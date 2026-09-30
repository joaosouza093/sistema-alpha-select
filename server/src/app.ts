import path from 'node:path';
import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import type { Deps } from './lib/context.js';
import { AppError, forbidden, fromPgError, unauthorized } from './lib/errors.js';
import { ValidationError } from './lib/validate.js';
import { safeEqual } from './lib/crypto.js';
import { resolveSession } from './modules/auth/service.js';
import { registerAuthRoutes, sessionCookieName } from './modules/auth/routes.js';
import { registerUserRoutes } from './modules/users/routes.js';
import { registerCompanyRoutes } from './modules/companies/routes.js';
import { registerProcessRoutes } from './modules/processes/routes.js';
import { registerCandidateRoutes } from './modules/candidates/routes.js';
import { registerApplicationRoutes } from './modules/applications/routes.js';
import { registerDocumentRoutes } from './modules/documents/routes.js';
import { registerDashboardRoutes } from './modules/dashboard/routes.js';
import { registerAuditRoutes } from './modules/audit/routes.js';

z.config(z.locales.pt());

declare module 'fastify' {
  interface FastifyContextConfig {
    public?: boolean;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function buildApp(deps: Deps): Promise<FastifyInstance> {
  const { config } = deps;
  const app = Fastify({
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 256 * 1024,
    logger:
      config.LOG_LEVEL === 'silent'
        ? false
        : {
            level: config.LOG_LEVEL,
            // Nunca registrar cookies, cabeçalhos de autenticação, corpos ou query strings.
            serializers: {
              req: (req) => ({ method: req.method, url: req.url.split('?')[0], id: req.id }),
              res: (res) => ({ statusCode: res.statusCode }),
            },
          },
  });

  await app.register(cookie);
  await app.register(multipart, { throwFileSizeLimit: false });
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        frameSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'self'"],
        ...(config.secureCookies ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: config.secureCookies ? { maxAge: 31536000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'no-referrer' },
  });

  // CORS: por padrão, somente mesma origem. Origens extras só por configuração explícita.
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (!origin) return;
    const self = new URL(config.APP_URL).origin;
    const allowed = origin === self || config.corsOrigins.includes(origin);
    if (!allowed) {
      if (req.url.startsWith('/api/')) throw forbidden('Origem não permitida.');
      return;
    }
    if (origin !== self) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Access-Control-Allow-Credentials', 'true');
      reply.header('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE');
        reply.header('Access-Control-Allow-Headers', 'Content-Type,X-CSRF-Token');
        return reply.code(204).send();
      }
    }
  });

  // Autenticação e CSRF para toda a API.
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Robots-Tag', 'noindex, nofollow');
    const isPublic = req.routeOptions.config?.public === true;
    const token = req.cookies[sessionCookieName(deps)];
    if (token) {
      const user = await resolveSession(deps, token);
      if (user) req.authUser = user;
    }
    if (isPublic) return;
    if (!req.authUser) throw unauthorized();
    if (!SAFE_METHODS.has(req.method)) {
      const header = req.headers['x-csrf-token'];
      if (typeof header !== 'string' || !safeEqual(header, req.authUser.csrfToken)) {
        throw forbidden('Falha de verificação de segurança (CSRF). Recarregue a página.');
      }
    }
  });

  app.setErrorHandler((err, req, reply) => {
    let e: AppError | null = err instanceof AppError ? err : fromPgError(err);
    const fe = err as { statusCode?: number; code?: string };
    if (!e && fe.statusCode === 413) e = new AppError(413, 'too_large', 'Conteúdo acima do limite permitido.');
    if (!e && fe.statusCode === 415) e = new AppError(415, 'unsupported', 'Tipo de conteúdo não suportado.');
    if (!e && fe.statusCode === 400) e = new AppError(400, 'bad_request', 'Requisição inválida.');
    if (!e && fe.statusCode === 406) e = new AppError(406, 'bad_request', 'Requisição inválida.');
    if (!e) {
      req.log.error({ err: { message: (err as Error).message, code: fe.code } }, 'erro não tratado');
      e = new AppError(500, 'internal', 'Erro interno. Tente novamente em instantes.');
    }
    const payload: Record<string, unknown> = { code: e.code, message: e.message };
    if (e instanceof ValidationError) payload.fields = e.fields;
    const extra = (err as { extra?: unknown }).extra;
    if (extra) payload.details = extra;
    reply.header('Cache-Control', 'no-store');
    return reply.code(e.status).send({ error: payload });
  });

  registerAuthRoutes(app, deps);
  registerUserRoutes(app, deps);
  registerCompanyRoutes(app, deps);
  registerProcessRoutes(app, deps);
  registerCandidateRoutes(app, deps);
  registerApplicationRoutes(app, deps);
  registerDocumentRoutes(app, deps);
  registerDashboardRoutes(app, deps);
  registerAuditRoutes(app, deps);

  app.get('/api/health', { config: { public: true } }, async () => ({ ok: true }));

  // Frontend compilado (homologação/produção).
  const webDir = config.WEB_DIST_DIR ? path.resolve(config.WEB_DIST_DIR) : null;
  if (webDir && existsSync(webDir)) {
    await app.register(fastifyStatic, {
      root: webDir,
      wildcard: false,
      setHeaders: (res, filePath) => {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.header('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          res.header('Cache-Control', 'no-cache');
        }
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.method !== 'GET') {
        return reply.code(404).send({ error: { code: 'not_found', message: 'Recurso não encontrado.' } });
      }
      reply.header('Cache-Control', 'no-cache');
      return reply.sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((_req, reply) =>
      reply.code(404).send({ error: { code: 'not_found', message: 'Recurso não encontrado.' } }),
    );
  }

  return app;
}
