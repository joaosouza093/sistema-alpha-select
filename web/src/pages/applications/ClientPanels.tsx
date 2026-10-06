import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { Application, Interview, Reason, Stage } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { Alert, Button, Checkbox, ErrorState, Loading, SelectField, TextArea, TextField, useToast } from '../../components/ui';
import { fmtDateTime, interviewModeLabel, interviewStatusLabel, reasonLabel } from '../../lib/format';

/**
 * Retorno do cliente em um só lugar: avançar, aprovar, recusar (com motivo)
 * ou manter em análise, com comentário compartilhado com a Alpha Select.
 */
export function FeedbackCard({ a, stages }: { a: Application; stages: Stage[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [comment, setComment] = useState('');
  const [reason, setReason] = useState<Reason | ''>('');
  const [refusing, setRefusing] = useState(false);
  const [busy, setBusy] = useState(false);
  const p = a.permissions;
  const open = a.process.status === 'em_andamento' && a.decision === 'pendente';
  const idx = stages.findIndex((s) => s.id === a.stageId);
  const next = stages[idx + 1];
  const atApproval = stages[idx]?.key === 'aprovacao';
  if (!open || !(p.canMoveStage || p.canDecide || p.canComment)) return null;

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      if (comment.trim() && p.canComment) {
        await api.post(`/api/applications/${a.id}/comments`, { body: comment.trim(), visibility: 'shared' });
      }
      toast.success(ok);
      setComment('');
      setRefusing(false);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
      await qc.invalidateQueries({ queryKey: ['application', a.id] });
      await qc.invalidateQueries({ queryKey: ['comments', a.id] });
    }
  };

  return (
    <section className="card">
      <div className="card-header"><h2>Seu retorno</h2></div>
      <div className="card-body stack">
        {p.canComment && (
          <TextArea label="Comentário para a Alpha Select" value={comment} onChange={(e) => setComment(e.target.value)} rows={3} maxLength={5000}
            hint="Opcional ao avançar ou recusar. Fica no histórico de comentários." />
        )}
        {refusing ? (
          <div className="stack">
            <SelectField label="Motivo" value={reason} onChange={(e) => setReason(e.target.value as Reason)} required>
              <option value="">Escolha o motivo</option>
              {Object.entries(reasonLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </SelectField>
            <div className="row">
              <Button variant="danger" loading={busy} disabled={!reason}
                onClick={() => run(() => api.post(`/api/applications/${a.id}/decision`, { decision: 'reprovado', reason, expectedVersion: a.version }), 'Retorno registrado: não aprovado.')}>
                Confirmar recusa
              </Button>
              <Button onClick={() => setRefusing(false)}>Voltar</Button>
            </div>
          </div>
        ) : (
          <div className="row">
            {p.canMoveStage && next && (
              <Button variant="primary" loading={busy}
                onClick={() => run(() => api.post(`/api/applications/${a.id}/move`, { toStageId: next.id, expectedVersion: a.version }), `Candidato avançou para ${next.name}.`)}>
                Avançar para {next.name}
              </Button>
            )}
            {p.canDecide && atApproval && (
              <Button variant="primary" loading={busy}
                onClick={() => run(() => api.post(`/api/applications/${a.id}/decision`, { decision: 'aprovado', expectedVersion: a.version }), 'Candidato aprovado.')}>
                Aprovar
              </Button>
            )}
            {p.canDecide && <Button variant="danger" onClick={() => setRefusing(true)}>Recusar</Button>}
            {p.canComment && (
              <Button loading={busy} disabled={!comment.trim()}
                onClick={() => run(async () => undefined, 'Comentário enviado. O candidato segue em análise.')}>
                Manter em análise
              </Button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

/** Entrevistas e próximos passos da participação. */
export function InterviewsCard({ a }: { a: Application }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { isAlpha } = useAuth();
  const q = useQuery({
    queryKey: ['interviews', a.id],
    queryFn: () => api.get<{ items: Interview[]; canSchedule: boolean }>(`/api/applications/${a.id}/interviews`),
  });
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ when: toLocalInput(new Date(Date.now() + 86_400_000)), mode: 'online', location: '', notes: '', notify: true });
  const [busy, setBusy] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['interviews', a.id] });

  const save = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ candidateNotified: string | null }>(`/api/applications/${a.id}/interviews`, {
        scheduledAt: new Date(f.when).toISOString(),
        mode: f.mode,
        location: f.location || null,
        notes: f.notes || null,
        notifyCandidate: isAlpha && f.notify,
      });
      toast.success(r.candidateNotified === 'sent' ? 'Entrevista agendada e candidato avisado por e-mail.' : 'Entrevista agendada.');
      setAdding(false);
      await refresh();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (iv: Interview, status: Interview['status']) => {
    try {
      await api.patch(`/api/interviews/${iv.id}`, { expectedVersion: iv.version, status });
      toast.success(`Entrevista marcada como ${interviewStatusLabel[status].toLowerCase()}.`);
    } catch (e) {
      toast.error(e);
    } finally {
      await refresh();
    }
  };

  return (
    <section className="card">
      <div className="card-header">
        <h2>Entrevistas e próximos passos</h2>
        {q.data?.canSchedule && a.process.status === 'em_andamento' && !adding && <Button size="sm" onClick={() => setAdding(true)}>Agendar</Button>}
      </div>
      <div className="card-body stack">
        {adding && (
          <div className="stack" style={{ borderBottom: '1px solid var(--border)', paddingBottom: 12 }}>
            <div className="grid grid-2">
              <TextField label="Data e hora" type="datetime-local" value={f.when} onChange={(e) => setF((x) => ({ ...x, when: e.target.value }))} required />
              <SelectField label="Formato" value={f.mode} onChange={(e) => setF((x) => ({ ...x, mode: e.target.value }))}>
                {Object.entries(interviewModeLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </SelectField>
            </div>
            <TextField label="Local ou link" value={f.location} maxLength={300} onChange={(e) => setF((x) => ({ ...x, location: e.target.value }))} />
            <TextArea label="Observações" value={f.notes} rows={2} maxLength={2000} onChange={(e) => setF((x) => ({ ...x, notes: e.target.value }))} />
            {isAlpha && <Checkbox label="Avisar o candidato por e-mail" checked={f.notify} onChange={(e) => setF((x) => ({ ...x, notify: e.target.checked }))} />}
            <div className="row">
              <Button variant="primary" loading={busy} disabled={!f.when} onClick={save}>Salvar</Button>
              <Button onClick={() => setAdding(false)}>Cancelar</Button>
            </div>
          </div>
        )}
        {q.isLoading ? <Loading /> : q.isError ? <ErrorState error={q.error} /> : q.data!.items.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>Nenhuma entrevista registrada.</p>
        ) : (
          <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0, gap: 10 }}>
            {q.data!.items.map((iv) => (
              <li key={iv.id}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <strong>{fmtDateTime(iv.scheduledAt)} · {interviewModeLabel[iv.mode]}</strong>
                  <span className={`badge ${iv.status === 'agendada' ? 'badge-info' : iv.status === 'realizada' ? 'badge-success' : ''}`}>{interviewStatusLabel[iv.status]}</span>
                </div>
                {iv.location && <div className="small">{iv.location}</div>}
                {iv.notes && <div className="muted small pre-wrap">{iv.notes}</div>}
                <div className="muted small">Registrada por {iv.createdByName ?? '—'}</div>
                {q.data!.canSchedule && iv.status === 'agendada' && (
                  <div className="row" style={{ marginTop: 4 }}>
                    <Button size="sm" onClick={() => setStatus(iv, 'realizada')}>Marcar realizada</Button>
                    <Button size="sm" variant="ghost" onClick={() => setStatus(iv, 'cancelada')}>Cancelar</Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {a.process.status === 'em_andamento' && q.data && !q.data.canSchedule && (
          <Alert kind="info">Para agendar entrevistas, é preciso ter permissão de mover etapas ou decidir neste processo.</Alert>
        )}
      </div>
    </section>
  );
}
