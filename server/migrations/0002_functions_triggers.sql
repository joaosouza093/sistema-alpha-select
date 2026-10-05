-- =====================================================================
-- Funções auxiliares de autorização e gatilhos de integridade.
--
-- O servidor abre cada transação de usuário com:
--   select set_config('app.user_id', '<uuid do usuário autenticado>', true)
-- usando o papel "alpha_app" (sem BYPASSRLS). Todas as funções abaixo
-- derivam perfil, empresa e escopo EXCLUSIVAMENTE do banco, a partir
-- desse identificador — nunca de dados enviados pelo navegador.
--
-- Códigos de erro próprios (SQLSTATE):
--   AS403 = operação não permitida
--   AS409 = conflito de estado
--   AS422 = dados inválidos / relacionamento incoerente
-- =====================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'alpha_app') then
    raise exception 'O papel alpha_app precisa existir antes das migrações (ver docs/INSTALACAO.md).';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Identidade e escopo do usuário corrente
-- ---------------------------------------------------------------------
create or replace function app.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

-- Perfil do usuário corrente, somente se ativo (e se a empresa estiver ativa).
create or replace function app.kind() returns user_kind
language sql stable security definer set search_path = public, pg_temp as $$
  select u.kind
    from users u
    left join companies c on c.id = u.company_id
   where u.id = app.uid()
     and u.is_active
     and (u.company_id is null or c.is_active)
$$;

create or replace function app.company_id() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select u.company_id from users u where u.id = app.uid() and app.kind() is not null
$$;

create or replace function app.is_admin() returns boolean
language sql stable as $$ select coalesce(app.kind() = 'alpha_admin', false) $$;

create or replace function app.is_alpha() returns boolean
language sql stable as $$ select coalesce(app.kind() in ('alpha_admin', 'alpha_staff'), false) $$;

-- Participante autorizado do processo. Para usuários de cliente, exige
-- também que o processo seja da empresa do usuário (dupla verificação).
create or replace function app.is_member(p_process uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1
      from process_members m
      join processes pr on pr.id = m.process_id
     where m.process_id = p_process
       and m.user_id = app.uid()
       and app.kind() is not null
       and (app.is_alpha() or pr.company_id = app.company_id())
  )
$$;

create or replace function app.can_view_process(p_process uuid) returns boolean
language sql stable as $$ select app.is_admin() or app.is_member(p_process) $$;

-- Permissão específica do participante: 'move' | 'decide' | 'comment'.
create or replace function app.member_perm(p_process uuid, p_perm text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when app.is_admin() then true
    when not app.is_member(p_process) then false
    else coalesce((
      select case p_perm
               when 'move'    then m.can_move_stage
               when 'decide'  then m.can_decide
               when 'comment' then m.can_comment
               else false
             end
        from process_members m
       where m.process_id = p_process and m.user_id = app.uid()
    ), false)
  end
$$;

create or replace function app.can_view_application(p_application uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select app.can_view_process(a.process_id) from applications a where a.id = p_application), false)
$$;

