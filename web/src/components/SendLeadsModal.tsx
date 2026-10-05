import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { Alert, Button, Checkbox, Modal, TextArea, useToast } from './ui';

interface Item {
  applicationId: string;
  name: string;
  summary: string;
  shareEmail: boolean;
  sharePhone: boolean;
  shareSalary: boolean;
  shareDocuments: boolean;
}

/**
 * Envio ao cliente (um ou vários candidatos aprovados na triagem): resumo do
 * recrutador e o que será compartilhado. Move para a etapa do RH Interno.
 */
export function SendLeadsModal({
  processId,
  candidates,
  onClose,
  onDone,
}: {
  processId: string;
  candidates: { applicationId: string; name: string; summary?: string | null }[];
  onClose: () => void;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [items, setItems] = useState<Item[]>(
    candidates.map((c) => ({
      applicationId: c.applicationId, name: c.name, summary: c.summary ?? '',
      shareEmail: false, sharePhone: false, shareSalary: false, shareDocuments: true,
    })),
  );
  const [dups, setDups] = useState<{ name: string; title: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const upd = (i: number, patch: Partial<Item>) => setItems((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  const send = async (confirmDuplicate = false) => {
    setBusy(true);
    try {
      const r = await api.post<{ count: number }>(`/api/processes/${processId}/send-leads`, {
        items: items.map(({ name: _n, summary, ...rest }) => ({ ...rest, summary: summary.trim() || null })),
        confirmDuplicate,
      });
      toast.success(`${r.count} candidato(s) enviado(s) ao cliente. Os participantes da empresa foram avisados.`);
      await qc.invalidateQueries({ queryKey: ['board', processId] });
      await qc.invalidateQueries({ queryKey: ['application'] });
      onDone();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'possible_duplicate') setDups((e.details as { name: string; title: string }[]) ?? []);
      else toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={items.length > 1 ? `Enviar ${items.length} candidatos ao cliente` : 'Enviar candidato ao cliente'} size="lg" onClose={onClose}
      footer={<><Button onClick={onClose}>Cancelar</Button>
        {dups ? <Button variant="primary" loading={busy} onClick={() => send(true)}>Enviar mesmo assim</Button>
          : <Button variant="primary" loading={busy} onClick={() => send(false)}>Enviar</Button>}</>}>
      <div className="stack">
        <p className="muted small" style={{ margin: 0 }}>
          O cliente passa a ver o candidato na etapa RH Interno, com o resumo abaixo e somente os dados marcados.
        </p>
        {dups && (
          <Alert kind="warning">
            Já enviado a esta empresa em outro processo: {dups.map((d) => `${d.name} (${d.title})`).join('; ')}. Confirme para enviar mesmo assim.
          </Alert>
        )}
        {items.map((it, i) => (
          <fieldset key={it.applicationId} className="question stack" style={{ gap: 8 }}>
            <legend>{it.name}</legend>
            <TextArea label="Resumo do recrutador (o cliente vê)" value={it.summary} rows={3} maxLength={5000}
              onChange={(e) => upd(i, { summary: e.target.value })} placeholder="Destaques, aderência à vaga, observações." />
            <div className="row">
              <Checkbox label="E-mail" checked={it.shareEmail} onChange={(e) => upd(i, { shareEmail: e.target.checked })} />
              <Checkbox label="Telefone" checked={it.sharePhone} onChange={(e) => upd(i, { sharePhone: e.target.checked })} />
              <Checkbox label="Pretensão salarial" checked={it.shareSalary} onChange={(e) => upd(i, { shareSalary: e.target.checked })} />
              <Checkbox label="Documentos vinculados (currículo)" checked={it.shareDocuments} onChange={(e) => upd(i, { shareDocuments: e.target.checked })} />
            </div>
          </fieldset>
        ))}
      </div>
    </Modal>
  );
}
