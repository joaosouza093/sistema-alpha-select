import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withUser } from '../src/lib/db.js';
import {
  Agent,
  PDF,
  addMember,
  bootstrapAdmin,
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

function applyBody(data: Record<string, unknown>, file: Buffer = PDF, filename = 'curriculo.pdf', mime = 'application/pdf') {
  const boundary = `----vaga${Date.now()}`;
  const head =
    `--${boundary}\r\nContent-Disposition: form-data; name="dados"\r\n\r\n${JSON.stringify(data)}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="curriculo"; filename="${filename}"\r\n` +
    `Content-Type: ${mime}\r\n\r\n`;
  return {
    payload: Buffer.concat([Buffer.from(head), file, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

function candidateData(over: Record<string, unknown> = {}) {
  return { fullName: 'Pessoa Candidata', email: `${uniq('portal')}@example.test`, phone: '11988887777', acceptPrivacy: true, ...over };
}

async function apply(slug: string, data: Record<string, unknown>, file: Buffer = PDF, filename?: string, mime?: string) {
  const { payload, headers } = applyBody(data, file, filename, mime);
  return new Agent(ctx).request('POST', `/api/public/jobs/${slug}/apply`, payload, headers);
}

async function publishedJob(questions: unknown[] = []) {
  const companyId = await createCompany(admin);
  const processId = await createProcess(admin, companyId, uniq('Analista de Dados'));
  let p = json(await admin.get(`/api/processes/${processId}/job`));
  const put = await admin.put(`/api/processes/${processId}/job`, {
    expectedVersion: p.version,
    jobLocation: 'São Paulo/SP',
    workModel: 'hibrido',
    employmentType: 'clt',
    requirements: 'SQL e Python',
    benefits: 'Vale-refeição',
    salaryMinCents: 500_000,
    salaryMaxCents: 700_000,
    showCompany: false,
    screeningQuestions: questions,
  });
  expect(put.statusCode).toBe(200);
  p = json(await admin.get(`/api/processes/${processId}/job`));
  const pub = await admin.post(`/api/processes/${processId}/publication`, { expectedVersion: p.version, publication: 'publicada' });
  expect(pub.statusCode).toBe(200);
  return { companyId, processId, slug: json(pub).publicSlug as string };
}

describe('vagas e portal público', () => {
  it('somente vagas publicadas aparecem; dados internos e resposta esperada não vazam', async () => {
    const { processId, slug } = await publishedJob([{ text: 'Tem disponibilidade para viagens?', eliminatory: true, expected: 'sim' }]);
    const companyId2 = await createCompany(admin);
    const draft = await createProcess(admin, companyId2, uniq('Rascunho'));
    const list = json(await new Agent(ctx).get('/api/public/jobs'));
    const item = list.items.find((i: { slug: string }) => i.slug === slug);
    expect(item).toBeTruthy();
    expect(item.companyName).toBeNull(); // empresa confidencial
    expect(JSON.stringify(list)).not.toContain(processId);
    expect(JSON.stringify(list)).not.toContain(draft);
    const detail = json(await new Agent(ctx).get(`/api/public/jobs/${slug}`));
    expect(detail.questions).toHaveLength(1);
    expect(detail.questions[0]).toEqual({ id: expect.any(String), text: 'Tem disponibilidade para viagens?' });
    expect(JSON.stringify(detail)).not.toContain('expected');
    expect((await new Agent(ctx).get('/api/public/jobs/nao-existe-123')).statusCode).toBe(404);
  });

  it('candidatura cria candidato, participação na etapa inicial e currículo; triagem marca reprovação eliminatória', async () => {
    const { processId, slug } = await publishedJob([{ text: 'Mora em São Paulo?', eliminatory: true, expected: 'sim' }]);
    const q = json(await new Agent(ctx).get(`/api/public/jobs/${slug}`)).questions[0];
    const data = candidateData({ answers: [{ id: q.id, answer: 'nao' }], city: 'Campinas' });
    const r = await apply(slug, data);
    expect(r.statusCode).toBe(201);
    const board = json(await admin.get(`/api/processes/${processId}/board`));
    expect(board.cards).toHaveLength(1);
    const card = board.cards[0];
    expect(card).toMatchObject({ stageId: 1, decision: 'pendente', source: 'portal', screeningFailed: true, documentCount: 1 });
    const intake = json(await admin.get(`/api/applications/${card.id}/intake`));
    expect(intake.answers[0]).toMatchObject({ text: 'Mora em São Paulo?', answer: 'nao', expected: 'sim' });
    const cand = await ctx.owner.query('select source, consent_at, created_by from candidates where email = $1', [data.email]);
    expect(cand.rows[0].source).toBe('portal');
    expect(cand.rows[0].consent_at).not.toBeNull();
    expect(ctx.mailer.outbox.some((m) => m.to === data.email && m.subject.includes('Candidatura recebida'))).toBe(true);
    // Mesmo e-mail na mesma vaga não duplica.
    expect((await apply(slug, data)).statusCode).toBe(201);
    expect(json(await admin.get(`/api/processes/${processId}/board`)).cards).toHaveLength(1);
  });

  it('valida perguntas, consentimento, campos extras e arquivo; robô (campo isca) é descartado', async () => {
    const { processId, slug } = await publishedJob([{ text: 'Possui CNH?', eliminatory: false }]);
    expect((await apply(slug, candidateData())).statusCode).toBe(422); // sem resposta
    expect((await apply(slug, candidateData({ acceptPrivacy: false }))).statusCode).toBe(422);
    expect((await apply(slug, candidateData({ stageId: 4 }))).statusCode).toBe(422);
    const q = json(await new Agent(ctx).get(`/api/public/jobs/${slug}`)).questions[0];
    const ok = { answers: [{ id: q.id, answer: 'sim' }] };
    expect((await apply(slug, candidateData(ok), Buffer.from('<html><script>alert(1)</script></html>'), 'cv.pdf')).statusCode).toBe(415);
    expect((await apply(slug, candidateData(ok), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'foto.png', 'image/png')).statusCode).toBe(415);
    expect((await apply(slug, candidateData({ ...ok, website: 'http://spam' }))).statusCode).toBe(200);
    expect(json(await admin.get(`/api/processes/${processId}/board`)).cards).toHaveLength(0);
    const leftovers = await ctx.owner.query("select count(*)::int as n from documents d join candidates c on c.id = d.candidate_id where c.source = 'portal' and c.full_name = 'Nunca'");
    expect(leftovers.rows[0].n).toBe(0);
  });

  it('vaga pausada ou processo concluído some do portal e recusa candidaturas', async () => {
    const { processId, slug } = await publishedJob();
    let p = json(await admin.get(`/api/processes/${processId}/job`));
    await admin.post(`/api/processes/${processId}/publication`, { expectedVersion: p.version, publication: 'pausada' });
    expect((await new Agent(ctx).get(`/api/public/jobs/${slug}`)).statusCode).toBe(404);
    expect((await apply(slug, candidateData())).statusCode).toBe(404);
    p = json(await admin.get(`/api/processes/${processId}/job`));
    await admin.post(`/api/processes/${processId}/publication`, { expectedVersion: p.version, publication: 'publicada' });
    expect((await new Agent(ctx).get(`/api/public/jobs/${slug}`)).statusCode).toBe(200);
    p = json(await admin.get(`/api/processes/${processId}`));
    await admin.patch(`/api/processes/${processId}`, { expectedVersion: p.version, status: 'concluido' });
    expect((await new Agent(ctx).get(`/api/public/jobs/${slug}`)).statusCode).toBe(404);
    p = json(await admin.get(`/api/processes/${processId}/job`));
    expect((await admin.post(`/api/processes/${processId}/publication`, { expectedVersion: p.version, publication: 'publicada' })).statusCode).toBe(409);
  });

  it('banco de talentos: cadastro sem vaga fica visível só para administrador', async () => {
    const data = candidateData();
    const { payload, headers } = applyBody(data);
    const r = await new Agent(ctx).request('POST', '/api/public/talent', payload, headers);
    expect(r.statusCode).toBe(201);
    const staff = await inviteUser(ctx, admin, 'alpha_staff');
    const list = json(await admin.get(`/api/candidates?q=${encodeURIComponent(data.email as string)}`));
    expect(list.items.length).toBe(1);
    const staffList = json(await staff.agent.get(`/api/candidates?q=${encodeURIComponent(data.email as string)}`));
    expect(staffList.items.length).toBe(0);
  });

  it('respostas do formulário: cliente não lê (API e banco); só administrador configura e publica', async () => {
    const { companyId, processId, slug } = await publishedJob([{ text: 'Inglês fluente?', eliminatory: true, expected: 'sim' }]);
    const q = json(await new Agent(ctx).get(`/api/public/jobs/${slug}`)).questions[0];
    await apply(slug, candidateData({ answers: [{ id: q.id, answer: 'sim' }] }));
    const client = await inviteUser(ctx, admin, 'client_manager', companyId);
    const staff = await inviteUser(ctx, admin, 'alpha_staff');
    await addMember(admin, processId, client.id);
    await addMember(admin, processId, staff.id);
    // Antes do envio pela Alpha Select, o cliente nem vê a candidatura.
    expect(json(await client.agent.get(`/api/processes/${processId}/board`)).cards).toHaveLength(0);
    await ctx.owner.query('update applications set sent_at = now() where process_id = $1', [processId]);
    const board = json(await client.agent.get(`/api/processes/${processId}/board`));
    expect(board.cards[0].screeningFailed).toBeNull();
    expect(board.cards[0].triageStatus).toBeNull();
    expect((await client.agent.get(`/api/applications/${board.cards[0].id}/intake`)).statusCode).toBe(403);
    expect((await client.agent.get(`/api/processes/${processId}/job`)).statusCode).toBe(403);
    const rows = await withUser(ctx.deps.pools.app, client.id, (db) => db.query('select * from application_intake'));
    expect(rows.rowCount).toBe(0);
    // Equipe vinculada lê as respostas, mas não altera a vaga.
    expect((await staff.agent.get(`/api/applications/${board.cards[0].id}/intake`)).statusCode).toBe(200);
    const p = json(await staff.agent.get(`/api/processes/${processId}/job`));
    expect((await staff.agent.post(`/api/processes/${processId}/publication`, { expectedVersion: p.version, publication: 'pausada' })).statusCode).toBe(403);
    expect((await client.agent.put(`/api/processes/${processId}/job`, {})).statusCode).toBe(403);
  });
});
