import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withUser } from '../src/lib/db.js';
import { sendFeedbackReminders } from '../src/modules/messages/service.js';
import {
  Agent,
  addMember,
  bootstrapAdmin,
  createApplication,
  createCandidate,
  createCompany,
  createProcess,
  inviteUser,
  json,
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
  await ctx.close();
});

async function scenario() {
  const companyId = await createCompany(admin);
  const processId = await createProcess(admin, companyId, uniq('Vaga'));
  const staff = await inviteUser(ctx, admin, 'alpha_staff');
  const gestor = await inviteUser(ctx, admin, 'client_manager', companyId);
  const leitor = await inviteUser(ctx, admin, 'client_user', companyId);
  await addMember(admin, processId, staff.id, { canMoveStage: true });
  await addMember(admin, processId, gestor.id, { canMoveStage: true, canDecide: true });
  await addMember(admin, processId, leitor.id, { canComment: true });
  const email = `${uniq('cand')}@example.test`;
  const candidateId = await createCandidate(staff.agent, { email });
  return { companyId, processId, staff, gestor, leitor, email, candidateId };
}

const mailsTo = (to: string) => ctx.mailer.outbox.filter((m) => m.to === to);

async function setTemplate(key: string, enabled: boolean) {
  const t = json(await admin.get('/api/message-templates')).items.find((x: { key: string }) => x.key === key);
  const r = await admin.put(`/api/message-templates/${key}`, { enabled, subject: t.subject, body: t.body });
  expect(r.statusCode).toBe(200);
}

async function sendLead(staff: Agent, processId: string, applicationId: string) {
  const ev = await staff.put(`/api/applications/${applicationId}/evaluation`, { expectedVersion: null, triageStatus: 'aprovado_interno', ratings: [], reason: null, notes: null });
  expect(ev.statusCode).toBe(200);
  const r = await staff.post(`/api/processes/${processId}/send-leads`, {
    items: [{ applicationId, summary: null, shareEmail: false, sharePhone: false, shareSalary: false, shareDocuments: false }],
  });
  expect(r.statusCode).toBe(200);
}

