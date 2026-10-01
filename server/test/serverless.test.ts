import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { TEST_ENV } from './env.js';
import { PDF, multipartBody } from './helpers.js';
import { startFakeSupabase } from './fake-supabase.js';
import { newToken, sha256 } from '../src/lib/crypto.js';

/**
 * Configuração usada no Netlify + Supabase: adaptador de Request/Response,
 * modo de produção (https, cookie __Host-), convites manuais (sem SMTP),
 * limites de tentativa no PostgreSQL e documentos no Supabase Storage.
 */
const ORIGIN = 'https://alpha-homolog.netlify.app';
const KEY = 'sb_secret_chaveDeTesteServiceRole123';
let fake: Awaited<ReturnType<typeof startFakeSupabase>>;
let handle: (r: Request, ip: string) => Promise<Response>;
let owner: pg.Pool;

class WebAgent {
  cookie = '';
  csrf = '';
  constructor(readonly ip: string) {}
  async call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
    const headers: Record<string, string> = { origin: ORIGIN, ...extra };
    if (this.cookie) headers.cookie = this.cookie;
    if (this.csrf && method !== 'GET' && !extra['x-csrf-token']) headers['x-csrf-token'] = this.csrf;
    let payload: BodyInit | undefined;
    if (body instanceof Uint8Array) payload = body as unknown as BodyInit;
    else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['content-type'] = 'application/json';
    }
    const res = await handle(new Request(ORIGIN + path, { method, headers, body: payload }), this.ip);
    for (const c of res.headers.getSetCookie()) this.cookie = c.split(';')[0]!;
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, headers: res.headers, buf, setCookie: res.headers.getSetCookie(), json: () => JSON.parse(buf.toString()) };
  }
  async login(email: string, password: string) {
    const r = await this.call('POST', '/api/auth/login', { email, password });
    if (r.status !== 200) throw new Error(r.buf.toString());
    this.csrf = r.json().csrfToken;
    return r;
  }
}

beforeAll(async () => {
  fake = await startFakeSupabase(KEY);
  Object.assign(process.env, {
    ...TEST_ENV,
    APP_ENV: 'staging',
    APP_URL: ORIGIN,
    MAIL_MODE: 'manual',
    STORAGE_DRIVER: 'supabase',
    SUPABASE_URL: fake.url,
    SUPABASE_SERVICE_ROLE_KEY: KEY,
    RATE_LIMIT_STORE: 'postgres',
    DB_POOL_MAX: '2',
    MAX_UPLOAD_MB: '4',
  });
  ({ handleWebRequest: handle } = await import('../src/serverless.js'));
  owner = new pg.Pool({ connectionString: TEST_ENV.DATABASE_OWNER_URL });
});
afterAll(async () => {
  await owner.end();
  await fake.close();
});

async function bootstrapAdmin() {
  const email = `admin.sl.${Date.now()}@alpha.test`;
  const { rows } = await owner.query<{ id: string }>(
    "insert into users (email, full_name, kind) values ($1, 'Admin Serverless', 'alpha_admin') returning id",
    [email],
  );
  const token = newToken();
  await owner.query("insert into invites (token_hash, user_id, expires_at) values ($1, $2, now() + interval '1 hour')", [
    sha256(token),
    rows[0]!.id,
  ]);
  const a = new WebAgent('198.51.100.10');
  expect((await a.call('POST', '/api/auth/invite/accept', { token, password: 'Senha-de-teste-123' })).status).toBe(200);
  await a.login(email, 'Senha-de-teste-123');
  return a;
}

