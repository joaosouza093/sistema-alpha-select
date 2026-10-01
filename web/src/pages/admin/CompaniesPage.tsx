import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { Company } from '../../api/types';
import { Button, ConfirmDialog, Empty, ErrorState, Loading, Modal, PageHeader, TextField, fieldErrors, usePageTitle, useToast } from '../../components/ui';
import { fmtDate } from '../../lib/format';

export function CompaniesPage() {
  usePageTitle('Empresas clientes');
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ['companies'], queryFn: () => api.get<{ items: Company[] }>('/api/companies') });
  const [editing, setEditing] = useState<Company | 'new' | null>(null);
  const [toggling, setToggling] = useState<Company | null>(null);

  const toggle = async () => {
    if (!toggling) return;
    try {
      await api.patch(`/api/companies/${toggling.id}`, { isActive: !toggling.isActive });
      toast.success(toggling.isActive ? 'Empresa desativada: os acessos dos seus usuários foram revogados.' : 'Empresa reativada.');
      setToggling(null);
      await qc.invalidateQueries({ queryKey: ['companies'] });
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <>
      <PageHeader title="Empresas clientes" subtitle="Empresas atendidas pela Alpha Select. Cada uma só acessa os processos liberados."
        actions={<Button variant="primary" onClick={() => setEditing('new')}>Nova empresa</Button>} />
      <section className="card">
        {list.isLoading ? <Loading /> : list.isError ? <ErrorState error={list.error} /> : list.data!.items.length === 0 ? (
          <Empty title="Nenhuma empresa cadastrada" />
        ) : (
          <div className="table-wrap">
            <table className="table responsive">
              <thead><tr><th>Empresa</th><th>Situação</th><th>Processos</th><th>Usuários ativos</th><th>Desde</th><th className="actions">Ações</th></tr></thead>
              <tbody>
                {list.data!.items.map((c) => (
                  <tr key={c.id}>
                    <td data-label="Empresa"><strong>{c.name}</strong></td>
                    <td data-label="Situação">{c.isActive ? <span className="badge badge-success">Ativa</span> : <span className="badge">Inativa</span>}</td>
                    <td data-label="Processos"><Link to={`/processos?empresa=${c.id}`}>{c.processCount}</Link></td>
                    <td data-label="Usuários ativos"><Link to={`/usuarios?empresa=${c.id}`}>{c.activeUsers}</Link></td>
                    <td data-label="Desde">{fmtDate(c.createdAt)}</td>
                    <td className="actions">
                      <Button size="sm" onClick={() => setEditing(c)}>Renomear</Button>{' '}
                      <Button size="sm" variant={c.isActive ? 'danger' : 'default'} onClick={() => setToggling(c)}>{c.isActive ? 'Desativar' : 'Reativar'}</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {editing && <CompanyModal company={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {toggling && (
        <ConfirmDialog title={toggling.isActive ? 'Desativar empresa' : 'Reativar empresa'} danger={toggling.isActive}
          message={toggling.isActive ? <>Desativar <strong>{toggling.name}</strong>? Todos os usuários desta empresa perdem o acesso imediatamente, inclusive sessões abertas.</> : <>Reativar <strong>{toggling.name}</strong>?</>}
          confirmLabel={toggling.isActive ? 'Desativar' : 'Reativar'} onConfirm={toggle} onCancel={() => setToggling(null)} />
      )}
    </>
  );
}

function CompanyModal({ company, onClose }: { company: Company | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(company?.name ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      if (company) await api.patch(`/api/companies/${company.id}`, { name });
      else await api.post('/api/companies', { name });
      toast.success('Empresa salva.');
      await qc.invalidateQueries({ queryKey: ['companies'] });
      onClose();
    } catch (e) {
      setErrors(fieldErrors(e));
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={company ? 'Renomear empresa' : 'Nova empresa cliente'} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" onClick={save} loading={busy} disabled={name.trim().length < 2}>Salvar</Button></>}>
      <TextField label="Nome da empresa" value={name} onChange={(e) => setName(e.target.value)} error={errors.name} maxLength={160} required />
    </Modal>
  );
}
