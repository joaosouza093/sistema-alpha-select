# Matriz de permissões

Proposta inicial de implementação — **não** está detalhada no contrato e precisa ser
validada pela Alpha Select. Regra geral: **negar por padrão**. Todas as regras abaixo
são aplicadas no servidor **e** no banco (RLS, privilégios por coluna e gatilhos).
Ocultar botões na interface é apenas conveniência.

Legenda: ✅ permitido · ❌ negado · 🔸 somente com vínculo ao processo · 🔹 somente com a permissão marcada no vínculo

| Ação | Administrador Alpha | Equipe Alpha / RH Externo | Cliente / RH Interno | Gestor / CEO |
| --- | --- | --- | --- | --- |
| Gerenciar empresas clientes | ✅ | ❌ | ❌ | ❌ |
| Aprovar/recusar cadastros feitos pelo site | ✅ | ❌ | ❌ | ❌ |
| Cobranças (ver, criar, baixar, configurar) | ✅ | ❌ | ❌ | ❌ |
| Configurar e publicar vaga no portal | ✅ | ❌ (vê a configuração se vinculado) | ❌ | ❌ |
| Ver respostas da candidatura pelo portal | ✅ | 🔸 | ❌ | ❌ |
| Convidar, editar, ativar/desativar usuários | ✅ | ❌ | ❌ | ❌ |
| Alterar o próprio perfil, empresa ou situação | ❌ | ❌ | ❌ | ❌ |
| Criar/editar processos, alterar status | ✅ | ❌ | ❌ | ❌ |
| Vincular participantes e definir permissões | ✅ | ❌ | ❌ | ❌ |
| Ver processo e quadro | ✅ todos | 🔸 | 🔸 (e da própria empresa; só candidatos já enviados) | 🔸 (e da própria empresa; só candidatos já enviados) |
| Ficha de avaliação da triagem | ✅ | 🔸 | ❌ | ❌ |
| Enviar candidatos ao cliente | ✅ | 🔹 (permissão de mover etapa) | ❌ | ❌ |
| Definir critérios de avaliação e prazo (SLA) | ✅ | ❌ | ❌ | ❌ |
| Cadastro completo de candidatos (lista, busca, observações) | ✅ todos | cadastrados por si ou em processos com vínculo | ❌ | ❌ |
| Cadastrar/editar candidato | ✅ | ✅ (no seu escopo) | ❌ | ❌ |
| Incluir candidato em processo | ✅ | 🔸 | ❌ | ❌ |
| Ver dados do candidato na participação | ✅ | 🔸 | 🔸 somente campos compartilhados | 🔸 somente campos compartilhados |
| Configurar o que é compartilhado | ✅ | 🔸 | ❌ | ❌ |
| Mover etapa | ✅ (qualquer etapa) | 🔹 etapa vizinha | 🔹 etapa vizinha | 🔹 etapa vizinha |
| Definir responsável | ✅ | 🔸 | 🔹 (com permissão de mover) | 🔹 (com permissão de mover) |
| Registrar decisão | ✅ | 🔹 | 🔹 | 🔹 |
| Comentário interno (ler/publicar) | ✅ | 🔸 | ❌ | ❌ |
| Comentário compartilhado (ler) | ✅ | 🔸 | 🔸 | 🔸 |
| Comentário compartilhado (publicar) | ✅ | 🔸 | 🔹 | 🔹 |
| Editar comentário | próprio | próprio | próprio | próprio |
| Excluir comentário | qualquer | próprio | próprio | próprio |
| Enviar documento | ✅ | ✅ (no seu escopo) | ❌ | ❌ |
| Vincular/compartilhar documento na participação | ✅ | 🔸 | ❌ | ❌ |
| Ver/baixar documento | ✅ | candidatos no seu escopo | 🔸 somente compartilhados na participação | 🔸 somente compartilhados na participação |
| Remover documento | ✅ | somente os que enviou | ❌ | ❌ |
| Arquivar candidato | ✅ | ✅ (no seu escopo) | ❌ | ❌ |
| Exportar dados do titular (JSON) | ✅ | ❌ | ❌ | ❌ |
| Eliminar candidato definitivamente | ✅ | ❌ | ❌ | ❌ |
| Consultar auditoria | ✅ | ❌ | ❌ | ❌ |

## Regras adicionais

- Usuário de cliente só pode ser vinculado a processos da própria empresa (gatilho no banco).
- O acesso de cliente exige vínculo **explícito** com o processo; pertencer à empresa não basta.
- Desativar usuário ou empresa, ou remover o vínculo, revoga o acesso na próxima requisição
  (sessões abertas incluídas); desativação também apaga as sessões.
- Responsável precisa ser administrador ou participante ativo do processo; ao remover o vínculo,
  o usuário deixa de ser responsável nas participações daquele processo.
- Em processos concluídos ou arquivados, etapa, decisão, responsável e compartilhamento ficam
  bloqueados e não se incluem candidatos; comentários continuam permitidos para registro.
- “Aprovado” só pode ser registrado na etapa **Aprovação**. Com decisão registrada, a etapa não
  muda até a decisão ser reaberta (“Em avaliação”).
- Sempre deve existir ao menos um administrador ativo.
- Nomes exibidos a clientes: participantes dos mesmos processos aparecem pelo nome; demais pessoas
  da Alpha Select aparecem como “Equipe Alpha Select” (função `app.person_label`).

## Premissas a validar com a Alpha Select

- Se a equipe Alpha deve enxergar **todo** o banco de talentos (hoje: apenas candidatos que
  cadastrou ou de processos em que está vinculada).
- Se equipe Alpha pode criar processos (hoje: somente administrador).
- Se clientes/gestores devem mover etapas livremente ou apenas a partir de etapas específicas.
- Se o Gestor/CEO pertence sempre à empresa cliente (premissa atual) ou pode ser da Alpha.