describe('portal do cliente e mensagens ao candidato', () => {
  it('envio ao cliente avisa o candidato sem revelar empresa confidencial; descadastro interrompe e-mails', async () => {
    const { processId, staff, email, candidateId } = await scenario();
    const app = await createApplication(staff.agent, candidateId, processId, undefined, { sent: false });
    await sendLead(staff.agent, processId, app);
    const msg = mailsTo(email).find((m) => m.subject.startsWith('Seu perfil avançou'));
    expect(msg?.text).toContain('uma empresa parceira');
    const token = msg!.text.match(/descadastrar#token=([0-9a-f]{64})/)![1];
    expect((await new Agent(ctx).post('/api/public/unsubscribe', { token: 'f'.repeat(64) })).statusCode).toBe(200);
    expect((await new Agent(ctx).post('/api/public/unsubscribe', { token })).statusCode).toBe(200);
    // Depois do descadastro, nada mais é enviado.
    const before = mailsTo(email).length;
    const iv = await staff.agent.post(`/api/applications/${app}/interviews`, {
      scheduledAt: new Date(Date.now() + 86_400_000).toISOString(), mode: 'online', location: 'https://meet.example/abc', notes: null, notifyCandidate: true,
    });
    expect(json(iv).candidateNotified).toBe('skipped');
    expect(mailsTo(email).length).toBe(before);
    const log = json(await staff.agent.get(`/api/message-log?candidateId=${candidateId}`)).items;
    expect(log.map((l: { templateKey: string }) => l.templateKey)).toEqual(['perfil_enviado']);
  });

  it('entrevistas: gestor com permissão agenda; sem permissão recebe 403; só a Alpha avisa o candidato', async () => {
    const { processId, staff, gestor, leitor, email, candidateId } = await scenario();
    const app = await createApplication(staff.agent, candidateId, processId);
    const when = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const g = await gestor.agent.post(`/api/applications/${app}/interviews`, { scheduledAt: when, mode: 'presencial', location: 'Av. Exemplo, 100', notes: null, notifyCandidate: true });
    expect(g.statusCode).toBe(201);
    expect(json(g).candidateNotified).toBeNull();
    expect((await leitor.agent.post(`/api/applications/${app}/interviews`, { scheduledAt: when, mode: 'online', location: null, notes: null })).statusCode).toBe(403);
    const list = json(await leitor.agent.get(`/api/applications/${app}/interviews`));
    expect(list.items).toHaveLength(1);
    expect(list.canSchedule).toBe(false);
    const iv = list.items[0];
    expect((await leitor.agent.patch(`/api/interviews/${iv.id}`, { expectedVersion: iv.version, status: 'cancelada' })).statusCode).toBe(403);
    expect((await gestor.agent.patch(`/api/interviews/${iv.id}`, { expectedVersion: iv.version, status: 'realizada' })).statusCode).toBe(200);
    expect((await gestor.agent.patch(`/api/interviews/${iv.id}`, { expectedVersion: iv.version, status: 'cancelada' })).statusCode).toBe(409);
    const a = await staff.agent.post(`/api/applications/${app}/interviews`, { scheduledAt: when, mode: 'online', location: 'https://meet.example/x', notes: 'Levar portfólio', notifyCandidate: true });
    expect(json(a).candidateNotified).toBe('sent');
    const mail = mailsTo(email).find((m) => m.subject.startsWith('Entrevista agendada'));
    expect(mail?.text).toContain('On-line');
    expect(mail?.text).toContain('https://meet.example/x');
  });

  it('entrevistas de candidato ainda em triagem são invisíveis ao cliente (API e banco)', async () => {
    const { processId, staff, gestor, candidateId } = await scenario();
    const app = await createApplication(staff.agent, candidateId, processId, undefined, { sent: false });
    await staff.agent.post(`/api/applications/${app}/interviews`, { scheduledAt: new Date().toISOString(), mode: 'telefone', location: null, notes: 'triagem', notifyCandidate: false });
    expect((await gestor.agent.get(`/api/applications/${app}/interviews`)).statusCode).toBe(404);
    expect((await gestor.agent.post(`/api/applications/${app}/interviews`, { scheduledAt: new Date().toISOString(), mode: 'telefone', location: null, notes: null })).statusCode).toBe(404);
    const r = await withUser(ctx.deps.pools.app, gestor.id, (db) => db.query('select 1 from interviews i where i.application_id = $1', [app]));
    expect(r.rowCount).toBe(0);
  });

  it('modelos: administrador edita e liga/desliga; reprovação só avisa quando ligada', async () => {
    const { processId, staff, gestor, email, candidateId } = await scenario();
    expect((await staff.agent.get('/api/message-templates')).statusCode).toBe(403);
    expect((await gestor.agent.put('/api/message-templates/reprovacao', { enabled: true, subject: 'x', body: 'y' })).statusCode).toBe(403);
    const app = await createApplication(staff.agent, candidateId, processId);
    let d = json(await gestor.agent.get(`/api/applications/${app}`));
    await gestor.agent.post(`/api/applications/${app}/decision`, { decision: 'reprovado', reason: 'experiencia', expectedVersion: d.version });
    expect(mailsTo(email).some((m) => m.subject.startsWith('Processo seletivo'))).toBe(false);
    await setTemplate('reprovacao', true);
    d = json(await gestor.agent.get(`/api/applications/${app}`));
    await admin.post(`/api/applications/${app}/decision`, { decision: 'pendente', expectedVersion: d.version });
    d = json(await gestor.agent.get(`/api/applications/${app}`));
    await gestor.agent.post(`/api/applications/${app}/decision`, { decision: 'reprovado', reason: 'experiencia', expectedVersion: d.version });
    const mail = mailsTo(email).find((m) => m.subject.startsWith('Processo seletivo'));
    expect(mail).toBeTruthy();
    expect(mail!.text).not.toContain('experiencia'); // motivo interno não vai ao candidato
    await setTemplate('reprovacao', false);
    // Variáveis desconhecidas ficam como estão; quebras de linha não entram no assunto.
    const bad = await admin.put('/api/message-templates/perfil_enviado', { enabled: true, subject: 'Olá\r\nBcc: x@y.z {{candidato}}', body: 'Corpo de teste {{inexistente}}' });
    expect(bad.statusCode).toBe(200);
    const c2 = await createCandidate(staff.agent, { email: `${uniq('c2')}@example.test` });
    const app2 = await createApplication(staff.agent, c2, processId, undefined, { sent: false });
    await sendLead(staff.agent, processId, app2);
    const log = await ctx.owner.query("select subject from message_log where application_id = $1 and template_key = 'perfil_enviado'", [app2]);
    expect(log.rows[0].subject).not.toMatch(/[\r\n]/);
  });

  it('cliente: fila "aguardando seu retorno", indicadores por processo e lembrete diário de retorno', async () => {
    const { processId, staff, gestor, candidateId } = await scenario();
    const app = await createApplication(staff.agent, candidateId, processId);
    await ctx.owner.query("update applications set stage_changed_at = now() - interval '10 days' where id = $1", [app]);
    const dash = json(await gestor.agent.get('/api/dashboard'));
    const item = dash.awaiting.find((x: { id: string }) => x.id === app);
    expect(item).toMatchObject({ overdue: true });
    expect(dash.byProcess.find((p: { id: string }) => p.id === processId)).toMatchObject({ sent: 1, pending: 1 });
    expect(json(await staff.agent.get('/api/dashboard')).awaiting).toEqual([]);
    const before = mailsTo(gestor.email).length;
    await sendFeedbackReminders(ctx.deps, { anyHour: true });
    await sendFeedbackReminders(ctx.deps, { anyHour: true });
    const reminders = mailsTo(gestor.email).slice(before).filter((m) => m.subject.startsWith('Retorno pendente'));
    expect(reminders).toHaveLength(1);
    // Cliente não lê o histórico de mensagens.
    expect((await gestor.agent.get('/api/message-log')).statusCode).toBe(403);
  });
});
