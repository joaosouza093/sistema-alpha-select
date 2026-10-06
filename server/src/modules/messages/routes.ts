import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../lib/context.js';
import { asUser, audit, isAdmin, isAlpha, requireUser } from '../../lib/context.js';
import { forbidden, notFound, staleVersion } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { zOptionalText, zPage, zText, zUuid } from '../../lib/normalize.js';
import { fmtDateTimeBR, modeLabel, sendCandidateMessage, templateKeys, templateVars } from './service.js';

const modes = ['presencial', 'online', 'telefone'] as const;

export function registerMessageRoutes(app: FastifyInstance, deps: Deps) {
  const adminOnly = (req: FastifyRequest) => {
    if (!isAdmin(requireUser(req))) throw forbidden();
  };

  // ------------------------------------------------------------------ modelos

  app.get('/api/message-templates', async (req) => {
    adminOnly(req);
    return asUser(deps, req, async (db) => {
      const { rows } = await db.query(
        'select key, enabled, subject, body, updated_at as "updatedAt" from message_templates order by key',
      );
      return { items: rows, variables: templateVars, emailEnabled: deps.config.mailMode !== 'manual' };
    });
  });

  app.put('/api/message-templates/:key', async (req) => {
    adminOnly(req);
    const { key } = parse(z.object({ key: z.enum(templateKeys) }), req.params);
    const body = parse(z.object({ enabled: z.boolean(), subject: zText(3, 200), body: zText(10, 5000) }).strict(), req.body);
    return asUser(deps, req, async (db, user) => {
      const r = await db.query(
        'update message_templates set enabled = $2, subject = $3, body = $4, updated_at = now(), updated_by = $5 where key = $1',
        [key, body.enabled, body.subject, body.body, user.id],
      );
      if (!r.rowCount) throw notFound();
      await audit(db, req, 'message_template.updated', 'message_template', key, null, { enabled: body.enabled });
      return { ok: true };
    });
  });

  /** Histórico de mensagens (equipe Alpha; RLS limita aos candidatos visíveis). */
  app.get('/api/message-log', async (req) => {
    if (!isAlpha(requireUser(req))) throw forbidden();
    const q = parse(zPage.extend({ candidateId: zUuid.optional() }), req.query);
    return asUser(deps, req, async (db) => {
      const params: unknown[] = [];
      let where = '';
      if (q.candidateId) {
        params.push(q.candidateId);
        where = 'where l.candidate_id = $1';
      }
      const total = await db.query<{ n: number }>(`select count(*)::int as n from message_log l ${where}`, params);
      params.push(q.pageSize, (q.page - 1) * q.pageSize);
      const { rows } = await db.query(
        `select l.id, l.template_key as "templateKey", l.candidate_id as "candidateId", c.full_name as "candidateName",
                l.to_address as "to", l.subject, l.ok, l.error, l.sent_at as "sentAt"
           from message_log l join candidates c on c.id = l.candidate_id ${where}
          order by l.sent_at desc limit $${params.length - 1} offset $${params.length}`,
        params,
      );
      return { items: rows, total: total.rows[0]!.n, page: q.page, pageSize: q.pageSize };
    });
  });

  /** Descadastro pelo link do e-mail (público; resposta sempre igual). */
  app.post('/api/public/unsubscribe', { config: { public: true } }, async (req) => {
    const body = parse(z.object({ token: z.string().regex(/^[0-9a-f]{64}$/) }).strict(), req.body);
    await deps.limiters.tokenIp.consume(`ip:${req.ip}`);
    await deps.pools.owner.query(
      'update candidates set email_opt_out_at = coalesce(email_opt_out_at, now()) where unsubscribe_token = $1',
      [body.token],
    );
    return { ok: true };
  });

  // ------------------------------------------------------------------ entrevistas

  const interviewCols = `i.id, i.scheduled_at as "scheduledAt", i.mode, i.location, i.notes, i.status, i.version,
    app.person_label(i.created_by) as "createdByName", i.created_at as "createdAt"`;

  app.get('/api/applications/:id/interviews', async (req) => {
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return asUser(deps, req, async (db) => {
      const a = await db.query('select 1 from applications where id = $1', [id]);
      if (!a.rowCount) throw notFound('Participação não encontrada.');
      const can = await db.query<{ ok: boolean }>('select app.can_schedule($1) as ok', [id]);
      const { rows } = await db.query(`select ${interviewCols} from interviews i where i.application_id = $1 order by i.scheduled_at`, [id]);
      return { items: rows, canSchedule: can.rows[0]!.ok };
    });
  });

  app.post('/api/applications/:id/interviews', async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(
      z
        .object({
          scheduledAt: z.string().datetime({ offset: true, message: 'Data inválida.' }),
          mode: z.enum(modes),
          location: zOptionalText(300),
          notes: zOptionalText(2000),
          notifyCandidate: z.boolean().default(false),
        })
        .strict(),
      req.body,
    );
    const created = await asUser(deps, req, async (db) => {
      const a = await db.query<{ candidate_id: string | null; company_id: string }>(
        `select s.candidate_id, p.company_id from applications a
           join processes p on p.id = a.process_id
           join shared_application_candidates s on s.application_id = a.id where a.id = $1`,
        [id],
      );
      if (!a.rows[0]) throw notFound('Participação não encontrada.');
      const { rows } = await db.query<{ id: string }>(
        `insert into interviews (application_id, scheduled_at, mode, location, notes, created_by)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [id, body.scheduledAt, body.mode, body.location, body.notes, user.id],
      );
      await audit(db, req, 'interview.scheduled', 'interview', rows[0]!.id, a.rows[0].company_id);
      return { id: rows[0]!.id, candidateId: a.rows[0].candidate_id };
    });
    // Aviso ao candidato: somente a equipe Alpha decide comunicar.
    let notified: string | null = null;
    if (body.notifyCandidate && isAlpha(user) && created.candidateId) {
      notified = await sendCandidateMessage(deps, 'entrevista_agendada', {
        candidateId: created.candidateId,
        applicationId: id,
        vars: { data_entrevista: fmtDateTimeBR(new Date(body.scheduledAt)), formato: modeLabel[body.mode], local: body.location ?? 'a confirmar' },
      });
    }
    reply.code(201);
    return { id: created.id, candidateNotified: notified };
  });

  app.patch('/api/interviews/:id', async (req) => {
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(
      z
        .object({
          expectedVersion: z.number().int().positive(),
          status: z.enum(['agendada', 'realizada', 'cancelada']).optional(),
          scheduledAt: z.string().datetime({ offset: true }).optional(),
          notes: zOptionalText(2000).optional(),
        })
        .strict(),
      req.body,
    );
    return asUser(deps, req, async (db) => {
      const r = await db.query(
        `update interviews set status = coalesce($3, status), scheduled_at = coalesce($4::timestamptz, scheduled_at),
                notes = case when $5::boolean then $6 else notes end
          where id = $1 and version = $2`,
        [id, body.expectedVersion, body.status ?? null, body.scheduledAt ?? null, body.notes !== undefined, body.notes ?? null],
      );
      if (!r.rowCount) {
        const exists = await db.query<{ can: boolean }>('select app.can_schedule(application_id) as can from interviews where id = $1', [id]);
        if (!exists.rows[0]) throw notFound();
        if (!exists.rows[0].can) throw forbidden();
        throw staleVersion();
      }
      await audit(db, req, 'interview.updated', 'interview', id, null, { status: body.status });
      return { ok: true };
    });
  });
}
