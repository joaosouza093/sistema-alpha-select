import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../lib/context.js';
import { asUser, audit, isAdmin, requireUser } from '../../lib/context.js';
import type { Db } from '../../lib/db.js';
import { AppError, forbidden } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { headerKey, parseCsv } from '../../lib/csv.js';
import { cleanText, normalizeEmail, normalizePhone, zText } from '../../lib/normalize.js';

/**
 * Importação de candidatos por planilha (CSV), somente administrador.
 * Duas etapas com o mesmo arquivo: prévia (nada é gravado) e importação.
 * O servidor valida tudo de novo na importação; linhas com erro ou já
 * cadastradas (mesmo e-mail ou telefone) nunca entram.
 */
export const MAX_IMPORT_ROWS = 5000;
const MAX_CHARS = 3_000_000;

type Field = 'fullName' | 'email' | 'phone' | 'city' | 'salary' | 'notes';
const ALIASES: Record<Field, string[]> = {
  fullName: ['nome', 'nomecompleto', 'name', 'candidato', 'nomedocandidato'],
  email: ['email', 'emailpessoal', 'mail'],
  phone: ['telefone', 'celular', 'whatsapp', 'fone', 'phone', 'telefonecelular'],
  city: ['cidade', 'municipio', 'city'],
  salary: ['pretensao', 'pretensaosalarial', 'pretensaosalarialr', 'salario', 'salariopretendido'],
  notes: ['observacoes', 'observacao', 'obs', 'notas', 'comentarios'],
};

export interface ImportRow {
  line: number;
  fullName: string;
  email: string | null;
  phone: string | null;
  city: string | null;
  salary: number | null;
  notes: string | null;
  status: 'ok' | 'erro' | 'ja_cadastrado' | 'repetido';
  problems: string[];
}

function mapHeader(header: string[]) {
  const map: Partial<Record<Field, number>> = {};
  const ignored: string[] = [];
  header.forEach((h, i) => {
    const k = headerKey(h);
    const field = (Object.keys(ALIASES) as Field[]).find((f) => ALIASES[f].includes(k));
    if (field && map[field] === undefined) map[field] = i;
    else if (h.trim()) ignored.push(h.trim());
  });
  return { map, ignored };
}

function parseSalary(v: string): number | null | 'invalid' {
  const s = v.replace(/[R$\s]/g, '');
  if (!s) return null;
  const n = Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s);
  return Number.isFinite(n) && n >= 0 && n <= 9_999_999_999 ? Math.round(n * 100) / 100 : 'invalid';
}

