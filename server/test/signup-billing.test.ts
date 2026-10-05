import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withUser } from '../src/lib/db.js';
import { nextNotice, runBillingNotifications, type BillingSettings } from '../src/modules/billing/notify.js';
import { runMaintenance } from '../src/maintenance.js';
import {
  Agent,
  PASSWORD,
  bootstrapAdmin,
  createCompany,
  inviteUser,
  json,
  setupApp,
  tokenFromMail,
  uniq,
  type TestCtx,
} from './helpers.js';

let ctx: TestCtx;
let admin: Agent;
let adminEmail: string;
let adminId: string;

beforeAll(async () => {
  ctx = await setupApp();
  const a = await bootstrapAdmin(ctx);
  admin = a.agent;
  adminEmail = a.email;
  adminId = a.id;
});
afterAll(async () => {
  await ctx.close();
});

const CNPJ_VALIDO = '11.222.333/0001-81';

function signupBody(over: Record<string, unknown> = {}) {
  return {
    companyName: uniq('Empresa Cadastro'),
    fullName: 'Pessoa Responsável',
    email: `${uniq('cadastro')}@example.test`,
    phone: '(11) 98888-7777',
    acceptTerms: true,
    ...over,
  };
}

async function signupAndVerify(over: Record<string, unknown> = {}) {
  const body = signupBody(over);
  const anon = new Agent(ctx);
  const r = await anon.post('/api/auth/signup', body);
  expect(r.statusCode).toBe(200);
  const token = tokenFromMail(ctx.mailer, body.email as string);
  const v = await anon.post('/api/auth/signup/verify', { token, password: PASSWORD });
  expect(v.statusCode).toBe(200);
  const list = json(await admin.get('/api/signups'));
  const item = list.items.find((i: { email: string }) => i.email === body.email);
  return { body, id: item.id as string };
}

