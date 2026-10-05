-- =====================================================================
-- Vagas e portal público de candidatura.
-- Cada processo seletivo pode ser publicado como vaga. Candidaturas pelo
-- portal criam candidato + participação na etapa inicial, com origem
-- registrada; respostas às perguntas ficam visíveis só para a Alpha Select.
-- =====================================================================

alter table processes
  add column job_location        text check (char_length(job_location) <= 120),
  add column work_model          text check (work_model in ('presencial', 'hibrido', 'remoto')),
  add column employment_type     text check (employment_type in ('clt', 'pj', 'estagio', 'temporario', 'outro')),
  add column requirements        text check (char_length(requirements) <= 5000),
  add column benefits            text check (char_length(benefits) <= 3000),
  add column salary_min_cents    integer check (salary_min_cents >= 0),
  add column salary_max_cents    integer check (salary_max_cents >= 0),
  add column show_company        boolean not null default false,
  add column publication         text not null default 'rascunho'
                                 check (publication in ('rascunho', 'publicada', 'pausada', 'encerrada')),
  add column public_slug         text unique check (public_slug ~ '^[a-z0-9-]{3,120}$'),
  add column published_at        timestamptz,
  add column screening_questions jsonb not null default '[]'::jsonb
                                 check (jsonb_typeof(screening_questions) = 'array' and jsonb_array_length(screening_questions) <= 10),
  add constraint processes_salary_range
    check (salary_min_cents is null or salary_max_cents is null or salary_min_cents <= salary_max_cents),
  add constraint processes_published_slug check (publication = 'rascunho' or public_slug is not null);
create index processes_publication_idx on processes (publication) where publication = 'publicada';

grant update (job_location, work_model, employment_type, requirements, benefits, salary_min_cents, salary_max_cents,
              show_company, publication, public_slug, published_at, screening_questions)
  on processes to alpha_app;

-- Origem do candidato e da participação, e consentimento do próprio candidato.
alter table candidates
  add column source           text not null default 'interno' check (source in ('interno', 'portal')),
  add column city             text check (char_length(city) <= 120),
  add column consent_at       timestamptz,
  add column consent_version  text check (char_length(consent_version) <= 40);
grant update (city) on candidates to alpha_app;

alter table applications
  add column source text not null default 'interno' check (source in ('interno', 'portal'));

-- Respostas do formulário público. Somente a equipe Alpha lê (clientes nunca).
create table application_intake (
  application_id    uuid primary key references applications (id) on delete cascade,
  answers           jsonb not null check (jsonb_typeof(answers) = 'array'),
  screening_failed  boolean not null,
  created_at        timestamptz not null default now()
);
alter table application_intake enable row level security;
create policy intake_read on application_intake for select to alpha_app
  using (app.is_alpha() and app.can_view_application(application_id));
grant select on application_intake to alpha_app;

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on application_intake from %I', r);
    end if;
  end loop;
end $$;
