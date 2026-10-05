# Vagas e portal público de candidatura

Corresponde ao Módulo 4 / Marco 2 do documento de escopo (`ESCOPO_ALPHA_SELECT.pdf`).

## Como funciona

- Cada **processo seletivo** pode virar uma **vaga** (aba **Vaga no portal**, só equipe Alpha; só
  administrador altera): local, modelo (presencial/híbrido/remoto), contratação (CLT, PJ, estágio,
  temporário), requisitos, benefícios, faixa salarial opcional, mostrar ou não o nome da empresa
  ("Empresa confidencial") e até 10 perguntas sim/não, eliminatórias ou não.
- Situação no portal: **não publicada → publicada → pausada / encerrada**. Só processos em andamento
  e de empresas ativas aparecem. Concluir ou arquivar o processo tira a vaga do ar.
- Páginas públicas (sem login): **/vagas** (lista com busca), **/vagas/<endereço>** (detalhe +
  formulário) e **/trabalhe-conosco** (banco de talentos, sem vaga).
- A candidatura cria o candidato (origem "portal", com data do aceite do aviso de privacidade), o
  currículo e a participação na **primeira etapa** do quadro, com os selos **Portal** e, se alguma
  pergunta eliminatória não bater, **Não atende requisito**. Ninguém é reprovado automaticamente.
- O candidato recebe e-mail de confirmação (quando o e-mail do servidor está configurado).

## Segurança

- O portal só devolve campos públicos; nunca IDs internos nem a resposta esperada das perguntas.
- Currículo: PDF, DOC, DOCX ou ODT, validado pelo conteúdo (mesma validação dos uploads internos).
- Limites: 10 envios por hora por IP, 3 e-mails de confirmação por hora por endereço, campo isca contra
  robôs; mesmo e-mail na mesma vaga não duplica.
- Respostas do formulário ficam em tabela própria que **só a equipe Alpha** lê (RLS); clientes não as
  veem nem pela API nem pelo banco.
- Candidatos do banco de talentos (sem vaga) ficam visíveis só para administradores até serem
  incluídos em um processo.

## Pendências

- Texto do aviso de privacidade é um modelo: validar com o jurídico da Alpha Select (base legal e prazo
  de retenção).
- As páginas públicas estão com `noindex` (não aparecem no Google). Para divulgar em buscadores, liberar
  `/vagas` no `robots.txt` e nos cabeçalhos.
- Área do candidato com login (editar os próprios dados) ainda não existe.
