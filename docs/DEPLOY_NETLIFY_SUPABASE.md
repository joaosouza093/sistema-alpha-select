# Deploy: Netlify + Supabase

| Peça | Onde | Observação |
| --- | --- | --- |
| Frontend (React) | Netlify, estático | `web/dist` |
| API (Fastify) | Netlify Functions, rota `/api/*` | mesmo domínio do site: cookies seguros, CSRF e verificação de origem funcionam sem CORS |
| Limpeza periódica | Netlify Scheduled Function (a cada hora) | sessões e tokens vencidos |
| PostgreSQL + RLS | Supabase | acesso pela aplicação só com os papéis `alpha_app`/`alpha_owner` |
| Documentos | Supabase Storage, bucket **privado** | acesso só pela API, com a chave de serviço guardada no servidor |

> A API automática do Supabase (PostgREST) **não é usada**. A migração `0006` retira qualquer
> privilégio dos papéis `anon`/`authenticated` sobre os objetos da aplicação.

## Estado do ambiente de homologação (30/09/2026)

Projeto Supabase **`alpha-select-homologacao`** (ref `nobrlidvvbbkgjqztesd`, região **sa-east-1 / São Paulo**),
URL `https://nobrlidvvbbkgjqztesd.supabase.co`. Já feito a partir da sessão de desenvolvimento:

- [x] Extensões `citext` e `pg_trgm` (esquema `extensions`).
- [x] Papéis `alpha_owner` e `alpha_app` criados **sem senha** (ninguém entra até você definir as senhas).
- [x] Migrações 0001–0007 aplicadas como `alpha_owner` e registradas em `schema_migrations`.
- [x] Bucket `documentos-candidatos` **privado**, limite de 4 MB e tipos permitidos, sem políticas públicas.
- [x] Verificado: o papel `anon` (API pública do Supabase) tem acesso **negado** a todas as tabelas, à visão e às funções.
- [x] Security Advisor: só resta o aviso INFO “RLS habilitada sem políticas” em sessões, credenciais,
      convites, redefinições, contadores e migrações. É **intencional**: nenhum papel da API acessa essas
      tabelas, apenas o servidor (`alpha_owner`).

Falta fazer por você (envolve segredos, que não devem passar por conversas):
1. Definir as senhas dos papéis (item 1.3 abaixo, só o `alter role`).
2. Baixar o certificado, copiar a chave `service_role` e as strings do pooler (itens 1.4, 1.6 e 1.7).
3. Configurar e publicar o site no Netlify (seção 3).
4. Criar o primeiro administrador (seção 2).

Para definir as senhas, no **SQL Editor** do projeto, troque pelos valores fortes que você gerar:

```sql
alter role alpha_owner password 'SENHA_FORTE_OWNER';
alter role alpha_app   password 'SENHA_FORTE_APP';
```

## 1. Supabase

1. Crie o projeto. Anote a **senha do banco** (usuário `postgres`).
   - **Região:** fique perto da região das funções do Netlify para reduzir a latência. Hospedar os
     dados fora do Brasil é uma **decisão da Alpha Select** (transferência internacional, LGPD).
2. **Database → Extensions**: habilite `citext` e `pg_trgm`.
3. **SQL Editor**: execute `server/scripts/sql/supabase-setup.sql` com duas senhas fortes novas.
   Esse script cria os papéis `alpha_owner` e `alpha_app`. (No projeto de homologação isso já foi feito; falta só definir as senhas.)
4. **Database → Settings → SSL Configuration**: baixe o certificado (CA). Ele será o `DATABASE_SSL_CA`.
5. **Storage → New bucket**: crie `documentos-candidatos` com **Public = desligado**.
   - Não crie políticas de acesso para esse bucket: só a API, com a chave de serviço, acessa.
   - Opcional: limite o tamanho a 4 MB e os tipos a PDF, DOC, DOCX, ODT, PNG e JPEG.
6. **Project Settings → API**: copie a **Project URL** e a chave **service_role** (secreta).
7. **Connect → Connection string**, com o pooler (Supavisor):
   - **Transaction** (porta 6543): use para a aplicação.
   - **Session** (porta 5432): use para migrações e scripts.
   - O usuário tem o formato `papel.<ref-do-projeto>`, por exemplo
     `postgres://alpha_app.abcd1234:SENHA@aws-0-REGIAO.pooler.supabase.com:6543/postgres`.
   - **Não** acrescente `?sslmode=...` às URLs: o TLS é configurado por `DATABASE_SSL`/`DATABASE_SSL_CA`.

## 2. Migrações e primeiro administrador (no seu computador)

```bash
npm ci
export DATABASE_OWNER_URL='postgres://alpha_owner.<ref>:<senha-owner>@<host-pooler>:5432/postgres'
export DATABASE_SSL=true
export DATABASE_SSL_CA="$(cat prod-ca-2021.crt)"      # certificado baixado no passo 1.4
export APP_URL='https://<seu-site>.netlify.app'

npm run db:migrate
npm run admin:create -- --email pessoa@alphaselect.com.br --name "Nome Completo"
```

