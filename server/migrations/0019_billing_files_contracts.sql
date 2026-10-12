-- =====================================================================
-- Contratos das empresas clientes e anexos financeiros (boleto e nota
-- fiscal da cobrança, contrato assinado). O gestor da empresa cliente
-- consulta as cobranças, os anexos e os contratos da própria empresa.
-- =====================================================================

create table contracts (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies (id) on delete restrict,
  plan          text not null check (char_length(btrim(plan)) between 2 and 120),
  modality      text not null check (modality in ('mensalidade', 'pacote', 'sucesso', 'outro')),
  amount_cents  integer check (amount_cents > 0 and amount_cents <= 1000000000),
  start_date    date not null,
  end_date      date check (end_date >= start_date),
  status        text not null default 'ativo' check (status in ('ativo', 'suspenso', 'encerrado')),
  owner_id      uuid references users (id) on delete set null,
  notes         text check (char_length(notes) <= 2000),
  created_by    uuid references users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  version       integer not null default 1
);
create index contracts_company_idx on contracts (company_id, start_date desc);
create trigger contracts_touch before update on contracts
  for each row execute function app.tg_touch_version();

-- Um arquivo por tipo: boleto e nota fiscal da cobrança; contrato assinado.
create table billing_files (
  id             uuid primary key default gen_random_uuid(),
  charge_id      uuid references charges (id) on delete cascade,
  contract_id    uuid references contracts (id) on delete cascade,
  kind           text not null check (kind in ('boleto', 'nota_fiscal', 'contrato')),
  storage_key    text not null unique check (storage_key ~ '^[0-9a-f]{2}/[0-9a-f-]{36}$'),
  original_name  text not null check (char_length(original_name) between 1 and 255),
  mime_type      text not null check (char_length(mime_type) <= 120),
  size_bytes     integer not null check (size_bytes > 0),
  sha256         text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_by    uuid references users (id) on delete set null,
  created_at     timestamptz not null default now(),
  check ((kind = 'contrato') = (contract_id is not null and charge_id is null)),
  check ((kind <> 'contrato') = (charge_id is not null and contract_id is null))
);
create unique index billing_files_charge_kind_uq on billing_files (charge_id, kind) where charge_id is not null;
create unique index billing_files_contract_uq on billing_files (contract_id) where contract_id is not null;

-- ---------------------------------------------------------------------
-- Acesso
-- ---------------------------------------------------------------------
alter table contracts     enable row level security;
alter table billing_files enable row level security;

create or replace function app.is_client_manager_of(p_company uuid) returns boolean
language sql stable set search_path = public, pg_temp as $$
  select coalesce(app.kind() = 'client_manager' and app.company_id() = p_company, false)
$$;
revoke all on function app.is_client_manager_of(uuid) from public;
grant execute on function app.is_client_manager_of(uuid) to alpha_app;

-- Cobranças: o gestor da empresa cliente lê as da própria empresa.
create policy charges_client_read on charges for select to alpha_app using (app.is_client_manager_of(company_id));

create policy contracts_read on contracts for select to alpha_app
  using (app.is_admin() or app.is_client_manager_of(company_id));
create policy contracts_insert on contracts for insert to alpha_app with check (app.is_admin());
create policy contracts_update on contracts for update to alpha_app using (app.is_admin()) with check (app.is_admin());
create policy contracts_delete on contracts for delete to alpha_app using (app.is_admin());
grant select, insert, delete on contracts to alpha_app;
grant update (plan, modality, amount_cents, start_date, end_date, status, owner_id, notes) on contracts to alpha_app;

create policy billing_files_read on billing_files for select to alpha_app
  using (
    app.is_admin()
    or exists (select 1 from charges c where c.id = charge_id and app.is_client_manager_of(c.company_id))
    or exists (select 1 from contracts k where k.id = contract_id and app.is_client_manager_of(k.company_id))
  );
create policy billing_files_insert on billing_files for insert to alpha_app with check (app.is_admin());
create policy billing_files_delete on billing_files for delete to alpha_app using (app.is_admin());
grant select, insert, delete on billing_files to alpha_app;

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on contracts, billing_files from %I', r);
      execute format('revoke all on function app.is_client_manager_of(uuid) from %I', r);
    end if;
  end loop;
end $$;
