# Testes executados

Execução em 05/10/2026, PostgreSQL 16 local, Node.js 22, Chromium (Playwright 1.63).

| Verificação | Comando | Resultado |
| --- | --- | --- |
| Tipos (servidor e web) | `npm run typecheck` | ✅ sem erros |
| Build de produção | `npm run build` | ✅ |
| Integração do backend | `npm test` | ✅ **117/117** |
| Integração no layout do Supabase | `TEST_SUPABASE_LAYOUT=1 npm test` | ✅ **117/117** (extensões em `extensions`, papéis `anon`/`authenticated` sem acesso) |
| Empacotamento Netlify Functions | `npm run check:netlify` | ✅ |
| Navegador (desktop + celular) | `npm run test:e2e` | ✅ **8/8** |
| Dependências de produção | `npm audit --omit=dev` | ✅ 0 vulnerabilidades |
| Servidor compilado em modo `staging` | manual | ✅ HSTS, CSP, `noindex`; recusa sem https/SMTP; recusa origem externa |
| Teste de mutação | política RLS de comentários enfraquecida de propósito | ✅ 3 testes falharam (detectado); código restaurado |

Os testes de integração recriam o banco `alpha_test`, aplicam todas as migrações e agem
**via HTTP com usuários distintos** (admin, equipe, clientes de empresas diferentes,
gestor). A única ação feita diretamente no banco é a criação do primeiro administrador,
exatamente como o script `admin:create`; alguns testes consultam o banco como `alpha_app`
para provar que a RLS bloqueia mesmo sem o backend.

## Cobertura dos critérios pedidos

| # | Critério | Onde |
| --- | --- | --- |
| 1 | Login, recuperação de senha, convite e logout | `auth.test.ts`; E2E login/logout |
| 2 | Convite expirado ou reutilizado recusado | `auth.test.ts` (uso único, expirado, reenvio invalida o anterior) |
| 3 | Usuário desativado perde acesso com sessão anterior | `auth.test.ts` (usuário, empresa, e RLS direta) |
| 4 | Cliente A não acessa dados de B por URL e API | `isolation.test.ts` (8 endpoints por ID); E2E por URL e `fetch` |
| 5 | Cliente não acessa comentários internos | `isolation.test.ts`, `documents-comments.test.ts`, E2E |
| 6 | Documento privado inacessível sem autorização | `documents-comments.test.ts` (sem sessão, não vinculado, não compartilhado, revogado) |
| 7 | Candidato em dois processos sem vazamento | `isolation.test.ts` (compartilhamento por participação) |
| 8 | Usuário comum não altera perfil/permissões | `workflow.test.ts`, `isolation.test.ts` (API e SQL direto) |
| 9 | Persistência após recarregar | `workflow.test.ts`; E2E com `page.reload()` |
| 10 | Upload inválido ou acima do limite recusado | HTML, SVG, conteúdo falso, > limite, sem resíduos no disco; E2E |
| 11 | Mudança de etapa registra histórico e responsável | `workflow.test.ts` (fluxo completo); E2E |
| 12 | Conflito de atualização simultânea | `workflow.test.ts` (duas requisições paralelas → 200 + 409) |
| 13 | Dashboard, busca, paginação respeitam permissões | `isolation.test.ts`, `workflow.test.ts` (sem canal de tempo real nesta versão) |
| 14 | Fluxo cliente → processo → candidato → documento → etapas → decisão | `workflow.test.ts` |
| 15 | Responsividade e teclado | E2E (Pixel 7 sem rolagem horizontal; foco, link de pular, abas com setas, login só por teclado) |

Também testados: exportação de dados do titular (somente administrador, auditada), rótulos de nomes exibidos a clientes, convite de empresa desativada recusado, CSRF ausente/errado, origem externa, expiração por inatividade,
limite de tentativas e bloqueio de conta, campos extras recusados, transições inválidas,
decisão sem permissão, aprovação fora da etapa, responsável sem acesso, processo arquivado
congelado, duplicidade com dados fora do escopo, eliminação definitiva com remoção física,
auditoria imutável e sem segredos, XSS armazenado exibido como texto.

## Netlify + Supabase

`serverless.test.ts` exercita o adaptador das Netlify Functions em modo de produção: cookie `__Host-`,
CSRF, origem, convites e redefinição sem SMTP, documentos no Supabase Storage (servidor que imita a
API REST do Storage) e limites de tentativa no PostgreSQL. O pacote gerado pelo esbuild também foi
executado localmente com as mesmas verificações. **Não testado contra um projeto Supabase real nem
no Netlify real** (sem acesso a esses ambientes a partir daqui).

## Cadastro e cobranças

`signup-billing.test.ts` (15 testes): resposta igual para e-mail novo e existente, senha só pelo
link do e-mail, CNPJ inválido, campos extras recusados, aprovação só após confirmação, empresa
duplicada, hash apagado após decisão, acesso só de administrador (API e RLS, inclusive coluna de
senha negada ao próprio administrador); regra dos avisos (criada, lembrete, vencimento, atrasos
limitados), envio em lote, e-mail de cobrança ausente, atraso sem repetição, recibo de pagamento,
versão desatualizada, recorrência mensal sem duplicar e com fim de mês, envio automático desligado.
`serverless.test.ts` cobre a configuração de `SMTP_USER`/`SMTP_PASSWORD`.

## Vagas e portal

`jobs-portal.test.ts` (6 testes): só vagas publicadas aparecem e sem dados internos nem resposta
esperada; candidatura cria candidato, currículo e participação na 1ª etapa com origem e triagem;
duplicidade na mesma vaga; perguntas sem resposta, sem consentimento, campos extras, arquivo falso e
robô recusados; vaga pausada/processo concluído saem do ar; banco de talentos visível só ao
administrador; respostas não chegam a clientes (API e RLS) e só administrador publica.

## Triagem e envio

`triage-leads.test.ts` (7 testes): candidato em triagem invisível ao cliente (API, RLS e visão),
ficha de avaliação com nota média e motivo obrigatório, envio em lote só de aprovados na triagem,
compartilhamento escolhido e aviso por e-mail, envio irreversível e sem repetição, aviso de envio
duplicado à mesma empresa, permissões de envio, motivo padronizado nas decisões e prazo vencido.

## Integração contínua

`.github/workflows/ci.yml` executa, a cada push/PR, verificação de tipos, build, os testes de
integração com PostgreSQL 16 e `npm audit`. Os testes de navegador não estão no CI (exigem
servidor e dados de desenvolvimento) e são executados localmente com `npm run test:e2e`.

## Não executado

- **Build da imagem Docker**: não havia daemon Docker no ambiente. O `Dockerfile` foi
  escrito, mas não construído.
- **Envio real de e-mail (SMTP)**: sem credencial; os testes usam caixa de saída em memória.
- **Publicação**: sem ambiente autorizado.
- **Leitores de tela** e navegadores além do Chromium: não testados automaticamente.
- **Carga/desempenho**: não testado.
