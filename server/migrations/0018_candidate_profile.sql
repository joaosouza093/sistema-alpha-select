-- =====================================================================
-- Perfil completo do candidato (pedido da Alpha Select, out/2026):
-- nascimento, endereço, área de interesse, LinkedIn e formação; e
-- etiquetas livres do banco de talentos (escopo, Módulo 3).
-- =====================================================================

alter table candidates
  add column birth_date         date check (birth_date >= date '1900-01-01'),
  add column address_street     text check (char_length(address_street) <= 160),
  add column address_number     text check (char_length(address_number) <= 20),
  add column address_complement text check (char_length(address_complement) <= 80),
  add column address_district   text check (char_length(address_district) <= 80),
  add column state              text check (state ~ '^[A-Z]{2}$'),
  add column postal_code        text check (postal_code ~ '^[0-9]{8}$'),
  add column desired_role       text check (char_length(desired_role) <= 120),
  add column linkedin_url       text check (char_length(linkedin_url) <= 300 and linkedin_url ~ '^https://([a-z]{2,3}\.)?linkedin\.com/'),
  add column education_level    text check (education_level in (
    'fundamental_incompleto', 'fundamental', 'medio_incompleto', 'medio', 'tecnico',
    'superior_incompleto', 'superior', 'pos_graduacao', 'mestrado', 'doutorado')),
  add column course             text check (char_length(course) <= 120),
  add column institution        text check (char_length(institution) <= 160),
  add column education_status   text check (education_status in ('concluido', 'cursando', 'trancado', 'incompleto')),
  add column tags               text[] not null default '{}' check (cardinality(tags) <= 20);

create index candidates_tags_idx on candidates using gin (tags);
create index candidates_state_idx on candidates (state);

grant update (city, birth_date, address_street, address_number, address_complement, address_district, state, postal_code,
              desired_role, linkedin_url, education_level, course, institution, education_status, tags)
  on candidates to alpha_app;
