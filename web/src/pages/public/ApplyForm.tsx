import { useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import { Alert, Button, Checkbox, TextField, fieldErrors } from '../../components/ui';
import { parseMoneyToCents } from '../../lib/format';

const ACCEPT = '.pdf,.doc,.docx,.odt,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.oasis.opendocument.text';

/**
 * Formulário de candidatura (com vaga) ou de banco de talentos (sem vaga).
 * Envia "dados" (JSON) antes do arquivo "curriculo".
 */
export function ApplyForm({ endpoint, questions = [], title }: { endpoint: string; questions?: { id: string; text: string }[]; title: string }) {
  const opts = useQuery({ queryKey: ['auth-options'], queryFn: () => api.get<{ maxUploadMb?: number }>('/api/auth/options'), staleTime: Infinity });
  const [f, setF] = useState({ fullName: '', email: '', phone: '', city: '', salary: '' });
  const [answers, setAnswers] = useState<Record<string, 'sim' | 'nao'>>({});
  const [file, setFile] = useState<File | null>(null);
  const [accept, setAccept] = useState(false);
  const [whatsapp, setWhatsapp] = useState(false);
  const [website, setWebsite] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const maxMb = opts.data?.maxUploadMb ?? 4;
  const tooBig = !!file && file.size > maxMb * 1024 * 1024;
  const salaryCents = f.salary ? parseMoneyToCents(f.salary) : null;
  const allAnswered = questions.every((q) => answers[q.id]);
  const ready = f.fullName.trim().length >= 2 && f.email && file && !tooBig && accept && allAnswered && (!f.salary || salaryCents !== null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready || !file) return;
    setBusy(true);
    setError(null);
    setErrors({});
    const data = {
      fullName: f.fullName,
      email: f.email,
      phone: f.phone || null,
      city: f.city || null,
      salaryExpectation: salaryCents !== null ? salaryCents / 100 : null,
      answers: questions.map((q) => ({ id: q.id, answer: answers[q.id] })),
      acceptPrivacy: accept,
      whatsappOptIn: whatsapp && !!f.phone,
      ...(website ? { website } : {}),
    };
    const fd = new FormData();
    fd.append('dados', JSON.stringify(data));
    fd.append('curriculo', file);
    try {
      const r = await api.post<{ message: string }>(endpoint, fd);
      setDone(r?.message ?? 'Recebido. Obrigado!');
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(err instanceof ApiError ? err.message : 'Não foi possível enviar. Tente novamente.');
    } finally {
      setBusy(false);
    }
  };

  if (done) return <Alert kind="success">{done}</Alert>;

  return (
    <form className="stack" onSubmit={submit} noValidate aria-label={title}>
      {error && <Alert>{error}</Alert>}
      <TextField label="Nome completo" value={f.fullName} onChange={set('fullName')} autoComplete="name" maxLength={160} required error={errors.fullName} />
      <TextField label="E-mail" type="email" value={f.email} onChange={set('email')} autoComplete="email" required error={errors.email} />
      <TextField label="Telefone / WhatsApp" type="tel" value={f.phone} onChange={set('phone')} autoComplete="tel" error={errors.phone} hint="Opcional." />
      {f.phone && (
        <Checkbox checked={whatsapp} onChange={(e) => setWhatsapp(e.target.checked)}
          label="Quero receber avisos sobre esta candidatura pelo WhatsApp (para cancelar, é só responder SAIR)." />
      )}
      <TextField label="Cidade" value={f.city} onChange={set('city')} autoComplete="address-level2" maxLength={120} error={errors.city} hint="Opcional." />
      <TextField label="Pretensão salarial (R$)" value={f.salary} onChange={set('salary')} inputMode="decimal"
        error={f.salary && salaryCents === null ? 'Valor inválido.' : errors.salaryExpectation} hint="Opcional." />
      {questions.map((q) => (
        <fieldset key={q.id} className="question">
          <legend>{q.text} <span aria-hidden>*</span></legend>
          <div className="row">
            {(['sim', 'nao'] as const).map((v) => (
              <label key={v} className="checkbox">
                <input type="radio" name={`q-${q.id}`} value={v} checked={answers[q.id] === v} onChange={() => setAnswers((a) => ({ ...a, [q.id]: v }))} required />
                <span>{v === 'sim' ? 'Sim' : 'Não'}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ))}
      <div className="field">
        <label htmlFor="curriculo">Currículo <span aria-hidden>*</span></label>
        <input id="curriculo" ref={fileRef} type="file" accept={ACCEPT} className="input" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required />
        <span className="hint">PDF, DOC, DOCX ou ODT, até {maxMb} MB.</span>
        {tooBig && <span className="error" role="alert">Arquivo acima de {maxMb} MB.</span>}
      </div>
      {/* Campo isca para robôs: invisível e fora da navegação. */}
      <div className="sr-only" aria-hidden="true">
        <label htmlFor="website">Site</label>
        <input id="website" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
      </div>
      <details className="privacy">
        <summary>Aviso de privacidade</summary>
        <p>
          A Alpha Select usa seus dados (nome, contatos, cidade, pretensão, currículo e respostas) para analisar sua candidatura e
          para futuras oportunidades compatíveis do banco de talentos. Seus dados só são apresentados a uma empresa contratante
          se o seu perfil avançar no processo. Você pode consultar, corrigir, baixar ou excluir seus dados a qualquer momento em{' '}
          <a href="/meus-dados" target="_blank" rel="noreferrer">Meus dados</a>. Se não houver atividade no seu cadastro por um
          longo período, avisaremos por e-mail antes de excluí-lo.
        </p>
      </details>
      <Checkbox checked={accept} onChange={(e) => setAccept(e.target.checked)}
        label="Li o aviso de privacidade e autorizo o tratamento dos meus dados para processos seletivos da Alpha Select." />
      <Button type="submit" variant="primary" loading={busy} disabled={!ready}>Enviar</Button>
    </form>
  );
}
