import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import type { Board, Member, Process, ProcessStatus, UserKind } from '../../api/types';
import {
  Button, Checkbox, ConfirmDialog, Empty, ErrorState, Loading, Modal, PageHeader, SelectField, StatusBadge, Tabs,
  TextArea, TextField, fieldErrors, usePageTitle, useToast,
} from '../../components/ui';
import { kindLabel, statusLabel } from '../../lib/format';
import { BoardView } from './BoardView';
import { AddCandidateModal } from './AddCandidateModal';
import { JobPanel, PublicationBadge } from './JobPanel';
import { useAuth } from '../../auth/AuthContext';

type Tab = 'quadro' | 'participantes' | 'dados' | 'vaga';

export function ProcessPage() {
  usePageTitle('Processo seletivo');
  const { id } = useParams<{ id: string }>();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('aba') as Tab) || 'quadro';
  const [adding, setAdding] = useState(false);
  const { isAlpha } = useAuth();
  const board = useQuery({ queryKey: ['board', id], queryFn: () => api.get<Board>(`/api/processes/${id}/board`) });

  if (board.isLoading) return <Loading />;
  if (board.isError) return <ErrorState error={board.error} onRetry={() => board.refetch()} />;
  const { process } = board.data!;
  const perms = process.permissions;
  const tabs: { id: Tab; label: string }[] = [
    { id: 'quadro', label: 'Quadro' },
    { id: 'participantes', label: 'Participantes autorizados' },
    { id: 'dados', label: 'Dados do processo' },
    ...(isAlpha ? [{ id: 'vaga' as Tab, label: 'Vaga e triagem' }] : []),
  ];

  return (
    <>
      <PageHeader
        breadcrumb={<Link to="/processos">Processos seletivos</Link>}
        title={process.title}
        subtitle={
          <span className="row">
            <span>{process.companyName}</span>
            <StatusBadge status={process.status} />
            <PublicationBadge publication={process.publication} />
          </span>
        }
        actions={
          perms.canAddCandidates && process.status === 'em_andamento' && (
            <Button variant="primary" onClick={() => setAdding(true)}>
              Incluir candidato
            </Button>
          )
        }
      />
      {process.status !== 'em_andamento' && (
        <p className="alert alert-info" style={{ marginBottom: 16 }}>
          Processo {statusLabel[process.status].toLowerCase()}: consulta apenas. Movimentações e decisões estão bloqueadas.
        </p>
      )}
      <Tabs label="Seções do processo" tabs={tabs} value={tab} onChange={(t) => setParams({ aba: t }, { replace: true })} />
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'quadro' && <BoardView board={board.data!} />}
        {tab === 'participantes' && <MembersPanel process={process} />}
        {tab === 'dados' && <ProcessDetails process={process} />}
        {tab === 'vaga' && isAlpha && <JobPanel process={process} />}
      </div>
      {adding && <AddCandidateModal processId={process.id} onClose={() => setAdding(false)} />}
    </>
  );
}

// ------------------------------------------------------------------ participantes

