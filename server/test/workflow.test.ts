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

let ctx: TestCtx;
let admin: Agent;
let adminId: string;

beforeAll(async () => {
  ctx = await setupApp();
  const a = await bootstrapAdmin(ctx);
  admin = a.agent;
  adminId = a.id;
});
afterAll(async () => {
  await ctx.close();
});

describe('fluxo completo: cliente → processo → candidato → documento → etapas → decisão', () => {
  it('executa o fluxo com usuários distintos e registra histórico', async () => {
    const company = await createCompany(admin);
    const process = await createProcess(admin, company, 'Analista Financeiro');
    const staff = await inviteUser(ctx, admin, 'alpha_staff');
    const rhInterno = await inviteUser(ctx, admin, 'client_user', company);
    const ceo = await inviteUser(ctx, admin, 'client_manager', company);
    await addMember(admin, process, staff.id, { canMoveStage: true });
    await addMember(admin, process, rhInterno.id, { canMoveStage: true, canComment: true });
    await addMember(admin, process, ceo.id, { canMoveStage: true, canDecide: true, canComment: true });

    const cand = await createCandidate(staff.agent, { fullName: 'João Fictício', phone: '11 91234-5678' });
    const app = await createApplication(staff.agent, cand, process, staff.id);
    const doc = json(await upload(staff.agent, cand, 'cv.pdf', 'application/pdf', PDF)).id;
    await staff.agent.put(`/api/applications/${app}/documents/${doc}`, { sharedWithClient: true });

    const version = async () => json(await admin.get(`/api/applications/${app}`)).version as number;

    // RH Externo → RH Interno, trocando o responsável
    let r = await staff.agent.post(`/api/applications/${app}/move`, {
      toStageId: 2,
      expectedVersion: await version(),
      ownerId: rhInterno.id,
    });
    expect(r.statusCode).toBe(200);
    // RH Interno → CEO/Gestor
    r = await rhInterno.agent.post(`/api/applications/${app}/move`, {
      toStageId: 3,
      expectedVersion: await version(),
      ownerId: ceo.id,
    });
    expect(r.statusCode).toBe(200);
    // CEO → Aprovação e decisão
    r = await ceo.agent.post(`/api/applications/${app}/move`, { toStageId: 4, expectedVersion: await version() });
    expect(r.statusCode).toBe(200);
    const detail = json(await ceo.agent.get(`/api/applications/${app}`));
    expect(detail.stageName).toBe('Aprovação');
    // Estar em "Aprovação" não significa aprovado.
    expect(detail.decision).toBe('pendente');
    r = await ceo.agent.post(`/api/applications/${app}/decision`, { decision: 'aprovado', expectedVersion: detail.version });
    expect(r.statusCode).toBe(200);

    const hist = json(await rhInterno.agent.get(`/api/applications/${app}/history`)).items;
    expect(hist).toHaveLength(5);
    const [dec, toApproval, toCeo, toInterno, created] = hist;
    expect(created.event).toBe('created');
    expect(toInterno).toMatchObject({ fromStageId: 1, toStageId: 2, toOwnerId: rhInterno.id });
    expect(toCeo).toMatchObject({ fromStageId: 2, toStageId: 3, fromOwnerId: rhInterno.id, toOwnerId: ceo.id });
    expect(toApproval).toMatchObject({ fromStageId: 3, toStageId: 4 });
    expect(dec).toMatchObject({ fromDecision: 'pendente', toDecision: 'aprovado', actorName: 'Usuário client_manager' });
    expect(toInterno.actorName).toBe('Usuário alpha_staff');

    // Persistência: nova "recarga" retorna o mesmo estado.
    const again = json(await rhInterno.agent.get(`/api/applications/${app}`));
    expect(again).toMatchObject({ stageId: 4, decision: 'aprovado', ownerId: ceo.id });
  });
});

