import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import type { Application, Evaluation, Intake, Reason, TriageStatus, Comment, Decision, DocumentRow, HistoryItem, Stage, Visibility } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import {
  Alert, Button, Checkbox, ConfirmDialog, DecisionBadge, Empty, ErrorState, Loading, PageHeader, SelectField,
  StatusBadge, Tabs, TextArea, usePageTitle, useToast,
} from '../../components/ui';
import { MoveDialog } from '../../components/MoveDialog';
import { DocumentPreview } from '../../components/DocumentPreview';
import { daysSince, decisionLabel, docKindLabel, fmtDateTime, fmtMoney, fmtPhone, fmtScore, fmtSize, reasonLabel, triageLabel } from '../../lib/format';
import { SendLeadsModal } from '../../components/SendLeadsModal';

type Tab = 'candidato' | 'triagem' | 'etapa' | 'documentos' | 'comentarios' | 'historico';

export function ApplicationPage() {
  usePageTitle('Participação');
  const { id } = useParams<{ id: string }>();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('aba') as Tab) || 'candidato';
  const q = useQuery({ queryKey: ['application', id], queryFn: () => api.get<Application>(`/api/applications/${id}`) });
  const { isAlpha } = useAuth();
  const stages = useQuery({ queryKey: ['stages'], queryFn: () => api.get<{ items: Stage[] }>('/api/stages'), staleTime: Infinity });

  if (q.isLoading || stages.isLoading) return <Loading />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const a = q.data!;
  const tabs: { id: Tab; label: string }[] = [
    { id: 'candidato', label: 'Candidato' },
    ...(isAlpha ? [{ id: 'triagem' as Tab, label: 'Triagem' }] : []),
    { id: 'etapa', label: 'Etapa e decisão' },
    { id: 'documentos', label: 'Documentos' },
    { id: 'comentarios', label: 'Comentários' },
    { id: 'historico', label: 'Histórico' },
  ];

  return (
    <>
      <PageHeader
        breadcrumb={<><Link to="/processos">Processos</Link> / <Link to={`/processos/${a.process.id}`}>{a.process.title}</Link></>}
        title={a.candidateName}
        subtitle={
          <span className="row">
            <span>{a.process.companyName}</span>
            <span className="badge badge-brand">Etapa: {a.stageName}</span>
            <DecisionBadge decision={a.decision} />
            {isAlpha && !a.sentAt && <span className="badge">Ainda não enviado ao cliente</span>}
            <StatusBadge status={a.process.status} />
          </span>
        }
        actions={a.candidateId && <Link className="btn" to={`/candidatos/${a.candidateId}`}>Cadastro completo</Link>}
      />
      <Tabs label="Seções da participação" tabs={tabs} value={tab} onChange={(t) => setParams({ aba: t }, { replace: true })} />
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'candidato' && <CandidateTab a={a} />}
        {tab === 'triagem' && isAlpha && <TriageTab a={a} />}
        {tab === 'etapa' && <StageTab a={a} stages={stages.data!.items} />}
        {tab === 'documentos' && <DocumentsTab a={a} />}
        {tab === 'comentarios' && <CommentsTab a={a} />}
        {tab === 'historico' && <HistoryTab a={a} stages={stages.data!.items} />}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ candidato

