import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../lib/context.js';
import { asUser, audit, isAdmin, isAlpha, requireUser } from '../../lib/context.js';
import type { Db } from '../../lib/db.js';
import { AppError, forbidden, notFound, staleVersion } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import {
  likePattern,
  zOptionalEmail,
  zOptionalPhone,
  zOptionalText,
  zPage,
  zText,
  zUuid,
} from '../../lib/normalize.js';
import { Where } from '../../lib/sql.js';

const zSalary = z
  .union([z.number(), z.string(), z.null()])
  .optional()
  .transform((v, ctx) => {
    if (v === undefined || v === null || v === '') return null;
    const n = typeof v === 'number' ? v : Number(String(v).replace(/\./g, '').replace(',', '.'));
    if (!Number.isFinite(n) || n < 0 || n > 9_999_999_999) {
      ctx.addIssue({ code: 'custom', message: 'Pretensão salarial inválida.' });
      return z.NEVER;
    }
    return Math.round(n * 100) / 100;
  });

const candidateFields = {
  fullName: zText(2, 160),
  email: zOptionalEmail,
  phone: zOptionalPhone,
  salaryExpectation: zSalary,
  notes: zOptionalText(10000),
};

function alphaOnly(req: FastifyRequest) {
  if (!isAlpha(requireUser(req))) throw forbidden();
}

async function findDuplicates(db: Db, email: string | null, phone: string | null, excludeId: string | null) {
  if (!email && !phone) return { matches: [], hiddenCount: 0 };
  const { rows } = await db.query<{ id: string; fullName: string; email: string | null; phone: string | null }>(
    `select id, full_name as "fullName", email, phone from candidates
      where ($3::uuid is null or id <> $3)
        and (($1::text is not null and email = $1::citext) or ($2::text is not null and phone = $2))
      limit 10`,
    [email, phone, excludeId],
  );
  const total = await db.query<{ n: number }>('select app.candidate_duplicate_count($1, $2, $3) as n', [
    email,
    phone,
    excludeId,
  ]);
  return { matches: rows, hiddenCount: Math.max(0, total.rows[0]!.n - rows.length) };
}

