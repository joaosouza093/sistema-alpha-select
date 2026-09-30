import type { Deps, AuthUser, UserKind } from '../../lib/context.js';
import { withTx, type Db } from '../../lib/db.js';
import { DUMMY_HASH, hashPassword, newToken, sha256, verifyPassword } from '../../lib/crypto.js';
import { AppError, badRequest } from '../../lib/errors.js';

export const INVITE_TTL_HOURS = 72;
export const RESET_TTL_MINUTES = 60;
const MAX_FAILED = 8;
const LOCK_MINUTES = 15;

const GENERIC_LOGIN_ERROR = new AppError(401, 'invalid_credentials', 'E-mail ou senha inválidos.');

interface SessionRow {
  session_id: string;
  csrf_token: string;
  user_id: string;
  email: string;
  full_name: string;
  kind: UserKind;
  company_id: string | null;
  last_seen_at: Date;
}

/** Valida a sessão a cada requisição: usuário e empresa precisam continuar ativos. */
export async function resolveSession(deps: Deps, token: string): Promise<AuthUser | null> {
  const { config, pools } = deps;
  const { rows } = await pools.owner.query<SessionRow>(
    `select s.id as session_id, s.csrf_token, s.last_seen_at,
            u.id as user_id, u.email, u.full_name, u.kind, u.company_id
       from sessions s
       join users u on u.id = s.user_id
       left join companies c on c.id = u.company_id
      where s.token_hash = $1
        and s.expires_at > now()
        and s.last_seen_at > now() - make_interval(mins => $2)
        and u.is_active
        and (u.company_id is null or c.is_active)`,
    [sha256(token), config.SESSION_IDLE_MINUTES],
  );
  const r = rows[0];
  if (!r) return null;
  if (Date.now() - r.last_seen_at.getTime() > 60_000) {
    await pools.owner.query('update sessions set last_seen_at = now() where id = $1', [r.session_id]);
  }
  return {
    id: r.user_id,
    email: r.email,
    fullName: r.full_name,
    kind: r.kind,
    companyId: r.company_id,
    sessionId: r.session_id,
    csrfToken: r.csrf_token,
  };
}

export async function login(
  deps: Deps,
  email: string,
  password: string,
  meta: { ip: string; userAgent: string | undefined },
): Promise<{ token: string; user: AuthUser }> {
  const { pools, limiters, config } = deps;
  limiters.loginIp.consume(`ip:${meta.ip}`);
  limiters.loginAccount.consume(`acc:${email}`);

  const { rows } = await pools.owner.query<{
    id: string;
    email: string;
    full_name: string;
    kind: UserKind;
    company_id: string | null;
    active: boolean;
    password_hash: string | null;
    locked_until: Date | null;
  }>(
    `select u.id, u.email, u.full_name, u.kind, u.company_id,
            (u.is_active and (u.company_id is null or c.is_active)) as active,
            cr.password_hash, cr.locked_until
       from users u
       left join companies c on c.id = u.company_id
       left join user_credentials cr on cr.user_id = u.id
      where u.email = $1`,
    [email],
  );
  const u = rows[0];
  const ok = await verifyPassword(password, u?.password_hash ?? DUMMY_HASH);

  if (!u || !u.password_hash) throw GENERIC_LOGIN_ERROR;

  if (u.locked_until && u.locked_until.getTime() > Date.now()) {
    await auditOwner(deps, u.id, 'auth.login_blocked_locked', meta.ip);
    throw new AppError(429, 'locked', 'Acesso temporariamente bloqueado por excesso de tentativas. Tente mais tarde.');
  }

  if (!ok) {
    await pools.owner.query(
      `update user_credentials
          set failed_attempts = failed_attempts + 1,
              locked_until = case when failed_attempts + 1 >= $2 then now() + make_interval(mins => $3) else locked_until end
        where user_id = $1`,
      [u.id, MAX_FAILED, LOCK_MINUTES],
    );
    await auditOwner(deps, u.id, 'auth.login_failed', meta.ip);
    throw GENERIC_LOGIN_ERROR;
  }

  if (!u.active) {
    await auditOwner(deps, u.id, 'auth.login_blocked_inactive', meta.ip);
    throw new AppError(403, 'inactive', 'Seu acesso está desativado. Procure o administrador da Alpha Select.');
  }

  limiters.loginAccount.reset(`acc:${email}`);
  const token = newToken();
  const csrf = newToken();
  const session = await withTx(pools.owner, async (db) => {
    await db.query('update user_credentials set failed_attempts = 0, locked_until = null where user_id = $1', [u.id]);
    await db.query('update users set last_login_at = now() where id = $1', [u.id]);
    const s = await db.query<{ id: string }>(
      `insert into sessions (token_hash, csrf_token, user_id, expires_at, user_agent, ip)
       values ($1, $2, $3, now() + make_interval(hours => $4), $5, $6) returning id`,
      [sha256(token), csrf, u.id, config.SESSION_ABSOLUTE_HOURS, meta.userAgent?.slice(0, 200) ?? null, meta.ip],
    );
    await insertAudit(db, u.id, 'auth.login', 'user', u.id, meta.ip);
    return s.rows[0]!;
  });

  return {
    token,
    user: {
      id: u.id,
      email: u.email,
      fullName: u.full_name,
      kind: u.kind,
      companyId: u.company_id,
      sessionId: session.id,
      csrfToken: csrf,
    },
  };
}

