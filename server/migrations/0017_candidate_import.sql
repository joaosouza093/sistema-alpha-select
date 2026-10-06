-- =====================================================================
-- Importação de candidatos por planilha (migração do banco de currículos
-- e importação autorizada citada no escopo). Nova origem "importacao".
-- =====================================================================

alter table candidates drop constraint candidates_source_check;
alter table candidates
  add constraint candidates_source_check check (source in ('interno', 'portal', 'importacao'));
