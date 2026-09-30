-- Situação de acesso do usuário (somente para administradores),
-- sem expor hashes ou tokens ao papel alpha_app.
create or replace function app.user_access_status(p_user uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when not app.is_admin() then null
    when exists (select 1 from user_credentials where user_id = p_user) then 'senha_definida'
    when exists (select 1 from invites where user_id = p_user and used_at is null
                   and revoked_at is null and expires_at > now()) then 'convite_pendente'
    else 'sem_convite_valido'
  end
$$;

revoke all on function app.user_access_status(uuid) from public;
grant execute on function app.user_access_status(uuid) to alpha_app;

-- Possíveis duplicidades fora do escopo visível do usuário: retorna apenas
-- a quantidade (sem dados), para que a equipe acione um administrador.
create or replace function app.candidate_duplicate_count(p_email text, p_phone text, p_exclude uuid)
returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select case when not app.is_alpha() then 0 else (
    select count(*)::int from candidates c
     where (p_exclude is null or c.id <> p_exclude)
       and ((p_email is not null and c.email = p_email::citext)
            or (p_phone is not null and c.phone = p_phone))
  ) end
$$;

revoke all on function app.candidate_duplicate_count(text, text, uuid) from public;
grant execute on function app.candidate_duplicate_count(text, text, uuid) to alpha_app;
