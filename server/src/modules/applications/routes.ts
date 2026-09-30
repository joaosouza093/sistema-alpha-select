import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../lib/context.js';
import { asUser, audit, isAdmin, isAlpha, requireUser } from '../../lib/context.js';
import type { Db } from '../../lib/db.js';
import { AppError, conflict, forbidden, notFound, staleVersion } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { zOptionalText, zText, zUuid } from '../../lib/normalize.js';
import { loadProcess, processPermissions } from '../processes/routes.js';

const decisions = ['pendente', 'aprovado', 'reprovado', 'desistiu'] as const;
const zVersion = z.number().int().positive();

interface AppRow {
  id: string;
  process_id: string;
  company_id: string;
}

async function loadApp(db: Db, id: string): Promise<AppRow> {
  const { rows } = await db.query<AppRow>(
    `select a.id, a.process_id, p.company_id from applications a join processes p on p.id = a.process_id where a.id = $1`,
    [id],
  );
  if (!rows[0]) throw notFound('Participação não encontrada.');
  return rows[0];
}

/** UPDATE com controle de versão: evita que alterações simultâneas se sobrescrevam. */
async function versionedUpdate(db: Db, id: string, expectedVersion: number, setSql: string, params: unknown[]) {
  const { rowCount } = await db.query(
    `update applications set ${setSql} where id = $1 and version = $2`,
    [id, expectedVersion, ...params],
  );
  if (!rowCount) throw staleVersion();
}

