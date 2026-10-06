import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Deps, AuthUser } from '../../lib/context.js';
import { requireUser } from '../../lib/context.js';
import { parse } from '../../lib/validate.js';
import { zEmail, zPassword } from '../../lib/normalize.js';
import * as auth from './service.js';
import * as mfa from './mfa.js';

export function sessionCookieName(deps: Deps) {
  return deps.config.secureCookies ? '__Host-as_session' : 'as_session';
}

function setSessionCookie(deps: Deps, reply: FastifyReply, token: string) {
  reply.setCookie(sessionCookieName(deps), token, {
    httpOnly: true,
    secure: deps.config.secureCookies,
    sameSite: 'strict',
    path: '/',
    maxAge: deps.config.SESSION_ABSOLUTE_HOURS * 3600,
  });
}

export function publicUser(u: AuthUser) {
  return { id: u.id, email: u.email, fullName: u.fullName, kind: u.kind, companyId: u.companyId };
}

const zToken = z.string().min(20).max(200);
const zCode = z.string().trim().min(6, 'Informe o código.').max(20);

export function registerAuthRoutes(app: FastifyInstance, deps: Deps) {
  app.post('/api/auth/login', { config: { public: true } }, async (req, reply) => {
    const body = parse(z.object({ email: zEmail, password: z.string().min(1).max(200) }).strict(), req.body);
    const r = await auth.login(deps, body.email, body.password, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    if ('mfaToken' in r) return { mfaRequired: true, mfaToken: r.mfaToken };
    setSessionCookie(deps, reply, r.token);
    return { user: publicUser(r.user), csrfToken: r.user.csrfToken, limits: { maxUploadMb: deps.config.MAX_UPLOAD_MB } };
  });

  // Segunda etapa: código do aplicativo autenticador (6 dígitos) ou de recuperação (XXXX-XXXX).
  app.post('/api/auth/login/mfa', { config: { public: true } }, async (req, reply) => {
    const body = parse(z.object({ mfaToken: zToken, code: zCode }).strict(), req.body);
    const { token, user } = await mfa.completeLogin(deps, body.mfaToken, body.code, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    setSessionCookie(deps, reply, token);
    return { user: publicUser(user), csrfToken: user.csrfToken, limits: { maxUploadMb: deps.config.MAX_UPLOAD_MB } };
  });

  app.get('/api/auth/mfa', async (req) => mfa.mfaStatus(deps, requireUser(req)));

  app.post('/api/auth/mfa/setup', async (req) => {
    const body = parse(z.object({ password: z.string().min(1).max(200) }).strict(), req.body);
    return mfa.startSetup(deps, requireUser(req), body.password);
  });

  app.post('/api/auth/mfa/confirm', async (req) => {
    const body = parse(z.object({ code: zCode }).strict(), req.body);
    return mfa.confirmSetup(deps, requireUser(req), body.code, req.ip);
  });

  app.post('/api/auth/mfa/disable', async (req) => {
    const body = parse(z.object({ password: z.string().min(1).max(200), code: zCode }).strict(), req.body);
    await mfa.disable(deps, requireUser(req), body.password, body.code, req.ip);
    return { ok: true };
  });

  app.post('/api/auth/mfa/recovery-codes', async (req) => {
    const body = parse(z.object({ code: zCode }).strict(), req.body);
    return mfa.regenerateRecovery(deps, requireUser(req), body.code, req.ip);
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const user = requireUser(req);
    await auth.logout(deps, user, req.ip);
    reply.clearCookie(sessionCookieName(deps), { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    const user = requireUser(req);
    return { user: publicUser(user), csrfToken: user.csrfToken, limits: { maxUploadMb: deps.config.MAX_UPLOAD_MB } };
  });

  app.post('/api/auth/password-reset/request', { config: { public: true } }, async (req) => {
    const body = parse(z.object({ email: zEmail }).strict(), req.body);
    await auth.requestPasswordReset(deps, body.email, req.ip);
    if (deps.config.mailMode === 'manual') {
      return {
        ok: true,
        message: 'A redefinição de senha é feita pela administração da Alpha Select. Solicite o link a um administrador.',
      };
    }
    return { ok: true, message: 'Se o e-mail estiver cadastrado e ativo, você receberá as instruções em instantes.' };
  });

  app.post('/api/auth/password-reset/confirm', { config: { public: true } }, async (req) => {
    const body = parse(z.object({ token: zToken, password: zPassword }).strict(), req.body);
    await auth.confirmPasswordReset(deps, body.token, body.password, req.ip);
    return { ok: true };
  });

  app.post('/api/auth/invite/inspect', { config: { public: true } }, async (req) => {
    const body = parse(z.object({ token: zToken }).strict(), req.body);
    return auth.inspectInvite(deps, body.token, req.ip);
  });

  app.post('/api/auth/invite/accept', { config: { public: true } }, async (req) => {
    const body = parse(z.object({ token: zToken, password: zPassword }).strict(), req.body);
    await auth.acceptInvite(deps, body.token, body.password, req.ip);
    return { ok: true };
  });

  app.post('/api/auth/password/change', async (req) => {
    const user = requireUser(req);
    const body = parse(
      z.object({ currentPassword: z.string().min(1).max(200), newPassword: zPassword }).strict(),
      req.body,
    );
    await auth.changePassword(deps, user, body.currentPassword, body.newPassword, req.ip);
    return { ok: true };
  });
}
