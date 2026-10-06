import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sendCandidateMessage } from '../src/modules/messages/service.js';
import { Agent, PDF, bootstrapAdmin, createCandidate, createCompany, createProcess, json, setupApp, uniq, type TestCtx } from './helpers.js';
import { startFakeWhatsApp } from './fake-whatsapp.js';

const TOKEN = 'token-whatsapp-de-teste';
const SECRET = 'segredo-do-app-meta';
const VERIFY = 'verificacao-do-webhook-123';

let ctx: TestCtx;
let admin: Agent;
let wa: Awaited<ReturnType<typeof startFakeWhatsApp>>;

beforeAll(async () => {
  wa = await startFakeWhatsApp(TOKEN);
  ctx = await setupApp({
    WHATSAPP_TOKEN: TOKEN, WHATSAPP_PHONE_NUMBER_ID: '1234567890', WHATSAPP_APP_SECRET: SECRET,
    WHATSAPP_VERIFY_TOKEN: VERIFY, WHATSAPP_API_URL: wa.url,
  });
  admin = (await bootstrapAdmin(ctx)).agent;
});
afterAll(async () => {
  await ctx.owner.query("update message_templates set wa_enabled = false, wa_template = null");
  await ctx.owner.query("update billing_settings set wa_enabled = false, wa_templates = '{}'");
  await ctx.close();
  await wa.close();
});

async function setTemplate(key: string, waTemplate: string | null, waEnabled = true) {
  const t = json(await admin.get('/api/message-templates')).items.find((x: any) => x.key === key);
  return admin.put(`/api/message-templates/${key}`, { enabled: t.enabled, subject: t.subject, body: t.body, waEnabled, waTemplate, waLanguage: 'pt_BR' });
}

