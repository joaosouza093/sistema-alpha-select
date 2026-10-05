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
let staff: { agent: Agent; id: string };
let client: { agent: Agent; id: string };
let mutedClient: { agent: Agent; id: string };
let candidate: string;
let otherCandidate: string;
let app: string;

beforeAll(async () => {
  ctx = await setupApp();
  admin = (await bootstrapAdmin(ctx)).agent;
  const company = await createCompany(admin);
  const process = await createProcess(admin, company);
  staff = await inviteUser(ctx, admin, 'alpha_staff');
  client = await inviteUser(ctx, admin, 'client_user', company);
  mutedClient = await inviteUser(ctx, admin, 'client_user', company);
  await addMember(admin, process, staff.id);
  await addMember(admin, process, client.id, { canComment: true });
  await addMember(admin, process, mutedClient.id, { canComment: false });
  candidate = await createCandidate(staff.agent);
  otherCandidate = await createCandidate(staff.agent);
  app = await createApplication(staff.agent, candidate, process);
});
afterAll(async () => {
  await ctx.close();
});

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4890000000049454e44ae426082',
  'hex',
);

describe('upload de documentos', () => {
  it('aceita PDF e PNG válidos com metadados', async () => {
    const r = await upload(staff.agent, candidate, 'Currículo Maria.pdf', 'application/pdf', PDF);
    expect(r.statusCode).toBe(201);
    const p = await upload(staff.agent, candidate, 'foto.png', 'image/png', PNG);
    expect(p.statusCode).toBe(201);
    const c = json(await staff.agent.get(`/api/candidates/${candidate}`));
    const doc = c.documents.find((d: any) => d.id === json(r).id);
    expect(doc).toMatchObject({ name: 'Currículo Maria.pdf', mimeType: 'application/pdf', size: PDF.length, kind: 'curriculo' });
    expect(doc.uploadedByName).toBeTruthy();
    // Caminho interno aleatório, sem dados pessoais.
    const key = (await ctx.owner.query('select storage_key from documents where id = $1', [doc.id])).rows[0].storage_key;
    expect(key).toMatch(/^[0-9a-f]{2}\/[0-9a-f-]{36}$/);
  });

  it('recusa HTML e SVG', async () => {
    expect((await upload(staff.agent, candidate, 'x.html', 'text/html', Buffer.from('<script>alert(1)</script>'))).statusCode).toBe(415);
    expect((await upload(staff.agent, candidate, 'x.svg', 'image/svg+xml', Buffer.from('<svg onload="alert(1)"/>'))).statusCode).toBe(415);
  });

  it('recusa conteúdo que não corresponde à extensão', async () => {
    const r = await upload(staff.agent, candidate, 'falso.pdf', 'application/pdf', Buffer.from('<html>não é pdf</html>'));
    expect(r.statusCode).toBe(415);
    const r2 = await upload(staff.agent, candidate, 'falso.png', 'image/png', PDF);
    expect(r2.statusCode).toBe(415);
  });

  it('recusa arquivo acima do limite e não deixa resíduos', async () => {
    const before = (await ctx.owner.query('select count(*)::int as n from documents')).rows[0].n;
    const big = Buffer.concat([PDF, Buffer.alloc(1024 * 1024 + 10, 0x20)]);
    const r = await upload(staff.agent, candidate, 'grande.pdf', 'application/pdf', big);
    expect(r.statusCode).toBe(413);
    const after = (await ctx.owner.query('select count(*)::int as n from documents')).rows[0].n;
    expect(after).toBe(before);
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(ctx.deps.storage.tmpDir)).toHaveLength(0);
  });

  it('cliente não envia documentos', async () => {
    expect((await upload(client.agent, candidate, 'x.pdf', 'application/pdf', PDF)).statusCode).toBe(403);
  });

  it('não vincula documento de outro candidato à participação', async () => {
    const d = json(await upload(staff.agent, otherCandidate, 'outro.pdf', 'application/pdf', PDF)).id;
    const r = await staff.agent.put(`/api/applications/${app}/documents/${d}`, { sharedWithClient: true });
    expect(r.statusCode).toBe(422);
  });
});

