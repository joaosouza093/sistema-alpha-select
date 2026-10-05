import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps, AuthUser } from '../../lib/context.js';
import { asUser, audit, isAdmin, isAlpha, requireUser } from '../../lib/context.js';
import type { Db } from '../../lib/db.js';
import { forbidden, notFound, staleVersion } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { likePattern, zOptionalText, zPage, zText, zUuid } from '../../lib/normalize.js';
import { Where } from '../../lib/sql.js';

const statuses = ['em_andamento', 'concluido', 'arquivado'] as const;

export interface ProcessPermissions {
  isMember: boolean;
  canManage: boolean;
  canAddCandidates: boolean;
  canMoveStage: boolean;
  canDecide: boolean;
  canComment: boolean;
  canSeeInternal: boolean;
}

/** Permissões efetivas do usuário no processo (as mesmas regras são reaplicadas pelo banco). */
export async function processPermissions(db: Db, user: AuthUser, processId: string): Promise<ProcessPermissions> {
  const { rows } = await db.query<{ can_move_stage: boolean; can_decide: boolean; can_comment: boolean }>(
    'select can_move_stage, can_decide, can_comment from process_members where process_id = $1 and user_id = $2',
    [processId, user.id],
  );
  const m = rows[0];
  const admin = isAdmin(user);
  const alpha = isAlpha(user);
  return {
    isMember: !!m,
    canManage: admin,
    canAddCandidates: admin || (alpha && !!m),
    canMoveStage: admin || !!m?.can_move_stage,
    canDecide: admin || !!m?.can_decide,
    canComment: admin || (alpha && !!m) || !!m?.can_comment,
    canSeeInternal: alpha,
  };
}

export async function loadProcess(db: Db, id: string) {
  const { rows } = await db.query<{
    id: string;
    companyId: string;
    companyName: string;
    title: string;
    description: string | null;
    status: (typeof statuses)[number];
    publication: string;
    publicSlug: string | null;
    slaDays: number;
    evaluationCriteria: string[];
    version: number;
    createdAt: Date;
    updatedAt: Date;
  }>(
    `select p.id, p.company_id as "companyId", c.name as "companyName", p.title, p.description, p.status,
            p.publication, p.public_slug as "publicSlug", p.sla_days as "slaDays",
            p.evaluation_criteria as "evaluationCriteria", p.version, p.created_at as "createdAt", p.updated_at as "updatedAt"
       from processes p join companies c on c.id = p.company_id where p.id = $1`,
    [id],
  );
  if (!rows[0]) throw notFound('Processo não encontrado.');
  return rows[0];
}

interface FunnelCard {
  stageId: number;
  decision: string;
  sentAt: Date | null;
  triageStatus: string | null;
}

/** Funil do processo calculado sobre o que o usuário pode ver (RLS). */
function funnel(cards: FunnelCard[]) {
  return {
    total: cards.length,
    emTriagem: cards.filter((c) => !c.sentAt && c.decision === 'pendente' && c.triageStatus !== 'aprovado_interno' && c.triageStatus !== 'reprovado_interno').length,
    aprovadosInternos: cards.filter((c) => c.triageStatus === 'aprovado_interno' || !!c.sentAt).length,
    enviados: cards.filter((c) => !!c.sentAt).length,
    aprovados: cards.filter((c) => c.decision === 'aprovado').length,
  };
}

