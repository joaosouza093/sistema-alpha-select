# Relatórios e indicadores

Corresponde ao Marco 6 do documento de escopo (dashboards executivos e operacionais, relatórios por
empresa, vaga, origem, recrutador e período, exportação em CSV e PDF).

## Onde fica

Menu **Relatórios** (equipe Alpha Select). Clientes não acessam (eles têm os indicadores no próprio painel).

## Filtros

Período (atalhos: 30 dias, 90 dias, este ano, 12 meses; máximo de 2 anos), empresa e processo.

**Base de cálculo:** as participações (candidato em um processo) **criadas no período**, horário de Brasília.
Todos os números saem dessa mesma base, então qualquer total pode ser conferido nas telas de processos e
candidatos. A equipe vê apenas os processos aos quais tem acesso (a mesma regra do banco, RLS); o
administrador vê tudo.

## O que mostra

| Bloco | Indicadores |
| --- | --- |
| Resumo | candidaturas, triados, enviados, aprovados pelo cliente, aguardando retorno, recusas, dias até o envio, dias de retorno do cliente |
| Funil | candidaturas → triados → aprovados na triagem → enviados → aprovados pelo cliente |
| Por empresa / por processo / por origem / por mês | as mesmas métricas, com taxa de aprovação sobre enviados |
| Produtividade por recrutador | triagens registradas, envios, aprovados e tempo médio até o envio |
| Motivos | reprovação na triagem e recusa pelo cliente |
| Mensagens (só administrador) | e-mails por modelo: enviados, entregues ao servidor, falhas; descadastros no período |
| Financeiro (só administrador) | por empresa, cobranças com vencimento no período: emitido, recebido, vencido em aberto, a vencer, adimplência (recebido ÷ já vencido) e atraso médio de pagamento |

"Aprovados pelo cliente" é a decisão **Aprovado** (etapa Aprovação). Os tempos de retorno usam a data da
decisão atual registrada no histórico.

## Exportação

- **Baixar CSV** em cada tabela, ou **Baixar tudo (CSV)** — separador `;` e acentuação compatível com o Excel.
- **Imprimir / salvar PDF** — layout de impressão sem menu, com o período e os filtros no topo.

Os relatórios não trazem dados pessoais de candidatos, só contagens e nomes de usuários da equipe.
