# Identidade visual

A logo oficial e o manual de marca da Alpha Select **não foram fornecidos**. A interface
usa uma apresentação **provisória** e sóbria (monograma “AS” em azul-marinho), que não
deve ser tratada como logo oficial.

## Como substituir

1. **Logo na interface**: `web/src/layout/AppLayout.tsx`, componente `Brand` — trocar o
   `<span className="brand-mark">AS</span>` por `<img src="/logo.svg" alt="" />` e colocar
   o arquivo em `web/public/`.
2. **Favicon**: substituir `web/public/favicon.svg` (e, se desejado, adicionar PNG 32/180 px
   e as tags correspondentes em `web/index.html`).
3. **Cores e tipografia**: tokens no topo de `web/src/styles.css` (`--brand`, `--accent`,
   `--font`...). Fontes externas exigem ajustar a CSP em `server/src/app.ts`.
4. `theme-color` e descrição em `web/index.html`.
5. Rodar `npm run build` e conferir contraste (WCAG AA) após a troca.

O rodapé “Tecnologia desenvolvida pela PMG Code” está em `Footer` (`AppLayout.tsx`).
