-- =====================================================================
-- Preparação do banco no SUPABASE (executar UMA vez no SQL Editor do
-- projeto, ANTES das migrações). Troque as duas senhas por valores fortes
-- e guarde-as somente nas variáveis de ambiente do Netlify.
--
-- Antes: em Database → Extensions, habilite "citext" e "pg_trgm"
-- (esquema "extensions", padrão do Supabase).
-- =====================================================================

-- Proprietário do esquema: migrações, autenticação e scripts administrativos.
create role alpha_owner login password 'TROQUE_SENHA_OWNER_FORTE';
-- Papel da aplicação: sujeito à RLS. Sem BYPASSRLS, sem superusuário.
create role alpha_app login password 'TROQUE_SENHA_APP_FORTE' nosuperuser nobypassrls nocreatedb nocreaterole noinherit;

-- alpha_owner cria o esquema "app" e as tabelas em "public".
grant create on database postgres to alpha_owner;
grant usage, create on schema public to alpha_owner;
-- Tipos citext / pg_trgm ficam no esquema "extensions" no Supabase.
grant usage on schema extensions to alpha_owner, alpha_app;
alter role alpha_owner set search_path = public, extensions;
alter role alpha_app set search_path = public, extensions;
