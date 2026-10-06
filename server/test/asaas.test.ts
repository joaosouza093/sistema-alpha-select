import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syncGateway } from '../src/modules/billing/asaas.js';
import { generateRecurring, todaySP } from '../src/modules/billing/notify.js';
import { Agent, bootstrapAdmin, createCompany, json, setupApp, uniq, type TestCtx } from './helpers.js';
import { startFakeAsaas } from './fake-asaas.js';

const KEY = '$aact_hmlg_chave-de-teste';
const HOOK = 'token-do-webhook-de-teste-123';

let ctx: TestCtx;
let admin: Agent;
let asaas: Awaited<ReturnType<typeof startFakeAsaas>>;

beforeAll(async () => {
  asaas = await startFakeAsaas(KEY);
  ctx = await setupApp({ ASAAS_API_KEY: KEY, ASAAS_WEBHOOK_TOKEN: HOOK, ASAAS_API_URL: asaas.url });
  admin = (await bootstrapAdmin(ctx)).agent;
  const s = json(await admin.get('/api/billing/settings'));
  const r = await admin.put('/api/billing/settings', {
    autoEmail: true, pixKey: null, beneficiary: null, instructions: null,
    reminderDaysBefore: s.reminderDaysBefore, overdueEveryDays: s.overdueEveryDays, overdueMaxReminders: s.overdueMaxReminders,
    gatewayEnabled: true,
  });
  if (r.statusCode !== 200) throw new Error(r.body);
});
afterAll(async () => {
  await ctx.owner.query('update billing_settings set gateway_enabled = false');
  await ctx.close();
  await asaas.close();
});

const settingsBody = (s: any) => ({
  autoEmail: s.autoEmail, pixKey: s.pixKey, beneficiary: s.beneficiary, instructions: s.instructions,
  reminderDaysBefore: s.reminderDaysBefore, overdueEveryDays: s.overdueEveryDays, overdueMaxReminders: s.overdueMaxReminders,
});

