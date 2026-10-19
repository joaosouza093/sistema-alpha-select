# Portal do cliente e mensagens ao candidato

Corresponde aos Módulos 6 e 7 do documento de escopo. O WhatsApp está em `WHATSAPP.md`.

## Portal do cliente

- **Painel do cliente**: lista **Aguardando seu retorno** (candidatos enviados e sem decisão, com selo
  de prazo vencido) e **Indicadores por processo**: enviados, aguardando, aprovados, não aprovados/
  desistências e tempo médio de retorno (do envio até a decisão).
- **Seu retorno** (na participação, para cliente/gestor): avançar para a próxima etapa, aprovar (na
  etapa Aprovação), recusar com motivo padronizado ou manter em análise, com comentário compartilhado
  com a Alpha Select. Cada botão aparece conforme a permissão do usuário no processo.
- **Entrevistas e próximos passos**: data/hora, formato (presencial, on-line, telefone), local ou link
  e observações; marcar como realizada ou cancelada. Agenda quem é da equipe Alpha com acesso ou o
  participante com permissão de mover ou decidir. Tudo visível a quem vê a participação — e nada do
  candidato em triagem chega ao cliente.
- **Lembrete diário de retorno**: a partir das 9h, um e-mail por processo por dia aos participantes do
  cliente com permissão de decidir/mover, quando há candidatos parados além do prazo.

## Mensagens ao candidato (Administração → Mensagens)

| Modelo | Quando sai | Padrão |
| --- | --- | --- |
| Candidatura recebida | candidatura pelo portal de vagas | ligado |
| Perfil enviado ao cliente | envio pela Alpha Select (empresa só aparece se a vaga não for confidencial) | ligado |
| Entrevista agendada | quando a equipe Alpha agenda e marca "Avisar o candidato" | ligado |
| Não aprovado | decisão "Não aprovado" (o motivo interno nunca vai ao candidato) | **desligado** |

- O administrador edita assunto e texto, com variáveis `{{candidato}}`, `{{vaga}}`, `{{empresa}}`,
  `{{data_entrevista}}`, `{{formato}}`, `{{local}}`.
- Todo e-mail tem no rodapé o link de **descadastro** (`/descadastrar`); depois disso nada mais é enviado.
- Cada envio fica registrado (modelo, destinatário, assunto, data, resultado), sem o texto do e-mail:
  na página Mensagens e no cadastro do candidato. Clientes não veem esse histórico.
- Sem e-mail configurado no servidor (`SMTP_USER`/`SMTP_PASSWORD`), nada é enviado e nada é registrado.

## Comunicados (mensagem livre para vários candidatos)

- Menu **Comunicados** (equipe Alpha). Destinatários: candidatos marcados na lista de **Candidatos** (caixas de seleção →
  "Enviar comunicado") e/ou todos os candidatos de um **processo** (botão "Enviar comunicado" no processo), opcionalmente
  só de uma etapa e só os ainda em avaliação. Máximo de 500 por comunicado.
- Assunto e mensagem livres, com as variáveis {{candidato}}, {{nome_completo}}, {{vaga}} e {{empresa}}. O rodapé com
  Meus dados e o link de descadastro entra sozinho.
- **Enviar agora** ou **Agendar** (data e hora). Agendados saem na rodada automática seguinte ao horário (até 1 hora
  depois) e podem ser cancelados antes disso.
- Cada destinatário fica com a situação (enviado, falhou, não enviado: sem e-mail ou descadastrado). Os envios também
  aparecem no histórico de mensagens do candidato.
- Somente por **e-mail**: o WhatsApp oficial não aceita texto livre, só modelos aprovados pela Meta.
- A equipe só alcança candidatos que já pode ver e só vê os próprios comunicados; o administrador vê todos.

## Dados pessoais para admissão

- Liberados ao candidato **somente depois da aprovação** em um processo seletivo. Ao registrar "Aprovado", o candidato
  recebe por e-mail um link (válido por 7 dias) para a área **Meus dados**, onde aparece o formulário.
- Campos: nome completo, data de nascimento, sexo, estado civil, nacionalidade, naturalidade (cidade/UF), CPF (validado),
  RG, órgão emissor, UF e data de emissão do RG, endereço completo, celular, nome da mãe e nome do pai (opcional).
- No fim, caixa obrigatória com o termo de consentimento (LGPD) no texto pedido pela Alpha Select; o texto e a data do aceite
  ficam gravados. O candidato pode corrigir e reenviar.
- Na ficha do candidato (aba Dados), a equipe Alpha vê os dados e pode **gerar o link** de novo (copiado para enviar pelo
  WhatsApp quando o e-mail não estiver configurado). Os clientes nunca veem esses dados. Cada consulta fica na auditoria.
