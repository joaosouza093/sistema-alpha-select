-- =====================================================================
-- Pedido da Alpha Select (out/2026):
--  • novas categorias de documento: antecedentes criminais e processos;
--  • dados pessoais para admissão, preenchidos pelo próprio candidato
--    (área "Meus dados") somente depois da aprovação no processo, com o
--    termo de consentimento (LGPD). Só a equipe Alpha com acesso ao
--    candidato lê; o cliente nunca vê. Escrita apenas pelo servidor.
-- =====================================================================

alter type document_kind add value if not exists 'antecedentes_criminais';
alter type document_kind add value if not exists 'processos';

-- Link enviado ao candidato aprovado (vale mais que o de acesso comum).
alter table candidate_access_tokens drop constraint candidate_access_tokens_purpose_check;
alter table candidate_access_tokens
  add constraint candidate_access_tokens_purpose_check check (purpose in ('acesso', 'retencao', 'admissao'));

create table candidate_admission_data (
  candidate_id      uuid primary key references candidates (id) on delete cascade,
  full_name         text not null check (char_length(btrim(full_name)) between 2 and 160),
  birth_date        date not null check (birth_date >= date '1900-01-01'),
  sex               text not null check (sex in ('feminino', 'masculino', 'outro', 'nao_informado')),
  marital_status    text not null check (marital_status in ('solteiro', 'casado', 'uniao_estavel', 'divorciado', 'separado', 'viuvo')),
  nationality       text not null check (char_length(btrim(nationality)) between 2 and 60),
  birthplace_city   text not null check (char_length(btrim(birthplace_city)) between 2 and 120),
  birthplace_state  text not null check (birthplace_state ~ '^[A-Z]{2}$'),
  cpf               text not null check (cpf ~ '^[0-9]{11}$'),
  rg                text not null check (char_length(btrim(rg)) between 3 and 20),
  rg_issuer         text not null check (char_length(btrim(rg_issuer)) between 2 and 20),
  rg_state          text not null check (rg_state ~ '^[A-Z]{2}$'),
  rg_issue_date     date not null check (rg_issue_date >= date '1900-01-01'),
  address           text not null check (char_length(btrim(address)) between 10 and 300),
  mobile_phone      text not null check (mobile_phone ~ '^\+[0-9]{10,15}$'),
  mother_name       text not null check (char_length(btrim(mother_name)) between 2 and 160),
  father_name       text check (char_length(father_name) <= 160),
  consent_text      text not null check (char_length(consent_text) <= 1000),
  consent_at        timestamptz not null,
  submitted_at      timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

alter table candidate_admission_data enable row level security;
create policy admission_read on candidate_admission_data for select to alpha_app
  using (app.is_alpha() and app.can_view_candidate(candidate_id));
grant select on candidate_admission_data to alpha_app;

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on candidate_admission_data from %I', r);
    end if;
  end loop;
end $$;
