import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qs } from '../../api/client';
import type { BillingSettings, NoticeKind, BillingSummary, ChargeDetail, ChargeRow, ChargeSituacao, Company, Page } from '../../api/types';
import {
  Alert, Button, Checkbox, ConfirmDialog, Empty, ErrorState, Loading, Modal, PageHeader, Pagination, SelectField, TextArea, TextField,
  fieldErrors, usePageTitle, useToast,
} from '../../components/ui';
import { fmtCents, fmtDateTime, fmtDay, noticeLabel, parseMoneyToCents, situacaoLabel } from '../../lib/format';

const situacaoBadge: Record<ChargeSituacao, string> = {
  pendente: 'badge-info',
  vencida: 'badge-danger',
  pago: 'badge-success',
  cancelado: '',
};

function SituacaoBadge({ s }: { s: ChargeSituacao }) {
  return <span className={`badge ${situacaoBadge[s]}`}>{situacaoLabel[s]}</span>;
}

const centsToInput = (c: number) => (c / 100).toFixed(2).replace('.', ',');

export function BillingPage() {
  usePageTitle('Cobranças');
  const [page, setPage] = useState(1);
  const [situacao, setSituacao] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);

  const summary = useQuery({ queryKey: ['billing', 'summary'], queryFn: () => api.get<BillingSummary>('/api/billing/summary') });
  const companies = useQuery({ queryKey: ['companies'], queryFn: () => api.get<{ items: Company[] }>('/api/companies') });
  const list = useQuery({
    queryKey: ['billing', 'charges', page, situacao, companyId, q],
    queryFn: () => api.get<Page<ChargeRow>>(`/api/billing/charges${qs({ page, situacao, companyId, q, pageSize: 20 })}`),
  });
  const sm = summary.data;

  return (
    <>
      <PageHeader
        title="Cobranças"
        subtitle="Cobranças das empresas clientes. Os e-mails de cobrança, lembrete e atraso saem sozinhos."
        actions={<><Button onClick={() => setSettingsOpen(true)}>Configurações</Button><Button variant="primary" onClick={() => setCreating(true)}>Nova cobrança</Button></>}
      />
      <div className="stack">
        {sm && !sm.emailEnabled && (
          <Alert kind="warning">
            Os e-mails automáticos estão desligados porque o envio de e-mail do servidor não foi configurado
            (variáveis SMTP_USER e SMTP_PASSWORD no Netlify). As cobranças ficam registradas, mas ninguém é avisado.
          </Alert>
        )}
        {sm && sm.emailEnabled && !sm.autoEmail && (
          <Alert kind="warning">O envio automático está desligado em Configurações.</Alert>
        )}
        <section className="grid grid-3" aria-label="Resumo">
          <div className="card stat">
            <div className="label">A receber (a vencer)</div>
            <div className="value">{sm ? fmtCents(sm.openCents) : '…'}</div>
            <div className="muted small">{sm?.openCount ?? 0} cobrança(s)</div>
          </div>
          <div className="card stat">
            <div className="label">Vencidas</div>
            <div className="value">{sm ? fmtCents(sm.overdueCents) : '…'}</div>
            <div className="muted small">{sm?.overdueCount ?? 0} cobrança(s)</div>
          </div>
          <div className="card stat">
            <div className="label">Recebido neste mês</div>
            <div className="value">{sm ? fmtCents(sm.paidMonthCents) : '…'}</div>
            <div className="muted small">{sm?.paidMonthCount ?? 0} pagamento(s)</div>
          </div>
        </section>

        <section className="card">
          <div className="card-body">
            <div className="filters" role="search">
              <TextField label="Buscar" placeholder="Empresa ou descrição" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
              <SelectField label="Situação" value={situacao} onChange={(e) => { setSituacao(e.target.value); setPage(1); }}>
                <option value="">Todas</option>
                <option value="abertas">Em aberto (a vencer + vencidas)</option>
                <option value="vencida">Vencidas</option>
                <option value="pendente">A vencer</option>
                <option value="pago">Pagas</option>
                <option value="cancelado">Canceladas</option>
              </SelectField>
              <SelectField label="Empresa" value={companyId} onChange={(e) => { setCompanyId(e.target.value); setPage(1); }}>
                <option value="">Todas</option>
                {companies.data?.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </SelectField>
            </div>
          </div>
          {list.isLoading ? <Loading /> : list.isError ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : list.data!.items.length === 0 ? (
            <Empty title="Nenhuma cobrança encontrada" />
          ) : (
            <>
              <div className="table-wrap">
                <table className="table responsive">
                  <thead><tr><th>Empresa</th><th>Descrição</th><th>Valor</th><th>Vencimento</th><th>Situação</th><th>Último e-mail</th><th className="actions">Ações</th></tr></thead>
                  <tbody>
                    {list.data!.items.map((c) => (
                      <tr key={c.id}>
                        <td data-label="Empresa"><strong>{c.companyName}</strong></td>
                        <td data-label="Descrição">
                          {c.description}
                          {c.recurrence === 'mensal' && <> <span className="badge badge-brand">Mensal</span></>}
                          {c.remindersPaused && c.status === 'pendente' && <> <span className="badge">Avisos pausados</span></>}
                          {c.gatewayId && <> <span className="badge badge-info">Asaas</span></>}
                          {c.gatewayError && c.gatewayPending && <> <span className="badge badge-danger" title={c.gatewayError}>Erro no Asaas</span></>}
                        </td>
                        <td data-label="Valor" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtCents(c.amountCents)}</td>
                        <td data-label="Vencimento">{fmtDay(c.dueDate)}</td>
                        <td data-label="Situação"><SituacaoBadge s={c.situacao} /></td>
                        <td data-label="Último e-mail">
                          {c.lastNotice ? (
                            <>
                              {noticeLabel[c.lastNotice.kind]}
                              {!c.lastNotice.ok && <> <span className="badge badge-danger">falhou</span></>}
                              <div className="muted small">{fmtDateTime(c.lastNotice.sentAt)}</div>
                            </>
                          ) : '—'}
                        </td>
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
      </div>
      {creating && <NewChargeModal companies={companies.data?.items.filter((c) => c.isActive) ?? []} onClose={() => setCreating(false)} />}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {detail && <ChargeModal id={detail} onClose={() => setDetail(null)} emailEnabled={!!sm?.emailEnabled} today={sm?.today} />}
    </>
  );
}

function useRefresh() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['billing'] });
}

function NewChargeModal({ companies, onClose }: { companies: Company[]; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const [all, setAll] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [recurrence, setRecurrence] = useState<'nenhuma' | 'mensal'>('nenhuma');
  const [paymentLink, setPaymentLink] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const cents = parseMoneyToCents(amount);
  const visible = useMemo(
    () => companies.filter((c) => c.name.toLowerCase().includes(filter.trim().toLowerCase())),
    [companies, filter],
  );
  const count = all ? companies.length : selected.size;
  const noEmail = companies.filter((c) => (all || selected.has(c.id)) && !c.billingEmail);

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const save = async () => {
    setBusy(true);
    setErrors({});
    try {
      const r = await api.post<{ count: number; emails: { sent: number; failed: number; pending: number } }>('/api/billing/charges', {
        ...(all ? { allActive: true } : { companyIds: [...selected] }),
        description,
        amountCents: cents,
        dueDate,
        recurrence,
        paymentLink: paymentLink || null,
      });
      const pend = r.emails.pending + r.emails.failed;
      toast.success(
        `${r.count} cobrança(s) criada(s). ${r.emails.sent} e-mail(s) enviado(s)${pend ? `; ${pend} sairá(ão) na próxima rodada automática` : ''}.`,
      );
      await refresh();
      onClose();
    } catch (e) {
      setErrors(fieldErrors(e));
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Nova cobrança" size="lg" onClose={onClose}
      footer={<><Button onClick={onClose}>Cancelar</Button>
        <Button variant="primary" onClick={save} loading={busy} disabled={!count || !cents || !dueDate || description.trim().length < 2}>
          Criar {count > 1 ? `${count} cobranças` : 'cobrança'}
        </Button></>}>
      <div className="stack">
        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="small" style={{ fontWeight: 600, marginBottom: 6 }}>Empresas</legend>
          <Checkbox label={`Todas as empresas ativas (${companies.length})`} checked={all} onChange={(e) => setAll(e.target.checked)} />
          {!all && (
            <>
              <TextField label="Filtrar empresas" value={filter} onChange={(e) => setFilter(e.target.value)} />
              <div style={{ maxHeight: 200, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8, padding: 8 }}>
                {visible.length === 0 ? <span className="muted small">Nenhuma empresa.</span> : visible.map((c) => (
                  <Checkbox key={c.id} label={c.name} hint={c.billingEmail ?? 'sem e-mail de cobrança: usa o e-mail do usuário da empresa'}
                    checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                ))}
              </div>
              {errors.companyIds && <span className="error" role="alert">{errors.companyIds}</span>}
            </>
          )}
          {noEmail.length > 0 && (
            <span className="muted small">
              {noEmail.length} empresa(s) sem e-mail de cobrança: será usado o e-mail do usuário da empresa. Para escolher outro, edite em Empresas clientes.
            </span>
          )}
        </fieldset>
        <TextField label="Descrição" value={description} onChange={(e) => setDescription(e.target.value)} error={errors.description} maxLength={200}
          placeholder="Ex.: Mensalidade — recrutamento e seleção" required />
        <div className="grid grid-2">
          <TextField label="Valor (R$)" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="1.500,00"
            error={amount && !cents ? 'Valor inválido.' : errors.amountCents} required />
          <TextField label="Vencimento" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} error={errors.dueDate} required />
        </div>
        <SelectField label="Repetição" value={recurrence} onChange={(e) => setRecurrence(e.target.value as typeof recurrence)}
          hint={recurrence === 'mensal' ? 'Uma nova cobrança é criada automaticamente todo mês, no mesmo dia.' : undefined}>
          <option value="nenhuma">Cobrança única</option>
          <option value="mensal">Todo mês</option>
        </SelectField>
        <TextField label="Link de pagamento" value={paymentLink} onChange={(e) => setPaymentLink(e.target.value)} error={errors.paymentLink}
          placeholder="https://..." hint="Opcional (boleto ou link do banco). A chave Pix vem das Configurações." />
      </div>
    </Modal>
  );
}

const gatewayStatusLabel: Record<string, string> = {
  PENDING: 'Aguardando pagamento',
  OVERDUE: 'Vencida',
  RECEIVED: 'Recebida',
  CONFIRMED: 'Confirmada',
  RECEIVED_IN_CASH: 'Baixada manualmente',
  REFUNDED: 'Estornada',
  DELETED: 'Removida',
};

function ChargeModal({ id, onClose, emailEnabled, today }: { id: string; onClose: () => void; emailEnabled: boolean; today?: string }) {
  const settings = useQuery({ queryKey: ['billing', 'settings'], queryFn: () => api.get<BillingSettings>('/api/billing/settings') });
  const gatewayOn = !!settings.data?.gatewayEnabled && !!settings.data?.asaas.configured;
  const toast = useToast();
  const refresh = useRefresh();
  const q = useQuery({ queryKey: ['billing', 'charge', id], queryFn: () => api.get<ChargeDetail>(`/api/billing/charges/${id}`) });
  const [mode, setMode] = useState<'view' | 'edit' | 'pay' | 'cancel'>('view');
  const [busy, setBusy] = useState(false);
  const c = q.data;

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
      await refresh();
      setMode('view');
    } catch (e) {
      toast.error(e);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  if (c && mode === 'edit') return <EditChargeModal charge={c} onClose={() => setMode('view')} />;
  if (c && mode === 'pay') return <PayModal charge={c} today={today} onClose={() => setMode('view')} />;
  if (c && mode === 'cancel') {
    return (
      <ConfirmDialog title="Cancelar cobrança" danger loading={busy}
        message={<>Cancelar <strong>{c.description}</strong> de {c.companyName}? Nenhum novo e-mail será enviado{c.recurrence === 'mensal' ? ' e a repetição mensal termina' : ''}.</>}
        confirmLabel="Cancelar cobrança" onCancel={() => setMode('view')}
        onConfirm={() => act(() => api.post(`/api/billing/charges/${id}/cancel`, { expectedVersion: c.version }), 'Cobrança cancelada.')} />
    );
  }

  const pending = c?.status === 'pendente';
  return (
    <Modal title="Cobrança" size="lg" onClose={onClose}
      footer={pending && c ? (
        <div className="row" style={{ width: '100%', justifyContent: 'space-between' }}>
          <Button variant="danger" onClick={() => setMode('cancel')}>Cancelar cobrança</Button>
          <div className="row">
            <Button onClick={() => setMode('edit')}>Editar</Button>
            {emailEnabled && (
              <Button loading={busy} onClick={() => act(() => api.post(`/api/billing/charges/${id}/send`), 'E-mail enviado.')}>Enviar e-mail agora</Button>
            )}
            <Button variant="primary" onClick={() => setMode('pay')}>Marcar como paga</Button>
          </div>
        </div>
      ) : <Button onClick={onClose}>Fechar</Button>}>
      {q.isLoading ? <Loading /> : q.isError ? <ErrorState error={q.error} /> : c && (
        <div className="stack">
          <div className="grid grid-2">
            <div><div className="muted small">Empresa</div><strong>{c.companyName}</strong></div>
            <div><div className="muted small">Situação</div><SituacaoBadge s={c.situacao} /></div>
            <div><div className="muted small">Descrição</div>{c.description}{c.recurrence === 'mensal' && <> <span className="badge badge-brand">Mensal · parcela {c.seriesIndex + 1}</span></>}</div>
            <div><div className="muted small">Valor</div><strong>{fmtCents(c.amountCents)}</strong></div>
            <div><div className="muted small">Vencimento</div>{fmtDay(c.dueDate)}</div>
            <div><div className="muted small">E-mail de cobrança</div>{c.billingEmail}</div>
            {c.paymentLink && <div><div className="muted small">Link de pagamento</div><a href={c.paymentLink} target="_blank" rel="noopener noreferrer">{c.paymentLink}</a></div>}
            {c.paidAt && <div><div className="muted small">Pago em</div>{fmtDateTime(c.paidAt)}{c.paidNote && <div className="muted small">{c.paidNote}</div>}</div>}
            {c.canceledAt && <div><div className="muted small">Cancelada em</div>{fmtDateTime(c.canceledAt)}</div>}
            {(c.gatewayId || c.gatewayPending) && (
              <div>
                <div className="muted small">Asaas</div>
                {c.gatewayId ? <>{gatewayStatusLabel[c.gatewayStatus ?? ''] ?? c.gatewayStatus ?? '—'} <span className="muted small">({c.gatewayId})</span></> : 'Aguardando criação'}
              </div>
            )}
          </div>
          {c.gatewayError && c.gatewayPending && <Alert>{c.gatewayError}</Alert>}
          {gatewayOn && (c.gatewayId || pending) && (
            <div className="row">
              <Button size="sm" loading={busy}
                onClick={() => act(async () => {
                  const r = await api.post<{ paid: boolean }>(`/api/billing/charges/${id}/gateway-sync`);
                  if (r.paid) toast.success('Pagamento encontrado no Asaas: cobrança baixada.');
                }, c.gatewayId ? 'Atualizado com o Asaas.' : 'Cobrança gerada no Asaas.')}>
                {c.gatewayId ? 'Atualizar do Asaas' : 'Gerar boleto/Pix no Asaas'}
              </Button>
              <span className="muted small">O pagamento pelo Asaas dá baixa automática; use este botão se ela demorar.</span>
            </div>
          )}
          {pending && (
            <div className="row">
              <Checkbox label="Pausar e-mails automáticos desta cobrança" checked={c.remindersPaused} disabled={busy}
                onChange={(e) => act(() => api.patch(`/api/billing/charges/${id}`, { expectedVersion: c.version, remindersPaused: e.target.checked }),
                  e.target.checked ? 'E-mails automáticos pausados.' : 'E-mails automáticos retomados.')} />
              {c.recurrence === 'mensal' && (
                <Button size="sm" loading={busy}
                  onClick={() => act(() => api.patch(`/api/billing/charges/${id}`, { expectedVersion: c.version, recurrence: 'nenhuma' }), 'Repetição mensal encerrada após esta cobrança.')}>
                  Encerrar repetição mensal
                </Button>
              )}
            </div>
          )}
          <div>
            <h3 style={{ margin: '0 0 8px' }}>E-mails enviados</h3>
            {c.notices.length === 0 ? <p className="muted">Nenhum e-mail enviado ainda.</p> : (
              <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0, gap: 8 }}>
                {c.notices.map((n) => (
                  <li key={n.id}>
                    <strong>{noticeLabel[n.kind]}</strong>{n.channel === 'whatsapp' ? ' (WhatsApp)' : ''} — {fmtDateTime(n.sentAt)} — {n.sentTo}{' '}
                    {n.ok ? <span className="badge badge-success">enviado</span> : <span className="badge badge-danger">{n.error ?? 'falhou'}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

function EditChargeModal({ charge, onClose }: { charge: ChargeDetail; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const [description, setDescription] = useState(charge.description);
  const [amount, setAmount] = useState(centsToInput(charge.amountCents));
  const [dueDate, setDueDate] = useState(charge.dueDate);
  const [billingEmail, setBillingEmail] = useState(charge.billingEmail);
  const [paymentLink, setPaymentLink] = useState(charge.paymentLink ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const cents = parseMoneyToCents(amount);
  const save = async () => {
    setBusy(true);
    try {
      await api.patch(`/api/billing/charges/${charge.id}`, {
        expectedVersion: charge.version, description, amountCents: cents, dueDate, billingEmail, paymentLink: paymentLink || null,
      });
      toast.success('Cobrança atualizada.');
      await refresh();
      onClose();
    } catch (e) {
      setErrors(fieldErrors(e));
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Editar cobrança" onClose={onClose}
      footer={<><Button onClick={onClose}>Voltar</Button><Button variant="primary" onClick={save} loading={busy} disabled={!cents || !dueDate}>Salvar</Button></>}>
      <div className="stack">
        <TextField label="Descrição" value={description} onChange={(e) => setDescription(e.target.value)} error={errors.description} maxLength={200} required />
        <div className="grid grid-2">
          <TextField label="Valor (R$)" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" error={amount && !cents ? 'Valor inválido.' : errors.amountCents} required />
          <TextField label="Vencimento" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} error={errors.dueDate} required />
        </div>
        <TextField label="E-mail de cobrança" type="email" value={billingEmail} onChange={(e) => setBillingEmail(e.target.value)} error={errors.billingEmail} required />
        <TextField label="Link de pagamento" value={paymentLink} onChange={(e) => setPaymentLink(e.target.value)} error={errors.paymentLink} placeholder="https://..." />
        <span className="muted small">Ao mudar o vencimento, os lembretes seguem a nova data.</span>
      </div>
    </Modal>
  );
}

function PayModal({ charge, today, onClose }: { charge: ChargeDetail; today?: string; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const [paidOn, setPaidOn] = useState(today ?? '');
  const [note, setNote] = useState('');
  const [sendReceipt, setSendReceipt] = useState(true);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ receipt: boolean }>(`/api/billing/charges/${charge.id}/pay`, {
        expectedVersion: charge.version, note: note || null, ...(paidOn ? { paidOn } : {}), sendReceipt,
      });
      toast.success(r.receipt ? 'Pagamento registrado e recibo enviado por e-mail.' : 'Pagamento registrado.');
      await refresh();
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Registrar pagamento" onClose={onClose}
      footer={<><Button onClick={onClose}>Voltar</Button><Button variant="primary" onClick={save} loading={busy}>Confirmar pagamento</Button></>}>
      <div className="stack">
        <p>{charge.companyName} — {charge.description} — <strong>{fmtCents(charge.amountCents)}</strong></p>
        <TextField label="Data do pagamento" type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
        <TextArea label="Observação" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} rows={2} hint="Opcional. Ex.: Pix recebido no banco X." />
        <Checkbox label="Enviar recibo por e-mail para a empresa" checked={sendReceipt} onChange={(e) => setSendReceipt(e.target.checked)} />
      </div>
    </Modal>
  );
}

function SettingsModal({ onClose }: { onClose: () => void }) {
  const q = useQuery({ queryKey: ['billing', 'settings'], queryFn: () => api.get<BillingSettings>('/api/billing/settings') });
  return q.data ? <SettingsForm initial={q.data} onClose={onClose} /> : (
    <Modal title="Configurações de cobrança" onClose={onClose}>{q.isError ? <ErrorState error={q.error} /> : <Loading />}</Modal>
  );
}

function SettingsForm({ initial, onClose }: { initial: BillingSettings; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const [s, setS] = useState({
    autoEmail: initial.autoEmail,
    pixKey: initial.pixKey ?? '',
    beneficiary: initial.beneficiary ?? '',
    instructions: initial.instructions ?? '',
    reminderDaysBefore: String(initial.reminderDaysBefore),
    overdueEveryDays: String(initial.overdueEveryDays),
    overdueMaxReminders: String(initial.overdueMaxReminders),
    gatewayEnabled: initial.gatewayEnabled,
    whatsappEnabled: initial.whatsappEnabled,
  });
  const [waTemplates, setWaTemplates] = useState<Partial<Record<NoticeKind, string>>>(initial.whatsappTemplates ?? {});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof s) => (e: { target: { value: string } }) => setS((x) => ({ ...x, [k]: e.target.value }));
  const save = async () => {
    setBusy(true);
    try {
      await api.put('/api/billing/settings', {
        autoEmail: s.autoEmail,
        pixKey: s.pixKey || null,
        beneficiary: s.beneficiary || null,
        instructions: s.instructions || null,
        reminderDaysBefore: Number(s.reminderDaysBefore),
        overdueEveryDays: Number(s.overdueEveryDays),
        overdueMaxReminders: Number(s.overdueMaxReminders),
        gatewayEnabled: s.gatewayEnabled,
        whatsappEnabled: s.whatsappEnabled,
        whatsappTemplates: Object.fromEntries(Object.entries(waTemplates).map(([k, v]) => [k, v?.trim()]).filter(([, v]) => v)),
      });
      toast.success('Configurações salvas.');
      await refresh();
      onClose();
    } catch (e) {
      setErrors(fieldErrors(e));
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Configurações de cobrança" size="lg" onClose={onClose}
      footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" onClick={save} loading={busy}>Salvar</Button></>}>
      <div className="stack">
        {!initial.emailEnabled && <Alert kind="warning">Envio de e-mail não configurado no servidor: nada será enviado até configurar.</Alert>}
        <Checkbox label="Enviar e-mails de cobrança automaticamente" checked={s.autoEmail}
          onChange={(e) => setS((x) => ({ ...x, autoEmail: e.target.checked }))}
          hint="Ao criar a cobrança, alguns dias antes do vencimento, no dia do vencimento e enquanto estiver em atraso." />
        <div className="grid grid-2">
          <TextField label="Chave Pix" value={s.pixKey} onChange={set('pixKey')} maxLength={140} error={errors.pixKey} />
          <TextField label="Favorecido" value={s.beneficiary} onChange={set('beneficiary')} maxLength={140} error={errors.beneficiary} />
        </div>
        <TextArea label="Instruções no e-mail" value={s.instructions} onChange={set('instructions')} maxLength={2000} rows={3}
          hint="Opcional. Ex.: dados bancários para TED ou contato do financeiro." error={errors.instructions} />
        <fieldset className="question">
          <legend>Boleto, Pix e cartão (Asaas)</legend>
          <div className="stack">
            {!initial.asaas.configured ? (
              <p className="muted small" style={{ margin: 0 }}>
                Para gerar boleto/Pix/cartão e dar baixa automática, crie uma conta no Asaas e coloque a chave da API na variável
                <code> ASAAS_API_KEY</code> do Netlify (marcada como secreta). Sem isso, a baixa continua manual.
              </p>
            ) : (
              <>
                <Checkbox label="Gerar cobranças no Asaas" checked={s.gatewayEnabled}
                  onChange={(e) => setS((x) => ({ ...x, gatewayEnabled: e.target.checked }))}
                  hint="Cada nova cobrança vira uma página de pagamento do Asaas (o cliente escolhe boleto, Pix ou cartão) e o link vai no e-mail. A empresa precisa ter CNPJ cadastrado." />
                <p className="small" style={{ margin: 0 }}>
                  Conta: <strong>{initial.asaas.environment === 'producao' ? 'produção' : 'sandbox (testes, sem cobrança real)'}</strong>
                </p>
                {initial.asaas.webhookConfigured ? (
                  <p className="muted small" style={{ margin: 0 }}>
                    Baixa automática: no Asaas, em Integrações → Webhooks, cadastre a URL <code>{initial.asaas.webhookUrl}</code> com
                    o mesmo token da variável <code>ASAAS_WEBHOOK_TOKEN</code> e os eventos de cobrança.
                  </p>
                ) : (
                  <Alert kind="warning">Falta a variável ASAAS_WEBHOOK_TOKEN: sem ela o sistema não recebe os avisos de pagamento (use "Atualizar do Asaas" na cobrança).</Alert>
                )}
              </>
            )}
          </div>
        </fieldset>
        {initial.whatsappConfigured && (
          <fieldset className="question">
            <legend>WhatsApp</legend>
            <div className="stack">
              <Checkbox label="Enviar os avisos também pelo WhatsApp do financeiro" checked={s.whatsappEnabled}
                onChange={(e) => setS((x) => ({ ...x, whatsappEnabled: e.target.checked }))}
                hint="Vai para o número cadastrado em Empresas clientes → WhatsApp do financeiro. Só sai o aviso que tiver modelo aprovado informado abaixo." />
              <div className="grid grid-3">
                {(['criada', 'lembrete', 'vencimento', 'atraso', 'pagamento', 'manual'] as NoticeKind[]).map((k) => (
                  <TextField key={k} label={noticeLabel[k]} value={waTemplates[k] ?? ''} placeholder="nome do modelo"
                    onChange={(e) => setWaTemplates((x) => ({ ...x, [k]: e.target.value.toLowerCase() }))} error={errors[`whatsappTemplates.${k}`]} />
                ))}
              </div>
              <span className="muted small">
                Parâmetros dos modelos, nesta ordem: <code>{'{{1}}'} empresa</code> <code>{'{{2}}'} descrição</code>{' '}
                <code>{'{{3}}'} valor</code> <code>{'{{4}}'} vencimento</code> <code>{'{{5}}'} link de pagamento</code>
              </span>
            </div>
          </fieldset>
        )}
        <div className="grid grid-3">
          <TextField label="Lembrete (dias antes)" type="number" min={0} max={30} value={s.reminderDaysBefore} onChange={set('reminderDaysBefore')} error={errors.reminderDaysBefore} />
          <TextField label="Reenviar atraso a cada (dias)" type="number" min={1} max={60} value={s.overdueEveryDays} onChange={set('overdueEveryDays')} error={errors.overdueEveryDays} />
          <TextField label="Máximo de avisos de atraso" type="number" min={0} max={12} value={s.overdueMaxReminders} onChange={set('overdueMaxReminders')} error={errors.overdueMaxReminders} />
        </div>
      </div>
    </Modal>
  );
}
