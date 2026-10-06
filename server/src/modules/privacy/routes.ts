import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../lib/context.js';
import { asUser, audit, isAdmin, requireUser } from '../../lib/context.js';
import { forbidden, notFound } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { zUuid } from '../../lib/normalize.js';
import { inactiveWhere, runRetention } from './retention.js';

/** Privacidade (LGPD): regra de retenção do banco de talentos. Somente administradores. */
export function registerPrivacyRoutes(app: FastifyInstance, deps: Deps) {
  const adminOnly = (req: FastifyRequest) => {
    const u = requireUser(req);
    if (!isAdmin(u)) throw forbidden();
    return u;
  };

  const settingsCols = `retention_enabled as "retentionEnabled", retention_months as "retentionMonths",
    notice_days as "noticeDays", updated_at as "updatedAt"`;

  app.get('/api/privacy/retention', async (req) => {
    adminOnly(req);
    return asUser(deps, req, async (db) => {
      const settings = (await db.query(`select ${settingsCols} from privacy_settings`)).rows[0];
      // Prévia: quem recebe aviso na próxima execução e quem está avisado (com data de exclusão).
      const pending = await db.query(
        `select c.id, c.full_name as "fullName", app.candidate_last_activity(c.id) as "lastActivity",
                r.notice_at as "noticeAt", r.notice_sent as "noticeSent",
                r.notice_at + make_interval(days => s.notice_days) as "deleteAfter"
           from candidates c cross join privacy_settings s
           left join candidate_retention r on r.candidate_id = c.id
          where ${inactiveWhere}
          order by r.notice_at nulls last, 3
          limit 200`,
      );
      const count = await db.query<{ n: number }>(
        `select count(*)::int as n from candidates c cross join privacy_settings s where ${inactiveWhere}`,
      );
      const erased = await db.query<{ n: number }>(
        `select count(*)::int as n from audit_events where action = 'candidate.retention_erased' and occurred_at > now() - interval '30 days'`,
      );
      return { settings, candidates: pending.rows, total: count.rows[0]!.n, erasedLast30: erased.rows[0]!.n };
    });
  });

  app.put('/api/privacy/retention', async (req) => {
    adminOnly(req);
    const body = parse(
      z
        .object({
          retentionEnabled: z.boolean(),
          retentionMonths: z.number().int().min(6, 'Mínimo de 6 meses.').max(120, 'Máximo de 120 meses.'),
          noticeDays: z.number().int().min(7, 'Mínimo de 7 dias.').max(90, 'Máximo de 90 dias.'),
        })
        .strict(),
      req.body,
    );
    return asUser(deps, req, async (db, user) => {
      await db.query(
        `update privacy_settings set retention_enabled = $1, retention_months = $2, notice_days = $3,
                updated_at = now(), updated_by = $4`,
        [body.retentionEnabled, body.retentionMonths, body.noticeDays, user.id],
      );
      await audit(db, req, 'privacy.retention_updated', null, null, null, body);
      return { ok: true };
    });
  });

  /** "Manter": conta como atividade e cancela o aviso. */
  app.post('/api/privacy/retention/:id/keep', async (req) => {
    adminOnly(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return asUser(deps, req, async (db, user) => {
      const c = await db.query('select 1 from candidates where id = $1', [id]);
      if (!c.rowCount) throw notFound('Candidato não encontrado.');
      await db.query(
        `insert into candidate_retention (candidate_id, kept_at, kept_by) values ($1, now(), $2)
         on conflict (candidate_id) do update set kept_at = now(), kept_by = $2, notice_at = null, notice_sent = false`,
        [id, user.id],
      );
      await audit(db, req, 'candidate.retention_kept', 'candidate', id);
      return { ok: true };
    });
  });

  /** Executa a regra agora (normalmente roda sozinha a cada hora). */
  app.post('/api/privacy/retention/run', async (req) => {
    adminOnly(req);
    const r = await runRetention(deps);
    await asUser(deps, req, (db) => audit(db, req, 'privacy.retention_run', null, null, null, r));
    return r;
  });
}
