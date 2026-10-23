-- =====================================================================
-- Pedido da Alpha Select (out/2026): o Financeiro (cobranças, boleto,
-- nota fiscal e contratos) fica visível a todos os usuários ativos da
-- empresa cliente, não só ao Gestor/CEO. Cada um continua vendo somente
-- a própria empresa.
-- =====================================================================

create or replace function app.is_client_of(p_company uuid) returns boolean
language sql stable set search_path = public, pg_temp as $$
  select coalesce(app.kind() in ('client_manager', 'client_user') and app.company_id() = p_company, false)
$$;
revoke all on function app.is_client_of(uuid) from public;
grant execute on function app.is_client_of(uuid) to alpha_app;

alter policy charges_client_read on charges using (app.is_client_of(company_id));

alter policy contracts_read on contracts using (app.is_admin() or app.is_client_of(company_id));

alter policy billing_files_read on billing_files
  using (
    app.is_admin()
    or exists (select 1 from charges c where c.id = charge_id and app.is_client_of(c.company_id))
    or exists (select 1 from contracts k where k.id = contract_id and app.is_client_of(k.company_id))
  );

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function app.is_client_of(uuid) from %I', r);
    end if;
  end loop;
end $$;
