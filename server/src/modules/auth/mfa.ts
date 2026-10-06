import type { AuthUser, Deps, UserKind } from '../../lib/context.js';
import { withTx } from '../../lib/db.js';
import { sha256, verifyPassword } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import { newRecoveryCodes, newTotpSecret, normalizeRecoveryCode, otpauthUrl, verifyTotp } from '../../lib/totp.js';
import { createSession, insertAudit, revokeSessions } from './service.js';

const MAX_CHALLENGE_ATTEMPTS = 5;
const INVALID_CODE = new AppError(422, 'invalid_code', 'Código inválido. Confira o código no aplicativo e tente de novo.');
const EXPIRED = new AppError(401, 'mfa_expired', 'A verificação expirou. Entre novamente com e-mail e senha.');

const hashCode = (c: string) => sha256(`recovery:${normalizeRecoveryCode(c)}`).toString('hex');

async function checkPassword(deps: Deps, userId: string, password: string) {
  await deps.limiters.loginAccount.consume(`mfa:${userId}`);
  const { rows } = await deps.pools.owner.query<{ password_hash: string }>(
    'select password_hash from user_credentials where user_id = $1',
    [userId],
  );
  if (!rows[0] || !(await verifyPassword(password, rows[0].password_hash))) {
    throw new AppError(422, 'invalid', 'Senha atual incorreta.');
  }
}

export async function mfaStatus(deps: Deps, user: AuthUser) {
  const { rows } = await deps.pools.owner.query<{ enabled_at: Date | null; left: number }>(
    'select enabled_at, cardinality(recovery_hashes) as left from user_mfa where user_id = $1',
    [user.id],
  );
  const r = rows[0];
  return { enabled: !!r?.enabled_at, enabledAt: r?.enabled_at ?? null, recoveryCodesLeft: r?.enabled_at ? r.left : 0 };
}

/** Gera um segredo pendente (só vale depois de confirmado com um código). */
export async function startSetup(deps: Deps, user: AuthUser, password: string) {
  await checkPassword(deps, user.id, password);
  const secret = newTotpSecret();
  const r = await deps.pools.owner.query(
    `insert into user_mfa (user_id, secret) values ($1, $2)
     on conflict (user_id) do update set secret = excluded.secret, last_step = null, recovery_hashes = '{}'
       where user_mfa.enabled_at is null`,
    [user.id, secret],
  );
  if (!r.rowCount) throw new AppError(409, 'conflict', 'A verificação em duas etapas já está ativa.');
  return { secret, otpauthUrl: otpauthUrl(secret, user.email) };
}

export async function confirmSetup(deps: Deps, user: AuthUser, code: string, ip: string) {
  await deps.limiters.loginAccount.consume(`mfa:${user.id}`);
  const codes = newRecoveryCodes();
  await withTx(deps.pools.owner, async (db) => {
    const { rows } = await db.query<{ secret: string; enabled_at: Date | null }>(
      'select secret, enabled_at from user_mfa where user_id = $1 for update',
      [user.id],
    );
    const m = rows[0];
    if (!m || m.enabled_at) throw new AppError(409, 'conflict', 'Inicie a configuração novamente.');
    const step = verifyTotp(m.secret, code, null);
    if (step === null) throw INVALID_CODE;
    await db.query('update user_mfa set enabled_at = now(), last_step = $2, recovery_hashes = $3 where user_id = $1', [
      user.id,
      step,
      codes.map(hashCode),
    ]);
    // As outras sessões abertas foram criadas sem o segundo fator.
    await revokeSessions(db, user.id, user.sessionId);
    await insertAudit(db, user.id, 'auth.mfa_enabled', 'user', user.id, ip);
  });
  return { recoveryCodes: codes };
}

