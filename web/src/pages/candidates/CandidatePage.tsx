import { useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { Candidate, DocumentRow, Page, ProcessRow, Stage } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import {
  Alert, Button, ConfirmDialog, DecisionBadge, Empty, ErrorState, Loading, Modal, PageHeader, SelectField, StatusBadge,
  Tabs, usePageTitle, useToast,
} from '../../components/ui';
import { DocumentPreview } from '../../components/DocumentPreview';
import { docKindLabel, fmtDateTime, fmtMoney, fmtPhone, fmtSize } from '../../lib/format';

type Tab = 'dados' | 'participacoes' | 'documentos';

export function CandidatePage() {
  usePageTitle('Candidato');
  const { id } = useParams<{ id: string }>();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('aba') as Tab) || 'dados';
  const q = useQuery({ queryKey: ['candidate', id], queryFn: () => api.get<Candidate>(`/api/candidates/${id}`) });

  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const c = q.data!;

  return (
    <>
      <PageHeader
        breadcrumb={<Link to="/candidatos">Candidatos</Link>}
        title={c.fullName}
        subtitle={c.archivedAt ? <span className="badge">Arquivado em {fmtDateTime(c.archivedAt)}</span> : 'Cadastro interno — não visível aos clientes'}
        actions={<Link to={`/candidatos/${c.id}/editar`} className="btn">Editar cadastro</Link>}
      />
      <Tabs label="Seções do candidato" value={tab} onChange={(t) => setParams({ aba: t }, { replace: true })}
        tabs={[{ id: 'dados', label: 'Dados' }, { id: 'participacoes', label: `Processos (${c.applications.length})` }, { id: 'documentos', label: `Documentos (${c.documents.length})` }]} />
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'dados' && <DataTab c={c} />}
        {tab === 'participacoes' && <ApplicationsTab c={c} />}
        {tab === 'documentos' && <DocumentsTab c={c} initialApp={params.get('participacao')} />}
      </div>
    </>
  );
}

