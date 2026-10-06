# Cadastro pelo site, recuperação de senha e cobranças

Incluídos a pedido da Alpha Select (outubro/2026). Antes estavam fora do escopo
(sem cadastro público e sem cobrança).

## E-mail: o que precisa estar configurado

Tudo abaixo depende do envio de e-mail do servidor. Não há serviço pago: basta uma conta
de e-mail com **senha de app**. No Gmail, o caminho é: Conta Google → Segurança → Verificação em
duas etapas (ligar) → **Senhas de app** → criar.

| Variável (Netlify → Environment variables) | Valor |
| --- | --- |
| `SMTP_USER` | o endereço do e-mail que envia (ex.: `financeiro@...` ou um Gmail) |
| `SMTP_PASSWORD` | a senha de app (16 letras; espaços são ignorados) — marcar como **secreta** |
| `SMTP_HOST` / `SMTP_PORT` | só se **não** for Gmail (padrão: `smtp.gmail.com` / `465`) |
| `MAIL_FROM` | opcional; padrão `Alpha Select <SMTP_USER>` |

Com `SMTP_USER` e `SMTP_PASSWORD` definidos, o sistema envia e-mails mesmo que `MAIL_MODE=manual`
continue nas variáveis. Limite do Gmail: cerca de 500 e-mails por dia.

O Supabase não serve para isso: o envio de e-mail dele é só para o login do próprio Supabase
(que este sistema não usa) e, sem SMTP próprio, só entrega para os membros da equipe do projeto.

## Esqueci minha senha

Tela **Esqueci minha senha** → e-mail com link de uso único (60 min) → nova senha → todas as sessões
anteriores são encerradas. Resposta igual exista ou não a conta. Sem e-mail configurado, a tela
orienta a pedir o link ao administrador (Usuários → Link de redefinição).

## Cadastro de empresas pelo site

1. A empresa preenche **Criar cadastro** (link no login): nome da empresa, CNPJ (opcional,
   validado), responsável, e-mail, telefone (opcional) e autorização de uso dos dados.
2. Recebe um link no e-mail (48 h). **A senha só é criada por esse link**, então ninguém cria
   acesso com o e-mail de outra pessoa.
3. Os administradores recebem um aviso. Em **Administração → Cadastros**, aprovam (escolhendo o
   perfil — Gestor/CEO ou Cliente/RH Interno — e se a empresa é nova ou já existente) ou recusam.
4. Na aprovação, a empresa e o usuário são criados e a pessoa recebe "Acesso liberado".
   **Ela não vê nenhum processo** até ser vinculada a um processo.

Segurança: a resposta do formulário é sempre a mesma (não revela quem já tem conta); limite de
8 cadastros por hora por IP e 3 e-mails por hora por endereço; o hash da senha é apagado quando o
cadastro é decidido; pedidos não confirmados são apagados em ~7 dias e recusados após 90 dias.

Sem e-mail configurado: o cadastro chega como "e-mail não confirmado"; confirme com a empresa por
telefone. Ao aprovar, o sistema mostra um link de convite para a pessoa criar a senha.

## Cobranças (Administração → Cobranças)

- **Nova cobrança**: escolha uma, várias ou **todas as empresas ativas** de uma vez; descrição, valor,
  vencimento, "cobrança única" ou **todo mês**, e link de pagamento opcional.
- O e-mail vai para o **e-mail de cobrança** da empresa (Empresas clientes → Editar). Se estiver vazio,
  usa o e-mail do Gestor/CEO (ou do primeiro usuário ativo) da empresa.
- **E-mails automáticos** (tarefa a cada hora, horário de Brasília):
  - ao criar a cobrança;
  - lembrete X dias antes do vencimento (padrão 3);
  - no dia do vencimento;
  - em atraso, a cada N dias (padrão 7), até um máximo (padrão 3).
  Nenhum aviso é repetido; falhas são registradas e tentadas de novo na hora seguinte.
- **Mensal**: no vencimento, o sistema cria a próxima cobrança (mesmo dia do mês; em meses
  mais curtos, o último dia).
- Em cada cobrança: **Marcar como paga** (envia recibo, opcional), **Enviar e-mail agora**, **Editar**,
  **Pausar e-mails automáticos**, **Encerrar repetição mensal**, **Cancelar**, e o histórico dos e-mails.
- **Configurações**: liga/desliga o envio automático, chave Pix, favorecido, instruções e os prazos.
- Painel: a receber, vencidas e recebido no mês.

## Boleto, Pix e cartão com o Asaas (opcional)

Sem o Asaas, a baixa é manual ("Marcar como paga"). Com ele:

- Cada nova cobrança (inclusive as parcelas mensais) vira uma cobrança no Asaas. O cliente abre o link do e-mail e
  escolhe **boleto, Pix ou cartão** na página do Asaas. O primeiro e-mail espera o link ser criado.
- Quando o cliente paga, o Asaas avisa o sistema (webhook) e a cobrança é **baixada sozinha**, com recibo por e-mail
  ("Pago pelo Asaas (Pix)", por exemplo). O botão **Atualizar do Asaas** na cobrança busca a situação se o aviso não chegar.
- Editar valor/vencimento/descrição, cancelar ou dar baixa manual também atualiza o Asaas. Falhas ficam registradas na
  cobrança ("Erro no Asaas") e são tentadas de novo a cada hora.
- A empresa precisa ter **CNPJ** cadastrado (Empresas clientes → Editar). Os avisos do próprio Asaas ficam desligados
  para o cliente não receber e-mails em dobro.

### Como ligar

1. Crie a conta no Asaas (para testar sem cobrar ninguém, use uma conta **sandbox**: sandbox.asaas.com).
2. No Asaas: Integrações → **Chave de API** → gerar. No Netlify, variável `ASAAS_API_KEY` (secreta). Chaves de produção
   começam com `$aact_prod_`; as de sandbox, com `$aact_hmlg_` — o sistema escolhe o endereço certo sozinho.
3. Invente um token longo (16+ caracteres) e coloque em `ASAAS_WEBHOOK_TOKEN` (secreta) no Netlify.
4. No Asaas: Integrações → **Webhooks** → nova URL `https://SEU-SITE/api/webhooks/asaas`, com o mesmo token em
   "Token de autenticação", eventos de **cobrança**, API v3. (A URL exata aparece em Cobranças → Configurações.)
5. Faça um novo deploy no Netlify e, em Cobranças → Configurações, marque **Gerar cobranças no Asaas**.

Cobranças criadas antes de ligar continuam manuais; para levar uma delas ao Asaas, abra-a e use **Gerar boleto/Pix no
Asaas**. Taxas do Asaas (por boleto, Pix ou cartão) são cobradas pelo próprio Asaas.

Acesso: somente administradores (servidor + RLS). Equipe e clientes recebem 403 e o banco não
devolve nenhuma linha a eles. Todas as ações ficam na auditoria; o conteúdo dos e-mails não é
gravado, só o tipo, destinatário, data e resultado.
