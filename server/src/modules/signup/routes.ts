import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../lib/context.js';
import { asUser, isAdmin, requireUser } from '../../lib/context.js';
import { forbidden } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { zEmail, zOptionalPhone, zOptionalText, zPassword, zText, zUuid } from '../../lib/normalize.js';
import { approveSignup, emailVerificationEnabled, rejectSignup, requestSignup, verifySignupEmail } from './service.js';

/** CNPJ opcional: só dígitos, com dígitos verificadores válidos. */
export const zOptionalCnpj = z
  .string()
  .nullish()
  .transform((v, ctx) => {
    const d = (v ?? '').replace(/\D/g, '');
    if (!d) return null;
    if (!validCnpj(d)) {
      ctx.addIssue({ code: 'custom', message: 'CNPJ inválido.' });
      return z.NEVER;
    }
    return d;
  });

export function validCnpj(d: string) {
  if (!/^\d{14}$/.test(d) || /^(\d)\1{13}$/.test(d)) return false;
  const calc = (len: number) => {
    const w = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = w.reduce((acc, wi, i) => acc + Number(d[i]) * wi, 0);
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(d[12]) && calc(13) === Number(d[13]);
}

const zToken = z.string().min(20).max(200);

export function registerSignupRoutes(app: FastifyInstance, deps: Deps) {
  /** Informações públicas para as telas de acesso (sem dados sensíveis). */
  app.get('/api/auth/options', { config: { public: true } }, async () => ({
    emailEnabled: emailVerificationEnabled(deps),
  }));

  app.post('/api/auth/signup', { config: { public: true } }, async (req) => {
    const body = parse(
      z
        .object({
          companyName: zText(2, 160),
          cnpj: zOptionalCnpj,
          fullName: zText(2, 120),
          email: zEmail,
          phone: zOptionalPhone,
          acceptTerms: z.literal(true, { message: 'É necessário aceitar o uso dos dados para o cadastro.' }),
        })
        .strict(),
      req.body,
    );
    await requestSignup(deps, body, req.ip);
    return {
      ok: true,
      message: emailVerificationEnabled(deps)
        ? 'Cadastro recebido. Enviamos um link para o seu e-mail: abra-o para confirmar e criar sua senha. Depois, a Alpha Select analisa e libera o acesso.'
        : 'Cadastro recebido. A equipe da Alpha Select vai analisar e entrar em contato para liberar o acesso.',
    };
  });

  app.post('/api/auth/signup/verify', { config: { public: true } }, async (req) => {
    const body = parse(z.object({ token: zToken, password: zPassword }).strict(), req.body);
    await verifySignupEmail(deps, body.token, body.password, req.ip);
    return { ok: true };
  });

  // ------------------------------------------------------------------
  // Administração
  // ------------------------------------------------------------------
  const adminOnly = (req: Parameters<typeof requireUser>[0]) => {
    const u = requireUser(req);
    if (!isAdmin(u)) throw forbidden();
    return u;
  };

  app.get('/api/signups', async (req) => {
    adminOnly(req);
    const q = parse(z.object({ status: z.enum(['pendente', 'aprovado', 'recusado']).default('pendente') }), req.query);
    return asUser(deps, req, async (db) => {
      const { rows } = await db.query(
        `select s.id, s.company_name as "companyName", s.cnpj, s.full_name as "fullName", s.email, s.phone,
                s.status, s.email_verified_at as "emailVerifiedAt", s.created_at as "createdAt",
                s.decided_at as "decidedAt", s.decision_note as "decisionNote", s.company_id as "companyId",
                d.full_name as "decidedByName",
                (select c.id from companies c
                  where lower(btrim(c.name)) = lower(btrim(s.company_name)) or (s.cnpj is not null and c.cnpj = s.cnpj)
                  limit 1) as "matchingCompanyId"
           from signup_requests s
           left join users d on d.id = s.decided_by
          where s.status = $1
          order by s.created_at desc
          limit 200`,
        [q.status],
      );
      const pending = await db.query<{ n: number }>(
        "select count(*)::int as n from signup_requests where status = 'pendente'",
      );
      return { items: rows, pendingCount: pending.rows[0]!.n, emailVerification: emailVerificationEnabled(deps) };
    });
  });

  app.post('/api/signups/:id/approve', async (req) => {
    const admin = adminOnly(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(
      z
        .object({
          kind: z.enum(['client_user', 'client_manager']).default('client_user'),
          companyId: zUuid.nullish().transform((v) => v ?? null),
        })
        .strict(),
      req.body,
    );
    return approveSignup(deps, admin.id, id, body, req.ip);
  });

  app.post('/api/signups/:id/reject', async (req) => {
    const admin = adminOnly(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(z.object({ note: zOptionalText(500) }).strict(), req.body);
    await rejectSignup(deps, admin.id, id, body.note, req.ip);
    return { ok: true };
  });
}
