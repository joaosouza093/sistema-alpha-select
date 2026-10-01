-- Armazenamento alternativo dos arquivos dentro do próprio PostgreSQL
-- (usado quando o Supabase Storage não está configurado). Acesso exclusivo
-- do papel proprietário (servidor); nenhum privilégio para alpha_app,
-- anon ou authenticated. Conteúdo criptografado em repouso pelo provedor
-- do banco e incluído nos backups do banco.
create table if not exists document_blobs (
  storage_key  text primary key check (storage_key ~ '^[0-9a-f]{2}/[0-9a-f-]{36}$'),
  content      bytea not null,
  created_at   timestamptz not null default now()
);
alter table document_blobs enable row level security;
revoke all on document_blobs from public;