export async function logout(deps: Deps, user: AuthUser, ip: string) {
  await withTx(deps.pools.owner, async (db) => {
    await db.query('delete from sessions where id = $1', [user.sessionId]);
    await insertAudit(db, user.id, 'auth.logout', 'user', user.id, ip);
  });
}

/** Encerra todas as sessões do usuário (desativação, troca/redefinição de senha). */
export async function revokeSessions(db: Db, userId: string, exceptSessionId?: string) {
  await db.query('delete from sessions where user_id = $1 and ($2::uuid is null or id <> $2)', [
    userId,
    exceptSessionId ?? null,
  ]);
}

// ---------------------------------------------------------------------------
// Convites
// ---------------------------------------------------------------------------

/** Cria convite de uso único. O perfil já está definido no registro do usuário pelo servidor. */
export async function createInvite(deps: Deps, db: Db, userId: string, createdBy: string | null) {
  const token = newToken();
  await db.query('update invites set revoked_at = now() where user_id = $1 and used_at is null and revoked_at is null', [
    userId,
  ]);
  await db.query(
    `insert into invites (token_hash, user_id, created_by, expires_at)
     values ($1, $2, $3, now() + make_interval(hours => $4))`,
    [sha256(token), userId, createdBy, INVITE_TTL_HOURS],
  );
  return token;
}

export function inviteLink(deps: Deps, token: string) {
  // Token no fragmento (#): não é enviado ao servidor em requisições nem gravado em logs de acesso.
  return `${deps.config.APP_URL.replace(/\/$/, '')}/convite#token=${token}`;
}

export async function sendInviteEmail(deps: Deps, to: string, name: string, token: string) {
  await deps.mailer.send({
    to,
    subject: 'Convite de acesso — Alpha Select',
    text:
      `Olá, ${name}.\n\nVocê recebeu um convite para acessar o sistema de processos seletivos da Alpha Select.\n` +
      `Para definir sua senha, acesse o link abaixo (válido por ${INVITE_TTL_HOURS} horas, uso único):\n\n` +
      `${inviteLink(deps, token)}\n\nSe você não esperava este convite, ignore esta mensagem.`,
  });
}

async function findValidInvite(db: Db, token: string) {
  const { rows } = await db.query<{ id: string; user_id: string; email: string; full_name: string }>(
    `select i.id, i.user_id, u.email, u.full_name
       from invites i join users u on u.id = i.user_id
       left join companies c on c.id = u.company_id
      where i.token_hash = $1 and i.used_at is null and i.revoked_at is null
        and i.expires_at > now() and u.is_active and (u.company_id is null or c.is_active)
      for update of i`,
    [sha256(token)],
  );
  return rows[0] ?? null;
}

const INVALID_INVITE = badRequest('Convite inválido, expirado ou já utilizado. Solicite um novo convite.');

export async function inspectInvite(deps: Deps, token: string, ip: string) {
  deps.limiters.tokenIp.consume(`ip:${ip}`);
  return withTx(deps.pools.owner, async (db) => {
    const inv = await findValidInvite(db, token);
    if (!inv) throw INVALID_INVITE;
    return { email: inv.email, fullName: inv.full_name };
  });
}

export async function acceptInvite(deps: Deps, token: string, password: string, ip: string) {
  deps.limiters.tokenIp.consume(`ip:${ip}`);
  const hash = await hashPassword(password);
  await withTx(deps.pools.owner, async (db) => {
    const inv = await findValidInvite(db, token);
    if (!inv) throw INVALID_INVITE;
    const existing = await db.query('select 1 from user_credentials where user_id = $1', [inv.user_id]);
    if (existing.rowCount) throw INVALID_INVITE;
    await db.query('update invites set used_at = now() where id = $1', [inv.id]);
    await db.query('insert into user_credentials (user_id, password_hash) values ($1, $2)', [inv.user_id, hash]);
    await insertAudit(db, inv.user_id, 'auth.invite_accepted', 'user', inv.user_id, ip);
  });
}

