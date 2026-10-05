import { useState } from 'react';
import { api, ApiError } from '../../api/client';
import { Alert, Button, usePageTitle } from '../../components/ui';
import { readHashToken } from '../auth/AuthShell';
import { PublicLayout } from './PublicLayout';

/** Descadastro de e-mails pelo link do rodapé das mensagens. */
export function UnsubscribePage() {
  usePageTitle('Cancelar e-mails');
  const [token] = useState(() => readHashToken());
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    setBusy(true);
    try {
      await api.post('/api/public/unsubscribe', { token });
      setDone(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Não foi possível concluir. Tente novamente.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <PublicLayout>
      <div className="public-content narrow">
        <div className="card card-body stack">
          <h1 style={{ margin: 0, fontSize: '1.4rem' }}>Cancelar e-mails</h1>
          {!token ? <Alert>Link inválido. Use o link do rodapé do e-mail recebido.</Alert> : done ? (
            <Alert kind="success">Pronto. Você não receberá mais e-mails automáticos sobre processos seletivos da Alpha Select.</Alert>
          ) : (
            <>
              {error && <Alert>{error}</Alert>}
              <p style={{ margin: 0 }}>Confirme para não receber mais e-mails automáticos sobre processos seletivos. Seu cadastro continua no banco de talentos.</p>
              <div><Button variant="primary" loading={busy} onClick={confirm}>Confirmar</Button></div>
            </>
          )}
        </div>
      </div>
    </PublicLayout>
  );
}
