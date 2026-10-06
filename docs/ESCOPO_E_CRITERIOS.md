# Escopo, requisitos e critérios de aceite

## Fonte do escopo

**Pendência:** o contrato mencionado como anexo **não estava disponível** no ambiente de
desenvolvimento, nem o material/PDF complementar de referência citado nele. Nada do
conteúdo desses documentos foi presumido. O escopo abaixo foi extraído das instruções
de desenvolvimento recebidas, que descrevem o escopo central do contrato. Assim que o
contrato e o material complementar forem disponibilizados, esta lista deve ser
conferida item a item e divergências registradas em `PENDENCIAS.md`.

Fora do escopo (não implementado por não estar aprovado): agentes de IA,
avaliação automática de candidatos, assinatura, folha de pagamento e integrações externas.
Em outubro/2026 a Alpha Select pediu e foram incluídos: cadastro de empresas pelo site (com
aprovação do administrador) e cobranças com e-mails automáticos, sem gateway de pagamento
(ver `CADASTRO_E_COBRANCAS.md`). Condições financeiras do contrato não viraram funcionalidades.
Nenhum dado pessoal das partes do contrato está no código, nas seeds ou nas telas.

## Requisitos e critérios de aceite

| # | Requisito | Critério de aceite | Situação |
| --- | --- | --- | --- |
| R1 | Cadastro de candidatos | Criar/editar/consultar nome, telefone, e-mail, pretensão, observações; validação e normalização no servidor; aviso de duplicidade sem bloquear | Implementado e testado |
| R2 | Currículos e documentos | Upload real, metadados (nome, tamanho, tipo, data, autor), visualização de PDF/imagem, download autorizado, remoção autorizada | Implementado e testado |
| R3 | Processos seletivos e etapas | Processo por empresa cliente com título, descrição, status (em andamento/concluído/arquivado) e participantes | Implementado e testado |
| R4 | Fluxo visual | Quadro com RH Externo → RH Interno → CEO/Gestor → Aprovação; mover por botão, diálogo ou arrastar-e-soltar | Implementado e testado |
| R5 | Responsável pela etapa | Responsável exibido no cartão; apenas usuário com acesso ativo ao processo | Implementado e testado (regra também no banco) |
| R6 | Comentários e observações internas | Visibilidade interna (padrão) ou compartilhada; interno nunca chega ao cliente | Implementado e testado |
| R7 | Alteração de status | Decisão separada da etapa; histórico com etapa anterior/nova, autor, horário, responsável | Implementado e testado |
| R8 | Acesso da Alpha Select e de clientes autorizados | Clientes veem apenas processos liberados explicitamente para seu usuário e empresa | Implementado e testado |
| R9 | Permissões por perfil | Matriz explícita aplicada no servidor e no banco (RLS) | Implementado e testado |
| R10 | Visualização segura de documentos | Armazenamento privado, sem URL pública, autorização a cada acesso, revogação imediata | Implementado e testado |
| R11 | Painel intuitivo | Indicadores reais limitados ao escopo, pendências, movimentações recentes, atalhos | Implementado e testado |
| R12 | Testes, ajustes e preparação para publicação | Build, tipos, testes de integração e navegador; Dockerfile; documentação | Implementado; publicação depende de ambiente (ver `PENDENCIAS.md`) |
| R13 | Relatórios e indicadores (Marco 6) | Por empresa, processo, origem, mês e recrutador; motivos; mensagens e financeiro (admin); CSV e PDF; totais reproduzíveis | Implementado e testado (ver `RELATORIOS.md`) |
| R14 | Verificação em duas etapas (opcional) | Código de aplicativo autenticador no login, códigos de recuperação, sem reutilização, desligamento pelo administrador | Implementado e testado |
| R15 | Retenção de dados (LGPD) | Regra configurável, aviso por e-mail com renovação, eliminação definitiva auditada, processos ativos preservados | Implementado e testado (desligado por padrão) |
| R16 | Área do candidato | Acesso por link no e-mail; ver, corrigir, trocar currículo, e-mails, renovar, baixar e excluir os próprios dados | Implementado e testado |
| R17 | Gateway de pagamento (Asaas) | Cobrança gerada no Asaas com link no e-mail, baixa automática por webhook, edição/cancelamento/baixa manual refletidos, nova tentativa em falhas | Implementado e testado com servidor simulado; falta a conta real |
| R18 | WhatsApp (API oficial) | Avisos ao candidato com autorização e SAIR; avisos de cobrança ao financeiro; status de entrega por webhook assinado; falhas registradas | Implementado e testado com servidor simulado; falta a conta na Meta |
