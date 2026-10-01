# Identidade visual — Alpha Select RH

A cliente enviou uma **composição em JPEG** (1024×1280, sem transparência, não vetorial)
com as aplicações da marca. A interface usa **recortes** dessa composição, sem incluir os
outros elementos e sem recriar a logo com fonte parecida. São arquivos **provisórios** até
a entrega do SVG ou PNG transparente oficial.

## Arquivos

| Arquivo (`web/public/`) | Origem | Uso |
| --- | --- | --- |
| `brand/alpha-select-rh-horizontal.png` | recorte da versão horizontal “Alpha Select RH” | login (painel institucional) e menu lateral |
| `brand/alpha-select-monograma.png` | recorte do monograma “AS” | topo compacto no celular |
| `brand/alpha-select-monograma-institucional.png` | recorte do monograma grande translúcido | decoração discreta do painel institucional do login (nunca atrás de campos ou dados) |
| `favicon.ico`, `brand/icon-32/192/512.png`, `apple-touch-icon.png` | monograma “AS” centralizado em quadrado azul-marinho | favicon, atalho e manifesto |

Os recortes mantêm o fundo azul-marinho do arquivo original. Por isso só são usados sobre
superfícies com a mesma cor (`--navy: #0C1B32`, medida no arquivo), onde se fundem sem
borda visível. Não há esticamento: as imagens usam `width` proporcional e `height: auto`.

## Paleta (tokens em `web/src/styles.css`)

| Token | Valor | Observação |
| --- | --- | --- |
| `--navy` | `#0C1B32` | medido no arquivo (o briefing citava `#0C1B30`) |
| `--gold` | `#D39726` | do briefing; mediana medida no JPEG ≈ `#D59136` (variação de compressão) |
| `--gold-ink` | `#86590A` | dourado escurecido para **texto** sobre fundo claro |
| `--on-navy` | `#FFFFFF` | texto sobre azul-marinho |
| `--bg` | `#F5F7FA` | área de trabalho |

Contraste verificado (WCAG):

| Par | Razão | Uso permitido |
| --- | --- | --- |
| branco sobre azul-marinho | 17,2:1 | textos do menu e do login |
| dourado sobre azul-marinho | 6,75:1 | títulos de seção do menu, destaques |
| dourado sobre branco | **2,55:1** | **somente** fios, bordas, indicador de seleção e acentos decorativos — nunca texto |
| `--gold-ink` sobre branco | 6,1:1 | texto dourado em áreas claras, se necessário |
| texto `#1C2733` sobre branco | 15,1:1 | texto principal |
| texto secundário `#5B6875` sobre `#F5F7FA` | 5,3:1 | legendas |

Status (etapas, decisões, situação) continuam com cores distintas **e** rótulos textuais.

## Aplicação na interface

- Menu lateral azul-marinho, logo horizontal, item ativo com fundo translúcido e barra dourada à esquerda.
- Área principal clara, cartões brancos com bordas discretas; indicadores com fio dourado no topo.
- Botões principais azul-marinho com texto branco; abas selecionadas com sublinhado dourado e texto azul-marinho em negrito.
- Login, recuperação de senha e convite: painel institucional azul-marinho com a marca e cartão de formulário com fio dourado.
- Tipografia da interface: **Inter** (auto-hospedada via `@fontsource-variable/inter`, licença OFL), sem chamadas a CDN.
- Título: “Alpha Select | Gestão de Processos Seletivos” (cada página acrescenta o nome da seção, sem dados pessoais).
- Rodapé: “Tecnologia desenvolvida pela PMG Code”.

## Como substituir pelos arquivos oficiais

1. Salve o SVG ou PNG transparente em `web/public/brand/`.
2. Ajuste caminhos e dimensões em `web/src/brand.ts` (ponto único de configuração).
3. Com arquivos transparentes, a restrição de usar os recortes só sobre azul-marinho deixa de existir.
4. Regere os favicons a partir do monograma oficial.
5. `npm run build` e confira o contraste.
