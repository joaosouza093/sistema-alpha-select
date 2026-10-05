-- Nome exibível de uma pessoa para o usuário corrente, sem ampliar o acesso:
--  • equipe Alpha Select vê o nome de qualquer usuário;
--  • usuário de cliente vê o nome de quem participa dos mesmos processos
--    (as mesmas pessoas que a política users_read lhe mostra); para outras
--    pessoas da Alpha Select, apenas o rótulo genérico "Equipe Alpha Select";
--  • demais casos: "Usuário sem acesso" (nunca o nome).
create or replace function app.person_label(p_user uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when p_user is null or app.kind() is null then null
    when app.is_alpha() then (select full_name from users where id = p_user)
    else coalesce(
      (select case
                when u.id = app.uid()
                  or exists (select 1 from process_members m
                              where m.user_id = u.id and app.is_member(m.process_id)) then u.full_name
                when u.kind in ('alpha_admin', 'alpha_staff') then 'Equipe Alpha Select'
              end
         from users u where u.id = p_user),
      'Usuário sem acesso')
  end
$$;

revoke all on function app.person_label(uuid) from public;
grant execute on function app.person_label(uuid) to alpha_app;
