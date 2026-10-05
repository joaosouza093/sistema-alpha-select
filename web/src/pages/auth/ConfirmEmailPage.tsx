import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../api/client';
import { Alert, usePageTitle } from '../../components/ui';
import { AuthShell, readHashToken } from './AuthShell';
import { PasswordForm } from './PasswordForm';

/** Link do e-mail de cadastro: confirma o endereço e define a senha. */
export function ConfirmEmailPage() {
  usePageTitle('Confirmar cadastro');
  const [token] = useState(() => readHashToken());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async (password: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/signup/verify', { token, password });
      setDone(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Não foi possível confirmar o cadastro.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Confirmar cadastro">
      {!token ? (
        <div className="stack">
          <Alert>Link inválido. Abra o link mais recente enviado ao seu e-mail ou faça o cadastro novamente.</Alert>
          <Link to="/cadastro">Fazer cadastro</Link>
        </div>
      ) : done ? (
        <div className="stack">
          <Alert kind="success">
            E-mail confirmado e senha criada. A Alpha Select vai analisar o cadastro e avisar por e-mail quando o acesso for liberado.
          </Alert>
          <Link to="/entrar">Ir para o login</Link>
        </div>
      ) : (
        <div className="stack">
          <p className="muted">Crie a senha que você vai usar para entrar no sistema.</p>
          {error && <Alert>{error}</Alert>}
          <PasswordForm onSubmit={submit} submitLabel="Confirmar e criar senha" busy={busy} />
        </div>
      )}
    </AuthShell>
  );
}
