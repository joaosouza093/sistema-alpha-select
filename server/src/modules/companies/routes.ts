import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../lib/context.js';
import { asUser, audit, isAdmin, requireUser } from '../../lib/context.js';
import { withTx } from '../../lib/db.js';
import { forbidden, notFound } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { zOptionalEmail, zText, zUuid } from '../../lib/normalize.js';
import { zOptionalCnpj } from '../signup/routes.js';

export function registerCompanyRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/api/companies', async (req) => {
    return asUser(deps, req, async (db) => {
      const { rows } = await db.query(
        `select c.id, c.name, c.is_active as "isActive", c.created_at as "createdAt",
                c.cnpj, c.billing_email as "billingEmail",
                (select count(*)::int from processes p where p.company_id = c.id) as "processCount",
                (select count(*)::int from users u where u.company_id = c.id and u.is_active) as "activeUsers"
           from companies c order by c.is_active desc, c.name`,
      );
      return { items: rows };
    });
  });

  app.get('/api/companies/:id', async (req) => {
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return asUser(deps, req, async (db) => {
      const { rows } = await db.query(
        `select id, name, is_active as "isActive", created_at as "createdAt", cnpj, billing_email as "billingEmail"
           from companies where id = $1`,
        [id],
      );
      if (!rows[0]) throw notFound();
      return rows[0];
    });
  });

  app.post('/api/companies', async (req, reply) => {
    if (!isAdmin(requireUser(req))) throw forbidden();
    const body = parse(
      z.object({ name: zText(2, 160), cnpj: zOptionalCnpj, billingEmail: zOptionalEmail }).strict(),
      req.body,
    );
    const id = await asUser(deps, req, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        'insert into companies (name, cnpj, billing_email) values ($1, $2, $3) returning id',
        [body.name, body.cnpj, body.billingEmail],
      );
      await audit(db, req, 'company.created', 'company', rows[0]!.id, rows[0]!.id);
      return rows[0]!.id;
    });
    reply.code(201);
    return { id };
  });

  app.patch('/api/companies/:id', async (req) => {
    if (!isAdmin(requireUser(req))) throw forbidden();
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(
      z
        .object({
          name: zText(2, 160).optional(),
          isActive: z.boolean().optional(),
          cnpj: zOptionalCnpj.optional(),
          billingEmail: zOptionalEmail.optional(),
        })
        .strict(),
      req.body,
    );
    const deactivated = await asUser(deps, req, async (db) => {
      const cur = await db.query<{ is_active: boolean }>('select is_active from companies where id = $1', [id]);
      if (!cur.rows[0]) throw notFound();
      await db.query(
        `update companies set name = coalesce($2, name), is_active = coalesce($3, is_active),
                cnpj = case when $4::boolean then $5 else cnpj end,
                billing_email = case when $6::boolean then $7 else billing_email end
          where id = $1`,
        [id, body.name ?? null, body.isActive ?? null, body.cnpj !== undefined, body.cnpj ?? null,
          body.billingEmail !== undefined, body.billingEmail ?? null],
      );
      await audit(db, req, 'company.updated', 'company', id, id, { fields: Object.keys(body), isActive: body.isActive });
      return body.isActive === false && cur.rows[0].is_active;
    });
    if (deactivated) {
      await withTx(deps.pools.owner, (db) =>
        db.query('delete from sessions where user_id in (select id from users where company_id = $1)', [id]),
      );
    }
    return { ok: true };
  });
}
