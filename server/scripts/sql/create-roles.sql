-- Executar UMA vez por ambiente, como superusuário/administrador do PostgreSQL,
-- ANTES das migrações. Troque as senhas por valores fortes e guarde-as no
-- gerenciador de segredos do ambiente (nunca no repositório).
--
--   psql "<url de administrador>" -v owner_pw="'...'" -v app_pw="'...'" -f create-roles.sql

-- Proprietário do esquema: migrações, autenticação e scripts administrativos.
create role alpha_owner login password :owner_pw;
-- Papel da aplicação: sujeito à RLS. Não pode ser superusuário nem ter BYPASSRLS.
create role alpha_app login password :app_pw nosuperuser nobypassrls nocreatedb nocreaterole noinherit;

-- Banco (ajuste o nome por ambiente: alpha_dev, alpha_homolog, alpha_prod)
-- create database alpha_prod owner alpha_owner;
-- revoke all on database alpha_prod from public;
-- grant connect on database alpha_prod to alpha_app;
