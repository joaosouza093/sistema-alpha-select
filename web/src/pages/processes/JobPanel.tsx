import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { JobConfig, Process, Publication, ScreeningQuestion } from '../../api/types';
import { Alert, Button, Checkbox, ErrorState, Loading, SelectField, TextArea, TextField, fieldErrors, useToast } from '../../components/ui';
import {
  employmentTypeLabel, fmtDateTime, fmtSalaryRange, parseMoneyToCents, publicationLabel, workModelLabel,
} from '../../lib/format';

const pubBadge: Record<Publication, string> = { rascunho: '', publicada: 'badge-success', pausada: 'badge-warning', encerrada: '' };

export function PublicationBadge({ publication }: { publication?: Publication }) {
  if (!publication || publication === 'rascunho') return null;
  return <span className={`badge ${pubBadge[publication]}`}>Portal: {publicationLabel[publication].toLowerCase()}</span>;
}

const centsToInput = (c: number | null) => (c == null ? '' : (c / 100).toFixed(2).replace('.', ','));

/** Configuração da vaga e publicação no portal (equipe vê; administrador altera). */
export function JobPanel({ process }: { process: Process }) {
  const job = useQuery({ queryKey: ['job', process.id], queryFn: () => api.get<JobConfig>(`/api/processes/${process.id}/job`) });
  if (job.isLoading) return <Loading />;
  if (job.isError) return <ErrorState error={job.error} onRetry={() => job.refetch()} />;
  return (
    <div className="stack">
      <TriageConfig key={`t-${job.data!.version}`} process={process} version={job.data!.version} />
      <JobForm key={job.data!.version} process={process} job={job.data!} />
    </div>
  );
}

/** Critérios da ficha de avaliação e prazo (SLA) por etapa. */
function TriageConfig({ process, version }: { process: Process; version: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  const canManage = process.permissions.canManage;
  const [sla, setSla] = useState(String(process.slaDays ?? 3));
  const [criteria, setCriteria] = useState<string[]>(process.evaluationCriteria ?? []);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.put(`/api/processes/${process.id}/triage-config`, {
        expectedVersion: version,
        slaDays: Number(sla),
        evaluationCriteria: criteria.map((c) => c.trim()).filter(Boolean),
      });
      toast.success('Triagem configurada.');
      await Promise.all([qc.invalidateQueries({ queryKey: ['job', process.id] }), qc.invalidateQueries({ queryKey: ['board', process.id] })]);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card">
      <div className="card-header">
        <div>
          <h2>Triagem</h2>
          <p className="muted small" style={{ margin: 0 }}>Critérios da ficha de avaliação (nota de 1 a 5) e prazo máximo em cada etapa.</p>
        </div>
      </div>
      <div className="card-body stack">
        <TextField label="Prazo por etapa (dias)" type="number" min={1} max={60} value={sla} onChange={(e) => setSla(e.target.value)} disabled={!canManage}
          hint="Passado o prazo sem decisão, o cartão mostra “Prazo vencido”." />
        {criteria.map((c, i) => (
          <div key={i} className="row">
            <div style={{ flex: 1 }}>
              <TextField label={`Critério ${i + 1}`} value={c} maxLength={80} disabled={!canManage}
                onChange={(e) => setCriteria((xs) => xs.map((x, j) => (j === i ? e.target.value : x)))} />
            </div>
            {canManage && <Button size="sm" variant="ghost" onClick={() => setCriteria((xs) => xs.filter((_, j) => j !== i))}>Remover</Button>}
          </div>
        ))}
        {canManage && (
          <div className="row">
            {criteria.length < 10 && <Button size="sm" onClick={() => setCriteria((xs) => [...xs, ''])}>Adicionar critério</Button>}
            <Button variant="primary" loading={busy} onClick={save} disabled={!sla || Number(sla) < 1}>Salvar triagem</Button>
          </div>
        )}
      </div>
    </section>
  );
}

