import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { docKindLabel, fmtSize } from '../lib/format';
import { Alert, Button, Checkbox, Modal, TextArea, useToast } from './ui';

interface Item {
  applicationId: string;
  name: string;
  summary: string;
  shareEmail: boolean;
  sharePhone: boolean;
  shareSalary: boolean;
  shareDocuments: boolean;
  /** Documentos do cadastro marcados para o cliente (null enquanto a lista carrega). */
  documentIds: string[] | null;
}

interface CandidateDoc { id: string; kind: keyof typeof docKindLabel; name: string; size: number; linked: boolean; sharedWithClient: boolean }

/** Lista os documentos do cadastro do candidato para escolher quais vão ao cliente. */
function DocumentPicker({ applicationId, value, onChange }: { applicationId: string; value: string[] | null; onChange: (ids: string[]) => void }) {
  const q = useQuery({
    queryKey: ['candidate-documents', applicationId],
    queryFn: () => api.get<{ items: CandidateDoc[] }>(`/api/applications/${applicationId}/candidate-documents`),
  });
  const docs = q.data?.items;
  useEffect(() => {
    // Padrão: currículo e o que já estava liberado; os demais (ex.: antecedentes) só se marcados.
    if (docs && value === null) onChange(docs.filter((d) => d.kind === 'curriculo' || d.sharedWithClient).map((d) => d.id));
  }, [docs, value, onChange]);
  if (q.isLoading) return <p className="muted small" style={{ margin: 0 }}>Carregando documentos…</p>;
  if (q.isError) return <p className="muted small" style={{ margin: 0 }}>Não foi possível carregar os documentos.</p>;
  if (!docs?.length) return <p className="muted small" style={{ margin: 0 }}>Nenhum documento no cadastro do candidato.</p>;
  const sel = new Set(value ?? []);
  return (
    <div className="stack" style={{ gap: 4 }}>
      <strong className="small">Documentos que o cliente vai ver</strong>
      {docs.map((d) => (
        <Checkbox key={d.id} label={`${docKindLabel[d.kind]}: ${d.name} (${fmtSize(d.size)})`} checked={sel.has(d.id)}
          onChange={(e) => onChange(e.target.checked ? [...sel, d.id] : [...sel].filter((x) => x !== d.id))} />
      ))}
    </div>
  );
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
      shareEmail: false, sharePhone: false, shareSalary: false, shareDocuments: false, documentIds: null,
    })),
  );
  const [dups, setDups] = useState<{ name: string; title: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const upd = (i: number, patch: Partial<Item>) => setItems((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  const send = async (confirmDuplicate = false) => {
    setBusy(true);
    try {
      const r = await api.post<{ count: number }>(`/api/processes/${processId}/send-leads`, {
        items: items.map(({ name: _n, summary, documentIds, ...rest }) => ({ ...rest, documentIds: documentIds ?? [], summary: summary.trim() || null })),
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
            </div>
            <DocumentPicker applicationId={it.applicationId} value={it.documentIds} onChange={(ids) => upd(i, { documentIds: ids })} />
          </fieldset>
        ))}
      </div>
    </Modal>
  );
}
