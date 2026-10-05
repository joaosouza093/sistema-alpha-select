import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { BrandLogo, Footer } from '../../layout/AppLayout';

/** Estrutura das páginas públicas (portal de vagas): sem dados internos, sem login. */
export function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <div className="public-page">
      <a href="#conteudo" className="skip-link">Pular para o conteúdo</a>
      <header className="public-header">
        <Link to="/vagas" className="public-brand" aria-label="Alpha Select — vagas abertas">
          <BrandLogo variant="horizontal" />
        </Link>
        <nav className="public-nav" aria-label="Portal de vagas">
          <NavLink to="/vagas" end>Vagas</NavLink>
          <NavLink to="/trabalhe-conosco">Cadastrar currículo</NavLink>
          <NavLink to="/entrar">Área restrita</NavLink>
        </nav>
      </header>
      <main id="conteudo" className="public-main" tabIndex={-1}>
        {children}
      </main>
      <Footer />
    </div>
  );
}