function applyBody(data: Record<string, unknown>) {
  const boundary = `----wa${Date.now()}`;
  const head =
    `--${boundary}\r\nContent-Disposition: form-data; name="dados"\r\n\r\n${JSON.stringify(data)}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="curriculo"; filename="cv.pdf"\r\nContent-Type: application/pdf\r\n\r\n`;
  return {
    payload: Buffer.concat([Buffer.from(head), PDF, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

async function publishedJob() {
  const processId = await createProcess(admin, await createCompany(admin), uniq('Vaga WhatsApp'));
  let p = json(await admin.get(`/api/processes/${processId}/job`));
  await admin.put(`/api/processes/${processId}/job`, {
    expectedVersion: p.version, jobLocation: 'Remoto', workModel: 'remoto', employmentType: 'clt', requirements: null, benefits: null,
    salaryMinCents: null, salaryMaxCents: null, showCompany: false, screeningQuestions: [],
  });
  p = json(await admin.get(`/api/processes/${processId}/job`));
  const pub = await admin.post(`/api/processes/${processId}/publication`, { expectedVersion: p.version, publication: 'publicada' });
  return { processId, slug: json(pub).publicSlug as string };
}

const sign = (raw: string, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
const hook = (body: object, signature?: string) => {
  const raw = JSON.stringify(body);
  return ctx.app.inject({
    method: 'POST', url: '/api/webhooks/whatsapp', payload: raw,
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature ?? sign(raw) },
  });
};

describe('WhatsApp', () => {
  it('modelos: exige nome do modelo; tela mostra configuração e ordem dos parâmetros', async () => {
    expect((await setTemplate('candidatura_recebida', null)).statusCode).toBe(422);
    expect((await setTemplate('candidatura_recebida', 'Nome Invalido')).statusCode).toBe(422);
    expect((await setTemplate('candidatura_recebida', 'candidatura_recebida_v1')).statusCode).toBe(200);
    const r = json(await admin.get('/api/message-templates'));
    expect(r.whatsapp).toMatchObject({ configured: true, webhookConfigured: true });
    expect(r.items.find((x: any) => x.key === 'entrevista_agendada').waParams).toEqual(['candidato', 'vaga', 'data_entrevista', 'formato', 'local']);
  });

  it('candidatura pelo portal com autorização envia o modelo; sem autorização, não', async () => {
    await setTemplate('candidatura_recebida', 'candidatura_recebida_v1');
    const { slug } = await publishedJob();
    const before = wa.sent.length;
    const yes = applyBody({ fullName: 'Ana Teste Silva', email: `${uniq('wa')}@example.test`, phone: '(11) 98888-1111', acceptPrivacy: true, whatsappOptIn: true });
    expect((await new Agent(ctx).request('POST', `/api/public/jobs/${slug}/apply`, yes.payload, yes.headers)).statusCode).toBe(201);
    const no = applyBody({ fullName: 'Bia Teste', email: `${uniq('wa')}@example.test`, phone: '(11) 98888-2222', acceptPrivacy: true });
    expect((await new Agent(ctx).request('POST', `/api/public/jobs/${slug}/apply`, no.payload, no.headers)).statusCode).toBe(201);
    const msgs = wa.sent.slice(before);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ to: '5511988881111', template: 'candidatura_recebida_v1', language: 'pt_BR' });
    expect(msgs[0]!.params[0]).toBe('Ana');
    expect(msgs[0]!.params[1]).toMatch(/^Vaga WhatsApp/);
    const log = await ctx.owner.query("select ok, delivery_status, provider_id from message_log where channel = 'whatsapp' and provider_id = $1", [msgs[0]!.id]);
    expect(log.rows).toEqual([{ ok: true, delivery_status: 'enviada', provider_id: msgs[0]!.id }]);
  });

  it('webhook: assinatura obrigatória, status de entrega e "SAIR" cancela', async () => {
    await setTemplate('perfil_enviado', 'perfil_enviado_v1');
    const id = await createCandidate(admin, { phone: '(21) 97777-3333', email: null });
    await ctx.owner.query('update candidates set whatsapp_opt_in_at = now() where id = $1', [id]);
    expect(await sendCandidateMessage(ctx.deps, 'perfil_enviado', { candidateId: id })).toBe('sent');
    const m = wa.sent.at(-1)!;
    expect(m.params).toEqual([expect.any(String), '-', '-']); // sem vaga: parâmetros vazios viram "-"

    const statuses = (status: string) => ({ entry: [{ changes: [{ value: { statuses: [{ id: m.id, status }] } }] }] });
    expect((await hook(statuses('read'), 'sha256=errada')).statusCode).toBe(401);
    expect((await hook(statuses('read'), sign(JSON.stringify(statuses('read')), 'outro'))).statusCode).toBe(401);
    expect(json(await hook(statuses('read'))).statuses).toBe(1);
    expect(json(await hook(statuses('delivered'))).statuses).toBe(0); // não regride de "lida" para "entregue"
    const st = await ctx.owner.query('select delivery_status from message_log where provider_id = $1', [m.id]);
    expect(st.rows[0].delivery_status).toBe('lida');

    const inbound = { entry: [{ changes: [{ value: { messages: [{ from: '5521977773333', type: 'text', text: { body: ' Sair ' } }] } }] }] };
    expect(json(await hook(inbound)).optOuts).toBe(1);
    expect(await sendCandidateMessage(ctx.deps, 'perfil_enviado', { candidateId: id })).toBe('skipped');
  });

  it('confirmação da URL do webhook', async () => {
    const ok = await ctx.app.inject({ method: 'GET', url: `/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=4242` });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('4242');
    const bad = await ctx.app.inject({ method: 'GET', url: '/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=4242' });
    expect(bad.statusCode).toBe(403);
  });

  it('falha da Meta fica registrada com o motivo', async () => {
    await setTemplate('perfil_enviado', 'perfil_enviado_v1');
    const id = await createCandidate(admin, { phone: '(31) 96666-4444', email: null });
    await ctx.owner.query('update candidates set whatsapp_opt_in_at = now() where id = $1', [id]);
    wa.failNext(1);
    expect(await sendCandidateMessage(ctx.deps, 'perfil_enviado', { candidateId: id })).toBe('failed');
    const r = await ctx.owner.query("select ok, error, delivery_status from message_log where candidate_id = $1 and channel = 'whatsapp'", [id]);
    expect(r.rows[0]).toMatchObject({ ok: false, delivery_status: 'falhou' });
    expect(r.rows[0].error).toContain('132001');
  });

  it('área do candidato liga e desliga; sem telefone não liga', async () => {
    const email = `${uniq('wa-portal')}@example.test`;
    await createCandidate(admin, { email, phone: null });
    await new Agent(ctx).post('/api/public/my-data/request', { email });
    const token = [...ctx.mailer.outbox].reverse().find((x) => x.to === email)!.text.match(/token=([\w-]+)/)![1]!;
    const call = (payload: object, url = '/api/public/my-data/whatsapp', method: 'POST' | 'PATCH' = 'POST') =>
      ctx.app.inject({ method, url, headers: { 'x-candidate-token': token }, payload });
    expect((await call({ optIn: true })).statusCode).toBe(422);
    await call({ fullName: 'Com Telefone', phone: '(41) 95555-6666', city: null, salaryExpectation: null }, '/api/public/my-data', 'PATCH');
    expect((await call({ optIn: true })).statusCode).toBe(200);
    const me = json(await ctx.app.inject({ method: 'GET', url: '/api/public/my-data', headers: { 'x-candidate-token': token } }));
    expect(me.whatsappOptInAt).not.toBeNull();
    expect((await call({ optIn: false })).statusCode).toBe(200);
  });

  it('cobrança: aviso pelo WhatsApp do financeiro da empresa junto com o e-mail', async () => {
    const companyId = await createCompany(admin);
    await admin.patch(`/api/companies/${companyId}`, { billingEmail: `${uniq('fin')}@example.test`, billingWhatsapp: '(11) 94444-5555' });
    const s = json(await admin.get('/api/billing/settings'));
    expect(s.whatsappConfigured).toBe(true);
    const put = await admin.put('/api/billing/settings', {
      autoEmail: true, pixKey: null, beneficiary: null, instructions: null,
      reminderDaysBefore: s.reminderDaysBefore, overdueEveryDays: s.overdueEveryDays, overdueMaxReminders: s.overdueMaxReminders,
      whatsappEnabled: true, whatsappTemplates: { criada: 'cobranca_nova_v1' },
    });
    expect(put.statusCode).toBe(200);
    const before = wa.sent.length;
    const due = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    const r = await admin.post('/api/billing/charges', { companyIds: [companyId], description: 'Mensalidade', amountCents: 250000, dueDate: due, recurrence: 'nenhuma' });
    expect(r.statusCode).toBe(201);
    const m = wa.sent.slice(before);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ to: '5511944445555', template: 'cobranca_nova_v1' });
    expect(m[0]!.params[2]).toContain('2.500,00');
    const c = json(await admin.get(`/api/billing/charges/${json(r).ids[0]}`));
    expect(c.notices.map((n: any) => n.kind).sort()).toEqual(['criada', 'criada']);
  });
});
