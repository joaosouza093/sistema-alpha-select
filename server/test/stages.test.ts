import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Agent, bootstrapAdmin, createApplication, createCandidate, createCompany, createProcess, inviteUser, json, setupApp, type TestCtx,
} from './helpers.js';

let ctx: TestCtx;
let admin: Agent;

beforeAll(async () => {
  ctx = await setupApp();
  admin = (await bootstrapAdmin(ctx)).agent;
});
afterAll(async () => {
  // Devolve as 4 etapas originais (as criadas aqui ficam desativadas, depois delas) para os outros arquivos de teste.
  await ctx.owner.query(`begin;
    update stages set is_active = (id <= 4), name = case id when 1 then 'RH Externo' when 2 then 'RH Interno' when 3 then 'CEO/Gestor'
      when 4 then 'Aprovação' else name end, position = case when id <= 4 then id else id + 100 end;
    commit;`);
  await ctx.close();
});

const active = async () => json(await admin.get('/api/stages')).items as { id: number; name: string; isApproval: boolean }[];

describe('etapas configuráveis', () => {
  it('administrador cria, renomeia, reordena e desativa; regras do quadro seguem as etapas ativas', async () => {
    const created = await admin.post('/api/stages', { name: 'Teste técnico' });
    expect(created.statusCode).toBe(201);
    const tecnico = json(created).id as number;
    expect((await admin.post('/api/stages', { name: 'teste técnico' })).statusCode).toBe(409);
    // Entra antes da aprovação.
    expect((await active()).map((s) => s.name)).toEqual(['RH Externo', 'RH Interno', 'CEO/Gestor', 'Teste técnico', 'Aprovação']);
    expect((await admin.patch('/api/stages/3', { name: 'Gestor da área' })).statusCode).toBe(200);
    // Reordena: teste técnico logo depois do RH Interno.
    expect((await admin.put('/api/stages/order', { ids: [1, 2, tecnico, 3, 4] })).statusCode).toBe(200);
    expect((await admin.put('/api/stages/order', { ids: [1, 2, 3, 4] })).statusCode).toBe(422);
    expect((await active()).map((s) => s.name)).toEqual(['RH Externo', 'RH Interno', 'Teste técnico', 'Gestor da área', 'Aprovação']);

    const companyId = await createCompany(admin);
    const processId = await createProcess(admin, companyId);
    const staff = await inviteUser(ctx, admin, 'alpha_staff');
    await admin.put(`/api/processes/${processId}/members/${staff.id}`, { canMoveStage: true, canDecide: true, canComment: true });
    const cand = await createCandidate(admin);
    const app = await createApplication(admin, cand, processId, undefined, { sent: false });
    const version = async () => json(await admin.get(`/api/applications/${app}`)).version;
    const move = (agent: Agent, toStageId: number) => version().then((v) => agent.post(`/api/applications/${app}/move`, { toStageId, expectedVersion: v }));

    expect((await move(staff.agent, 2)).statusCode).toBe(200);
    // Pula a etapa nova: só administrador.
    expect((await move(staff.agent, 3)).statusCode).toBe(422);
    expect((await move(staff.agent, tecnico)).statusCode).toBe(200);
    expect((await admin.post(`/api/applications/${app}/decision`, { decision: 'aprovado', expectedVersion: await version() })).statusCode).toBe(422);

    // Não desativa etapa com candidato em avaliação; nem a de aprovação; nem exclui etapa usada.
    expect((await admin.patch(`/api/stages/${tecnico}`, { isActive: false })).statusCode).toBe(409);
    expect((await admin.patch('/api/stages/4', { isActive: false })).statusCode).toBe(409);
    expect((await admin.delete(`/api/stages/${tecnico}`)).statusCode).toBe(409);
    expect((await move(staff.agent, 3)).statusCode).toBe(200);
    expect((await admin.patch(`/api/stages/${tecnico}`, { isActive: false })).statusCode).toBe(200);
    expect((await active()).map((s) => s.name)).toEqual(['RH Externo', 'RH Interno', 'Gestor da área', 'Aprovação']);
    // Sem a etapa desativada no meio, Gestor → Aprovação é vizinho.
    expect((await move(staff.agent, 4)).statusCode).toBe(200);
    expect((await move(staff.agent, tecnico)).statusCode).toBe(422);
    expect((await admin.post(`/api/applications/${app}/decision`, { decision: 'aprovado', expectedVersion: await version() })).statusCode).toBe(200);

    // Etapa nunca usada pode ser excluída.
    const temp = json(await admin.post('/api/stages', { name: 'Etapa temporária' })).id;
    expect((await admin.delete(`/api/stages/${temp}`)).statusCode).toBe(200);
    const all = json(await admin.get('/api/stages?all=1')).items;
    expect(all.find((s: any) => s.id === tecnico)).toMatchObject({ isActive: false, used: true });
  });

  it('nova etapa como primeira recebe os novos candidatos; equipe e cliente não alteram etapas', async () => {
    const triagem = json(await admin.post('/api/stages', { name: 'Pré-triagem' })).id as number;
    const ids = (json(await admin.get('/api/stages?all=1')).items as { id: number }[]).map((s) => s.id).filter((i) => i !== triagem);
    expect((await admin.put('/api/stages/order', { ids: [triagem, ...ids] })).statusCode).toBe(200);
    const companyId = await createCompany(admin);
    const processId = await createProcess(admin, companyId);
    const app = await createApplication(admin, await createCandidate(admin), processId, undefined, { sent: false });
    const a = json(await admin.get(`/api/applications/${app}`));
    expect(a.stageId).toBe(triagem);
    // Sair da primeira etapa ativa marca como enviado ao cliente.
    expect((await admin.post(`/api/applications/${app}/move`, { toStageId: 1, expectedVersion: a.version })).statusCode).toBe(200);
    expect((await ctx.owner.query('select sent_at is not null as sent from applications where id = $1', [app])).rows[0].sent).toBe(true);

    const staff = await inviteUser(ctx, admin, 'alpha_staff');
    expect((await staff.agent.post('/api/stages', { name: 'Da equipe' })).statusCode).toBe(403);
    expect((await staff.agent.patch('/api/stages/1', { name: 'Outro nome' })).statusCode).toBe(403);
    expect((await staff.agent.get('/api/stages?all=1')).statusCode).toBe(403);
    expect((await staff.agent.get('/api/stages')).statusCode).toBe(200);
  });
});