describe('execução serverless (Netlify + Supabase)', () => {
  it('cookie de sessão __Host-, Secure e SameSite=Strict; CSRF e origem verificados', async () => {
    const admin = await bootstrapAdmin();
    const r = await admin.call('GET', '/api/auth/me');
    expect(r.status).toBe(200);
    const login = await new WebAgent('198.51.100.11').call('POST', '/api/auth/login', { email: 'x@y.zz', password: 'errada-123' });
    expect(login.status).toBe(401);
    expect(admin.cookie).toMatch(/^__Host-as_session=/);
    expect((await admin.call('POST', '/api/companies', { name: 'X Y' }, { 'x-csrf-token': 'x'.repeat(43) })).status).toBe(403);
    expect((await admin.call('GET', '/api/auth/me', undefined, { origin: 'https://evil.example' })).status).toBe(403);
  });

  it('convite e redefinição sem SMTP: link entregue somente ao administrador', async () => {
    const admin = await bootstrapAdmin();
    const company = (await admin.call('POST', '/api/companies', { name: `Serverless ${Date.now()}` })).json().id;
    const email = `sl.cliente.${Date.now()}@example.test`;
    const created = await admin.call('POST', '/api/users', { email, fullName: 'Cliente SL', kind: 'client_user', companyId: company });
    const { id, inviteLink, validHours } = created.json();
    expect(inviteLink).toMatch(new RegExp(`^${ORIGIN}/convite#token=[A-Za-z0-9_-]{40,}$`));
    expect(validHours).toBe(72);
    // O link não aparece na auditoria.
    const audit = await owner.query("select details::text d from audit_events where entity_id = $1", [id]);
    expect(audit.rows.map((r) => r.d).join()).not.toContain(inviteLink.split('#token=')[1]);

    const token = inviteLink.split('#token=')[1];
    const user = new WebAgent('198.51.100.12');
    expect((await user.call('POST', '/api/auth/invite/accept', { token, password: 'Senha-cliente-123' })).status).toBe(200);
    await user.login(email, 'Senha-cliente-123');

    // Autoatendimento de recuperação não gera token no modo manual.
    const before = (await owner.query('select count(*)::int n from password_resets where user_id = $1', [id])).rows[0].n;
    const fr = await new WebAgent('198.51.100.13').call('POST', '/api/auth/password-reset/request', { email });
    expect(fr.json().message).toMatch(/administra/);
    expect((await owner.query('select count(*)::int n from password_resets where user_id = $1', [id])).rows[0].n).toBe(before);

    // Administrador gera o link; o próprio usuário não pode.
    expect((await user.call('POST', `/api/users/${id}/password-reset-link`)).status).toBe(403);
    const rl = (await admin.call('POST', `/api/users/${id}/password-reset-link`)).json();
    expect(rl.link).toMatch(new RegExp(`^${ORIGIN}/redefinir-senha#token=`));
    const rt = rl.link.split('#token=')[1];
    const anon = new WebAgent('198.51.100.14');
    expect((await anon.call('POST', '/api/auth/password-reset/confirm', { token: rt, password: 'Nova-senha-cliente-9' })).status).toBe(200);
    expect((await user.call('GET', '/api/auth/me')).status).toBe(401); // sessões encerradas
    await new WebAgent('198.51.100.15').login(email, 'Nova-senha-cliente-9');
  });

  it('documentos no Supabase Storage: chave aleatória, download autorizado e remoção', async () => {
    const admin = await bootstrapAdmin();
    const cand = (await admin.call('POST', '/api/candidates', { fullName: 'Candidato Storage', confirmDuplicate: true })).json().id;
    const { payload, contentType } = multipartBody('cv.pdf', 'application/pdf', PDF);
    const up = await admin.call('POST', `/api/candidates/${cand}/documents`, new Uint8Array(payload), { 'content-type': contentType });
    expect(up.status).toBe(201);
    const doc = up.json().id;
    const key = (await owner.query('select storage_key from documents where id = $1', [doc])).rows[0].storage_key;
    expect(fake.objects.has(key)).toBe(true);
    const dl = await admin.call('GET', `/api/documents/${doc}/content?download=1`);
    expect(dl.status).toBe(200);
    expect(dl.buf.equals(PDF)).toBe(true);
    expect(dl.headers.get('cache-control')).toContain('no-store');
    expect((await new WebAgent('198.51.100.16').call('GET', `/api/documents/${doc}/content`)).status).toBe(401);
    expect((await admin.call('DELETE', `/api/documents/${doc}`)).status).toBe(200);
    expect(fake.objects.has(key)).toBe(false);
  });

  it('limite de tentativas compartilhado no PostgreSQL, sem e-mail/IP em texto', async () => {
    const a = new WebAgent('198.51.100.20');
    const codes: number[] = [];
    // 20 tentativas (> 2 × limite de 8): mesmo que caiam em duas janelas fixas, uma delas estoura.
    for (let i = 0; i < 20; i++) {
      codes.push((await a.call('POST', '/api/auth/login', { email: 'alvo@example.test', password: 'errada-123' })).status);
    }
    expect(codes).toContain(429);
    const leak = await owner.query(
      "select count(*)::int n from rate_limit_counters where key_hash like '%@%' or key_hash like '%198.51%'",
    );
    expect(leak.rows[0].n).toBe(0);
  });
});

describe('configuração', () => {
  it('variáveis vazias do .env são tratadas como não definidas', async () => {
    const { loadConfig } = await import('../src/config.js');
    const cfg = loadConfig({ ...TEST_ENV, APP_ENV: 'development', MAIL_MODE: '', SMTP_URL: '', SUPABASE_URL: '', DATABASE_SSL_CA: '' });
    expect(cfg.mailMode).toBe('dev');
    expect(() => loadConfig({ ...TEST_ENV, APP_ENV: 'production', APP_URL: 'https://x.example', MAIL_MODE: '' })).toThrow(/SMTP_URL ou MAIL_MODE/);
    // Erro de configuração lista só os nomes das variáveis, nunca valores.
    try {
      loadConfig({ APP_ENV: 'staging', APP_URL: 'https://x.example', DATABASE_URL: 'postgres://u:SEGREDO@h/db' });
      throw new Error('deveria falhar');
    } catch (e) {
      const err = e as { fields?: string[]; message: string };
      expect(err.fields).toEqual(expect.arrayContaining(['DATABASE_OWNER_URL', 'STORAGE_DIR']));
      expect(err.message).not.toContain('SEGREDO');
    }
  });
});

