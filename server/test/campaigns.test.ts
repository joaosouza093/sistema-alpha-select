import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMaintenance } from '../src/maintenance.js';
import {
  Agent, addMember, bootstrapAdmin, createApplication, createCandidate, createCompany, createProcess, inviteUser, json, setupApp, uniq,
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

const mailsTo = (email: string) => ctx.mailer.outbox.filter((m) => m.to === email);

describe('comunicados aos candidatos', () => {
  it('envio imediato para escolhidos e para o processo; variáveis, descadastrados e sem e-mail', async () => {
    const companyId = await createCompany(admin);
    const processId = await createProcess(admin, companyId, 'Analista de Compras');
    const a = `${uniq('com')}@example.test`;
    const b = `${uniq('com')}@example.test`;
    const ca = await createCandidate(admin, { fullName: 'Ana Comunicado Silva', email: a });
    const cb = await createCandidate(admin, { fullName: 'Bruno Optout', email: b });
    const cc = await createCandidate(admin, { fullName: 'Carla Sem Email', email: null });
    await createApplication(admin, ca, processId);
    await createApplication(admin, cb, processId);
    await ctx.owner.query('update candidates set email_opt_out_at = now() where id = $1', [cb]);

    const r = await admin.post('/api/campaigns', {
      subject: 'Atualização — {{vaga}}', body: 'Olá, {{candidato}} ({{nome_completo}}). Seguimos com a vaga {{vaga}}.',
      processId, candidateIds: [cc, ca],
    });
    expect(r.statusCode).toBe(201);
    expect(json(r)).toMatchObject({ total: 3, scheduled: false, result: { sent: 1, skipped: 2 } });
    const mail = mailsTo(a).at(-1)!;
    expect(mail.subject).toBe('Atualização — Analista de Compras');
    expect(mail.text).toContain('Olá, Ana (Ana Comunicado Silva). Seguimos com a vaga Analista de Compras.');
    expect(mail.text).toContain('/descadastrar#token=');
    expect(mailsTo(b)).toHaveLength(0);

    const d = json(await admin.get(`/api/campaigns/${json(r).id}`));
    expect(d).toMatchObject({ status: 'enviada', sent: 1, skipped: 2, failed: 0 });
    expect(d.recipients.map((x: any) => `${x.fullName}:${x.status}`).sort()).toEqual([
      'Ana Comunicado Silva:enviado', 'Bruno Optout:ignorado', 'Carla Sem Email:ignorado',
    ]);
    const log = await ctx.owner.query("select count(*)::int as n from message_log where template_key = 'comunicado' and candidate_id = $1", [ca]);
    expect(log.rows[0].n).toBe(1);
    // Rodar a tarefa de novo não reenvia.
    await runMaintenance(ctx.deps);
    expect(mailsTo(a)).toHaveLength(1);
  });

  it('agendado sai só na tarefa após o horário; cancelado não sai', async () => {
    const email = `${uniq('agenda')}@example.test`;
    const id = await createCandidate(admin, { fullName: 'Dora Agendada', email });
    const future = new Date(Date.now() + 3 * 3600_000).toISOString();
    const r = json(await admin.post('/api/campaigns', { subject: 'Lembrete', body: 'Olá, {{candidato}}. Lembrete do evento.', candidateIds: [id], scheduledAt: future }));
    expect(r.scheduled).toBe(true);
    await runMaintenance(ctx.deps);
    expect(mailsTo(email)).toHaveLength(0);
    await ctx.owner.query("update message_campaigns set scheduled_at = now() - interval '1 minute' where id = $1", [r.id]);
    await runMaintenance(ctx.deps);
    expect(mailsTo(email)).toHaveLength(1);
    expect((await admin.post(`/api/campaigns/${r.id}/cancel`)).statusCode).toBe(409);

    const c2 = json(await admin.post('/api/campaigns', { subject: 'Outro', body: 'Mensagem que não deve sair.', candidateIds: [id], scheduledAt: future }));
    expect((await admin.post(`/api/campaigns/${c2.id}/cancel`)).statusCode).toBe(200);
    await ctx.owner.query("update message_campaigns set scheduled_at = now() - interval '1 minute' where id = $1", [c2.id]);
    await runMaintenance(ctx.deps);
    expect(mailsTo(email)).toHaveLength(1);
  });

  it('equipe só alcança candidatos que pode ver; cliente não usa comunicados', async () => {
    const staff = await inviteUser(ctx, admin, 'alpha_staff');
    const companyId = await createCompany(admin);
    const processId = await createProcess(admin, companyId);
    const hidden = await createCandidate(admin, { email: `${uniq('oculto')}@example.test` });
    const own = await createCandidate(staff.agent, { email: `${uniq('proprio')}@example.test` });
    const r = await staff.agent.post('/api/campaigns', { subject: 'Teste', body: 'Mensagem da equipe.', candidateIds: [hidden, own] });
    expect(json(r).total).toBe(1);
    // Processo sem acesso: não encontrado.
    expect((await staff.agent.post('/api/campaigns', { subject: 'Teste', body: 'Mensagem da equipe.', processId })).statusCode).toBe(404);
    expect((await staff.agent.post('/api/campaigns', { subject: 'Teste', body: 'Mensagem da equipe.', candidateIds: [hidden] })).statusCode).toBe(422);
    // A equipe vê só os próprios comunicados; o administrador vê todos.
    expect(json(await staff.agent.get('/api/campaigns')).items.every((c: any) => c.createdByName === 'Usuário alpha_staff')).toBe(true);
    expect(json(await admin.get('/api/campaigns')).items.some((c: any) => c.id === json(r).id)).toBe(true);

    const manager = await inviteUser(ctx, admin, 'client_manager', companyId);
    await addMember(admin, processId, manager.id);
    expect((await manager.agent.get('/api/campaigns')).statusCode).toBe(403);
    expect((await manager.agent.post('/api/campaigns', { subject: 'X', body: 'Mensagem do cliente.', processId })).statusCode).toBe(403);
  });
});
