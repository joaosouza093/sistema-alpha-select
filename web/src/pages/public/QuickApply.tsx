import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError, type candidateApi } from '../../api/client';
import type { PublicJob, PublicJobDetail } from '../../api/types';
import { Alert, Button, Checkbox, Loading, TextField } from '../../components/ui';
import { jobMeta } from './JobsPage';

const errorText = (e: unknown) => (e instanceof ApiError ? e.message : 'Não foi possível enviar. Tente novamente.');

/**
 * Na página da vaga: quem já tem cadastro pede o link por e-mail e se
 * candidata sem preencher o formulário de novo.
 */
export function QuickApplyRequest({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setMsg((await api.post<{ message: string }>('/api/public/my-data/request', { email, vaga: slug })).message);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="question stack" style={{ gap: 8 }}>
      <strong>Já se cadastrou na Alpha Select antes?</strong>
      {!open ? (
        <>
          <span className="muted small">Candidate-se com o cadastro que você já tem, sem preencher tudo de novo.</span>
          <div><Button size="sm" onClick={() => setOpen(true)}>Usar meu cadastro</Button></div>
        </>
      ) : msg ? <Alert kind="success">{msg} Abra o link do e-mail para concluir a candidatura.</Alert> : (
        <form className="stack" onSubmit={submit} noValidate>
          {error && <Alert>{error}</Alert>}
          <TextField label="E-mail do cadastro" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required
            hint="Enviaremos um link para você se candidatar a esta vaga com seus dados já salvos." />
          <div><Button type="submit" variant="primary" loading={busy} disabled={!email.includes('@')}>Receber link</Button></div>
        </form>
      )}
    </div>
  );
}

type Capi = ReturnType<typeof candidateApi>;

/** Em "Meus dados": vagas abertas e candidatura com um clique (só as perguntas da vaga). */
export function OpenJobsCard({ capi, applied, highlight, onDone }: {
  capi: Capi; applied: string[]; highlight: string | null; onDone: (message: string) => Promise<void>;
}) {
  const q = useQuery({ queryKey: ['public-jobs'], queryFn: () => api.get<{ items: PublicJob[] }>('/api/public/jobs') });
  const [openSlug, setOpenSlug] = useState<string | null>(highlight && !applied.includes(highlight) ? highlight : null);
  const jobs = [...(q.data?.items ?? [])].sort((a, b) => Number(b.slug === highlight) - Number(a.slug === highlight));
  return (
    <section className="card" id="vagas-abertas">
      <div className="card-header"><h2>Candidatar-se a outras vagas</h2></div>
      <div className="card-body stack">
        <p className="muted small" style={{ margin: 0 }}>
          Sua candidatura usa o cadastro e o currículo desta página. Confira se estão atualizados antes de enviar.
        </p>
        {q.isLoading ? <Loading /> : q.isError ? <Alert>Não foi possível carregar as vagas.</Alert> : jobs.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>Nenhuma vaga aberta no momento.</p>
        ) : (
          <ul className="stack" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {jobs.map((j) => (
              <li key={j.slug} className="stack" style={{ gap: 8 }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <div>
                    <strong>{j.title}</strong>
                    <div className="muted small">{[j.companyName ?? 'Empresa confidencial', jobMeta(j)].filter(Boolean).join(' · ')}</div>
                  </div>
                  {applied.includes(j.slug) ? <span className="badge badge-success">Candidatura enviada</span>
                    : openSlug !== j.slug && <Button size="sm" variant="primary" onClick={() => setOpenSlug(j.slug)}>Candidatar-me</Button>}
                </div>
                {openSlug === j.slug && !applied.includes(j.slug) && (
                  <QuickApplyForm slug={j.slug} capi={capi} onCancel={() => setOpenSlug(null)}
                    onDone={async (m) => { setOpenSlug(null); await onDone(m); }} />
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function QuickApplyForm({ slug, capi, onCancel, onDone }: {
  slug: string; capi: Capi; onCancel: () => void; onDone: (message: string) => Promise<void>;
}) {
  const q = useQuery({ queryKey: ['public-job', slug], queryFn: () => api.get<PublicJobDetail>(`/api/public/jobs/${slug}`) });
  const [answers, setAnswers] = useState<Record<string, 'sim' | 'nao'>>({});
  const [accept, setAccept] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <Alert>Vaga não encontrada ou encerrada.</Alert>;
  const questions = q.data.questions;
  const ready = accept && questions.every((x) => answers[x.id]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await capi.post<{ message: string }>('/api/public/my-data/apply', {
        vaga: slug, acceptPrivacy: true, answers: questions.map((x) => ({ id: x.id, answer: answers[x.id] })),
      });
      await onDone(r.message);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="question stack" onSubmit={submit} noValidate aria-label={`Candidatura para ${q.data.title}`}>
      {error && <Alert>{error}</Alert>}
      {questions.map((x) => (
        <fieldset key={x.id} className="question">
          <legend>{x.text} <span aria-hidden>*</span></legend>
          <div className="row">
            {(['sim', 'nao'] as const).map((v) => (
              <label key={v} className="checkbox">
                <input type="radio" name={`qa-${slug}-${x.id}`} value={v} checked={answers[x.id] === v}
                  onChange={() => setAnswers((a) => ({ ...a, [x.id]: v }))} required />
                <span>{v === 'sim' ? 'Sim' : 'Não'}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ))}
      <Checkbox checked={accept} onChange={(e) => setAccept(e.target.checked)}
        label="Li o aviso de privacidade e autorizo o tratamento dos meus dados para processos seletivos da Alpha Select." />
      <div className="row">
        <Button type="submit" variant="primary" loading={busy} disabled={!ready}>Enviar candidatura</Button>
        <Button onClick={onCancel}>Cancelar</Button>
      </div>
    </form>
  );
}
