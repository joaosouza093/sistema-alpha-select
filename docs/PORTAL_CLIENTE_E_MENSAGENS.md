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
