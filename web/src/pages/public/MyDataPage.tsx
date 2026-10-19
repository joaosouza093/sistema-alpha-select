import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, candidateApi } from '../../api/client';
import { Alert, Button, Checkbox, ConfirmDialog, Loading, TextField, fieldErrors, usePageTitle } from '../../components/ui';
import { fmtDate, fmtDateTime, fmtPhone, fmtSize, parseMoneyToCents } from '../../lib/format';
import { readHashToken } from '../auth/AuthShell';
import { PublicLayout } from './PublicLayout';
import type { AdmissionData } from '../../api/types';
import { UFS, maritalLabel, sexLabel, fmtCpf } from '../../lib/format';
import { SelectField, TextArea } from '../../components/ui';
import { ProfileFields, profileFrom, profilePayload } from '../../components/ProfileFields';

interface MyData {
  fullName: string;
  email: string;
  phone: string | null;
  city: string | null;
  salaryExpectation: number | null;
  birthDate: string | null;
  addressStreet: string | null;
  addressNumber: string | null;
  addressComplement: string | null;
  addressDistrict: string | null;
  state: string | null;
  postalCode: string | null;
  desiredRole: string | null;
  linkedinUrl: string | null;
  educationLevel: string | null;
  course: string | null;
  institution: string | null;
  educationStatus: string | null;
  consentAt: string | null;
  emailOptOutAt: string | null;
  whatsappOptInAt: string | null;
  createdAt: string;
  records: number;
  applications: { title: string; company: string | null; appliedAt: string; source: string; status: string }[];
  documents: { name: string; size: number; createdAt: string }[];
  messages: { subject: string; sentAt: string }[];
  deletionScheduledFor: string | null;
  admission: { available: boolean; data: AdmissionData | null; consentText: string };
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

      {data.admission.available && <AdmissionCard data={data} capi={capi} onDone={done} />}
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
        <div className="card-header"><h2>Mensagens recebidas</h2></div>
        <div className="card-body stack">
          {data.messages.length === 0 ? <p className="muted" style={{ margin: 0 }}>Nenhuma mensagem automática enviada.</p> : (
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
    salary: data.salaryExpectation == null ? '' : String(data.salaryExpectation).replace('.', ','),
  });
  const [profile, setProfile] = useState(() => profileFrom(data));
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
        ...profilePayload(profile), fullName: f.fullName, phone: f.phone || null, salaryExpectation: cents === null ? null : cents / 100,
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
        <ProfileFields value={profile} onChange={setProfile} errors={errors} sections={['personal', 'address']} />
        <h3 className="form-section">Informações profissionais</h3>
        <ProfileFields value={profile} onChange={setProfile} errors={errors} sections={['professional']} />
        <TextField label="Pretensão salarial (R$)" inputMode="decimal" value={f.salary} onChange={set('salary')} error={errors.salaryExpectation} />
        <h3 className="form-section">Formação</h3>
        <ProfileFields value={profile} onChange={setProfile} errors={errors} sections={['education']} framed={false} />
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
  const [error, setError] = useState<string | null>(null);
  // A caixa muda na hora; volta ao estado anterior se o servidor recusar.
  const [emailOn, setEmailOn] = useState(!data.emailOptOutAt);
  const [waOn, setWaOn] = useState(!!data.whatsappOptInAt);

