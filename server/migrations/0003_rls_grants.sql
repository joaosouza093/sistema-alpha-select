-- =====================================================================
-- Row Level Security, visão de dados compartilhados e privilégios.
-- Regra geral: negar por padrão. O papel alpha_app só recebe o mínimo
-- necessário, por tabela e por coluna, e toda linha passa pelas políticas.
-- =====================================================================

alter table companies             enable row level security;
alter table users                 enable row level security;
alter table user_credentials      enable row level security;
alter table sessions              enable row level security;
alter table invites               enable row level security;
alter table password_resets       enable row level security;
alter table stages                enable row level security;
alter table processes             enable row level security;
alter table process_members       enable row level security;
alter table candidates            enable row level security;
alter table applications          enable row level security;
alter table documents             enable row level security;
alter table application_documents enable row level security;
alter table comments              enable row level security;
alter table application_history   enable row level security;
alter table audit_events          enable row level security;

-- user_credentials, sessions, invites, password_resets: sem políticas e sem
-- privilégios para alpha_app => inacessíveis fora do servidor privilegiado.

-- ---------------------------------------------------------------------
-- Etapas
-- ---------------------------------------------------------------------
create policy stages_read on stages for select to alpha_app using (app.kind() is not null);

-- ---------------------------------------------------------------------
-- Empresas
-- ---------------------------------------------------------------------
create policy companies_read on companies for select to alpha_app
  using (app.is_alpha() or id = app.company_id());
create policy companies_insert on companies for insert to alpha_app with check (app.is_admin());
create policy companies_update on companies for update to alpha_app
  using (app.is_admin()) with check (app.is_admin());

-- ---------------------------------------------------------------------
-- Usuários
-- Próprio registro; administrador vê todos; equipe vê a equipe Alpha e
-- quem participa dos seus processos; cliente vê quem participa dos seus.
-- ---------------------------------------------------------------------
create policy users_read on users for select to alpha_app
  using (
    id = app.uid() and app.kind() is not null
    or app.is_admin()
    or (app.kind() = 'alpha_staff' and kind in ('alpha_admin', 'alpha_staff'))
    or exists (
      select 1 from process_members m
       where m.user_id = users.id and app.is_member(m.process_id)
    )
  );
create policy users_insert on users for insert to alpha_app with check (app.is_admin());
create policy users_update on users for update to alpha_app
  using (app.is_admin()) with check (app.is_admin());

-- ---------------------------------------------------------------------
-- Processos e participantes
-- ---------------------------------------------------------------------
create policy processes_read on processes for select to alpha_app using (app.can_view_process(id));
create policy processes_insert on processes for insert to alpha_app with check (app.is_admin());
create policy processes_update on processes for update to alpha_app
  using (app.is_admin()) with check (app.is_admin());

create policy members_read on process_members for select to alpha_app using (app.can_view_process(process_id));
create policy members_insert on process_members for insert to alpha_app with check (app.is_admin());
create policy members_update on process_members for update to alpha_app
  using (app.is_admin()) with check (app.is_admin());
create policy members_delete on process_members for delete to alpha_app using (app.is_admin());

-- ---------------------------------------------------------------------
-- Candidatos: somente equipe Alpha Select. Clientes nunca leem esta tabela;
-- recebem apenas os campos compartilhados por meio de shared_application_candidates.
-- ---------------------------------------------------------------------
-- Condição escrita sobre as colunas da própria linha para valer também no RETURNING do INSERT.
create policy candidates_read on candidates for select to alpha_app
  using (
    app.is_admin()
    or (app.kind() = 'alpha_staff' and (
          created_by = app.uid()
          or exists (select 1 from applications a where a.candidate_id = candidates.id and app.is_member(a.process_id))
       ))
  );
create policy candidates_insert on candidates for insert to alpha_app
  with check (app.is_alpha() and created_by = app.uid());
create policy candidates_update on candidates for update to alpha_app
  using (app.can_view_candidate(id)) with check (app.can_view_candidate(id));
create policy candidates_delete on candidates for delete to alpha_app using (app.is_admin());

-- ---------------------------------------------------------------------
-- Participações
-- ---------------------------------------------------------------------
create policy applications_read on applications for select to alpha_app using (app.can_view_process(process_id));
create policy applications_insert on applications for insert to alpha_app
  with check (
    app.is_alpha() and app.can_view_process(process_id) and app.can_view_candidate(candidate_id)
  );
-- Regras finas (etapa, decisão, responsável, compartilhamento) no gatilho applications_guard.
create policy applications_update on applications for update to alpha_app
  using (app.can_view_process(process_id)) with check (app.can_view_process(process_id));
create policy applications_delete on applications for delete to alpha_app using (app.is_admin());

create policy history_read on application_history for select to alpha_app
  using (app.can_view_application(application_id));

