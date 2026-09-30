import type { Config } from './config.js';
import type { Deps } from './lib/context.js';
import { createPools } from './lib/db.js';
import { createMailer, type Mailer } from './lib/mailer.js';
import { createLimiters } from './lib/rate-limit.js';
import { DiskStorage, SupabaseStorage, type FileStorage } from './lib/storage.js';

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
  const storage = overrides.storage ?? createStorage(config);
  await storage.init();
  const pools = createPools(config);
  return {
    config,
    pools,
    mailer: overrides.mailer ?? createMailer(config),
    storage,
    limiters: createLimiters(config.RATE_LIMIT_STORE, pools.owner),
  };
}
