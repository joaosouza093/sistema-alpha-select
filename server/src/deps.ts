import type { Config } from './config.js';
import type { Deps } from './lib/context.js';
import { createPools, createPoolsResolved } from './lib/db.js';
import { createMailer, type Mailer } from './lib/mailer.js';
import { createLimiters } from './lib/rate-limit.js';
import { DiskStorage, PgStorage, SupabaseStorage, plausibleServiceKey, type FileStorage } from './lib/storage.js';

export function createStorage(config: Config): FileStorage {
  if (config.STORAGE_DRIVER === 'supabase') {
    return new SupabaseStorage(config.SUPABASE_URL!, config.SUPABASE_SERVICE_ROLE_KEY!, config.SUPABASE_BUCKET, config.STORAGE_DIR);
  }
  return new DiskStorage(config.STORAGE_DIR);
}

export async function createDeps(
  config: Config,
  overrides: { mailer?: Mailer; storage?: FileStorage } = {},
): Promise<Deps> {
  // Com Supabase configurado, descobre o endereço do pooler se o informado não funcionar.
  const { pools, info } = config.SUPABASE_URL && config.SUPABASE_REGION
    ? await createPoolsResolved(config)
    : { pools: createPools(config), info: { auto: false, tlsUnverified: false } };
  // Sem chave válida do Supabase Storage, guarda os documentos no próprio banco.
  const storageFallback =
    !overrides.storage && config.STORAGE_DRIVER === 'supabase' && !plausibleServiceKey(config.SUPABASE_SERVICE_ROLE_KEY);
  const storage =
    overrides.storage ?? (storageFallback ? new PgStorage(pools.owner, config.STORAGE_DIR) : createStorage(config));
  await storage.init();
  return {
    config,
    pools,
    dbInfo: { ...info, storageFallback },
    mailer: overrides.mailer ?? createMailer(config),
    storage,
    limiters: createLimiters(config.RATE_LIMIT_STORE, pools.owner),
  };
}