function DataTab({ c }: { c: Candidate }) {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const nav = useNavigate();
  const toast = useToast();
  const [erase, setErase] = useState(false);
  const [busy, setBusy] = useState(false);

  const toggleArchive = async () => {
    try {
      await api.patch(`/api/candidates/${c.id}`, { expectedVersion: c.version, archived: !c.archivedAt });
      toast.success(c.archivedAt ? 'Cadastro reativado.' : 'Cadastro arquivado (os dados permanecem armazenados).');
      await qc.invalidateQueries({ queryKey: ['candidate', c.id] });
    } catch (e) {
      toast.error(e);
    }
  };
  const doErase = async () => {
    setBusy(true);
    try {
      await api.delete(`/api/candidates/${c.id}`);
      toast.success('Dados do candidato eliminados definitivamente.');
      await qc.invalidateQueries({ queryKey: ['candidates'] });
      nav('/candidatos');
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <section className="card">
        <div className="card-body">
          <dl className="dl">
            <dt>Nome</dt><dd>{c.fullName}</dd>
            <dt>E-mail</dt><dd>{c.email ?? '—'}</dd>
            <dt>Telefone</dt><dd>{fmtPhone(c.phone)}</dd>
            <dt>Pretensão salarial</dt><dd>{fmtMoney(c.salaryExpectation)}</dd>
            <dt>Observações internas</dt><dd className="pre-wrap">{c.notes || '—'}</dd>
            <dt>Cadastrado por</dt><dd>{c.createdByName ?? '—'} em {fmtDateTime(c.createdAt)}</dd>
            <dt>Última atualização</dt><dd>{fmtDateTime(c.updatedAt)}</dd>
          </dl>
        </div>
      </section>
      <section className="card">
        <div className="card-header"><h2>Ciclo de vida do cadastro</h2></div>
        <div className="card-body stack">
          <p className="muted small">
            Arquivar oculta o cadastro das listagens, mas <strong>não elimina</strong> os dados. A eliminação definitiva (atendimento a solicitação do titular)
            é exclusiva de administradores e remove participações, comentários, histórico, documentos e arquivos.
          </p>
          <div className="row">
            <Button onClick={toggleArchive}>{c.archivedAt ? 'Reativar cadastro' : 'Arquivar cadastro'}</Button>
            {isAdmin && <Button variant="danger" onClick={() => setErase(true)}>Eliminar definitivamente</Button>}
          </div>
        </div>
      </section>
      {erase && (
        <ConfirmDialog title="Eliminar dados do candidato" danger loading={busy} confirmLabel="Eliminar definitivamente" requireText="ELIMINAR"
          message={<Alert kind="warning">Esta ação é irreversível no sistema. Cópias em backups seguem a política de retenção dos backups (ver documentação). O registro de auditoria mantém apenas identificadores.</Alert>}
          onConfirm={doErase} onCancel={() => setErase(false)} />
      )}
    </div>
  );
}

function ApplicationsTab({ c }: { c: Candidate }) {
  const [adding, setAdding] = useState(false);
  const stages = useQuery({ queryKey: ['stages'], queryFn: () => api.get<{ items: Stage[] }>('/api/stages'), staleTime: Infinity });
  const stageName = (id: number) => stages.data?.items.find((s) => s.id === id)?.name ?? '';
  return (
    <section className="card">
      <div className="card-header">
        <h2>Participações em processos seletivos</h2>
        {!c.archivedAt && <Button variant="primary" onClick={() => setAdding(true)}>Incluir em processo</Button>}
      </div>
      {c.applications.length === 0 ? <Empty title="Ainda não participa de processos" /> : (
        <div className="table-wrap">
          <table className="table responsive">
            <thead><tr><th>Processo</th><th>Empresa</th><th>Etapa</th><th>Decisão</th><th>Responsável</th><th>Situação</th></tr></thead>
            <tbody>
              {c.applications.map((a) => (
                <tr key={a.id}>
                  <td data-label="Processo"><Link to={`/participacoes/${a.id}`}><strong>{a.processTitle}</strong></Link></td>
                  <td data-label="Empresa">{a.companyName}</td>
                  <td data-label="Etapa">{stageName(a.stageId)}</td>
                  <td data-label="Decisão"><DecisionBadge decision={a.decision} /></td>
                  <td data-label="Responsável">{a.ownerName ?? '—'}</td>
                  <td data-label="Situação"><StatusBadge status={a.processStatus} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {adding && <AddToProcessModal c={c} onClose={() => setAdding(false)} />}
    </section>
  );
}

function AddToProcessModal({ c, onClose }: { c: Candidate; onClose: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const processes = useQuery({ queryKey: ['processes-active'], queryFn: () => api.get<Page<ProcessRow>>('/api/processes?status=em_andamento&pageSize=100') });
  const [processId, setProcessId] = useState('');
  const [busy, setBusy] = useState(false);
  const already = new Set(c.applications.map((a) => a.processId));
  const add = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ id: string }>('/api/applications', { candidateId: c.id, processId });
      toast.success('Candidato incluído no processo.');
      nav(`/participacoes/${r.id}`);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Incluir em processo seletivo" onClose={onClose}
      footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" onClick={add} loading={busy} disabled={!processId}>Incluir</Button></>}>
      {processes.isLoading ? <Loading /> : (
        <SelectField label="Processo em andamento" value={processId} onChange={(e) => setProcessId(e.target.value)}
          hint="Uma participação própria é criada; nada do cadastro é compartilhado automaticamente.">
          <option value="">Selecione…</option>
          {processes.data?.items.filter((p) => !already.has(p.id)).map((p) => <option key={p.id} value={p.id}>{p.title} — {p.companyName}</option>)}
        </SelectField>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------------ documentos

function DocumentsTab({ c, initialApp }: { c: Candidate; initialApp: string | null }) {
  const { user, isAdmin } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<'curriculo' | 'documento' | 'outro'>('curriculo');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [preview, setPreview] = useState<DocumentRow | null>(null);
  const [removing, setRemoving] = useState<DocumentRow | null>(null);
  const openApps = c.applications.filter((a) => a.processStatus === 'em_andamento');
  const [appId, setAppId] = useState(initialApp && c.applications.some((a) => a.id === initialApp) ? initialApp : openApps[0]?.id ?? '');
  const links = useQuery({
    queryKey: ['app-docs', appId],
    queryFn: () => api.get<{ items: DocumentRow[] }>(`/api/applications/${appId}/documents`),
    enabled: !!appId,
  });
  const linkMap = new Map((links.data?.items ?? []).map((d) => [d.id, d.sharedWithClient]));

  const doUpload = async () => {
    const f = fileRef.current?.files?.[0];
    if (!f) return;
    setUploading(true);
    setUploadError(null);
    const fd = new FormData();
    fd.append('kind', kind); // campo antes do arquivo (lido pelo servidor em streaming)
    fd.append('file', f);
    try {
      await api.post(`/api/candidates/${c.id}/documents`, fd);
      toast.success('Documento enviado.');
      if (fileRef.current) fileRef.current.value = '';
      await qc.invalidateQueries({ queryKey: ['candidate', c.id] });
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : 'Falha no envio.');
    } finally {
      setUploading(false);
    }
  };

  const setLink = async (d: DocumentRow, shared: boolean | null) => {
    try {
      if (shared === null) await api.delete(`/api/applications/${appId}/documents/${d.id}`);
      else await api.put(`/api/applications/${appId}/documents/${d.id}`, { sharedWithClient: shared });
      await qc.invalidateQueries({ queryKey: ['app-docs', appId] });
      toast.success(shared === null ? 'Documento desvinculado.' : shared ? 'Documento compartilhado com o cliente.' : 'Documento vinculado (interno).');
    } catch (e) {
      toast.error(e);
    }
  };

  const doRemove = async () => {
    if (!removing) return;
    try {
      await api.delete(`/api/documents/${removing.id}`);
      toast.success('Documento removido definitivamente.');
      setRemoving(null);
      await qc.invalidateQueries({ queryKey: ['candidate', c.id] });
      await qc.invalidateQueries({ queryKey: ['app-docs'] });
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <div className="stack">
      <section className="card">
        <div className="card-header"><h2>Enviar documento</h2></div>
        <div className="card-body stack">
          <div className="grid grid-3">
            <SelectField label="Tipo" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              {Object.entries(docKindLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </SelectField>
            <div className="field" style={{ gridColumn: 'span 2' }}>
              <label htmlFor="file-input">Arquivo</label>
              <input id="file-input" ref={fileRef} type="file" className="input" accept=".pdf,.doc,.docx,.odt,.png,.jpg,.jpeg" aria-describedby="file-hint" />
              <span id="file-hint" className="hint">PDF, DOC, DOCX, ODT, PNG ou JPG, até 10 MB. O conteúdo é conferido no servidor. Não há verificação antivírus nesta versão.</span>
            </div>
          </div>
          {uploadError && <Alert>{uploadError}</Alert>}
          <div className="form-actions"><Button variant="primary" onClick={doUpload} loading={uploading}>Enviar</Button></div>
        </div>
      </section>

      <section className="card">
        <div className="card-header">
          <h2>Arquivos do candidato</h2>
          {c.applications.length > 0 && (
            <div style={{ minWidth: 260 }}>
              <SelectField label="Compartilhamento na participação" value={appId} onChange={(e) => setAppId(e.target.value)}>
                {c.applications.map((a) => <option key={a.id} value={a.id}>{a.processTitle} — {a.companyName}</option>)}
              </SelectField>
            </div>
          )}
        </div>
        {c.documents.length === 0 ? <Empty title="Nenhum documento enviado" /> : (
          <div className="table-wrap">
            <table className="table responsive">
              <thead><tr><th>Arquivo</th><th>Tipo</th><th>Tamanho</th><th>Enviado</th>{appId && <th>Nesta participação</th>}<th className="actions">Ações</th></tr></thead>
              <tbody>
                {c.documents.map((d) => {
                  const state = linkMap.has(d.id) ? (linkMap.get(d.id) ? 'shared' : 'linked') : 'none';
                  const appOpen = c.applications.find((a) => a.id === appId)?.processStatus === 'em_andamento';
                  return (
                    <tr key={d.id}>
                      <td data-label="Arquivo">{d.name}</td>
                      <td data-label="Tipo">{docKindLabel[d.kind]}</td>
                      <td data-label="Tamanho">{fmtSize(d.size)}</td>
                      <td data-label="Enviado">{fmtDateTime(d.createdAt)}<span className="muted small" style={{ display: 'block' }}>{d.uploadedByName}</span></td>
                      {appId && (
                        <td data-label="Nesta participação">
                          {state === 'shared' ? <span className="badge badge-shared">Compartilhado com o cliente</span> : state === 'linked' ? <span className="badge badge-internal">Vinculado (interno)</span> : <span className="badge">Não vinculado</span>}
                          {appOpen && (
                            <div className="row" style={{ marginTop: 6, gap: 4 }}>
                              {state !== 'shared' && <Button size="sm" onClick={() => setLink(d, true)}>Compartilhar</Button>}
                              {state === 'none' && <Button size="sm" onClick={() => setLink(d, false)}>Vincular interno</Button>}
                              {state === 'shared' && <Button size="sm" onClick={() => setLink(d, false)}>Parar de compartilhar</Button>}
                              {state !== 'none' && <Button size="sm" variant="ghost" onClick={() => setLink(d, null)}>Desvincular</Button>}
                            </div>
                          )}
                        </td>
                      )}
                      <td className="actions">
                        <Button size="sm" onClick={() => setPreview(d)}>Visualizar</Button>{' '}
                        <a className="btn btn-sm" href={`/api/documents/${d.id}/content?download=1`}>Baixar</a>
                        {(isAdmin || d.uploadedBy === user?.id) && <>{' '}<Button size="sm" variant="danger" onClick={() => setRemoving(d)}>Remover</Button></>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {preview && <DocumentPreview doc={preview} onClose={() => setPreview(null)} />}
      {removing && (
        <ConfirmDialog title="Remover documento" danger confirmLabel="Remover definitivamente"
          message={<>Remover <strong>{removing.name}</strong>? O arquivo é apagado do armazenamento e deixa de estar disponível em todas as participações.</>}
          onConfirm={doRemove} onCancel={() => setRemoving(null)} />
      )}
    </div>
  );
}
