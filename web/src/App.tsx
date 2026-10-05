import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { Loading } from './components/ui';
import { AppLayout } from './layout/AppLayout';
import { LoginPage } from './pages/auth/LoginPage';
import { ForgotPasswordPage } from './pages/auth/ForgotPasswordPage';
import { ResetPasswordPage } from './pages/auth/ResetPasswordPage';
import { AcceptInvitePage } from './pages/auth/AcceptInvitePage';
import { SignupPage } from './pages/auth/SignupPage';
import { ConfirmEmailPage } from './pages/auth/ConfirmEmailPage';
import { SignupsPage } from './pages/admin/SignupsPage';
import { BillingPage } from './pages/admin/BillingPage';
import { DashboardPage } from './pages/DashboardPage';
import { ProcessListPage } from './pages/processes/ProcessListPage';
import { ProcessPage } from './pages/processes/ProcessPage';
import { ApplicationPage } from './pages/applications/ApplicationPage';
import { CandidateListPage } from './pages/candidates/CandidateListPage';
import { CandidateFormPage } from './pages/candidates/CandidateFormPage';
import { CandidatePage } from './pages/candidates/CandidatePage';
import { CompaniesPage } from './pages/admin/CompaniesPage';
import { UsersPage } from './pages/admin/UsersPage';
import { AuditPage } from './pages/admin/AuditPage';
import { AccountPage } from './pages/AccountPage';
import { NotFoundPage } from './pages/NotFoundPage';

function RequireAuth({ children, alpha, admin }: { children: ReactNode; alpha?: boolean; admin?: boolean }) {
  const { user, loading, isAlpha, isAdmin } = useAuth();
  const loc = useLocation();
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/entrar" replace state={{ from: loc.pathname }} />;
  // Proteção de interface apenas; a autorização efetiva é feita no servidor e no banco.
  if ((admin && !isAdmin) || (alpha && !isAlpha)) return <NotFoundPage />;
  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route path="/entrar" element={<LoginPage />} />
      <Route path="/esqueci-senha" element={<ForgotPasswordPage />} />
      <Route path="/redefinir-senha" element={<ResetPasswordPage />} />
      <Route path="/convite" element={<AcceptInvitePage />} />
      <Route path="/cadastro" element={<SignupPage />} />
      <Route path="/confirmar-email" element={<ConfirmEmailPage />} />
      <Route
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="processos" element={<ProcessListPage />} />
        <Route path="processos/:id" element={<ProcessPage />} />
        <Route path="participacoes/:id" element={<ApplicationPage />} />
        <Route path="candidatos" element={<RequireAuth alpha><CandidateListPage /></RequireAuth>} />
        <Route path="candidatos/novo" element={<RequireAuth alpha><CandidateFormPage /></RequireAuth>} />
        <Route path="candidatos/:id" element={<RequireAuth alpha><CandidatePage /></RequireAuth>} />
        <Route path="candidatos/:id/editar" element={<RequireAuth alpha><CandidateFormPage /></RequireAuth>} />
        <Route path="clientes" element={<RequireAuth admin><CompaniesPage /></RequireAuth>} />
        <Route path="usuarios" element={<RequireAuth admin><UsersPage /></RequireAuth>} />
        <Route path="cadastros" element={<RequireAuth admin><SignupsPage /></RequireAuth>} />
        <Route path="cobrancas" element={<RequireAuth admin><BillingPage /></RequireAuth>} />
        <Route path="auditoria" element={<RequireAuth admin><AuditPage /></RequireAuth>} />
        <Route path="conta" element={<AccountPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