describe('regras de transição e permissões', () => {
  let process: string;
  let staff: { agent: Agent; id: string };
  let viewer: { agent: Agent; id: string };
  let app: string;
  const version = async () => json(await admin.get(`/api/applications/${app}`)).version as number;

  beforeAll(async () => {
    const company = await createCompany(admin);
    process = await createProcess(admin, company);
    staff = await inviteUser(ctx, admin, 'alpha_staff');
    viewer = await inviteUser(ctx, admin, 'client_user', company);
    await addMember(admin, process, staff.id, { canMoveStage: true });
    await addMember(admin, process, viewer.id, { canMoveStage: false, canComment: false });
    const cand = await createCandidate(staff.agent);
    app = await createApplication(staff.agent, cand, process);
  });

  it('nega mover etapa sem permissão', async () => {
    const r = await viewer.agent.post(`/api/applications/${app}/move`, { toStageId: 2, expectedVersion: await version() });
    expect(r.statusCode).toBe(403);
  });

  it('nega decisão sem permissão', async () => {
    const r = await staff.agent.post(`/api/applications/${app}/decision`, { decision: 'reprovado', reason: 'experiencia', expectedVersion: await version() });
    expect(r.statusCode).toBe(403);
  });

  it('não permite pular etapas (exceto administrador)', async () => {
    const r = await staff.agent.post(`/api/applications/${app}/move`, { toStageId: 4, expectedVersion: await version() });
    expect(r.statusCode).toBe(422);
  });

  it('aprovação só pode ser registrada na etapa Aprovação', async () => {
    const r = await admin.post(`/api/applications/${app}/decision`, { decision: 'aprovado', expectedVersion: await version() });
    expect(r.statusCode).toBe(422);
  });

  it('decisão final impede mover etapa até ser reaberta', async () => {
    expect((await admin.post(`/api/applications/${app}/decision`, { decision: 'reprovado', reason: 'perfil_tecnico', expectedVersion: await version() })).statusCode).toBe(200);
    expect((await staff.agent.post(`/api/applications/${app}/move`, { toStageId: 2, expectedVersion: await version() })).statusCode).toBe(409);
    expect((await admin.post(`/api/applications/${app}/decision`, { decision: 'pendente', expectedVersion: await version() })).statusCode).toBe(200);
    expect((await staff.agent.post(`/api/applications/${app}/move`, { toStageId: 2, expectedVersion: await version() })).statusCode).toBe(200);
  });

  it('responsável precisa ter acesso ao processo', async () => {
    const outsider = await inviteUser(ctx, admin, 'alpha_staff');
    const r = await staff.agent.post(`/api/applications/${app}/owner`, { ownerId: outsider.id, expectedVersion: await version() });
    expect(r.statusCode).toBe(422);
    const ok = await staff.agent.post(`/api/applications/${app}/owner`, { ownerId: adminId, expectedVersion: await version() });
    expect(ok.statusCode).toBe(200);
  });

  it('atualizações simultâneas: a segunda com versão antiga recebe 409 e nada é sobrescrito', async () => {
    const v = await version();
    const [a, b] = await Promise.all([
      staff.agent.post(`/api/applications/${app}/move`, { toStageId: 3, expectedVersion: v }),
      admin.post(`/api/applications/${app}/move`, { toStageId: 1, expectedVersion: v }),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    const hist = json(await admin.get(`/api/applications/${app}/history`)).items;
    // Somente uma das duas movimentações foi registrada.
    const latest = hist[0];
    const detail = json(await admin.get(`/api/applications/${app}`));
    expect(latest.toStageId).toBe(detail.stageId);
  });

  it('processo arquivado não aceita alterações', async () => {
    const p = json(await admin.get(`/api/processes/${process}`));
    expect((await admin.patch(`/api/processes/${process}`, { expectedVersion: p.version, status: 'arquivado' })).statusCode).toBe(200);
    const r = await staff.agent.post(`/api/applications/${app}/move`, { toStageId: 2, expectedVersion: await version() });
    expect(r.statusCode).toBe(409);
    const p2 = json(await admin.get(`/api/processes/${process}`));
    await admin.patch(`/api/processes/${process}`, { expectedVersion: p2.version, status: 'em_andamento' });
  });

  it('edição de processo com versão desatualizada é recusada', async () => {
    const p = json(await admin.get(`/api/processes/${process}`));
    expect((await admin.patch(`/api/processes/${process}`, { expectedVersion: p.version, title: 'Título novo' })).statusCode).toBe(200);
    expect((await admin.patch(`/api/processes/${process}`, { expectedVersion: p.version, title: 'Outro' })).statusCode).toBe(409);
  });
});

describe('escalada de privilégios', () => {
  it('equipe não altera o próprio perfil nem o de outros', async () => {
    const staff = await inviteUser(ctx, admin, 'alpha_staff');
    expect((await staff.agent.patch(`/api/users/${staff.id}`, { kind: 'alpha_admin' })).statusCode).toBe(403);
    expect((await staff.agent.patch(`/api/users/${adminId}`, { isActive: false })).statusCode).toBe(403);
    const me = json(await staff.agent.get('/api/auth/me')).user;
    expect(me.kind).toBe('alpha_staff');
  });

  it('equipe não cria processos, empresas nem vínculos', async () => {
    const staff = await inviteUser(ctx, admin, 'alpha_staff');
    const company = await createCompany(admin);
    expect((await staff.agent.post('/api/companies', { name: 'Nova' })).statusCode).toBe(403);
    expect((await staff.agent.post('/api/processes', { companyId: company, title: 'Novo processo' })).statusCode).toBe(403);
    const p = await createProcess(admin, company);
    expect(
      (await staff.agent.put(`/api/processes/${p}/members/${staff.id}`, { canMoveStage: true, canDecide: true, canComment: true })).statusCode,
    ).toBe(403);
    expect((await staff.agent.get('/api/audit')).statusCode).toBe(403);
  });

  it('campos não permitidos no corpo são recusados', async () => {
    const staff = await inviteUser(ctx, admin, 'alpha_staff');
    const r = await staff.agent.post('/api/candidates', { fullName: 'Teste', createdBy: adminId });
    expect(r.statusCode).toBe(422);
  });
});

describe('candidatos: validação, normalização, duplicidade, busca e paginação', () => {
  it('normaliza e-mail e telefone e persiste após recarregar', async () => {
    const id = await createCandidate(admin, {
      fullName: '  Ana   Fictícia ',
      email: '  ANA.FICTICIA@Example.TEST ',
      phone: '(21) 3333-4444',
      salaryExpectation: '7.500,50',
    });
    const c = json(await admin.get(`/api/candidates/${id}`));
    expect(c.email).toBe('ana.ficticia@example.test');
    expect(c.phone).toBe('+552133334444');
    expect(c.salaryExpectation).toBe(7500.5);
    const upd = await admin.patch(`/api/candidates/${id}`, { expectedVersion: c.version, notes: 'Atualizado' });
    expect(upd.statusCode).toBe(200);
    const c2 = json(await admin.get(`/api/candidates/${id}`));
    expect(c2.notes).toBe('Atualizado');
    expect(c2.version).toBe(c.version + 1);
    const stale = await admin.patch(`/api/candidates/${id}`, { expectedVersion: c.version, notes: 'Sobrescrita' });
    expect(stale.statusCode).toBe(409);
  });

  it('rejeita dados inválidos', async () => {
    const bad = await admin.post('/api/candidates', { fullName: 'X', email: 'invalido', phone: '12' });
    expect(bad.statusCode).toBe(422);
    const fields = json(bad).error.fields;
    expect(Object.keys(fields)).toEqual(expect.arrayContaining(['fullName', 'email', 'phone']));
  });

  it('identifica possível duplicidade sem impedir cadastro confirmado', async () => {
    await createCandidate(admin, { fullName: 'Pessoa Duplicada', email: 'dup@example.test' });
    const r = await admin.post('/api/candidates', { fullName: 'Pessoa Duplicada 2', email: 'DUP@example.test' });
    expect(r.statusCode).toBe(409);
    expect(json(r).error.code).toBe('possible_duplicate');
    expect(json(r).error.details.matches.length).toBeGreaterThan(0);
    const ok = await admin.post('/api/candidates', { fullName: 'Pessoa Duplicada 2', email: 'dup@example.test', confirmDuplicate: true });
    expect(ok.statusCode).toBe(201);
  });

  it('equipe vê só a quantidade de duplicidades fora do seu escopo, sem dados', async () => {
    const staff = await inviteUser(ctx, admin, 'alpha_staff');
    await createCandidate(admin, { fullName: 'Fora do Escopo', email: 'escopo@example.test' });
    const r = await staff.agent.post('/api/candidates/check-duplicates', { email: 'escopo@example.test' });
    expect(json(r)).toEqual({ matches: [], hiddenCount: 1 });
  });

  it('busca e paginação respeitam o escopo e os filtros', async () => {
    const staff = await inviteUser(ctx, admin, 'alpha_staff');
    for (let i = 0; i < 7; i++) await createCandidate(staff.agent, { fullName: `Zeta Busca ${i}` });
    await createCandidate(admin, { fullName: 'Zeta Busca Admin' });
    const p1 = json(await staff.agent.get('/api/candidates?q=zeta&pageSize=5&page=1'));
    const p2 = json(await staff.agent.get('/api/candidates?q=zeta&pageSize=5&page=2'));
    expect(p1.total).toBe(7);
    expect(p1.items).toHaveLength(5);
    expect(p2.items).toHaveLength(2);
    expect(JSON.stringify([p1, p2])).not.toContain('Zeta Busca Admin');
    const adminView = json(await admin.get('/api/candidates?q=zeta&pageSize=50'));
    expect(adminView.total).toBe(8);
    // Curingas digitados não ampliam a busca.
    expect(json(await staff.agent.get('/api/candidates?q=%25')).total).toBe(0);
  });

  it('filtro por processo e etapa', async () => {
    const company = await createCompany(admin);
    const p = await createProcess(admin, company);
    const c1 = await createCandidate(admin, { fullName: 'Filtro Um' });
    const c2 = await createCandidate(admin, { fullName: 'Filtro Dois' });
    const a1 = await createApplication(admin, c1, p);
    await createApplication(admin, c2, p);
    const v = json(await admin.get(`/api/applications/${a1}`)).version;
    await admin.post(`/api/applications/${a1}/move`, { toStageId: 2, expectedVersion: v });
    const r = json(await admin.get(`/api/candidates?processId=${p}&stageId=2`));
    expect(r.items.map((x: any) => x.fullName)).toEqual(['Filtro Um']);
  });

  it('administrador elimina definitivamente candidato e arquivos', async () => {
    const id = await createCandidate(admin, { fullName: 'Para Eliminar' });
    const doc = json(await upload(admin, id, 'a.pdf', 'application/pdf', PDF)).id;
    const key = (await ctx.owner.query('select storage_key from documents where id = $1', [doc])).rows[0].storage_key;
    expect(await ctx.deps.storage.exists(key)).toBe(true);
    expect((await admin.delete(`/api/candidates/${id}`)).statusCode).toBe(200);
    expect((await admin.get(`/api/candidates/${id}`)).statusCode).toBe(404);
    expect(await ctx.deps.storage.exists(key)).toBe(false);
    const audit = json(await admin.get(`/api/audit?entityId=${id}`)).items;
    expect(audit.map((x: any) => x.action)).toContain('candidate.erased');
    expect(JSON.stringify(audit)).not.toContain('Para Eliminar');
  });
});

describe('auditoria', () => {
  it('registra eventos sem senhas ou tokens e é somente leitura', async () => {
    const r = json(await admin.get('/api/audit?pageSize=100'));
    expect(r.items.length).toBeGreaterThan(0);
    const text = JSON.stringify(r.items);
    expect(text).not.toMatch(/Senha-de-teste|token=|scrypt\$/);
    await expect(ctx.owner.query('delete from audit_events')).rejects.toThrow(/não podem ser alterados/);
  });
});
