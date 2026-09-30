import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, qs } from '../../api/client';
import type { Company, Page, ProcessRow, ProcessStatus } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import {
  Button, Empty, ErrorState, Loading, Modal, PageHeader, Pagination, SelectField, StatusBadge, TextArea, TextField,
  fieldErrors, usePageTitle, useToast,
} from '../../components/ui';
import { fmtDate, statusLabel } from '../../lib/format';

function params0(): ProcessStatus | '' {
  return new URLSearchParams(window.location.search).get('empresa') ? '' : 'em_andamento';
}

export function ProcessListPage() {
  usePageTitle('Processos seletivos');
  const { isAdmin, isAlpha } = useAuth();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<ProcessStatus | ''>(params0());
  const [params] = useSearchParams();
  const [companyId, setCompanyId] = useState(params.get('empresa') ?? '');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);

  const companies = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.get<{ items: Company[] }>('/api/companies'),
    enabled: isAlpha,
  });
  const list = useQuery({
    queryKey: ['processes', q, status, companyId, page],
    queryFn: () => api.get<Page<ProcessRow>>(`/api/processes${qs({ q, status, companyId, page, pageSize: 20 })}`),
    placeholderData: (prev) => prev,
  });

  return (
    <>
      <PageHeader
        title="Processos seletivos"
        subtitle={isAlpha ? 'Processos das empresas clientes aos quais você tem acesso.' : 'Processos liberados para você.'}
        actions={isAdmin && <Button variant="primary" onClick={() => setCreating(true)}>Novo processo</Button>}
      />
      <section className="card">
        <div className="card-header">
          <div className="filters" style={{ width: '100%' }}>
            <TextField label="Buscar por título" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} type="search" />
            <SelectField label="Situação" value={status} onChange={(e) => { setStatus(e.target.value as ProcessStatus | ''); setPage(1); }}>
              <option value="">Todas</option>
              {Object.entries(statusLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </SelectField>
            {isAlpha && (
              <SelectField label="Empresa" value={companyId} onChange={(e) => { setCompanyId(e.target.value); setPage(1); }}>
                <option value="">Todas</option>
                {companies.data?.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </SelectField>
            )}
          </div>
        </div>
        {list.isLoading ? <Loading /> : list.isError ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : list.data!.items.length === 0 ? (
          <Empty title="Nenhum processo encontrado">{isAdmin ? 'Crie um processo para uma empresa cliente.' : 'Quando um processo for liberado para você, ele aparecerá aqui.'}</Empty>
        ) : (
          <>
            <div className="table-wrap">
              <table className="table responsive">
                <thead>
                  <tr><th>Processo</th><th>Empresa</th><th>Situação</th><th>Candidatos</th><th>Em avaliação</th><th>Atualizado</th></tr>
                </thead>
                <tbody>
                  {list.data!.items.map((p) => (
                    <tr key={p.id}>
                      <td data-label="Processo"><Link to={`/processos/${p.id}`}><strong>{p.title}</strong></Link></td>
                      <td data-label="Empresa">{p.companyName}</td>
                      <td data-label="Situação"><StatusBadge status={p.status} /></td>
                      <td data-label="Candidatos">{p.candidateCount}</td>
                      <td data-label="Em avaliação">{p.openCount}</td>
                      <td data-label="Atualizado">{fmtDate(p.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={list.data!.page} pageSize={list.data!.pageSize} total={list.data!.total} onPage={setPage} />
          </>
        )}
      </section>
      {creating && <NewProcessModal companies={companies.data?.items.filter((c) => c.isActive) ?? []} onClose={() => setCreating(false)} />}
    </>
  );
}

function NewProcessModal({ companies, onClose }: { companies: Company[]; onClose: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const [params] = useSearchParams();
  const [companyId, setCompanyId] = useState(params.get('empresa') ?? '');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ id: string }>('/api/processes', { companyId, title, description: description || null });
      toast.success('Processo criado. Agora vincule os participantes autorizados.');
      nav(`/processos/${r.id}?aba=participantes`);
    } catch (e) {
      setErrors(fieldErrors(e));
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Novo processo seletivo" onClose={onClose} footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" onClick={submit} loading={busy} disabled={!companyId || title.trim().length < 3}>Criar processo</Button></>}>
      <div className="stack">
        {companies.length === 0 && <p className="alert alert-warning">Cadastre uma empresa cliente ativa antes de criar processos.</p>}
        <SelectField label="Empresa cliente" value={companyId} onChange={(e) => setCompanyId(e.target.value)} error={errors.companyId} required>
          <option value="">Selecione…</option>
          {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </SelectField>
        <TextField label="Título da vaga / processo" value={title} onChange={(e) => setTitle(e.target.value)} error={errors.title} maxLength={160} required />
        <TextArea label="Descrição" value={description} onChange={(e) => setDescription(e.target.value)} error={errors.description} maxLength={5000} />
      </div>
    </Modal>
  );
}
