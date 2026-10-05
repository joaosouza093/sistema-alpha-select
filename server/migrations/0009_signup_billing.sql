-- =====================================================================
-- Cadastro de empresas pelo site (sempre com aprovação do administrador)
-- e cobranças com e-mails automáticos.
-- Somente administradores acessam essas tabelas (RLS + privilégios).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Dados de faturamento da empresa cliente
-- ---------------------------------------------------------------------
alter table companies
  add column cnpj text check (cnpj ~ '^[0-9]{14}$'),
  add column billing_email citext
    check (char_length(billing_email) <= 254 and billing_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$');
create unique index companies_cnpj_uq on companies (cnpj) where cnpj is not null;
grant update (cnpj, billing_email) on companies to alpha_app;

-- ---------------------------------------------------------------------
-- Pedidos de cadastro. A pessoa confirma o e-mail e o administrador
-- aprova: só então a empresa e o usuário são criados. O hash da senha é
-- apagado assim que o pedido é decidido.
-- ---------------------------------------------------------------------
create table signup_requests (
  id                 uuid primary key default gen_random_uuid(),
  company_name       text not null check (char_length(btrim(company_name)) between 2 and 160),
  cnpj               text check (cnpj ~ '^[0-9]{14}$'),
  full_name          text not null check (char_length(btrim(full_name)) between 2 and 120),
  email              citext not null
                     check (char_length(email) <= 254 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone              text check (char_length(phone) <= 20),
  password_hash      text,
  status             text not null default 'pendente' check (status in ('pendente', 'aprovado', 'recusado')),
  email_verified_at  timestamptz,
  verify_token_hash  bytea unique,
  verify_expires_at  timestamptz,
  consent_at         timestamptz not null,
  ip                 inet,
  created_at         timestamptz not null default now(),
  decided_at         timestamptz,
  decided_by         uuid references users (id) on delete set null,
  decision_note      text check (char_length(decision_note) <= 500),
  company_id         uuid references companies (id) on delete set null,
  user_id            uuid references users (id) on delete set null,
  check ((status = 'pendente') = (decided_at is null)),
  check (status = 'pendente' or password_hash is null)
);
create unique index signup_requests_pending_email_uq on signup_requests (email) where status = 'pendente';
create index signup_requests_status_idx on signup_requests (status, created_at desc);

-- ---------------------------------------------------------------------
-- Cobranças
-- ---------------------------------------------------------------------
create type charge_status as enum ('pendente', 'pago', 'cancelado');

-- Configuração única (linha fixa): dados de pagamento e regras dos lembretes.
create table billing_settings (
  id                     boolean primary key default true check (id),
  auto_email             boolean not null default true,
  pix_key                text check (char_length(pix_key) <= 140),
  beneficiary            text check (char_length(beneficiary) <= 140),
  instructions           text check (char_length(instructions) <= 2000),
  reminder_days_before   smallint not null default 3 check (reminder_days_before between 0 and 30),
  overdue_every_days     smallint not null default 7 check (overdue_every_days between 1 and 60),
  overdue_max_reminders  smallint not null default 3 check (overdue_max_reminders between 0 and 12),
  updated_at             timestamptz not null default now(),
  updated_by             uuid references users (id) on delete set null
);
insert into billing_settings default values;

create table charges (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references companies (id) on delete restrict,
  description       text not null check (char_length(btrim(description)) between 2 and 200),
  amount_cents      integer not null check (amount_cents > 0),
  due_date          date not null,
  billing_email     citext not null
                    check (char_length(billing_email) <= 254 and billing_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  payment_link      text check (payment_link ~ '^https://' and char_length(payment_link) <= 500),
  status            charge_status not null default 'pendente',
  paid_at           timestamptz,
  paid_note         text check (char_length(paid_note) <= 300),
  canceled_at       timestamptz,
  reminders_paused  boolean not null default false,
  -- Recorrência mensal: cada cobrança da série guarda a data inicial e o número da parcela,
  -- para que o dia do vencimento não "escorregue" em meses mais curtos.
  recurrence        text not null default 'nenhuma' check (recurrence in ('nenhuma', 'mensal')),
  series_id         uuid not null default gen_random_uuid(),
  series_start      date not null,
  series_index      integer not null default 0 check (series_index >= 0),
  next_generated    boolean not null default false,
  batch_id          uuid,
  created_by        uuid references users (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  version           integer not null default 1,
  check ((status = 'pago') = (paid_at is not null)),
  check ((status = 'cancelado') = (canceled_at is not null)),
  unique (series_id, series_index)
);
create index charges_company_idx on charges (company_id, due_date desc);
create index charges_status_due_idx on charges (status, due_date);

create trigger charges_touch before update on charges
  for each row execute function app.tg_touch_version();

-- Registro de cada e-mail de cobrança (enviado ou com falha).
create table charge_notifications (
  id         uuid primary key default gen_random_uuid(),
  charge_id  uuid not null references charges (id) on delete cascade,
  kind       text not null check (kind in ('criada', 'lembrete', 'vencimento', 'atraso', 'pagamento', 'manual')),
  sent_to    citext not null,
  ok         boolean not null,
  error      text check (char_length(error) <= 200),
  sent_at    timestamptz not null default now()
);
create index charge_notifications_charge_idx on charge_notifications (charge_id, sent_at desc);

-- ---------------------------------------------------------------------
-- Acesso: somente administradores (papel da aplicação, sujeito à RLS).
-- E-mails automáticos e aprovação de cadastro rodam no servidor.
-- ---------------------------------------------------------------------
alter table signup_requests      enable row level security;
alter table billing_settings     enable row level security;
alter table charges              enable row level security;
alter table charge_notifications enable row level security;

create policy signup_read on signup_requests for select to alpha_app using (app.is_admin());
grant select (id, company_name, cnpj, full_name, email, phone, status, email_verified_at, created_at,
              decided_at, decided_by, decision_note, company_id, user_id)
  on signup_requests to alpha_app;

create policy billing_settings_read on billing_settings for select to alpha_app using (app.is_admin());
create policy billing_settings_update on billing_settings for update to alpha_app
  using (app.is_admin()) with check (app.is_admin());
grant select on billing_settings to alpha_app;
grant update (auto_email, pix_key, beneficiary, instructions, reminder_days_before, overdue_every_days,
              overdue_max_reminders, updated_at, updated_by)
  on billing_settings to alpha_app;

create policy charges_read on charges for select to alpha_app using (app.is_admin());
create policy charges_insert on charges for insert to alpha_app with check (app.is_admin());
create policy charges_update on charges for update to alpha_app using (app.is_admin()) with check (app.is_admin());
grant select, insert on charges to alpha_app;
grant update (description, amount_cents, due_date, billing_email, payment_link, status, paid_at, paid_note,
              canceled_at, reminders_paused, recurrence)
  on charges to alpha_app;

create policy charge_notifications_read on charge_notifications for select to alpha_app using (app.is_admin());
grant select on charge_notifications to alpha_app;

-- Mesma proteção da 0006: nada exposto aos papéis da API automática do Supabase.
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on signup_requests, billing_settings, charges, charge_notifications from %I', r);
    end if;
  end loop;
end $$;
