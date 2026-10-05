import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../api/client';
import { Alert, Button, Checkbox, TextField, fieldErrors, usePageTitle } from '../../components/ui';
import { AuthShell } from './AuthShell';

/** Cadastro de empresa cliente. O acesso só é liberado após aprovação da Alpha Select. */
export function SignupPage() {
  usePageTitle('Criar cadastro');
  const [form, setForm] = useState({ companyName: '', cnpj: '', fullName: '', email: '', phone: '' });
  const [accept, setAccept] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setErrors({});
    try {
      const r = await api.post<{ message: string }>('/api/auth/signup', {
        ...form,
        cnpj: form.cnpj || null,
        phone: form.phone || null,
        acceptTerms: accept,
      });
      setDone(r.message);
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(err instanceof ApiError ? err.message : 'Não foi possível enviar o cadastro.');
    } finally {
      setBusy(false);
    }
  };

  const ready = form.companyName.trim().length >= 2 && form.fullName.trim().length >= 2 && form.email && accept;

  return (
    <AuthShell title="Criar cadastro">
      {done ? (
        <div className="stack">
          <Alert kind="success">{done}</Alert>
          <Link to="/entrar">Voltar para o login</Link>
        </div>
      ) : (
        <form onSubmit={submit} className="stack" noValidate>
          <p className="muted">Cadastre sua empresa. A equipe da Alpha Select analisa o pedido e libera o acesso.</p>
          {error && <Alert>{error}</Alert>}
          <TextField label="Nome da empresa" value={form.companyName} onChange={set('companyName')} error={errors.companyName} maxLength={160} autoComplete="organization" required />
          <TextField label="CNPJ" value={form.cnpj} onChange={set('cnpj')} error={errors.cnpj} inputMode="numeric" maxLength={18} hint="Opcional." />
          <TextField label="Seu nome" value={form.fullName} onChange={set('fullName')} error={errors.fullName} maxLength={120} autoComplete="name" required />
          <TextField label="E-mail" type="email" value={form.email} onChange={set('email')} error={errors.email} autoComplete="email" required
            hint="Você vai receber um link neste e-mail para criar sua senha." />
          <TextField label="Telefone" type="tel" value={form.phone} onChange={set('phone')} error={errors.phone} autoComplete="tel" hint="Opcional." />
          <Checkbox
            checked={accept}
            onChange={(e) => setAccept(e.target.checked)}
            label="Autorizo a Alpha Select a usar estes dados para analisar o cadastro e entrar em contato."
          />
          {errors.acceptTerms && <span className="error" role="alert">{errors.acceptTerms}</span>}
          <Button type="submit" variant="primary" loading={busy} disabled={!ready}>
            Enviar cadastro
          </Button>
          <Link to="/entrar" className="small">
            Já tenho acesso
          </Link>
        </form>
      )}
    </AuthShell>
  );
}
