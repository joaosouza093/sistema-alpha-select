import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Agent,
  PDF,
  addMember,
  bootstrapAdmin,
  createApplication,
  createCandidate,
  createCompany,
  createProcess,
  inviteUser,
  json,
  setupApp,
  upload,
  type TestCtx,
} from './helpers.js';

/**
 * Cenário: empresas A e B, cada uma com seu processo. A mesma candidata
 * participa dos dois processos. Clientes de A não podem ver nada de B,
 * nem o cadastro completo da candidata, nem comentários internos.
 */
let ctx: TestCtx;
let admin: Agent;
let staff: { agent: Agent; id: string };
let clientA: { agent: Agent; id: string };
let clientA2: { agent: Agent; id: string };
let clientB: { agent: Agent; id: string };
let companyA: string;
let companyB: string;
let processA: string;
let processB: string;
let candidate: string;
let appA: string;
let appB: string;
let docShared: string;
let docOnlyB: string;

beforeAll(async () => {
  ctx = await setupApp();
  admin = (await bootstrapAdmin(ctx)).agent;
  companyA = await createCompany(admin, 'Empresa A Fictícia');
  companyB = await createCompany(admin, 'Empresa B Fictícia');
  processA = await createProcess(admin, companyA, 'Vaga A');
  processB = await createProcess(admin, companyB, 'Vaga B');
  staff = await inviteUser(ctx, admin, 'alpha_staff');
  clientA = await inviteUser(ctx, admin, 'client_user', companyA);
  clientA2 = await inviteUser(ctx, admin, 'client_user', companyA); // da empresa A, mas sem vínculo
  clientB = await inviteUser(ctx, admin, 'client_user', companyB);
  await addMember(admin, processA, staff.id, { canMoveStage: true });
  await addMember(admin, processB, staff.id, { canMoveStage: true });
  await addMember(admin, processA, clientA.id, { canComment: true });
  await addMember(admin, processB, clientB.id, { canComment: true });

  candidate = await createCandidate(staff.agent, {
    fullName: 'Maria Exemplo',
    email: 'maria.exemplo@example.test',
    phone: '(11) 98888-7777',
  });
  appA = await createApplication(staff.agent, candidate, processA);
  appB = await createApplication(staff.agent, candidate, processB);

  docShared = json(await upload(staff.agent, candidate, 'curriculo.pdf', 'application/pdf', PDF)).id;
  docOnlyB = json(await upload(staff.agent, candidate, 'laudo.pdf', 'application/pdf', PDF)).id;
  await staff.agent.put(`/api/applications/${appA}/documents/${docShared}`, { sharedWithClient: true });
  await staff.agent.put(`/api/applications/${appB}/documents/${docShared}`, { sharedWithClient: true });
  await staff.agent.put(`/api/applications/${appB}/documents/${docOnlyB}`, { sharedWithClient: true });

  await staff.agent.post(`/api/applications/${appA}/comments`, { body: 'INTERNO-A', visibility: 'internal' });
  await staff.agent.post(`/api/applications/${appA}/comments`, { body: 'COMPARTILHADO-A', visibility: 'shared' });
  await staff.agent.post(`/api/applications/${appB}/comments`, { body: 'COMPARTILHADO-B', visibility: 'shared' });
});

afterAll(async () => {
  await ctx.close();
});

