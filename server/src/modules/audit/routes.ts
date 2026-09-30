import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../lib/context.js';
import { asUser, isAdmin, requireUser } from '../../lib/context.js';
import { forbidden } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { zPage, zUuid } from '../../lib/normalize.js';
import { Where } from '../../lib/sql.js';

export function registerAuditRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/api/audit', async (req) => {
    if (!isAdmin(requireUser(req))) throw forbidden();
    const q = parse(
      zPage.extend({
        action: z.string().max(80).regex(/^[a-z_.]*$/).optional(),
        actorId: zUuid.optional(),
        entityId: z.string().max(80).optional(),
      }),
      req.query,
    );
    return asUser(deps, req, async (db) => {
      const w = new Where();
      if (q.action) w.add("e.action like ? || '%'", q.action);
      if (q.actorId) w.add('e.actor_id = ?', q.actorId);
      if (q.entityId) w.add('e.entity_id = ?', q.entityId);
      const total = await db.query<{ n: number }>(`select count(*)::int as n from audit_events e ${w.clause}`, w.params);
      const lim = w.param(q.pageSize);
      const off = w.param((q.page - 1) * q.pageSize);
      const { rows } = await db.query(
        `select e.id, e.occurred_at as "occurredAt", e.action, e.entity_type as "entityType",
                e.entity_id as "entityId", e.details, host(e.ip) as ip, u.full_name as "actorName",
                c.name as "companyName"
           from audit_events e
           left join users u on u.id = e.actor_id
           left join companies c on c.id = e.company_id
           ${w.clause}
          order by e.occurred_at desc, e.id desc limit ${lim} offset ${off}`,
        w.params,
      );
      return { items: rows, total: total.rows[0]!.n, page: q.page, pageSize: q.pageSize };
    });
  });
}
