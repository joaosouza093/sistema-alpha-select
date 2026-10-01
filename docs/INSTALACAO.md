# Instalação, configuração e publicação

## Ambientes

Use **três ambientes separados**, cada um com banco, diretório de arquivos, segredos e
URL próprios. Nunca use dados reais de candidatos em desenvolvimento.

| Ambiente | `APP_ENV` | Banco sugerido | Dados |
| --- | --- | --- | --- |
| Desenvolvimento | `development` | `alpha_dev` | somente fictícios (`db:seed-dev`) |
| Homologação | `staging` | `alpha_homolog` | fictícios ou anonimizados |
| Produção | `production` | `alpha_prod` | reais |

Em `staging`/`production` a aplicação **recusa iniciar** sem `https` em `APP_URL` e sem
`SMTP_URL`. O seed de desenvolvimento recusa executar fora de `development`.

## 1. Banco de dados

Requer PostgreSQL 14+ com as extensões `citext` e `pg_trgm` (disponíveis na maioria dos
provedores gerenciados; são extensões "trusted" que o dono do banco pode criar).

Como administrador do PostgreSQL, crie os dois papéis e o banco
(`server/scripts/sql/create-roles.sql`):

```bash
psql "$URL_ADMIN" -v owner_pw="'SENHA_FORTE_1'" -v app_pw="'SENHA_FORTE_2'" -f server/scripts/sql/create-roles.sql
psql "$URL_ADMIN" -c "create database alpha_prod owner alpha_owner"
psql "$URL_ADMIN" -c "revoke all on database alpha_prod from public; grant connect on database alpha_prod to alpha_app"
```

- `alpha_owner`: dono do esquema. Usado por migrações, autenticação e scripts.
- `alpha_app`: **sem** `BYPASSRLS`/superusuário. Usado em todas as operações de usuário.

Os nomes dos papéis são fixos nas migrações (`alpha_app`).

## 2. Configuração

Copie `server/.env.example` para `server/.env` (ou configure as variáveis no provedor).
Variáveis principais:

| Variável | Descrição |
| --- | --- |
| `APP_ENV` | `development`, `staging` ou `production` |
| `APP_URL` | URL pública (links de convite/recuperação). `https` em homologação/produção |
| `DATABASE_URL` | Conexão como `alpha_app` |
| `DATABASE_OWNER_URL` | Conexão como `alpha_owner` |
| `DATABASE_SSL` | `true` para exigir TLS com verificação de certificado |
| `STORAGE_DIR` | Diretório privado e persistente dos arquivos (fora de pasta pública) |
| `MAX_UPLOAD_MB` | Limite de upload (padrão 10) |
| `SMTP_URL`, `MAIL_FROM` | Envio de convites e recuperação de senha |
| `TRUST_PROXY` | `true` atrás de proxy reverso confiável (IP correto para limites) |
| `CORS_ORIGINS` | Vazio (padrão) = somente a mesma origem |
| `SESSION_ABSOLUTE_HOURS`, `SESSION_IDLE_MINUTES` | 12 h e 120 min por padrão |
| `WEB_DIST_DIR` | Pasta do frontend compilado servida pelo backend |

Segredos ficam somente no servidor/gerenciador de segredos do provedor. O frontend não
recebe nenhuma chave.

## 3. Migrações

```bash
npm ci
npm run db:migrate        # usa DATABASE_OWNER_URL
```

Cada migração roda em transação e tem checksum; alterar uma migração já aplicada é
recusado (crie uma nova).

## 4. Primeiro administrador (procedimento seguro)

Não há senha administrativa fixa nem cadastro público.

```bash
npm run admin:create -- --email pessoa@alphaselect.com.br --name "Nome Completo"
```

1. O script cria o usuário `alpha_admin` e um **convite de uso único válido por 72 h**.
2. O link é exibido **somente no terminal** de quem executou. Envie-o à pessoa por canal
   seguro (não por grupos ou chats compartilhados) e limpe o histórico do terminal se for
   compartilhado.
3. A pessoa abre o link e define a própria senha (mín. 10 caracteres).
4. Se já existir administrador ativo, o script exige `--additional`; o normal é criar
   os demais pela tela **Usuários e convites**.
5. A criação fica registrada na auditoria (`admin.provisioned_cli`).

## 5. Build e execução

```bash
npm run build                          # servidor (tsc) e web (vite)
cd server && node dist/src/index.js    # serve API + frontend (WEB_DIST_DIR)
```

Ou com Docker (imagem única, usuário não-root, volume para arquivos):

```bash
docker build -t alpha-select .
docker run --env-file server/.env -e WEB_DIST_DIR=/app/web/dist \
  -v alpha_storage:/data/storage -p 3000:3000 alpha-select
# migrações a partir da imagem:
docker run --env-file server/.env alpha-select node dist/scripts/migrate.js
```

Coloque um proxy reverso com TLS (HTTPS) na frente e defina `TRUST_PROXY=true`.

## 6. Tarefas periódicas

- Sessões expiradas e tokens vencidos são limpos automaticamente a cada hora.
- Execute `npm run storage:cleanup -w server` periodicamente (ex.: diariamente) para
  relatório de órfãos; use `-- --apply` para removê-los.

## 7. Publicação

Nenhum ambiente de hospedagem foi disponibilizado/autorizado durante o desenvolvimento;
portanto **não houve publicação**. Para publicar é necessário:

1. Servidor ou serviço de contêiner com Node.js 22 (ou Docker) e disco persistente para `STORAGE_DIR`.
2. PostgreSQL gerenciado (com backups automáticos e criptografia em repouso habilitados).
3. Domínio com certificado TLS (ex.: `sistema.alphaselect.com.br`).
4. Conta SMTP transacional (remetente do domínio da Alpha Select, com SPF/DKIM).
5. Execução dos passos 1–4 acima e do roteiro de homologação.

### Netlify + Supabase

Há suporte completo a essa hospedagem (API em Netlify Functions, banco e documentos no Supabase):
ver [DEPLOY_NETLIFY_SUPABASE.md](DEPLOY_NETLIFY_SUPABASE.md).

### Sobre Lovable

O projeto não usa Lovable; por isso não há selo “Edit with Lovable”.
