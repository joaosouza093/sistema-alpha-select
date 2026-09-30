import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, qs } from '../../api/client';
import type { AuditRow, Page } from '../../api/types';
import { Empty, ErrorState, Loading, PageHeader, Pagination, SelectField, usePageTitle } from '../../components/ui';
import { fmtDateTime } from '../../lib/format';

const groups: Record<string, string> = {
  '': 'Todas',
  'auth.': 'Autenticação',
  'user.': 'Usuários',
  'company.': 'Empresas',
  'process.': 'Processos e vínculos',
  'candidate.': 'Candidatos',
  'application.': 'Participações',
  'document.': 'Documentos',
  'comment.': 'Comentários',
};

export function AuditPage() {
  usePageTitle('Auditoria');
  const [action, setAction] = useState('');
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: ['audit', action, page],
    queryFn: () => api.get<Page<AuditRow>>(`/api/audit${qs({ action, page, pageSize: 50 })}`),
    placeholderData: (p) => p,
  });
  return (
    <>
      <PageHeader title="Auditoria" subtitle="Registro somente leitura de acessos e alterações. Não contém senhas, tokens nem conteúdo de documentos." />
      <section className="card">
        <div className="card-header">
          <div style={{ minWidth: 240 }}>
            <SelectField label="Categoria" value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }}>
              {Object.entries(groups).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </SelectField>
          </div>
        </div>
        {list.isLoading ? <Loading /> : list.isError ? <ErrorState error={list.error} /> : list.data!.items.length === 0 ? <Empty title="Nenhum evento" /> : (
          <>
            <div className="table-wrap">
              <table className="table responsive">
                <thead><tr><th>Quando</th><th>Ação</th><th>Usuário</th><th>Registro</th><th>Empresa</th><th>Detalhes</th><th>IP</th></tr></thead>
                <tbody>
                  {list.data!.items.map((e) => (
                    <tr key={e.id}>
                      <td data-label="Quando" className="nowrap">{fmtDateTime(e.occurredAt)}</td>
                      <td data-label="Ação"><code>{e.action}</code></td>
                      <td data-label="Usuário">{e.actorName ?? '—'}</td>
                      <td data-label="Registro" className="small">{e.entityType ? `${e.entityType} ${e.entityId?.slice(0, 8) ?? ''}` : '—'}</td>
                      <td data-label="Empresa">{e.companyName ?? '—'}</td>
                      <td data-label="Detalhes" className="small"><code>{Object.keys(e.details).length ? JSON.stringify(e.details) : ''}</code></td>
                      <td data-label="IP" className="small">{e.ip ?? '—'}</td>
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
