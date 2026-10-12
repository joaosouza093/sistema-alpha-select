import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { Stage } from '../../api/types';
import { Button, ConfirmDialog, ErrorState, Loading, Modal, PageHeader, TextField, fieldErrors, usePageTitle, useToast } from '../../components/ui';

interface StageAdmin extends Stage {
  isActive: boolean;
  isApproval: boolean;
  openCount: number;
  used: boolean;
}

/** Etapas do processo seletivo (iguais para todos os processos). */
export function StagesPage() {
  usePageTitle('Etapas do processo');
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['stages-admin'], queryFn: () => api.get<{ items: StageAdmin[] }>('/api/stages?all=1') });
  const [editing, setEditing] = useState<StageAdmin | 'new' | null>(null);
  const [removing, setRemoving] = useState<StageAdmin | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['stages-admin'] });
    await qc.invalidateQueries({ queryKey: ['stages'] });
  };
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
      await refresh();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const items = q.data!.items;
  const active = items.filter((s) => s.isActive);
  const inactive = items.filter((s) => !s.isActive);

  /** Troca a etapa ativa de lugar com a vizinha; as desativadas ficam no fim. */
  const swap = (i: number, j: number) => {
    const order = active.map((s) => s.id);
    [order[i], order[j]] = [order[j]!, order[i]!];
    return run(() => api.put('/api/stages/order', { ids: [...order, ...inactive.map((s) => s.id)] }), 'Ordem atualizada.');
  };

  return (
    <>
      <PageHeader title="Etapas do processo" subtitle="As mesmas etapas valem para todos os processos seletivos. O candidato entra na primeira etapa e avança uma de cada vez."
        actions={<Button variant="primary" onClick={() => setEditing('new')}>Nova etapa</Button>} />
      <div className="stack">
        <section className="card">
          <div className="card-header"><h2>Etapas ativas</h2></div>
          <ol className="list-plain">
            {active.map((s, i) => (
              <li key={s.id} className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
                <span>
                  <strong>{i + 1}. {s.name}</strong>
                  {i === 0 && <span className="badge badge-info" style={{ marginLeft: 8 }}>Entrada (triagem)</span>}
                  {s.isApproval && <span className="badge badge-success" style={{ marginLeft: 8 }}>Aprovação</span>}
                  <span className="muted small"> · {s.openCount} candidato(s) em avaliação</span>
                </span>
                <span className="row">
                  <Button size="sm" disabled={busy || i === 0} onClick={() => swap(i, i - 1)} aria-label={`Subir ${s.name}`}>↑</Button>
                  <Button size="sm" disabled={busy || i === active.length - 1} onClick={() => swap(i, i + 1)} aria-label={`Descer ${s.name}`}>↓</Button>
                  <Button size="sm" onClick={() => setEditing(s)}>Renomear</Button>
                  {!s.isApproval && (
                    <Button size="sm" disabled={busy} onClick={() => run(() => api.patch(`/api/stages/${s.id}`, { isActive: false }), `Etapa "${s.name}" desativada.`)}>
                      Desativar
                    </Button>
                  )}
                  {!s.isApproval && !s.used && <Button size="sm" variant="danger" onClick={() => setRemoving(s)}>Excluir</Button>}
                </span>
              </li>
            ))}
          </ol>
          <div className="card-body muted small" style={{ paddingTop: 0 }}>
            Sair da primeira etapa marca o candidato como enviado ao cliente. A aprovação só pode ser registrada na etapa de
            aprovação. Para desativar uma etapa, mova antes os candidatos em avaliação nela.
          </div>
        </section>
        {inactive.length > 0 && (
          <section className="card">
            <div className="card-header"><h2>Etapas desativadas</h2></div>
            <ul className="list-plain">
              {inactive.map((s) => (
                <li key={s.id} className="row" style={{ justifyContent: 'space-between' }}>
                  <span>{s.name} <span className="muted small">{s.used ? '· mantida no histórico' : ''}</span></span>
                  <span className="row">
                    <Button size="sm" disabled={busy} onClick={() => run(async () => {
                      await api.patch(`/api/stages/${s.id}`, { isActive: true });
                      // Volta antes da aprovação.
                      const order = active.map((x) => x.id);
                      const ap = active.findIndex((x) => x.isApproval);
                      order.splice(ap < 0 ? order.length : ap, 0, s.id);
                      await api.put('/api/stages/order', { ids: [...order, ...inactive.filter((x) => x.id !== s.id).map((x) => x.id)] });
                    }, `Etapa "${s.name}" reativada.`)}>Reativar</Button>
                    {!s.used && <Button size="sm" variant="danger" onClick={() => setRemoving(s)}>Excluir</Button>}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      {editing && <StageModal stage={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={refresh} />}
      {removing && (
        <ConfirmDialog title="Excluir etapa" danger message={<>Excluir a etapa <strong>{removing.name}</strong>? Ela nunca foi usada.</>}
          confirmLabel="Excluir" onCancel={() => setRemoving(null)}
          onConfirm={() => run(() => api.delete(`/api/stages/${removing.id}`), 'Etapa excluída.').then(() => setRemoving(null))} />
      )}
    </>
  );
}

function StageModal({ stage, onClose, onSaved }: { stage: StageAdmin | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const [name, setName] = useState(stage?.name ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      if (stage) await api.patch(`/api/stages/${stage.id}`, { name });
      else await api.post('/api/stages', { name });
      toast.success(stage ? 'Etapa renomeada.' : 'Etapa criada antes da aprovação. Ajuste a ordem se precisar.');
      await onSaved();
      onClose();
    } catch (e) {
      setErrors(fieldErrors(e));
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={stage ? 'Renomear etapa' : 'Nova etapa'} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} onClick={save} disabled={name.trim().length < 2}>Salvar</Button></>}>
      <TextField label="Nome da etapa" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required error={errors.name}
        placeholder="Ex.: Teste técnico" />
    </Modal>
  );
}
