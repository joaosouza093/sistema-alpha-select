-- =====================================================================
-- Verificação em duas etapas (TOTP) opcional por usuário.
-- Segredos, códigos de recuperação e desafios de login ficam acessíveis
-- somente ao papel do servidor (RLS ligada e sem políticas, como as
-- credenciais).
-- =====================================================================

create table user_mfa (
  user_id         uuid primary key references users (id) on delete cascade,
  secret          text not null check (secret ~ '^[A-Z2-7]{32}$'),
  enabled_at      timestamptz,             -- null: configuração iniciada e não confirmada
  last_step       bigint,                  -- último passo aceito (impede reutilizar o código)
  recovery_hashes text[] not null default '{}',
  created_at      timestamptz not null default now()
);

create table mfa_challenges (
  id          uuid primary key default gen_random_uuid(),
  token_hash  bytea not null unique,
  user_id     uuid not null references users (id) on delete cascade,
  attempts    smallint not null default 0,
  expires_at  timestamptz not null,
  user_agent  text,
  ip          inet
);
create index mfa_challenges_user_idx on mfa_challenges (user_id);

alter table user_mfa enable row level security;
alter table mfa_challenges enable row level security;
revoke all on user_mfa, mfa_challenges from public;

-- Situação para a tela de usuários (somente administradores obtêm resposta).
create or replace function app.user_mfa_enabled(p_user uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select case when not app.is_admin() then null
              else exists (select 1 from user_mfa where user_id = p_user and enabled_at is not null) end
$$;
revoke all on function app.user_mfa_enabled(uuid) from public;
grant execute on function app.user_mfa_enabled(uuid) to alpha_app;

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on user_mfa, mfa_challenges from %I', r);
    end if;
  end loop;
end $$;
