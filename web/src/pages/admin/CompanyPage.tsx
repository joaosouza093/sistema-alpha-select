import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { CompanyOverview, Contract, ContractModality, ContractStatus, Page, UserRow } from '../../api/types';
import { BillingFileLink, BillingFilePicker, uploadBillingFile } from '../../components/BillingFiles';
import {
  Button, ConfirmDialog, Empty, ErrorState, Loading, Modal, PageHeader, SelectField, StatusBadge, TextArea, TextField, fieldErrors,
  usePageTitle, useToast,
} from '../../components/ui';
import {
  contractStatusLabel, fmtCents, fmtCnpj, fmtDate, fmtDateTime, fmtDay, fmtPhone, kindLabel, modalityLabel, parseMoneyToCents,
} from '../../lib/format';
import { ContractTable } from '../FinancePage';
import { SituacaoBadge } from './BillingPage';
import { CompanyModal } from './CompaniesPage';

/** Visão 360° da empresa cliente: processos, leads, usuários, contratos e financeiro. */
export function CompanyPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['company-overview', id], queryFn: () => api.get<CompanyOverview>(`/api/companies/${id}/overview`) });
  usePageTitle(q.data?.company.name ?? 'Empresa');
  const [editing, setEditing] = useState(false);
  const [contract, setContract] = useState<Contract | 'new' | null>(null);
  const [removing, setRemoving] = useState<Contract | null>(null);
  const toast = useToast();
  const refresh = () => qc.invalidateQueries({ queryKey: ['company-overview', id] });

  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  const c = d.company;

  const removeContract = async () => {
    if (!removing) return;
    try {
      await api.delete(`/api/contracts/${removing.id}`);
      toast.success('Contrato excluído.');
      setRemoving(null);
      await refresh();
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <>
      <PageHeader
        title={c.name}
        subtitle={<>{c.isActive ? 'Ativa' : 'Inativa'} · cliente desde {fmtDate(c.createdAt)}{c.cnpj && <> · CNPJ {fmtCnpj(c.cnpj)}</>}</>}
        actions={<><Link to="/clientes" className="btn">Voltar</Link><Button onClick={() => setEditing(true)}>Editar dados</Button></>}
      />
      <div className="stack">
        <section className="grid grid-4" aria-label="Resumo">
          <div className="card stat">
            <div className="label">Processos em andamento</div>
            <div className="value">{d.pipeline.openProcesses}</div>
            <div className="muted small">{d.pipeline.doneProcesses} concluído(s)</div>
          </div>
          <div className="card stat">
            <div className="label">Candidatos nos processos</div>
            <div className="value">{d.pipeline.candidates}</div>
            <div className="muted small">{d.pipeline.approved} aprovado(s)</div>
          </div>
          <div className="card stat">
            <div className="label">Leads enviados</div>
            <div className="value">{d.leads.total}</div>
            <div className="muted small">{d.leads.last30} nos últimos 30 dias</div>
          </div>
          <div className="card stat">
            <div className="label">Em aberto</div>
            <div className="value">{fmtCents(d.finance.openCents + d.finance.overdueCents)}</div>
            <div className="muted small">{d.finance.overdueCount ? `${fmtCents(d.finance.overdueCents)} vencido` : 'nada vencido'}</div>
          </div>
        </section>

        <section className="card">
          <div className="card-header">
            <h2>Contratos</h2>
            <Button size="sm" variant="primary" onClick={() => setContract('new')}>Novo contrato</Button>
          </div>
          {d.contracts.length === 0 ? <Empty title="Nenhum contrato cadastrado">Registre o plano, a modalidade, o valor e a vigência.</Empty> : (
            <ContractTable items={d.contracts} actions={(k) => (
              <>
                <Button size="sm" onClick={() => setContract(k)}>Editar</Button>{' '}
                <Button size="sm" variant="danger" onClick={() => setRemoving(k)}>Excluir</Button>
              </>
            )} />
          )}
        </section>

        <section className="card">
          <div className="card-header">
            <h2>Financeiro</h2>
            <span className="muted small">Recebido no total: {fmtCents(d.finance.paidCents)} · <Link to={`/cobrancas?empresa=${c.id}`}>ver todas as cobranças</Link></span>
          </div>
          {d.charges.length === 0 ? <Empty title="Nenhuma cobrança" /> : (
            <div className="table-wrap">
              <table className="table responsive">
                <thead><tr><th>Descrição</th><th>Valor</th><th>Vencimento</th><th>Situação</th><th>Documentos</th></tr></thead>
                <tbody>
                  {d.charges.map((ch) => (
                    <tr key={ch.id}>
                      <td data-label="Descrição">{ch.description}</td>
                      <td data-label="Valor">{fmtCents(ch.amountCents)}</td>
                      <td data-label="Vencimento">{fmtDay(ch.dueDate)}</td>
                      <td data-label="Situação"><SituacaoBadge s={ch.situacao} /></td>
                      <td data-label="Documentos">
                        {ch.files.length ? <span className="row" style={{ gap: 12 }}>{ch.files.map((f) => <BillingFileLink key={f.id} file={f} />)}</span> : <span className="muted">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <div className="grid grid-2">
          <section className="card">
            <div className="card-header"><h2>Processos seletivos</h2></div>
            {d.processes.length === 0 ? <Empty title="Nenhum processo" /> : (
              <ul className="list-plain">
                {d.processes.map((p) => (
                  <li key={p.id} className="row" style={{ justifyContent: 'space-between' }}>
                    <span><Link to={`/processos/${p.id}`}>{p.title}</Link> <span className="muted small">· {p.candidates} candidato(s) · {p.leads} lead(s)</span></span>
                    <StatusBadge status={p.status} />
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="card">
            <div className="card-header"><h2>Usuários da empresa</h2><Link to={`/usuarios?empresa=${c.id}`} className="small">gerenciar</Link></div>
            {d.users.length === 0 ? <Empty title="Nenhum usuário" /> : (
              <ul className="list-plain">
                {d.users.map((u) => (
                  <li key={u.id}>
                    <strong>{u.fullName}</strong> <span className="muted small">· {kindLabel[u.kind as keyof typeof kindLabel] ?? u.kind}{!u.isActive && ' · inativo'}</span>
                    <div className="muted small">{u.email} · último acesso: {u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : 'nunca'}</div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <div className="grid grid-2">
          <section className="card">
            <div className="card-header"><h2>Contato e cobrança</h2></div>
            <div className="card-body stack" style={{ gap: 6 }}>
              <div><span className="muted small">E-mail de cobrança:</span> {c.billingEmail ?? '—'}</div>
              <div><span className="muted small">WhatsApp do financeiro:</span> {c.billingWhatsapp ? fmtPhone(c.billingWhatsapp) : '—'}</div>
              <div><span className="muted small">Mensagens aos candidatos dos processos:</span> {d.messages.total}{d.messages.lastSentAt && <> (última em {fmtDate(d.messages.lastSentAt)})</>}</div>
              <div><span className="muted small">Último lead enviado:</span> {d.leads.lastSentAt ? fmtDateTime(d.leads.lastSentAt) : '—'}</div>
            </div>
          </section>
          <section className="card">
            <div className="card-header"><h2>Atividade recente</h2><Link to="/auditoria" className="small">auditoria</Link></div>
            {d.activity.length === 0 ? <Empty title="Sem registros" /> : (
              <ul className="list-plain">
                {d.activity.map((a, i) => (
                  <li key={i}><code className="small">{a.action}</code> <span className="muted small">· {a.actorName ?? 'sistema'} · {fmtDateTime(a.occurredAt)}</span></li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      {editing && <CompanyModal company={c} onClose={() => { setEditing(false); void refresh(); }} />}
      {contract && <ContractModal companyId={c.id} contract={contract === 'new' ? null : contract} onClose={() => setContract(null)} onSaved={refresh} />}
      {removing && (
        <ConfirmDialog title="Excluir contrato" danger message={<>Excluir o contrato <strong>{removing.plan}</strong>{removing.file ? ' e o arquivo anexado' : ''}? Para manter o histórico, prefira marcar como encerrado.</>}
          confirmLabel="Excluir" onConfirm={removeContract} onCancel={() => setRemoving(null)} />
      )}
    </>
  );
}

const centsToInput = (c: number | null) => (c == null ? '' : (c / 100).toFixed(2).replace('.', ','));

function ContractModal({ companyId, contract, onClose, onSaved }: { companyId: string; contract: Contract | null; onClose: () => void; onSaved: () => Promise<unknown> }) {
  const toast = useToast();
  const staff = useQuery({ queryKey: ['users-alpha-active'], queryFn: () => api.get<Page<UserRow>>('/api/users?pageSize=100&active=true') });
  const [plan, setPlan] = useState(contract?.plan ?? '');
  const [modality, setModality] = useState<ContractModality>(contract?.modality ?? 'mensalidade');
  const [amount, setAmount] = useState(centsToInput(contract?.amountCents ?? null));
  const [startDate, setStartDate] = useState(contract?.startDate ?? new Date().toISOString().slice(0, 10));
  const [endDate, setEndDate] = useState(contract?.endDate ?? '');
  const [status, setStatus] = useState<ContractStatus>(contract?.status ?? 'ativo');
  const [ownerId, setOwnerId] = useState(contract?.ownerId ?? '');
  const [notes, setNotes] = useState(contract?.notes ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [current, setCurrent] = useState(contract?.file ?? null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const cents = amount.trim() ? parseMoneyToCents(amount) : null;

  const save = async () => {
    if (amount.trim() && cents === null) return setErrors({ amountCents: 'Valor inválido.' });
    setBusy(true);
    setErrors({});
    try {
      const body = { plan, modality, amountCents: cents, startDate, endDate: endDate || null, status, ownerId: ownerId || null, notes: notes || null };
      let id = contract?.id;
      if (contract) await api.patch(`/api/contracts/${contract.id}`, { ...body, expectedVersion: contract.version });
      else id = (await api.post<{ id: string }>('/api/contracts', { ...body, companyId })).id;
      if (file && id) await uploadBillingFile(`/api/contracts/${id}/file`, file);
      toast.success('Contrato salvo.');
      await onSaved();
      onClose();
    } catch (e) {
      setErrors(fieldErrors(e));
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={contract ? 'Editar contrato' : 'Novo contrato'} size="lg" onClose={onClose}
      footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" onClick={save} loading={busy} disabled={plan.trim().length < 2 || !startDate}>Salvar</Button></>}>
      <div className="stack">
        <TextField label="Plano" value={plan} onChange={(e) => setPlan(e.target.value)} maxLength={120} required error={errors.plan}
          placeholder="Ex.: Recrutamento contínuo — até 5 vagas/mês" />
        <div className="grid grid-3">
          <SelectField label="Modalidade" value={modality} onChange={(e) => setModality(e.target.value as ContractModality)}>
            {Object.entries(modalityLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </SelectField>
          <TextField label="Valor (R$)" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="4.500,00"
            hint="Opcional." error={errors.amountCents} />
          <SelectField label="Situação" value={status} onChange={(e) => setStatus(e.target.value as ContractStatus)}>
            {Object.entries(contractStatusLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </SelectField>
        </div>
        <div className="grid grid-3">
          <TextField label="Início da vigência" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required error={errors.startDate} />
          <TextField label="Fim da vigência" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} min={startDate}
            hint="Vazio = prazo indeterminado." error={errors.endDate} />
          <SelectField label="Responsável na Alpha" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
            <option value="">—</option>
            {staff.data?.items.filter((u) => u.kind === 'alpha_admin' || u.kind === 'alpha_staff').map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
          </SelectField>
        </div>
        <TextArea label="Observações internas" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} rows={3}
          hint="Não aparecem para a empresa." error={errors.notes} />
        {current && (
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span><strong>Arquivo atual:</strong> <BillingFileLink file={current} label={current.name} /></span>
            <Button size="sm" variant="danger" loading={busy} onClick={async () => {
              try {
                await api.delete(`/api/billing/files/${current.id}`);
                setCurrent(null);
                await onSaved();
              } catch (e) {
                toast.error(e);
              }
            }}>Remover arquivo</Button>
          </div>
        )}
        <BillingFilePicker id="contrato-arquivo" kind="contrato" file={file} onChange={setFile} />
        {current && file && <span className="muted small">O arquivo atual será substituído ao salvar.</span>}
      </div>
    </Modal>
  );
}
