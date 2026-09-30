import type { ReactNode } from 'react';
import { Brand, Footer } from '../../layout/AppLayout';

export function AuthShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="auth-page">
      <main className="auth-center">
        <div className="auth-card">
          <div className="brand">
            <Brand />
          </div>
          <h1 style={{ marginBottom: 16 }}>{title}</h1>
          {children}
        </div>
      </main>
      <Footer className="auth-footer" />
    </div>
  );
}

/** Lê o token do fragmento (#token=...) e o remove da barra de endereço. */
export function readHashToken(): string | null {
  const m = window.location.hash.match(/token=([A-Za-z0-9_-]+)/);
  if (m) window.history.replaceState(null, '', window.location.pathname);
  return m ? m[1]! : null;
}
