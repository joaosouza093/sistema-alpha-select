import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qs } from '../../api/client';
import type { MessageLogRow, MessageTemplate, Page } from '../../api/types';
import { Alert, Button, Checkbox, Empty, ErrorState, Loading, PageHeader, Pagination, TextArea, TextField, fieldErrors, usePageTitle, useToast } from '../../components/ui';
import { fmtDateTime, templateLabel } from '../../lib/format';

/** Modelos de e-mail ao candidato e histórico de envios (administrador). */
export function MessagesPage() {
  usePageTitle('Mensagens');
  const tpl = useQuery({
    queryKey: ['message-templates'],
    queryFn: () => api.get<{ items: MessageTemplate[]; variables: string[]; emailEnabled: boolean }>('/api/message-templates'),
  });
  const [page, setPage] = useState(1);
  const log = useQuery({ queryKey: ['message-log', page], queryFn: () => api.get<Page<MessageLogRow>>(`/api/message-log${qs({ page, pageSize: 20 })}`) });

  return (
    <>
      <PageHeader title="Mensagens ao candidato" subtitle="E-mails automáticos enviados aos candidatos em cada etapa. O candidato pode se descadastrar pelo link no rodapé." />
      <div className="stack">
        {tpl.data && !tpl.data.emailEnabled && (
          <Alert kind="warning">O envio de e-mail não está configurado no servidor (SMTP_USER e SMTP_PASSWORD): nenhuma mensagem sai até configurar.</Alert>
        )}
        {tpl.isLoading ? <Loading /> : tpl.isError ? <ErrorState error={tpl.error} /> : (
          <>
            <p className="muted small" style={{ margin: 0 }}>
              Variáveis: {tpl.data!.variables.map((v) => <code key={v} style={{ marginRight: 6 }}>{`{{${v}}}`}</code>)}
              — “empresa” mostra o nome só quando a vaga não é confidencial.
            </p>
            <div className="grid grid-2">
              {tpl.data!.items.map((t) => <TemplateCard key={`${t.key}-${t.updatedAt}`} t={t} />)}
            </div>
          </>
        )}
        <section className="card">
          <div className="card-header"><h2>Últimos envios</h2></div>
          {log.isLoading ? <Loading /> : log.isError ? <ErrorState error={log.error} /> : log.data!.items.length === 0 ? (
            <Empty title="Nenhuma mensagem enviada ainda" />
          ) : (
            <>
              <div className="table-wrap">
                <table className="table responsive">
                  <thead><tr><th>Quando</th><th>Candidato</th><th>Mensagem</th><th>Assunto</th><th>Resultado</th></tr></thead>
                  <tbody>
                    {log.data!.items.map((m) => (
                      <tr key={m.id}>
                        <td data-label="Quando">{fmtDateTime(m.sentAt)}</td>
                        <td data-label="Candidato"><Link to={`/candidatos/${m.candidateId}`}>{m.candidateName}</Link><div className="muted small">{m.to}</div></td>
                        <td data-label="Mensagem">{templateLabel[m.templateKey] ?? m.templateKey}</td>
                        <td data-label="Assunto">{m.subject}</td>
                        <td data-label="Resultado">{m.ok ? <span className="badge badge-success">enviado</span> : <span className="badge badge-danger">{m.error ?? 'falhou'}</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination page={page} pageSize={log.data!.pageSize} total={log.data!.total} onPage={setPage} />
            </>
          )}
        </section>
      </div>
    </>
  );
}

function TemplateCard({ t }: { t: MessageTemplate }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [enabled, setEnabled] = useState(t.enabled);
  const [subject, setSubject] = useState(t.subject);
  const [body, setBody] = useState(t.body);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.put(`/api/message-templates/${t.key}`, { enabled, subject, body });
      toast.success('Modelo salvo.');
      await qc.invalidateQueries({ queryKey: ['message-templates'] });
    } catch (e) {
      setErrors(fieldErrors(e));
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card">
      <div className="card-header"><h2>{templateLabel[t.key]}</h2>{enabled ? <span className="badge badge-success">Ativo</span> : <span className="badge">Desligado</span>}</div>
      <div className="card-body stack">
        <Checkbox label="Enviar automaticamente" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <TextField label="Assunto" value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} error={errors.subject} />
        <TextArea label="Texto" value={body} rows={7} maxLength={5000} onChange={(e) => setBody(e.target.value)} error={errors.body} />
        <div><Button variant="primary" loading={busy} onClick={save}>Salvar</Button></div>
      </div>
    </section>
  );
}
