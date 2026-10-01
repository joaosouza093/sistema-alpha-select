import type { ReactNode } from 'react';
import { brand } from '../../brand';
import { BrandLogo, Footer } from '../../layout/AppLayout';

/**
 * Estrutura das telas públicas (login, recuperação de senha, convite):
 * painel institucional azul-marinho com a marca e formulário em cartão claro.
 * O monograma grande é decorativo e fica só no painel, nunca atrás dos campos.
 */
export function AuthShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="auth-page">
      <aside className="auth-brand" aria-label="Alpha Select RH">
        <BrandLogo variant="horizontal" className="auth-logo" />
        <p className="auth-tagline">{brand.product}</p>
        <img
          src={brand.monogramInstitutional.src}
          width={brand.monogramInstitutional.width}
          height={brand.monogramInstitutional.height}
          alt=""
          aria-hidden="true"
          className="auth-watermark"
          decoding="async"
        />
      </aside>
      <div className="auth-main">
        <main className="auth-center">
          <div className="auth-card">
            <h1>{title}</h1>
            {children}
          </div>
        </main>
        <Footer className="auth-footer" />
      </div>
    </div>
  );
}

/** Lê o token do fragmento (#token=...) e o remove da barra de endereço. */
export function readHashToken(): string | null {
  const m = window.location.hash.match(/token=([A-Za-z0-9_-]+)/);
  if (m) window.history.replaceState(null, '', window.location.pathname);
  return m ? m[1]! : null;
}
