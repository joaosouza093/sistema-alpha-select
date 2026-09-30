import type { Pools } from './lib/db.js';

/** Limpeza periódica: sessões expiradas, tokens vencidos e contadores de tentativas antigos. */
export async function runMaintenance(pools: Pools) {
  await pools.owner.query(
    `delete from sessions where expires_at < now();
     delete from password_resets where expires_at < now() - interval '7 days';
     delete from invites where expires_at < now() - interval '30 days' and used_at is null;
     delete from rate_limit_counters where expires_at < now() - interval '1 hour';`,
  );
}
