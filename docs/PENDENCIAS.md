# Pendências, premissas e limitações

## Documentos e insumos não recebidos

1. **Contrato** citado como anexo — não disponível no ambiente. Conferir o escopo
   (`ESCOPO_E_CRITERIOS.md`) contra o contrato quando for enviado.
2. **Material/PDF complementar de referência** citado no contrato — não disponível;
   nada do seu conteúdo foi presumido.
3. **Arquivos vetoriais da marca** — a identidade oficial foi aplicada a partir do JPEG de referência
   (recortes provisórios); falta o SVG ou PNG transparente oficial (`IDENTIDADE_VISUAL.md`).

## Configurações externas necessárias para publicar

| Item | Situação |
| --- | --- |
| Hospedagem (Node 22/Docker + disco persistente) | não disponibilizada |
| PostgreSQL gerenciado com backup automático e criptografia em repouso | não disponibilizado |
| Domínio + certificado TLS | não informado |
| E-mail de envio (`SMTP_USER` + `SMTP_PASSWORD`) | **falta configurar no Netlify** — sem isso não saem: recuperação de senha, confirmação de cadastro e cobranças automáticas |
| Execução de `create-roles.sql`, migrações e `admin:create` | depende dos itens acima |

## Premissas de negócio a validar com a Alpha Select

- Matriz de permissões (ver `PERMISSOES.md`), em especial:
  escopo da equipe sobre o banco de talentos; quem cria processos; se clientes podem
  mover livremente entre etapas vizinhas; se Gestor/CEO é sempre da empresa cliente.
- Etapas fixas (RH Externo, RH Interno, CEO/Gestor, Aprovação) para todos os processos;
  movimentação apenas para a etapa vizinha (administrador pode pular).
- Decisões possíveis: Em avaliação, Aprovado (só na etapa Aprovação), Não aprovado, Desistiu.
- Situações de processo: em andamento, concluído, arquivado (os dois últimos somente leitura).
- Formatos aceitos (PDF, DOC, DOCX, ODT, PNG, JPG). Limite por arquivo: 10 MB em servidor próprio, 4 MB no Netlify.
- Sessão: 12 h absolutas, 2 h de inatividade; convite 72 h; recuperação 60 min.
- Base legal do tratamento e **prazo de retenção** (não implementado prazo automático).

## Hospedagem Netlify + Supabase

- Upload limitado a 4 MB por arquivo nessa hospedagem (limite das funções).
- Sem e-mail configurado: convites e redefinições por link entregue pelo administrador (`MAIL_MODE=manual`), cadastros sem confirmação de e-mail e cobranças sem aviso.
- Cobranças sem gateway: a baixa do pagamento é manual.
- Região do banco (Brasil × exterior) é decisão da Alpha Select.

## Limitações técnicas atuais

- Sem análise antivírus dos uploads.
- Limitador de tentativas em memória (uma instância).
- Sem notificações por e-mail de movimentações e sem atualização em tempo real.
- Sem MFA.
- Imagem Docker não foi construída neste ambiente (sem daemon).

## Situação

O sistema está **pronto para homologação** assim que houver um ambiente de homologação
(banco, hospedagem, SMTP). Não há bloqueio técnico conhecido no código; os bloqueios
para produção são as configurações externas acima e a validação das premissas.
