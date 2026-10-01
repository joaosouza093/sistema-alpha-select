import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../lib/context.js';
import { asUser, audit, isAdmin, requireUser } from '../../lib/context.js';
import { withTx } from '../../lib/db.js';
import { forbidden, notFound, conflict } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { Where } from '../../lib/sql.js';
import { likePattern, zEmail, zPage, zText, zUuid } from '../../lib/normalize.js';
import {
  ADMIN_RESET_TTL_MINUTES,
  INVITE_TTL_HOURS,
  createInvite,
  createResetToken,
  inviteLink,
  resetLink,
  revokeSessions,
  sendInviteEmail,
} from '../auth/service.js';

const kinds = ['alpha_admin', 'alpha_staff', 'client_user', 'client_manager'] as const;

const userCols = `u.id, u.email, u.full_name as "fullName", u.kind, u.company_id as "companyId",
  co.name as "companyName", u.is_active as "isActive", u.created_at as "createdAt",
  u.last_login_at as "lastLoginAt", app.user_access_status(u.id) as "accessStatus"`;

export function registerUserRoutes(app: FastifyInstance, deps: Deps) {
  /**
   * Com SMTP, o convite vai por e-mail. No modo manual, o link é devolvido
   * SOMENTE ao administrador que o gerou (nunca registrado em log/auditoria).
   */
  async function deliverInvite(email: string, name: string, token: string) {
    if (deps.config.mailMode === 'manual') {
      return { inviteLink: inviteLink(deps, token), validHours: INVITE_TTL_HOURS };
    }
    await sendInviteEmail(deps, email, name, token);
    return {};
  }

  const adminOnly = (req: Parameters<typeof requireUser>[0]) => {
    if (!isAdmin(requireUser(req))) throw forbidden();
  };

  app.get('/api/users', async (req) => {
    const q = parse(
      zPage.extend({
        q: z.string().max(100).optional(),
        companyId: zUuid.optional(),
        kind: z.enum(kinds).optional(),
        scope: z.enum(['alpha', 'client']).optional(),
        active: z.enum(['true', 'false']).optional(),
      }),
      req.query,
    );
    return asUser(deps, req, async (db) => {
      const w = new Where();
      if (q.q) w.add('(u.full_name ilike ? or u.email::text ilike ?)', likePattern(q.q));
      if (q.companyId) w.add('u.company_id = ?', q.companyId);
      if (q.kind) w.add('u.kind = ?', q.kind);
      if (q.scope === 'alpha') w.raw("u.kind in ('alpha_admin','alpha_staff')");
      if (q.scope === 'client') w.raw("u.kind in ('client_user','client_manager')");
      if (q.active) w.add('u.is_active = ?', q.active === 'true');
      const total = await db.query<{ n: number }>(`select count(*)::int as n from users u ${w.clause}`, w.params);
      const lim = w.param(q.pageSize);
      const off = w.param((q.page - 1) * q.pageSize);
      const { rows } = await db.query(
        `select ${userCols} from users u left join companies co on co.id = u.company_id ${w.clause}
         order by u.is_active desc, u.full_name limit ${lim} offset ${off}`,
        w.params,
      );
      return { items: rows, total: total.rows[0]!.n, page: q.page, pageSize: q.pageSize };
    });
  });

  app.post('/api/users', async (req, reply) => {
    adminOnly(req);
    const body = parse(
      z
        .object({
          email: zEmail,
          fullName: zText(2, 120),
          kind: z.enum(kinds),
          companyId: zUuid.nullish(),
          sendInvite: z.boolean().default(true),
        })
        .strict()
        .refine((b) => (b.kind.startsWith('client') ? !!b.companyId : !b.companyId), {
          message: 'Usuários de cliente exigem empresa; usuários da Alpha Select não podem ter empresa.',
          path: ['companyId'],
        }),
      req.body,
    );
    await deps.limiters.invite.consume(`u:${requireUser(req).id}`);
    const created = await asUser(deps, req, async (db) => {
      const exists = await db.query('select 1 from users where email = $1', [body.email]);
      if (exists.rowCount) throw conflict('Já existe um usuário com este e-mail.');
      const { rows } = await db.query<{ id: string }>(
        `insert into users (email, full_name, kind, company_id) values ($1, $2, $3, $4) returning id`,
        [body.email, body.fullName, body.kind, body.companyId ?? null],
      );
      const id = rows[0]!.id;
      await audit(db, req, 'user.created', 'user', id, body.companyId ?? null, { kind: body.kind });
      return id;
    });
    reply.code(201);
    if (!body.sendInvite) return { id: created };
    const token = await withTx(deps.pools.owner, (db) => createInvite(deps, db, created, requireUser(req).id));
    return { id: created, ...(await deliverInvite(body.email, body.fullName, token)) };
  });

  app.get('/api/users/:id', async (req) => {
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return asUser(deps, req, async (db) => {
      const { rows } = await db.query(
        `select ${userCols} from users u left join companies co on co.id = u.company_id where u.id = $1`,
        [id],
      );
      if (!rows[0]) throw notFound();
      return rows[0];
    });
  });

  app.patch('/api/users/:id', async (req) => {
    adminOnly(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(
      z
        .object({
          fullName: zText(2, 120).optional(),
          isActive: z.boolean().optional(),
          kind: z.enum(kinds).optional(),
          companyId: zUuid.nullish(),
        })
        .strict(),
      req.body,
    );
    const result = await asUser(deps, req, async (db) => {
      const cur = await db.query<{ kind: string; company_id: string | null; is_active: boolean }>(
        'select kind, company_id, is_active from users where id = $1',
        [id],
      );
      const c = cur.rows[0];
      if (!c) throw notFound();
      const kind = body.kind ?? c.kind;
      const companyId = body.companyId !== undefined ? body.companyId : c.company_id;
      await db.query(
        `update users set full_name = coalesce($2, full_name), is_active = coalesce($3, is_active),
                kind = $4, company_id = $5 where id = $1`,
        [id, body.fullName ?? null, body.isActive ?? null, kind, companyId],
      );
      await audit(db, req, 'user.updated', 'user', id, companyId, {
        fields: Object.keys(body),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
        ...(body.kind ? { kind } : {}),
      });
      return { deactivated: body.isActive === false && c.is_active };
    });
    if (result.deactivated) {
      // Revogação imediata: além da checagem de "ativo" a cada requisição, remove as sessões abertas.
      await withTx(deps.pools.owner, (db) => revokeSessions(db, id));
    }
    return { ok: true };
  });

  app.post('/api/users/:id/invite', async (req) => {
    adminOnly(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    await deps.limiters.invite.consume(`u:${requireUser(req).id}`);
    const target = await asUser(deps, req, async (db) => {
      const { rows } = await db.query<{ email: string; full_name: string; is_active: boolean; status: string }>(
        `select email, full_name, is_active, app.user_access_status(id) as status from users where id = $1`,
        [id],
      );
      const u = rows[0];
      if (!u) throw notFound();
      if (!u.is_active) throw conflict('Reative o usuário antes de reenviar o convite.');
      if (u.status === 'senha_definida')
        throw conflict('Este usuário já definiu senha. Use "Link de redefinição" ou oriente-o a usar "Esqueci minha senha".');
      await audit(db, req, 'user.invite_sent', 'user', id);
      return u;
    });
    const token = await withTx(deps.pools.owner, (db) => createInvite(deps, db, id, requireUser(req).id));
    return { ok: true, ...(await deliverInvite(target.email, target.full_name, token)) };
  });

  /**
   * Link de redefinição gerado pelo administrador (necessário quando não há
   * SMTP). O link é exibido uma única vez ao administrador, que o entrega por
   * canal seguro. Sessões da pessoa continuam até ela redefinir a senha.
   */
  app.post('/api/users/:id/password-reset-link', async (req) => {
    adminOnly(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    await deps.limiters.invite.consume(`u:${requireUser(req).id}`);
    await asUser(deps, req, async (db) => {
      const { rows } = await db.query<{ is_active: boolean; status: string }>(
        'select is_active, app.user_access_status(id) as status from users where id = $1',
        [id],
      );
      const u = rows[0];
      if (!u) throw notFound();
      if (!u.is_active) throw conflict('Reative o usuário antes de gerar o link.');
      if (u.status !== 'senha_definida') throw conflict('Este usuário ainda não aceitou o convite. Reenvie o convite.');
      await audit(db, req, 'user.password_reset_link', 'user', id);
    });
    const token = await withTx(deps.pools.owner, (db) => createResetToken(db, id, ADMIN_RESET_TTL_MINUTES));
    return { link: resetLink(deps, token), validHours: ADMIN_RESET_TTL_MINUTES / 60 };
  });
}