  const save = async (apply: (v: boolean) => void, next: boolean, url: string, body: object, ok: string) => {
    apply(next);
    setBusy(true);
    setError(null);
    try {
      await capi.post(url, body);
      await onDone(ok);
    } catch (err) {
      apply(!next);
      setError(err instanceof ApiError ? err.message : 'Não foi possível salvar.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {error && <Alert>{error}</Alert>}
      <Checkbox label="Receber e-mails sobre minhas candidaturas e oportunidades" checked={emailOn} disabled={busy}
        onChange={() => save(setEmailOn, !emailOn, '/api/public/my-data/email-preferences', { optOut: emailOn },
          emailOn ? 'Você não receberá mais e-mails automáticos sobre processos seletivos.' : 'Você voltará a receber e-mails sobre processos seletivos.')} />
      <Checkbox label="Receber avisos pelo WhatsApp (no telefone do cadastro)" checked={waOn} disabled={busy}
        onChange={() => save(setWaOn, !waOn, '/api/public/my-data/whatsapp', { optIn: !waOn },
          waOn ? 'Você não receberá mais avisos pelo WhatsApp.' : 'Pronto: você receberá avisos pelo WhatsApp no telefone do seu cadastro.')}
        hint={data.phone ? undefined : 'Cadastre um telefone em Dados pessoais para ativar.'} />
    </>
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

const maskCpf = (v: string) => {
  const d = v.replace(/\D/g, '').slice(0, 11);
  return d.replace(/^(\d{3})(\d)/, '$1.$2').replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d{1,2})$/, '.$1-$2');
};

/** Dados pessoais para admissão: aparece só depois da aprovação no processo seletivo. */
function AdmissionCard({ data, capi, onDone }: CardProps) {
  const d = data.admission.data;
  const [f, setF] = useState({
    fullName: d?.fullName ?? data.fullName, birthDate: d?.birthDate ?? data.birthDate ?? '', sex: d?.sex ?? '', maritalStatus: d?.maritalStatus ?? '',
    nationality: d?.nationality ?? 'Brasileira', birthplaceCity: d?.birthplaceCity ?? '', birthplaceState: d?.birthplaceState ?? '',
    cpf: d?.cpf ? fmtCpf(d.cpf) : '', rg: d?.rg ?? '', rgIssuer: d?.rgIssuer ?? '', rgState: d?.rgState ?? '', rgIssueDate: d?.rgIssueDate ?? '',
    address: d?.address ?? '', mobilePhone: d?.mobilePhone ? fmtPhone(d.mobilePhone) : data.phone ? fmtPhone(data.phone) : '',
    motherName: d?.motherName ?? '', fatherName: d?.fatherName ?? '',
  });
  const [accept, setAccept] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: k === 'cpf' ? maskCpf(e.target.value) : e.target.value });
  const today = new Date().toISOString().slice(0, 10);
  const required: (keyof typeof f)[] = ['fullName', 'birthDate', 'sex', 'maritalStatus', 'nationality', 'birthplaceCity', 'birthplaceState', 'cpf', 'rg',
    'rgIssuer', 'rgState', 'rgIssueDate', 'address', 'mobilePhone', 'motherName'];
  const complete = required.every((k) => f[k].trim());

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      await capi.put('/api/public/my-data/admission', { ...f, fatherName: f.fatherName || null, acceptTerms: accept });
      setAccept(false);
      await onDone('Dados para admissão enviados. Obrigado!');
    } catch (err) {
      setErrors({ _: err instanceof ApiError ? err.message : 'Não foi possível enviar.', ...fieldErrors(err) });
    } finally {
      setBusy(false);
    }
  };
  const uf = (k: 'birthplaceState' | 'rgState', label: string) => (
    <SelectField label={label} value={f[k]} onChange={set(k)} required error={errors[k]}>
      <option value="">Selecione</option>
      {UFS.map((u) => <option key={u} value={u}>{u}</option>)}
    </SelectField>
  );
  return (
    <section className="card">
      <div className="card-header"><h2>Dados pessoais para admissão</h2></div>
      <form className="card-body stack" onSubmit={submit} noValidate>
        <Alert kind={d ? 'success' : 'info'}>
          {d ? <>Recebemos seus dados em {fmtDateTime(d.updatedAt)}. Se precisar corrigir algo, altere abaixo e envie de novo.</>
            : <>Você foi aprovado(a) no processo seletivo. Preencha seus dados para a admissão. Eles são vistos somente pela equipe da Alpha Select.</>}
        </Alert>
        {errors._ && <Alert>{errors._}</Alert>}
        <TextField label="Nome completo" value={f.fullName} onChange={set('fullName')} maxLength={160} required error={errors.fullName} autoComplete="name" />
        <div className="grid grid-3">
          <TextField label="Data de nascimento" type="date" value={f.birthDate} onChange={set('birthDate')} max={today} required error={errors.birthDate} />
          <SelectField label="Sexo" value={f.sex} onChange={set('sex')} required error={errors.sex}>
            <option value="">Selecione</option>
            {Object.entries(sexLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </SelectField>
          <SelectField label="Estado civil" value={f.maritalStatus} onChange={set('maritalStatus')} required error={errors.maritalStatus}>
            <option value="">Selecione</option>
            {Object.entries(maritalLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </SelectField>
        </div>
        <div className="grid grid-3">
          <TextField label="Nacionalidade" value={f.nationality} onChange={set('nationality')} maxLength={60} required error={errors.nationality} />
          <TextField label="Naturalidade (cidade)" value={f.birthplaceCity} onChange={set('birthplaceCity')} maxLength={120} required error={errors.birthplaceCity} />
          {uf('birthplaceState', 'Naturalidade (UF)')}
        </div>
        <div className="grid grid-2">
          <TextField label="CPF" value={f.cpf} onChange={set('cpf')} inputMode="numeric" maxLength={14} required error={errors.cpf} />
          <TextField label="RG" value={f.rg} onChange={set('rg')} maxLength={20} required error={errors.rg} />
        </div>
        <div className="grid grid-3">
          <TextField label="Órgão emissor do RG" value={f.rgIssuer} onChange={set('rgIssuer')} maxLength={20} placeholder="Ex.: SSP" required error={errors.rgIssuer} />
          {uf('rgState', 'UF do RG')}
          <TextField label="Data de emissão do RG" type="date" value={f.rgIssueDate} onChange={set('rgIssueDate')} max={today} required error={errors.rgIssueDate} />
        </div>
        <TextArea label="Endereço completo" value={f.address} onChange={set('address')} maxLength={300} rows={2} required error={errors.address}
          placeholder="Rua, número, complemento, bairro, cidade/UF e CEP" />
        <TextField label="Telefone celular" type="tel" value={f.mobilePhone} onChange={set('mobilePhone')} required error={errors.mobilePhone} autoComplete="tel" />
        <div className="grid grid-2">
          <TextField label="Nome completo da mãe" value={f.motherName} onChange={set('motherName')} maxLength={160} required error={errors.motherName} />
          <TextField label="Nome do pai" value={f.fatherName} onChange={set('fatherName')} maxLength={160} hint="Opcional." error={errors.fatherName} />
        </div>
        <Checkbox checked={accept} onChange={(e) => setAccept(e.target.checked)} label={data.admission.consentText} />
        {errors.acceptTerms && <span className="error" role="alert">{errors.acceptTerms}</span>}
        <div><Button type="submit" variant="primary" loading={busy} disabled={!accept || !complete}>Enviar dados</Button></div>
      </form>
    </section>
  );
}
