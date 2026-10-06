import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCsv } from '../src/lib/csv.js';
import { Agent, bootstrapAdmin, createCandidate, inviteUser, json, setupApp, uniq, type TestCtx } from './helpers.js';

let ctx: TestCtx;
let admin: Agent;

beforeAll(async () => {
  ctx = await setupApp();
  admin = (await bootstrapAdmin(ctx)).agent;
});
afterAll(async () => {
  await ctx.close();
});

describe('leitor de CSV', () => {
  it('aspas, ponto e vírgula, quebra de linha dentro de aspas, BOM e CRLF', () => {
    const t = parseCsv('﻿Nome;Obs\r\n"Silva; Ana";"linha 1\nlinha 2"\r\n"Diz ""oi""";\r\n\r\n');
    expect(t).toEqual([['Nome', 'Obs'], ['Silva; Ana', 'linha 1\nlinha 2'], ['Diz "oi"', '']]);
    expect(parseCsv('nome,email\nAna,a@x.com')).toEqual([['nome', 'email'], ['Ana', 'a@x.com']]);
  });
});

describe('importação de candidatos', () => {
  it('prévia aponta erros, repetidos e já cadastrados sem gravar; importação grava só as válidas', async () => {
    const existing = `${uniq('ja')}@example.test`;
    await createCandidate(admin, { email: existing, fullName: 'Pessoa Já Cadastrada' });
    const a = `${uniq('imp')}@example.test`;
    const b = `${uniq('imp')}@example.test`;
    const csv = [
      'Nome Completo;E-mail;Celular;Cidade;Pretensão salarial (R$);Observações;Coluna estranha',
      `Ana Importada;${a.toUpperCase()};(11) 98888-0001;São Paulo;"5.500,00";veio do banco antigo;x`,
      `Bruno Importado;${b};;Campinas;;;`,
      `Ana Repetida;${a};;;;;`,
      `Pessoa Existente;${existing};;;;;`,
      `X;email-invalido;123;;abc;;`,
    ].join('\r\n');
    const before = (await ctx.owner.query('select count(*)::int as n from candidates')).rows[0].n;

    const p = await admin.post('/api/candidates/import/preview', { csv });
    expect(p.statusCode).toBe(200);
    const prev = json(p);
    expect(prev.summary).toEqual({ total: 5, ok: 2, erro: 1, jaCadastrado: 1, repetido: 1 });
    expect(prev.ignoredColumns).toEqual(['Coluna estranha']);
    const bad = prev.rows.find((r: any) => r.line === 6);
    expect(bad.problems).toEqual(expect.arrayContaining(['Nome ausente ou inválido', 'E-mail inválido', 'Telefone inválido', 'Pretensão inválida']));
    expect(prev.rows.find((r: any) => r.line === 4).problems).toEqual(['Repete a linha 2']);
    expect(prev.rows.find((r: any) => r.line === 5).problems[0]).toContain('Pessoa Já Cadastrada');
    expect((await ctx.owner.query('select count(*)::int as n from candidates')).rows[0].n).toBe(before);

    expect((await admin.post('/api/candidates/import', { csv, origin: '' })).statusCode).toBe(422);
    const r = await admin.post('/api/candidates/import', { csv, origin: 'Banco de currículos antigo da Alpha Select (planilha 2025)' });
    expect(r.statusCode).toBe(201);
    expect(json(r)).toMatchObject({ imported: 2, skipped: 3 });
    const ana = (await ctx.owner.query('select full_name, email, phone, city, salary_expectation, notes, source from candidates where email = $1', [a])).rows[0];
    expect(ana).toMatchObject({ full_name: 'Ana Importada', phone: '+5511988880001', city: 'São Paulo', salary_expectation: 5500, notes: 'veio do banco antigo', source: 'importacao' });
    const audit = await ctx.owner.query("select details from audit_events where action = 'candidate.imported' order by id desc limit 1");
    expect(audit.rows[0].details).toMatchObject({ origin: 'Banco de currículos antigo da Alpha Select (planilha 2025)', ok: 2 });

    // Importar o mesmo arquivo de novo não duplica ninguém.
    expect((await admin.post('/api/candidates/import', { csv, origin: 'Segunda tentativa do mesmo arquivo' })).statusCode).toBe(422);
  });

  it('somente administrador; planilha sem coluna Nome é recusada', async () => {
    const staff = await inviteUser(ctx, admin, 'alpha_staff');
    expect((await staff.agent.post('/api/candidates/import/preview', { csv: 'Nome\nAna Teste' })).statusCode).toBe(403);
    expect((await staff.agent.post('/api/candidates/import', { csv: 'Nome\nAna Teste', origin: 'teste da equipe' })).statusCode).toBe(403);
    const r = await admin.post('/api/candidates/import/preview', { csv: 'Email;Telefone\na@b.com;11999990000' });
    expect(r.statusCode).toBe(422);
    expect(json(r).error.message).toContain('Nome');
  });
});
