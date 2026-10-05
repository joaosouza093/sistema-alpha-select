import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import type { Stage, UserKind } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Alert, Button, Modal, SelectField, useToast } from './ui';

interface Props {
  applicationId: string;
  candidateName: string;
  currentStageId: number;
  currentOwnerId: string | null;
  version: number;
  stages: Stage[];
  initialTargetId?: number;
  onClose: () => void;
  onDone: () => void;
}

/** Movimentação por ação explícita (também usada ao soltar um cartão no quadro). */
export function MoveDialog(p: Props) {
  const { isAdmin } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const current = p.stages.find((s) => s.id === p.currentStageId)!;
  const allowed = p.stages.filter((s) => s.id !== p.currentStageId && (isAdmin || Math.abs(s.position - current.position) === 1));
  const [target, setTarget] = useState<number>(
    p.initialTargetId && allowed.some((s) => s.id === p.initialTargetId) ? p.initialTargetId : allowed.find((s) => s.position > current.position)?.id ?? allowed[0]?.id ?? 0,
  );
  const [owner, setOwner] = useState<string>(p.currentOwnerId ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const owners = useQuery({
    queryKey: ['owner-options', p.applicationId],
    queryFn: () => api.get<{ items: { id: string; fullName: string; kind: UserKind }[] }>(`/api/applications/${p.applicationId}/owner-options`),
  });
  const invalidDrop = p.initialTargetId !== undefined && !allowed.some((s) => s.id === p.initialTargetId);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { toStageId: target, expectedVersion: p.version };
      if (owner !== (p.currentOwnerId ?? '')) body.ownerId = owner || null;
      await api.post(`/api/applications/${p.applicationId}/move`, body);
      toast.success('Etapa atualizada e registrada no histórico.');
      await qc.invalidateQueries();
      p.onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Não foi possível mover.');
      if (e instanceof ApiError && e.status === 409) await qc.invalidateQueries();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Mover candidato de etapa"
      onClose={p.onClose}
      footer={
        <>
          <Button onClick={p.onClose}>Cancelar</Button>
          <Button variant="primary" onClick={submit} loading={busy} disabled={!target}>
            Confirmar movimentação
          </Button>
        </>
      }
    >
      <div className="stack">
        <p>
          <strong>{p.candidateName}</strong> — etapa atual: <strong>{current.name}</strong>
        </p>
        {invalidDrop && <Alert kind="warning">Movimentação permitida apenas para a etapa anterior ou seguinte.</Alert>}
        {error && <Alert>{error}</Alert>}
        <SelectField label="Nova etapa" value={target} onChange={(e) => setTarget(Number(e.target.value))}>
          {allowed.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Responsável pela etapa"
          value={owner}
          onChange={(e) => setOwner(e.target.value)}
          hint="Somente participantes com acesso ativo ao processo."
        >
          <option value="">Sem responsável</option>
          {owners.data?.items.map((u) => (
            <option key={u.id} value={u.id}>
              {u.fullName}
            </option>
          ))}
        </SelectField>
        <p className="muted small">Mover para “Aprovação” não aprova o candidato: a decisão é registrada separadamente.</p>
      </div>
    </Modal>
  );
}
