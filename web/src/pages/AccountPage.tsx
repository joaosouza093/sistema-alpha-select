import { useState, type FormEvent } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Button, PageHeader, TextField, fieldErrors, usePageTitle, useToast } from '../components/ui';
import { kindLabel } from '../lib/format';

export function AccountPage() {
  usePageTitle('Minha conta');
  const { user } = useAuth();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== confirm) return setErrors({ confirm: 'As senhas não conferem.' });
    setBusy(true);
    setErrors({});
    try {
      await api.post('/api/auth/password/change', { currentPassword: current, newPassword: next });
      toast.success('Senha alterada. Outras sessões abertas foram encerradas.');
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (err) {
      setErrors(fieldErrors(err));
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Minha conta" />
      <div className="grid grid-2">
        <section className="card">
          <div className="card-header"><h2>Dados de acesso</h2></div>
          <div className="card-body">
            <dl className="dl">
              <dt>Nome</dt><dd>{user?.fullName}</dd>
              <dt>E-mail</dt><dd>{user?.email}</dd>
              <dt>Perfil</dt><dd>{user && kindLabel[user.kind]}</dd>
            </dl>
            <p className="muted small" style={{ marginTop: 12 }}>
              Perfil, empresa e permissões são definidos pela administração da Alpha Select.
            </p>
          </div>
        </section>
        <section className="card">
          <div className="card-header"><h2>Alterar senha</h2></div>
          <form className="card-body stack" onSubmit={submit} noValidate>
            <TextField label="Senha atual" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
            <TextField label="Nova senha" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} hint="Mínimo de 10 caracteres." error={errors.newPassword} required />
            <TextField label="Confirme a nova senha" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} error={errors.confirm} required />
            <div className="form-actions">
              <Button type="submit" variant="primary" loading={busy} disabled={!current || next.length < 10}>Alterar senha</Button>
            </div>
          </form>
        </section>
      </div>
    </>
  );
}