describe('cadastro pelo site', () => {
  it('resposta igual para e-mail novo e já cadastrado; senha só pelo link do e-mail', async () => {
    const anon = new Agent(ctx);
    const novo = signupBody();
    const r1 = await anon.post('/api/auth/signup', novo);
    const r2 = await anon.post('/api/auth/signup', signupBody({ email: adminEmail }));
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(json(r1).message).toBe(json(r2).message);
    // Quem já tem conta recebe aviso, sem link de cadastro.
    const aviso = [...ctx.mailer.outbox].reverse().find((m) => m.to === adminEmail)!;
    expect(aviso.text).not.toMatch(/#token=/);
    const { rows } = await ctx.owner.query('select password_hash from signup_requests where email = $1', [novo.email]);
    expect(rows[0].password_hash).toBeNull();
    const dup = await ctx.owner.query('select 1 from signup_requests where email = $1', [adminEmail]);
    expect(dup.rowCount).toBe(0);
  });

  it('valida CNPJ, consentimento e campos extras', async () => {
    const anon = new Agent(ctx);
    expect((await anon.post('/api/auth/signup', signupBody({ cnpj: '11.111.111/1111-11' }))).statusCode).toBe(422);
    expect((await anon.post('/api/auth/signup', signupBody({ acceptTerms: false }))).statusCode).toBe(422);
    expect((await anon.post('/api/auth/signup', signupBody({ kind: 'alpha_admin' }))).statusCode).toBe(422);
    expect((await anon.post('/api/auth/signup', signupBody({ cnpj: CNPJ_VALIDO }))).statusCode).toBe(200);
  });

  it('não aprova antes da confirmação do e-mail; link usado não vale de novo', async () => {
    const body = signupBody();
    const anon = new Agent(ctx);
    await anon.post('/api/auth/signup', body);
    const pend = json(await admin.get('/api/signups')).items.find((i: { email: string }) => i.email === body.email);
    const early = await admin.post(`/api/signups/${pend.id}/approve`, {});
    expect(early.statusCode).toBe(422);
    const token = tokenFromMail(ctx.mailer, body.email);
    expect((await anon.post('/api/auth/signup/verify', { token, password: 'curta' })).statusCode).toBe(422);
    expect((await anon.post('/api/auth/signup/verify', { token, password: PASSWORD })).statusCode).toBe(200);
    expect((await anon.post('/api/auth/signup/verify', { token, password: PASSWORD })).statusCode).toBe(400);
    // Administradores são avisados do cadastro confirmado.
    expect(ctx.mailer.outbox.some((m) => m.to === adminEmail && m.subject.includes('Novo cadastro'))).toBe(true);
  });

  it('aprovação cria empresa e usuário com a senha escolhida; sem acesso a processos', async () => {
    const { body, id } = await signupAndVerify({ cnpj: null });
    const r = await admin.post(`/api/signups/${id}/approve`, { kind: 'client_manager' });
    expect(r.statusCode).toBe(200);
    expect((await admin.post(`/api/signups/${id}/approve`, {})).statusCode).toBe(409);
    const user = new Agent(ctx);
    await user.login(body.email, PASSWORD);
    const me = json(await user.get('/api/auth/me'));
    expect(me.user.kind).toBe('client_manager');
    expect(me.user.companyId).toBe(json(r).companyId);
    expect(json(await user.get('/api/processes')).items).toHaveLength(0);
    const { rows } = await ctx.owner.query('select password_hash, status from signup_requests where id = $1', [id]);
    expect(rows[0]).toEqual({ password_hash: null, status: 'aprovado' });
    expect(ctx.mailer.outbox.some((m) => m.to === body.email && m.subject.includes('Acesso liberado'))).toBe(true);
  });

  it('empresa com o mesmo nome exige escolher a existente', async () => {
    const companyId = await createCompany(admin);
    const name = json(await admin.get(`/api/companies/${companyId}`)).name;
    const { id } = await signupAndVerify({ companyName: name });
    const item = json(await admin.get('/api/signups')).items.find((i: { id: string }) => i.id === id);
    expect(item.matchingCompanyId).toBe(companyId);
    expect((await admin.post(`/api/signups/${id}/approve`, {})).statusCode).toBe(409);
    const ok = await admin.post(`/api/signups/${id}/approve`, { companyId });
    expect(ok.statusCode).toBe(200);
    expect(json(ok).companyId).toBe(companyId);
  });

  it('recusa apaga o hash da senha', async () => {
    const { id } = await signupAndVerify();
    expect((await admin.post(`/api/signups/${id}/reject`, { note: 'Fora do perfil' })).statusCode).toBe(200);
    const { rows } = await ctx.owner.query('select password_hash, status from signup_requests where id = $1', [id]);
    expect(rows[0]).toEqual({ password_hash: null, status: 'recusado' });
  });

  it('somente administrador vê e decide cadastros; banco nega o hash até ao administrador', async () => {
    const companyId = await createCompany(admin);
    const staff = await inviteUser(ctx, admin, 'alpha_staff');
    const client = await inviteUser(ctx, admin, 'client_manager', companyId);
    const { id } = await signupAndVerify();
    for (const a of [staff.agent, client.agent]) {
      expect((await a.get('/api/signups')).statusCode).toBe(403);
      expect((await a.post(`/api/signups/${id}/approve`, {})).statusCode).toBe(403);
    }
    expect((await new Agent(ctx).get('/api/signups')).statusCode).toBe(401);
    // RLS: equipe não lê nenhuma linha; nem o administrador lê a coluna de senha.
    const n = await withUser(ctx.deps.pools.app, staff.id, (db) => db.query('select id from signup_requests'));
    expect(n.rowCount).toBe(0);
    await expect(
      withUser(ctx.deps.pools.app, adminId, (db) => db.query('select password_hash from signup_requests')),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

// ---------------------------------------------------------------------------

const settings: BillingSettings = {
  auto_email: true,
  pix_key: null,
  beneficiary: null,
  instructions: null,
  reminder_days_before: 3,
  overdue_every_days: 7,
  overdue_max_reminders: 3,
};

describe('regra dos avisos de cobrança', () => {
  const base = { created_date: '2026-01-01', due_date: '2026-01-20', n_criada: 1, n_lembrete: 0, n_vencimento: 0, n_atraso: 0 };
  it('sequência: criada → lembrete → vencimento → atrasos limitados', () => {
    expect(nextNotice({ ...base, n_criada: 0 }, '2026-01-01', settings)).toBe('criada');
    expect(nextNotice(base, '2026-01-10', settings)).toBeNull();
    expect(nextNotice(base, '2026-01-17', settings)).toBe('lembrete');
    expect(nextNotice({ ...base, n_lembrete: 1 }, '2026-01-18', settings)).toBeNull();
    expect(nextNotice({ ...base, n_lembrete: 1 }, '2026-01-20', settings)).toBe('vencimento');
    const venc = { ...base, n_lembrete: 1, n_vencimento: 1 };
    expect(nextNotice(venc, '2026-01-21', settings)).toBe('atraso');
    expect(nextNotice({ ...venc, n_atraso: 1 }, '2026-01-27', settings)).toBeNull();
    expect(nextNotice({ ...venc, n_atraso: 1 }, '2026-01-28', settings)).toBe('atraso');
    expect(nextNotice({ ...venc, n_atraso: 3 }, '2026-06-01', settings)).toBeNull();
  });
  it('cobrança criada perto do vencimento não recebe lembrete repetido', () => {
    const c = { ...base, created_date: '2026-01-19' };
    expect(nextNotice(c, '2026-01-19', settings)).toBeNull();
    expect(nextNotice({ ...c, n_criada: 0, due_date: '2026-01-19' }, '2026-01-19', settings)).toBe('criada');
    expect(nextNotice({ ...c, due_date: '2026-01-19' }, '2026-01-19', settings)).toBeNull();
  });
});

describe('cobranças', () => {
  async function companyWithEmail() {
    const id = await createCompany(admin);
    const email = `${uniq('financeiro')}@example.test`;
    expect((await admin.patch(`/api/companies/${id}`, { billingEmail: email })).statusCode).toBe(200);
    return { id, email };
  }
  const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

  it('cria em lote para várias empresas e envia o primeiro e-mail na hora', async () => {
    const a = await companyWithEmail();
    // Empresa sem e-mail de cobrança usa o e-mail do gestor/cliente ativo.
    const bId = await createCompany(admin);
    const gestor = await inviteUser(ctx, admin, 'client_manager', bId);
    const r = await admin.post('/api/billing/charges', {
      companyIds: [a.id, bId],
      description: 'Mensalidade de recrutamento',
      amountCents: 150_000,
      dueDate: future(20),
    });
    expect(r.statusCode).toBe(201);
    expect(json(r).count).toBe(2);
    const toA = ctx.mailer.outbox.find((m) => m.to === a.email && m.subject.includes('Nova cobrança'));
    expect(toA?.text).toContain('R$');
    expect(toA?.text).toContain('1.500,00');
    expect(ctx.mailer.outbox.some((m) => m.to === gestor.email && m.subject.includes('Nova cobrança'))).toBe(true);
  });

  it('recusa empresa sem nenhum e-mail para cobrança', async () => {
    const id = await createCompany(admin);
    const r = await admin.post('/api/billing/charges', { companyIds: [id], description: 'Teste', amountCents: 100, dueDate: future(5) });
    expect(r.statusCode).toBe(422);
    expect(json(r).error.message).toContain('Sem e-mail');
  });

  it('atraso dispara e-mail automático uma vez por intervalo; pago envia recibo e para os avisos', async () => {
    const c = await companyWithEmail();
    const r = await admin.post('/api/billing/charges', { companyIds: [c.id], description: 'Serviço avulso', amountCents: 9_990, dueDate: future(10) });
    const id = json(r).ids[0];
    await ctx.owner.query("update charges set due_date = current_date - 2 where id = $1", [id]);
    const count = () => ctx.mailer.outbox.filter((m) => m.to === c.email && m.subject.includes('atraso')).length;
    await runMaintenance(ctx.deps);
    expect(count()).toBe(1);
    await runMaintenance(ctx.deps);
    expect(count()).toBe(1);
    const detail = json(await admin.get(`/api/billing/charges/${id}`));
    expect(detail.situacao).toBe('vencida');
    expect(detail.notices.map((n: { kind: string }) => n.kind)).toEqual(['atraso', 'criada']);
    // Versão desatualizada é recusada.
    expect((await admin.post(`/api/billing/charges/${id}/pay`, { expectedVersion: detail.version - 1 })).statusCode).toBe(409);
    const pay = await admin.post(`/api/billing/charges/${id}/pay`, { expectedVersion: detail.version });
    expect(json(pay).receipt).toBe(true);
    expect(ctx.mailer.outbox.some((m) => m.to === c.email && m.subject.includes('Pagamento confirmado'))).toBe(true);
    await ctx.owner.query("update charges set due_date = current_date - 30 where id = $1", [id]);
    await runMaintenance(ctx.deps);
    expect(count()).toBe(1);
    expect((await admin.post(`/api/billing/charges/${id}/cancel`, { expectedVersion: detail.version + 1 })).statusCode).toBe(409);
  });

  it('cobrança mensal gera a próxima parcela no vencimento, sem duplicar', async () => {
    const c = await companyWithEmail();
    const r = await admin.post('/api/billing/charges', {
      companyIds: [c.id], description: 'Plano mensal', amountCents: 50_000, dueDate: '2026-01-31', recurrence: 'mensal',
    });
    const id = json(r).ids[0];
    await runBillingNotifications(ctx.deps);
    await runBillingNotifications(ctx.deps);
    const { rows } = await ctx.owner.query(
      `select series_index, to_char(due_date, 'YYYY-MM-DD') as due from charges
        where series_id = (select series_id from charges where id = $1) order by series_index`,
      [id],
    );
    // Gera até a primeira parcela futura; fevereiro fica no último dia e março volta ao dia 31.
    expect(rows.slice(0, 3).map((x) => x.due)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
    expect(new Set(rows.map((x) => x.series_index)).size).toBe(rows.length);
    const last = rows[rows.length - 1]!.due;
    expect(last >= new Date().toISOString().slice(0, 10)).toBe(true);
  });

  it('envio automático desligado não manda e-mails', async () => {
    const s = json(await admin.get('/api/billing/settings'));
    const put = (autoEmail: boolean) =>
      admin.put('/api/billing/settings', {
        autoEmail, pixKey: 'financeiro@alpha.test', beneficiary: 'Alpha Select', instructions: null,
        reminderDaysBefore: s.reminderDaysBefore, overdueEveryDays: s.overdueEveryDays, overdueMaxReminders: s.overdueMaxReminders,
      });
    expect((await put(false)).statusCode).toBe(200);
    const c = await companyWithEmail();
    await admin.post('/api/billing/charges', { companyIds: [c.id], description: 'Sem aviso', amountCents: 100, dueDate: future(3) });
    expect(ctx.mailer.outbox.some((m) => m.to === c.email)).toBe(false);
    expect((await put(true)).statusCode).toBe(200);
    await runBillingNotifications(ctx.deps);
    const msg = ctx.mailer.outbox.find((m) => m.to === c.email);
    expect(msg?.text).toContain('Pix: financeiro@alpha.test (favorecido: Alpha Select)');
  });

  it('somente administrador acessa cobranças (API e banco)', async () => {
    const companyId = await createCompany(admin);
    const staff = await inviteUser(ctx, admin, 'alpha_staff');
    const client = await inviteUser(ctx, admin, 'client_manager', companyId);
    for (const a of [staff.agent, client.agent]) {
      expect((await a.get('/api/billing/charges')).statusCode).toBe(403);
      expect((await a.get('/api/billing/summary')).statusCode).toBe(403);
      expect((await a.post('/api/billing/charges', { allActive: true, description: 'x', amountCents: 1, dueDate: future(1) })).statusCode).toBe(403);
      expect((await a.put('/api/billing/settings', {})).statusCode).toBe(403);
    }
    for (const id of [staff.id, client.id]) {
      const r = await withUser(ctx.deps.pools.app, id, (db) => db.query('select id from charges'));
      expect(r.rowCount).toBe(0);
      await expect(
        withUser(ctx.deps.pools.app, id, (db) =>
          db.query("insert into charges (company_id, description, amount_cents, due_date, billing_email, series_start) values ($1, 'x', 1, current_date, 'a@b.co', current_date)", [companyId]),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    }
    const sum = json(await admin.get('/api/billing/summary'));
    expect(sum.emailEnabled).toBe(true);
    expect(typeof sum.overdueCents).toBe('number');
  });
});
