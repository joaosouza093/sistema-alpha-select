import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Dashboard } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Empty, ErrorState, Loading, PageHeader, usePageTitle } from '../components/ui';
import { daysSince, decisionLabel, fmtDateTime } from '../lib/format';

function describe(r: Dashboard['recent'][number]) {
  if (r.event === 'created') return 'incluído(a) no processo';
  const parts: string[] = [];
  if (r.fromStage !== r.toStage) parts.push(`${r.fromStage} → ${r.toStage}`);
  if (r.fromDecision !== r.toDecision && r.toDecision) parts.push(`decisão: ${decisionLabel[r.toDecision]}`);
  return parts.join(' · ') || 'responsável alterado';
}

export function DashboardPage() {
  usePageTitle('Painel');
  const { user, isAlpha, isAdmin } = useAuth();
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => api.get<Dashboard>('/api/dashboard') });

  return (
    <>
      <PageHeader
        title={`Olá, ${user?.fullName.split(' ')[0] ?? ''}`}
        subtitle="Resumo dos processos aos quais você tem acesso."
        actions={
          <>
            <Link to="/processos" className="btn">
              Ver processos
            </Link>
            {isAlpha && (
              <Link to="/candidatos/novo" className="btn btn-primary">
                Cadastrar candidato
              </Link>
            )}
          </>
        }
      />
      {q.isLoading ? (
        <Loading />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <div className="stack">
          <section className="grid grid-3" aria-label="Indicadores">
            <div className="card stat">
              <div className="label">Processos em andamento</div>
              <div className="value">{q.data!.totals.activeProcesses}</div>
            </div>
            <div className="card stat">
              <div className="label">Candidatos nos processos ativos</div>
              <div className="value">{q.data!.totals.candidates}</div>
            </div>
            <div className="card stat">
              <div className="label">Participações em avaliação</div>
              <div className="value">{q.data!.totals.openApplications}</div>
            </div>
          </section>
          {q.data!.leads && (
            <section className="grid grid-3" aria-label="Envio de candidatos">
              {isAlpha && (
                <div className="card stat">
                  <div className="label">Em triagem (ainda não enviados)</div>
                  <div className="value">{q.data!.leads.inTriage}</div>
                </div>
              )}
              <div className="card stat">
                <div className="label">{isAlpha ? 'Enviados aos clientes (30 dias)' : 'Candidatos recebidos (30 dias)'}</div>
                <div className="value">{q.data!.leads.sentLast30}</div>
              </div>
              <div className="card stat">
                <div className="label">{isAlpha ? 'Aguardando retorno além do prazo' : 'Aguardando seu retorno além do prazo'}</div>
                <div className="value">{q.data!.leads.overdue}</div>
              </div>
            </section>
          )}

          <div className="grid grid-2">
            <section className="card">
              <div className="card-header">
                <h2>Distribuição por etapa</h2>
                <span className="muted small">em avaliação</span>
              </div>
              <div className="card-body stack">
                {q.data!.byStage.map((s) => {
                  const max = Math.max(1, ...q.data!.byStage.map((x) => x.count));
                  return (
                    <div key={s.stageId}>
                      <div className="row" style={{ justifyContent: 'space-between' }}>
                        <span>{s.name}</span>
                        <strong>{s.count}</strong>
                      </div>
                      <div className="bar" aria-hidden>
                        <span style={{ width: `${(s.count / max) * 100}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="card">
              <div className="card-header">
                <h2>Minhas pendências</h2>
                <span className="muted small">sob minha responsabilidade</span>
              </div>
              {q.data!.myPending.length === 0 ? (
                <Empty title="Nenhuma pendência">Você não é responsável por nenhuma participação em avaliação.</Empty>
              ) : (
                <ul className="card-body stack" style={{ listStyle: 'none', margin: 0 }}>
                  {q.data!.myPending.map((p) => (
                    <li key={p.id}>
                      <Link to={`/participacoes/${p.id}`}>
                        <strong>{p.candidateName}</strong>
                      </Link>
                      <div className="muted small">
                        {p.processTitle} · {p.stageName} · {daysSince(p.stageChangedAt)}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <section className="card">
            <div className="card-header">
              <h2>Movimentações recentes</h2>
            </div>
            {q.data!.recent.length === 0 ? (
              <Empty title="Sem movimentações">As movimentações dos seus processos aparecerão aqui.</Empty>
            ) : (
              <div className="table-wrap">
                <table className="table responsive">
                  <thead>
                    <tr>
                      <th>Quando</th>
                      <th>Candidato</th>
                      <th>Processo</th>
                      <th>Movimentação</th>
                      <th>Por</th>
                    </tr>
                  </thead>
                  <tbody>
                    {q.data!.recent.map((r) => (
                      <tr key={r.id}>
                        <td data-label="Quando" className="nowrap">{fmtDateTime(r.createdAt)}</td>
                        <td data-label="Candidato">
                          <Link to={`/participacoes/${r.applicationId}`}>{r.candidateName}</Link>
                        </td>
                        <td data-label="Processo">{r.processTitle}</td>
                        <td data-label="Movimentação">{describe(r)}</td>
                        <td data-label="Por">{r.actorName ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {isAdmin && (
            <section className="row">
              <Link to="/clientes" className="btn">Empresas clientes</Link>
              <Link to="/usuarios" className="btn">Usuários e convites</Link>
              <Link to="/auditoria" className="btn">Auditoria</Link>
            </section>
          )}
        </div>
      )}
    </>
  );
}
