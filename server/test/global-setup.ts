import pg from 'pg';
import { migrate } from '../scripts/migrate-lib.js';
import { TEST_ENV } from './env.js';

/**
 * Recria o banco de testes do zero e aplica todas as migrações.
 * Com TEST_SUPABASE_LAYOUT=1, reproduz o layout do Supabase antes das
 * migrações: extensões no esquema "extensions", search_path dos papéis e
 * papéis anon/authenticated da API automática.
 */
export default async function setup() {
  const dbName = new URL(TEST_ENV.DATABASE_OWNER_URL).pathname.slice(1);
  const layout = process.env.TEST_SUPABASE_LAYOUT === '1';
  // No layout do Supabase o banco e o esquema public pertencem ao superusuário, não a alpha_owner.
  const adminUrl = layout ? process.env.TEST_SUPERUSER_URL! : TEST_ENV.DATABASE_OWNER_URL.replace(/\/[^/]+$/, '/postgres');
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`drop database if exists ${dbName} with (force)`);
  await admin.query(`create database ${dbName}`);
  await admin.end();

  if (layout) {
    const su = new pg.Client({ connectionString: adminUrl.replace(/\/[^/]*$/, `/${dbName}`) });
    await su.connect();
    // Mesmo conteúdo de scripts/sql/supabase-setup.sql, com o que o Supabase já traz pronto.
    await su.query(`
      create schema if not exists extensions;
      create extension if not exists citext with schema extensions;
      create extension if not exists pg_trgm with schema extensions;
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
        if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      end $$;
      grant usage on schema public, extensions to anon, authenticated;
      alter default privileges in schema public grant all on tables to anon, authenticated;
      grant create on database ${dbName} to alpha_owner;
      grant usage, create on schema public to alpha_owner;
      grant usage on schema public to alpha_app;
      grant usage on schema extensions to alpha_owner, alpha_app;
      alter role alpha_owner in database ${dbName} set search_path = public, extensions;
      alter role alpha_app in database ${dbName} set search_path = public, extensions;
    `);
    await su.end();
  }
  await migrate(TEST_ENV.DATABASE_OWNER_URL, () => undefined);
}
