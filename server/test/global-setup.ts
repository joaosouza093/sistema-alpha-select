import pg from 'pg';
import { migrate } from '../scripts/migrate-lib.js';
import { TEST_ENV } from './env.js';

/** Recria o banco de testes do zero e aplica todas as migrações. */
export default async function setup() {
  const admin = new pg.Client({ connectionString: TEST_ENV.DATABASE_OWNER_URL.replace(/\/[^/]+$/, '/postgres') });
  await admin.connect();
  await admin.query('drop database if exists alpha_test with (force)');
  await admin.query('create database alpha_test');
  await admin.end();
  await migrate(TEST_ENV.DATABASE_OWNER_URL, () => undefined);
}
