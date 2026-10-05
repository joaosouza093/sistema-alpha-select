-- =====================================================================
-- Triagem interna, envio de leads ao cliente, motivos padronizados e SLA.
-- Regra nova: o cliente só enxerga a participação depois que a Alpha
-- Select a envia (sent_at). Antes disso ela é interna (triagem).
-- =====================================================================

alter table applications
  add column sent_at          timestamptz,
  add column sent_by          uuid references users (id) on delete set null,
  add column decision_reason  text check (decision_reason in (
    'perfil_tecnico', 'experiencia', 'pretensao_salarial', 'localizacao', 'disponibilidade',
    'comportamental', 'sem_retorno', 'vaga_cancelada', 'desistencia_candidato', 'outro'));
grant update (decision_reason) on applications to alpha_app;

-- Participações que já passaram da primeira etapa contam como enviadas.
update applications set sent_at = stage_changed_at where stage_id > 1 and sent_at is null;

-- Ao sair da etapa inicial, a participação fica enviada (marca permanente).
create or replace function app.tg_applications_sent() returns trigger
language plpgsql as $$
begin
  if new.sent_at is null and new.stage_id <> old.stage_id
     and (select position from stages where id = new.stage_id) > 1 then
    new.sent_at := now();
    new.sent_by := app.uid();
  end if;
  if old.sent_at is not null and new.sent_at is distinct from old.sent_at then
    raise exception 'O envio ao cliente não pode ser desfeito.' using errcode = 'AS409';
  end if;
  return new;
end $$;
alter function app.tg_applications_sent() set search_path = public, pg_temp;
create trigger applications_sent before update on applications
  for each row execute function app.tg_applications_sent();

-- Visibilidade: cliente/gestor só veem participações enviadas.
create or replace function app.can_view_application(p_application uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((
    select app.can_view_process(a.process_id) and (app.is_alpha() or a.sent_at is not null)
      from applications a where a.id = p_application), false)
$$;

alter policy applications_read on applications
  using (app.can_view_process(process_id) and (app.is_alpha() or sent_at is not null));
alter policy applications_update on applications
  using (app.can_view_process(process_id) and (app.is_alpha() or sent_at is not null))
  with check (app.can_view_process(process_id));

create or replace view shared_application_candidates with (security_barrier = true) as
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
where app.can_view_process(a.process_id) and (app.is_alpha() or a.sent_at is not null);

-- Configuração de triagem por processo.
alter table processes
  add column sla_days            smallint not null default 3 check (sla_days between 1 and 60),
  add column evaluation_criteria jsonb not null default '[]'::jsonb
    check (jsonb_typeof(evaluation_criteria) = 'array' and jsonb_array_length(evaluation_criteria) <= 10);
grant update (sla_days, evaluation_criteria) on processes to alpha_app;

-- Ficha de avaliação da triagem (somente equipe Alpha).
create table application_evaluations (
  application_id  uuid primary key references applications (id) on delete cascade,
  triage_status   text not null default 'em_triagem'
                  check (triage_status in ('em_triagem', 'aprovado_interno', 'reprovado_interno')),
  ratings         jsonb not null default '[]'::jsonb check (jsonb_typeof(ratings) = 'array'),
  score           numeric(3, 2) check (score between 1 and 5),
  reason          text check (reason in (
    'perfil_tecnico', 'experiencia', 'pretensao_salarial', 'localizacao', 'disponibilidade',
    'comportamental', 'sem_retorno', 'vaga_cancelada', 'desistencia_candidato', 'outro')),
  notes           text check (char_length(notes) <= 5000),
  evaluated_by    uuid references users (id) on delete set null,
  updated_at      timestamptz not null default now(),
  version         integer not null default 1,
  check (triage_status <> 'reprovado_interno' or reason is not null)
);
create trigger application_evaluations_touch before update on application_evaluations
  for each row execute function app.tg_touch_version();
alter table application_evaluations enable row level security;
create policy evaluations_read on application_evaluations for select to alpha_app
  using (app.is_alpha() and app.can_view_application(application_id));
create policy evaluations_insert on application_evaluations for insert to alpha_app
  with check (app.is_alpha() and app.can_view_application(application_id) and evaluated_by = app.uid());
create policy evaluations_update on application_evaluations for update to alpha_app
  using (app.is_alpha() and app.can_view_application(application_id))
  with check (app.is_alpha() and evaluated_by = app.uid());
grant select, insert on application_evaluations to alpha_app;
grant update (triage_status, ratings, score, reason, notes, evaluated_by) on application_evaluations to alpha_app;

-- Registro de cada envio ao cliente (lead).
create table lead_submissions (
  id              uuid primary key default gen_random_uuid(),
  application_id  uuid not null unique references applications (id) on delete cascade,
  process_id      uuid not null references processes (id) on delete cascade,
  batch_id        uuid,
  sent_by         uuid references users (id) on delete set null,
  sent_at         timestamptz not null default now()
);
create index lead_submissions_process_idx on lead_submissions (process_id, sent_at desc);
alter table lead_submissions enable row level security;
create policy leads_read on lead_submissions for select to alpha_app
  using (app.can_view_application(application_id));
create policy leads_insert on lead_submissions for insert to alpha_app
  with check (app.is_alpha() and app.can_view_application(application_id) and sent_by = app.uid());
grant select, insert on lead_submissions to alpha_app;

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on application_evaluations, lead_submissions, shared_application_candidates from %I', r);
    end if;
  end loop;
end $$;
