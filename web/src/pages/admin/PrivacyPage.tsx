import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { Alert, Button, Checkbox, Empty, ErrorState, Loading, PageHeader, TextField, fieldErrors, usePageTitle, useToast } from '../../components/ui';
import { fmtDate } from '../../lib/format';

interface Retention {
  settings: { retentionEnabled: boolean; retentionMonths: number; noticeDays: number; updatedAt: string };
  candidates: { id: string; fullName: string; lastActivity: string; noticeAt: string | null; noticeSent: boolean | null; deleteAfter: string | null }[];
  total: number;
  erasedLast30: number;
}

/** Privacidade (LGPD): prazo de retenção do banco de talentos. */
export function PrivacyPage() {
  usePageTitle('Privacidade (LGPD)');
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['privacy'], queryFn: () => api.get<Retention>('/api/privacy/retention') });
  const [f, setF] = useState({ enabled: false, months: '24', days: '30' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    const s = q.data?.settings;
    if (s) setF({ enabled: s.retentionEnabled, months: String(s.retentionMonths), days: String(s.noticeDays) });
  }, [q.data?.settings]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      await api.put('/api/privacy/retention', { retentionEnabled: f.enabled, retentionMonths: Number(f.months), noticeDays: Number(f.days) });
      toast.success(f.enabled ? 'Regra de retenção ativada. Ela roda automaticamente a cada hora.' : 'Regra de retenção desligada.');
      await qc.invalidateQueries({ queryKey: ['privacy'] });
    } catch (err) {
      setErrors(fieldErrors(err));
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  const keep = async (id: string) => {
    try {
      await api.post(`/api/privacy/retention/${id}/keep`);
      toast.success('Candidato mantido por mais um período.');
      await qc.invalidateQueries({ queryKey: ['privacy'] });
    } catch (err) {
      toast.error(err);
    }
  };

  const runNow = async () => {
    setRunning(true);
    try {
      const r = await api.post<{ noticed: number; erased: number; canceled: number }>('/api/privacy/retention/run');
      toast.success(`Executado: ${r.noticed} aviso(s), ${r.erased} exclusão(ões), ${r.canceled} aviso(s) cancelado(s).`);
      await qc.invalidateQueries({ queryKey: ['privacy'] });
    } catch (err) {
      toast.error(err);
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      <PageHeader title="Privacidade (LGPD)" subtitle="Prazo de guarda dos dados do banco de talentos e pedidos dos titulares." />
      {q.isLoading ? <Loading /> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
        <div className="stack">
          <div className="grid grid-2">
            <section className="card">
              <div className="card-header"><h2>Regra de retenção</h2></div>
              <form className="card-body stack" onSubmit={save} noValidate>
                <p className="muted small" style={{ margin: 0 }}>
                  Candidatos sem nenhuma atividade (cadastro, edição, candidatura, renovação) pelo prazo abaixo e fora de
                  processos em andamento recebem um e-mail avisando da exclusão, com um link para continuar no banco de
                  talentos. Sem resposta, os dados e currículos são excluídos definitivamente ao fim do aviso.
                </p>
                <Checkbox label="Ativar exclusão automática" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />
                <TextField label="Excluir após (meses sem atividade)" type="number" min={6} max={120} value={f.months}
                  onChange={(e) => setF({ ...f, months: e.target.value })} error={errors.retentionMonths} />
                <TextField label="Prazo do aviso antes da exclusão (dias)" type="number" min={7} max={90} value={f.days}
                  onChange={(e) => setF({ ...f, days: e.target.value })} error={errors.noticeDays} />
                <Alert kind="info">O prazo de guarda é uma decisão da Alpha Select (base legal e política de privacidade). Confirme com o jurídico antes de ativar.</Alert>
                <div className="form-actions"><Button type="submit" variant="primary" loading={busy}>Salvar</Button></div>
              </form>
            </section>
            <section className="card">
              <div className="card-header"><h2>Direitos do titular</h2></div>
              <div className="card-body stack">
                <p style={{ margin: 0 }}>
                  O próprio candidato consulta, corrige, atualiza o currículo, baixa ou exclui os dados em{' '}
                  <a href="/meus-dados" target="_blank" rel="noreferrer">/meus-dados</a>, com um link enviado ao e-mail dele.
                  Divulgue esse endereço na política de privacidade.
                </p>
                <p className="muted small" style={{ margin: 0 }}>
                  Pedidos por outros canais: abra o cadastro do candidato para exportar os dados completos (inclui anotações
                  internas) ou excluir definitivamente.
                </p>
                <div className="grid grid-2">
                  <div className="card stat"><div className="label">Sem atividade no prazo</div><div className="value">{q.data!.total}</div></div>
                  <div className="card stat"><div className="label">Excluídos pela regra (30 dias)</div><div className="value">{q.data!.erasedLast30}</div></div>
                </div>
              </div>
            </section>
          </div>

          <section className="card">
            <div className="card-header">
              <div>
                <h2>Candidatos sem atividade no prazo</h2>
                <span className="muted small">pelo prazo salvo; quem está em processo em andamento não aparece</span>
              </div>
              {q.data!.settings.retentionEnabled && <Button size="sm" loading={running} onClick={runNow}>Executar agora</Button>}
            </div>
            {q.data!.candidates.length === 0 ? <Empty title="Nenhum candidato fora do prazo" /> : (
              <div className="table-wrap">
                <table className="table responsive">
                  <thead><tr><th>Candidato</th><th>Última atividade</th><th>Aviso</th><th>Exclusão a partir de</th><th className="actions">Ações</th></tr></thead>
                  <tbody>
                    {q.data!.candidates.map((c) => (
                      <tr key={c.id}>
                        <td data-label="Candidato"><Link to={`/candidatos/${c.id}`}>{c.fullName}</Link></td>
                        <td data-label="Última atividade">{fmtDate(c.lastActivity)}</td>
                        <td data-label="Aviso">
                          {!c.noticeAt ? <span className="muted">na próxima execução</span>
                            : `${fmtDate(c.noticeAt)}${c.noticeSent ? ' (e-mail enviado)' : ' (sem e-mail)'}`}
                        </td>
                        <td data-label="Exclusão a partir de">{c.deleteAfter ? fmtDate(c.deleteAfter) : '—'}</td>
                        <td className="actions"><Button size="sm" onClick={() => keep(c.id)}>Manter</Button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );
}