function JobForm({ process, job }: { process: Process; job: JobConfig }) {
  const qc = useQueryClient();
  const toast = useToast();
  const canManage = process.permissions.canManage;
  const [f, setF] = useState({
    jobLocation: job.jobLocation ?? '',
    workModel: job.workModel ?? '',
    employmentType: job.employmentType ?? '',
    requirements: job.requirements ?? '',
    benefits: job.benefits ?? '',
    salaryMin: centsToInput(job.salaryMinCents),
    salaryMax: centsToInput(job.salaryMaxCents),
    showCompany: job.showCompany,
  });
  const [questions, setQuestions] = useState<ScreeningQuestion[]>(job.screeningQuestions);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const minC = f.salaryMin ? parseMoneyToCents(f.salaryMin) : null;
  const maxC = f.salaryMax ? parseMoneyToCents(f.salaryMax) : null;
  const link = job.publicSlug ? `${window.location.origin}/vagas/${job.publicSlug}` : null;

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['job', process.id] }),
      qc.invalidateQueries({ queryKey: ['board', process.id] }),
      qc.invalidateQueries({ queryKey: ['processes'] }),
    ]);

  const save = async () => {
    setBusy(true);
    setErrors({});
    try {
      await api.put(`/api/processes/${process.id}/job`, {
        expectedVersion: job.version,
        jobLocation: f.jobLocation || null,
        workModel: f.workModel || null,
        employmentType: f.employmentType || null,
        requirements: f.requirements || null,
        benefits: f.benefits || null,
        salaryMinCents: minC,
        salaryMaxCents: maxC,
        showCompany: f.showCompany,
        screeningQuestions: questions.filter((q) => q.text.trim()),
      });
      toast.success('Vaga salva.');
      await refresh();
    } catch (e) {
      setErrors(fieldErrors(e));
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const publish = async (publication: Publication) => {
    setBusy(true);
    try {
      await api.post(`/api/processes/${process.id}/publication`, { expectedVersion: job.version, publication });
      toast.success(publication === 'publicada' ? 'Vaga publicada no portal.' : `Vaga ${publicationLabel[publication].toLowerCase()}.`);
      await refresh();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link!);
      toast.success('Link copiado.');
    } catch {
      toast.error('Não foi possível copiar. Selecione o link e copie.');
    }
  };

  const updateQ = (i: number, patch: Partial<ScreeningQuestion>) =>
    setQuestions((qs) => qs.map((q, j) => (j === i ? { ...q, ...patch } : q)));

  const ro = !canManage;
  return (
    <div className="stack">
      <section className="card">
        <div className="card-header">
          <div>
            <h2>Publicação no portal de vagas</h2>
            <p className="muted small" style={{ margin: 0 }}>
              Situação: <strong>{publicationLabel[job.publication]}</strong>
              {job.publishedAt && <> · publicada em {fmtDateTime(job.publishedAt)}</>}
            </p>
          </div>
          {canManage && (
            <div className="row">
              {job.publication !== 'publicada' && (
                <Button variant="primary" loading={busy} disabled={process.status !== 'em_andamento'} onClick={() => publish('publicada')}>
                  {job.publication === 'rascunho' ? 'Publicar vaga' : 'Publicar novamente'}
                </Button>
              )}
              {job.publication === 'publicada' && <Button loading={busy} onClick={() => publish('pausada')}>Pausar</Button>}
              {job.publication !== 'rascunho' && job.publication !== 'encerrada' && (
                <Button variant="danger" loading={busy} onClick={() => publish('encerrada')}>Encerrar</Button>
              )}
            </div>
          )}
        </div>
        <div className="card-body stack">
          {link && job.publication === 'publicada' && (
            <div className="row">
              <a href={link} target="_blank" rel="noopener noreferrer">{link}</a>
              <Button size="sm" onClick={copy}>Copiar link</Button>
            </div>
          )}
          {process.status !== 'em_andamento' && <Alert kind="info">Processos concluídos ou arquivados não aparecem no portal.</Alert>}
          <p className="muted small" style={{ margin: 0 }}>
            O portal mostra título, descrição (aba “Dados do processo”), local, modelo, contrato, requisitos, benefícios e faixa salarial.
            Candidaturas entram na primeira etapa do quadro com a origem “Portal”.
          </p>
        </div>
      </section>

      <section className="card">
        <div className="card-header"><h2>Dados da vaga</h2></div>
        <div className="card-body stack">
          <div className="grid grid-3">
            <TextField label="Local" value={f.jobLocation} onChange={set('jobLocation')} maxLength={120} placeholder="São Paulo/SP" disabled={ro} error={errors.jobLocation} />
            <SelectField label="Modelo" value={f.workModel} onChange={set('workModel')} disabled={ro}>
              <option value="">Não informar</option>
              {Object.entries(workModelLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </SelectField>
            <SelectField label="Contratação" value={f.employmentType} onChange={set('employmentType')} disabled={ro}>
              <option value="">Não informar</option>
              {Object.entries(employmentTypeLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </SelectField>
          </div>
          <TextArea label="Requisitos" value={f.requirements} onChange={set('requirements')} maxLength={5000} rows={4} disabled={ro} error={errors.requirements} />
          <TextArea label="Benefícios" value={f.benefits} onChange={set('benefits')} maxLength={3000} rows={3} disabled={ro} error={errors.benefits} />
          <div className="grid grid-2">
            <TextField label="Salário mínimo (R$)" value={f.salaryMin} onChange={set('salaryMin')} inputMode="decimal" disabled={ro}
              error={f.salaryMin && minC === null ? 'Valor inválido.' : errors.salaryMinCents} hint="Opcional. Deixe vazio para não mostrar." />
            <TextField label="Salário máximo (R$)" value={f.salaryMax} onChange={set('salaryMax')} inputMode="decimal" disabled={ro}
              error={f.salaryMax && maxC === null ? 'Valor inválido.' : errors.salaryMaxCents}
              hint={fmtSalaryRange(minC, maxC) ? `No portal: ${fmtSalaryRange(minC, maxC)}` : undefined} />
          </div>
          <Checkbox label={`Mostrar o nome da empresa (${process.companyName}) no portal`} checked={f.showCompany} disabled={ro}
            onChange={(e) => setF((x) => ({ ...x, showCompany: e.target.checked }))} hint="Desmarcado: a vaga aparece como “Empresa confidencial”." />
        </div>
      </section>

      <section className="card">
        <div className="card-header">
          <div>
            <h2>Perguntas da candidatura</h2>
            <p className="muted small" style={{ margin: 0 }}>Respostas “sim” ou “não”. As eliminatórias marcam o candidato no quadro; a decisão continua sendo da equipe.</p>
          </div>
          {canManage && questions.length < 10 && (
            <Button size="sm" onClick={() => setQuestions((q) => [...q, { text: '', eliminatory: false, expected: 'sim' }])}>Adicionar pergunta</Button>
          )}
        </div>
        <div className="card-body stack">
          {questions.length === 0 && <p className="muted" style={{ margin: 0 }}>Nenhuma pergunta.</p>}
          {questions.map((q, i) => (
            <div key={q.id ?? `novo-${i}`} className="stack" style={{ gap: 8, borderBottom: '1px solid var(--border)', paddingBottom: 12 }}>
              <TextField label={`Pergunta ${i + 1}`} value={q.text} maxLength={300} disabled={ro} onChange={(e) => updateQ(i, { text: e.target.value })} />
              <div className="row">
                <Checkbox label="Eliminatória" checked={q.eliminatory} disabled={ro} onChange={(e) => updateQ(i, { eliminatory: e.target.checked })} />
                {q.eliminatory && (
                  <SelectField label="Resposta exigida" value={q.expected} disabled={ro} onChange={(e) => updateQ(i, { expected: e.target.value as 'sim' | 'nao' })}>
                    <option value="sim">Sim</option>
                    <option value="nao">Não</option>
                  </SelectField>
                )}
                {canManage && <Button size="sm" variant="ghost" onClick={() => setQuestions((qs) => qs.filter((_, j) => j !== i))}>Remover</Button>}
              </div>
            </div>
          ))}
        </div>
      </section>

      {canManage && (
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button variant="primary" onClick={save} loading={busy} disabled={(!!f.salaryMin && minC === null) || (!!f.salaryMax && maxC === null)}>
            Salvar vaga
          </Button>
        </div>
      )}
    </div>
  );
}