describe('isolamento entre empresas clientes', () => {
  it('lista de processos mostra somente os liberados', async () => {
    const r = json(await clientA.agent.get('/api/processes'));
    expect(r.items.map((p: any) => p.id)).toEqual([processA]);
    expect(r.total).toBe(1);
    const none = json(await clientA2.agent.get('/api/processes'));
    expect(none.total).toBe(0);
  });

  it('acesso direto por ID a processo, quadro e participantes de outra empresa retorna 404', async () => {
    for (const url of [
      `/api/processes/${processB}`,
      `/api/processes/${processB}/board`,
      `/api/processes/${processB}/members`,
      `/api/applications/${appB}`,
      `/api/applications/${appB}/comments`,
      `/api/applications/${appB}/history`,
      `/api/applications/${appB}/documents`,
      `/api/applications/${appB}/owner-options`,
    ]) {
      const r = await clientA.agent.get(url);
      expect(r.statusCode, url).toBe(404);
      expect(r.body).not.toContain('Vaga B');
      expect(r.body).not.toContain('COMPARTILHADO-B');
    }
  });

  it('usuário da mesma empresa sem vínculo explícito não acessa o processo', async () => {
    expect((await clientA2.agent.get(`/api/processes/${processA}`)).statusCode).toBe(404);
    expect((await clientA2.agent.get(`/api/applications/${appA}`)).statusCode).toBe(404);
  });

  it('escritas em recursos de outra empresa são negadas', async () => {
    const detailB = json(await clientB.agent.get(`/api/applications/${appB}`));
    const c = await clientA.agent.post(`/api/applications/${appB}/comments`, { body: 'invasão', visibility: 'shared' });
    expect(c.statusCode).toBe(404);
    const m = await clientA.agent.post(`/api/applications/${appB}/move`, { toStageId: 2, expectedVersion: detailB.version });
    expect(m.statusCode).toBe(404);
  });

  it('cliente não acessa o cadastro de candidatos', async () => {
    expect((await clientA.agent.get('/api/candidates')).statusCode).toBe(403);
    expect((await clientA.agent.get(`/api/candidates/${candidate}`)).statusCode).toBe(403);
    expect((await clientA.agent.post('/api/candidates/check-duplicates', { email: 'maria.exemplo@example.test' })).statusCode).toBe(403);
  });

  it('participação exibe somente campos compartilhados; nunca observações internas', async () => {
    const r = await clientA.agent.get(`/api/applications/${appA}`);
    expect(r.statusCode).toBe(200);
    const d = json(r);
    expect(d.candidateName).toBe('Maria Exemplo');
    expect(d.candidateId).toBeNull();
    expect(d.candidateEmail).toBeNull();
    expect(d.candidatePhone).toBeNull();
    expect(d.candidateSalary).toBeNull();
    expect(d.shareEmail).toBeUndefined();
    expect(r.body).not.toContain('OBSERVACAO-INTERNA-SIGILOSA');
    expect(r.body).not.toContain('maria.exemplo@example.test');

    await staff.agent.patch(`/api/applications/${appA}/sharing`, {
      expectedVersion: d.version,
      shareEmail: true,
      sharePhone: false,
      shareSalary: false,
      sharedSummary: 'Resumo para o cliente',
    });
    const d2 = json(await clientA.agent.get(`/api/applications/${appA}`));
    expect(d2.candidateEmail).toBe('maria.exemplo@example.test');
    expect(d2.candidatePhone).toBeNull();
    expect(d2.sharedSummary).toBe('Resumo para o cliente');
    // Compartilhar na participação A não libera nada na B para o cliente B.
    const b = json(await clientB.agent.get(`/api/applications/${appB}`));
    expect(b.candidateEmail).toBeNull();
    expect(b.sharedSummary).toBeNull();
  });

  it('cliente não altera configuração de compartilhamento', async () => {
    const d = json(await clientA.agent.get(`/api/applications/${appA}`));
    const r = await clientA.agent.patch(`/api/applications/${appA}/sharing`, {
      expectedVersion: d.version,
      shareEmail: true,
      sharePhone: true,
      shareSalary: true,
      sharedSummary: null,
    });
    expect(r.statusCode).toBe(403);
  });

  it('comentários internos nunca chegam ao cliente', async () => {
    const r = await clientA.agent.get(`/api/applications/${appA}/comments`);
    const items = json(r).items;
    expect(items.map((c: any) => c.body)).toEqual(['COMPARTILHADO-A']);
    expect(r.body).not.toContain('INTERNO-A');
    const board = await clientA.agent.get(`/api/processes/${processA}/board`);
    expect(json(board).cards[0].commentCount).toBe(1);
  });

  it('documentos: cliente A vê só o compartilhado na participação A; documento de B é inacessível', async () => {
    const list = json(await clientA.agent.get(`/api/applications/${appA}/documents`)).items;
    expect(list.map((x: any) => x.id)).toEqual([docShared]);
    expect(list[0].sharedWithClient).toBeUndefined();
    expect(JSON.stringify(list)).not.toMatch(/storage|[0-9a-f]{2}\/[0-9a-f-]{36}/);
    expect((await clientA.agent.get(`/api/documents/${docShared}/content`)).statusCode).toBe(200);
    expect((await clientA.agent.get(`/api/documents/${docOnlyB}/content`)).statusCode).toBe(404);
    expect((await clientB.agent.get(`/api/documents/${docOnlyB}/content`)).statusCode).toBe(200);
  });

  it('dashboard e contadores consideram somente o escopo do usuário', async () => {
    const a = json(await clientA.agent.get('/api/dashboard'));
    expect(a.totals.activeProcesses).toBe(1);
    expect(a.totals.candidates).toBe(1);
    expect(a.byStage.reduce((s: number, x: any) => s + x.count, 0)).toBe(1);
    expect(JSON.stringify(a.recent)).not.toContain('Vaga B');
    const empty = json(await clientA2.agent.get('/api/dashboard'));
    expect(empty.totals).toEqual({ activeProcesses: 0, candidates: 0, openApplications: 0 });
    expect(empty.recent).toEqual([]);
  });

  it('lista de empresas e usuários respeita o escopo', async () => {
    const companies = json(await clientA.agent.get('/api/companies')).items;
    expect(companies.map((c: any) => c.id)).toEqual([companyA]);
    const users = json(await clientA.agent.get('/api/users')).items;
    const ids = users.map((u: any) => u.id);
    expect(ids).toContain(clientA.id);
    expect(ids).not.toContain(clientB.id);
    expect(ids).not.toContain(clientA2.id);
    expect((await clientA.agent.get(`/api/users/${clientB.id}`)).statusCode).toBe(404);
  });

  it('cliente não gerencia vínculos nem se inclui em processos', async () => {
    const r = await clientA.agent.put(`/api/processes/${processB}/members/${clientA.id}`, {
      canMoveStage: true,
      canDecide: true,
      canComment: true,
    });
    expect(r.statusCode).toBe(403);
  });

  it('banco recusa vincular usuário de outra empresa ao processo', async () => {
    const r = await admin.put(`/api/processes/${processA}/members/${clientB.id}`, {
      canMoveStage: false,
      canDecide: false,
      canComment: true,
    });
    expect(r.statusCode).toBe(422);
  });

  it('remover o vínculo revoga o acesso imediatamente, inclusive a documentos', async () => {
    const tmp = await inviteUser(ctx, admin, 'client_user', companyA);
    await addMember(admin, processA, tmp.id);
    expect((await tmp.agent.get(`/api/documents/${docShared}/content`)).statusCode).toBe(200);
    await admin.delete(`/api/processes/${processA}/members/${tmp.id}`);
    expect((await tmp.agent.get(`/api/documents/${docShared}/content`)).statusCode).toBe(404);
    expect((await tmp.agent.get(`/api/applications/${appA}`)).statusCode).toBe(404);
  });

  it('equipe Alpha sem vínculo ao processo não vê participações nem candidatos dele', async () => {
    const other = await inviteUser(ctx, admin, 'alpha_staff');
    expect((await other.agent.get(`/api/processes/${processA}`)).statusCode).toBe(404);
    expect((await other.agent.get(`/api/candidates/${candidate}`)).statusCode).toBe(404);
    expect(json(await other.agent.get('/api/candidates')).total).toBe(0);
    expect((await other.agent.get(`/api/documents/${docShared}/content`)).statusCode).toBe(404);
  });
});

