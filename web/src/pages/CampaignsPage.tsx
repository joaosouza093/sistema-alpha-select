import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Page, ProcessRow, Stage } from '../api/types';
import {
  Alert, Button, Checkbox, ConfirmDialog, Empty, ErrorState, Loading, Modal, PageHeader, Pagination, SelectField, TextArea, TextField,
  fieldErrors, usePageTitle, useToast,
} from '../components/ui';
import { fmtDateTime } from '../lib/format';

type CampaignStatus = 'agendada' | 'enviando' | 'enviada' | 'cancelada';
interface Campaign {
  id: string;
  subject: string;
  body: string;
  processId: string | null;
  processTitle: string | null;
  scheduledAt: string;
  status: CampaignStatus;
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  createdAt: string;
  finishedAt: string | null;
  createdByName: string | null;
}
interface CampaignDetail extends Campaign {
  recipients: { candidateId: string; fullName: string; email: string | null; status: 'pendente' | 'enviado' | 'falhou' | 'ignorado'; detail: string | null; sentAt: string | null }[];
}

/** Destinatários pré-escolhidos ao abrir a página (lista de candidatos ou processo). */
export interface CampaignPreset {
  candidates?: { id: string; fullName: string }[];
  processId?: string;
}

const statusLabel: Record<CampaignStatus, string> = { agendada: 'Agendado', enviando: 'Enviando', enviada: 'Enviado', cancelada: 'Cancelado' };
const statusBadge: Record<CampaignStatus, string> = { agendada: 'badge-info', enviando: 'badge-warning', enviada: 'badge-success', cancelada: '' };
const recipientLabel = { pendente: 'Aguardando', enviado: 'Enviado', falhou: 'Falhou', ignorado: 'Não enviado' } as const;