function CandidateTab({ a }: { a: Application }) {
  const { isAlpha } = useAuth();
  return (
    <div className="grid grid-2">
      <section className="card">
        <div className="card-header"><h2>Dados {isAlpha ? 'do candidato' : 'compartilhados'}</h2></div>
        <div className="card-body">
          <dl className="dl">
            <dt>Nome</dt><dd>{a.candidateName}</dd>
            <dt>E-mail</dt><dd>{a.candidateEmail ?? <span className="muted">não compartilhado</span>}</dd>
            <dt>Telefone</dt><dd>{a.candidatePhone ? fmtPhone(a.candidatePhone) : <span className="muted">não compartilhado</span>}</dd>
            <dt>Pretensão salarial</dt><dd>{a.candidateSalary !== null ? fmtMoney(a.candidateSalary) : <span className="muted">não compartilhada</span>}</dd>
          </dl>
          {a.sharedSummary && (
            <>
              <h3 style={{ marginTop: 16 }}>Resumo da Alpha Select</h3>
              <p className="pre-wrap">{a.sharedSummary}</p>
            </>
          )}
        </div>
      </section>
      <section className="card">
        <div className="card-header"><h2>Processo</h2></div>
        <div className="card-body">
          <dl className="dl">
            <dt>Processo</dt><dd><Link to={`/processos/${a.process.id}`}>{a.process.title}</Link></dd>
            <dt>Empresa</dt><dd>{a.process.companyName}</dd>
            <dt>Etapa atual</dt><dd>{a.stageName} ({daysSince(a.stageChangedAt)})</dd>
            <dt>Responsável</dt><dd>{a.ownerName ?? '—'}</dd>
            <dt>Decisão</dt><dd><DecisionBadge decision={a.decision} /></dd>
            <dt>Incluído em</dt><dd>{fmtDateTime(a.createdAt)}{a.source === 'portal' && <> · <span className="badge badge-brand">pelo portal de vagas</span></>}</dd>
          </dl>
        </div>
      </section>
      {isAlpha && a.source === 'portal' && <IntakeCard a={a} />}
      {isAlpha && <SharingCard a={a} />}
    </div>
  );
}

/** Ficha de avaliação da triagem e envio ao cliente (somente equipe Alpha). */
function TriageTab({ a }: { a: Application }) {
  const q = useQuery({
    queryKey: ['evaluation', a.id],
    queryFn: () => api.get<{ criteria: string[]; evaluation: Evaluation | null }>(`/api/applications/${a.id}/evaluation`),
  });
  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  return <TriageForm key={q.data!.evaluation?.version ?? 0} a={a} criteria={q.data!.criteria} ev={q.data!.evaluation} />;
}

