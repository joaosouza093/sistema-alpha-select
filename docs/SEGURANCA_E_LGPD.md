# Segurança, proteção de dados e operação

## Controles implementados

| Controle | Como |
| --- | --- |
| Autorização em toda leitura/escrita | Hook global exige sessão; serviços checam perfil; RLS no banco com papel sem `BYPASSRLS` |
| Troca de identificadores (IDOR) | Toda consulta passa pela RLS; recursos fora do escopo retornam **404** (não revelam existência) |
| Campos não autorizados | Schemas `strict` (campo extra → 422); `GRANT UPDATE` por coluna; gatilhos impedem alterar autor, visibilidade, empresa etc. |
| Campos sensíveis | Clientes não leem `candidates`; recebem só a visão mascarada; configuração de compartilhamento removida da resposta |
| Consultas parametrizadas | Sempre `$n`; curingas de busca escapados |
| XSS | React renderiza texto; nenhum `dangerouslySetInnerHTML`; CSP `script-src 'self'`; HTML/SVG não aceitos no upload |
| CSRF | Cookie `SameSite=Strict` + token `X-CSRF-Token` por sessão + verificação de `Origin` |
| CORS | Somente mesma origem por padrão; origens extras apenas por configuração |
| Senhas | scrypt (N=2^15) com sal; mínimo 10 caracteres; troca/redefinição encerra outras sessões |
| Tentativas | Limites por IP e por conta (login, recuperação, convite, upload) + bloqueio de conta por 15 min após 8 falhas |
| Convites | Token aleatório de 256 bits, guardado como hash, uso único, 72 h, perfil definido pelo servidor; reenvio invalida o anterior; token no fragmento `#` (não vai a logs) |
| Revogação | Sessão validada a cada requisição (usuário e empresa ativos); desativação apaga sessões; RLS também nega usuário inativo |
| Cabeçalhos | CSP, HSTS (https), `X-Frame-Options`, `nosniff`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex` |
| Cache | API com `Cache-Control: no-store`; documentos `private, no-store`; cache do frontend limpo ao sair/expirar |
| Erros | Mensagens genéricas; sem stack trace; erros do banco traduzidos |
| Logs | Sem corpo, cookies, cabeçalhos de autenticação ou query string |
| Auditoria | Login/logout/falhas, usuários, empresas, processos, vínculos, candidatos (inclui visualização), participações, documentos (envio, visualização, download, remoção, compartilhamento), comentários; somente inserção |
| Indexação | `robots.txt` Disallow, `noindex` em meta e cabeçalho; títulos de página sem dados pessoais |

## Supabase

- A API automática do Supabase não é usada: `anon`/`authenticated` não têm privilégios nos objetos da aplicação (migração 0006, verificado no projeto).
- Documentos em bucket privado; a chave `service_role` fica só nas variáveis das Netlify Functions.
- Aviso INFO do Security Advisor “RLS habilitada sem políticas” é intencional (tabelas acessíveis só pelo servidor).
- Criptografia em repouso e backups diários são recursos do Supabase; confirme o plano e a retenção de backups no painel
  (o plano gratuito tem retenção curta e não oferece restauração pontual — PITR).

## Limitações conhecidas (reais)

- **Sem antivírus**: a validação de extensão/MIME/assinatura **não** equivale a análise
  antimalware. Recomenda-se integrar um scanner (ex.: ClamAV) antes do uso em produção,
  mediante aprovação.
- **Limitador de tentativas em memória**: correto para uma instância. Com várias
  instâncias, substituir por armazenamento compartilhado (ex.: Redis) ou limitar no proxy.
- **Criptografia em repouso**: depende do provedor do banco e do disco. Nada está
  habilitado por este projeto; habilite no provedor escolhido e registre aqui.
- **Sem MFA** nesta versão.
- O dono do banco (`alpha_owner`) pode, tecnicamente, ler tudo; proteja essa credencial.

## Proteção de dados pessoais (LGPD)

- Coleta mínima: nome obrigatório; e-mail, telefone e pretensão opcionais. CPF/RG não são
  coletados. Não há campos de dados sensíveis.
- Nenhum currículo, documento ou comentário é enviado a IA, analytics ou serviços
  externos. O único serviço externo é o SMTP (convites, recuperação de senha, confirmação de
  cadastro e cobranças — sem dados de candidatos).
- Cadastro pelo site: guarda empresa, CNPJ, responsável, e-mail, telefone, IP e data da autorização.
  Pedidos não confirmados são apagados em ~7 dias; recusados, após 90 dias. Cobranças guardam
  empresa, valor, vencimento e e-mail de cobrança; o texto dos e-mails não é armazenado.
- **Base legal e prazo de retenção devem ser definidos pela Alpha Select.** O sistema não
  aplica prazo automático e nenhuma tela apresenta “aceite” como garantia de conformidade.

### Atendimento a solicitações de titulares

| Pedido | Procedimento |
| --- | --- |
| Correção | Equipe edita o cadastro (tela Candidatos → Editar). Fica na auditoria. |
| Acesso/exportação | Administrador: Candidatos → Dados → **Exportar dados do titular (JSON)** — cadastro, participações, comentários, histórico e lista de documentos (registrado na auditoria). Os arquivos são baixados individualmente na aba Documentos. Entregar ao titular por canal seguro. |
| Eliminação | Administrador: Candidatos → Dados → **Eliminar definitivamente** (digitar ELIMINAR). Remove participações, comentários, histórico, documentos e arquivos físicos. A auditoria guarda só identificadores. |

**Arquivar ≠ eliminar**: arquivar só oculta das listagens. Eliminação no sistema não
remove cópias já existentes em **backups**, que expiram conforme a política de retenção
dos backups; documente esse prazo para responder ao titular. Registros de auditoria são
mantidos sem dados pessoais.

## Backup e restauração

**Banco** (diário, com retenção definida pela Alpha Select):

```bash
pg_dump --format=custom --no-owner "$DATABASE_OWNER_URL" > alpha_$(date +%F).dump
```

**Arquivos** (mesma frequência e retenção; o backup deve ser consistente com o do banco):

```bash
tar -czf storage_$(date +%F).tar.gz -C "$STORAGE_DIR" files
```

Guarde os backups criptografados, em local separado do servidor, com acesso restrito.
Prefira os backups automáticos/PITR do provedor gerenciado quando disponíveis.

**Restauração** (testar ao menos trimestralmente em ambiente isolado):

1. Criar papéis e banco vazio (INSTALACAO, passo 1).
2. `pg_restore --no-owner --role=alpha_owner -d "$DATABASE_OWNER_URL" alpha_AAAA-MM-DD.dump`
3. Os privilégios de `alpha_app` vêm no dump (por isso os papéis precisam existir antes). Confira com `npm run db:migrate`, que deve informar nada pendente.
4. Extrair os arquivos em `STORAGE_DIR` (`tar -xzf ... -C "$STORAGE_DIR"`).
5. `npm run storage:cleanup -w server` para conferir consistência.
6. Após restaurar backup antigo, repetir eliminações feitas depois da data do backup.

## Resposta a incidentes (resumo)

1. **Conter**: desativar usuários/empresas afetados (efeito imediato); se necessário,
   apagar todas as sessões: `delete from sessions;` (como `alpha_owner`); trocar senhas
   dos papéis do banco e do SMTP.
2. **Investigar**: consultar `audit_events` (ações, usuários, IPs, horários) e logs do servidor.
3. **Erradicar e recuperar**: corrigir a causa; restaurar backup se houve alteração indevida.
4. **Comunicar**: a Alpha Select avalia a comunicação à ANPD e aos titulares conforme a LGPD
   e seu encarregado (DPO).
5. **Registrar** lições aprendidas e ajustes.