export function CampaignsPage() {
  usePageTitle('Comunicados');
  const loc = useLocation();
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [preset, setPreset] = useState<CampaignPreset | null>((loc.state as { campaign?: CampaignPreset } | null)?.campaign ?? null);
  const [detail, setDetail] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ['campaigns', page],
    queryFn: () => api.get<Page<Campaign> & { emailEnabled: boolean }>(`/api/campaigns?page=${page}&pageSize=20`),
  });
  // Limpa o estado da navegação para o modal não reabrir ao recarregar.
  useEffect(() => {
    if (loc.state) navigate(loc.pathname, { replace: true, state: null });
  }, [loc.state, loc.pathname, navigate]);

  return (
    <>
      <PageHeader title="Comunicados" subtitle="Mensagens por e-mail para vários candidatos, na hora ou agendadas."
        actions={<Button variant="primary" onClick={() => setPreset({})}>Novo comunicado</Button>} />
      {list.data && !list.data.emailEnabled && (
        <Alert kind="warning">O envio de e-mail do servidor não está configurado (SMTP): os comunicados não podem ser enviados.</Alert>
      )}
      <section className="card">
        {list.isLoading ? <Loading /> : list.isError ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : list.data!.items.length === 0 ? (
          <Empty title="Nenhum comunicado enviado">Escolha candidatos na lista (caixas de seleção) ou use "Enviar comunicado" num processo.</Empty>
        ) : (
          <>
            <div className="table-wrap">
              <table className="table responsive">
                <thead><tr><th>Assunto</th><th>Envio</th><th>Situação</th><th>Destinatários</th><th>Por</th><th className="actions">Ações</th></tr></thead>
                <tbody>
                  {list.data!.items.map((c) => (
                    <tr key={c.id}>
                      <td data-label="Assunto"><strong>{c.subject}</strong>{c.processTitle && <div className="muted small">{c.processTitle}</div>}</td>
                      <td data-label="Envio">{fmtDateTime(c.scheduledAt)}</td>
                      <td data-label="Situação"><span className={`badge ${statusBadge[c.status]}`}>{statusLabel[c.status]}</span></td>
                      <td data-label="Destinatários">
                        {c.total}
                        {(c.status === 'enviada' || c.status === 'enviando') && (
                          <div className="muted small">{c.sent} enviado(s){c.failed ? ` · ${c.failed} falha(s)` : ''}{c.skipped ? ` · ${c.skipped} não enviado(s)` : ''}</div>
                        )}
                      </td>
                      <td data-label="Por">{c.createdByName ?? '—'}</td>
                      <td className="actions"><Button size="sm" onClick={() => setDetail(c.id)}>Abrir</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={page} pageSize={list.data!.pageSize} total={list.data!.total} onPage={setPage} />
          </>
        )}
      </section>
      {preset && <NewCampaignModal preset={preset} onClose={() => setPreset(null)} />}
      {detail && <CampaignModal id={detail} onClose={() => setDetail(null)} />}
    </>
  );
}

/** "2026-10-12T14:30" (horário local do navegador) a partir de agora + minutos. */
const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

function NewCampaignModal({ preset, onClose }: { preset: CampaignPreset; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const processes = useQuery({ queryKey: ['processes-all'], queryFn: () => api.get<Page<ProcessRow>>('/api/processes?pageSize=100') });
  const stages = useQuery({ queryKey: ['stages'], queryFn: () => api.get<{ items: Stage[] }>('/api/stages'), staleTime: Infinity });
  const [picked, setPicked] = useState(preset.candidates ?? []);
  const [processId, setProcessId] = useState(preset.processId ?? '');
  const [stageId, setStageId] = useState('');
  const [onlyPending, setOnlyPending] = useState(true);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('Olá, {{candidato}}.\n\n\n\nAlpha Select Consultoria de Recursos Humanos');
  const [schedule, setSchedule] = useState(false);
  const [when, setWhen] = useState(localInput(new Date(Date.now() + 24 * 3600_000)));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const hasRecipients = picked.length > 0 || !!processId;

  const send = async () => {
    setBusy(true);
    setErrors({});
    try {
      const r = await api.post<{ total: number; scheduled: boolean; result: { sent: number; failed: number; skipped: number; pending: number } | null }>('/api/campaigns', {
        subject, body,
        candidateIds: picked.map((c) => c.id),
        processId: processId || null,
        stageId: processId && stageId ? Number(stageId) : null,
        onlyPending: !!processId && onlyPending,
        scheduledAt: schedule ? new Date(when).toISOString() : null,
      });
      if (r.scheduled) toast.success(`Comunicado agendado para ${r.total} candidato(s).`);
      else {
        const x = r.result;
        toast.success(x
          ? `${x.sent} e-mail(s) enviado(s)${x.skipped ? `, ${x.skipped} sem e-mail ou descadastrado(s)` : ''}${x.failed ? `, ${x.failed} falha(s)` : ''}${x.pending ? `; ${x.pending} sairão em seguida` : ''}.`
          : `Comunicado criado para ${r.total} candidato(s).`);
      }
      await qc.invalidateQueries({ queryKey: ['campaigns'] });
      onClose();
    } catch (e) {
      setErrors(fieldErrors(e));
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Novo comunicado" size="lg" onClose={onClose}
      footer={<><Button onClick={onClose}>Cancelar</Button>
        <Button variant="primary" loading={busy} onClick={send} disabled={!hasRecipients || subject.trim().length < 3 || body.trim().length < 10 || (schedule && !when)}>
          {schedule ? 'Agendar' : 'Enviar agora'}
        </Button></>}>
      <div className="stack">
        <fieldset className="question">
          <legend>Destinatários</legend>
          <div className="stack">
            {picked.length > 0 && (
              <div>
                <div className="small"><strong>{picked.length} candidato(s) escolhido(s):</strong> {picked.slice(0, 8).map((c) => c.fullName).join(', ')}{picked.length > 8 ? '…' : ''}</div>
                <Button size="sm" onClick={() => setPicked([])}>Remover escolhidos</Button>
              </div>
            )}
            <div className="grid grid-2">
              <SelectField label={picked.length ? 'E também os candidatos do processo' : 'Candidatos do processo'} value={processId} onChange={(e) => setProcessId(e.target.value)}>
                <option value="">—</option>
                {processes.data?.items.map((p) => <option key={p.id} value={p.id}>{p.title} — {p.companyName}</option>)}
              </SelectField>
              {processId && (
                <SelectField label="Etapa" value={stageId} onChange={(e) => setStageId(e.target.value)}>
                  <option value="">Todas</option>
                  {stages.data?.items.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </SelectField>
              )}
            </div>
            {processId && <Checkbox label="Somente quem ainda está em avaliação (sem aprovação, reprovação ou desistência)" checked={onlyPending} onChange={(e) => setOnlyPending(e.target.checked)} />}
            {!hasRecipients && <span className="muted small">Escolha um processo, ou selecione candidatos na lista de Candidatos e use "Enviar comunicado".</span>}
            {errors.candidateIds && <span className="error" role="alert">{errors.candidateIds}</span>}
          </div>
        </fieldset>
        <TextField label="Assunto" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} required error={errors.subject}
          placeholder="Ex.: Atualização sobre a vaga {{vaga}}" />
        <TextArea label="Mensagem" value={body} onChange={(e) => setBody(e.target.value)} maxLength={5000} rows={9} required error={errors.body}
          hint="Variáveis: {{candidato}} (primeiro nome), {{nome_completo}}, {{vaga}} e {{empresa}} (quando o candidato vem de um processo). O rodapé com o link para descadastrar é incluído automaticamente." />
        <Checkbox label="Agendar o envio" checked={schedule} onChange={(e) => setSchedule(e.target.checked)} />
        {schedule && (
          <TextField label="Data e hora do envio" type="datetime-local" value={when} min={localInput(new Date())} onChange={(e) => setWhen(e.target.value)}
            error={errors.scheduledAt} hint="Sai na rodada automática seguinte ao horário (até 1 hora depois)." />
        )}
        <span className="muted small">Só recebe quem tem e-mail e não se descadastrou. Não é enviado pelo WhatsApp (a Meta só permite modelos aprovados).</span>
      </div>
    </Modal>
  );
}

function CampaignModal({ id, onClose }: { id: string; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['campaign', id], queryFn: () => api.get<CampaignDetail>(`/api/campaigns/${id}`) });
  const [canceling, setCanceling] = useState(false);
  const c = q.data;
  const cancel = async () => {
    try {
      await api.post(`/api/campaigns/${id}/cancel`);
      toast.success('Comunicado cancelado.');
      await qc.invalidateQueries({ queryKey: ['campaigns'] });
      await q.refetch();
      setCanceling(false);
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <Modal title="Comunicado" size="lg" onClose={onClose}
      footer={<>{c?.status === 'agendada' && <Button variant="danger" onClick={() => setCanceling(true)}>Cancelar envio</Button>}<Button onClick={onClose}>Fechar</Button></>}>
      {q.isLoading ? <Loading /> : q.isError ? <ErrorState error={q.error} /> : c && (
        <div className="stack">
          <div className="grid grid-2">
            <div><div className="muted small">Situação</div><span className={`badge ${statusBadge[c.status]}`}>{statusLabel[c.status]}</span></div>
            <div><div className="muted small">Envio</div>{fmtDateTime(c.scheduledAt)}</div>
          </div>
          <div><div className="muted small">Assunto</div><strong>{c.subject}</strong></div>
          <div><div className="muted small">Mensagem</div><div style={{ whiteSpace: 'pre-wrap' }}>{c.body}</div></div>
          <div>
            <h3 style={{ margin: '0 0 8px' }}>Destinatários ({c.total})</h3>
            <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0, gap: 6 }}>
              {c.recipients.map((r) => (
                <li key={r.candidateId}>
                  {r.fullName} <span className="muted small">{r.email ?? 'sem e-mail'}</span>{' '}
                  <span className={`badge ${r.status === 'enviado' ? 'badge-success' : r.status === 'falhou' ? 'badge-danger' : ''}`}>{recipientLabel[r.status]}</span>
                  {r.detail && <span className="muted small"> · {r.detail}</span>}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {canceling && (
        <ConfirmDialog title="Cancelar envio" danger message="Cancelar este comunicado agendado? Ninguém receberá a mensagem."
          confirmLabel="Cancelar envio" onConfirm={cancel} onCancel={() => setCanceling(false)} />
      )}
    </Modal>
  );
}
