import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

const today = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10); // Brasília
const yearAgo = () => new Date(Date.now() - 365 * 86400_000).toISOString().slice(0, 10);
const period = (extra = '') => `/api/reports?from=${yearAgo()}&to=${today()}${extra}`;

async function evaluate(agent: Agent, appId: string, triageStatus: string, reason: string | null = null) {
  const r = await agent.put(`/api/applications/${appId}/evaluation`, { expectedVersion: null, triageStatus, ratings: [], reason, notes: null });
  if (r.statusCode !== 200) throw new Error(r.body);
}

async function scenario() {
  const companyId = await createCompany(admin);
  const processId = await createProcess(admin, companyId, uniq('Vaga'));
  const staff = await inviteUser(ctx, admin, 'alpha_staff');
  const client = await inviteUser(ctx, admin, 'client_manager', companyId);
  await addMember(admin, processId, staff.id, { canMoveStage: true });
  await addMember(admin, processId, client.id, { canMoveStage: true, canDecide: true });

  // 3 candidaturas: uma reprovada na triagem, duas aprovadas e enviadas; o cliente recusa uma.
  const apps: string[] = [];
  for (let i = 0; i < 3; i++) {
    const cand = await createCandidate(staff.agent, { email: `${uniq('rep')}@example.test` });
    apps.push(await createApplication(staff.agent, cand, processId, undefined, { sent: false }));
  }
  await evaluate(staff.agent, apps[0]!, 'reprovado_interno', 'experiencia');
  await evaluate(staff.agent, apps[1]!, 'aprovado_interno');
  await evaluate(staff.agent, apps[2]!, 'aprovado_interno');
  const item = (applicationId: string) => ({ applicationId, summary: null, shareEmail: false, sharePhone: false, shareSalary: false, shareDocuments: false });
  const s = await staff.agent.post(`/api/processes/${processId}/send-leads`, { items: [item(apps[1]!), item(apps[2]!)], confirmDuplicate: true });
  if (s.statusCode !== 200) throw new Error(s.body);
  const d = json(await client.agent.get(`/api/applications/${apps[1]}`));
  const r = await client.agent.post(`/api/applications/${apps[1]}/decision`, { decision: 'reprovado', reason: 'pretensao_salarial', expectedVersion: d.version });
  if (r.statusCode !== 200) throw new Error(r.body);
  return { companyId, processId, staff, client, apps };
}

describe('relatórios gerenciais', () => {
  it('totais por processo reproduzem os registros operacionais', async () => {
    const { processId, companyId, staff } = await scenario();
    const res = await admin.get(period(`&processId=${processId}`));
    if (res.statusCode !== 200) throw new Error(res.body);
    const r = json(res);
    expect(r.summary).toMatchObject({
      applications: 3, screened: 3, approvedInternal: 2, rejectedInternal: 1,
      sent: 2, awaitingFeedback: 1, hired: 0, rejectedClient: 1,
    });
    expect(r.byCompany).toHaveLength(1);
    expect(r.byCompany[0].id).toBe(companyId);
    expect(r.bySource).toEqual([expect.objectContaining({ id: 'interno', applications: 3 })]);
    expect(r.triageReasons).toEqual([{ reason: 'experiencia', count: 1 }]);
    expect(r.clientReasons).toEqual([{ reason: 'pretensao_salarial', count: 1 }]);
    const rec = r.byRecruiter.find((x: any) => x.id === staff.id);
    expect(rec).toMatchObject({ screened: 3, sent: 2 });
    expect(r.byMonth.reduce((s: number, m: any) => s + m.applications, 0)).toBe(3);
    expect(r.finance).not.toBeNull();
    expect(r.messages).not.toBeNull();
  });

  it('período sem participações traz tudo zerado', async () => {
    const { processId } = await scenario();
    const r = json(await admin.get(`/api/reports?from=2020-01-01&to=2020-12-31&processId=${processId}`));
    expect(r.summary.applications).toBe(0);
    expect(r.byProcess).toHaveLength(0);
  });

  it('equipe vê só os processos aos quais tem acesso e não vê financeiro nem mensagens', async () => {
    const a = await scenario();
    const b = await scenario();
    const r = json(await a.staff.agent.get(period()));
    const ids = r.byProcess.map((p: any) => p.id);
    expect(ids).toContain(a.processId);
    expect(ids).not.toContain(b.processId);
    expect(r.finance).toBeNull();
    expect(r.messages).toBeNull();
    // Filtro por processo de outra pessoa: nada vaza.
    expect(json(await a.staff.agent.get(period(`&processId=${b.processId}`))).summary.applications).toBe(0);
  });

  it('clientes não acessam; filtros inválidos são recusados', async () => {
    const { client } = await scenario();
    expect((await client.agent.get(period())).statusCode).toBe(403);
    expect((await new Agent(ctx).get(period())).statusCode).toBe(401);
    expect((await admin.get('/api/reports?from=2024-02-01&to=2024-01-01')).statusCode).toBe(422);
    expect((await admin.get('/api/reports?from=2020-01-01&to=2024-01-01')).statusCode).toBe(422);
    expect((await admin.get('/api/reports?from=x&to=2024-01-01')).statusCode).toBe(422);
    expect((await admin.get(`${period()}&extra=1`)).statusCode).toBe(422);
  });

  it('financeiro por empresa: pago, vencido, em aberto e adimplência', async () => {
    const companyId = await createCompany(admin);
    const mk = async (dueDate: string, amountCents: number) => {
      const r = await admin.post('/api/billing/charges', {
        companyIds: [companyId], description: 'Mensalidade', amountCents, dueDate, recurrence: 'nenhuma',
        billingEmail: 'fin@example.test', paymentLink: null,
      });
      if (r.statusCode !== 201) throw new Error(r.body);
      return (r.json().ids ?? [r.json().id])[0] as string;
    };
    const paid = await mk('2025-01-10', 10000);
    await mk('2025-01-20', 5000);
    const c = json(await admin.get(`/api/billing/charges/${paid}`));
    const p = await admin.post(`/api/billing/charges/${paid}/pay`, { expectedVersion: c.version ?? c.charge?.version, note: null, sendReceipt: false });
    if (p.statusCode !== 200) throw new Error(p.body);
    const r = json(await admin.get(`/api/reports?from=2025-01-01&to=2025-01-31&companyId=${companyId}`));
    expect(r.finance.byCompany).toHaveLength(1);
    expect(r.finance.totals).toMatchObject({ billedCents: 15000, paidCents: 10000, overdueCents: 5000, openCents: 0 });
    expect(r.finance.totals.complianceRate).toBeCloseTo(66.7, 1);
  });
});