export function registerCandidateRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/api/candidates', async (req) => {
    alphaOnly(req);
    const q = parse(
      zPage.extend({
        q: z.string().max(100).optional(),
        processId: zUuid.optional(),
        stageId: z.coerce.number().int().min(1).max(20).optional(),
        ownerId: zUuid.optional(),
        decision: z.enum(['pendente', 'aprovado', 'reprovado', 'desistiu']).optional(),
        archived: z.enum(['true', 'false']).default('false'),
      }),
      req.query,
    );
    return asUser(deps, req, async (db) => {
      const w = new Where();
      w.raw(q.archived === 'true' ? 'c.archived_at is not null' : 'c.archived_at is null');
      if (q.q) {
        const digits = q.q.replace(/\D/g, '');
        const pat = likePattern(q.q);
        if (digits.length >= 4) {
          const dp = w.param(`%${digits}%`);
          w.add(`(c.full_name ilike ? or c.email::text ilike ? or c.phone like ${dp})`, pat);
        } else {
          w.add('(c.full_name ilike ? or c.email::text ilike ?)', pat);
        }
      }
      const appFilters: string[] = [];
      if (q.processId) appFilters.push(`a.process_id = ${w.param(q.processId)}`);
      if (q.stageId) appFilters.push(`a.stage_id = ${w.param(q.stageId)}`);
      if (q.ownerId) appFilters.push(`a.owner_id = ${w.param(q.ownerId)}`);
      if (q.decision) appFilters.push(`a.decision = ${w.param(q.decision)}`);
      if (appFilters.length) {
        w.raw(`exists (select 1 from applications a where a.candidate_id = c.id and ${appFilters.join(' and ')})`);
      }
      const total = await db.query<{ n: number }>(`select count(*)::int as n from candidates c ${w.clause}`, w.params);
      const lim = w.param(q.pageSize);
      const off = w.param((q.page - 1) * q.pageSize);
      const { rows } = await db.query(
        `select c.id, c.full_name as "fullName", c.email, c.phone, c.updated_at as "updatedAt",
                (select count(*)::int from applications a where a.candidate_id = c.id) as "applicationCount",
                (select count(*)::int from documents d where d.candidate_id = c.id) as "documentCount"
           from candidates c ${w.clause}
          order by c.updated_at desc limit ${lim} offset ${off}`,
        w.params,
      );
      return { items: rows, total: total.rows[0]!.n, page: q.page, pageSize: q.pageSize };
    });
  });

  app.post('/api/candidates/check-duplicates', async (req) => {
    alphaOnly(req);
    const body = parse(
      z.object({ email: zOptionalEmail, phone: zOptionalPhone, excludeId: zUuid.nullish() }).strict(),
      req.body,
    );
    return asUser(deps, req, (db) => findDuplicates(db, body.email, body.phone, body.excludeId ?? null));
  });

  app.post('/api/candidates', async (req, reply) => {
    alphaOnly(req);
    const body = parse(z.object({ ...candidateFields, confirmDuplicate: z.boolean().default(false) }).strict(), req.body);
    const id = await asUser(deps, req, async (db, user) => {
      if (!body.confirmDuplicate) {
        const dup = await findDuplicates(db, body.email, body.phone, null);
        if (dup.matches.length || dup.hiddenCount) {
          throw Object.assign(
            new AppError(409, 'possible_duplicate', 'Encontramos cadastro(s) com o mesmo e-mail ou telefone.'),
            { extra: dup },
          );
        }
      }
      const { rows } = await db.query<{ id: string }>(
        `insert into candidates (full_name, email, phone, salary_expectation, notes, created_by)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [body.fullName, body.email, body.phone, body.salaryExpectation, body.notes, user.id],
      );
      await audit(db, req, 'candidate.created', 'candidate', rows[0]!.id, null, {
        confirmedDuplicate: body.confirmDuplicate,
      });
      return rows[0]!.id;
    });
    reply.code(201);
    return { id };
  });

  app.get('/api/candidates/:id', async (req) => {
    alphaOnly(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return asUser(deps, req, async (db) => {
      const { rows } = await db.query(
        `select c.id, c.full_name as "fullName", c.email, c.phone, c.salary_expectation as "salaryExpectation",
                c.notes, c.version, c.archived_at as "archivedAt", c.created_at as "createdAt",
                c.updated_at as "updatedAt", u.full_name as "createdByName",
                c.source, c.city, c.consent_at as "consentAt"
           from candidates c left join users u on u.id = c.created_by where c.id = $1`,
        [id],
      );
      if (!rows[0]) throw notFound('Candidato não encontrado.');
      const apps = await db.query(
        `select a.id, a.process_id as "processId", p.title as "processTitle", co.name as "companyName",
                p.status as "processStatus", a.stage_id as "stageId", a.decision, o.full_name as "ownerName",
                a.updated_at as "updatedAt"
           from applications a
           join processes p on p.id = a.process_id
           join companies co on co.id = p.company_id
           left join users o on o.id = a.owner_id
          where a.candidate_id = $1 order by a.created_at desc`,
        [id],
      );
      const docs = await db.query(
        `select d.id, d.kind, d.original_name as "name", d.mime_type as "mimeType", d.size_bytes as "size",
                d.created_at as "createdAt", u.full_name as "uploadedByName", d.uploaded_by as "uploadedBy"
           from documents d left join users u on u.id = d.uploaded_by
          where d.candidate_id = $1 order by d.created_at desc`,
        [id],
      );
      await audit(db, req, 'candidate.viewed', 'candidate', id);
      return { ...rows[0], applications: apps.rows, documents: docs.rows };
    });
  });

  app.patch('/api/candidates/:id', async (req) => {
    alphaOnly(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(
      z
        .object({
          expectedVersion: z.number().int().positive(),
          fullName: candidateFields.fullName.optional(),
          email: candidateFields.email.optional(),
          phone: candidateFields.phone.optional(),
          salaryExpectation: candidateFields.salaryExpectation,
          notes: candidateFields.notes.optional(),
          archived: z.boolean().optional(),
        })
        .strict(),
      req.body,
    );
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const has = (k: string) => Object.prototype.hasOwnProperty.call(raw, k);
    return asUser(deps, req, async (db) => {
      const cur = await db.query('select 1 from candidates where id = $1', [id]);
      if (!cur.rowCount) throw notFound('Candidato não encontrado.');
      const sets: string[] = [];
      const params: unknown[] = [id, body.expectedVersion];
      const set = (col: string, v: unknown) => {
        params.push(v);
        sets.push(`${col} = $${params.length}`);
      };
      if (body.fullName !== undefined) set('full_name', body.fullName);
      if (has('email')) set('email', body.email ?? null);
      if (has('phone')) set('phone', body.phone ?? null);
      if (has('salaryExpectation')) set('salary_expectation', body.salaryExpectation);
      if (has('notes')) set('notes', body.notes ?? null);
      if (body.archived !== undefined) sets.push(`archived_at = ${body.archived ? 'now()' : 'null'}`);
      if (!sets.length) return { ok: true };
      const { rowCount } = await db.query(
        `update candidates set ${sets.join(', ')} where id = $1 and version = $2`,
        params,
      );
      if (!rowCount) throw staleVersion();
      await audit(db, req, 'candidate.updated', 'candidate', id, null, {
        fields: Object.keys(raw).filter((k) => k !== 'expectedVersion'),
      });
      return { ok: true };
    });
  });

  /**
   * Exportação dos dados do titular (portabilidade/acesso), somente administrador.
   * Inclui cadastro, participações, comentários, histórico e metadados dos
   * documentos. Os arquivos são baixados individualmente pela tela.
   */
  app.get('/api/candidates/:id/export', async (req, reply) => {
    if (!isAdmin(requireUser(req))) throw forbidden();
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const data = await asUser(deps, req, async (db) => {
      const cand = await db.query(
        `select full_name as "nome", email, phone as "telefone", salary_expectation as "pretensaoSalarial",
                notes as "observacoesInternas", created_at as "cadastradoEm", updated_at as "atualizadoEm",
                archived_at as "arquivadoEm"
           from candidates where id = $1`,
        [id],
      );
      if (!cand.rows[0]) throw notFound('Candidato não encontrado.');
      const apps = await db.query(
        `select a.id, p.title as "processo", co.name as "empresa", st.name as "etapa", a.decision as "decisao",
                a.share_email as "compartilhaEmail", a.share_phone as "compartilhaTelefone",
                a.share_salary as "compartilhaPretensao", a.shared_summary as "resumoCompartilhado",
                a.created_at as "incluidoEm", a.updated_at as "atualizadoEm",
                coalesce((select json_agg(json_build_object(
                    'visibilidade', c.visibility, 'autor', app.person_label(c.author_id),
                    'texto', c.body, 'em', c.created_at) order by c.created_at)
                  from comments c where c.application_id = a.id), '[]') as "comentarios",
                coalesce((select json_agg(json_build_object(
                    'deEtapa', fs.name, 'paraEtapa', ts.name, 'deDecisao', h.from_decision,
                    'paraDecisao', h.to_decision, 'por', app.person_label(h.actor_id), 'em', h.created_at)
                    order by h.created_at)
                  from application_history h
                  left join stages fs on fs.id = h.from_stage_id
                  left join stages ts on ts.id = h.to_stage_id
                  where h.application_id = a.id), '[]') as "historico"
           from applications a
           join processes p on p.id = a.process_id
           join companies co on co.id = p.company_id
           join stages st on st.id = a.stage_id
          where a.candidate_id = $1 order by a.created_at`,
        [id],
      );
      const docs = await db.query(
        `select d.original_name as "nome", d.kind as "tipo", d.mime_type as "formato", d.size_bytes as "tamanhoBytes",
                d.sha256, d.created_at as "enviadoEm"
           from documents d where d.candidate_id = $1 order by d.created_at`,
        [id],
      );
      await audit(db, req, 'candidate.exported', 'candidate', id);
      return {
        geradoEm: new Date().toISOString(),
        candidato: cand.rows[0],
        participacoes: apps.rows,
        documentos: docs.rows,
      };
    });
    reply
      .header('Content-Type', 'application/json; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="dados-candidato-${id.slice(0, 8)}.json"`);
    return JSON.stringify(data, null, 2);
  });

  /**
   * Eliminação definitiva (atendimento a solicitação do titular), somente administrador.
   * Remove participações, comentários, histórico, documentos e arquivos físicos.
   * Registros de auditoria mantêm apenas identificadores, sem dados pessoais.
   */
  app.delete('/api/candidates/:id', async (req) => {
    if (!isAdmin(requireUser(req))) throw forbidden();
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const keys = await asUser(deps, req, async (db) => {
      const cur = await db.query('select 1 from candidates where id = $1', [id]);
      if (!cur.rowCount) throw notFound('Candidato não encontrado.');
      const docs = await db.query<{ storage_key: string }>('select storage_key from documents where candidate_id = $1', [
        id,
      ]);
      await db.query('delete from applications where candidate_id = $1', [id]);
      await db.query('delete from documents where candidate_id = $1', [id]);
      await db.query('delete from candidates where id = $1', [id]);
      await audit(db, req, 'candidate.erased', 'candidate', id, null, { documents: docs.rowCount });
      return docs.rows.map((d) => d.storage_key);
    });
    for (const k of keys) await deps.storage.remove(k).catch(() => undefined);
    return { ok: true };
  });
}