function TriageForm({ a, criteria, ev }: { a: Application; criteria: string[]; ev: Evaluation | null }) {
  const qc = useQueryClient();
  const toast = useToast();
  const names = Array.from(new Set([...criteria, ...(ev?.ratings.map((r) => r.criterion) ?? [])]));
  const [status, setStatus] = useState<TriageStatus>(ev?.triageStatus ?? 'em_triagem');
  const [ratings, setRatings] = useState<Record<string, number>>(Object.fromEntries((ev?.ratings ?? []).map((r) => [r.criterion, r.score])));
  const [reason, setReason] = useState<Reason | ''>(ev?.reason ?? '');
  const [notes, setNotes] = useState(ev?.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const open = a.process.status === 'em_andamento';
  const values = Object.values(ratings);
  const avg = values.length ? values.reduce((x, y) => x + y, 0) / values.length : null;

  const save = async () => {
    setBusy(true);
    try {
      await api.put(`/api/applications/${a.id}/evaluation`, {
        expectedVersion: ev?.version ?? null,
        triageStatus: status,
        ratings: Object.entries(ratings).map(([criterion, score]) => ({ criterion, score })),
        reason: status === 'reprovado_interno' ? reason || null : null,
        notes: notes || null,
      });
      toast.success('Avaliação salva.');
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
      await qc.invalidateQueries({ queryKey: ['evaluation', a.id] });
      await qc.invalidateQueries({ queryKey: ['board', a.process.id] });
    }
  };

  return (
    <div className="grid grid-2">
      <section className="card">
        <div className="card-header"><h2>Ficha de avaliação</h2>{avg !== null && <span className="badge badge-brand">Nota {fmtScore(avg)}</span>}</div>
        <div className="card-body stack">
          {names.length === 0 ? (
            <p className="muted small" style={{ margin: 0 }}>Sem critérios definidos. O administrador define os critérios na aba “Vaga e triagem” do processo.</p>
          ) : names.map((n) => (
            <div key={n} className="row" style={{ justifyContent: 'space-between' }}>
              <span>{n}</span>
              <span className="row" role="radiogroup" aria-label={`Nota para ${n}`} style={{ gap: 4 }}>
                {[1, 2, 3, 4, 5].map((v) => (
                  <Button key={v} size="sm" variant={ratings[n] === v ? 'primary' : 'default'} role="radio" aria-checked={ratings[n] === v}
                    disabled={!open} onClick={() => setRatings((r) => ({ ...r, [n]: v }))}>{v}</Button>
                ))}
              </span>
            </div>
          ))}
          <TextArea label="Observações internas" value={notes} onChange={(e) => setNotes(e.target.value)} rows={4} maxLength={5000} disabled={!open}
            hint="Não são enviadas ao cliente." />
        </div>
      </section>
      <section className="card">
        <div className="card-header"><h2>Resultado da triagem</h2></div>
        <div className="card-body stack">
          {a.sentAt ? (
            <Alert kind="success">Enviado ao cliente em {fmtDateTime(a.sentAt)}.</Alert>
          ) : (
            <>
              <SelectField label="Situação" value={status} onChange={(e) => setStatus(e.target.value as TriageStatus)} disabled={!open}>
                {Object.entries(triageLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </SelectField>
              {status === 'reprovado_interno' && (
                <SelectField label="Motivo" value={reason} onChange={(e) => setReason(e.target.value as Reason)} required>
                  <option value="">Escolha o motivo</option>
                  {Object.entries(reasonLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </SelectField>
              )}
            </>
          )}
          {open && (
            <div className="row">
              <Button variant="primary" loading={busy} onClick={save} disabled={status === 'reprovado_interno' && !reason}>Salvar avaliação</Button>
              {!a.sentAt && ev?.triageStatus === 'aprovado_interno' && a.permissions.canMoveStage && a.decision === 'pendente' && (
                <Button onClick={() => setSending(true)}>Enviar ao cliente</Button>
              )}
            </div>
          )}
          {ev && <p className="muted small" style={{ margin: 0 }}>Última avaliação por {ev.evaluatedByName ?? '—'} em {fmtDateTime(ev.updatedAt)}.</p>}
        </div>
      </section>
      {sending && (
        <SendLeadsModal processId={a.process.id} candidates={[{ applicationId: a.id, name: a.candidateName, summary: a.sharedSummary }]}
          onClose={() => setSending(false)} onDone={() => setSending(false)} />
      )}
    </div>
  );
}

/** Respostas da candidatura pelo portal (somente equipe Alpha). */
function IntakeCard({ a }: { a: Application }) {
  const q = useQuery({ queryKey: ['intake', a.id], queryFn: () => api.get<Intake>(`/api/applications/${a.id}/intake`) });
  return (
    <section className="card">
      <div className="card-header"><h2>Respostas da candidatura</h2>
        {q.data?.screeningFailed && <span className="badge badge-warning">Não atende requisito eliminatório</span>}</div>
      <div className="card-body">
        {q.isLoading ? <Loading /> : q.isError ? <ErrorState error={q.error} /> : q.data!.answers.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>A vaga não tinha perguntas.</p>
        ) : (
          <dl className="dl">
            {q.data!.answers.map((x) => (
              <div key={x.id} style={{ display: 'contents' }}>
                <dt>{x.text}</dt>
                <dd>
                  {x.answer === 'sim' ? 'Sim' : 'Não'}
                  {x.eliminatory && x.answer !== x.expected && <> <span className="badge badge-warning">esperado: {x.expected === 'sim' ? 'Sim' : 'Não'}</span></>}
                </dd>
              </div>
            ))}
          </dl>
        )}
        <p className="muted small" style={{ marginBottom: 0 }}>A decisão continua sendo da equipe; as respostas não reprovam ninguém automaticamente.</p>
      </div>
    </section>
  );
}

function SharingCard({ a }: { a: Application }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [shareEmail, setE] = useState(!!a.shareEmail);
  const [sharePhone, setP] = useState(!!a.sharePhone);
  const [shareSalary, setS] = useState(!!a.shareSalary);
  const [summary, setSummary] = useState(a.sharedSummary ?? '');
  const [busy, setBusy] = useState(false);
  const locked = a.process.status !== 'em_andamento';
  const save = async () => {
    setBusy(true);
    try {
      await api.patch(`/api/applications/${a.id}/sharing`, { expectedVersion: a.version, shareEmail, sharePhone, shareSalary, sharedSummary: summary || null });
      toast.success('Compartilhamento atualizado.');
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
      await qc.invalidateQueries({ queryKey: ['application', a.id] });
    }
  };
  return (
    <section className="card" style={{ gridColumn: '1 / -1' }}>
      <div className="card-header">
        <div>
          <h2>O que o cliente vê nesta participação</h2>
          <p className="muted small" style={{ margin: 0 }}>Nome sempre visível. Observações internas do cadastro nunca são compartilhadas.</p>
        </div>
        <span className="badge badge-internal">Visível só para a Alpha Select</span>
      </div>
      <div className="card-body stack">
        <div className="row" style={{ gap: 24 }}>
          <Checkbox label="E-mail" checked={shareEmail} onChange={(e) => setE(e.target.checked)} disabled={locked} />
          <Checkbox label="Telefone" checked={sharePhone} onChange={(e) => setP(e.target.checked)} disabled={locked} />
          <Checkbox label="Pretensão salarial" checked={shareSalary} onChange={(e) => setS(e.target.checked)} disabled={locked} />
        </div>
        <TextArea label="Resumo compartilhado com o cliente" value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={5000} disabled={locked}
          hint="Texto visível aos usuários autorizados do processo." />
        <div className="form-actions"><Button variant="primary" onClick={save} loading={busy} disabled={locked}>Salvar compartilhamento</Button></div>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ etapa e decisão

function StageTab({ a, stages }: { a: Application; stages: Stage[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [moving, setMoving] = useState(false);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [reason, setReason] = useState<Reason | ''>('');
  const needsReason = decision === 'reprovado' || decision === 'desistiu';
  const [busy, setBusy] = useState(false);
  const open = a.process.status === 'em_andamento';
  const perms = a.permissions;
  const isApprovalStage = stages.find((s) => s.id === a.stageId)?.key === 'aprovacao';

  const saveDecision = async () => {
    if (!decision) return;
    setBusy(true);
    try {
      await api.post(`/api/applications/${a.id}/decision`, { decision, expectedVersion: a.version, ...(needsReason ? { reason } : {}) });
      toast.success('Decisão registrada no histórico.');
      setDecision(null);
      setReason('');
    } catch (e) {
      toast.error(e);
      if (e instanceof ApiError && e.status === 409) setDecision(null);
    } finally {
      setBusy(false);
      await qc.invalidateQueries({ queryKey: ['application', a.id] });
    }
  };

  const options: Decision[] = (['pendente', 'aprovado', 'reprovado', 'desistiu'] as Decision[]).filter(
    (d) => d !== a.decision && (d !== 'aprovado' || isApprovalStage),
  );

  return (
    <div className="grid grid-2">
      <section className="card">
        <div className="card-header"><h2>Etapa atual</h2></div>
        <div className="card-body stack">
          <ol className="row" style={{ listStyle: 'none', padding: 0, margin: 0, gap: 6 }} aria-label="Etapas do fluxo">
            {stages.map((s) => (
              <li key={s.id} className={`badge ${s.id === a.stageId ? 'badge-brand' : ''}`} aria-current={s.id === a.stageId ? 'step' : undefined}>
                {s.position}. {s.name}
              </li>
            ))}
          </ol>
          <dl className="dl">
            <dt>Responsável</dt><dd>{a.ownerName ?? '—'}</dd>
            <dt>Na etapa desde</dt><dd>{fmtDateTime(a.stageChangedAt)}</dd>
          </dl>
          {!open ? <Alert kind="info">Processo encerrado: somente consulta.</Alert> : perms.canMoveStage ? (
            a.decision === 'pendente' ? (
              <div><Button variant="primary" onClick={() => setMoving(true)}>Mover etapa / trocar responsável</Button></div>
            ) : <Alert kind="info">Há decisão registrada. Para mover de etapa, reabra a decisão como “Em avaliação”.</Alert>
          ) : <p className="muted small">Você não tem permissão para mover etapas neste processo.</p>}
        </div>
      </section>
      <section className="card">
        <div className="card-header"><h2>Decisão sobre o candidato</h2></div>
        <div className="card-body stack">
          <div><DecisionBadge decision={a.decision} />{a.decisionReason && <span className="muted small"> · Motivo: {reasonLabel[a.decisionReason]}</span>}</div>
          <p className="muted small">A etapa indica onde o candidato está no fluxo. A decisão é registrada separadamente; “Aprovado” só pode ser registrado na etapa Aprovação.</p>
          {open && perms.canDecide ? (
            <div className="row">
              {options.map((d) => (
                <Button key={d} variant={d === 'aprovado' ? 'primary' : d === 'reprovado' ? 'danger' : 'default'} onClick={() => setDecision(d)}>
                  {d === 'pendente' ? 'Reabrir (em avaliação)' : `Registrar: ${decisionLabel[d]}`}
                </Button>
              ))}
            </div>
          ) : open ? <p className="muted small">Você não tem permissão para registrar decisões neste processo.</p> : null}
        </div>
      </section>
      {moving && (
        <MoveDialog applicationId={a.id} candidateName={a.candidateName} currentStageId={a.stageId} currentOwnerId={a.ownerId}
          version={a.version} stages={stages} onClose={() => setMoving(false)} onDone={() => setMoving(false)} />
      )}
      {decision && (
        <ConfirmDialog title="Registrar decisão"
          message={<div className="stack">
            <span>Confirmar a decisão <strong>{decisionLabel[decision]}</strong> para {a.candidateName}? A alteração fica registrada no histórico com seu nome e horário.</span>
            {needsReason && (
              <SelectField label="Motivo" value={reason} onChange={(e) => setReason(e.target.value as Reason)} required>
                <option value="">Escolha o motivo</option>
                {Object.entries(reasonLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </SelectField>
            )}
          </div>}
          confirmLabel="Registrar decisão" danger={decision === 'reprovado'} loading={busy}
          onConfirm={() => { if (!needsReason || reason) void saveDecision(); else toast.error('Escolha o motivo.'); }}
          onCancel={() => { setDecision(null); setReason(''); }} />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ documentos

function DocumentsTab({ a }: { a: Application }) {
  const { isAlpha } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const docs = useQuery({ queryKey: ['app-docs', a.id], queryFn: () => api.get<{ items: DocumentRow[] }>(`/api/applications/${a.id}/documents`) });
  const [preview, setPreview] = useState<DocumentRow | null>(null);
  const [unlink, setUnlink] = useState<DocumentRow | null>(null);

  const toggle = async (d: DocumentRow) => {
    try {
      await api.put(`/api/applications/${a.id}/documents/${d.id}`, { sharedWithClient: !d.sharedWithClient });
      toast.success(d.sharedWithClient ? 'Documento deixou de ser compartilhado (efeito imediato).' : 'Documento compartilhado com o cliente.');
      await qc.invalidateQueries({ queryKey: ['app-docs', a.id] });
    } catch (e) {
      toast.error(e);
    }
  };
  const doUnlink = async () => {
    if (!unlink) return;
    try {
      await api.delete(`/api/applications/${a.id}/documents/${unlink.id}`);
      toast.success('Documento desvinculado desta participação.');
      setUnlink(null);
      await qc.invalidateQueries({ queryKey: ['app-docs', a.id] });
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <section className="card">
      <div className="card-header">
        <div>
          <h2>Documentos desta participação</h2>
          {isAlpha && <p className="muted small" style={{ margin: 0 }}>Envie arquivos no cadastro do candidato e vincule-os aqui. Somente os marcados como compartilhados ficam visíveis ao cliente.</p>}
        </div>
        {isAlpha && a.candidateId && <Link className="btn" to={`/candidatos/${a.candidateId}?aba=documentos&participacao=${a.id}`}>Enviar ou vincular documentos</Link>}
      </div>
      {docs.isLoading ? <Loading /> : docs.isError ? <ErrorState error={docs.error} /> : docs.data!.items.length === 0 ? (
        <Empty title="Nenhum documento disponível" />
      ) : (
        <div className="table-wrap">
          <table className="table responsive">
            <thead><tr><th>Arquivo</th><th>Tipo</th><th>Tamanho</th><th>Enviado</th>{isAlpha && <th>Cliente vê?</th>}<th className="actions">Ações</th></tr></thead>
            <tbody>
              {docs.data!.items.map((d) => (
                <tr key={d.id}>
                  <td data-label="Arquivo">{d.name}</td>
                  <td data-label="Tipo">{docKindLabel[d.kind]}</td>
                  <td data-label="Tamanho">{fmtSize(d.size)}</td>
                  <td data-label="Enviado">{fmtDateTime(d.createdAt)}<span className="muted small" style={{ display: 'block' }}>{d.uploadedByName ?? ''}</span></td>
                  {isAlpha && <td data-label="Cliente vê?">{d.sharedWithClient ? <span className="badge badge-shared">Compartilhado</span> : <span className="badge badge-internal">Interno</span>}</td>}
                  <td className="actions">
                    <Button size="sm" onClick={() => setPreview(d)}>Visualizar</Button>{' '}
                    <a className="btn btn-sm" href={`/api/documents/${d.id}/content?download=1`}>Baixar</a>
                    {isAlpha && a.process.status === 'em_andamento' && (
                      <>
                        {' '}<Button size="sm" onClick={() => toggle(d)}>{d.sharedWithClient ? 'Parar de compartilhar' : 'Compartilhar'}</Button>
                        {' '}<Button size="sm" variant="ghost" onClick={() => setUnlink(d)}>Desvincular</Button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {preview && <DocumentPreview doc={preview} onClose={() => setPreview(null)} />}
      {unlink && <ConfirmDialog title="Desvincular documento" message={<>Desvincular <strong>{unlink.name}</strong> desta participação? O arquivo continua no cadastro do candidato.</>} confirmLabel="Desvincular" onConfirm={doUnlink} onCancel={() => setUnlink(null)} />}
    </section>
  );
}

// ------------------------------------------------------------------ comentários

function CommentsTab({ a }: { a: Application }) {
  const { user, isAlpha, isAdmin } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const comments = useQuery({ queryKey: ['comments', a.id], queryFn: () => api.get<{ items: Comment[] }>(`/api/applications/${a.id}/comments`) });
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState<Visibility>(isAlpha ? 'internal' : 'shared');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [removing, setRemoving] = useState<Comment | null>(null);
  const canComment = a.permissions.canComment;

  const post = async () => {
    setBusy(true);
    try {
      await api.post(`/api/applications/${a.id}/comments`, { body, visibility });
      setBody('');
      if (isAlpha) setVisibility('internal');
      toast.success(visibility === 'internal' ? 'Comentário interno publicado.' : 'Comentário compartilhado publicado.');
      await qc.invalidateQueries({ queryKey: ['comments', a.id] });
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const saveEdit = async () => {
    if (!editing) return;
    try {
      await api.patch(`/api/comments/${editing.id}`, { body: editing.body });
      setEditing(null);
      await qc.invalidateQueries({ queryKey: ['comments', a.id] });
    } catch (e) {
      toast.error(e);
    }
  };
  const doRemove = async () => {
    if (!removing) return;
    try {
      await api.delete(`/api/comments/${removing.id}`);
      setRemoving(null);
      await qc.invalidateQueries({ queryKey: ['comments', a.id] });
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <div className="stack">
      {canComment && (
        <section className="card">
          <div className="card-body stack">
            <TextArea label="Novo comentário" value={body} onChange={(e) => setBody(e.target.value)} maxLength={5000} />
            {isAlpha ? (
              <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
                <legend style={{ fontWeight: 600, marginBottom: 6 }}>Visibilidade</legend>
                <div className="radio-cards">
                  <label className="radio-card">
                    <input type="radio" name="vis" checked={visibility === 'internal'} onChange={() => setVisibility('internal')} />
                    <span><strong>Interno da Alpha Select</strong><span className="muted small" style={{ display: 'block' }}>Nunca é exibido ao cliente.</span></span>
                  </label>
                  <label className="radio-card">
                    <input type="radio" name="vis" checked={visibility === 'shared'} onChange={() => setVisibility('shared')} />
                    <span><strong>Compartilhado</strong><span className="muted small" style={{ display: 'block' }}>Visível a todos os usuários autorizados do processo.</span></span>
                  </label>
                </div>
              </fieldset>
            ) : (
              <p className="muted small">Seu comentário será visível à Alpha Select e aos usuários autorizados deste processo.</p>
            )}
            <div className="form-actions">
              <Button variant="primary" onClick={post} loading={busy} disabled={!body.trim()}>
                {visibility === 'internal' ? 'Publicar comentário interno' : 'Publicar comentário compartilhado'}
              </Button>
            </div>
          </div>
        </section>
      )}
      {comments.isLoading ? <Loading /> : comments.isError ? <ErrorState error={comments.error} /> : comments.data!.items.length === 0 ? (
        <div className="card"><Empty title="Nenhum comentário" /></div>
      ) : (
        <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {comments.data!.items.map((c) => (
            <li key={c.id} className={`comment ${c.visibility}`}>
              <div className="comment-head">
                <span><strong>{c.authorName ?? 'Usuário removido'}</strong> · <span className="muted">{fmtDateTime(c.createdAt)}{c.edited && ' (editado)'}</span></span>
                <span className={`badge ${c.visibility === 'internal' ? 'badge-internal' : 'badge-shared'}`}>{c.visibility === 'internal' ? 'Interno' : 'Compartilhado'}</span>
              </div>
              {editing?.id === c.id ? (
                <div className="stack">
                  <TextArea label="Editar comentário" value={editing.body} onChange={(e) => setEditing({ id: c.id, body: e.target.value })} maxLength={5000} />
                  <div className="form-actions"><Button onClick={() => setEditing(null)}>Cancelar</Button><Button variant="primary" onClick={saveEdit} disabled={!editing.body.trim()}>Salvar</Button></div>
                </div>
              ) : (
                // Texto renderizado como conteúdo textual: nenhum HTML inserido pelo usuário é interpretado.
                <p className="pre-wrap" style={{ margin: 0 }}>{c.body}</p>
              )}
              {(c.authorId === user?.id || isAdmin) && editing?.id !== c.id && (
                <div className="row" style={{ marginTop: 8 }}>
                  {c.authorId === user?.id && <Button size="sm" variant="ghost" onClick={() => setEditing({ id: c.id, body: c.body })}>Editar</Button>}
                  <Button size="sm" variant="ghost" onClick={() => setRemoving(c)}>Excluir</Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {removing && <ConfirmDialog title="Excluir comentário" message="Excluir este comentário? Esta ação não pode ser desfeita." confirmLabel="Excluir" danger onConfirm={doRemove} onCancel={() => setRemoving(null)} />}
    </div>
  );
}

// ------------------------------------------------------------------ histórico

function HistoryTab({ a, stages }: { a: Application; stages: Stage[] }) {
  const h = useQuery({ queryKey: ['history', a.id, a.version], queryFn: () => api.get<{ items: HistoryItem[] }>(`/api/applications/${a.id}/history`) });
  const stageName = (id: number | null) => stages.find((s) => s.id === id)?.name ?? '—';
  if (h.isLoading) return <Loading />;
  if (h.isError) return <ErrorState error={h.error} />;
  return (
    <section className="card">
      <div className="card-header"><h2>Histórico de movimentações</h2></div>
      <div className="card-body">
        <ul className="timeline">
          {h.data!.items.map((x) => (
            <li key={x.id}>
              <div className="muted small">{fmtDateTime(x.createdAt)} · por {x.actorName ?? 'sistema'}</div>
              {x.event === 'created' ? (
                <div>Incluído no processo na etapa <strong>{stageName(x.toStageId)}</strong>{x.toOwnerName && <> com responsável <strong>{x.toOwnerName}</strong></>}.</div>
              ) : (
                <div className="stack" style={{ gap: 2 }}>
                  {x.fromStageId !== x.toStageId && <div>Etapa: {stageName(x.fromStageId)} → <strong>{stageName(x.toStageId)}</strong></div>}
                  {x.fromOwnerId !== x.toOwnerId && <div>Responsável: {x.fromOwnerName ?? '—'} → <strong>{x.toOwnerName ?? '—'}</strong></div>}
                  {x.fromDecision !== x.toDecision && x.toDecision && <div>Decisão: {x.fromDecision ? decisionLabel[x.fromDecision] : '—'} → <strong>{decisionLabel[x.toDecision]}</strong></div>}
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