describe('diagnóstico de saúde', () => {
  it('/api/health confirma o banco e, em falha, informa só a categoria', async () => {
    const ok = await new WebAgent('198.51.100.30').call('GET', '/api/health');
    expect(ok.status).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, banco: 'ok', documentos: 'Supabase Storage' });
    expect(ok.json().aviso).toBeUndefined();

    const { loadConfig } = await import('../src/config.js');
    const { createDeps } = await import('../src/deps.js');
    const { buildApp } = await import('../src/app.js');
    const wrong = new URL(TEST_ENV.DATABASE_OWNER_URL);
    wrong.password = 'senha-errada';
    const bad = loadConfig({ ...TEST_ENV, DATABASE_OWNER_URL: wrong.toString() });
    const deps = await createDeps(bad);
    const app = await buildApp(deps);
    const r = await app.inject({ method: 'GET', url: '/api/health' });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ ok: false, banco: 'senha do banco recusada', codigo: '28P01' });
    expect(r.body).not.toMatch(/senha-errada|alpha_owner|127\.0\.0\.1/);
    await app.close();
    await deps.pools.app.end();
    await deps.pools.owner.end();

    // Endereço malformado (ex.: marcador >>> <<< não substituído).
    const malformed = loadConfig({ ...TEST_ENV, DATABASE_OWNER_URL: 'postgres://u:p@>>>HOST_DO_POOLER<<<:6543/postgres' });
    const deps2 = await createDeps(malformed);
    const app2 = await buildApp(deps2);
    const r2 = await app2.inject({ method: 'GET', url: '/api/health' });
    expect(r2.statusCode).toBe(503);
    expect(r2.json()).toMatchObject({ ok: false, codigo: 'ERR_INVALID_URL' });
    expect(r2.json().banco).toMatch(/malformado/);
    await app2.close();
    await deps2.pools.app.end();
    await deps2.pools.owner.end();
  });
});

describe('documentos sem chave do Supabase Storage', () => {
  it('guarda no banco (acesso só do servidor) e o health avisa', async () => {
    const { loadConfig } = await import('../src/config.js');
    const { createDeps } = await import('../src/deps.js');
    const { buildApp } = await import('../src/app.js');
    const cfg = loadConfig({
      ...TEST_ENV,
      STORAGE_DRIVER: 'supabase',
      SUPABASE_URL: fake.url,
      SUPABASE_SERVICE_ROLE_KEY: 'marcador-nao-substituido', // chave inválida
    });
    const deps = await createDeps(cfg);
    const app = await buildApp(deps);
    const health = (await app.inject({ method: 'GET', url: '/api/health' })).json();
    expect(health.documentos).toMatch(/banco de dados/);

    const email = `blob.${Date.now()}@alpha.test`;
    const { rows } = await owner.query<{ id: string }>(
      "insert into users (email, full_name, kind) values ($1, 'Admin Blob', 'alpha_admin') returning id",
      [email],
    );
    const { hashPassword } = await import('../src/lib/crypto.js');
    await owner.query('insert into user_credentials (user_id, password_hash) values ($1, $2)', [rows[0]!.id, await hashPassword('Senha-de-teste-123')]);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'Senha-de-teste-123' }, remoteAddress: '198.51.100.40' });
    const cookie = `as_session=${login.cookies.find((c) => c.name === 'as_session')!.value}`;
    const csrf = login.json().csrfToken;
    const cand = (await app.inject({ method: 'POST', url: '/api/candidates', headers: { cookie, 'x-csrf-token': csrf }, payload: { fullName: 'Candidato Blob', confirmDuplicate: true } })).json().id;
    const { payload, contentType } = multipartBody('foto.pdf', 'application/pdf', PDF);
    const up = await app.inject({ method: 'POST', url: `/api/candidates/${cand}/documents`, headers: { cookie, 'x-csrf-token': csrf, 'content-type': contentType }, payload });
    expect(up.statusCode).toBe(201);
    const key = (await owner.query('select storage_key from documents where id = $1', [up.json().id])).rows[0].storage_key;
    expect((await owner.query('select count(*)::int n from document_blobs where storage_key = $1', [key])).rows[0].n).toBe(1);
    expect(fake.objects.has(key)).toBe(false);
    const dl = await app.inject({ method: 'GET', url: `/api/documents/${up.json().id}/content`, headers: { cookie } });
    expect(dl.statusCode).toBe(200);
    expect(dl.rawPayload.equals(PDF)).toBe(true);
    // O papel da aplicação (sujeito à RLS) não lê a tabela de conteúdos.
    const c = await deps.pools.app.connect();
    await expect(c.query('select 1 from document_blobs')).rejects.toThrow(/permission denied/);
    c.release();
    await app.close();
    await deps.pools.app.end();
    await deps.pools.owner.end();
  });
});