describe('acesso a documentos', () => {
  it('documento privado só é entregue após autorização; revogação é imediata', async () => {
    const d = json(await upload(staff.agent, candidate, 'privado.pdf', 'application/pdf', PDF)).id;
    // Sem sessão
    expect((await new Agent(ctx).get(`/api/documents/${d}/content`)).statusCode).toBe(401);
    // Cliente: não vinculado
    expect((await client.agent.get(`/api/documents/${d}/content`)).statusCode).toBe(404);
    // Vinculado mas não compartilhado
    await staff.agent.put(`/api/applications/${app}/documents/${d}`, { sharedWithClient: false });
    expect((await client.agent.get(`/api/documents/${d}/content`)).statusCode).toBe(404);
    expect(json(await client.agent.get(`/api/applications/${app}/documents`)).items.map((x: any) => x.id)).not.toContain(d);
    // Compartilhado
    await staff.agent.put(`/api/applications/${app}/documents/${d}`, { sharedWithClient: true });
    const ok = await client.agent.get(`/api/documents/${d}/content`);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toBe('application/pdf');
    expect(ok.headers['cache-control']).toContain('no-store');
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    expect(ok.rawPayload.equals(PDF)).toBe(true);
    const dl = await client.agent.get(`/api/documents/${d}/content?download=1`);
    expect(dl.headers['content-disposition']).toMatch(/^attachment;/);
    // Revogado
    await staff.agent.put(`/api/applications/${app}/documents/${d}`, { sharedWithClient: false });
    expect((await client.agent.get(`/api/documents/${d}/content`)).statusCode).toBe(404);
  });

  it('remoção: somente quem enviou ou administrador; arquivo físico removido', async () => {
    const other = await inviteUser(ctx, admin, 'alpha_staff');
    const company = await createCompany(admin);
    const p = await createProcess(admin, company);
    await addMember(admin, p, other.id);
    await createApplication(admin, candidate, p);
    const d = json(await upload(staff.agent, candidate, 'remover.pdf', 'application/pdf', PDF)).id;
    const key = (await ctx.owner.query('select storage_key from documents where id = $1', [d])).rows[0].storage_key;
    expect((await other.agent.delete(`/api/documents/${d}`)).statusCode).toBe(403);
    expect((await client.agent.delete(`/api/documents/${d}`)).statusCode).toBe(403);
    expect((await staff.agent.delete(`/api/documents/${d}`)).statusCode).toBe(200);
    expect(await ctx.deps.storage.exists(key)).toBe(false);
    expect((await staff.agent.get(`/api/documents/${d}/content`)).statusCode).toBe(404);
  });
});

describe('comentários', () => {
  it('visibilidade padrão é interna', async () => {
    const r = await staff.agent.post(`/api/applications/${app}/comments`, { body: 'Sem visibilidade explícita' });
    expect(r.statusCode).toBe(201);
    const list = json(await staff.agent.get(`/api/applications/${app}/comments`)).items;
    expect(list.find((c: any) => c.id === json(r).id).visibility).toBe('internal');
    expect(json(await client.agent.get(`/api/applications/${app}/comments`)).items.map((c: any) => c.id)).not.toContain(json(r).id);
  });

  it('cliente não publica comentário interno e só comenta com permissão', async () => {
    expect((await client.agent.post(`/api/applications/${app}/comments`, { body: 'x', visibility: 'internal' })).statusCode).toBe(403);
    expect((await client.agent.post(`/api/applications/${app}/comments`, { body: 'Parecer do RH interno', visibility: 'shared' })).statusCode).toBe(201);
    expect((await mutedClient.agent.post(`/api/applications/${app}/comments`, { body: 'x', visibility: 'shared' })).statusCode).toBe(403);
  });

  it('conteúdo é armazenado como texto, sem interpretação', async () => {
    const payload = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    await staff.agent.post(`/api/applications/${app}/comments`, { body: payload, visibility: 'shared' });
    const list = json(await client.agent.get(`/api/applications/${app}/comments`)).items;
    expect(list.map((c: any) => c.body)).toContain(payload);
  });

  it('somente o autor edita; visibilidade não pode ser trocada; cliente não apaga comentário da equipe', async () => {
    const r = await staff.agent.post(`/api/applications/${app}/comments`, { body: 'Original', visibility: 'shared' });
    const id = json(r).id;
    expect((await client.agent.patch(`/api/comments/${id}`, { body: 'Alterado pelo cliente' })).statusCode).toBe(404);
    expect((await client.agent.delete(`/api/comments/${id}`)).statusCode).toBe(404);
    expect((await staff.agent.patch(`/api/comments/${id}`, { body: 'Editado', visibility: 'internal' })).statusCode).toBe(422);
    expect((await staff.agent.patch(`/api/comments/${id}`, { body: 'Editado' })).statusCode).toBe(200);
    const c = json(await client.agent.get(`/api/applications/${app}/comments`)).items.find((x: any) => x.id === id);
    expect(c).toMatchObject({ body: 'Editado', edited: true });
  });

  it('cliente não consegue ler comentário interno nem por ID de edição', async () => {
    const r = await staff.agent.post(`/api/applications/${app}/comments`, { body: 'SEGREDO', visibility: 'internal' });
    const res = await client.agent.patch(`/api/comments/${json(r).id}`, { body: 'x' });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('SEGREDO');
  });
});