O último comando mostra **uma vez** o link de convite do primeiro administrador (uso único, 72 h).

## 3. Netlify

1. **Add new site → Import from Git**: escolha o repositório `sistema-alpha-select` e a branch.
   Após mesclar o PR, use `main`.
2. O `netlify.toml` já define o build, a pasta publicada, as funções e os cabeçalhos de segurança.
3. **Site configuration → Environment variables**:

| Variável | Valor | Escopo |
| --- | --- | --- |
| `APP_ENV` | `staging` (homologação) ou `production` | Functions |
| `APP_URL` | `https://<seu-site>.netlify.app` (ou domínio próprio) | Functions |
| `DATABASE_URL` | pooler **transaction** (6543) com `alpha_app.<ref>` | Functions — **secreta** |
| `DATABASE_OWNER_URL` | pooler **transaction** (6543) com `alpha_owner.<ref>` | Functions — **secreta** |
| `DATABASE_SSL` | `true` | Functions |
| `DATABASE_SSL_CA` | conteúdo do certificado (PEM) | Functions |
| `DB_POOL_MAX` | `2` | Functions |
| `STORAGE_DRIVER` | `supabase` | Functions |
| `STORAGE_DIR` | `/tmp/alpha-select` | Functions |
| `SUPABASE_URL` | Project URL | Functions |
| `SUPABASE_SERVICE_ROLE_KEY` | chave service_role | Functions — **secreta** |
| `SUPABASE_BUCKET` | `documentos-candidatos` | Functions |
| `MAIL_MODE` | `manual` (enquanto não houver e-mail configurado) | Functions |
| `SMTP_USER` | e-mail que envia (ex.: Gmail) — ver `CADASTRO_E_COBRANCAS.md` | Functions |
| `SMTP_PASSWORD` | senha de app desse e-mail | Functions — **secreta** |
| `RATE_LIMIT_STORE` | `postgres` | Functions |
| `MAX_UPLOAD_MB` | `4` | Functions |
| `LOG_LEVEL` | `warn` | Functions |

- Só `DATABASE_URL`, `DATABASE_OWNER_URL`, `SUPABASE_SERVICE_ROLE_KEY` e `SMTP_PASSWORD` precisam ser marcadas como
  **secretas** no Netlify. As demais não são segredo; o `netlify.toml` as exclui do scanner de segredos
  (`SECRETS_SCAN_OMIT_KEYS`), que senão bloqueia o build ao achar valores comuns como "warn" no código.
- Nenhuma dessas variáveis começa com `VITE_`: o build do frontend **não** as inclui no navegador.
- O AWS Lambda, que roda as funções, limita o total de variáveis a cerca de 4 KB. A configuração
  acima fica bem abaixo disso.

4. **Deploy site**. Depois, acesse `https://<seu-site>.netlify.app/api/health`: deve responder
   `{"ok":true}`.
5. Abra o link de convite do passo 2, defina a senha e entre.

## 4. Sem e-mail (MAIL_MODE=manual)

O Supabase não envia e-mails da aplicação. Sem SMTP:

- Ao **convidar** ou **reenviar convite**, o administrador vê o link **uma única vez** e o envia por
  canal seguro e individual.
- **Esqueci minha senha** orienta a pessoa a procurar a administração. O administrador usa
  **Usuários → Link de redefinição** (válido por 24 h, uso único).
- Os links não ficam gravados no sistema nem na auditoria. Se um link se perder, gere outro; o
  anterior deixa de valer.

Para enviar e-mails automaticamente, defina `SMTP_USER` e `SMTP_PASSWORD` (uma conta Gmail com
senha de app serve, sem custo). Veja `CADASTRO_E_COBRANCAS.md`.

## 5. Limites desta hospedagem

- A tarefa agendada `manutencao` (a cada hora) também envia os e-mails de cobrança.
- **Upload de até 4 MB** por arquivo: o Netlify Functions limita o corpo da requisição a ~6 MB,
  com codificação. Arquivos maiores exigiriam upload direto ao Storage com URL assinada, o que
  não está implementado.
- **Primeiro acesso mais lento** após um período sem uso (inicialização da função).
- **Tempo máximo por requisição**: cerca de 10 s no plano gratuito do Netlify.
- A chave `service_role` ignora as políticas do Storage. Por isso ela fica só nas variáveis das
  funções, e toda entrega de arquivo passa pela autorização da API.

## 6. Conferência pós-deploy

- [ ] `/api/health` responde `{"ok":true}`.
- [ ] Login funciona e o cookie aparece como `__Host-as_session` (Secure, HttpOnly, SameSite=Strict).
- [ ] Upload de PDF pequeno funciona; o arquivo aparece no bucket com nome aleatório (`ab/uuid`).
- [ ] O bucket está **privado**: a URL pública do objeto retorna erro.
- [ ] `https://<ref>.supabase.co/rest/v1/candidates` com a chave `anon` **não** retorna dados.
- [ ] Siga o roteiro `docs/HOMOLOGACAO.md`.