let cnpjSeq = 0;
/** CNPJ válido (dígitos verificadores calculados). */
function cnpj() {
  const base = `${String(Date.now() % 1e8).padStart(8, '0')}${String(++cnpjSeq).padStart(4, '0')}`.split('').map(Number);
  const dv = (n: number[]) => {
    const w = n.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const r = n.reduce((s, d, i) => s + d * w[i]!, 0) % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const d1 = dv(base);
  const d2 = dv([...base, d1]);
  return [...base, d1, d2].join('');
}

async function company(withCnpj = true) {
  const id = await createCompany(admin);
  const r = await admin.patch(`/api/companies/${id}`, { cnpj: withCnpj ? cnpj() : null, billingEmail: `${uniq('fin')}@example.test` });
  if (r.statusCode !== 200) throw new Error(r.body);
  return id;
}

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

async function charge(companyId: string, extra: Record<string, unknown> = {}) {
  const r = await admin.post('/api/billing/charges', {
    companyIds: [companyId], description: 'Mensalidade', amountCents: 150000, dueDate: inDays(10), recurrence: 'nenhuma', ...extra,
  });
  if (r.statusCode !== 201) throw new Error(r.body);
  const id = json(r).ids[0] as string;
  return json(await admin.get(`/api/billing/charges/${id}`));
}

const webhook = (event: string, payment: object, token = HOOK) =>
  ctx.app.inject({ method: 'POST', url: '/api/webhooks/asaas', headers: { 'asaas-access-token': token }, payload: { event, payment } });

describe('Asaas', () => {
  it('configurações mostram o ambiente; sem chave não liga', async () => {
    const s = json(await admin.get('/api/billing/settings'));
    expect(s.gatewayEnabled).toBe(true);
    expect(s.asaas).toMatchObject({ configured: true, environment: 'sandbox', webhookConfigured: true });
    expect(s.asaas.webhookUrl).toMatch(/\/api\/webhooks\/asaas$/);
    // Servidor sem a chave: não liga e o webhook recusa tudo.
    const other = await setupApp();
    try {
      const a2 = (await bootstrapAdmin(other)).agent;
      const r = await a2.put('/api/billing/settings', { ...settingsBody(s), gatewayEnabled: true });
      expect(r.statusCode).toBe(422);
      const w = await other.app.inject({ method: 'POST', url: '/api/webhooks/asaas', headers: { 'asaas-access-token': HOOK }, payload: {} });
      expect(w.statusCode).toBe(401);
    } finally {
      await other.close();
    }
  });

  it('cria cliente e cobrança no Asaas; o e-mail leva o link de pagamento', async () => {
    const co = await company();
    const c = await charge(co);
    expect(c.gatewayId).toMatch(/^pay_/);
    expect(c.paymentLink).toBe(`https://sandbox.asaas.com/i/${c.gatewayId}`);
    const pay = asaas.payments.get(c.gatewayId)!;
    expect(pay).toMatchObject({ value: 1500, dueDate: inDays(10), billingType: 'UNDEFINED', externalReference: c.id });
    expect(asaas.customers.get(pay.customer)!.notificationDisabled).toBe(true);
    const mail = ctx.mailer.outbox.find((m) => m.to === c.billingEmail);
    expect(mail?.text).toContain(c.paymentLink);
    // Segunda cobrança da mesma empresa reaproveita o cliente.
    const c2 = await charge(co);
    expect(asaas.payments.get(c2.gatewayId)!.customer).toBe(pay.customer);
  });

  it('empresa sem CNPJ: erro claro e o e-mail espera o link', async () => {
    const co = await company(false);
    const c = await charge(co);
    expect(c.gatewayId).toBeNull();
    expect(c.gatewayError).toContain('CNPJ');
    expect(ctx.mailer.outbox.some((m) => m.to === c.billingEmail)).toBe(false);
    // Cadastrou o CNPJ: o botão do Asaas gera a cobrança.
    await admin.patch(`/api/companies/${co}`, { cnpj: cnpj() });
    expect((await admin.post(`/api/billing/charges/${c.id}/gateway-sync`)).statusCode).toBe(200);
    expect(json(await admin.get(`/api/billing/charges/${c.id}`)).gatewayId).toMatch(/^pay_/);
  });

  it('webhook de pagamento dá baixa automática e envia recibo uma vez', async () => {
    const c = await charge(await company());
    expect((await webhook('PAYMENT_RECEIVED', { id: c.gatewayId, status: 'RECEIVED' }, 'errado-errado-errado')).statusCode).toBe(401);
    const payload = { id: c.gatewayId, status: 'RECEIVED', billingType: 'PIX', value: 1500, clientPaymentDate: inDays(0) };
    const r = await webhook('PAYMENT_RECEIVED', payload);
    expect(json(r)).toMatchObject({ ok: true, found: true, paid: true });
    const after = json(await admin.get(`/api/billing/charges/${c.id}`));
    expect(after).toMatchObject({ status: 'pago', paidVia: 'asaas', paidNote: 'Pago pelo Asaas (Pix)', gatewayStatus: 'RECEIVED' });
    expect(json(await webhook('PAYMENT_CONFIRMED', payload)).paid).toBe(false);
    const receipts = ctx.mailer.outbox.filter((m) => m.to === c.billingEmail && m.subject.startsWith('Pagamento confirmado'));
    expect(receipts).toHaveLength(1);
    // Pagamento desconhecido: 200 (o Asaas não fica reenviando).
    expect(json(await webhook('PAYMENT_RECEIVED', { id: 'pay_inexistente', status: 'RECEIVED' })).found).toBe(false);
  });

  it('editar, baixa manual e cancelar refletem no Asaas', async () => {
    const co = await company();
    const a = await charge(co);
    expect((await admin.patch(`/api/billing/charges/${a.id}`, { expectedVersion: a.version, amountCents: 99000, dueDate: inDays(20) })).statusCode).toBe(200);
    expect(asaas.payments.get(a.gatewayId)).toMatchObject({ value: 990, dueDate: inDays(20) });

    const b = await charge(co);
    expect((await admin.post(`/api/billing/charges/${b.id}/pay`, { expectedVersion: b.version, note: null, sendReceipt: false })).statusCode).toBe(200);
    expect(asaas.payments.get(b.gatewayId)!.status).toBe('RECEIVED_IN_CASH');
    expect(json(await admin.get(`/api/billing/charges/${b.id}`)).paidVia).toBe('manual');

    const c = await charge(co);
    expect((await admin.post(`/api/billing/charges/${c.id}/cancel`, { expectedVersion: c.version })).statusCode).toBe(200);
    expect(asaas.payments.get(c.gatewayId)!.deleted).toBe(true);
    expect(json(await admin.get(`/api/billing/charges/${c.id}`)).gatewayStatus).toBe('DELETED');
  });

  it('falha temporária fica pendente e a tarefa tenta de novo', async () => {
    const co = await company();
    asaas.failNext(1);
    const c = await charge(co);
    expect(c.gatewayId).toBeNull();
    expect(c.gatewayPending).toBe(true);
    expect(c.gatewayError).toContain('instabilidade');
    expect(await syncGateway(ctx.deps)).toMatchObject({ failed: 0 });
    expect(json(await admin.get(`/api/billing/charges/${c.id}`)).gatewayId).toMatch(/^pay_/);
  });

  it('"Atualizar do Asaas" dá baixa quando o webhook não chegou', async () => {
    const c = await charge(await company());
    Object.assign(asaas.payments.get(c.gatewayId)!, { status: 'CONFIRMED', billingType: 'CREDIT_CARD', paymentDate: inDays(0) });
    const r = await admin.post(`/api/billing/charges/${c.id}/gateway-sync`);
    if (r.statusCode !== 200) throw new Error(r.body);
    expect(json(r)).toMatchObject({ ok: true, paid: true });
    expect(json(await admin.get(`/api/billing/charges/${c.id}`))).toMatchObject({ status: 'pago', paidNote: 'Pago pelo Asaas (cartão)' });
  });

  it('cobrança mensal: cada parcela tem a sua cobrança no Asaas', async () => {
    const today = await todaySP(ctx.deps);
    const c = await charge(await company(), { dueDate: today, recurrence: 'mensal' });
    await generateRecurring(ctx.deps, today);
    const next = (await ctx.owner.query('select id, payment_link, gateway_dirty from charges where series_id = (select series_id from charges where id = $1) and series_index = 1', [c.id])).rows[0];
    expect(next).toMatchObject({ payment_link: null, gateway_dirty: true });
    await syncGateway(ctx.deps);
    const n = json(await admin.get(`/api/billing/charges/${next.id}`));
    expect(n.gatewayId).toMatch(/^pay_/);
    expect(n.gatewayId).not.toBe(c.gatewayId);
  });
});
