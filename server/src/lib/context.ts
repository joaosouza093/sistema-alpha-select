import type { FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { Pools, Db } from './db.js';
import { withUser } from './db.js';
import type { Mailer } from './mailer.js';
import type { FileStorage } from './storage.js';
import type { Limiters } from './rate-limit.js';
import { unauthorized } from './errors.js';

export type UserKind = 'alpha_admin' | 'alpha_staff' | 'client_user' | 'client_manager';

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  kind: UserKind;
  companyId: string | null;
  sessionId: string;
  csrfToken: string;
}

export interface Deps {
  config: Config;
  pools: Pools;
  mailer: Mailer;
  storage: FileStorage;
  limiters: Limiters;
}

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AuthUser;
  }
}

export function requireUser(req: FastifyRequest): AuthUser {
  if (!req.authUser) throw unauthorized();
  return req.authUser;
}

export const isAlpha = (u: AuthUser) => u.kind === 'alpha_admin' || u.kind === 'alpha_staff';
export const isAdmin = (u: AuthUser) => u.kind === 'alpha_admin';

/** Transação com RLS aplicada ao usuário autenticado desta requisição. */
export function asUser<T>(deps: Deps, req: FastifyRequest, fn: (db: Db, user: AuthUser) => Promise<T>): Promise<T> {
  const user = requireUser(req);
  return withUser(deps.pools.app, user.id, (db) => fn(db, user));
}

export async function audit(
  db: Db,
  req: FastifyRequest,
  action: string,
  entityType: string | null,
  entityId: string | null,
  companyId: string | null = null,
  details: Record<string, unknown> = {},
) {
  await db.query('select app.audit($1, $2, $3, $4, $5, $6)', [
    action,
    entityType,
    entityId,
    companyId,
    JSON.stringify(details),
    req.ip ?? null,
  ]);
}
