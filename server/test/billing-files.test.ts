import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Agent, PDF, bootstrapAdmin, createCompany, inviteUser, json, setupApp, uniq, type TestCtx } from './helpers.js';

let ctx: TestCtx;
let admin: Agent;

beforeAll(async () => {
  ctx = await setupApp();
  admin = (await bootstrapAdmin(ctx)).agent;
});
afterAll(async () => {
  await ctx.close();
});

const future = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
const XML = Buffer.from('<?xml version="1.0" encoding="UTF-8"?><nfeProc versao="4.00"><NFe/></nfeProc>');

function filePart(filename: string, contentType: string, content: Buffer, kind?: string) {
  const boundary = `----nf${Date.now()}`;
  const head =
    (kind ? `--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\n${kind}\r\n` : '') +
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`;
  return {
    payload: Buffer.concat([Buffer.from(head), content, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}
const send = (agent: Agent, url: string, f: ReturnType<typeof filePart>) => agent.request('POST', url, f.payload, f.headers);

async function companyWithManager() {
  const companyId = await createCompany(admin);
  const email = `${uniq('fin')}@example.test`;
  expect((await admin.patch(`/api/companies/${companyId}`, { billingEmail: email })).statusCode).toBe(200);
  const manager = await inviteUser(ctx, admin, 'client_manager', companyId);
  const user = await inviteUser(ctx, admin, 'client_user', companyId);
  return { companyId, email, manager: manager.agent, user: user.agent };
}

describe('anexos da cobrança (boleto e nota fiscal)', () => {
  it('cria sem e-mail, anexa boleto e NF, e o aviso sai com os anexos', async () => {
    const c = await companyWithManager();
    const r = await admin.post('/api/billing/charges', {
      companyIds: [c.companyId], description: 'Recrutamento — vaga analista', amountCents: 350_000, dueDate: future(10), deferNotice: true,
    });
    expect(r.statusCode).toBe(201);
    const id = json(r).ids[0];
    expect(ctx.mailer.outbox.some((m) => m.to === c.email)).toBe(false);

    const boleto = await send(admin, `/api/billing/charges/${id}/files`, filePart('boleto.pdf', 'application/pdf', PDF, 'boleto'));
    expect(boleto.statusCode).toBe(201);
    expect((await send(admin, `/api/billing/charges/${id}/files`, filePart('nf.xml', 'text/xml', XML, 'nota_fiscal'))).statusCode).toBe(201);
    // Boleto só em PDF; HTML disfarçado é recusado.
    expect((await send(admin, `/api/billing/charges/${id}/files`, filePart('boleto.xml', 'text/xml', XML, 'boleto'))).statusCode).toBe(415);
    expect((await send(admin, `/api/billing/charges/${id}/files`, filePart('nf.xml', 'text/xml', Buffer.from('\0\0binário'), 'nota_fiscal'))).statusCode).toBe(415);
    // Substitui o boleto anterior.
    expect((await send(admin, `/api/billing/charges/${id}/files`, filePart('boleto-2.pdf', 'application/pdf', PDF, 'boleto'))).statusCode).toBe(201);
    const detail = json(await admin.get(`/api/billing/charges/${id}`));
    expect(detail.files.map((f: any) => `${f.kind}:${f.name}`).sort()).toEqual(['boleto:boleto-2.pdf', 'nota_fiscal:nf.xml']);
    expect((await ctx.owner.query('select count(*)::int as n from billing_files where charge_id = $1', [id])).rows[0].n).toBe(2);

    expect((await admin.post('/api/billing/charges/notify', { ids: [id] })).statusCode).toBe(200);
    const mail = ctx.mailer.outbox.find((m) => m.to === c.email && m.subject.includes('Nova cobrança'))!;
    expect(mail.attachments?.map((a) => a.filename).sort()).toEqual(['boleto-2.pdf', 'nf.xml']);
    expect(mail.text).toContain('Documentos em anexo');

    // Pagamento: o recibo leva só a nota fiscal.
    expect((await admin.post(`/api/billing/charges/${id}/pay`, { expectedVersion: detail.version })).statusCode).toBe(200);
    const recibo = ctx.mailer.outbox.find((m) => m.to === c.email && m.subject.includes('Pagamento confirmado'))!;
    expect(recibo.attachments?.map((a) => a.filename)).toEqual(['nf.xml']);
  });

  it('usuários da empresa (gestor e RH interno) veem o financeiro e baixam os anexos; outras empresas não', async () => {
    const a = await companyWithManager();
    const b = await companyWithManager();
    const r = await admin.post('/api/billing/charges', { companyIds: [a.companyId], description: 'Mensalidade', amountCents: 100_000, dueDate: future(5) });
    const id = json(r).ids[0];
    const up = json(await send(admin, `/api/billing/charges/${id}/files`, filePart('boleto.pdf', 'application/pdf', PDF, 'boleto')));
    const canceled = json(await admin.post('/api/billing/charges', { companyIds: [a.companyId], description: 'Cancelada', amountCents: 500, dueDate: future(5) })).ids[0];
    const v = json(await admin.get(`/api/billing/charges/${canceled}`)).version;
    expect((await admin.post(`/api/billing/charges/${canceled}/cancel`, { expectedVersion: v })).statusCode).toBe(200);

    const fin = json(await a.manager.get('/api/client/finance'));
    expect(fin.charges.map((c: any) => c.id)).toEqual([id]);
    expect(fin.charges[0].files[0]).toMatchObject({ kind: 'boleto', name: 'boleto.pdf' });
    expect(fin.summary).toMatchObject({ openCents: 100_000, openCount: 1 });
    const dl = await a.manager.get(`/api/billing/files/${up.id}/content?download=1`);
    expect(dl.statusCode).toBe(200);
    expect(dl.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');

    expect(json(await b.manager.get('/api/client/finance')).charges).toEqual([]);
    expect((await b.manager.get(`/api/billing/files/${up.id}/content`)).statusCode).toBe(404);
    expect(json(await a.user.get('/api/client/finance')).charges.map((c: any) => c.id)).toEqual([id]);
    expect((await a.user.get(`/api/billing/files/${up.id}/content`)).statusCode).toBe(200);
    expect(json(await b.user.get('/api/client/finance')).charges).toEqual([]);
    expect((await send(a.manager, `/api/billing/charges/${id}/files`, filePart('x.pdf', 'application/pdf', PDF, 'boleto'))).statusCode).toBe(403);
    expect((await a.manager.delete(`/api/billing/files/${up.id}`)).statusCode).toBe(403);
    // RLS: mesmo direto no banco, o gestor não lê cobranças de outra empresa.
    expect((await a.manager.get('/api/billing/charges')).statusCode).toBe(403);

    expect((await admin.delete(`/api/billing/files/${up.id}`)).statusCode).toBe(200);
    expect(json(await a.manager.get('/api/client/finance')).charges[0].files).toEqual([]);
  });
});

describe('contratos e visão 360° da empresa', () => {
  it('administrador cadastra contrato com arquivo; gestor vê sem as observações internas', async () => {
    const c = await companyWithManager();
    const bad = await admin.post('/api/contracts', {
      companyId: c.companyId, plan: 'Plano X', modality: 'mensalidade', amountCents: 100, startDate: '2026-05-01', endDate: '2026-04-01',
      status: 'ativo', ownerId: null, notes: null,
    });
    expect(bad.statusCode).toBe(422);
    const r = await admin.post('/api/contracts', {
      companyId: c.companyId, plan: 'Recrutamento contínuo', modality: 'mensalidade', amountCents: 450_000, startDate: '2026-01-01',
      endDate: '2026-12-31', status: 'ativo', ownerId: null, notes: 'NOTA-INTERNA-CONTRATO',
    });
    expect(r.statusCode).toBe(201);
    const id = json(r).id;
    expect((await send(admin, `/api/contracts/${id}/file`, filePart('contrato.pdf', 'application/pdf', PDF))).statusCode).toBe(201);

    const list = json(await admin.get(`/api/contracts?companyId=${c.companyId}`)).items;
    expect(list[0]).toMatchObject({ plan: 'Recrutamento contínuo', notes: 'NOTA-INTERNA-CONTRATO', file: { name: 'contrato.pdf' } });
    expect((await admin.patch(`/api/contracts/${id}`, { expectedVersion: list[0].version, status: 'suspenso' })).statusCode).toBe(200);
    expect((await admin.patch(`/api/contracts/${id}`, { expectedVersion: list[0].version, status: 'ativo' })).statusCode).toBe(409);
    expect((await admin.patch(`/api/contracts/${id}`, { expectedVersion: list[0].version + 1, endDate: '2025-01-01' })).statusCode).toBe(422);

    const fin = await c.manager.get('/api/client/finance');
    expect(json(fin).contracts[0]).toMatchObject({ plan: 'Recrutamento contínuo', status: 'suspenso', file: { name: 'contrato.pdf' } });
    expect(fin.body).not.toContain('NOTA-INTERNA-CONTRATO');
    expect((await c.manager.get('/api/contracts')).statusCode).toBe(403);
    expect((await c.manager.post('/api/contracts', { companyId: c.companyId })).statusCode).toBe(403);

    const ov = json(await admin.get(`/api/companies/${c.companyId}/overview`));
    expect(ov.company.id).toBe(c.companyId);
    expect(ov.users).toHaveLength(2);
    expect(ov.contracts[0].plan).toBe('Recrutamento contínuo');
    expect(ov).toHaveProperty('pipeline.openProcesses');
    expect((await c.manager.get(`/api/companies/${c.companyId}/overview`)).statusCode).toBe(403);

    expect((await admin.delete(`/api/contracts/${id}`)).statusCode).toBe(200);
    expect((await ctx.owner.query('select count(*)::int as n from billing_files where contract_id = $1', [id])).rows[0].n).toBe(0);
  });
});