-- ---------------------------------------------------------------------
-- Documentos
-- ---------------------------------------------------------------------
create policy documents_read on documents for select to alpha_app
  using (
    (app.is_alpha() and app.can_view_candidate(candidate_id))
    or exists (
      select 1 from application_documents ad
       where ad.document_id = documents.id and ad.shared_with_client
         and app.can_view_application(ad.application_id)
    )
  );
create policy documents_insert on documents for insert to alpha_app
  with check (app.is_alpha() and app.can_view_candidate(candidate_id));
create policy documents_delete on documents for delete to alpha_app
  using (app.is_admin() or (app.is_alpha() and app.can_view_candidate(candidate_id) and uploaded_by = app.uid()));

create policy app_docs_read on application_documents for select to alpha_app
  using (app.can_view_application(application_id) and (app.is_alpha() or shared_with_client));
create policy app_docs_insert on application_documents for insert to alpha_app
  with check (app.is_alpha() and app.can_view_application(application_id) and app.can_view_candidate(candidate_id));
create policy app_docs_update on application_documents for update to alpha_app
  using (app.is_alpha() and app.can_view_application(application_id))
  with check (app.is_alpha() and app.can_view_application(application_id));
create policy app_docs_delete on application_documents for delete to alpha_app
  using (app.is_alpha() and app.can_view_application(application_id));

-- ---------------------------------------------------------------------
-- Comentários: internos somente para a equipe Alpha Select
-- ---------------------------------------------------------------------
create policy comments_read on comments for select to alpha_app
  using (app.can_view_application(application_id) and (app.is_alpha() or visibility = 'shared'));
create policy comments_insert on comments for insert to alpha_app
  with check (
    app.can_view_application(application_id)
    and author_id = app.uid()
    and (app.is_alpha() or visibility = 'shared')
  );
create policy comments_update on comments for update to alpha_app
  using (author_id = app.uid() and app.can_view_application(application_id)
         and (app.is_alpha() or visibility = 'shared'))
  with check (author_id = app.uid());
create policy comments_delete on comments for delete to alpha_app
  using ((author_id = app.uid() or app.is_admin()) and app.can_view_application(application_id)
         and (app.is_alpha() or visibility = 'shared'));

-- ---------------------------------------------------------------------
-- Auditoria: leitura apenas para administradores; escrita via app.audit()
-- ---------------------------------------------------------------------
create policy audit_read on audit_events for select to alpha_app using (app.is_admin());

-- ---------------------------------------------------------------------
-- Visão do candidato na participação
-- Executa com os privilégios do proprietário (ignora a RLS de candidates),
-- mas filtra pelo acesso ao processo e mascara campos não compartilhados.
-- Observações internas (candidates.notes) nunca fazem parte desta visão.
-- ---------------------------------------------------------------------
create view shared_application_candidates with (security_barrier = true) as
select
  a.id          as application_id,
  a.process_id,
  case when app.is_alpha() then a.candidate_id end as candidate_id,
  c.full_name,
  case when app.is_alpha() or a.share_email  then c.email::text end as email,
  case when app.is_alpha() or a.share_phone  then c.phone end as phone,
  case when app.is_alpha() or a.share_salary then c.salary_expectation end as salary_expectation
from applications a
join candidates c on c.id = a.candidate_id
where app.can_view_process(a.process_id);

-- ---------------------------------------------------------------------
-- Privilégios
-- ---------------------------------------------------------------------
revoke all on all tables in schema public from public;
revoke all on all sequences in schema public from public;
revoke all on all functions in schema app from public;
revoke all on schema app from public;

grant usage on schema public, app to alpha_app;
grant execute on all functions in schema app to alpha_app;

grant select on stages to alpha_app;
grant select, insert on companies to alpha_app;
grant update (name, is_active) on companies to alpha_app;

grant select, insert on users to alpha_app;
grant update (full_name, kind, company_id, is_active) on users to alpha_app;

grant select, insert on processes to alpha_app;
grant update (title, description, status) on processes to alpha_app;

grant select, insert, delete on process_members to alpha_app;
grant update (can_move_stage, can_decide, can_comment) on process_members to alpha_app;

grant select, insert, delete on candidates to alpha_app;
grant update (full_name, email, phone, salary_expectation, notes, archived_at) on candidates to alpha_app;

grant select, insert, delete on applications to alpha_app;
grant update (stage_id, decision, owner_id, share_email, share_phone, share_salary, shared_summary)
  on applications to alpha_app;

grant select on application_history to alpha_app;

grant select, insert, delete on documents to alpha_app;
grant select, insert, delete on application_documents to alpha_app;
grant update (shared_with_client) on application_documents to alpha_app;

grant select, insert, delete on comments to alpha_app;
grant update (body) on comments to alpha_app;

grant select on audit_events to alpha_app;
grant select on shared_application_candidates to alpha_app;