function MembersPanel({ process }: { process: Process }) {
  const qc = useQueryClient();
  const toast = useToast();
  const canManage = process.permissions.canManage;
  const members = useQuery({
    queryKey: ['members', process.id],
    queryFn: () => api.get<{ items: Member[] }>(`/api/processes/${process.id}/members`),
  });
  const [editing, setEditing] = useState<Member | 'new' | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      await api.delete(`/api/processes/${process.id}/members/${removing.userId}`);
      toast.success('Acesso removido. O efeito é imediato.');
      setRemoving(null);
      await qc.invalidateQueries({ queryKey: ['members', process.id] });
      await qc.invalidateQueries({ queryKey: ['board', process.id] });
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <div className="card-header">
        <div>
          <h2>Participantes autorizados</h2>
          <p className="muted small" style={{ margin: 0 }}>
            Somente estes usuários (e administradores) acessam o processo. Usuários de cliente precisam ser da empresa {process.companyName}.
          </p>
        </div>
        {canManage && <Button variant="primary" onClick={() => setEditing('new')}>Adicionar participante</Button>}
      </div>
      {members.isLoading ? <Loading /> : members.isError ? <ErrorState error={members.error} /> : members.data!.items.length === 0 ? (
        <Empty title="Nenhum participante vinculado" />
      ) : (
        <div className="table-wrap">
          <table className="table responsive">
            <thead><tr><th>Nome</th><th>Perfil</th><th>Mover etapa</th><th>Decidir</th><th>Comentar</th>{canManage && <th className="actions">Ações</th>}</tr></thead>
            <tbody>
              {members.data!.items.map((m) => (
                <tr key={m.userId}>
                  <td data-label="Nome">{m.fullName} {!m.isActive && <span className="badge">inativo</span>}</td>
                  <td data-label="Perfil">{kindLabel[m.kind]}</td>
                  <td data-label="Mover etapa">{m.canMoveStage ? 'Sim' : 'Não'}</td>
                  <td data-label="Decidir">{m.canDecide ? 'Sim' : 'Não'}</td>
                  <td data-label="Comentar">{m.canComment ? 'Sim' : 'Não'}</td>
                  {canManage && (
                    <td className="actions">
                      <Button size="sm" onClick={() => setEditing(m)}>Permissões</Button>{' '}
                      <Button size="sm" variant="danger" onClick={() => setRemoving(m)}>Remover</Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <MemberModal process={process} member={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {removing && (
        <ConfirmDialog
          title="Remover acesso ao processo"
          message={<>Remover <strong>{removing.fullName}</strong> deste processo? O acesso é revogado imediatamente, inclusive a documentos.</>}
          confirmLabel="Remover acesso"
          danger
          loading={busy}
          onConfirm={remove}
          onCancel={() => setRemoving(null)}
        />
      )}
    </section>
  );
}

function MemberModal({ process, member, onClose }: { process: Process; member: Member | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const options = useQuery({
    queryKey: ['member-candidates', process.id],
    queryFn: () => api.get<{ items: { id: string; fullName: string; kind: UserKind; email: string }[] }>(`/api/processes/${process.id}/member-candidates`),
    enabled: !member,
  });
  const [userId, setUserId] = useState(member?.userId ?? '');
  const selectedKind = member?.kind ?? options.data?.items.find((u) => u.id === userId)?.kind;
  const [canMoveStage, setMove] = useState(member?.canMoveStage ?? false);
  const [canDecide, setDecide] = useState(member?.canDecide ?? false);
  const [canComment, setComment] = useState(member?.canComment ?? true);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await api.put(`/api/processes/${process.id}/members/${userId}`, { canMoveStage, canDecide, canComment });
      toast.success('Permissões salvas.');
      await qc.invalidateQueries({ queryKey: ['members', process.id] });
      await qc.invalidateQueries({ queryKey: ['member-candidates', process.id] });
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={member ? `Permissões de ${member.fullName}` : 'Adicionar participante'} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" onClick={save} loading={busy} disabled={!userId}>Salvar</Button></>}>
      <div className="stack">
        {!member && (
          options.isLoading ? <Loading /> : (
            <SelectField label="Usuário" value={userId} onChange={(e) => setUserId(e.target.value)} hint="Equipe Alpha Select e usuários ativos da empresa do processo.">
              <option value="">Selecione…</option>
              {options.data?.items.map((u) => <option key={u.id} value={u.id}>{u.fullName} — {kindLabel[u.kind]}</option>)}
            </SelectField>
          )
        )}
        <fieldset className="stack" style={{ border: 'none', padding: 0, margin: 0 }}>
          <legend className="label" style={{ fontWeight: 600, marginBottom: 8 }}>Permissões neste processo</legend>
          <Checkbox label="Mover candidatos entre etapas" checked={canMoveStage} onChange={(e) => setMove(e.target.checked)} />
          <Checkbox label="Registrar decisão (aprovado, não aprovado, desistência)" checked={canDecide} onChange={(e) => setDecide(e.target.checked)} />
          <Checkbox
            label="Publicar comentários"
            hint={selectedKind?.startsWith('client') ? 'Usuários de cliente publicam apenas comentários compartilhados.' : undefined}
            checked={canComment}
            onChange={(e) => setComment(e.target.checked)}
          />
        </fieldset>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ dados

function ProcessDetails({ process }: { process: Process }) {
  const qc = useQueryClient();
  const toast = useToast();
  const canManage = process.permissions.canManage;
  const [title, setTitle] = useState(process.title);
  const [description, setDescription] = useState(process.description ?? '');
  const [status, setStatus] = useState<ProcessStatus>(process.status);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    setErrors({});
    try {
      await api.patch(`/api/processes/${process.id}`, { expectedVersion: process.version, title, description: description || null, status });
      toast.success('Processo atualizado.');
      await qc.invalidateQueries({ queryKey: ['board', process.id] });
      await qc.invalidateQueries({ queryKey: ['processes'] });
    } catch (e) {
      setErrors(fieldErrors(e));
      toast.error(e);
      if (e instanceof ApiError && e.status === 409) await qc.invalidateQueries({ queryKey: ['board', process.id] });
    } finally {
      setBusy(false);
    }
  };

  if (!canManage) {
    return (
      <section className="card"><div className="card-body">
        <dl className="dl">
          <dt>Empresa</dt><dd>{process.companyName}</dd>
          <dt>Situação</dt><dd>{statusLabel[process.status]}</dd>
          <dt>Descrição</dt><dd className="pre-wrap">{process.description || '—'}</dd>
        </dl>
      </div></section>
    );
  }
  return (
    <section className="card">
      <div className="card-body stack">
        <TextField label="Título" value={title} onChange={(e) => setTitle(e.target.value)} error={errors.title} maxLength={160} required />
        <TextArea label="Descrição" value={description} onChange={(e) => setDescription(e.target.value)} error={errors.description} maxLength={5000} />
        <SelectField label="Situação" value={status} onChange={(e) => setStatus(e.target.value as ProcessStatus)}
          hint="Processos concluídos ou arquivados ficam somente para consulta.">
          {Object.entries(statusLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </SelectField>
        <p className="muted small">Empresa: {process.companyName} (não pode ser alterada após a criação).</p>
        <div className="form-actions"><Button variant="primary" onClick={save} loading={busy}>Salvar alterações</Button></div>
      </div>
    </section>
  );
}
