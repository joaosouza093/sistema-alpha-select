# Alpha Select — Gestão de candidatos e processos seletivos

Sistema web para a Alpha Select Consultoria de Recursos Humanos gerenciar candidatos,
processos seletivos por empresa cliente, fluxo de etapas, documentos privados e
comentários, com acesso controlado da equipe Alpha Select e de clientes autorizados.

> Tecnologia desenvolvida pela PMG Code.

## Stack

| Camada | Tecnologia |
| --- | --- |
| Frontend | React 19 + TypeScript + Vite, React Router, TanStack Query, CSS com tokens |
| Backend | Node.js 22 + Fastify 5 + TypeScript, validação com Zod |
| Banco | PostgreSQL 16 com migrações SQL versionadas e **Row Level Security** |
| Autenticação | Sessões no servidor (cookie `httpOnly`, `SameSite=Strict`), CSRF, convites de uso único |
| Arquivos | Armazenamento privado em disco, entregue somente pelo backend após autorização |
| Testes | Vitest (integração com banco real) + Playwright (navegador) |

## Início rápido (desenvolvimento)

Pré-requisitos: Node.js 22+, PostgreSQL 14+.

```bash
npm install
# 1. papéis e banco (uma vez) — ver docs/INSTALACAO.md
# 2. configuração
cp server/.env.example server/.env   # ajuste senhas/URLs
npm run db:migrate
npm run db:seed-dev                  # opcional: dados FICTÍCIOS, senhas aleatórias
npm run dev:server                   # API em http://127.0.0.1:3000
npm run dev:web                      # interface em http://localhost:5173
```

## Comandos

| Comando | Função |
| --- | --- |
| `npm run typecheck` | Verificação de tipos (servidor e web) |
| `npm run build` | Build de produção (servidor e web) |
| `npm test` | 73 testes de integração do backend (recria o banco `alpha_test`) |
| `npm run test:e2e` | 8 testes no navegador (requer servidor em `localhost:3000`) |
| `npm run db:migrate` | Aplica migrações pendentes |
| `npm run admin:create -- --email ... --name "..."` | Provisiona o primeiro administrador (convite) |
| `npm run storage:cleanup -w server` | Relatório/limpeza de arquivos órfãos |

## Documentação

- [Escopo, requisitos e critérios de aceite](docs/ESCOPO_E_CRITERIOS.md)
- [Arquitetura e modelo de dados](docs/ARQUITETURA.md)
- [Matriz de permissões](docs/PERMISSOES.md)
- [Instalação, configuração, primeiro administrador e publicação](docs/INSTALACAO.md)
- [Segurança, proteção de dados, backup e incidentes](docs/SEGURANCA_E_LGPD.md)
- [Roteiro de homologação](docs/HOMOLOGACAO.md)
- [Testes executados](docs/TESTES.md)
- [Pendências, premissas e limitações](docs/PENDENCIAS.md)
- [Identidade visual oficial (arquivos, paleta, contraste e substituição)](docs/IDENTIDADE_VISUAL.md)
