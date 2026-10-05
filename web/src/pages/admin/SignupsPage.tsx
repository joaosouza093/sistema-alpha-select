import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qs } from '../../api/client';
import type { Company, SignupRow } from '../../api/types';
import { Alert, Button, Empty, ErrorState, Loading, Modal, PageHeader, SelectField, Tabs, TextArea, usePageTitle, useToast } from '../../components/ui';
import { fmtCnpj, fmtDateTime, fmtPhone } from '../../lib/format';
import { SharedLinkModal, type SharedLink } from './UsersPage';

type Status = SignupRow['status'];

export function SignupsPage() {
  usePageTitle('Cadastros');
  const [status, setStatus] = useState<Status>('pendente');
  const [approving, setApproving] = useState<SignupRow | null>(null);
  const [rejecting, setRejecting] = useState<SignupRow | null>(null);
  const [shared, setShared] = useState<SharedLink | null>(null);
  const list = useQuery({
    queryKey: ['signups', status],
    queryFn: () => api.get<{ items: SignupRow[]; pendingCount: number; emailVerification: boolean }>(`/api/signups${qs({ status })}`),
  });
  const companies = useQuery({ queryKey: ['companies'], queryFn: () => api.get<{ items: Company[] }>('/api/companies') });

  return (
    <>
      <PageHeader title="Cadastros" subtitle="Empresas que se cadastraram pelo site. Nenhum acesso é liberado sem a sua aprovação." />
      <Tabs
        label="Situação dos cadastros"
        value={status}
        onChange={setStatus}
        tabs={[
          { id: 'pendente', label: `Aguardando${list.data && status === 'pendente' ? ` (${list.data.pendingCount})` : ''}` },
          { id: 'aprovado', label: 'Aprovados' },
          { id: 'recusado', label: 'Recusados' },
        ]}
      />
      {list.data && !list.data.emailVerification && status === 'pendente' && (
        <Alert kind="warning">
          O envio de e-mail não está configurado: os e-mails dos cadastros não foram confirmados. Confirme com a empresa por telefone antes
          de aprovar. Ao aprovar, o sistema mostra um link para a pessoa criar a senha.
        </Alert>
      )}
      <section className="card">
        {list.isLoading ? <Loading /> : list.isError ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : list.data!.items.length === 0 ? (
          <Empty title={status === 'pendente' ? 'Nenhum cadastro aguardando' : 'Nada por aqui'} />
        ) : (
          <div className="table-wrap">
            <table className="table responsive">
              <thead>
                <tr><th>Empresa</th><th>Responsável</th><th>Contato</th><th>E-mail confirmado</th><th>{status === 'pendente' ? 'Recebido em' : 'Decidido em'}</th>{status === 'pendente' && <th className="actions">Ações</th>}</tr>
              </thead>
              <tbody>
                {list.data!.items.map((s) => (
                  <tr key={s.id}>
                    <td data-label="Empresa"><strong>{s.companyName}</strong>{s.cnpj && <div className="muted small">CNPJ {fmtCnpj(s.cnpj)}</div>}</td>
                    <td data-label="Responsável">{s.fullName}</td>
                    <td data-label="Contato">{s.email}{s.phone && <div className="muted small">{fmtPhone(s.phone)}</div>}</td>
                    <td data-label="E-mail confirmado">{s.emailVerifiedAt ? <span className="badge badge-success">Sim</span> : <span className="badge badge-warning">Não</span>}</td>
                    <td data-label={status === 'pendente' ? 'Recebido em' : 'Decidido em'}>
                      {fmtDateTime(status === 'pendente' ? s.createdAt : s.decidedAt)}
                      {s.decidedByName && <div className="muted small">por {s.decidedByName}</div>}
                      {s.decisionNote && <div className="muted small">{s.decisionNote}</div>}
                    </td>
                    {status === 'pendente' && (
                      <td className="actions">
                        <Button size="sm" variant="primary" onClick={() => setApproving(s)}
                          disabled={list.data!.emailVerification && !s.emailVerifiedAt}
                          title={list.data!.emailVerification && !s.emailVerifiedAt ? 'Aguardando a pessoa confirmar o e-mail' : undefined}>
                          Aprovar
                        </Button>{' '}
                        <Button size="sm" variant="danger" onClick={() => setRejecting(s)}>Recusar</Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {approving && (
        <ApproveModal signup={approving} companies={companies.data?.items.filter((c) => c.isActive) ?? []}
          onClose={() => setApproving(null)} onLink={setShared} />
      )}
      {rejecting && <RejectModal signup={rejecting} onClose={() => setRejecting(null)} />}
      {shared && <SharedLinkModal data={shared} onClose={() => setShared(null)} />}
    </>
  );
}

function ApproveModal({ signup, companies, onClose, onLink }: { signup: SignupRow; companies: Company[]; onClose: () => void; onLink: (l: SharedLink) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [kind, setKind] = useState<'client_user' | 'client_manager'>('client_manager');
  const [companyId, setCompanyId] = useState(signup.matchingCompanyId ?? '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ inviteLink?: string; validHours?: number }>(`/api/signups/${signup.id}/approve`, { kind, companyId: companyId || null });
      if (r.inviteLink) onLink({ kind: 'convite', name: signup.fullName, link: r.inviteLink, validHours: r.validHours ?? 72 });
      else toast.success('Cadastro aprovado. A pessoa foi avisada por e-mail e já pode entrar.');
      await Promise.all([qc.invalidateQueries({ queryKey: ['signups'] }), qc.invalidateQueries({ queryKey: ['companies'] }), qc.invalidateQueries({ queryKey: ['users'] })]);
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Aprovar cadastro" onClose={onClose}
      footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" onClick={save} loading={busy}>Aprovar</Button></>}>
      <div className="stack">
        <p><strong>{signup.fullName}</strong> ({signup.email}) — {signup.companyName}</p>
        <SelectField label="Empresa" value={companyId} onChange={(e) => setCompanyId(e.target.value)}
          hint={signup.matchingCompanyId ? 'Já existe uma empresa com este nome ou CNPJ.' : undefined}>
          {!signup.matchingCompanyId && <option value="">Criar nova empresa “{signup.companyName}”</option>}
          {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </SelectField>
        <SelectField label="Perfil" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          <option value="client_manager">Gestor/CEO</option>
          <option value="client_user">Cliente/RH Interno</option>
        </SelectField>
        <Alert kind="info">Depois de aprovar, vincule a pessoa aos processos seletivos da empresa para que ela os veja.</Alert>
      </div>
    </Modal>
  );
}

function RejectModal({ signup, onClose }: { signup: SignupRow; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/api/signups/${signup.id}/reject`, { note: note || null });
      toast.success('Cadastro recusado.');
      await qc.invalidateQueries({ queryKey: ['signups'] });
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Recusar cadastro" onClose={onClose}
      footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="danger" onClick={save} loading={busy}>Recusar</Button></>}>
      <div className="stack">
        <p>Recusar o cadastro de <strong>{signup.companyName}</strong>?</p>
        <TextArea label="Observação interna" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={3}
          hint="Opcional. Não é enviada à empresa." />
      </div>
    </Modal>
  );
}
