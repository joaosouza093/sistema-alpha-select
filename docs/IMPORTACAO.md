# Importação de candidatos por planilha

Corresponde à "importação autorizada" do escopo (entrada do candidato, seção 2.1) e à migração piloto do Marco 6.
Somente administradores: **Candidatos → Importar planilha**.

## Como funciona

1. Salve a planilha como **CSV** (no Excel: Arquivo → Salvar como → CSV). O sistema aceita `;`, `,` ou tabulação e
   reconhece arquivos do Excel em português (Windows-1252) e UTF-8. Há um **modelo** para baixar na própria tela.
2. Colunas reconhecidas pelo nome do título (sem diferença de maiúsculas e acentos): **Nome** (obrigatória), E-mail,
   Telefone (ou Celular/WhatsApp), Cidade, Pretensão salarial, Observações. Outras colunas são ignoradas e listadas.
3. A **prévia** mostra quantos serão importados e cada linha com problema. Nada é gravado nessa etapa.
   - *Com erro*: nome ausente, e-mail, telefone ou pretensão inválidos.
   - *Já cadastrado*: mesmo e-mail ou telefone de um candidato existente (não entra de novo).
   - *Repetido no arquivo*: mesmo e-mail ou telefone de uma linha anterior da planilha.
4. Informe **de onde vieram os dados** (ex.: "banco de currículos antigo da Alpha Select") e confirme. O servidor valida o
   arquivo inteiro de novo; só as linhas válidas entram, com origem "importação". O registro vai para a auditoria com
   a origem informada e as contagens.

Limites: até 5.000 candidatos e 3 MB por arquivo. Importar o mesmo arquivo de novo não duplica ninguém.

## LGPD

Candidatos importados não têm consentimento registrado no sistema; a base legal para tratar esses dados é decisão da
Alpha Select (informe-a no campo de origem). Eles entram na regra de retenção contando a partir da data da importação
e podem consultar, corrigir ou excluir os dados em **Meus dados**, como qualquer candidato.