export function registerProcessRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/api/processes', async (req) => {
    const q = parse(
      zPage.extend({
        q: z.string().max(100).optional(),
        status: z.enum(statuses).optional(),
        companyId: zUuid.optional(),
      }),
      req.query,
    );
    return asUser(deps, req, async (db) => {
      const w = new Where();
      if (q.q) w.add('p.title ilike ?', likePattern(q.q));
      if (q.status) w.add('p.status = ?', q.status);
      if (q.companyId) w.add('p.company_id = ?', q.companyId);
      const total = await db.query<{ n: number }>(`select count(*)::int as n from processes p ${w.clause}`, w.params);
      const lim = w.param(q.pageSize);
      const off = w.param((q.page - 1) * q.pageSize);
      const { rows } = await db.query(
        `select p.id, p.title, p.status, p.publication, p.company_id as "companyId", c.name as "companyName",
                p.updated_at as "updatedAt",
                (select count(*)::int from applications a where a.process_id = p.id) as "candidateCount",
                (select count(*)::int from applications a where a.process_id = p.id and a.decision = 'pendente') as "openCount"
           from processes p join companies c on c.id = p.company_id
           ${w.clause}
          order by (p.status = 'em_andamento') desc, p.updated_at desc
          limit ${lim} offset ${off}`,
        w.params,
      );
      return { items: rows, total: total.rows[0]!.n, page: q.page, pageSize: q.pageSize };
    });
  });

  app.post('/api/processes', async (req, reply) => {
    if (!isAdmin(requireUser(req))) throw forbidden();
    const body = parse(
      z.object({ companyId: zUuid, title: zText(3, 160), description: zOptionalText(5000) }).strict(),
      req.body,
    );
    const id = await asUser(deps, req, async (db, user) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into processes (company_id, title, description, created_by) values ($1, $2, $3, $4) returning id`,
        [body.companyId, body.title, body.description, user.id],
      );
      await audit(db, req, 'process.created', 'process', rows[0]!.id, body.companyId);
      return rows[0]!.id;
    });
    reply.code(201);
    return { id };
  });

  app.get('/api/processes/:id', async (req) => {
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return asUser(deps, req, async (db, user) => {
      const process = await loadProcess(db, id);
      const permissions = await processPermissions(db, user, id);
      return { ...process, permissions };
    });
  });

  app.patch('/api/processes/:id', async (req) => {
    if (!isAdmin(requireUser(req))) throw forbidden();
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(
      z
        .object({
          expectedVersion: z.number().int().positive(),
          title: zText(3, 160).optional(),
          description: zOptionalText(5000).optional(),
          status: z.enum(statuses).optional(),
        })
        .strict(),
      req.body,
    );
    return asUser(deps, req, async (db) => {
      const p = await loadProcess(db, id);
      const { rowCount } = await db.query(
        `update processes set title = coalesce($3, title),
                description = case when $4::boolean then $5 else description end,
                status = coalesce($6, status)
          where id = $1 and version = $2`,
        [id, body.expectedVersion, body.title ?? null, body.description !== undefined, body.description ?? null, body.status ?? null],
      );
      if (!rowCount) throw staleVersion();
      await audit(db, req, 'process.updated', 'process', id, p.companyId, {
        fields: Object.keys(body).filter((k) => k !== 'expectedVersion'),
        status: body.status,
      });
      return { ok: true };
    });
  });

  // ------------------------------------------------------------------ participantes autorizados

  app.get('/api/processes/:id/members', async (req) => {
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return asUser(deps, req, async (db) => {
      await loadProcess(db, id);
      const { rows } = await db.query(
        `select m.user_id as "userId", u.full_name as "fullName", u.kind, u.is_active as "isActive",
                m.can_move_stage as "canMoveStage", m.can_decide as "canDecide", m.can_comment as "canComment"
           from process_members m join users u on u.id = m.user_id
          where m.process_id = $1 order by u.kind, u.full_name`,
        [id],
      );
      return { items: rows };
    });
  });

  /** Usuários que podem ser vinculados: equipe Alpha e usuários da empresa do processo. */
  app.get('/api/processes/:id/member-candidates', async (req) => {
    if (!isAdmin(requireUser(req))) throw forbidden();
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return asUser(deps, req, async (db) => {
      const p = await loadProcess(db, id);
      const { rows } = await db.query(
        `select u.id, u.full_name as "fullName", u.kind, u.email
           from users u
          where u.is_active
            and (u.kind = 'alpha_staff' or u.company_id = $2)
            and not exists (select 1 from process_members m where m.process_id = $1 and m.user_id = u.id)
          order by u.kind, u.full_name`,
        [id, p.companyId],
      );
      return { items: rows };
    });
  });

  app.put('/api/processes/:id/members/:userId', async (req) => {
    if (!isAdmin(requireUser(req))) throw forbidden();
    const { id, userId } = parse(z.object({ id: zUuid, userId: zUuid }), req.params);
    const body = parse(
      z.object({ canMoveStage: z.boolean(), canDecide: z.boolean(), canComment: z.boolean() }).strict(),
      req.body,
    );
    return asUser(deps, req, async (db) => {
      const p = await loadProcess(db, id);
      await db.query(
        `insert into process_members (process_id, user_id, can_move_stage, can_decide, can_comment)
         values ($1, $2, $3, $4, $5)
         on conflict (process_id, user_id) do update
           set can_move_stage = excluded.can_move_stage, can_decide = excluded.can_decide,
               can_comment = excluded.can_comment`,
        [id, userId, body.canMoveStage, body.canDecide, body.canComment],
      );
      await audit(db, req, 'process.member_set', 'process', id, p.companyId, { userId, ...body });
      return { ok: true };
    });
  });

  app.delete('/api/processes/:id/members/:userId', async (req) => {
    if (!isAdmin(requireUser(req))) throw forbidden();
    const { id, userId } = parse(z.object({ id: zUuid, userId: zUuid }), req.params);
    return asUser(deps, req, async (db) => {
      const p = await loadProcess(db, id);
      const { rowCount } = await db.query('delete from process_members where process_id = $1 and user_id = $2', [
        id,
        userId,
      ]);
      if (!rowCount) throw notFound('Vínculo não encontrado.');
      await audit(db, req, 'process.member_removed', 'process', id, p.companyId, { userId });
      return { ok: true };
    });
  });

  // ------------------------------------------------------------------ quadro

  app.get('/api/processes/:id/board', async (req) => {
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return asUser(deps, req, async (db, user) => {
      const process = await loadProcess(db, id);
      const permissions = await processPermissions(db, user, id);
      const stages = await db.query('select id, key, name, position from stages order by position');
      const { rows } = await db.query(
        `select a.id, a.stage_id as "stageId", a.decision, a.version, a.stage_changed_at as "stageChangedAt",
                a.owner_id as "ownerId", app.person_label(a.owner_id) as "ownerName", s.full_name as "candidateName",
                (select count(*)::int from application_documents ad where ad.application_id = a.id) as "documentCount",
                (select count(*)::int from comments cm where cm.application_id = a.id) as "commentCount",
                a.source, (select i.screening_failed from application_intake i where i.application_id = a.id) as "screeningFailed",
                a.decision_reason as "decisionReason", a.sent_at as "sentAt",
                e.triage_status as "triageStatus", e.score::float as score,
                (a.decision = 'pendente' and a.stage_changed_at < now() - make_interval(days => $2)) as "slaOverdue"
           from applications a
           left join application_evaluations e on e.application_id = a.id
           join shared_application_candidates s on s.application_id = a.id
          where a.process_id = $1
          order by a.stage_changed_at`,
        [id, process.slaDays],
      );
      return { process: { ...process, permissions }, stages: stages.rows, cards: rows, funnel: funnel(rows as FunnelCard[]) };
    });
  });
}
