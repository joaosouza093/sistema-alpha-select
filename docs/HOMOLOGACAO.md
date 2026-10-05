# Roteiro de homologação

Executar em ambiente de **homologação** com dados fictícios, usando **contas distintas**
(não testar tudo com o administrador). Marque cada item e anote observações.

## Preparação

- [ ] Administrador provisionado via `admin:create`; convite aceito; login OK.
- [ ] Criar empresas **Empresa A** e **Empresa B**.
- [ ] Convidar: 1 Equipe Alpha, 1 RH Interno A, 1 Gestor A, 1 RH Interno B, 1 RH Interno A2 (sem vínculo).
- [ ] Cada convidado aceita o convite pelo e-mail recebido e define a senha.

## Autenticação

- [ ] Senha errada → “E-mail ou senha inválidos.” (mesma mensagem para e-mail inexistente).
- [ ] “Esqueci minha senha” → e-mail recebido → redefinição → sessões antigas encerradas.
- [ ] Reutilizar o link de convite ou de redefinição → recusado.
- [ ] Convite com mais de 72 h → recusado; “Reenviar convite” gera novo link e invalida o antigo.
- [ ] Sair → voltar com o botão do navegador não mostra dados.
- [ ] Desativar um usuário com sessão aberta em outro navegador → próxima ação o leva ao login.

## Fluxo completo

- [ ] Admin cria processo para Empresa A e vincula Equipe (mover), RH A (mover, comentar) e Gestor A (mover, decidir, comentar).
- [ ] Equipe cadastra candidato (telefone com máscara, pretensão “5.000,00”), recarrega a página e confere os dados.
- [ ] Cadastrar outro candidato com mesmo e-mail → aviso de duplicidade → “cadastrar mesmo assim”.
- [ ] Equipe envia currículo PDF; tenta enviar `.html`, arquivo renomeado e arquivo acima do limite (4 MB no Netlify) → recusados.
- [ ] Equipe inclui o candidato no processo, compartilha o currículo e o e-mail na participação.
- [ ] Equipe move RH Externo → RH Interno definindo RH A como responsável.
- [ ] RH A move para CEO/Gestor e define Gestor A como responsável.
- [ ] Gestor A move para Aprovação; confere que continua “Em avaliação”; registra **Aprovado**.
- [ ] Histórico mostra etapa anterior/nova, responsável, autor e horário de cada passo.

## Isolamento e permissões

- [ ] Incluir o **mesmo candidato** em processo da Empresa B.
- [ ] RH B não vê o processo A nem o e-mail compartilhado apenas em A.
- [ ] RH A abre URL de processo/participação/documento da Empresa B → “Conteúdo indisponível”.
- [ ] RH A2 (mesma empresa, sem vínculo) não vê o processo A.
- [ ] RH A não vê o menu Candidatos; acessar `/candidatos` → página não encontrada.
- [ ] Comentário interno da Equipe não aparece para RH A nem para Gestor A.
- [ ] RH A publica comentário (sempre compartilhado); não consegue publicar interno.
- [ ] Parar de compartilhar o currículo → RH A perde acesso imediatamente (inclusive com o link aberto).
- [ ] Remover RH A dos participantes → perde acesso imediatamente.
- [ ] Equipe não acessa Usuários, Empresas, Auditoria; não altera o próprio perfil.
- [ ] Painel de RH A mostra apenas números do processo A.

## Concorrência

- [ ] Abrir a mesma participação em dois navegadores; mover em um; tentar mover no outro → aviso para recarregar; nada é sobrescrito.

## Cadastro e cobranças

- [ ] Login → "Cadastre sua empresa" → e-mail com link → criar senha → administrador aprova em Cadastros → login funciona e não mostra processos.
- [ ] Esqueci minha senha → e-mail chega → nova senha funciona; a antiga não.
- [ ] Cobranças → nova cobrança para várias empresas → e-mails chegam; marcar como paga → recibo chega.
- [ ] Usuário da equipe ou cliente não vê "Cadastros" nem "Cobranças" e recebe 403 na API.

## Vagas e portal

- [ ] Processo → Vaga no portal → preencher e publicar → vaga aparece em /vagas; pausar → some.
- [ ] Candidatar-se pelo celular com PDF → entra no quadro (1ª etapa) com selo Portal; e-mail de confirmação chega.
- [ ] Pergunta eliminatória respondida diferente → selo "Não atende requisito"; respostas visíveis na participação.
- [ ] Usuário de cliente não vê as respostas da candidatura.

## Interface

- [ ] Celular: menu, quadro (colunas empilhadas, botões de mover), formulários sem rolagem horizontal.
- [ ] Teclado: Tab mostra foco visível; “Pular para o conteúdo”; abas com setas; diálogos fecham com Esc.
- [ ] Rodapé “Tecnologia desenvolvida pela PMG Code” em todas as telas.
- [ ] Marca: logo horizontal no login e no menu; monograma no topo do celular e no favicon; nada esticado ou cortado.
- [ ] Título da aba: “Alpha Select | Gestão de Processos Seletivos” (com o nome da seção à frente).
- [ ] Dourado apenas em detalhes; nenhum texto pequeno dourado sobre fundo branco.
- [ ] Título da aba nunca contém nome de candidato.

## Operação

- [ ] Backup do banco e dos arquivos gerado e **restaurado** em ambiente isolado.
- [ ] Auditoria registra os eventos acima, sem senhas ou tokens.