export function registerApplicationRoutes(app: FastifyInstance, deps: Deps) {
  app.post('/api/applications', async (req, reply) => {
    if (!isAlpha(requireUser(req))) throw forbidden();
    const body = parse(
      z.object({ candidateId: zUuid, processId: zUuid, ownerId: zUuid.nullish() }).strict(),
      req.body,
    );
    const id = await asUser(deps, req, async (db, user) => {
      const p = await loadProcess(db, body.processId);
      const perms = await processPermissions(db, user, body.processId);
      if (!perms.canAddCandidates) throw forbidden('Você não tem acesso para incluir candidatos neste processo.');
      const cand = await db.query('select 1 from candidates where id = $1', [body.candidateId]);
      if (!cand.rowCount) throw notFound('Candidato não encontrado.');
      const dup = await db.query('select 1 from applications where candidate_id = $1 and process_id = $2', [
        body.candidateId,
        body.processId,
      ]);
      if (dup.rowCount) throw conflict('O candidato já participa deste processo.');
      const { rows } = await db.query<{ id: string }>(
        `insert into applications (candidate_id, process_id, owner_id) values ($1, $2, $3) returning id`,
        [body.candidateId, body.processId, body.ownerId ?? null],
      );
      await audit(db, req, 'application.created', 'application', rows[0]!.id, p.companyId, {
        processId: body.processId,
      });
      return rows[0]!.id;
    });
    reply.code(201);
    return { id };
  });

  app.get('/api/applications/:id', async (req) => {
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return asUser(deps, req, async (db, user) => {
      const a = await loadApp(db, id);
      const alpha = isAlpha(user);
      const { rows } = await db.query(
        `select a.id, a.stage_id as "stageId", st.name as "stageName", a.decision, a.version,
                a.owner_id as "ownerId", o.full_name as "ownerName", a.stage_changed_at as "stageChangedAt",
                a.created_at as "createdAt", a.updated_at as "updatedAt", a.shared_summary as "sharedSummary",
                a.share_email as "shareEmail", a.share_phone as "sharePhone", a.share_salary as "shareSalary",
                s.candidate_id as "candidateId", s.full_name as "candidateName", s.email as "candidateEmail",
                s.phone as "candidatePhone", s.salary_expectation as "candidateSalary"
           from applications a
           join stages st on st.id = a.stage_id
           join shared_application_candidates s on s.application_id = a.id
           left join users o on o.id = a.owner_id
          where a.id = $1`,
        [id],
      );
      const row = rows[0] as Record<string, unknown> | undefined;
      if (!row) throw notFound('Participação não encontrada.');
      if (!alpha) {
        // Configuração de compartilhamento é interna.
        delete row.shareEmail;
        delete row.sharePhone;
        delete row.shareSalary;
      }
      if (row.ownerId && !row.ownerName) row.ownerName = 'Equipe Alpha Select';
      const process = await loadProcess(db, a.process_id);
      const permissions = await processPermissions(db, user, a.process_id);
      await audit(db, req, 'application.viewed', 'application', id, a.company_id);
      return { ...row, process, permissions };
    });
  });

  app.post('/api/applications/:id/move', async (req) => {
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(
      z
        .object({ toStageId: z.number().int().min(1).max(20), expectedVersion: zVersion, ownerId: zUuid.nullish() })
        .strict(),
      req.body,
    );
    return asUser(deps, req, async (db) => {
      const a = await loadApp(db, id);
      if (body.ownerId !== undefined) {
        await versionedUpdate(db, id, body.expectedVersion, 'stage_id = $3, owner_id = $4', [
          body.toStageId,
          body.ownerId,
        ]);
      } else {
        await versionedUpdate(db, id, body.expectedVersion, 'stage_id = $3', [body.toStageId]);
      }
      await audit(db, req, 'application.moved', 'application', id, a.company_id, { toStageId: body.toStageId });
      return { ok: true };
    });
  });

  app.post('/api/applications/:id/decision', async (req) => {
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(z.object({ decision: z.enum(decisions), expectedVersion: zVersion }).strict(), req.body);
    return asUser(deps, req, async (db) => {
      const a = await loadApp(db, id);
      await versionedUpdate(db, id, body.expectedVersion, 'decision = $3', [body.decision]);
      await audit(db, req, 'application.decision', 'application', id, a.company_id, { decision: body.decision });
      return { ok: true };
    });
  });

  app.post('/api/applications/:id/owner', async (req) => {
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(z.object({ ownerId: zUuid.nullable(), expectedVersion: zVersion }).strict(), req.body);
    return asUser(deps, req, async (db) => {
      const a = await loadApp(db, id);
      await versionedUpdate(db, id, body.expectedVersion, 'owner_id = $3', [body.ownerId]);
      await audit(db, req, 'application.owner', 'application', id, a.company_id, { ownerId: body.ownerId });
      return { ok: true };
    });
  });

  app.patch('/api/applications/:id/sharing', async (req) => {
    if (!isAlpha(requireUser(req))) throw forbidden();
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(
      z
        .object({
          expectedVersion: zVersion,
          shareEmail: z.boolean(),
          sharePhone: z.boolean(),
          shareSalary: z.boolean(),
          sharedSummary: zOptionalText(5000),
        })
        .strict(),
      req.body,
    );
    return asUser(deps, req, async (db) => {
      const a = await loadApp(db, id);
      await versionedUpdate(
        db,
        id,
        body.expectedVersion,
        'share_email = $3, share_phone = $4, share_salary = $5, shared_summary = $6',
        [body.shareEmail, body.sharePhone, body.shareSalary, body.sharedSummary],
      );
      await audit(db, req, 'application.sharing', 'application', id, a.company_id, {
        shareEmail: body.shareEmail,
        sharePhone: body.sharePhone,
        shareSalary: body.shareSalary,
      });
      return { ok: true };
    });
  });

  app.delete('/api/applications/:id', async (req) => {
    if (!isAdmin(requireUser(req))) throw forbidden();
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return asUser(deps, req, async (db) => {
      const a = await loadApp(db, id);
      await db.query('delete from applications where id = $1', [id]);
      await audit(db, req, 'application.deleted', 'application', id, a.company_id);
      return { ok: true };
    });
  });

  /** Quem pode ser responsável: participantes ativos do processo (e administradores, para a equipe). */
  app.get('/api/applications/:id/owner-options', async (req) => {
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return asUser(deps, req, async (db) => {
      const a = await loadApp(db, id);
      const { rows } = await db.query(
        `select u.id, u.full_name as "fullName", u.kind
           from users u
          where u.is_active
            and (exists (select 1 from process_members m where m.process_id = $1 and m.user_id = u.id)
                 or u.kind = 'alpha_admin')
          order by u.full_name`,
        [a.process_id],
      );
      return { items: rows };
    });
  });

  app.get('/api/applications/:id/history', async (req) => {
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return asUser(deps, req, async (db) => {
      await loadApp(db, id);
      const { rows } = await db.query(
        `select h.id, h.event, h.from_stage_id as "fromStageId", h.to_stage_id as "toStageId",
                h.from_decision as "fromDecision", h.to_decision as "toDecision",
                h.from_owner_id as "fromOwnerId", h.to_owner_id as "toOwnerId",
                fo.full_name as "fromOwnerName", tow.full_name as "toOwnerName",
                ac.full_name as "actorName", h.created_at as "createdAt"
           from application_history h
           left join users fo on fo.id = h.from_owner_id
           left join users tow on tow.id = h.to_owner_id
           left join users ac on ac.id = h.actor_id
          where h.application_id = $1 order by h.created_at desc, h.id desc`,
        [id],
      );
      return { items: rows };
    });
  });

  // ------------------------------------------------------------------ comentários

  app.get('/api/applications/:id/comments', async (req) => {
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return asUser(deps, req, async (db) => {
      await loadApp(db, id);
      const { rows } = await db.query(
        `select c.id, c.visibility, c.body, c.created_at as "createdAt", c.updated_at as "updatedAt", c.edited,
                c.author_id as "authorId", u.full_name as "authorName"
           from comments c left join users u on u.id = c.author_id
          where c.application_id = $1 order by c.created_at`,
        [id],
      );
      return { items: rows };
    });
  });

  app.post('/api/applications/:id/comments', async (req, reply) => {
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(
      z.object({ body: zText(1, 5000), visibility: z.enum(['internal', 'shared']).default('internal') }).strict(),
      req.body,
    );
    const commentId = await asUser(deps, req, async (db, user) => {
      const a = await loadApp(db, id);
      if (!isAlpha(user) && body.visibility !== 'shared') {
        throw forbidden('Usuários de cliente só publicam comentários compartilhados.');
      }
      const { rows } = await db.query<{ id: string }>(
        `insert into comments (application_id, author_id, visibility, body) values ($1, $2, $3, $4) returning id`,
        [id, user.id, body.visibility, body.body],
      );
      await audit(db, req, 'comment.created', 'comment', rows[0]!.id, a.company_id, {
        applicationId: id,
        visibility: body.visibility,
      });
      return rows[0]!.id;
    });
    reply.code(201);
    return { id: commentId };
  });

  app.patch('/api/comments/:id', async (req) => {
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(z.object({ body: zText(1, 5000) }).strict(), req.body);
    return asUser(deps, req, async (db) => {
      const { rowCount } = await db.query('update comments set body = $2 where id = $1', [id, body.body]);
      if (!rowCount) throw notFound('Comentário não encontrado ou sem permissão para editar.');
      await audit(db, req, 'comment.updated', 'comment', id);
      return { ok: true };
    });
  });

  app.delete('/api/comments/:id', async (req) => {
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return asUser(deps, req, async (db) => {
      const { rowCount } = await db.query('delete from comments where id = $1', [id]);
      if (!rowCount) throw notFound('Comentário não encontrado ou sem permissão para excluir.');
      await audit(db, req, 'comment.deleted', 'comment', id);
      return { ok: true };
    });
  });

  // ------------------------------------------------------------------ documentos da participação

  app.get('/api/applications/:id/documents', async (req) => {
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return asUser(deps, req, async (db, user) => {
      await loadApp(db, id);
      const { rows } = await db.query(
        `select d.id, d.kind, d.original_name as "name", d.mime_type as "mimeType", d.size_bytes as "size",
                d.created_at as "createdAt", u.full_name as "uploadedByName",
                ad.shared_with_client as "sharedWithClient"
           from application_documents ad
           join documents d on d.id = ad.document_id
           left join users u on u.id = d.uploaded_by
          where ad.application_id = $1 order by d.created_at desc`,
        [id],
      );
      if (!isAlpha(user)) {
        for (const r of rows as Record<string, unknown>[]) delete r.sharedWithClient;
      }
      return { items: rows };
    });
  });

  /** Vincula um documento do candidato à participação e define se é visível ao cliente. */
  app.put('/api/applications/:id/documents/:documentId', async (req) => {
    if (!isAlpha(requireUser(req))) throw forbidden();
    const { id, documentId } = parse(z.object({ id: zUuid, documentId: zUuid }), req.params);
    const body = parse(z.object({ sharedWithClient: z.boolean() }).strict(), req.body);
    return asUser(deps, req, async (db) => {
      const a = await loadApp(db, id);
      const doc = await db.query<{ candidate_id: string }>('select candidate_id from documents where id = $1', [documentId]);
      if (!doc.rows[0]) throw notFound('Documento não encontrado.');
      const owner = await db.query<{ candidate_id: string }>('select candidate_id from applications where id = $1', [id]);
      if (owner.rows[0]?.candidate_id !== doc.rows[0].candidate_id) {
        throw new AppError(422, 'invalid', 'O documento pertence a outro candidato.');
      }
      await db.query(
        `insert into application_documents (application_id, document_id, candidate_id, shared_with_client)
         values ($1, $2, $3, $4)
         on conflict (application_id, document_id) do update set shared_with_client = excluded.shared_with_client`,
        [id, documentId, doc.rows[0].candidate_id, body.sharedWithClient],
      );
      await audit(db, req, 'document.shared', 'document', documentId, a.company_id, {
        applicationId: id,
        sharedWithClient: body.sharedWithClient,
      });
      return { ok: true };
    });
  });

  app.delete('/api/applications/:id/documents/:documentId', async (req) => {
    if (!isAlpha(requireUser(req))) throw forbidden();
    const { id, documentId } = parse(z.object({ id: zUuid, documentId: zUuid }), req.params);
    return asUser(deps, req, async (db) => {
      const a = await loadApp(db, id);
      const { rowCount } = await db.query(
        'delete from application_documents where application_id = $1 and document_id = $2',
        [id, documentId],
      );
      if (!rowCount) throw notFound('Vínculo não encontrado.');
      await audit(db, req, 'document.unlinked', 'document', documentId, a.company_id, { applicationId: id });
      return { ok: true };
    });
  });
}
