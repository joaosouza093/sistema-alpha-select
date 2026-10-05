import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Alert, Button, TextField, usePageTitle } from '../../components/ui';
import { AuthShell } from './AuthShell';

export function LoginPage() {
  usePageTitle('Entrar');
  const { user, login, expired } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const from = (loc.state as { from?: string } | null)?.from ?? '/';

  if (user) return <Navigate to={from} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
      nav(from, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível entrar.');
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Entrar">
      <form onSubmit={submit} className="stack" noValidate>
        {expired && !error && <Alert kind="warning">Sua sessão expirou. Entre novamente para continuar.</Alert>}
        {error && <Alert>{error}</Alert>}
        <TextField label="E-mail" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <TextField
          label="Senha"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <Button type="submit" variant="primary" loading={busy} disabled={!email || !password}>
          Entrar
        </Button>
        <Link to="/esqueci-senha" className="small">
          Esqueci minha senha
        </Link>
        <p className="muted small">
          Ainda não tem acesso? <Link to="/cadastro">Cadastre sua empresa</Link>
        </p>
      </form>
    </AuthShell>
  );
}
