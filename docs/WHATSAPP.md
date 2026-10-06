# WhatsApp (API oficial da Meta)

Corresponde à parte de WhatsApp do Módulo 7 / Marco 4 do escopo. Usa a **WhatsApp Cloud API** da Meta. Fica
**desligado** até a conta estar pronta: sem as variáveis abaixo, o sistema funciona só com e-mail.

## O que faz

- **Candidatos**: os mesmos avisos do e-mail (candidatura recebida, perfil enviado ao cliente, entrevista agendada,
  não aprovado) também pelo WhatsApp, **só para quem autorizou** — caixa no formulário de candidatura ("Quero receber
  avisos pelo WhatsApp") ou em **Meus dados**. Responder **SAIR** (ou PARAR, CANCELAR, STOP) cancela na hora.
- **Cobranças**: os avisos (nova cobrança, lembrete, vencimento, atraso, recibo) também vão para o **WhatsApp do
  financeiro** cadastrado na empresa (Empresas clientes → Editar).
- **Rastreamento**: cada envio fica registrado (Mensagens → Últimos envios e cadastro do candidato) com o status
  devolvido pela Meta: enviada → entregue → lida, ou falhou com o motivo.

Mensagens que a empresa inicia precisam de **modelos aprovados pela Meta** ("message templates"). O sistema guarda só
o **nome** do modelo; o texto é o que foi aprovado lá.

## Modelos a criar na Meta (categoria "Utilidade", idioma Português (BR))

| Aviso | Parâmetros do corpo, nesta ordem |
| --- | --- |
| Candidatura recebida | `{{1}}` nome, `{{2}}` vaga |
| Perfil enviado ao cliente | `{{1}}` nome, `{{2}}` vaga, `{{3}}` empresa (ou "uma empresa parceira") |
| Entrevista agendada | `{{1}}` nome, `{{2}}` vaga, `{{3}}` data e hora, `{{4}}` formato, `{{5}}` local ou link |
| Não aprovado | `{{1}}` nome, `{{2}}` vaga |
| Cobranças (cada tipo de aviso) | `{{1}}` empresa, `{{2}}` descrição, `{{3}}` valor, `{{4}}` vencimento, `{{5}}` link de pagamento |

Exemplo (candidatura recebida): *"Olá, {{1}}! Recebemos sua candidatura para a vaga {{2}}. Avisaremos por aqui os
próximos passos. Para não receber mais mensagens, responda SAIR."*

## Como ligar

1. Na Meta (business.facebook.com / developers.facebook.com): crie o app do tipo **Business**, adicione o produto
   **WhatsApp**, verifique a empresa e cadastre o número oficial. Crie os modelos acima e aguarde a aprovação.
2. No Netlify (Environment variables), crie:

   | Variável | Valor |
   | --- | --- |
   | `WHATSAPP_TOKEN` | token de acesso **permanente** (usuário do sistema) — **secreta** |
   | `WHATSAPP_PHONE_NUMBER_ID` | "Phone number ID" do número (não é o telefone) |
   | `WHATSAPP_APP_SECRET` | chave secreta do app (Configurações do app → Básico) — **secreta** |
   | `WHATSAPP_VERIFY_TOKEN` | um texto longo inventado por você (16+ caracteres) — **secreta** |

3. Na Meta, em WhatsApp → Configuração → **Webhook**: URL `https://SEU-SITE/api/webhooks/whatsapp`, token de
   verificação = `WHATSAPP_VERIFY_TOKEN`; assine o campo **messages**.
4. Novo deploy no Netlify. Em **Mensagens**, marque "Enviar também pelo WhatsApp" em cada aviso e informe o nome do
   modelo aprovado. Em **Cobranças → Configurações**, ligue o WhatsApp e informe os modelos de cada tipo de aviso.

## Limites e custos

- A Meta cobra por conversa iniciada pela empresa (tabela da Meta); o sistema não controla esse custo.
- Modelos podem ser pausados pela Meta por baixa qualidade; o envio passa a falhar com o motivo no registro.
- Sem e-mail configurado (SMTP), os avisos de cobrança saem só pelo WhatsApp; o recibo manual e o "Enviar e-mail
  agora" continuam exigindo e-mail.
- Testado contra um servidor que imita a API da Meta (`server/test/fake-whatsapp.ts`); **não testado com a conta real**.
