import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import { Alert, Button, PageHeader, TextField, fieldErrors, usePageTitle, useToast } from '../../components/ui';
import { fmtPhone } from '../../lib/format';

interface PreviewRow {
  line: number;
  fullName: string;
  email: string | null;
  phone: string | null;
  status: 'ok' | 'erro' | 'ja_cadastrado' | 'repetido';
  problems: string[];
}
interface Preview {
  summary: { total: number; ok: number; erro: number; jaCadastrado: number; repetido: number };
  columns: string[];
  ignoredColumns: string[];
  rows: PreviewRow[];
}

const statusBadge: Record<PreviewRow['status'], [string, string]> = {
  ok: ['Será importado', 'badge-success'],
  erro: ['Com erro', 'badge-danger'],
  ja_cadastrado: ['Já cadastrado', 'badge-warning'],
  repetido: ['Repetido no arquivo', 'badge-warning'],
};
const columnLabel: Record<string, string> = { fullName: 'Nome', email: 'E-mail', phone: 'Telefone', city: 'Cidade', salary: 'Pretensão', notes: 'Observações' };

const TEMPLATE = 'Nome;E-mail;Telefone;Cidade;Pretensão salarial;Observações\r\nMaria Exemplo;maria@exemplo.com;(11) 98888-7777;São Paulo;5.000,00;Indicação\r\n';

/** O Excel em português costuma salvar CSV em Windows-1252; aceita esse formato e UTF-8. */
async function readText(file: File) {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

/** Importação de candidatos por planilha (administrador). */
export function ImportCandidatesPage() {
  usePageTitle('Importar candidatos');
  const toast = useToast();
  const qc = useQueryClient();
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [origin, setOrigin] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ imported: number; skipped: number } | null>(null);

  const pick = async (file: File | undefined) => {
    setPreview(null);
    setDone(null);
    setError(null);
    if (!file) return;
    if (file.size > 3 * 1024 * 1024) return setError('Arquivo grande demais. Divida a planilha em partes de até 5.000 linhas.');
    const text = await readText(file);
    setCsv(text);
    setFileName(file.name);
    setBusy(true);
    try {
      setPreview(await api.post<Preview>('/api/candidates/import/preview', { csv: text }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Não foi possível ler a planilha.');
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    if (!csv) return;
    setBusy(true);
    setErrors({});
    try {
      const r = await api.post<{ imported: number; skipped: number }>('/api/candidates/import', { csv, origin });
      setDone(r);
      setPreview(null);
      setCsv(null);
      toast.success(`${r.imported} candidato(s) importado(s).`);
      await qc.invalidateQueries({ queryKey: ['candidates'] });
    } catch (e) {
      setErrors(fieldErrors(e));
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const downloadTemplate = () => {
    const url = URL.createObjectURL(new Blob(['﻿', TEMPLATE], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'modelo-importacao-candidatos.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const s = preview?.summary;
  return (
    <>
      <PageHeader title="Importar candidatos" breadcrumb={<Link to="/candidatos">Candidatos</Link>}
        subtitle="Traga o banco de currículos de uma planilha. Nada é gravado até você confirmar." />
      <div className="stack">
        <section className="card">
          <div className="card-body stack">
            <ol style={{ margin: 0, paddingLeft: 18 }}>
              <li>Salve a planilha como <strong>CSV</strong> (no Excel: Arquivo → Salvar como → CSV). Uma linha por candidato.</li>
              <li>Colunas reconhecidas: Nome (obrigatória), E-mail, Telefone, Cidade, Pretensão salarial, Observações. As demais são ignoradas.</li>
              <li>Até 5.000 candidatos por arquivo. Quem já está cadastrado (mesmo e-mail ou telefone) não é importado de novo.</li>
            </ol>
            <div className="row">
              <Button onClick={downloadTemplate}>Baixar modelo de planilha</Button>
              <label className="btn btn-primary" style={{ cursor: 'pointer' }}>
                Escolher arquivo CSV
                <input type="file" accept=".csv,text/csv" style={{ display: 'none' }} onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
              </label>
              {fileName && <span className="muted small">{fileName}</span>}
            </div>
            {busy && !preview && <span className="muted">Lendo a planilha…</span>}
            {error && <Alert>{error}</Alert>}
            {done && (
              <Alert kind="success">
                {done.imported} candidato(s) importado(s){done.skipped ? `; ${done.skipped} linha(s) ficaram de fora` : ''}.{' '}
                <Link to="/candidatos">Ver candidatos</Link>
              </Alert>
            )}
          </div>
        </section>

        {preview && s && (
          <>
            <section className="grid grid-4" aria-label="Resumo da planilha">
              <div className="card stat"><div className="label">Serão importados</div><div className="value">{s.ok}</div></div>
              <div className="card stat"><div className="label">Com erro</div><div className="value">{s.erro}</div></div>
              <div className="card stat"><div className="label">Já cadastrados</div><div className="value">{s.jaCadastrado}</div></div>
              <div className="card stat"><div className="label">Repetidos no arquivo</div><div className="value">{s.repetido}</div></div>
            </section>
            <p className="muted small" style={{ margin: 0 }}>
              Colunas usadas: {preview.columns.map((c) => columnLabel[c] ?? c).join(', ')}
              {preview.ignoredColumns.length > 0 && <> · ignoradas: {preview.ignoredColumns.join(', ')}</>}
            </p>
            <section className="card">
              <div className="card-header"><h2>Prévia</h2><span className="muted small">linhas com problema e uma amostra das que serão importadas</span></div>
              <div className="table-wrap">
                <table className="table responsive">
                  <thead><tr><th>Linha</th><th>Nome</th><th>E-mail</th><th>Telefone</th><th>Situação</th></tr></thead>
                  <tbody>
                    {preview.rows.map((r) => (
                      <tr key={r.line}>
                        <td data-label="Linha">{r.line}</td>
                        <td data-label="Nome">{r.fullName || '—'}</td>
                        <td data-label="E-mail">{r.email ?? '—'}</td>
                        <td data-label="Telefone">{fmtPhone(r.phone)}</td>
                        <td data-label="Situação">
                          <span className={`badge ${statusBadge[r.status][1]}`}>{statusBadge[r.status][0]}</span>
                          {r.problems.length > 0 && <div className="muted small">{r.problems.join('; ')}</div>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            <section className="card">
              <div className="card-body stack">
                <TextField label="De onde vieram estes dados?" value={origin} onChange={(e) => setOrigin(e.target.value)} maxLength={300}
                  error={errors.origin} required
                  hint="Ex.: banco de currículos antigo da Alpha Select, candidatos que autorizaram o uso. Fica registrado na auditoria (LGPD)." />
                <div className="row">
                  <Button variant="primary" loading={busy} disabled={!s.ok || origin.trim().length < 5} onClick={run}>
                    Importar {s.ok} candidato(s)
                  </Button>
                  <Button onClick={() => { setPreview(null); setCsv(null); setFileName(''); }}>Cancelar</Button>
                </div>
              </div>
            </section>
          </>
        )}
      </div>
    </>
  );
}
