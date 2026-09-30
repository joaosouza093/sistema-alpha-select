-- =====================================================================
-- Alpha Select — esquema inicial
-- Tabelas de negócio, restrições e índices.
-- Políticas de acesso (RLS), gatilhos e permissões ficam em 0002/0003.
-- =====================================================================

create extension if not exists citext;
create extension if not exists pg_trgm;

create schema if not exists app;

-- ---------------------------------------------------------------------
-- Tipos
-- ---------------------------------------------------------------------
create type user_kind as enum ('alpha_admin', 'alpha_staff', 'client_user', 'client_manager');
create type process_status as enum ('em_andamento', 'concluido', 'arquivado');
create type candidate_decision as enum ('pendente', 'aprovado', 'reprovado', 'desistiu');
create type comment_visibility as enum ('internal', 'shared');
create type document_kind as enum ('curriculo', 'documento', 'outro');

-- ---------------------------------------------------------------------
-- Empresas clientes
-- ---------------------------------------------------------------------
create table companies (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 2 and 160),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index companies_name_uq on companies (lower(btrim(name)));

-- ---------------------------------------------------------------------
-- Usuários (sem credenciais — ver user_credentials)
-- ---------------------------------------------------------------------
create table users (
  id             uuid primary key default gen_random_uuid(),
  email          citext not null unique
                 check (char_length(email) <= 254 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  full_name      text not null check (char_length(btrim(full_name)) between 2 and 120),
  kind           user_kind not null,
  company_id     uuid references companies (id) on delete restrict,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  last_login_at  timestamptz,
  -- Usuários da Alpha Select não pertencem a empresa cliente; usuários de cliente sempre pertencem.
  constraint users_company_matches_kind
    check ((kind in ('alpha_admin', 'alpha_staff')) = (company_id is null))
);
create index users_company_idx on users (company_id);

-- Credenciais e sessões: acessíveis somente pelo papel privilegiado do servidor.
create table user_credentials (
  user_id              uuid primary key references users (id) on delete cascade,
  password_hash        text not null,
  password_changed_at  timestamptz not null default now(),
  failed_attempts      integer not null default 0,
  locked_until         timestamptz
);

create table sessions (
  id            uuid primary key default gen_random_uuid(),
  token_hash    bytea not null unique,
  csrf_token    text not null,
  user_id       uuid not null references users (id) on delete cascade,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  expires_at    timestamptz not null,
  user_agent    text,
  ip            inet
);
create index sessions_user_idx on sessions (user_id);
create index sessions_expires_idx on sessions (expires_at);

create table invites (
  id          uuid primary key default gen_random_uuid(),
  token_hash  bytea not null unique,
  user_id     uuid not null references users (id) on delete cascade,
  created_by  uuid references users (id) on delete set null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  revoked_at  timestamptz
);
create index invites_user_idx on invites (user_id);

create table password_resets (
  id          uuid primary key default gen_random_uuid(),
  token_hash  bytea not null unique,
  user_id     uuid not null references users (id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz
);
create index password_resets_user_idx on password_resets (user_id);

-- ---------------------------------------------------------------------
-- Etapas do fluxo
-- ---------------------------------------------------------------------
create table stages (
  id        smallint primary key,
  key       text not null unique,
  name      text not null,
  position  smallint not null unique
);
insert into stages (id, key, name, position) values
  (1, 'rh_externo', 'RH Externo', 1),
  (2, 'rh_interno', 'RH Interno', 2),
  (3, 'gestor',     'CEO/Gestor', 3),
  (4, 'aprovacao',  'Aprovação',  4);

-- ---------------------------------------------------------------------
-- Processos seletivos e participantes autorizados
-- ---------------------------------------------------------------------
create table processes (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies (id) on delete restrict,
  title        text not null check (char_length(btrim(title)) between 3 and 160),
  description  text check (char_length(description) <= 5000),
  status       process_status not null default 'em_andamento',
  created_by   uuid references users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  version      integer not null default 1
);
create index processes_company_idx on processes (company_id);
create index processes_status_idx on processes (status);

create table process_members (
  process_id      uuid not null references processes (id) on delete cascade,
  user_id         uuid not null references users (id) on delete cascade,
  can_move_stage  boolean not null default false,
  can_decide      boolean not null default false,
  can_comment     boolean not null default true,
  added_by        uuid references users (id) on delete set null,
  created_at      timestamptz not null default now(),
  primary key (process_id, user_id)
);
create index process_members_user_idx on process_members (user_id);

-- ---------------------------------------------------------------------
-- Candidatos (cadastro interno da Alpha Select)
-- ---------------------------------------------------------------------
create table candidates (
  id                  uuid primary key default gen_random_uuid(),
  full_name           text not null check (char_length(btrim(full_name)) between 2 and 160),
  email               citext check (email is null or (char_length(email) <= 254 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  phone               text check (phone is null or phone ~ '^\+?[0-9]{8,15}$'),
  salary_expectation  numeric(12, 2) check (salary_expectation is null or salary_expectation >= 0),
  notes               text check (notes is null or char_length(notes) <= 10000),
  created_by          uuid references users (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  version             integer not null default 1,
  archived_at         timestamptz
);
create index candidates_name_trgm on candidates using gin (full_name gin_trgm_ops);
create index candidates_email_idx on candidates (email);
create index candidates_phone_idx on candidates (phone);
create index candidates_created_by_idx on candidates (created_by);

-- ---------------------------------------------------------------------
-- Participações (candidato em um processo)
-- ---------------------------------------------------------------------
create table applications (
  id              uuid primary key default gen_random_uuid(),
  candidate_id    uuid not null references candidates (id) on delete restrict,
  process_id      uuid not null references processes (id) on delete restrict,
  stage_id        smallint not null default 1 references stages (id),
  decision        candidate_decision not null default 'pendente',
  owner_id        uuid references users (id) on delete set null,
  -- O que do cadastro é compartilhado com o cliente nesta participação.
  share_email     boolean not null default false,
  share_phone     boolean not null default false,
  share_salary    boolean not null default false,
  shared_summary  text check (shared_summary is null or char_length(shared_summary) <= 5000),
  created_by      uuid references users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  stage_changed_at timestamptz not null default now(),
  version         integer not null default 1,
  unique (candidate_id, process_id),
  unique (id, candidate_id)
);
create index applications_process_stage_idx on applications (process_id, stage_id);
create index applications_owner_idx on applications (owner_id);
create index applications_candidate_idx on applications (candidate_id);

-- ---------------------------------------------------------------------
-- Documentos (pertencem ao candidato) e compartilhamento por participação
-- ---------------------------------------------------------------------
create table documents (
  id             uuid primary key default gen_random_uuid(),
  candidate_id   uuid not null references candidates (id) on delete restrict,
  kind           document_kind not null default 'curriculo',
  storage_key    text not null unique check (storage_key ~ '^[0-9a-f]{2}/[0-9a-f-]{36}$'),
  original_name  text not null check (char_length(original_name) between 1 and 200),
  mime_type      text not null,
  size_bytes     bigint not null check (size_bytes > 0),
  sha256         text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_by    uuid references users (id) on delete set null,
  created_at     timestamptz not null default now(),
  unique (id, candidate_id)
);
create index documents_candidate_idx on documents (candidate_id);

create table application_documents (
  application_id      uuid not null,
  document_id         uuid not null,
  candidate_id        uuid not null,
  shared_with_client  boolean not null default false,
  linked_by           uuid references users (id) on delete set null,
  created_at          timestamptz not null default now(),
  primary key (application_id, document_id),
  -- Garante que o documento pertence ao mesmo candidato da participação.
  foreign key (application_id, candidate_id) references applications (id, candidate_id) on delete cascade,
  foreign key (document_id, candidate_id) references documents (id, candidate_id) on delete cascade
);
create index application_documents_document_idx on application_documents (document_id);

-- ---------------------------------------------------------------------
-- Comentários
-- ---------------------------------------------------------------------
create table comments (
  id              uuid primary key default gen_random_uuid(),
  application_id  uuid not null references applications (id) on delete cascade,
  author_id       uuid references users (id) on delete set null,
  visibility      comment_visibility not null default 'internal',
  body            text not null check (char_length(btrim(body)) between 1 and 5000),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  edited          boolean not null default false
);
create index comments_application_idx on comments (application_id, created_at);

-- ---------------------------------------------------------------------
-- Histórico de movimentações (somente via gatilho)
-- ---------------------------------------------------------------------
create table application_history (
  id              bigserial primary key,
  application_id  uuid not null references applications (id) on delete cascade,
  event           text not null check (event in ('created', 'changed')),
  from_stage_id   smallint references stages (id),
  to_stage_id     smallint references stages (id),
  from_owner_id   uuid references users (id) on delete set null,
  to_owner_id     uuid references users (id) on delete set null,
  from_decision   candidate_decision,
  to_decision     candidate_decision,
  actor_id        uuid references users (id) on delete set null,
  created_at      timestamptz not null default now()
);
create index application_history_app_idx on application_history (application_id, created_at desc);
create index application_history_created_idx on application_history (created_at desc);

-- ---------------------------------------------------------------------
-- Auditoria (somente inserção)
-- ---------------------------------------------------------------------
create table audit_events (
  id           bigserial primary key,
  occurred_at  timestamptz not null default now(),
  actor_id     uuid references users (id) on delete set null,
  action       text not null check (char_length(action) <= 80),
  entity_type  text check (char_length(entity_type) <= 40),
  entity_id    text check (char_length(entity_id) <= 80),
  company_id   uuid references companies (id) on delete set null,
  details      jsonb not null default '{}'::jsonb,
  ip           inet
);
create index audit_events_time_idx on audit_events (occurred_at desc);
create index audit_events_actor_idx on audit_events (actor_id, occurred_at desc);
create index audit_events_entity_idx on audit_events (entity_type, entity_id);
