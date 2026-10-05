import os from 'node:os';
import path from 'node:path';

export const TEST_ENV = {
  APP_ENV: 'test',
  APP_URL: 'http://localhost:5173',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://alpha_app:dev_app_pw@127.0.0.1:5432/alpha_test',
  DATABASE_OWNER_URL:
    process.env.TEST_DATABASE_OWNER_URL ?? 'postgres://alpha_owner:dev_owner_pw@127.0.0.1:5432/alpha_test',
  STORAGE_DIR: path.join(os.tmpdir(), `alpha-test-storage-${process.pid}`),
  MAX_UPLOAD_MB: '1',
  LOG_LEVEL: 'silent',
} as const;