/** Confere um código do aplicativo ou de recuperação, consumindo-o. */
async function consumeCode(db: import('../../lib/db.js').Db, userId: string, code: string): Promise<'totp' | 'recovery' | null> {
  const { rows } = await db.query<{ secret: string; last_step: string | null; recovery_hashes: string[] }>(
    'select secret, last_step, recovery_hashes from user_mfa where user_id = $1 and enabled_at is not null for update',
    [userId],
  );
  const m = rows[0];
  if (!m) return null;
  const clean = code.replace(/\s/g, '');
  if (/^\d{6}$/.test(clean)) {
    const step = verifyTotp(m.secret, clean, m.last_step === null ? null : Number(m.last_step));
    if (step === null) return null;
    await db.query('update user_mfa set last_step = $2 where user_id = $1', [userId, step]);
    return 'totp';
  }
  const h = hashCode(clean);
  if (normalizeRecoveryCode(clean).length !== 8 || !m.recovery_hashes.includes(h)) return null;
  await db.query('update user_mfa set recovery_hashes = array_remove(recovery_hashes, $2) where user_id = $1', [userId, h]);
  return 'recovery';
}

/** Segunda etapa do login. */
export async function completeLogin(deps: Deps, mfaToken: string, code: string, meta: { ip: string; userAgent: string | undefined }) {
  await deps.limiters.tokenIp.consume(`ip:${meta.ip}`);
  const result = await withTx(deps.pools.owner, async (db) => {
    const { rows } = await db.query<{
      id: string; user_id: string; attempts: number; email: string; full_name: string; kind: UserKind;
      company_id: string | null; active: boolean;
    }>(
      `select ch.id, ch.user_id, ch.attempts, u.email, u.full_name, u.kind, u.company_id,
              (u.is_active and (u.company_id is null or c.is_active)) as active
         from mfa_challenges ch join users u on u.id = ch.user_id
         left join companies c on c.id = u.company_id
        where ch.token_hash = $1 and ch.expires_at > now()
        for update of ch`,
      [sha256(mfaToken)],
    );
    const ch = rows[0];
    if (!ch || !ch.active || ch.attempts >= MAX_CHALLENGE_ATTEMPTS) return { error: EXPIRED };
    // Limite por conta, somando todos os desafios: acertar a senha de novo não zera esta contagem.
    await deps.limiters.loginAccount.consume(`mfa-login:${ch.user_id}`);
    const used = await consumeCode(db, ch.user_id, code);
    if (!used) {
      await db.query('update mfa_challenges set attempts = attempts + 1 where id = $1', [ch.id]);
      await insertAudit(db, ch.user_id, 'auth.mfa_failed', 'user', ch.user_id, meta.ip);
      return { error: ch.attempts + 1 >= MAX_CHALLENGE_ATTEMPTS ? EXPIRED : INVALID_CODE };
    }
    await db.query('delete from mfa_challenges where id = $1', [ch.id]);
    return { user: { id: ch.user_id, email: ch.email, full_name: ch.full_name, kind: ch.kind, company_id: ch.company_id }, used };
  });
  // O erro sai depois do commit, para que a tentativa fique registrada.
  if ('error' in result) throw result.error;
  return createSession(deps, result.user, meta, result.used === 'recovery' ? 'auth.login_mfa_recovery' : 'auth.login_mfa');
}

export async function disable(deps: Deps, user: AuthUser, password: string, code: string, ip: string) {
  await checkPassword(deps, user.id, password);
  await withTx(deps.pools.owner, async (db) => {
    if (!(await consumeCode(db, user.id, code))) throw INVALID_CODE;
    await db.query('delete from user_mfa where user_id = $1', [user.id]);
    await insertAudit(db, user.id, 'auth.mfa_disabled', 'user', user.id, ip);
  });
}

export async function regenerateRecovery(deps: Deps, user: AuthUser, code: string, ip: string) {
  await deps.limiters.loginAccount.consume(`mfa:${user.id}`);
  const codes = newRecoveryCodes();
  await withTx(deps.pools.owner, async (db) => {
    if (!(await consumeCode(db, user.id, code))) throw INVALID_CODE;
    await db.query('update user_mfa set recovery_hashes = $2 where user_id = $1', [user.id, codes.map(hashCode)]);
    await insertAudit(db, user.id, 'auth.mfa_recovery_regenerated', 'user', user.id, ip);
  });
  return { recoveryCodes: codes };
}

/** Administrador desliga a verificação de quem perdeu o celular e os códigos. */
export async function adminReset(deps: Deps, userId: string) {
  const r = await deps.pools.owner.query('delete from user_mfa where user_id = $1', [userId]);
  await deps.pools.owner.query('delete from mfa_challenges where user_id = $1', [userId]);
  return (r.rowCount ?? 0) > 0;
}