/** Lê e valida a planilha; marca duplicados no próprio arquivo e no banco. */
async function analyze(db: Db, csv: string) {
  if (csv.length > MAX_CHARS) throw new AppError(413, 'too_large', 'Arquivo grande demais. Divida a planilha em partes de até 5.000 linhas.');
  const table = parseCsv(csv);
  if (table.length < 2) throw new AppError(422, 'invalid', 'A planilha precisa de uma linha de títulos e ao menos um candidato.');
  if (table.length - 1 > MAX_IMPORT_ROWS) throw new AppError(422, 'invalid', `Máximo de ${MAX_IMPORT_ROWS} candidatos por arquivo.`);
  const { map, ignored } = mapHeader(table[0]!);
  if (map.fullName === undefined) {
    throw new AppError(422, 'invalid', 'Não encontramos a coluna "Nome". Use o modelo de planilha.');
  }
  const cell = (r: string[], f: Field) => (map[f] === undefined ? '' : cleanText(r[map[f]!] ?? ''));

  const rows: ImportRow[] = table.slice(1).map((r, i) => {
    const problems: string[] = [];
    const fullName = cell(r, 'fullName');
    if (fullName.length < 2 || fullName.length > 160) problems.push('Nome ausente ou inválido');
    const rawEmail = cell(r, 'email');
    let email: string | null = rawEmail ? normalizeEmail(rawEmail) : null;
    if (email && (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))) {
      problems.push('E-mail inválido');
      email = null;
    }
    const rawPhone = cell(r, 'phone');
    const phone = rawPhone ? normalizePhone(rawPhone) : null;
    if (rawPhone && !phone) problems.push('Telefone inválido');
    const city = cell(r, 'city').slice(0, 120) || null;
    const salary = parseSalary(cell(r, 'salary'));
    if (salary === 'invalid') problems.push('Pretensão inválida');
    const notes = cell(r, 'notes').slice(0, 10000) || null;
    return {
      line: i + 2, fullName, email, phone, city, salary: salary === 'invalid' ? null : salary, notes,
      status: problems.length ? 'erro' : 'ok', problems,
    };
  });

  // Repetidos dentro do próprio arquivo (fica a primeira ocorrência).
  const seen = new Map<string, number>();
  for (const r of rows) {
    if (r.status !== 'ok') continue;
    for (const key of [r.email && `e:${r.email}`, r.phone && `p:${r.phone}`].filter(Boolean) as string[]) {
      const first = seen.get(key);
      if (first !== undefined) {
        r.status = 'repetido';
        r.problems.push(`Repete a linha ${first}`);
        break;
      }
    }
    if (r.status === 'ok') for (const key of [r.email && `e:${r.email}`, r.phone && `p:${r.phone}`].filter(Boolean) as string[]) seen.set(key, r.line);
  }

  // Já cadastrados (mesmo e-mail ou telefone).
  const emails = rows.filter((r) => r.status === 'ok' && r.email).map((r) => r.email!);
  const phones = rows.filter((r) => r.status === 'ok' && r.phone).map((r) => r.phone!);
  if (emails.length || phones.length) {
    const { rows: found } = await db.query<{ email: string | null; phone: string | null; full_name: string }>(
      `select lower(email::text) as email, phone, full_name from candidates
        where lower(email::text) = any($1::text[]) or phone = any($2::text[])`,
      [emails, phones],
    );
    const byEmail = new Map(found.filter((f) => f.email).map((f) => [f.email!, f.full_name]));
    const byPhone = new Map(found.filter((f) => f.phone).map((f) => [f.phone!, f.full_name]));
    for (const r of rows) {
      if (r.status !== 'ok') continue;
      const who = (r.email && byEmail.get(r.email)) || (r.phone && byPhone.get(r.phone));
      if (who) {
        r.status = 'ja_cadastrado';
        r.problems.push(`Já cadastrado: ${who}`);
      }
    }
  }
  const count = (s: ImportRow['status']) => rows.filter((r) => r.status === s).length;
  return {
    rows,
    summary: { total: rows.length, ok: count('ok'), erro: count('erro'), jaCadastrado: count('ja_cadastrado'), repetido: count('repetido') },
    columns: Object.keys(map) as Field[],
    ignoredColumns: ignored,
  };
}

export function registerCandidateImportRoutes(app: FastifyInstance, deps: Deps) {
  const adminOnly = (req: Parameters<typeof requireUser>[0]) => {
    if (!isAdmin(requireUser(req))) throw forbidden();
  };
  const opts = { bodyLimit: 4 * 1024 * 1024 };

  app.post('/api/candidates/import/preview', opts, async (req) => {
    adminOnly(req);
    const body = parse(z.object({ csv: z.string().min(1, 'Envie a planilha.') }).strict(), req.body);
    return asUser(deps, req, async (db) => {
      const r = await analyze(db, body.csv);
      // Mostra todas as linhas com problema e até 50 das que serão importadas.
      const shown = [...r.rows.filter((x) => x.status !== 'ok').slice(0, 500), ...r.rows.filter((x) => x.status === 'ok').slice(0, 50)];
      return { summary: r.summary, columns: r.columns, ignoredColumns: r.ignoredColumns, rows: shown.sort((a, b) => a.line - b.line) };
    });
  });

  app.post('/api/candidates/import', opts, async (req, reply) => {
    adminOnly(req);
    const body = parse(
      z
        .object({
          csv: z.string().min(1, 'Envie a planilha.'),
          /** De onde vieram os dados e por que a Alpha Select pode tratá-los (fica na auditoria). */
          origin: zText(5, 300),
        })
        .strict(),
      req.body,
    );
    const result = await asUser(deps, req, async (db, user) => {
      const r = await analyze(db, body.csv);
      const ok = r.rows.filter((x) => x.status === 'ok');
      if (!ok.length) throw new AppError(422, 'invalid', 'Nenhuma linha válida para importar.');
      const batch = randomUUID();
      for (let i = 0; i < ok.length; i += 500) {
        const part = ok.slice(i, i + 500);
        await db.query(
          `insert into candidates (full_name, email, phone, city, salary_expectation, notes, source, created_by)
           select n, e, p, c, s, o, 'importacao', $7
             from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::numeric[], $6::text[]) as t(n, e, p, c, s, o)`,
          [part.map((x) => x.fullName), part.map((x) => x.email), part.map((x) => x.phone), part.map((x) => x.city),
            part.map((x) => x.salary), part.map((x) => x.notes), user.id],
        );
      }
      await audit(db, req, 'candidate.imported', null, batch, null, { origin: body.origin, ...r.summary });
      return { imported: ok.length, skipped: r.summary.total - ok.length, summary: r.summary };
    });
    reply.code(201);
    return result;
  });
}
