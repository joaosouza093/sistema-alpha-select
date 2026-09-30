import type { Config } from './config.js';
import type { Deps } from './lib/context.js';
import { createPools } from './lib/db.js';
import { createMailer, type Mailer } from './lib/mailer.js';
import { createLimiters } from './lib/rate-limit.js';
import { DiskStorage } from './lib/storage.js';

export async function createDeps(config: Config, overrides: { mailer?: Mailer } = {}): Promise<Deps> {
  const storage = new DiskStorage(config.STORAGE_DIR);
  await storage.init();
  return {
    config,
    pools: createPools(config),
    mailer: overrides.mailer ?? createMailer(config),
    storage,
    limiters: createLimiters(),
  };
}
