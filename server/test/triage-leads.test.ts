import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withUser } from '../src/lib/db.js';
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
  const client = await inviteUser(ctx, admin, 'client_manager', companyId);
  await addMember(admin, processId, staff.id, { canMoveStage: true });
  await addMember(admin, processId, client.id, { canMoveStage: true, canDecide: true });
  return { companyId, processId, staff, client };
}

async function newApp(agent: Agent, processId: string, data: Record<string, unknown> = {}) {
  const cand = await createCandidate(agent, data);
  return createApplication(agent, cand, processId, undefined, { sent: false });
}

async function evaluate(agent: Agent, appId: string, body: Record<string, unknown>) {
  const cur = json(await agent.get(`/api/applications/${appId}/evaluation`));
  return agent.put(`/api/applications/${appId}/evaluation`, {
    expectedVersion: cur.evaluation?.version ?? null,
    ratings: [],
    reason: null,
    notes: null,
    ...body,
  });
}

const sendItem = (applicationId: string, over: Record<string, unknown> = {}) => ({
  applicationId, summary: 'Perfil aderente, comunicação clara.', shareEmail: false, sharePhone: true, shareSalary: false, shareDocuments: true, ...over,
});

describe('triagem e envio de leads', () => {
  it('candidato em triagem é invisível ao cliente até ser enviado (API e banco)', async () => {
    const { processId, staff, client } = await scenario();
    const app = await newApp(staff.agent, processId);
    expect(json(await client.agent.get(`/api/processes/${processId}/board`)).cards).toHaveLength(0);
    expect((await client.agent.get(`/api/applications/${app}`)).statusCode).toBe(404);
    expect((await client.agent.get(`/api/applications/${app}/comments`)).statusCode).toBe(404);
    const r = await withUser(ctx.deps.pools.app, client.id, (db) =>
      db.query('select id from applications where id = $1 union all select application_id from shared_application_candidates where application_id = $1', [app]),
    );
    expect(r.rowCount).toBe(0);
    expect(json(await client.agent.get('/api/dashboard')).leads.inTriage).toBe(0);
  });

  it('ficha de avaliação calcula a nota; reprovação exige motivo; cliente não acessa', async () => {
    const { processId, staff, client } = await scenario();
    const p = json(await admin.get(`/api/processes/${processId}`));
    expect((await admin.put(`/api/processes/${processId}/triage-config`, { expectedVersion: p.version, slaDays: 2, evaluationCriteria: ['Experiência', 'Comunicação'] })).statusCode).toBe(200);
    expect((await staff.agent.put(`/api/processes/${processId}/triage-config`, { expectedVersion: p.version + 1, slaDays: 5, evaluationCriteria: [] })).statusCode).toBe(403);
    const app = await newApp(staff.agent, processId);
    const ev = json(await staff.agent.get(`/api/applications/${app}/evaluation`));
    expect(ev.criteria).toEqual(['Experiência', 'Comunicação']);
    expect((await evaluate(staff.agent, app, { triageStatus: 'reprovado_interno' })).statusCode).toBe(422);
    const ok = await evaluate(staff.agent, app, { triageStatus: 'em_triagem', ratings: [{ criterion: 'Experiência', score: 5 }, { criterion: 'Comunicação', score: 4 }] });
    expect(json(ok).score).toBe(4.5);
    // Versão desatualizada recusada.
    expect((await staff.agent.put(`/api/applications/${app}/evaluation`, { expectedVersion: null, triageStatus: 'em_triagem', ratings: [], reason: null, notes: null })).statusCode).toBe(409);
    expect((await client.agent.get(`/api/applications/${app}/evaluation`)).statusCode).toBe(403);
    await ctx.owner.query('update applications set sent_at = now() where id = $1', [app]);
    const rows = await withUser(ctx.deps.pools.app, client.id, (db) => db.query('select * from application_evaluations'));
    expect(rows.rowCount).toBe(0);
  });

  it('envio em lote: exige triagem aprovada, move para RH Interno, compartilha o escolhido e avisa o cliente', async () => {
    const { processId, staff, client } = await scenario();
    const a1 = await newApp(staff.agent, processId, { phone: '+5511999990001' });
    const a2 = await newApp(staff.agent, processId, { phone: '+5511999990002' });
    const notApproved = await staff.agent.post(`/api/processes/${processId}/send-leads`, { items: [sendItem(a1)] });
    expect(notApproved.statusCode).toBe(409);
    await evaluate(staff.agent, a1, { triageStatus: 'aprovado_interno' });
    await evaluate(staff.agent, a2, { triageStatus: 'aprovado_interno' });
    const r = await staff.agent.post(`/api/processes/${processId}/send-leads`, { items: [sendItem(a1), sendItem(a2, { sharePhone: false })] });
    expect(r.statusCode).toBe(200);
    expect(json(r).count).toBe(2);
    const board = json(await client.agent.get(`/api/processes/${processId}/board`));
    expect(board.cards).toHaveLength(2);
    expect(board.cards.every((c: { stageId: number }) => c.stageId === 2)).toBe(true);
    const d1 = json(await client.agent.get(`/api/applications/${a1}`));
    expect(d1.sharedSummary).toBe('Perfil aderente, comunicação clara.');
    expect(d1.candidateEmail).toBeNull();
    expect(d1.candidatePhone).not.toBeNull();
    expect(json(await client.agent.get(`/api/applications/${a2}`)).candidatePhone).toBeNull();
    expect(ctx.mailer.outbox.some((m) => m.to === client.email && m.subject.includes('2 novos candidatos'))).toBe(true);
    // Não envia duas vezes e o envio não pode ser desfeito.
    expect((await staff.agent.post(`/api/processes/${processId}/send-leads`, { items: [sendItem(a1)] })).statusCode).toBe(409);
    await expect(ctx.owner.query('update applications set sent_at = null where id = $1', [a1])).rejects.toMatchObject({ code: 'AS409' });
    const leads = await ctx.owner.query('select count(*)::int as n from lead_submissions where process_id = $1', [processId]);
    expect(leads.rows[0].n).toBe(2);
  });

  it('avisa quando o mesmo candidato já foi enviado à empresa em outro processo', async () => {
    const { companyId, processId, staff } = await scenario();
    const other = await createProcess(admin, companyId, uniq('Outra vaga'));
    await addMember(admin, other, staff.id, { canMoveStage: true });
    const email = `${uniq('repetido')}@example.test`;
    const a1 = await newApp(staff.agent, processId, { email });
    await evaluate(staff.agent, a1, { triageStatus: 'aprovado_interno' });
    expect((await staff.agent.post(`/api/processes/${processId}/send-leads`, { items: [sendItem(a1)] })).statusCode).toBe(200);
    const a2 = await newApp(staff.agent, other, { email });
    await evaluate(staff.agent, a2, { triageStatus: 'aprovado_interno' });
    const dup = await staff.agent.post(`/api/processes/${other}/send-leads`, { items: [sendItem(a2)] });
    expect(dup.statusCode).toBe(409);
    expect(json(dup).error.code).toBe('possible_duplicate');
    expect((await staff.agent.post(`/api/processes/${other}/send-leads`, { items: [sendItem(a2)], confirmDuplicate: true })).statusCode).toBe(200);
  });

  it('cliente não envia leads; equipe sem permissão de mover etapa também não', async () => {
    const { processId, client } = await scenario();
    const staffNoMove = await inviteUser(ctx, admin, 'alpha_staff');
    await addMember(admin, processId, staffNoMove.id, { canMoveStage: false });
    const app = await newApp(staffNoMove.agent, processId);
    await evaluate(staffNoMove.agent, app, { triageStatus: 'aprovado_interno' });
    expect((await staffNoMove.agent.post(`/api/processes/${processId}/send-leads`, { items: [sendItem(app)] })).statusCode).toBe(403);
    expect((await client.agent.post(`/api/processes/${processId}/send-leads`, { items: [sendItem(app)] })).statusCode).toBe(403);
  });

  it('reprovação e desistência exigem motivo padronizado; motivo aparece para o cliente', async () => {
    const { processId, staff, client } = await scenario();
    const app = await newApp(staff.agent, processId);
    await evaluate(staff.agent, app, { triageStatus: 'aprovado_interno' });
    await staff.agent.post(`/api/processes/${processId}/send-leads`, { items: [sendItem(app)] });
    let d = json(await client.agent.get(`/api/applications/${app}`));
    expect((await client.agent.post(`/api/applications/${app}/decision`, { decision: 'reprovado', expectedVersion: d.version })).statusCode).toBe(422);
    expect((await client.agent.post(`/api/applications/${app}/decision`, { decision: 'reprovado', reason: 'inventado', expectedVersion: d.version })).statusCode).toBe(422);
    expect((await client.agent.post(`/api/applications/${app}/decision`, { decision: 'reprovado', reason: 'pretensao_salarial', expectedVersion: d.version })).statusCode).toBe(200);
    d = json(await client.agent.get(`/api/applications/${app}`));
    expect(d.decisionReason).toBe('pretensao_salarial');
    // Reabrir limpa o motivo.
    await admin.post(`/api/applications/${app}/decision`, { decision: 'pendente', expectedVersion: d.version });
    expect(json(await admin.get(`/api/applications/${app}`)).decisionReason).toBeNull();
  });

  it('SLA: participação parada além do prazo aparece como atrasada no quadro e no painel', async () => {
    const { processId, staff, client } = await scenario();
    const app = await newApp(staff.agent, processId);
    await evaluate(staff.agent, app, { triageStatus: 'aprovado_interno' });
    await staff.agent.post(`/api/processes/${processId}/send-leads`, { items: [sendItem(app)] });
    await ctx.owner.query("update applications set stage_changed_at = now() - interval '10 days' where id = $1", [app]);
    const card = json(await client.agent.get(`/api/processes/${processId}/board`)).cards[0];
    expect(card.slaOverdue).toBe(true);
    expect(json(await client.agent.get('/api/dashboard')).leads.overdue).toBeGreaterThanOrEqual(1);
    const funnel = json(await admin.get(`/api/processes/${processId}/board`)).funnel;
    expect(funnel).toMatchObject({ total: 1, enviados: 1, aprovadosInternos: 1, emTriagem: 0 });
  });
});