-- Cadastro completo do candidato: somente equipe Alpha Select.
-- Administrador vê todos; equipe vê os que cadastrou ou que participam
-- de processos aos quais tem acesso.
create or replace function app.can_view_candidate(p_candidate uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app.is_admin()
      or (app.kind() = 'alpha_staff' and (
            exists (select 1 from candidates c where c.id = p_candidate and c.created_by = app.uid())
         or exists (select 1 from applications a where a.candidate_id = p_candidate and app.is_member(a.process_id))
      ))
$$;

-- Documento: equipe com acesso ao candidato, ou participante do processo
-- em que o documento foi explicitamente compartilhado com o cliente.
create or replace function app.can_view_document(p_document uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from documents d
     where d.id = p_document
       and (
         (app.is_alpha() and app.can_view_candidate(d.candidate_id))
         or exists (
           select 1
             from application_documents ad
             join applications a on a.id = ad.application_id
            where ad.document_id = d.id
              and ad.shared_with_client
              and app.can_view_process(a.process_id)
         )
       )
  )
$$;

-- Registro de auditoria dentro da mesma transação da operação.
create or replace function app.audit(
  p_action text, p_entity_type text, p_entity_id text,
  p_company_id uuid default null, p_details jsonb default '{}'::jsonb, p_ip inet default null
) returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into audit_events (actor_id, action, entity_type, entity_id, company_id, details, ip)
  values (app.uid(), p_action, p_entity_type, p_entity_id, p_company_id, coalesce(p_details, '{}'::jsonb), p_ip)
$$;

-- ---------------------------------------------------------------------
-- Gatilhos genéricos
-- ---------------------------------------------------------------------
create or replace function app.tg_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create or replace function app.tg_touch_version() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  new.version := old.version + 1;
  return new;
end $$;

create or replace function app.tg_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'Registros de % não podem ser alterados ou excluídos.', tg_table_name using errcode = 'AS403';
end $$;

create trigger companies_touch before update on companies for each row execute function app.tg_touch();
create trigger users_touch before update on users for each row execute function app.tg_touch();
create trigger processes_touch before update on processes for each row execute function app.tg_touch_version();
create trigger candidates_touch before update on candidates for each row execute function app.tg_touch_version();

create trigger audit_append_only before update or delete on audit_events
  for each row execute function app.tg_append_only();
create trigger history_append_only before update on application_history
  for each row execute function app.tg_append_only();

-- ---------------------------------------------------------------------
-- Usuários: proteção contra escalada e contra perda do último administrador
-- ---------------------------------------------------------------------
create or replace function app.tg_users_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if new.email is distinct from old.email and current_user = 'alpha_app' then
      raise exception 'E-mail do usuário não pode ser alterado por esta operação.' using errcode = 'AS403';
    end if;

    if current_user = 'alpha_app' and new.id = app.uid()
       and (new.kind is distinct from old.kind or new.is_active is distinct from old.is_active
            or new.company_id is distinct from old.company_id) then
      raise exception 'Você não pode alterar o próprio perfil, empresa ou situação.' using errcode = 'AS403';
    end if;

    if (new.kind is distinct from old.kind or new.company_id is distinct from old.company_id)
       and exists (select 1 from process_members m where m.user_id = new.id) then
      raise exception 'Remova os vínculos do usuário com processos antes de alterar perfil ou empresa.'
        using errcode = 'AS409';
    end if;

    if old.kind = 'alpha_admin' and old.is_active
       and (new.kind <> 'alpha_admin' or not new.is_active)
       and not exists (select 1 from users u where u.kind = 'alpha_admin' and u.is_active and u.id <> old.id) then
      raise exception 'É necessário manter ao menos um administrador ativo.' using errcode = 'AS409';
    end if;
  end if;
  return new;
end $$;

create trigger users_guard before update on users for each row execute function app.tg_users_guard();

-- ---------------------------------------------------------------------
-- Participantes do processo: usuário de cliente só em processo da própria empresa
-- ---------------------------------------------------------------------
create or replace function app.tg_members_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user users%rowtype;
  v_company uuid;
begin
  select * into v_user from users where id = new.user_id;
  select company_id into v_company from processes where id = new.process_id;

  if v_user.kind in ('client_user', 'client_manager') and v_user.company_id is distinct from v_company then
    raise exception 'O usuário não pertence à empresa deste processo.' using errcode = 'AS422';
  end if;

  if tg_op = 'UPDATE' and (new.user_id <> old.user_id or new.process_id <> old.process_id) then
    raise exception 'Vínculo não pode ser transferido.' using errcode = 'AS422';
  end if;

  if tg_op = 'INSERT' and current_user = 'alpha_app' then
    new.added_by := app.uid();
  end if;
  return new;
end $$;

create trigger process_members_guard before insert or update on process_members
  for each row execute function app.tg_members_guard();

-- Ao remover o vínculo, o usuário deixa de ser responsável nas participações do processo.
create or replace function app.tg_members_after_delete() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update applications set owner_id = null
   where process_id = old.process_id and owner_id = old.user_id;
  return old;
end $$;

create trigger process_members_after_delete after delete on process_members
  for each row execute function app.tg_members_after_delete();

-- ---------------------------------------------------------------------
-- Participações: transições, decisões, responsáveis e permissões
-- ---------------------------------------------------------------------
create or replace function app.valid_owner(p_process uuid, p_owner uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from users u
      left join companies c on c.id = u.company_id
     where u.id = p_owner and u.is_active and (u.company_id is null or c.is_active)
       and (
         u.kind = 'alpha_admin'
         or exists (
           select 1 from process_members m join processes pr on pr.id = m.process_id
            where m.process_id = p_process and m.user_id = u.id
              and (u.company_id is null or u.company_id = pr.company_id)
         )
       )
  )
$$;

create or replace function app.tg_applications_guard() returns trigger
language plpgsql as $$
declare
  v_status process_status;
  v_is_app boolean := current_user = 'alpha_app';
  v_old_pos smallint;
  v_new_pos smallint;
begin
  select status into v_status from processes where id = new.process_id;

  if tg_op = 'INSERT' then
    if v_status <> 'em_andamento' then
      raise exception 'Somente processos em andamento aceitam novos candidatos.' using errcode = 'AS409';
    end if;
    if v_is_app then
      new.stage_id := 1;
      new.decision := 'pendente';
      new.created_by := app.uid();
    end if;
    new.version := 1;
    if new.owner_id is not null and not app.valid_owner(new.process_id, new.owner_id) then
      raise exception 'O responsável precisa ter acesso ativo ao processo.' using errcode = 'AS422';
    end if;
    return new;
  end if;

  -- UPDATE
  if new.candidate_id <> old.candidate_id or new.process_id <> old.process_id then
    raise exception 'Candidato e processo da participação não podem ser alterados.' using errcode = 'AS422';
  end if;

  if v_status <> 'em_andamento' and v_is_app then
    raise exception 'Processo concluído ou arquivado não aceita alterações.' using errcode = 'AS409';
  end if;

  if v_is_app then
    if (new.share_email, new.share_phone, new.share_salary, new.shared_summary)
       is distinct from (old.share_email, old.share_phone, old.share_salary, old.shared_summary)
       and not (app.is_alpha() and app.can_view_process(new.process_id)) then
      raise exception 'Sem permissão para alterar o compartilhamento.' using errcode = 'AS403';
    end if;
    if new.stage_id <> old.stage_id and not app.member_perm(new.process_id, 'move') then
      raise exception 'Sem permissão para alterar a etapa.' using errcode = 'AS403';
    end if;
    if new.decision <> old.decision and not app.member_perm(new.process_id, 'decide') then
      raise exception 'Sem permissão para registrar decisão.' using errcode = 'AS403';
    end if;
    if new.owner_id is distinct from old.owner_id
       and not (app.is_admin()
                or (app.is_alpha() and app.is_member(new.process_id))
                or app.member_perm(new.process_id, 'move')) then
      raise exception 'Sem permissão para alterar o responsável.' using errcode = 'AS403';
    end if;
  end if;

  if new.stage_id <> old.stage_id then
    if new.decision <> 'pendente' then
      raise exception 'Reabra a decisão (pendente) antes de mover o candidato de etapa.' using errcode = 'AS409';
    end if;
    select position into v_old_pos from stages where id = old.stage_id;
    select position into v_new_pos from stages where id = new.stage_id;
    if abs(v_new_pos - v_old_pos) <> 1 and not (app.is_admin() or not v_is_app) then
      raise exception 'Movimentação permitida apenas para a etapa anterior ou seguinte.' using errcode = 'AS422';
    end if;
    new.stage_changed_at := now();
  end if;

  if new.decision = 'aprovado' and new.decision <> old.decision
     and new.stage_id <> (select id from stages where key = 'aprovacao') then
    raise exception 'A aprovação só pode ser registrada na etapa Aprovação.' using errcode = 'AS422';
  end if;

  if new.owner_id is distinct from old.owner_id and new.owner_id is not null
     and not app.valid_owner(new.process_id, new.owner_id) then
    raise exception 'O responsável precisa ter acesso ativo ao processo.' using errcode = 'AS422';
  end if;

  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end $$;

create trigger applications_guard before insert or update on applications
  for each row execute function app.tg_applications_guard();

-- Histórico gravado na mesma transação da alteração.
create or replace function app.tg_applications_history() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    insert into application_history (application_id, event, to_stage_id, to_owner_id, to_decision, actor_id)
    values (new.id, 'created', new.stage_id, new.owner_id, new.decision, app.uid());
  elsif (new.stage_id, new.owner_id, new.decision) is distinct from (old.stage_id, old.owner_id, old.decision) then
    insert into application_history (application_id, event, from_stage_id, to_stage_id,
                                     from_owner_id, to_owner_id, from_decision, to_decision, actor_id)
    values (new.id, 'changed', old.stage_id, new.stage_id, old.owner_id, new.owner_id,
            old.decision, new.decision, app.uid());
  end if;
  return null;
end $$;

create trigger applications_history after insert or update on applications
  for each row execute function app.tg_applications_history();

-- ---------------------------------------------------------------------
-- Comentários: autor e visibilidade definidos pelo servidor/banco
-- ---------------------------------------------------------------------
create or replace function app.tg_comments_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if current_user = 'alpha_app' then
      new.author_id := app.uid();
      if not app.is_alpha() then
        if new.visibility <> 'shared' then
          raise exception 'Usuários de cliente só publicam comentários compartilhados.' using errcode = 'AS403';
        end if;
        if not app.member_perm((select process_id from applications where id = new.application_id), 'comment') then
          raise exception 'Sem permissão para comentar neste processo.' using errcode = 'AS403';
        end if;
      end if;
    end if;
    new.edited := false;
    new.created_at := now();
    new.updated_at := now();
    return new;
  end if;

  if new.visibility <> old.visibility or new.application_id <> old.application_id
     or new.author_id is distinct from old.author_id then
    raise exception 'Visibilidade, participação e autor do comentário não podem ser alterados.' using errcode = 'AS422';
  end if;
  new.edited := true;
  new.updated_at := now();
  return new;
end $$;

create trigger comments_guard before insert or update on comments
  for each row execute function app.tg_comments_guard();

-- ---------------------------------------------------------------------
-- Documentos e compartilhamentos: autoria definida pelo banco
-- ---------------------------------------------------------------------
create or replace function app.tg_documents_guard() returns trigger
language plpgsql as $$
begin
  if current_user = 'alpha_app' then
    new.uploaded_by := app.uid();
  end if;
  new.created_at := now();
  return new;
end $$;

create trigger documents_guard before insert on documents
  for each row execute function app.tg_documents_guard();

create or replace function app.tg_app_docs_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if current_user = 'alpha_app' then
      new.linked_by := app.uid();
    end if;
  elsif new.application_id <> old.application_id or new.document_id <> old.document_id
        or new.candidate_id <> old.candidate_id then
    raise exception 'Vínculo de documento não pode ser transferido.' using errcode = 'AS422';
  end if;
  return new;
end $$;

create trigger application_documents_guard before insert or update on application_documents
  for each row execute function app.tg_app_docs_guard();
