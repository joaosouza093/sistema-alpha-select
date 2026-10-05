# Arquitetura

## Visão geral

```
Navegador (React SPA)
   │  cookie de sessão httpOnly + cabeçalho X-CSRF-Token (mesma origem)
   ▼
Fastify (Node.js) ── validação Zod ── regras de negócio por módulo
   │                                   │
   │ papel alpha_owner (privilegiado)  │ papel alpha_app (RLS obrigatória)
   │  • sessões, senhas, convites      │  • toda leitura/escrita de dados de negócio
   │  • migrações e scripts            │  • set_config('app.user_id') por transação
   ▼                                   ▼
PostgreSQL ── políticas RLS + gatilhos de integridade + auditoria somente-inserção
Disco privado (STORAGE_DIR) ── arquivos com nome aleatório, entregues só pelo backend
```

Em homologação/produção o backend também serve o frontend compilado, de modo que
aplicação e API ficam na **mesma origem** (sem CORS, cookies `__Host-` com `Secure`).

## Organização do código

```
server/
  migrations/           SQL versionado (esquema, gatilhos, RLS, privilégios)
  scripts/              migrate, create-admin, seed-dev (só desenvolvimento), storage-cleanup
  src/
    app.ts              montagem do servidor: cabeçalhos, CORS, sessão/CSRF, erros
    config.ts           variáveis de ambiente validadas
    lib/                banco (withUser), crypto, validação, limites, e-mail, storage
    modules/
      auth/             login, sessões, convites, recuperação/troca de senha
      users/  companies/  processes/  candidates/  applications/ (etapas, comentários, histórico)
      documents/  dashboard/  audit/
  test/                 testes de integração (banco real, usuários distintos)
web/src/
  api/                  cliente HTTP (CSRF, erros) e tipos
  auth/                 contexto de sessão
  components/           componentes reutilizáveis (ui, MoveDialog, DocumentPreview)
  layout/               estrutura, navegação, rodapé
  pages/                telas por módulo
e2e/                    testes Playwright
```

## Defesa em camadas

1. **Rota**: sessão válida exigida em toda a API (exceto login/convite/recuperação);
   CSRF em métodos de escrita; origem verificada.
2. **Serviço**: validação estrita (campos desconhecidos são recusados), checagem de
   perfil, controle de versão otimista.
3. **Banco**: cada transação roda como `alpha_app` com `app.user_id` definido a partir
   da sessão. Perfil, empresa e escopo são **derivados do banco** (`app.kind()`,
   `app.company_id()`, `app.is_member()`), considerando usuário e empresa ativos.
   Políticas RLS filtram linhas; privilégios por coluna impedem alterar campos
   privilegiados; gatilhos validam transições, decisões, responsáveis e vínculos.

Se uma verificação do serviço falhar por erro de programação, a RLS ainda impede o
vazamento — isso foi verificado nos testes de mutação (ver `TESTES.md`).

## Modelo de dados

| Tabela | Finalidade | Regras principais |
| --- | --- | --- |
| `companies` | Empresas clientes | Nome único; desativar revoga acesso dos usuários |
| `users` | Usuários (sem credenciais) | `kind` ∈ admin/equipe/cliente/gestor; cliente ⇔ empresa (CHECK); último admin protegido |
| `user_credentials`, `sessions`, `invites`, `password_resets` | Autenticação | Sem acesso para `alpha_app`; tokens guardados apenas como hash SHA-256 |
| `stages` | Etapas do fluxo | 4 etapas iniciais, ordenadas |
| `processes` | Processos por empresa | Empresa imutável; versão para concorrência |
| `process_members` | Participantes autorizados | Usuário de cliente só em processo da própria empresa (gatilho); flags `can_move_stage`, `can_decide`, `can_comment` |
| `candidates` | Cadastro interno Alpha | Clientes nunca leem esta tabela |
| `applications` | Participação candidato×processo | Única por par; etapa, decisão, responsável, flags de compartilhamento, versão |
| `documents` | Arquivos do candidato | Chave interna aleatória; SHA-256; sem update |
| `application_documents` | Compartilhamento por participação | FK composta garante mesmo candidato do documento e da participação |
| `comments` | Comentários | `internal` (padrão) ou `shared`; autor e visibilidade imutáveis |
| `application_history` | Movimentações | Gravado por gatilho na mesma transação; somente leitura |
| `audit_events` | Auditoria | Somente inserção (gatilho bloqueia update/delete) |
| visão `shared_application_candidates` | Dados do candidato por participação | Mascara e-mail/telefone/pretensão não compartilhados; nunca inclui observações |

### Candidato × participação × compartilhamento

- O **cadastro** (`candidates`) é interno da Alpha Select.
- Cada entrada em um processo é uma **participação** (`applications`) própria, com
  etapa, decisão, responsável, comentários e histórico próprios.
- O que o cliente vê é definido **por participação**: nome sempre; e-mail, telefone
  e pretensão somente se marcados; resumo escrito para o cliente; documentos
  vinculados e marcados como compartilhados. Liberar algo em uma participação não
  libera nada em outra, nem o cadastro, nem outras candidaturas.

### Concorrência

Participações, candidatos e processos têm coluna `version`. Toda alteração envia
`expectedVersion`; o `UPDATE ... WHERE version = $n` falha com **409** se outra
pessoa alterou antes, e nada é sobrescrito silenciosamente. Etapa, decisão e
histórico são gravados na mesma transação.

### Eventos em tempo real

Não há canal em tempo real nesta versão (as telas atualizam ao navegar/focar a janela).
Isso elimina esse vetor de vazamento. Se for adicionado no futuro, cada evento deve
ser filtrado pela mesma função de acesso (`app.can_view_process`) e nunca carregar
comentários internos para usuários de cliente.

## Documentos

- Upload em streaming para arquivo temporário (permissão 600), com limite de tamanho.
- Validação: extensão permitida + MIME declarado + **assinatura do conteúdo**
  (`file-type`) + cabeçalho PDF. Aceitos: PDF, DOC, DOCX, ODT, PNG, JPG. HTML/SVG nunca.
- Registro no banco e movimentação do arquivo na mesma transação; se o commit falhar,
  o arquivo é removido. `storage:cleanup` reconcilia órfãos e temporários.
- Entrega pelo servidor (`/api/documents/:id/content`) após autorização a cada
  acesso, com `no-store`, `nosniff` e, para formatos não-PDF, CSP `sandbox`. Não há
  links assinados: a revogação tem efeito imediato.
