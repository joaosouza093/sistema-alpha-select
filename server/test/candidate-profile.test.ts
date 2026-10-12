import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Agent, PDF, PORTAL_PROFILE, bootstrapAdmin, createCandidate, json, setupApp, uniq, type TestCtx } from './helpers.js';

let ctx: TestCtx;
let admin: Agent;

beforeAll(async () => {
  ctx = await setupApp();
  admin = (await bootstrapAdmin(ctx)).agent;
});
afterAll(async () => {
  await ctx.close();
});

function talentBody(data: Record<string, unknown>) {
  const boundary = `----perfil${Date.now()}`;
  const head =
    `--${boundary}\r\nContent-Disposition: form-data; name="dados"\r\n\r\n${JSON.stringify(data)}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="curriculo"; filename="cv.pdf"\r\nContent-Type: application/pdf\r\n\r\n`;
  return {
    payload: Buffer.concat([Buffer.from(head), PDF, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}
const talent = (data: Record<string, unknown>) => {
  const b = talentBody(data);
  return new Agent(ctx).request('POST', '/api/public/talent', b.payload, b.headers);
};

describe('perfil completo do candidato', () => {
  it('portal exige telefone, nascimento, cidade, UF, CEP, área de interesse e escolaridade', async () => {
    const base = { fullName: 'Pessoa Completa', email: `${uniq('perfil')}@example.test`, phone: '(11) 97777-6666', acceptPrivacy: true };
    const r = await talent(base);
    expect(r.statusCode).toBe(422);
    expect(Object.keys(json(r).error.fields).sort()).toEqual(['birthDate', 'city', 'desiredRole', 'educationLevel', 'postalCode', 'state']);
    expect((await talent({ ...base, ...PORTAL_PROFILE, state: 'XX' })).statusCode).toBe(422);
    expect((await talent({ ...base, ...PORTAL_PROFILE, birthDate: '2999-01-01' })).statusCode).toBe(422);
    expect((await talent({ ...base, ...PORTAL_PROFILE, linkedinUrl: 'https://example.com/eu' })).statusCode).toBe(422);

    const ok = await talent({
      ...base, ...PORTAL_PROFILE, addressStreet: 'Av. Paulista', addressNumber: '1000', addressDistrict: 'Bela Vista',
      linkedinUrl: 'linkedin.com/in/pessoa-completa', course: 'Estatística', institution: 'USP', educationStatus: 'concluido',
    });
    expect(ok.statusCode).toBe(201);
    const id = json(await admin.get(`/api/candidates?q=${encodeURIComponent(base.email)}`)).items[0].id;
    expect(json(await admin.get(`/api/candidates/${id}`))).toMatchObject({
      birthDate: '1990-05-10', state: 'SP', postalCode: '01310100', desiredRole: 'Analista de Dados', educationLevel: 'superior',
      addressStreet: 'Av. Paulista', linkedinUrl: 'https://linkedin.com/in/pessoa-completa', course: 'Estatística', educationStatus: 'concluido',
    });
  });

  it('equipe edita perfil e etiquetas; filtros combinados na lista', async () => {
    const tag = uniq('react').toLowerCase();
    const id = await createCandidate(admin, { fullName: 'Filtro Teste', state: 'RJ', city: 'Niterói', desiredRole: 'Desenvolvedora Front-end', educationLevel: 'superior', tags: [' React ', tag, tag] });
    const c = json(await admin.get(`/api/candidates/${id}`));
    expect(c.tags.sort()).toEqual(['react', tag].sort());
    expect((await admin.patch(`/api/candidates/${id}`, { expectedVersion: c.version, educationLevel: 'pos_graduacao', tags: ['react', 'inglês fluente'] })).statusCode).toBe(200);
    const after = json(await admin.get(`/api/candidates/${id}`));
    expect(after).toMatchObject({ educationLevel: 'pos_graduacao', state: 'RJ', tags: ['react', 'inglês fluente'] });

    const ids = async (qs: string) => json(await admin.get(`/api/candidates?${qs}`)).items.map((x: any) => x.id);
    expect(await ids('state=RJ&role=front&education=pos_graduacao&tag=react')).toContain(id);
    expect(await ids('state=SP&tag=react')).not.toContain(id);
    expect(await ids(`tag=${encodeURIComponent('inglês fluente')}&city=niter`)).toContain(id);
    const tags = json(await admin.get('/api/candidates/tags')).items.map((t: any) => t.tag);
    expect(tags).toContain('inglês fluente');
  });

  it('importação reconhece nascimento, UF, CEP, cargo, escolaridade e etiquetas', async () => {
    const email = `${uniq('impp')}@example.test`;
    const csv = `Nome;E-mail;Data de nascimento;UF;CEP;Cargo / Área de interesse;Escolaridade;Etiquetas\nPessoa Planilha;${email};31/12/1990;mg;30130-000;Contadora;Superior completo;contábil, excel\n`;
    const r = await admin.post('/api/candidates/import', { csv, origin: 'Teste de colunas novas' });
    expect(r.statusCode).toBe(201);
    const row = (await ctx.owner.query("select to_char(birth_date,'YYYY-MM-DD') as b, state, postal_code, desired_role, education_level, tags from candidates where email = $1", [email])).rows[0];
    expect(row).toEqual({ b: '1990-12-31', state: 'MG', postal_code: '30130000', desired_role: 'Contadora', education_level: 'superior', tags: ['contábil', 'excel'] });
  });
});
