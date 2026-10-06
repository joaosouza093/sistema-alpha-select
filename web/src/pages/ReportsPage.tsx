import { useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, qs } from '../api/client';
import type { Company, Page, ProcessRow, Report, ReportMetrics } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Button, Empty, ErrorState, Loading, PageHeader, SelectField, TextField, usePageTitle } from '../components/ui';
import { fmtCents, fmtDay, reasonLabel, templateLabel } from '../lib/format';

// ----------------------------------------------------------------- datas

const tz = 'America/Sao_Paulo';
const isoDay = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
const daysAgo = (n: number) => isoDay(new Date(Date.now() - n * 86_400_000));
const presets = [
  { key: '30', label: 'Últimos 30 dias', from: () => daysAgo(29) },
  { key: '90', label: 'Últimos 90 dias', from: () => daysAgo(89) },
  { key: 'ano', label: 'Este ano', from: () => `${isoDay(new Date()).slice(0, 4)}-01-01` },
  { key: '12m', label: 'Últimos 12 meses', from: () => daysAgo(364) },
];

// ----------------------------------------------------------------- formatação

const pct = (n: number, d: number) => (d > 0 ? `${((n / d) * 100).toFixed(1).replace('.', ',')}%` : '—');
const days = (v: number | null) => (v == null ? '—' : `${String(v).replace('.', ',')} dia(s)`);
const monthLabel = (ym: string) => {
  const [y, m] = ym.split('-');
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('pt-BR', { month: 'short', year: 'numeric' });
};
const sourceLabel = { interno: 'Cadastro interno', portal: 'Portal de vagas' } as const;

// ----------------------------------------------------------------- tabela + CSV

interface Col<T> {
  label: string;
  value: (r: T) => string | number | null;
  render?: (r: T) => ReactNode;
}

