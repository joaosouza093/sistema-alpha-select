import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { loadConfig } from '../src/config.js';
import { createDeps } from '../src/deps.js';
import { buildApp } from '../src/app.js';
import { MemoryMailer } from '../src/lib/mailer.js';
import type { Deps } from '../src/lib/context.js';
import { newToken, sha256 } from '../src/lib/crypto.js';
import { TEST_ENV } from './env.js';

export interface TestCtx {
  app: FastifyInstance;
  deps: Deps;
  mailer: MemoryMailer;
  owner: pg.Pool;
  close: () => Promise<void>;
}

let ownerPool: pg.Pool | null = null;

export async function setupApp(env: Record<string, string> = {}): Promise<TestCtx> {
  const config = loadConfig({ ...process.env, ...TEST_ENV, ...env });
  const mailer = new MemoryMailer();
  const deps = await createDeps(config, { mailer });
  const app = await buildApp(deps);
  await app.ready();
  ownerPool = deps.pools.owner;
  return {
    app,
    deps,
    mailer,
    owner: deps.pools.owner,
    close: async () => {
      await app.close();
      await deps.pools.app.end();
      await deps.pools.owner.end();
    },
  };
}

let ipCounter = 1;

/** Cliente HTTP que mantém cookie de sessão e token CSRF, como o navegador. */
export class Agent {
  cookie: string | null = null;
  csrf: string | null = null;
  readonly ip = `10.0.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

  constructor(private readonly ctx: TestCtx) {}

  async request(method: string, url: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
    const headers: Record<string, string> = { ...extraHeaders };
    if (this.cookie) headers.cookie = this.cookie;
    if (this.csrf && !('x-csrf-token' in extraHeaders)) headers['x-csrf-token'] = this.csrf;
    const res = await this.ctx.app.inject({
      method: method as 'GET',
      url,
      headers,
      remoteAddress: this.ip,
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    const set = res.cookies.find((c) => c.name === 'as_session');
    if (set) this.cookie = set.value ? `as_session=${set.value}` : null;
    return res;
  }

  get(url: string) {
    return this.request('GET', url);
  }
  post(url: string, body: unknown = {}) {
    return this.request('POST', url, body);
  }
  patch(url: string, body: unknown = {}) {
    return this.request('PATCH', url, body);
  }
  put(url: string, body: unknown = {}) {
    return this.request('PUT', url, body);
  }
  delete(url: string) {
    return this.request('DELETE', url);
  }

  async login(email: string, password: string) {
    const res = await this.post('/api/auth/login', { email, password });
    if (res.statusCode !== 200) throw new Error(`login falhou (${res.statusCode}): ${res.body}`);
    this.csrf = res.json().csrfToken;
    return res;
  }
}

export const json = (r: LightMyRequestResponse) => r.json() as any;

export const PASSWORD = 'Senha-de-teste-123';

let seq = 0;
export const uniq = (p: string) => `${p}-${Date.now().toString(36)}-${seq++}`;

/** Extrai o token do último e-mail enviado ao destinatário. */
export function tokenFromMail(mailer: MemoryMailer, to: string): string {
  const msg = [...mailer.outbox].reverse().find((m) => m.to === to);
  const m = msg?.text.match(/#token=([A-Za-z0-9_-]+)/);
  if (!m) throw new Error(`nenhum token enviado para ${to}`);
  return m[1]!;
}

/**
 * Cria o primeiro administrador como o script CLI faz (convite de uso único)
 * e conclui o convite pela API.
 */
export async function bootstrapAdmin(ctx: TestCtx): Promise<{ agent: Agent; email: string; id: string }> {
  const email = `${uniq('admin')}@alpha.test`;
  const { rows } = await ctx.owner.query<{ id: string }>(
    "insert into users (email, full_name, kind) values ($1, 'Admin Teste', 'alpha_admin') returning id",
    [email],
  );
  const token = newToken();
  await ctx.owner.query(
    "insert into invites (token_hash, user_id, expires_at) values ($1, $2, now() + interval '1 hour')",
    [sha256(token), rows[0]!.id],
  );
  const agent = new Agent(ctx);
  const r = await agent.post('/api/auth/invite/accept', { token, password: PASSWORD });
  if (r.statusCode !== 200) throw new Error(r.body);
  await agent.login(email, PASSWORD);
  return { agent, email, id: rows[0]!.id };
}

/** Administrador convida um usuário; o usuário aceita e entra. */
export async function inviteUser(
  ctx: TestCtx,
  admin: Agent,
  kind: 'alpha_admin' | 'alpha_staff' | 'client_user' | 'client_manager',
  companyId: string | null = null,
): Promise<{ agent: Agent; email: string; id: string }> {
  const email = `${uniq(kind)}@example.test`;
  const r = await admin.post('/api/users', { email, fullName: `Usuário ${kind}`, kind, companyId });
  if (r.statusCode !== 201) throw new Error(r.body);
  const id = r.json().id;
  const token = tokenFromMail(ctx.mailer, email);
  const agent = new Agent(ctx);
  const a = await agent.post('/api/auth/invite/accept', { token, password: PASSWORD });
  if (a.statusCode !== 200) throw new Error(a.body);
  await agent.login(email, PASSWORD);
  return { agent, email, id };
}

export async function createCompany(admin: Agent, name = uniq('Empresa')) {
  const r = await admin.post('/api/companies', { name });
  if (r.statusCode !== 201) throw new Error(r.body);
  return r.json().id as string;
}

export async function createProcess(admin: Agent, companyId: string, title = uniq('Processo')) {
  const r = await admin.post('/api/processes', { companyId, title, description: 'Vaga de teste' });
  if (r.statusCode !== 201) throw new Error(r.body);
  return r.json().id as string;
}

export async function addMember(
  admin: Agent,
  processId: string,
  userId: string,
  perms: Partial<{ canMoveStage: boolean; canDecide: boolean; canComment: boolean }> = {},
) {
  const r = await admin.put(`/api/processes/${processId}/members/${userId}`, {
    canMoveStage: false,
    canDecide: false,
    canComment: true,
    ...perms,
  });
  if (r.statusCode !== 200) throw new Error(r.body);
}

export async function createCandidate(agent: Agent, data: Record<string, unknown> = {}) {
  const r = await agent.post('/api/candidates', {
    fullName: 'Candidata Fictícia',
    email: `${uniq('cand')}@example.test`,
    phone: null,
    salaryExpectation: 5000,
    notes: 'OBSERVACAO-INTERNA-SIGILOSA',
    confirmDuplicate: true,
    ...data,
  });
  if (r.statusCode !== 201) throw new Error(r.body);
  return r.json().id as string;
}

/**
 * Inclui o candidato no processo. Por padrão marca como já enviado ao
 * cliente (como se tivesse passado pela triagem), para os testes de cliente.
 */
export async function createApplication(
  agent: Agent,
  candidateId: string,
  processId: string,
  ownerId?: string,
  opts: { sent?: boolean } = {},
) {
  const r = await agent.post('/api/applications', { candidateId, processId, ownerId });
  if (r.statusCode !== 201) throw new Error(r.body);
  const id = r.json().id as string;
  if (opts.sent !== false) await ownerPool!.query('update applications set sent_at = now() where id = $1', [id]);
  return id;
}

export function multipartBody(filename: string, contentType: string, content: Buffer, kind = 'curriculo') {
  const boundary = `----alpha${Date.now()}`;
  const head =
    `--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\n${kind}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`;
  const payload = Buffer.concat([Buffer.from(head), content, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  return { payload, contentType: `multipart/form-data; boundary=${boundary}` };
}

export async function upload(agent: Agent, candidateId: string, filename: string, contentType: string, content: Buffer) {
  const { payload, contentType: ct } = multipartBody(filename, contentType, content);
  return agent.request('POST', `/api/candidates/${candidateId}/documents`, payload, { 'content-type': ct });
}

export const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);
