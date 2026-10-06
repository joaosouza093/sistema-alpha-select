-- =====================================================================
-- Portal do cliente (entrevistas e retorno) e mensagens por e-mail ao
-- candidato: modelos editáveis, registro de envios, descadastro e
-- lembretes de retorno ao cliente.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Entrevistas e próximos passos (visíveis a quem vê a participação)
-- ---------------------------------------------------------------------
create table interviews (
  id            uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications (id) on delete cascade,
  scheduled_at  timestamptz not null,
  mode          text not null check (mode in ('presencial', 'online', 'telefone')),
  location      text check (char_length(location) <= 300),
  notes         text check (char_length(notes) <= 2000),
  status        text not null default 'agendada' check (status in ('agendada', 'realizada', 'cancelada')),
  created_by    uuid references users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  version       integer not null default 1
);
create index interviews_application_idx on interviews (application_id, scheduled_at);
create trigger interviews_touch before update on interviews
  for each row execute function app.tg_touch_version();

-- Quem pode agendar: equipe Alpha com acesso, ou participante com permissão de mover ou decidir.
create or replace function app.can_schedule(p_application uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((
    select app.can_view_application(a.id)
       and (app.is_alpha() or app.member_perm(a.process_id, 'move') or app.member_perm(a.process_id, 'decide'))
      from applications a where a.id = p_application), false)
$$;
grant execute on function app.can_schedule(uuid) to alpha_app;

alter table interviews enable row level security;
create policy interviews_read on interviews for select to alpha_app using (app.can_view_application(application_id));
create policy interviews_insert on interviews for insert to alpha_app
  with check (app.can_schedule(application_id) and created_by = app.uid());
create policy interviews_update on interviews for update to alpha_app
  using (app.can_schedule(application_id)) with check (app.can_schedule(application_id));
grant select, insert on interviews to alpha_app;
grant update (scheduled_at, mode, location, notes, status) on interviews to alpha_app;

-- ---------------------------------------------------------------------
-- Modelos de mensagem ao candidato (administrador edita)
-- ---------------------------------------------------------------------
create table message_templates (
  key         text primary key check (key in ('candidatura_recebida', 'perfil_enviado', 'entrevista_agendada', 'reprovacao')),
  enabled     boolean not null,
  subject     text not null check (char_length(btrim(subject)) between 3 and 200),
  body        text not null check (char_length(btrim(body)) between 10 and 5000),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references users (id) on delete set null
);
insert into message_templates (key, enabled, subject, body) values
  ('candidatura_recebida', true, 'Candidatura recebida — {{vaga}}',
   E'Olá, {{candidato}}.\n\nRecebemos sua candidatura para a vaga "{{vaga}}". Nossa equipe vai analisar seu perfil e, se ele avançar, entraremos em contato.\n\nAlpha Select Consultoria de Recursos Humanos'),
  ('perfil_enviado', true, 'Seu perfil avançou — {{vaga}}',
   E'Olá, {{candidato}}.\n\nBoa notícia: seu perfil foi apresentado a {{empresa}} para a vaga "{{vaga}}". Assim que houver retorno, entraremos em contato.\n\nAlpha Select Consultoria de Recursos Humanos'),
  ('entrevista_agendada', true, 'Entrevista agendada — {{vaga}}',
   E'Olá, {{candidato}}.\n\nSua entrevista para a vaga "{{vaga}}" foi agendada:\n\nData: {{data_entrevista}}\nFormato: {{formato}}\nLocal/link: {{local}}\n\nEm caso de imprevisto, responda a este e-mail.\n\nAlpha Select Consultoria de Recursos Humanos'),
  ('reprovacao', false, 'Processo seletivo — {{vaga}}',
   E'Olá, {{candidato}}.\n\nAgradecemos seu interesse na vaga "{{vaga}}". Neste momento, seguiremos com outros perfis. Seu currículo continua em nosso banco de talentos para futuras oportunidades.\n\nAlpha Select Consultoria de Recursos Humanos');

alter table message_templates enable row level security;
create policy templates_read on message_templates for select to alpha_app using (app.is_admin());
create policy templates_update on message_templates for update to alpha_app using (app.is_admin()) with check (app.is_admin());
grant select on message_templates to alpha_app;
grant update (enabled, subject, body, updated_at, updated_by) on message_templates to alpha_app;

-- ---------------------------------------------------------------------
-- Registro de mensagens enviadas ao candidato (sem o corpo do e-mail)
-- ---------------------------------------------------------------------
create table message_log (
  id              uuid primary key default gen_random_uuid(),
  channel         text not null default 'email' check (channel in ('email')),
  template_key    text not null,
  candidate_id    uuid not null references candidates (id) on delete cascade,
  application_id  uuid references applications (id) on delete set null,
  to_address      citext not null,
  subject         text not null check (char_length(subject) <= 200),
  ok              boolean not null,
  error           text check (char_length(error) <= 200),
  sent_at         timestamptz not null default now()
);
create index message_log_candidate_idx on message_log (candidate_id, sent_at desc);
create index message_log_time_idx on message_log (sent_at desc);
alter table message_log enable row level security;
create policy message_log_read on message_log for select to alpha_app
  using (app.is_alpha() and app.can_view_candidate(candidate_id));
grant select on message_log to alpha_app;

-- Descadastro de e-mails (o candidato clica no link do rodapé).
alter table candidates
  add column email_opt_out_at  timestamptz,
  add column unsubscribe_token text not null unique
    default replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');

-- Lembretes diários de retorno ao cliente (um por processo por dia).
create table feedback_reminders (
  process_id  uuid not null references processes (id) on delete cascade,
  sent_on     date not null,
  primary key (process_id, sent_on)
);
alter table feedback_reminders enable row level security;
revoke all on feedback_reminders from public;

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on interviews, message_templates, message_log, feedback_reminders from %I', r);
      execute format('revoke all on function app.can_schedule(uuid) from %I', r);
    end if;
  end loop;
end $$;