// ---------------------------------------------------------------------------
// Recuperação e troca de senha
// ---------------------------------------------------------------------------

export async function requestPasswordReset(deps: Deps, email: string, ip: string) {
  deps.limiters.resetIp.consume(`ip:${ip}`);
  try {
    deps.limiters.resetAccount.consume(`acc:${email}`);
  } catch {
    return; // resposta idêntica para não revelar existência da conta
  }
  const token = newToken();
  const target = await withTx(deps.pools.owner, async (db) => {
    const { rows } = await db.query<{ id: string; full_name: string }>(
      `select u.id, u.full_name from users u
         join user_credentials cr on cr.user_id = u.id
         left join companies c on c.id = u.company_id
        where u.email = $1 and u.is_active and (u.company_id is null or c.is_active)`,
      [email],
    );
    const u = rows[0];
    if (!u) return null;
    await db.query('update password_resets set used_at = now() where user_id = $1 and used_at is null', [u.id]);
    await db.query(
      `insert into password_resets (token_hash, user_id, expires_at)
       values ($1, $2, now() + make_interval(mins => $3))`,
      [sha256(token), u.id, RESET_TTL_MINUTES],
    );
    await insertAudit(db, u.id, 'auth.password_reset_requested', 'user', u.id, ip);
    return u;
  });
  if (!target) return;
  const link = `${deps.config.APP_URL.replace(/\/$/, '')}/redefinir-senha#token=${token}`;
  await deps.mailer.send({
    to: email,
    subject: 'Redefinição de senha — Alpha Select',
    text:
      `Olá, ${target.full_name}.\n\nRecebemos um pedido para redefinir sua senha. ` +
      `Use o link abaixo em até ${RESET_TTL_MINUTES} minutos (uso único):\n\n${link}\n\n` +
      'Se você não fez este pedido, ignore esta mensagem; sua senha continua a mesma.',
  });
}

export async function confirmPasswordReset(deps: Deps, token: string, password: string, ip: string) {
  deps.limiters.tokenIp.consume(`ip:${ip}`);
  const hash = await hashPassword(password);
  await withTx(deps.pools.owner, async (db) => {
    const { rows } = await db.query<{ id: string; user_id: string }>(
      `select r.id, r.user_id from password_resets r join users u on u.id = r.user_id
        where r.token_hash = $1 and r.used_at is null and r.expires_at > now() and u.is_active
        for update of r`,
      [sha256(token)],
    );
    const r = rows[0];
    if (!r) throw badRequest('Link inválido, expirado ou já utilizado. Solicite uma nova recuperação.');
    await db.query('update password_resets set used_at = now() where id = $1', [r.id]);
    await db.query(
      `update user_credentials set password_hash = $2, password_changed_at = now(),
              failed_attempts = 0, locked_until = null where user_id = $1`,
      [r.user_id, hash],
    );
    await revokeSessions(db, r.user_id);
    await insertAudit(db, r.user_id, 'auth.password_reset', 'user', r.user_id, ip);
  });
}

export async function changePassword(deps: Deps, user: AuthUser, current: string, next: string, ip: string) {
  deps.limiters.loginAccount.consume(`chg:${user.id}`);
  const { rows } = await deps.pools.owner.query<{ password_hash: string }>(
    'select password_hash from user_credentials where user_id = $1',
    [user.id],
  );
  const ok = rows[0] && (await verifyPassword(current, rows[0].password_hash));
  if (!ok) throw new AppError(422, 'invalid', 'Senha atual incorreta.');
  const hash = await hashPassword(next);
  await withTx(deps.pools.owner, async (db) => {
    await db.query('update user_credentials set password_hash = $2, password_changed_at = now() where user_id = $1', [
      user.id,
      hash,
    ]);
    await revokeSessions(db, user.id, user.sessionId);
    await insertAudit(db, user.id, 'auth.password_changed', 'user', user.id, ip);
  });
}

// ---------------------------------------------------------------------------

export async function insertAudit(
  db: Db,
  actorId: string | null,
  action: string,
  entityType: string | null,
  entityId: string | null,
  ip: string | null,
  details: Record<string, unknown> = {},
) {
  await db.query(
    `insert into audit_events (actor_id, action, entity_type, entity_id, details, ip)
     values ($1, $2, $3, $4, $5, $6)`,
    [actorId, action, entityType, entityId, JSON.stringify(details), ip],
  );
}

async function auditOwner(deps: Deps, userId: string, action: string, ip: string) {
  await insertAudit(deps.pools.owner as unknown as Db, userId, action, 'user', userId, ip);
}
