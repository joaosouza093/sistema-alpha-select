-- =====================================================================
-- Comunicados: mensagem escrita pela equipe para vários candidatos, por
-- e-mail, enviada na hora ou agendada (a tarefa periódica envia as
-- vencidas). Cada destinatário tem a sua situação; o envio em si é feito
-- pelo servidor e registrado também em message_log.
-- =====================================================================

create table message_campaigns (
  id            uuid primary key default gen_random_uuid(),
  subject       text not null check (char_length(btrim(subject)) between 3 and 200),
  body          text not null check (char_length(btrim(body)) between 10 and 5000),
  process_id    uuid references processes (id) on delete set null,
  scheduled_at  timestamptz not null default now(),
  status        text not null default 'agendada' check (status in ('agendada', 'enviando', 'enviada', 'cancelada')),
  total         integer not null default 0 check (total >= 0),
  sent          integer not null default 0 check (sent >= 0),
  failed        integer not null default 0 check (failed >= 0),
  skipped       integer not null default 0 check (skipped >= 0),
  created_by    uuid references users (id) on delete set null,
  created_at    timestamptz not null default now(),
  finished_at   timestamptz,
  canceled_at   timestamptz
);
create index message_campaigns_due_idx on message_campaigns (scheduled_at) where status in ('agendada', 'enviando');
create index message_campaigns_created_idx on message_campaigns (created_at desc);

create table message_campaign_recipients (
  campaign_id     uuid not null references message_campaigns (id) on delete cascade,
  candidate_id    uuid not null references candidates (id) on delete cascade,
  application_id  uuid references applications (id) on delete set null,
  status          text not null default 'pendente' check (status in ('pendente', 'enviado', 'falhou', 'ignorado')),
  detail          text check (char_length(detail) <= 200),
  sent_at         timestamptz,
  primary key (campaign_id, candidate_id)
);
create index message_campaign_recipients_pending_idx on message_campaign_recipients (campaign_id) where status = 'pendente';

alter table message_campaigns           enable row level security;
alter table message_campaign_recipients enable row level security;

-- Equipe Alpha: cada um vê e cancela os próprios comunicados; o administrador, todos.
create policy campaigns_read on message_campaigns for select to alpha_app
  using (app.is_admin() or (app.is_alpha() and created_by = app.uid()));
create policy campaigns_insert on message_campaigns for insert to alpha_app
  with check (app.is_alpha() and created_by = app.uid() and (process_id is null or app.can_view_process(process_id)));
create policy campaigns_update on message_campaigns for update to alpha_app
  using (app.is_admin() or (app.is_alpha() and created_by = app.uid()))
  with check (app.is_admin() or (app.is_alpha() and created_by = app.uid()));
grant select, insert on message_campaigns to alpha_app;
grant update (status, canceled_at, total) on message_campaigns to alpha_app;

-- Destinatários: só candidatos que quem envia pode ver.
create policy campaign_recipients_read on message_campaign_recipients for select to alpha_app
  using (exists (select 1 from message_campaigns m where m.id = campaign_id));
create policy campaign_recipients_insert on message_campaign_recipients for insert to alpha_app
  with check (
    app.can_view_candidate(candidate_id)
    and exists (select 1 from message_campaigns m where m.id = campaign_id and m.created_by = app.uid() and m.status = 'agendada')
  );
grant select, insert on message_campaign_recipients to alpha_app;

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on message_campaigns, message_campaign_recipients from %I', r);
    end if;
  end loop;
end $$;
