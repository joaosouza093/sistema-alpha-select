import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, candidateApi } from '../../api/client';
import { Alert, Button, Checkbox, ConfirmDialog, Loading, TextField, fieldErrors, usePageTitle } from '../../components/ui';
import { fmtDate, fmtDateTime, fmtPhone, fmtSize, parseMoneyToCents } from '../../lib/format';
import { readHashToken } from '../auth/AuthShell';
import { PublicLayout } from './PublicLayout';

interface MyData {
  fullName: string;
  email: string;
  phone: string | null;
  city: string | null;
  salaryExpectation: number | null;
  consentAt: string | null;
  emailOptOutAt: string | null;
  createdAt: string;
  records: number;
  applications: { title: string; company: string | null; appliedAt: string; source: string; status: string }[];
  documents: { name: string; size: number; createdAt: string }[];
  messages: { subject: string; sentAt: string }[];
  deletionScheduledFor: string | null;
}

const STORAGE_KEY = 'alpha-candidate-token';
const readStored = () => {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
};
const store = (t: string | null) => {
  try {
    if (t) sessionStorage.setItem(STORAGE_KEY, t);
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* sem armazenamento: o link continua válido na aba */
  }
};

/** Área do candidato: acesso por link enviado ao e-mail, sem senha. */
export function MyDataPage() {
  usePageTitle('Meus dados');
  const [token, setToken] = useState<string | null>(() => {
    const t = readHashToken() ?? readStored();
    if (t) store(t);
    return t;
  });
  // Link aberto na mesma aba (só o fragmento muda, sem recarregar a página).
  useEffect(() => {
    const onHash = () => {
      const t = readHashToken();
      if (t) {
        store(t);
        setToken(t);
      }
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const exit = () => {
    store(null);
    setToken(null);
  };

  return (
    <PublicLayout>
      <div className="public-content narrow">
        {token ? <Portal token={token} onExit={exit} /> : <RequestLink />}
      </div>
    </PublicLayout>
  );
}

function RequestLink({ expired }: { expired?: boolean }) {
  const [email, setEmail] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setMsg((await api.post<{ message: string }>('/api/public/my-data/request', { email })).message);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível enviar. Tente novamente.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card card-body stack">
      <h1 style={{ margin: 0, fontSize: '1.4rem' }}>Meus dados</h1>
      {expired && <Alert kind="warning">Seu link expirou. Peça um novo abaixo.</Alert>}
      <p style={{ margin: 0 }}>
        Candidatou-se a uma vaga ou cadastrou seu currículo na Alpha Select? Aqui você vê, corrige, atualiza o currículo
        ou exclui os seus dados. Informe o e-mail usado no cadastro e enviaremos um link de acesso (sem senha).
      </p>
      {msg ? <Alert kind="success">{msg}</Alert> : (
        <form className="stack" onSubmit={submit} noValidate>
          {error && <Alert>{error}</Alert>}
          <TextField label="E-mail" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <div><Button type="submit" variant="primary" loading={busy} disabled={!email.includes('@')}>Enviar link de acesso</Button></div>
        </form>
      )}
    </div>
  );
}

function Portal({ token, onExit }: { token: string; onExit: () => void }) {
  const capi = candidateApi(token);
  const [data, setData] = useState<MyData | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await candidateApi(token).get<MyData>('/api/public/my-data'));
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [token]);
  useEffect(() => void load(), [load]);

  if (error instanceof ApiError && error.status === 401) {
    return <RequestLink expired />;
  }
  if (error) return <Alert>Não foi possível carregar seus dados. Tente novamente em instantes.</Alert>;
  if (!data) return <Loading />;

  const done = async (message: string) => {
    setNotice(message);
    await load();
    window.scrollTo({ top: 0 });
  };

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1 style={{ margin: 0, fontSize: '1.4rem' }}>Meus dados</h1>
        <Button size="sm" onClick={onExit}>Sair</Button>
      </div>
      {notice && <Alert kind="success">{notice}</Alert>}
      {data.deletionScheduledFor && (
        <Alert kind="warning">
          Pela política de privacidade, seus dados serão excluídos em {fmtDate(data.deletionScheduledFor)} por falta de atividade.
          Quer continuar no banco de talentos? Use o botão abaixo.
        </Alert>
      )}

      <ConsentCard data={data} capi={capi} onDone={done} />
      <ProfileForm data={data} capi={capi} onDone={done} />
      <ResumeCard data={data} token={token} onDone={done} />

      <section className="card">
        <div className="card-header"><h2>Minhas candidaturas</h2></div>
        <div className="card-body">
          {data.applications.length === 0 ? <p className="muted" style={{ margin: 0 }}>Nenhuma candidatura. Seu currículo está no banco de talentos.</p> : (
            <ul className="stack" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {data.applications.map((a, i) => (
                <li key={i} className="row" style={{ justifyContent: 'space-between' }}>
                  <div>
                    <strong>{a.title}</strong>
                    <div className="muted small">{a.company ?? 'Empresa parceira'} · {fmtDate(a.appliedAt)}</div>
                  </div>
                  <span className="badge">{a.status}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="card">
        <div className="card-header"><h2>E-mails recebidos</h2></div>
        <div className="card-body stack">
          {data.messages.length === 0 ? <p className="muted" style={{ margin: 0 }}>Nenhum e-mail automático enviado.</p> : (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {data.messages.map((m, i) => <li key={i}>{m.subject} <span className="muted small">— {fmtDateTime(m.sentAt)}</span></li>)}
            </ul>
          )}
          <EmailPrefs data={data} capi={capi} onDone={done} />
        </div>
      </section>

      <PrivacyCard capi={capi} onErased={() => { onExit(); }} />
    </div>
  );
}

type Capi = ReturnType<typeof candidateApi>;
type CardProps = { data: MyData; capi: Capi; onDone: (msg: string) => Promise<void> };

function ConsentCard({ data, capi, onDone }: CardProps) {
  const [busy, setBusy] = useState(false);
  const renew = async () => {
    setBusy(true);
    try {
      await capi.post('/api/public/my-data/consent');
      await onDone('Pronto! Você continua no banco de talentos da Alpha Select.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card">
      <div className="card-header"><h2>Banco de talentos</h2></div>
      <div className="card-body stack">
        <p style={{ margin: 0 }}>
          Cadastro desde {fmtDate(data.createdAt)}.
          {data.consentAt ? ` Autorização confirmada em ${fmtDate(data.consentAt)}.` : ''}
        </p>
        <div><Button variant="primary" loading={busy} onClick={renew}>Quero continuar no banco de talentos</Button></div>
      </div>
    </section>
  );
}

function ProfileForm({ data, capi, onDone }: CardProps) {
  const [f, setF] = useState({
    fullName: data.fullName,
    phone: data.phone ? fmtPhone(data.phone) : '',
    city: data.city ?? '',
    salary: data.salaryExpectation == null ? '' : String(data.salaryExpectation).replace('.', ','),
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const cents = f.salary.trim() ? parseMoneyToCents(f.salary) : null;
    if (f.salary.trim() && cents === null) return setErrors({ salaryExpectation: 'Valor inválido.' });
    setBusy(true);
    setErrors({});
    try {
      await capi.patch('/api/public/my-data', {
        fullName: f.fullName, phone: f.phone || null, city: f.city || null, salaryExpectation: cents === null ? null : cents / 100,
      });
      await onDone('Dados atualizados.');
    } catch (err) {
      setErrors({ _: err instanceof ApiError ? err.message : 'Não foi possível salvar.', ...fieldErrors(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card">
      <div className="card-header"><h2>Dados pessoais</h2></div>
      <form className="card-body stack" onSubmit={submit} noValidate>
        {errors._ && <Alert>{errors._}</Alert>}
        <TextField label="Nome completo" value={f.fullName} onChange={set('fullName')} maxLength={160} error={errors.fullName} required />
        <TextField label="E-mail" value={data.email} disabled hint="O e-mail identifica seu cadastro. Para trocar, fale com a Alpha Select." />
        <TextField label="Telefone / WhatsApp" type="tel" value={f.phone} onChange={set('phone')} error={errors.phone} />
        <TextField label="Cidade" value={f.city} onChange={set('city')} maxLength={120} error={errors.city} />
        <TextField label="Pretensão salarial (R$)" inputMode="decimal" value={f.salary} onChange={set('salary')} error={errors.salaryExpectation} />
        {data.records > 1 && <p className="muted small" style={{ margin: 0 }}>Encontramos {data.records} cadastros com seu e-mail; a correção vale para todos.</p>}
        <div><Button type="submit" variant="primary" loading={busy} disabled={f.fullName.trim().length < 2}>Salvar</Button></div>
      </form>
    </section>
  );
}

function ResumeCard({ data, token, onDone }: { data: MyData; token: string; onDone: (m: string) => Promise<void> }) {
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    const fd = new FormData();
    fd.append('curriculo', file);
    try {
      const res = await fetch('/api/public/my-data/resume', { method: 'POST', body: fd, headers: { 'X-Candidate-Token': token } });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error(j?.error?.message ?? 'Não foi possível enviar o arquivo.');
      }
      setFile(null);
      await onDone('Currículo enviado. A equipe da Alpha Select verá a versão mais nova.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card">
      <div className="card-header"><h2>Currículo</h2></div>
      <form className="card-body stack" onSubmit={send} noValidate>
        {error && <Alert>{error}</Alert>}
        {data.documents.length > 0 && (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {data.documents.map((d, i) => <li key={i}>{d.name} <span className="muted small">— {fmtSize(d.size)}, {fmtDate(d.createdAt)}</span></li>)}
          </ul>
        )}
        <div className="field">
          <label htmlFor="novo-curriculo">Enviar currículo atualizado (PDF, DOC, DOCX ou ODT)</label>
          <input id="novo-curriculo" type="file" accept=".pdf,.doc,.docx,.odt" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </div>
        <div><Button type="submit" loading={busy} disabled={!file}>Enviar</Button></div>
      </form>
    </section>
  );
}

function EmailPrefs({ data, capi, onDone }: CardProps) {
  const [busy, setBusy] = useState(false);
  const optedOut = !!data.emailOptOutAt;
  const toggle = async () => {
    setBusy(true);
    try {
      await capi.post('/api/public/my-data/email-preferences', { optOut: !optedOut });
      await onDone(optedOut ? 'Você voltará a receber e-mails sobre processos seletivos.' : 'Você não receberá mais e-mails automáticos sobre processos seletivos.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Checkbox label="Receber e-mails sobre minhas candidaturas e oportunidades" checked={!optedOut} disabled={busy} onChange={toggle} />
  );
}

function PrivacyCard({ capi, onErased }: { capi: Capi; onErased: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [erased, setErased] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const erase = async () => {
    try {
      await capi.post('/api/public/my-data/delete', { confirm: true });
      setConfirming(false);
      setErased(true);
      setTimeout(onErased, 4000);
    } catch (err) {
      setConfirming(false);
      setError(err instanceof ApiError ? err.message : 'Não foi possível excluir.');
    }
  };
  if (erased) return <Alert kind="success">Seus dados foram excluídos definitivamente.</Alert>;
  return (
    <section className="card">
      <div className="card-header"><h2>Privacidade</h2></div>
      <div className="card-body stack">
        {error && <Alert>{error}</Alert>}
        <p style={{ margin: 0 }}>Baixe uma cópia dos seus dados ou exclua seu cadastro. A exclusão é imediata, definitiva e
          encerra suas candidaturas em andamento.</p>
        <div className="row">
          <Button onClick={() => capi.download('/api/public/my-data/export', 'meus-dados-alpha-select.json').catch(() => setError('Não foi possível baixar.'))}>
            Baixar meus dados
          </Button>
          <Button variant="danger" onClick={() => setConfirming(true)}>Excluir meus dados</Button>
        </div>
      </div>
      {confirming && (
        <ConfirmDialog title="Excluir meus dados" danger
          message="Todos os seus dados, currículos e candidaturas na Alpha Select serão apagados definitivamente. Esta ação não pode ser desfeita."
          confirmLabel="Excluir definitivamente" requireText="EXCLUIR" onConfirm={erase} onCancel={() => setConfirming(false)} />
      )}
    </section>
  );
}
