# Triagem, envio de candidatos ao cliente, motivos e prazos

Corresponde ao Módulo 5 / Marco 3 do documento de escopo.

## Como as etapas se encaixam no escopo

| Escopo | No sistema |
| --- | --- |
| Novo / em triagem | Etapa **1. RH Externo**, situação da triagem "Em triagem" |
| Aprovado interno | Situação "Aprovado na triagem" (ficha de avaliação) |
| Reprovado interno | Situação "Reprovado na triagem", com motivo |
| Enviado ao cliente | **Enviar ao cliente** → etapa **2. RH Interno** |
| Entrevista / oferta | Etapas **3. CEO/Gestor** e **4. Aprovação** |
| Contratado / encerrado | Decisão **Aprovado**, **Não aprovado** (com motivo) ou **Desistiu** (com motivo) |

## Regras

- **O cliente só vê o candidato depois do envio.** Enquanto está em triagem, a participação é interna
  (vale na API e no banco: RLS e visão compartilhada). O envio é permanente.
- **Ficha de avaliação** (aba **Triagem** da participação, só equipe Alpha): nota de 1 a 5 por critério,
  nota média, observações internas e resultado da triagem. Os critérios de cada processo são definidos
  pelo administrador em **Vaga e triagem**.
- **Envio**: só candidatos **aprovados na triagem**, sem decisão registrada e ainda não enviados. Pode ser
  individual (aba Triagem) ou em lote (marcar no quadro → **Enviar selecionados ao cliente**). Para cada
  um: resumo do recrutador (o cliente vê) e o que compartilhar (e-mail, telefone, pretensão,
  documentos vinculados). Exige permissão de mover etapas no processo.
- **Envio duplicado**: se o mesmo candidato (mesmo cadastro, e-mail ou telefone) já foi enviado à mesma
  empresa em outro processo, o sistema avisa e pede confirmação.
- **Aviso por e-mail** aos participantes do cliente no processo a cada envio (sem dados do candidato
  no e-mail).
- **Motivos padronizados** obrigatórios para "Não aprovado" e "Desistiu" (inclusive pelo cliente) e para
  a reprovação na triagem.
- **Prazo (SLA)** por processo (padrão 3 dias): cartão parado na etapa além do prazo, sem decisão, mostra
  **Prazo vencido**. O painel mostra quantos estão atrasados.
- **Funil** no topo do quadro (equipe Alpha): candidatos, em triagem, aprovados na triagem, enviados,
  aprovados. Painel: em triagem, enviados nos últimos 30 dias, aguardando retorno além do prazo.

## Fora desta entrega

- Etapas totalmente configuráveis por processo (hoje as 4 etapas são fixas, conforme o escopo original).
- Agenda de entrevistas (Módulo 6).
