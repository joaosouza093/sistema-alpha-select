import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validCpf } from '../src/modules/candidates/admission.js';
import {
  Agent, PDF, addMember, bootstrapAdmin, createApplication, createCandidate, createCompany, createProcess, inviteUser, json,
  multipartBody, setupApp, uniq, type TestCtx,
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

const linkToken = (to: string) => {
  const m = [...ctx.mailer.outbox].reverse().find((x) => x.to === to)?.text.match(/meus-dados#token=([A-Za-z0-9_-]+)/);
  if (!m) throw new Error(`sem link para ${to}`);
  return m[1]!;
};
const cand = (token: string) => ({
  get: (url: string) => ctx.app.inject({ method: 'GET', url, headers: { 'x-candidate-token': token } }),
  put: (url: string, payload: object) => ctx.app.inject({ method: 'PUT', url, headers: { 'x-candidate-token': token }, payload }),
});

const FORM = {
  fullName: 'Ana Admissão Souza', birthDate: '1992-04-10', sex: 'feminino', maritalStatus: 'solteiro', nationality: 'Brasileira',
  birthplaceCity: 'Campinas', birthplaceState: 'sp', cpf: '529.982.247-25', rg: '12.345.678-9', rgIssuer: 'SSP', rgState: 'SP',
  rgIssueDate: '2010-06-01', address: 'Rua das Flores, 100, apto 12, Centro, Campinas/SP, 13010-000', mobilePhone: '(19) 98888-7777',
  motherName: 'Maria Souza', fatherName: '', acceptTerms: true,
};

async function approvedScenario() {
  const companyId = await createCompany(admin);
  const processId = await createProcess(admin, companyId);
  const email = `${uniq('adm')}@example.test`;
  const candidateId = await createCandidate(admin, { fullName: 'Ana Admissão', email });
  const appId = await createApplication(admin, candidateId, processId);
  return { companyId, processId, email, candidateId, appId };
}
const approve = async (appId: string) => {
  for (const stage of [2, 3, 4]) {
    const v = json(await admin.get(`/api/applications/${appId}`)).version;
    expect((await admin.post(`/api/applications/${appId}/move`, { toStageId: stage, expectedVersion: v })).statusCode).toBe(200);
  }
  const v = json(await admin.get(`/api/applications/${appId}`)).version;
  expect((await admin.post(`/api/applications/${appId}/decision`, { decision: 'aprovado', expectedVersion: v })).statusCode).toBe(200);
};

describe('dados pessoais para admissão', () => {
  it('CPF: dígitos verificadores', () => {
    expect(validCpf('52998224725')).toBe(true);
    expect(validCpf('52998224724')).toBe(false);
    expect(validCpf('11111111111')).toBe(false);
  });

  it('só depois da aprovação: e-mail com link, formulário com termo, equipe Alpha lê', async () => {
    const s = await approvedScenario();
    // Antes da aprovação: link comum do "Meus dados" não dá acesso ao formulário.
    await new Agent(ctx).post('/api/public/my-data/request', { email: s.email });
    const early = cand(linkToken(s.email));
    expect(json(await early.get('/api/public/my-data')).admission).toMatchObject({ available: false, data: null });
    expect((await early.put('/api/public/my-data/admission', FORM)).statusCode).toBe(403);
    expect((await admin.post(`/api/candidates/${s.candidateId}/admission-link`)).statusCode).toBe(409);

    await approve(s.appId);
    const mail = [...ctx.mailer.outbox].reverse().find((m) => m.to === s.email)!;
    expect(mail.subject).toContain('Complete seus dados');
    const c = cand(linkToken(s.email));
    const me = json(await c.get('/api/public/my-data'));
    expect(me.admission.available).toBe(true);
    expect(me.admission.consentText).toContain('Lei nº 13.709/2018 (LGPD)');

    // Termo obrigatório; CPF validado.
    expect((await c.put('/api/public/my-data/admission', { ...FORM, acceptTerms: false })).statusCode).toBe(422);
    const bad = await c.put('/api/public/my-data/admission', { ...FORM, cpf: '123.456.789-00' });
    expect(bad.statusCode).toBe(422);
    expect(json(bad).error.fields).toHaveProperty('cpf');
    expect((await c.put('/api/public/my-data/admission', FORM)).statusCode).toBe(200);
    // Corrigir depois sobrescreve.
    expect((await c.put('/api/public/my-data/admission', { ...FORM, maritalStatus: 'casado' })).statusCode).toBe(200);

    const saved = json(await c.get('/api/public/my-data')).admission.data;
    expect(saved).toMatchObject({ cpf: '52998224725', birthplaceState: 'SP', mobilePhone: '+5519988887777', maritalStatus: 'casado', fatherName: null });
    const view = json(await admin.get(`/api/candidates/${s.candidateId}/admission`));
    expect(view).toMatchObject({ approved: true, data: { fullName: 'Ana Admissão Souza', rg: '12.345.678-9', motherName: 'Maria Souza' } });
    const row = (await ctx.owner.query('select consent_text from candidate_admission_data where candidate_id = $1', [s.candidateId])).rows[0];
    expect(row.consent_text).toContain('autorizo o tratamento dos meus dados pessoais');
    // Exportações do titular incluem os dados.
    expect(JSON.parse((await c.get('/api/public/my-data/export')).body).dadosParaAdmissao[0].cpf).toBe('52998224725');

    // Link manual pela equipe (para enviar por WhatsApp quando não houver e-mail configurado).
    const link = json(await admin.post(`/api/candidates/${s.candidateId}/admission-link`));
    expect(link.link).toMatch(/\/meus-dados#token=/);
  });

  it('cliente nunca vê os dados de admissão (API e banco)', async () => {
    const s = await approvedScenario();
    await approve(s.appId);
    await cand(linkToken(s.email)).put('/api/public/my-data/admission', FORM);
    const manager = await inviteUser(ctx, admin, 'client_manager', s.companyId);
    await addMember(admin, s.processId, manager.id, { canDecide: true });
    expect((await manager.agent.get(`/api/candidates/${s.candidateId}/admission`)).statusCode).toBe(403);
    expect((await manager.agent.post(`/api/candidates/${s.candidateId}/admission-link`)).statusCode).toBe(403);
    const { withUser } = await import('../src/lib/db.js');
    const rows = await withUser(ctx.deps.pools.app, manager.id, (db) => db.query('select * from candidate_admission_data'));
    expect(rows.rowCount).toBe(0);
    // Equipe sem acesso ao candidato também não lê.
    const staff = await inviteUser(ctx, admin, 'alpha_staff');
    expect(json(await staff.agent.get(`/api/candidates/${s.candidateId}/admission`)).data ?? null).toBeNull();
  });

  it('novas categorias de documento: antecedentes criminais e processos', async () => {
    const id = await createCandidate(admin);
    for (const kind of ['antecedentes_criminais', 'processos']) {
      const { payload, contentType } = multipartBody('doc.pdf', 'application/pdf', PDF, kind);
      const r = await admin.request('POST', `/api/candidates/${id}/documents`, payload, { 'content-type': contentType });
      expect(r.statusCode).toBe(201);
    }
    const kinds = json(await admin.get(`/api/candidates/${id}`)).documents.map((d: any) => d.kind).sort();
    expect(kinds).toEqual(['antecedentes_criminais', 'processos']);
  });
});
