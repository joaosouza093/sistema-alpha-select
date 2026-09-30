-- =====================================================================
-- Suporte a execução serverless (Netlify Functions) e ao Supabase.
-- =====================================================================

-- Contadores de limite de tentativas compartilhados entre instâncias.
-- Somente o papel proprietário (servidor) acessa; chaves gravadas como hash.
create table if not exists rate_limit_counters (
  key_hash      text not null,
  window_start  timestamptz not null,
  hits          integer not null,
  expires_at    timestamptz not null,
  primary key (key_hash, window_start)
);
create index if not exists rate_limit_counters_expires_idx on rate_limit_counters (expires_at);
alter table rate_limit_counters enable row level security;
revoke all on rate_limit_counters from public;

-- Supabase expõe o esquema public pela API automática (PostgREST) aos papéis
-- anon e authenticated. Este sistema NÃO usa essa API: removemos qualquer
-- privilégio desses papéis sobre os objetos da aplicação (defesa adicional
-- à RLS). Em PostgreSQL sem esses papéis, nada é feito.
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema public from %I', r);
      execute format('revoke all on all sequences in schema public from %I', r);
      execute format('revoke all on all functions in schema public from %I', r);
      execute format('revoke all on all functions in schema app from %I', r);
      execute format('revoke all on schema app from %I', r);
      execute format('alter default privileges in schema public revoke all on tables from %I', r);
      execute format('alter default privileges in schema public revoke all on sequences from %I', r);
      execute format('alter default privileges in schema public revoke all on functions from %I', r);
    end if;
  end loop;
end $$;
