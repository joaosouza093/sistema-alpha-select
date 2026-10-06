import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, qs } from '../../api/client';
import type { CandidateRow, Decision, Page, ProcessRow, Stage, UserRow } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { Empty, ErrorState, Loading, PageHeader, Pagination, SelectField, TextField, usePageTitle } from '../../components/ui';
import { decisionLabel, fmtDate, fmtPhone } from '../../lib/format';

function useDebounced<T>(v: T, ms = 300) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

export function CandidateListPage() {
  usePageTitle('Candidatos');
  const { isAdmin } = useAuth();
  const [q, setQ] = useState('');
  const [processId, setProcessId] = useState('');
  const [stageId, setStageId] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [decision, setDecision] = useState<Decision | ''>('');
  const [archived, setArchived] = useState('false');
  const [page, setPage] = useState(1);
  const dq = useDebounced(q);

  const processes = useQuery({ queryKey: ['processes-all'], queryFn: () => api.get<Page<ProcessRow>>('/api/processes?pageSize=100') });
  const stages = useQuery({ queryKey: ['stages'], queryFn: () => api.get<{ items: Stage[] }>('/api/stages'), staleTime: Infinity });
  const users = useQuery({ queryKey: ['users-owner-filter'], queryFn: () => api.get<Page<UserRow>>('/api/users?pageSize=100&active=true') });
  const list = useQuery({
    queryKey: ['candidates', dq, processId, stageId, ownerId, decision, archived, page],
    queryFn: () => api.get<Page<CandidateRow>>(`/api/candidates${qs({ q: dq, processId, stageId, ownerId, decision, archived, page, pageSize: 20 })}`),
    placeholderData: (p) => p,
  });
  const reset = <T,>(fn: (v: T) => void) => (v: T) => { fn(v); setPage(1); };

  return (
    <>
      <PageHeader title="Candidatos" subtitle="Cadastro interno da Alpha Select (não visível aos clientes)."
        actions={<>{isAdmin && <Link to="/candidatos/importar" className="btn">Importar planilha</Link>}<Link to="/candidatos/novo" className="btn btn-primary">Cadastrar candidato</Link></>} />
      <section className="card">
        <div className="card-header">
          <div className="filters" style={{ width: '100%' }}>
            <TextField label="Buscar (nome, e-mail ou telefone)" type="search" value={q} onChange={(e) => reset(setQ)(e.target.value)} />
            <SelectField label="Processo" value={processId} onChange={(e) => reset(setProcessId)(e.target.value)}>
              <option value="">Todos</option>
              {processes.data?.items.map((p) => <option key={p.id} value={p.id}>{p.title} — {p.companyName}</option>)}
            </SelectField>
            <SelectField label="Etapa" value={stageId} onChange={(e) => reset(setStageId)(e.target.value)}>
              <option value="">Todas</option>
              {stages.data?.items.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </SelectField>
            <SelectField label="Responsável" value={ownerId} onChange={(e) => reset(setOwnerId)(e.target.value)}>
              <option value="">Todos</option>
              {users.data?.items.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
            </SelectField>
            <SelectField label="Decisão" value={decision} onChange={(e) => reset(setDecision)(e.target.value as Decision | '')}>
              <option value="">Todas</option>
              {Object.entries(decisionLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </SelectField>
          </div>
          <SelectField label="Cadastros" value={archived} onChange={(e) => reset(setArchived)(e.target.value)}>
            <option value="false">Ativos</option>
            <option value="true">Arquivados</option>
          </SelectField>
        </div>
        {list.isLoading ? <Loading /> : list.isError ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : list.data!.items.length === 0 ? (
          <Empty title="Nenhum candidato encontrado">Ajuste os filtros ou cadastre um novo candidato.</Empty>
        ) : (
          <>
            <div className="table-wrap">
              <table className="table responsive">
                <thead><tr><th>Nome</th><th>E-mail</th><th>Telefone</th><th>Processos</th><th>Documentos</th><th>Atualizado</th></tr></thead>
                <tbody>
                  {list.data!.items.map((c) => (
                    <tr key={c.id}>
                      <td data-label="Nome"><Link to={`/candidatos/${c.id}`}><strong>{c.fullName}</strong></Link></td>
                      <td data-label="E-mail">{c.email ?? '—'}</td>
                      <td data-label="Telefone" className="nowrap">{fmtPhone(c.phone)}</td>
                      <td data-label="Processos">{c.applicationCount}</td>
                      <td data-label="Documentos">{c.documentCount}</td>
                      <td data-label="Atualizado">{fmtDate(c.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={list.data!.page} pageSize={list.data!.pageSize} total={list.data!.total} onPage={setPage} />
          </>
        )}
      </section>
    </>
  );
}
