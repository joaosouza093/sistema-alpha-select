import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Alert, Button, TextField, usePageTitle } from '../../components/ui';
import { AuthShell } from './AuthShell';

export function LoginPage() {
  usePageTitle('Entrar');
  const { user, login, completeMfa, expired } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const from = (loc.state as { from?: string } | null)?.from ?? '/';

  if (user) return <Navigate to={from} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const challenge = await login(email, password);
      if (challenge) {
        setMfaToken(challenge.mfaToken);
        setPassword('');
        return;
      }
      nav(from, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível entrar.');
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (e: FormEvent) => {
    e.preventDefault();
    if (!mfaToken) return;
    setBusy(true);
    setError(null);
    try {
      await completeMfa(mfaToken, code);
      nav(from, { replace: true });
    } catch (err) {
      setCode('');
      if (err instanceof ApiError && err.status === 401) {
        // Desafio expirado ou tentativas esgotadas: volta para e-mail e senha.
        setMfaToken(null);
        setUseRecovery(false);
      }
      setError(err instanceof ApiError ? err.message : 'Não foi possível entrar.');
    } finally {
      setBusy(false);
    }
  };

  if (mfaToken) {
    return (
      <AuthShell title="Verificação em duas etapas">
        <form onSubmit={submitCode} className="stack" noValidate>
          {error && <Alert>{error}</Alert>}
          <p className="muted" style={{ margin: 0 }}>
            {useRecovery
              ? 'Digite um dos códigos de recuperação que você guardou ao ativar a verificação. Cada código só funciona uma vez.'
              : 'Abra o aplicativo autenticador no celular e digite o código de 6 dígitos da Alpha Select.'}
          </p>
          <TextField
            label={useRecovery ? 'Código de recuperação' : 'Código do aplicativo'}
            inputMode={useRecovery ? 'text' : 'numeric'}
            autoComplete="one-time-code"
            autoFocus
            maxLength={useRecovery ? 12 : 6}
            value={code}
            onChange={(e) => setCode(useRecovery ? e.target.value.toUpperCase() : e.target.value.replace(/\D/g, ''))}
            required
          />
          <Button type="submit" variant="primary" loading={busy} disabled={useRecovery ? code.length < 8 : code.length !== 6}>
            Confirmar
          </Button>
          <button type="button" className="link-button small" onClick={() => { setUseRecovery(!useRecovery); setCode(''); setError(null); }}>
            {useRecovery ? 'Usar o código do aplicativo' : 'Perdeu o celular? Use um código de recuperação'}
          </button>
          <button type="button" className="link-button small" onClick={() => { setMfaToken(null); setCode(''); setError(null); }}>
            Voltar
          </button>
        </form>
      </AuthShell>
    );
  }

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
        <p className="muted small" style={{ margin: 0 }}>
          Procurando emprego? <Link to="/vagas">Veja as vagas abertas</Link>
        </p>
      </form>
    </AuthShell>
  );
}
