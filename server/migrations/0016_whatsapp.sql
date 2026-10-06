-- =====================================================================
-- WhatsApp (API oficial da Meta — WhatsApp Cloud API).
-- Mensagens iniciadas pela empresa exigem modelos aprovados pela Meta;
-- aqui fica só o NOME do modelo aprovado e se ele está ativo. O envio ao
-- candidato exige autorização dele (whatsapp_opt_in_at), dada no
-- formulário de candidatura ou na área Meus dados, e "SAIR" cancela.
-- =====================================================================

alter table message_templates
  add column wa_enabled  boolean not null default false,
  add column wa_template text check (wa_template ~ '^[a-z0-9_]+$' and char_length(wa_template) <= 512),
  add column wa_language text not null default 'pt_BR' check (wa_language ~ '^[a-z]{2,3}(_[A-Z]{2})?$');
grant update (wa_enabled, wa_template, wa_language) on message_templates to alpha_app;

alter table candidates add column whatsapp_opt_in_at timestamptz;

alter table message_log drop constraint message_log_channel_check;
alter table message_log
  add constraint message_log_channel_check check (channel in ('email', 'whatsapp')),
  add column provider_id     text unique check (char_length(provider_id) <= 200),
  add column delivery_status text check (delivery_status in ('enviada', 'entregue', 'lida', 'falhou'));

-- Cobranças: número de WhatsApp do financeiro da empresa e modelos por tipo de aviso.
alter table companies add column billing_whatsapp text check (billing_whatsapp ~ '^\+?[0-9]{8,15}$');
grant update (billing_whatsapp) on companies to alpha_app;

alter table billing_settings
  add column wa_enabled   boolean not null default false,
  add column wa_templates jsonb not null default '{}'::jsonb check (jsonb_typeof(wa_templates) = 'object');
grant update (wa_enabled, wa_templates) on billing_settings to alpha_app;

alter table charge_notifications
  add column channel text not null default 'email' check (channel in ('email', 'whatsapp'));
