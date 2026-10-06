-- =====================================================================
-- Integração com o Asaas (boleto, Pix e cartão) nas cobranças.
-- A cobrança local continua sendo a fonte da verdade; o Asaas gera a
-- página de pagamento e avisa (webhook) quando o cliente paga.
-- gateway_dirty marca alterações locais a enviar ao Asaas (criar,
-- alterar, cancelar, baixa manual); a tarefa periódica tenta de novo.
-- =====================================================================

alter table companies add column asaas_customer_id text check (char_length(asaas_customer_id) <= 60);

alter table charges
  add column gateway_id        text unique check (char_length(gateway_id) <= 60),
  add column gateway_status    text check (char_length(gateway_status) <= 40),
  add column gateway_dirty     boolean not null default false,
  add column gateway_error     text check (char_length(gateway_error) <= 300),
  add column gateway_attempts  smallint not null default 0,
  add column gateway_synced_at timestamptz,
  add column paid_via          text check (paid_via in ('manual', 'asaas'));
create index charges_gateway_dirty_idx on charges (gateway_dirty) where gateway_dirty;

alter table billing_settings add column gateway_enabled boolean not null default false;
grant update (gateway_enabled) on billing_settings to alpha_app;
grant update (gateway_dirty, gateway_attempts, gateway_error, paid_via) on charges to alpha_app;