describe('defesa em profundidade: RLS diretamente no banco', () => {
  async function asDbUser<T>(userId: string, sql: string, params: unknown[] = []) {
    const c = await ctx.deps.pools.app.connect();
    try {
      await c.query('begin');
      await c.query("select set_config('app.user_id', $1, true)", [userId]);
      const r = await c.query(sql, params);
      await c.query('rollback');
      return r.rows;
    } catch (e) {
      await c.query('rollback');
      throw e;
    } finally {
      c.release();
    }
  }

  it('cliente não lê candidates, comentários internos, auditoria nem credenciais', async () => {
    expect(await asDbUser(clientA.id, 'select * from candidates')).toHaveLength(0);
    const comments = await asDbUser(clientA.id, 'select body, visibility from comments');
    expect(comments.every((c: any) => c.visibility === 'shared')).toBe(true);
    expect(comments.map((c: any) => c.body)).not.toContain('COMPARTILHADO-B');
    expect(await asDbUser(clientA.id, 'select * from audit_events')).toHaveLength(0);
    await expect(asDbUser(clientA.id, 'select * from user_credentials')).rejects.toThrow(/permission denied/);
    await expect(asDbUser(clientA.id, 'select * from sessions')).rejects.toThrow(/permission denied/);
    await expect(asDbUser(clientA.id, 'select * from invites')).rejects.toThrow(/permission denied/);
  });

  it('a visão compartilhada nunca expõe observações internas e respeita o escopo', async () => {
    const rows = await asDbUser(clientA.id, 'select * from shared_application_candidates');
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!)).not.toContain('notes');
    expect(rows[0]!.application_id).toBe(appA);
  });

  it('sem usuário definido, nada é visível', async () => {
    const c = await ctx.deps.pools.app.connect();
    try {
      const r = await c.query('select count(*)::int as n from processes');
      expect(r.rows[0].n).toBe(0);
      const v = await c.query('select count(*)::int as n from shared_application_candidates');
      expect(v.rows[0].n).toBe(0);
    } finally {
      c.release();
    }
  });

  it('cliente não consegue alterar o próprio perfil ou empresa direto no banco', async () => {
    await expect(asDbUser(clientA.id, "update users set kind = 'alpha_admin' where id = $1 returning id", [clientA.id])).resolves.toHaveLength(0);
    await expect(asDbUser(clientA.id, 'update users set email = $2 where id = $1', [clientA.id, 'x@y.z'])).rejects.toThrow(/permission denied/);
    await expect(
      asDbUser(clientA2.id, 'insert into process_members (process_id, user_id) values ($1, $2)', [processA, clientA2.id]),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asDbUser(clientA.id, 'insert into process_members (process_id, user_id) values ($1, $2)', [processB, clientA.id]),
    ).rejects.toThrow();
  });
});
