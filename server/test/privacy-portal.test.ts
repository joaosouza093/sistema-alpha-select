import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runRetention } from '../src/modules/privacy/retention.js';
import {
  Agent,
  bootstrapAdmin,
  createApplication,
  createCandidate,
  createCompany,
  createProcess,
  inviteUser,
  json,
  multipartBody,
  setupApp,
  uniq,
  type TestCtx,
} from './helpers.js';

let ctx: TestCtx;
let admin: Agent;

beforeAll(async () => {
  ctx = await setupApp();
  admin = (await bootstrapAdmin(ctx)).agent;
});
afterAll(async () => {
  await ctx.owner.query('update privacy_settings set retention_enabled = false');
  await ctx.close();
});

/** Envelhece o candidato (sem o gatilho que atualiza updated_at). */
async function age(candidateId: string, months: number) {
  const c = await ctx.owner.connect();
  try {
    await c.query('begin');
    await c.query('alter table candidates disable trigger candidates_touch');
    await c.query(
      `update candidates set created_at = now() - make_interval(months => $2), updated_at = now() - make_interval(months => $2),
              consent_at = null where id = $1`,
      [candidateId, months],
    );
    await c.query('update applications set created_at = now() - make_interval(months => $2), updated_at = now() - make_interval(months => $2) where candidate_id = $1', [candidateId, months]);
    await c.query('alter table candidates enable trigger candidates_touch');
    await c.query('commit');
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}

const exists = async (id: string) => (await ctx.owner.query('select 1 from candidates where id = $1', [id])).rowCount === 1;
const linkToken = (to: string) => {
  const m = [...ctx.mailer.outbox].reverse().find((x) => x.to === to)?.text.match(/meus-dados#token=([A-Za-z0-9_-]+)/);
  if (!m) throw new Error(`sem link para ${to}`);
  return m[1]!;
};

/** Agente do candidato: só o cabeçalho com o token, sem sessão. */
const cand = (token: string) => ({
  get: (url: string) => ctx.app.inject({ method: 'GET', url, headers: { 'x-candidate-token': token } }),
  send: (method: 'POST' | 'PATCH', url: string, payload: object = {}) =>
    ctx.app.inject({ method, url, headers: { 'x-candidate-token': token }, payload }),
});

describe('retenção (LGPD)', () => {
  beforeEach(async () => {
    await ctx.owner.query('update privacy_settings set retention_enabled = false, retention_months = 24, notice_days = 30');
    // Isola dos candidatos criados por outros testes deste arquivo.
    await ctx.owner.query(`insert into candidate_retention (candidate_id, kept_at) select id, now() from candidates
                           on conflict (candidate_id) do update set kept_at = now(), notice_at = null`);
  });

  it('desligada por padrão; somente administrador configura', async () => {
    const staff = await inviteUser(ctx, admin, 'alpha_staff');
    expect((await staff.agent.get('/api/privacy/retention')).statusCode).toBe(403);
    expect((await staff.agent.put('/api/privacy/retention', { retentionEnabled: true, retentionMonths: 24, noticeDays: 30 })).statusCode).toBe(403);
    expect((await admin.put('/api/privacy/retention', { retentionEnabled: true, retentionMonths: 3, noticeDays: 30 })).statusCode).toBe(422);
    const id = await createCandidate(admin);
    await age(id, 30);
    expect(await runRetention(ctx.deps)).toEqual({ noticed: 0, erased: 0, canceled: 0 });
  });

  it('avisa, apaga depois do prazo e poupa quem está em processo em andamento', async () => {
    const email = `${uniq('ret')}@example.test`;
    const old = await createCandidate(admin, { email });
    const recent = await createCandidate(admin);
    const busy = await createCandidate(admin);
    const companyId = await createCompany(admin);
    await createApplication(admin, busy, await createProcess(admin, companyId));
    for (const id of [old, busy]) await age(id, 30);
    await ctx.owner.query('delete from candidate_retention where candidate_id = any($1::uuid[])', [[old, recent, busy]]);

    expect((await admin.put('/api/privacy/retention', { retentionEnabled: true, retentionMonths: 24, noticeDays: 30 })).statusCode).toBe(200);
    const pr = await admin.get('/api/privacy/retention');
    if (pr.statusCode !== 200) throw new Error(pr.body);
    const preview = json(pr);
    expect(preview.candidates.map((c: any) => c.id)).toEqual([old]);

    const r1 = await runRetention(ctx.deps);
    expect(r1.noticed).toBe(1);
    expect(linkToken(email)).toBeTruthy();
    const log = await ctx.owner.query("select ok from message_log where candidate_id = $1 and template_key = 'aviso_retencao'", [old]);
    expect(log.rows).toEqual([{ ok: true }]);
    // Segunda execução não repete o aviso nem apaga antes do prazo.
    expect(await runRetention(ctx.deps)).toMatchObject({ noticed: 0, erased: 0 });

    await ctx.owner.query("update candidate_retention set notice_at = now() - interval '31 days' where candidate_id = $1", [old]);
    expect(await runRetention(ctx.deps)).toMatchObject({ erased: 1 });
    expect(await exists(old)).toBe(false);
    expect(await exists(recent)).toBe(true);
    expect(await exists(busy)).toBe(true);
    const audit = await ctx.owner.query("select actor_id from audit_events where action = 'candidate.retention_erased' and entity_id = $1", [old]);
    expect(audit.rows).toEqual([{ actor_id: null }]);
  });

  it('desligar a regra invalida os avisos; falha no envio não conta como aviso', async () => {
    const email = `${uniq('off')}@example.test`;
    const a = await createCandidate(admin, { email });
    await age(a, 30);
    await ctx.owner.query('delete from candidate_retention where candidate_id = $1', [a]);
    await admin.put('/api/privacy/retention', { retentionEnabled: true, retentionMonths: 24, noticeDays: 30 });

    const send = ctx.mailer.send.bind(ctx.mailer);
    ctx.mailer.send = async () => { throw new Error('smtp fora do ar'); };
    try {
      expect((await runRetention(ctx.deps)).noticed).toBe(0);
    } finally {
      ctx.mailer.send = send;
    }
    expect((await ctx.owner.query('select notice_at from candidate_retention where candidate_id = $1', [a])).rowCount).toBe(0);

    expect((await runRetention(ctx.deps)).noticed).toBe(1);
    await ctx.owner.query("update candidate_retention set notice_at = now() - interval '200 days' where candidate_id = $1", [a]);
    await admin.put('/api/privacy/retention', { retentionEnabled: false, retentionMonths: 24, noticeDays: 30 });
    await admin.put('/api/privacy/retention', { retentionEnabled: true, retentionMonths: 24, noticeDays: 30 });
    const r = await runRetention(ctx.deps);
    expect(r.erased).toBe(0); // aviso antigo perdeu a validade: avisa de novo em vez de apagar
    expect(await exists(a)).toBe(true);
  });

  it('administrador "manter" e renovação pelo candidato cancelam o aviso', async () => {
    const email = `${uniq('keep')}@example.test`;
    const a = await createCandidate(admin, { email });
    const b = await createCandidate(admin);
    for (const id of [a, b]) {
      await age(id, 30);
      await ctx.owner.query('delete from candidate_retention where candidate_id = $1', [id]);
    }
    await admin.put('/api/privacy/retention', { retentionEnabled: true, retentionMonths: 24, noticeDays: 30 });
    expect((await runRetention(ctx.deps)).noticed).toBe(2);

    expect((await admin.post(`/api/privacy/retention/${b}/keep`)).statusCode).toBe(200);
    // Candidato renova pelo link do aviso.
    expect((await cand(linkToken(email)).send('POST', '/api/public/my-data/consent')).statusCode).toBe(200);

    await ctx.owner.query("update candidate_retention set notice_at = now() - interval '40 days' where notice_at is not null");
    expect((await runRetention(ctx.deps)).erased).toBe(0);
    expect(await exists(a)).toBe(true);
    expect(await exists(b)).toBe(true);
  });
});

describe('área do candidato', () => {
  it('link por e-mail; mesma resposta para e-mail inexistente; token inválido recusado', async () => {
    const email = `${uniq('portal')}@example.test`;
    await createCandidate(admin, { email, fullName: 'Maria Fictícia' });
    const before = ctx.mailer.outbox.length;
    const r1 = json(await new Agent(ctx).post('/api/public/my-data/request', { email }));
    const r2 = json(await new Agent(ctx).post('/api/public/my-data/request', { email: `${uniq('nao')}@example.test` }));
    expect(r1.message).toBe(r2.message);
    expect(ctx.mailer.outbox.length).toBe(before + 1);
    expect((await cand('x'.repeat(43)).get('/api/public/my-data')).statusCode).toBe(401);
    // Pedir um link novo invalida o anterior.
    const first = linkToken(email);
    await new Agent(ctx).post('/api/public/my-data/request', { email });
    expect((await cand(first).get('/api/public/my-data')).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/public/my-data' })).statusCode).toBe(401);
    const me = json(await cand(linkToken(email)).get('/api/public/my-data'));
    expect(me).toMatchObject({ fullName: 'Maria Fictícia', email });
    expect(me.notes).toBeUndefined();
    expect(JSON.stringify(me)).not.toContain('OBSERVACAO-INTERNA-SIGILOSA');
  });

  it('candidato vê candidaturas sem dados internos, corrige dados, troca currículo e se descadastra', async () => {
    const email = `${uniq('portal')}@example.test`;
    const id = await createCandidate(admin, { email });
    const companyId = await createCompany(admin, uniq('Empresa Sigilosa'));
    const processId = await createProcess(admin, companyId, 'Vaga Analista');
    await createApplication(admin, id, processId, undefined, { sent: false });
    await new Agent(ctx).post('/api/public/my-data/request', { email });
    const c = cand(linkToken(email));

    const me = json(await c.get('/api/public/my-data'));
    expect(me.applications).toEqual([expect.objectContaining({ title: 'Vaga Analista', company: null, status: 'Em análise pela Alpha Select' })]);
    expect(JSON.stringify(me)).not.toContain('Empresa Sigilosa');

    expect((await c.send('PATCH', '/api/public/my-data', { fullName: 'Nome Corrigido', phone: '(11) 98888-7777', city: 'Campinas', salaryExpectation: 7000 })).statusCode).toBe(200);
    expect((await c.send('PATCH', '/api/public/my-data', { fullName: 'X', email: 'outro@example.test' })).statusCode).toBe(422);
    const row = (await ctx.owner.query('select full_name, phone, city from candidates where id = $1', [id])).rows[0];
    expect(row).toEqual({ full_name: 'Nome Corrigido', phone: '+5511988887777', city: 'Campinas' });

    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
    const mp = multipartBody('novo.pdf', 'application/pdf', pdf);
    const up = await ctx.app.inject({
      method: 'POST', url: '/api/public/my-data/resume', payload: mp.payload,
      headers: { 'x-candidate-token': linkToken(email), 'content-type': mp.contentType },
    });
    expect(up.statusCode).toBe(201);
    expect(json(await c.get('/api/public/my-data')).documents[0].name).toBe('novo.pdf');

    expect((await c.send('POST', '/api/public/my-data/email-preferences', { optOut: true })).statusCode).toBe(200);
    expect((await ctx.owner.query('select email_opt_out_at from candidates where id = $1', [id])).rows[0].email_opt_out_at).not.toBeNull();

    const exp = await c.get('/api/public/my-data/export');
    expect(exp.headers['content-disposition']).toContain('attachment');
    expect(exp.body).not.toContain('OBSERVACAO-INTERNA-SIGILOSA');
  });

  it('exclusão pelo próprio candidato apaga todos os cadastros do e-mail e invalida o link', async () => {
    const email = `${uniq('del')}@example.test`;
    const a = await createCandidate(admin, { email });
    const b = await createCandidate(admin, { email });
    const other = await createCandidate(admin);
    await new Agent(ctx).post('/api/public/my-data/request', { email });
    const token = linkToken(email);
    expect(json(await cand(token).get('/api/public/my-data')).records).toBe(2);
    expect((await cand(token).send('POST', '/api/public/my-data/delete', {})).statusCode).toBe(422);
    expect((await cand(token).send('POST', '/api/public/my-data/delete', { confirm: true })).statusCode).toBe(200);
    expect(await exists(a)).toBe(false);
    expect(await exists(b)).toBe(false);
    expect(await exists(other)).toBe(true);
    expect((await cand(token).get('/api/public/my-data')).statusCode).toBe(401);
  });
});