function csvCell(v: string | number | null) {
  if (v == null) return '';
  const s = typeof v === 'number' ? String(v).replace('.', ',') : v;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV com ";" e BOM, como o Excel em português espera. */
function toCsv<T>(cols: Col<T>[], rows: T[]) {
  return [cols.map((c) => csvCell(c.label)).join(';'), ...rows.map((r) => cols.map((c) => csvCell(c.value(r))).join(';'))].join('\r\n');
}

function download(name: string, content: string) {
  const blob = new Blob(['﻿', content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

interface Section<T> {
  key: string;
  title: string;
  note?: string;
  cols: Col<T>[];
  rows: T[];
}

function ReportTable<T>({ s, fileSuffix }: { s: Section<T>; fileSuffix: string }) {
  return (
    <section className="card report-section">
      <div className="card-header">
        <div>
          <h2>{s.title}</h2>
          {s.note && <span className="muted small">{s.note}</span>}
        </div>
        {s.rows.length > 0 && (
          <Button size="sm" className="no-print" onClick={() => download(`relatorio-${s.key}-${fileSuffix}.csv`, toCsv(s.cols, s.rows))}>
            Baixar CSV
          </Button>
        )}
      </div>
      {s.rows.length === 0 ? (
        <Empty title="Sem dados no período" />
      ) : (
        <div className="table-wrap">
          <table className="table responsive">
            <thead>
              <tr>{s.cols.map((c) => <th key={c.label}>{c.label}</th>)}</tr>
            </thead>
            <tbody>
              {s.rows.map((r, i) => (
                <tr key={i}>
                  {s.cols.map((c) => (
                    <td key={c.label} data-label={c.label}>{c.render ? c.render(r) : (c.value(r) ?? '—')}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Colunas comuns às visões por empresa, processo, origem e mês. */
function metricCols<T extends ReportMetrics>(): Col<T>[] {
  return [
    { label: 'Candidaturas', value: (r) => r.applications },
    { label: 'Triados', value: (r) => r.screened },
    { label: 'Aprovados na triagem', value: (r) => r.approvedInternal },
    { label: 'Enviados', value: (r) => r.sent },
    { label: 'Aguardando retorno', value: (r) => r.awaitingFeedback },
    { label: 'Aprovados pelo cliente', value: (r) => r.hired },
    { label: 'Não aprovados/desistências', value: (r) => r.rejectedClient },
    { label: 'Aprovação sobre enviados', value: (r) => pct(r.hired, r.sent) },
    { label: 'Dias até o envio (média)', value: (r) => r.avgDaysToSend, render: (r) => days(r.avgDaysToSend) },
    { label: 'Dias de retorno do cliente (média)', value: (r) => r.avgResponseDays, render: (r) => days(r.avgResponseDays) },
  ];
}

// ----------------------------------------------------------------- página

export function ReportsPage() {
  usePageTitle('Relatórios');
  const { isAdmin } = useAuth();
  const [from, setFrom] = useState(presets[1]!.from());
  const [to, setTo] = useState(daysAgo(0));
  const [companyId, setCompanyId] = useState('');
  const [processId, setProcessId] = useState('');

  const companies = useQuery({ queryKey: ['companies'], queryFn: () => api.get<{ items: Company[] }>('/api/companies') });
  const processes = useQuery({
    queryKey: ['processes', 'report-filter', companyId],
    queryFn: () => api.get<Page<ProcessRow>>(`/api/processes${qs({ companyId, pageSize: 100 })}`),
  });
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;
  const q = useQuery({
    queryKey: ['reports', from, to, companyId, processId],
    queryFn: () => api.get<Report>(`/api/reports${qs({ from, to, companyId, processId })}`),
    enabled: valid,
    placeholderData: (prev) => prev,
  });

  const sections = useMemo(() => {
    const d = q.data;
    if (!d) return [];
    const list: Section<any>[] = [
      {
        key: 'empresas', title: 'Por empresa cliente', cols: [{ label: 'Empresa', value: (r: Report['byCompany'][number]) => r.name }, ...metricCols()], rows: d.byCompany,
      },
      {
        key: 'processos', title: 'Por processo / vaga',
        cols: [
          { label: 'Processo', value: (r: Report['byProcess'][number]) => r.name },
          { label: 'Empresa', value: (r: Report['byProcess'][number]) => r.companyName },
          ...metricCols(),
        ],
        rows: d.byProcess,
      },
      {
        key: 'origem', title: 'Por origem', note: 'de onde vêm os candidatos',
        cols: [{ label: 'Origem', value: (r: Report['bySource'][number]) => sourceLabel[r.id] ?? r.id }, ...metricCols()], rows: d.bySource,
      },
      {
        key: 'meses', title: 'Por mês', note: 'mês em que a participação foi criada',
        cols: [{ label: 'Mês', value: (r: Report['byMonth'][number]) => monthLabel(r.id) }, ...metricCols()], rows: d.byMonth,
      },
      {
        key: 'recrutadores', title: 'Produtividade por recrutador', note: 'quem registrou a triagem e quem enviou ao cliente',
        cols: [
          { label: 'Recrutador', value: (r: Report['byRecruiter'][number]) => r.name },
          { label: 'Triagens registradas', value: (r: Report['byRecruiter'][number]) => r.screened },
          { label: 'Enviados ao cliente', value: (r: Report['byRecruiter'][number]) => r.sent },
          { label: 'Aprovados pelo cliente', value: (r: Report['byRecruiter'][number]) => r.hired },
          { label: 'Aprovação sobre enviados', value: (r: Report['byRecruiter'][number]) => pct(r.hired, r.sent) },
          { label: 'Dias até o envio (média)', value: (r: Report['byRecruiter'][number]) => r.avgDaysToSend, render: (r: Report['byRecruiter'][number]) => days(r.avgDaysToSend) },
        ],
        rows: d.byRecruiter,
      },
      {
        key: 'motivos-triagem', title: 'Motivos de reprovação na triagem',
        cols: [
          { label: 'Motivo', value: (r: Report['triageReasons'][number]) => reasonLabel[r.reason] ?? r.reason },
          { label: 'Quantidade', value: (r: Report['triageReasons'][number]) => r.count },
          { label: '% do total', value: (r: Report['triageReasons'][number]) => pct(r.count, d.summary.rejectedInternal) },
        ],
        rows: d.triageReasons,
      },
      {
        key: 'motivos-cliente', title: 'Motivos de recusa pelo cliente', note: 'não aprovados e desistências',
        cols: [
          { label: 'Motivo', value: (r: Report['clientReasons'][number]) => reasonLabel[r.reason] ?? r.reason },
          { label: 'Quantidade', value: (r: Report['clientReasons'][number]) => r.count },
          { label: '% do total', value: (r: Report['clientReasons'][number]) => pct(r.count, d.summary.rejectedClient) },
        ],
        rows: d.clientReasons,
      },
    ];
    if (d.messages) {
      list.push({
        key: 'mensagens', title: 'Mensagens ao candidato', note: `e-mails enviados no período · ${d.messages.optOuts} descadastro(s)`,
        cols: [
          { label: 'Modelo', value: (r: NonNullable<Report['messages']>['byTemplate'][number]) => templateLabel[r.id as keyof typeof templateLabel] ?? r.id },
          { label: 'Enviados', value: (r: NonNullable<Report['messages']>['byTemplate'][number]) => r.total },
          { label: 'Entregues ao servidor', value: (r: NonNullable<Report['messages']>['byTemplate'][number]) => r.delivered },
          { label: 'Falhas', value: (r: NonNullable<Report['messages']>['byTemplate'][number]) => r.failed },
        ],
        rows: d.messages.byTemplate,
      });
    }
    if (d.finance) {
      type F = NonNullable<Report['finance']>['byCompany'][number];
      list.push({
        key: 'financeiro', title: 'Financeiro por empresa', note: 'cobranças com vencimento no período (canceladas não entram)',
        cols: [
          { label: 'Empresa', value: (r: F) => r.name },
          { label: 'Emitido', value: (r: F) => r.billedCents / 100, render: (r: F) => fmtCents(r.billedCents) },
          { label: 'Recebido', value: (r: F) => r.paidCents / 100, render: (r: F) => fmtCents(r.paidCents) },
          { label: 'Vencido em aberto', value: (r: F) => r.overdueCents / 100, render: (r: F) => fmtCents(r.overdueCents) },
          { label: 'A vencer', value: (r: F) => r.openCents / 100, render: (r: F) => fmtCents(r.openCents) },
          { label: 'Adimplência', value: (r: F) => pct(r.paidCents, r.paidCents + r.overdueCents) },
          { label: 'Atraso médio no pagamento', value: (r: F) => r.avgPayDelayDays, render: (r: F) => days(r.avgPayDelayDays) },
        ],
        rows: d.finance.byCompany,
      });
    }
    return list;
  }, [q.data]);

  const fileSuffix = `${from}_a_${to}`;
  const exportAll = () => {
    const parts = sections.filter((s) => s.rows.length).map((s) => `${s.title}\r\n${toCsv(s.cols, s.rows)}`);
    download(`relatorio-completo-${fileSuffix}.csv`, [`Período;${fmtDay(from)} a ${fmtDay(to)}`, ...parts].join('\r\n\r\n'));
  };

  const s = q.data?.summary;
  const companyName = companies.data?.items.find((c) => c.id === companyId)?.name;
  const processName = processes.data?.items.find((p) => p.id === processId)?.title;

  return (
    <>
      <PageHeader
        title="Relatórios"
        subtitle="Indicadores de captação, triagem, entrega, retorno do cliente e financeiro."
        actions={
          <div className="row no-print">
            <Button onClick={exportAll} disabled={!q.data}>Baixar tudo (CSV)</Button>
            <Button onClick={() => window.print()} disabled={!q.data}>Imprimir / salvar PDF</Button>
          </div>
        }
      />

      <section className="card no-print" aria-label="Filtros">
        <div className="card-body stack">
          <div className="row" role="group" aria-label="Períodos rápidos">
            {presets.map((p) => (
              <Button key={p.key} size="sm" onClick={() => { setFrom(p.from()); setTo(daysAgo(0)); }}>{p.label}</Button>
            ))}
          </div>
          <div className="filters report-filters">
            <TextField label="De" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
            <TextField label="Até" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
            <SelectField label="Empresa" value={companyId} onChange={(e) => { setCompanyId(e.target.value); setProcessId(''); }}>
              <option value="">Todas</option>
              {companies.data?.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </SelectField>
            <SelectField label="Processo" value={processId} onChange={(e) => setProcessId(e.target.value)}>
              <option value="">Todos</option>
              {processes.data?.items.map((p) => <option key={p.id} value={p.id}>{p.title}{companyId ? '' : ` — ${p.companyName}`}</option>)}
            </SelectField>
          </div>
          {!valid && <span className="error" role="alert">Informe um período válido (a data inicial deve vir antes da final).</span>}
        </div>
      </section>

      <p className="print-only">
        Período: {fmtDay(from)} a {fmtDay(to)}
        {companyName && ` · Empresa: ${companyName}`}
        {processName && ` · Processo: ${processName}`}
      </p>

      {q.isLoading ? (
        <Loading />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : s ? (
        <div className="stack" style={{ marginTop: 16 }} aria-busy={q.isFetching || undefined}>
          <p className="muted small">
            Base: participações criadas entre {fmtDay(from)} e {fmtDay(to)}{isAdmin ? '' : ', nos processos aos quais você tem acesso'}.
            Cada número pode ser conferido nas telas de processos e candidatos com os mesmos filtros.
          </p>
          <section className="grid grid-4" aria-label="Resumo">
            <Stat label="Candidaturas" value={s.applications} />
            <Stat label="Enviados aos clientes" value={s.sent} hint={`${pct(s.sent, s.applications)} das candidaturas`} />
            <Stat label="Aprovados pelo cliente" value={s.hired} hint={`${pct(s.hired, s.sent)} dos enviados`} />
            <Stat label="Aguardando retorno" value={s.awaitingFeedback} />
            <Stat label="Triados" value={s.screened} hint={`${s.approvedInternal} aprovados · ${s.rejectedInternal} reprovados`} />
            <Stat label="Não aprovados / desistências" value={s.rejectedClient} />
            <Stat label="Dias até o envio (média)" value={days(s.avgDaysToSend)} />
            <Stat label="Retorno do cliente (média)" value={days(s.avgResponseDays)} />
          </section>

          {q.data!.finance && (
            <section className="grid grid-4" aria-label="Resumo financeiro">
              <Stat label="Emitido no período" value={fmtCents(q.data!.finance.totals.billedCents)} />
              <Stat label="Recebido" value={fmtCents(q.data!.finance.totals.paidCents)} />
              <Stat label="Vencido em aberto" value={fmtCents(q.data!.finance.totals.overdueCents)} />
              <Stat
                label="Adimplência"
                value={q.data!.finance.totals.complianceRate == null ? '—' : `${String(q.data!.finance.totals.complianceRate).replace('.', ',')}%`}
                hint="recebido sobre o que já venceu"
              />
            </section>
          )}

          <Funnel s={s} />

          {sections.map((sec) => <ReportTable key={sec.key} s={sec} fileSuffix={fileSuffix} />)}
        </div>
      ) : null}
    </>
  );
}

function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="card stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {hint && <div className="muted small">{hint}</div>}
    </div>
  );
}

function Funnel({ s }: { s: ReportMetrics }) {
  const steps = [
    { label: 'Candidaturas', n: s.applications },
    { label: 'Triados', n: s.screened },
    { label: 'Aprovados na triagem', n: s.approvedInternal },
    { label: 'Enviados ao cliente', n: s.sent },
    { label: 'Aprovados pelo cliente', n: s.hired },
  ];
  const max = Math.max(1, s.applications);
  return (
    <section className="card report-section">
      <div className="card-header"><h2>Funil de candidatos</h2></div>
      <div className="card-body stack">
        {steps.map((st) => (
          <div key={st.label}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span>{st.label}</span>
              <strong>{st.n} <span className="muted small">({pct(st.n, s.applications)})</span></strong>
            </div>
            <div className="bar" aria-hidden><span style={{ width: `${(st.n / max) * 100}%` }} /></div>
          </div>
        ))}
      </div>
    </section>
  );
}
