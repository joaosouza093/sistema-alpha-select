import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qs } from '../../api/client';
import type { Company, Page, UserKind, UserRow } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import {
  Button, ConfirmDialog, Empty, ErrorState, Loading, Modal, PageHeader, Pagination, SelectField, TextField, fieldErrors,
  usePageTitle, useToast,
} from '../../components/ui';
import { fmtDateTime, kindLabel } from '../../lib/format';

const accessLabel = { senha_definida: 'Acesso ativo', convite_pendente: 'Convite pendente', sem_convite_valido: 'Convite expirado' } as const;

export function UsersPage() {
  usePageTitle('Usuários e convites');
  const { user: me } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [params] = useSearchParams();
  const [q, setQ] = useState('');
  const [companyId, setCompanyId] = useState(params.get('empresa') ?? '');
  const [kind, setKind] = useState<UserKind | ''>('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<UserRow | 'new' | null>(null);
  const [toggling, setToggling] = useState<UserRow | null>(null);

  const companies = useQuery({ queryKey: ['companies'], queryFn: () => api.get<{ items: Company[] }>('/api/companies') });
  const list = useQuery({
    queryKey: ['users', q, companyId, kind, page],
    queryFn: () => api.get<Page<UserRow>>(`/api/users${qs({ q, companyId, kind, page, pageSize: 20 })}`),
    placeholderData: (p) => p,
  });

  const [shared, setShared] = useState<SharedLink | null>(null);

  const resend = async (u: UserRow) => {
    try {
      const r = await api.post<{ inviteLink?: string; validHours?: number }>(`/api/users/${u.id}/invite`);
      if (r.inviteLink) setShared({ kind: 'convite', name: u.fullName, link: r.inviteLink, validHours: r.validHours ?? 72 });
      else toast.success('Novo convite enviado. O convite anterior foi invalidado.');
      await qc.invalidateQueries({ queryKey: ['users'] });
    } catch (e) {
      toast.error(e);
    }
  };
  const resetLink = async (u: UserRow) => {
    try {
      const r = await api.post<{ link: string; validHours: number }>(`/api/users/${u.id}/password-reset-link`);
      setShared({ kind: 'redefinicao', name: u.fullName, link: r.link, validHours: r.validHours });
    } catch (e) {
      toast.error(e);
    }
  };

  const toggle = async () => {
    if (!toggling) return;
    try {
      await api.patch(`/api/users/${toggling.id}`, { isActive: !toggling.isActive });
      toast.success(toggling.isActive ? 'Usuário desativado. Sessões abertas foram encerradas.' : 'Usuário reativado.');
      setToggling(null);
      await qc.invalidateQueries({ queryKey: ['users'] });
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <>
      <PageHeader title="Usuários e convites" subtitle="Não há cadastro público: todo acesso é criado aqui e ativado por convite de uso único."
        actions={<Button variant="primary" onClick={() => setEditing('new')}>Convidar usuário</Button>} />
      <section className="card">
        <div className="card-header">
          <div className="filters" style={{ width: '100%', gridTemplateColumns: '2fr 1fr 1fr' }}>
            <TextField label="Buscar por nome ou e-mail" type="search" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
            <SelectField label="Empresa" value={companyId} onChange={(e) => { setCompanyId(e.target.value); setPage(1); }}>
              <option value="">Todas</option>
              {companies.data?.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </SelectField>
            <SelectField label="Perfil" value={kind} onChange={(e) => { setKind(e.target.value as UserKind | ''); setPage(1); }}>
              <option value="">Todos</option>
              {Object.entries(kindLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </SelectField>
          </div>
        </div>
        {list.isLoading ? <Loading /> : list.isError ? <ErrorState error={list.error} /> : list.data!.items.length === 0 ? <Empty title="Nenhum usuário encontrado" /> : (
          <>
            <div className="table-wrap">
              <table className="table responsive">
                <thead><tr><th>Nome</th><th>E-mail</th><th>Perfil</th><th>Empresa</th><th>Situação</th><th>Último acesso</th><th className="actions">Ações</th></tr></thead>
                <tbody>
                  {list.data!.items.map((u) => (
                    <tr key={u.id}>
                      <td data-label="Nome"><strong>{u.fullName}</strong></td>
                      <td data-label="E-mail">{u.email}</td>
                      <td data-label="Perfil">{kindLabel[u.kind]}</td>
                      <td data-label="Empresa">{u.companyName ?? 'Alpha Select'}</td>
                      <td data-label="Situação">
                        {!u.isActive ? <span className="badge">Desativado</span> : u.accessStatus && (
                          <span className={`badge ${u.accessStatus === 'senha_definida' ? 'badge-success' : 'badge-warning'}`}>{accessLabel[u.accessStatus]}</span>
                        )}
                      </td>
                      <td data-label="Último acesso">{fmtDateTime(u.lastLoginAt)}</td>
                      <td className="actions">
                        <Button size="sm" onClick={() => setEditing(u)}>Editar</Button>
                        {u.isActive && u.accessStatus !== 'senha_definida' && <>{' '}<Button size="sm" onClick={() => resend(u)}>Reenviar convite</Button></>}
                        {u.isActive && u.accessStatus === 'senha_definida' && u.id !== me?.id && <>{' '}<Button size="sm" onClick={() => resetLink(u)}>Link de redefinição</Button></>}
                        {u.id !== me?.id && <>{' '}<Button size="sm" variant={u.isActive ? 'danger' : 'default'} onClick={() => setToggling(u)}>{u.isActive ? 'Desativar' : 'Reativar'}</Button></>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={list.data!.page} pageSize={list.data!.pageSize} total={list.data!.total} onPage={setPage} />
          </>
        )}
      </section>
      {shared && <SharedLinkModal data={shared} onClose={() => setShared(null)} />}
      {editing && <UserModal onLink={setShared} user={editing === 'new' ? null : editing} companies={companies.data?.items.filter((c) => c.isActive) ?? []} onClose={() => setEditing(null)} isSelf={editing !== 'new' && editing.id === me?.id} />}
      {toggling && (
        <ConfirmDialog title={toggling.isActive ? 'Desativar usuário' : 'Reativar usuário'} danger={toggling.isActive}
          message={toggling.isActive ? <>Desativar <strong>{toggling.fullName}</strong>? O acesso é bloqueado imediatamente, inclusive em sessões abertas.</> : <>Reativar <strong>{toggling.fullName}</strong>?</>}
          confirmLabel={toggling.isActive ? 'Desativar' : 'Reativar'} onConfirm={toggle} onCancel={() => setToggling(null)} />
      )}
    </>
  );
}

function UserModal({ user, companies, onClose, isSelf, onLink }: { user: UserRow | null; companies: Company[]; onClose: () => void; isSelf: boolean; onLink: (l: SharedLink) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [email, setEmail] = useState(user?.email ?? '');
  const [fullName, setFullName] = useState(user?.fullName ?? '');
  const [kind, setKind] = useState<UserKind>(user?.kind ?? 'alpha_staff');
  const [companyId, setCompanyId] = useState(user?.companyId ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const isClient = kind === 'client_user' || kind === 'client_manager';

  const save = async () => {
    setBusy(true);
    setErrors({});
    try {
      if (user) {
        const body: Record<string, unknown> = { fullName };
        if (!isSelf) Object.assign(body, { kind, companyId: isClient ? companyId : null });
        await api.patch(`/api/users/${user.id}`, body);
        toast.success('Usuário atualizado.');
      } else {
        const r = await api.post<{ inviteLink?: string; validHours?: number }>('/api/users', { email, fullName, kind, companyId: isClient ? companyId : null });
        if (r.inviteLink) onLink({ kind: 'convite', name: fullName, link: r.inviteLink, validHours: r.validHours ?? 72 });
        else toast.success('Convite enviado por e-mail (válido por 72 horas, uso único).');
      }
      await qc.invalidateQueries({ queryKey: ['users'] });
      onClose();
    } catch (e) {
      setErrors(fieldErrors(e));
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={user ? 'Editar usuário' : 'Convidar usuário'} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" onClick={save} loading={busy} disabled={fullName.trim().length < 2 || (!user && !email) || (isClient && !companyId)}>{user ? 'Salvar' : 'Enviar convite'}</Button></>}>
      <div className="stack">
        <TextField label="E-mail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email} disabled={!!user} required
          hint={user ? 'O e-mail não pode ser alterado.' : undefined} />
        <TextField label="Nome completo" value={fullName} onChange={(e) => setFullName(e.target.value)} error={errors.fullName} maxLength={120} required />
        <SelectField label="Perfil" value={kind} onChange={(e) => setKind(e.target.value as UserKind)} disabled={isSelf}
          hint={isSelf ? 'Você não pode alterar o próprio perfil.' : 'Perfil e escopo são definidos pelo servidor; o convidado não pode alterá-los.'}>
          {Object.entries(kindLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </SelectField>
        {isClient && (
          <SelectField label="Empresa" value={companyId} onChange={(e) => setCompanyId(e.target.value)} error={errors.companyId} required disabled={isSelf}>
            <option value="">Selecione…</option>
            {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </SelectField>
        )}
        {isClient && <p className="muted small">Após o convite, vincule o usuário aos processos na aba “Participantes autorizados” de cada processo.</p>}
      </div>
    </Modal>
  );
}

interface SharedLink {
  kind: 'convite' | 'redefinicao';
  name: string;
  link: string;
  validHours: number;
}

/**
 * Exibe o link UMA vez ao administrador (modo sem e-mail). O link não é
 * guardado no sistema: se for perdido, gere outro (o anterior deixa de valer).
 */
function SharedLinkModal({ data, onClose }: { data: SharedLink; onClose: () => void }) {
  const toast = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(data.link);
      toast.success('Link copiado.');
    } catch {
      toast.error('Não foi possível copiar automaticamente. Selecione o texto e copie.');
    }
  };
  const title = data.kind === 'convite' ? 'Link de convite' : 'Link de redefinição de senha';
  return (
    <Modal title={title} onClose={onClose} footer={<><Button onClick={copy} variant="primary">Copiar link</Button><Button onClick={onClose}>Concluir</Button></>}>
      <div className="stack">
        <p>
          Envie este link para <strong>{data.name}</strong> por um canal seguro e individual (por exemplo, mensagem direta),
          nunca em grupos. Ele é de <strong>uso único</strong> e vale por <strong>{data.validHours} horas</strong>.
        </p>
        <TextField label="Link" value={data.link} readOnly onFocus={(e) => e.currentTarget.select()} />
        <p className="alert alert-warning">
          Por segurança, este link não fica salvo no sistema e não será exibido novamente. Se perdê-lo, gere um novo — o anterior deixa de funcionar.
        </p>
      </div>
    </Modal>
  );
}
