import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { ClientFinance, Contract } from '../api/types';
import { BillingFileLink } from '../components/BillingFiles';
import { Empty, ErrorState, Loading, PageHeader, usePageTitle } from '../components/ui';
import { contractStatusBadge, contractStatusLabel, fmtCents, fmtDay, modalityLabel } from '../lib/format';
import { SituacaoBadge } from './admin/BillingPage';

/** Financeiro da empresa cliente (gestor): cobranças, boletos, notas fiscais e contratos. */
export function FinancePage() {
  usePageTitle('Financeiro');
  const q = useQuery({ queryKey: ['client-finance'], queryFn: () => api.get<ClientFinance>('/api/client/finance') });
  const d = q.data;
  return (
    <>
      <PageHeader title="Financeiro" subtitle="Cobranças da Alpha Select para a sua empresa, com boleto, nota fiscal e contratos." />
      {q.isLoading ? <Loading /> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : d && (
        <div className="stack">
          <section className="grid grid-2" aria-label="Resumo">
            <div className="card stat">
              <div className="label">Em aberto</div>
              <div className="value">{fmtCents(d.summary.openCents)}</div>
              <div className="muted small">{d.summary.openCount} cobrança(s)</div>
            </div>
            <div className="card stat">
              <div className="label">Vencidas</div>
              <div className="value">{fmtCents(d.summary.overdueCents)}</div>
              <div className="muted small">{d.summary.overdueCount} cobrança(s)</div>
            </div>
          </section>

          <section className="card">
            <div className="card-header"><h2>Cobranças</h2></div>
            {d.charges.length === 0 ? <Empty title="Nenhuma cobrança" /> : (
              <div className="table-wrap">
                <table className="table responsive">
                  <thead><tr><th>Descrição</th><th>Valor</th><th>Vencimento</th><th>Situação</th><th>Documentos</th></tr></thead>
                  <tbody>
                    {d.charges.map((c) => (
                      <tr key={c.id}>
                        <td data-label="Descrição"><strong>{c.description}</strong></td>
                        <td data-label="Valor" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtCents(c.amountCents)}</td>
                        <td data-label="Vencimento">{fmtDay(c.dueDate)}</td>
                        <td data-label="Situação"><SituacaoBadge s={c.situacao} /></td>
                        <td data-label="Documentos">
                          {c.files.length === 0 && !c.paymentLink ? <span className="muted">—</span> : (
                            <span className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
                              {c.files.map((f) => <BillingFileLink key={f.id} file={f} />)}
                              {c.paymentLink && (c.situacao === 'pendente' || c.situacao === 'vencida') && (
                                <a href={c.paymentLink} target="_blank" rel="noopener noreferrer">Pagar online</a>
                              )}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card">
            <div className="card-header"><h2>Contratos</h2></div>
            {d.contracts.length === 0 ? <Empty title="Nenhum contrato cadastrado" /> : <ContractTable items={d.contracts} />}
          </section>
        </div>
      )}
    </>
  );
}

export function ContractTable({ items, actions }: { items: Contract[]; actions?: (c: Contract) => ReactNode }) {
  return (
    <div className="table-wrap">
      <table className="table responsive">
        <thead>
          <tr>
            <th>Plano</th><th>Modalidade</th><th>Valor</th><th>Vigência</th><th>Situação</th><th>Arquivo</th>
            {actions && <th className="actions">Ações</th>}
          </tr>
        </thead>
        <tbody>
          {items.map((k) => (
            <tr key={k.id}>
              <td data-label="Plano">
                <strong>{k.plan}</strong>
                {k.ownerName && <div className="muted small">Responsável: {k.ownerName}</div>}
                {k.notes && <div className="muted small" style={{ whiteSpace: 'pre-wrap' }}>{k.notes}</div>}
              </td>
              <td data-label="Modalidade">{modalityLabel[k.modality]}</td>
              <td data-label="Valor">{k.amountCents ? fmtCents(k.amountCents) : '—'}</td>
              <td data-label="Vigência" className="nowrap">{fmtDay(k.startDate)} a {k.endDate ? fmtDay(k.endDate) : 'indeterminado'}</td>
              <td data-label="Situação"><span className={`badge ${contractStatusBadge[k.status]}`}>{contractStatusLabel[k.status]}</span></td>
              <td data-label="Arquivo">{k.file ? <BillingFileLink file={k.file} label={k.file.name} /> : <span className="muted">—</span>}</td>
              {actions && <td className="actions">{actions(k)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
