/**
 * Identidade visual da Alpha Select — ponto único de configuração.
 *
 * Os arquivos atuais são RECORTES PROVISÓRIOS do JPEG de referência enviado
 * pela cliente (fundo azul-marinho, sem transparência, não vetoriais).
 * Quando o SVG ou PNG transparente oficial for entregue, substitua os
 * arquivos em web/public/brand/ (ou altere os caminhos abaixo).
 * Ver docs/IDENTIDADE_VISUAL.md.
 */
export const brand = {
  name: 'Alpha Select',
  product: 'Gestão de Processos Seletivos',
  /** Versão horizontal "Alpha Select RH" (login e áreas com espaço). */
  logoHorizontal: { src: '/brand/alpha-select-rh-horizontal.png', width: 889, height: 242 },
  /** Monograma "AS" (navegação compacta). */
  monogram: { src: '/brand/alpha-select-monograma.png', width: 263, height: 234 },
  /** Monograma grande translúcido — somente decorativo na área institucional do login. */
  monogramInstitutional: { src: '/brand/alpha-select-monograma-institucional.png', width: 429, height: 636 },
} as const;

export const appTitle = `${brand.name} | ${brand.product}`;
