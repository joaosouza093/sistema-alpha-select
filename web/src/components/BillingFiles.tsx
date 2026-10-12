import { useRef, useState } from 'react';
import { api } from '../api/client';
import type { BillingFile, BillingFileKind } from '../api/types';
import { fmtSize } from '../lib/format';
import { Button, ConfirmDialog, useToast } from './ui';

export const billingFileLabel: Record<BillingFileKind, string> = { boleto: 'Boleto', nota_fiscal: 'Nota fiscal', contrato: 'Contrato' };
export const billingFileAccept: Record<BillingFileKind, string> = {
  boleto: '.pdf,application/pdf',
  nota_fiscal: '.pdf,.xml,application/pdf,text/xml,application/xml',
  contrato: '.pdf,.doc,.docx,.odt',
};
export const billingFileHint: Record<BillingFileKind, string> = {
  boleto: 'PDF',
  nota_fiscal: 'PDF ou XML',
  contrato: 'PDF, DOC, DOCX ou ODT',
};

export const billingFileUrl = (id: string, download = false) => `/api/billing/files/${id}/content${download ? '?download=1' : ''}`;

/** Envia o arquivo (o tipo vai antes do arquivo: o servidor lê em streaming). */
export async function uploadBillingFile(url: string, file: File, kind?: BillingFileKind) {
  const fd = new FormData();
  if (kind) fd.append('kind', kind);
  fd.append('file', file);
  return api.post(url, fd);
}

/** Link para abrir (PDF) ou baixar (XML/DOC) o anexo. */
export function BillingFileLink({ file, label }: { file: BillingFile; label?: string }) {
  const pdf = file.name.toLowerCase().endsWith('.pdf');
  return (
    <a href={billingFileUrl(file.id, !pdf)} target={pdf ? '_blank' : undefined} rel="noopener noreferrer" title={`${file.name} (${fmtSize(file.size)})`}>
      {label ?? billingFileLabel[file.kind]}
    </a>
  );
}

/** Seletor de arquivo simples (usado antes de a cobrança existir). */
export function BillingFilePicker({ id, kind, file, onChange }: { id: string; kind: BillingFileKind; file: File | null; onChange: (f: File | null) => void }) {
  return (
    <div className="field">
      <label htmlFor={id}>{billingFileLabel[kind]}</label>
      <input id={id} type="file" className="input" accept={billingFileAccept[kind]} onChange={(e) => onChange(e.target.files?.[0] ?? null)} />
      <span className="hint">{file ? `${file.name} (${fmtSize(file.size)})` : `Opcional. ${billingFileHint[kind]}.`}</span>
    </div>
  );
}

/**
 * Anexos de uma cobrança ou contrato já existente: abrir, anexar,
 * substituir e remover (administrador).
 */
export function BillingFilesEditor({ uploadUrl, kinds, files, onChanged, disabled }: {
  uploadUrl: string;
  kinds: BillingFileKind[];
  files: BillingFile[];
  onChanged: () => Promise<unknown> | void;
  disabled?: boolean;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<BillingFileKind | null>(null);
  const [removing, setRemoving] = useState<BillingFile | null>(null);
  const inputs = useRef<Partial<Record<BillingFileKind, HTMLInputElement | null>>>({});

  const send = async (kind: BillingFileKind, f: File | undefined) => {
    if (!f) return;
    setBusy(kind);
    try {
      await uploadBillingFile(uploadUrl, f, kind === 'contrato' ? undefined : kind);
      toast.success(`${billingFileLabel[kind]} anexado.`);
      await onChanged();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
      const el = inputs.current[kind];
      if (el) el.value = '';
    }
  };

  const remove = async () => {
    if (!removing) return;
    try {
      await api.delete(`/api/billing/files/${removing.id}`);
      toast.success(`${billingFileLabel[removing.kind]} removido.`);
      setRemoving(null);
      await onChanged();
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0, gap: 8 }}>
      {kinds.map((kind) => {
        const f = files.find((x) => x.kind === kind);
        return (
          <li key={kind} className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
            <span>
              <strong>{billingFileLabel[kind]}:</strong>{' '}
              {f ? <><BillingFileLink file={f} label={f.name} /> <span className="muted small">({fmtSize(f.size)})</span></> : <span className="muted">não anexado</span>}
            </span>
            {!disabled && (
              <span className="row">
                <input ref={(el) => { inputs.current[kind] = el; }} type="file" accept={billingFileAccept[kind]} style={{ display: 'none' }}
                  aria-label={`Arquivo do ${billingFileLabel[kind].toLowerCase()}`} onChange={(e) => void send(kind, e.target.files?.[0])} />
                <Button size="sm" loading={busy === kind} onClick={() => inputs.current[kind]?.click()}>
                  {f ? 'Substituir' : `Anexar ${billingFileLabel[kind].toLowerCase()}`}
                </Button>
                {f && <Button size="sm" variant="danger" onClick={() => setRemoving(f)}>Remover</Button>}
              </span>
            )}
          </li>
        );
      })}
      {removing && (
        <ConfirmDialog title={`Remover ${billingFileLabel[removing.kind].toLowerCase()}`} danger
          message={<>Remover o arquivo <strong>{removing.name}</strong>? A empresa deixa de ver este arquivo no Financeiro.</>}
          confirmLabel="Remover" onConfirm={remove} onCancel={() => setRemoving(null)} />
      )}
    </ul>
  );
}
