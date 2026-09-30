import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { kindLabel } from '../lib/format';
import { Button } from '../components/ui';

export function Footer({ className = 'footer' }: { className?: string }) {
  return <footer className={className}>Tecnologia desenvolvida pela PMG Code</footer>;
}

export function Brand() {
  return (
    <>
      {/* Marca provisória — substituir pela logo oficial da Alpha Select quando fornecida. */}
      <span className="brand-mark" aria-hidden>
        AS
      </span>
      <span>
        <span className="brand-name">Alpha Select</span>
        <span className="brand-sub">Processos seletivos</span>
      </span>
    </>
  );
}

export function AppLayout() {
  const { user, isAdmin, isAlpha, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);

  return (
    <div className="app-shell">
      <a href="#conteudo" className="skip-link">
        Pular para o conteúdo
      </a>
      {open && <div className="backdrop" onClick={() => setOpen(false)} aria-hidden />}
      <aside className={`sidebar ${open ? 'open' : ''}`} aria-label="Menu principal">
        <NavLink to="/" className="brand" aria-label="Alpha Select — página inicial">
          <Brand />
        </NavLink>
        <nav className="nav">
          <NavLink to="/" end>
            Painel
          </NavLink>
          <NavLink to="/processos">Processos seletivos</NavLink>
          {isAlpha && <NavLink to="/candidatos">Candidatos</NavLink>}
          {isAdmin && (
            <>
              <div className="nav-section">Administração</div>
              <NavLink to="/clientes">Empresas clientes</NavLink>
              <NavLink to="/usuarios">Usuários e convites</NavLink>
              <NavLink to="/auditoria">Auditoria</NavLink>
            </>
          )}
          <div className="nav-section">Conta</div>
          <NavLink to="/conta">Minha conta</NavLink>
        </nav>
        <div className="sidebar-user">
          <strong>{user?.fullName}</strong>
          <span className="role">{user ? kindLabel[user.kind] : ''}</span>
          <div style={{ marginTop: 8 }}>
            <Button size="sm" onClick={() => void logout()}>
              Sair
            </Button>
          </div>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <NavLink to="/" className="brand" aria-label="Alpha Select — página inicial">
            <Brand />
          </NavLink>
          <Button size="sm" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label="Abrir menu">
            Menu
          </Button>
        </header>
        <main id="conteudo" className="content" tabIndex={-1}>
          <Outlet />
        </main>
        <Footer />
      </div>
    </div>
  );
}
