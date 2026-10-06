-- =====================================================================
-- LGPD: prazo de retenção do banco de talentos e área do candidato.
--  • privacy_settings: regra de retenção definida pelo administrador
--    (desligada por padrão: o prazo é decisão da Alpha Select).
--  • candidate_retention: aviso de exclusão e "manter" (sem tocar em
--    candidates.updated_at, que conta como atividade).
--  • candidate_access_tokens: links de acesso do candidato aos próprios
--    dados (somente o papel do servidor).
-- =====================================================================

create table privacy_settings (
  id                 boolean primary key default true check (id),
  retention_enabled  boolean not null default false,
  retention_months   smallint not null default 24 check (retention_months between 6 and 120),
  notice_days        smallint not null default 30 check (notice_days between 7 and 90),
  updated_at         timestamptz not null default now(),
  updated_by         uuid references users (id) on delete set null
);
insert into privacy_settings default values;

alter table privacy_settings enable row level security;
create policy privacy_settings_read on privacy_settings for select to alpha_app using (app.is_admin());
create policy privacy_settings_update on privacy_settings for update to alpha_app
  using (app.is_admin()) with check (app.is_admin() and updated_by = app.uid());
grant select on privacy_settings to alpha_app;
grant update (retention_enabled, retention_months, notice_days, updated_at, updated_by) on privacy_settings to alpha_app;

create table candidate_retention (
  candidate_id  uuid primary key references candidates (id) on delete cascade,
  notice_at     timestamptz,           -- aviso de exclusão (enviado ou não, conta o prazo)
  notice_sent   boolean not null default false,
  kept_at       timestamptz,           -- candidato renovou ou administrador manteve
  kept_by       uuid references users (id) on delete set null
);
alter table candidate_retention enable row level security;
create policy candidate_retention_read on candidate_retention for select to alpha_app using (app.is_admin());
create policy candidate_retention_write on candidate_retention for insert to alpha_app
  with check (app.is_admin() and kept_by = app.uid());
create policy candidate_retention_update on candidate_retention for update to alpha_app
  using (app.is_admin()) with check (app.is_admin() and kept_by = app.uid());
grant select, insert on candidate_retention to alpha_app;
grant update (notice_at, notice_sent, kept_at, kept_by) on candidate_retention to alpha_app;

-- Última atividade do candidato: cadastro, edição, consentimento, "manter" e participações.
create or replace function app.candidate_last_activity(p_candidate uuid) returns timestamptz
language sql stable security definer set search_path = public, pg_temp as $$
  select greatest(
           c.created_at, c.updated_at, c.consent_at, r.kept_at,
           (select max(greatest(a.created_at, a.updated_at)) from applications a where a.candidate_id = c.id))
    from candidates c left join candidate_retention r on r.candidate_id = c.id
   where c.id = p_candidate
$$;
revoke all on function app.candidate_last_activity(uuid) from public;
grant execute on function app.candidate_last_activity(uuid) to alpha_app;

create table candidate_access_tokens (
  id          uuid primary key default gen_random_uuid(),
  token_hash  bytea not null unique,
  email       citext not null,
  purpose     text not null check (purpose in ('acesso', 'retencao')),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index candidate_access_tokens_email_idx on candidate_access_tokens (email);
alter table candidate_access_tokens enable row level security;
revoke all on candidate_access_tokens from public;

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on privacy_settings, candidate_retention, candidate_access_tokens from %I', r);
      execute format('revoke all on function app.candidate_last_activity(uuid) from %I', r);
    end if;
  end loop;
end $$;
