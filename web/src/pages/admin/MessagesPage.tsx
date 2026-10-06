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
    queryFn: () =>
      api.get<{
        items: MessageTemplate[]; variables: string[]; emailEnabled: boolean;
        whatsapp: { configured: boolean; webhookConfigured: boolean; webhookUrl: string };
      }>('/api/message-templates'),
  });
  const [page, setPage] = useState(1);
  const log = useQuery({ queryKey: ['message-log', page], queryFn: () => api.get<Page<MessageLogRow>>(`/api/message-log${qs({ page, pageSize: 20 })}`) });

  return (
    <>
      <PageHeader title="Mensagens ao candidato" subtitle="Avisos automáticos por e-mail e WhatsApp em cada etapa. O candidato pode cancelar o e-mail pelo link no rodapé e o WhatsApp respondendo SAIR." />
      <div className="stack">
        {tpl.data && !tpl.data.emailEnabled && (
          <Alert kind="warning">O envio de e-mail não está configurado no servidor (SMTP_USER e SMTP_PASSWORD): nenhuma mensagem sai até configurar.</Alert>
        )}
        {tpl.data && (
          tpl.data.whatsapp.configured ? (
            <Alert kind="info">
              WhatsApp conectado. Só recebe quem autorizou (formulário de candidatura ou Meus dados). Para os status de
              entrega e o "SAIR", cadastre na Meta o webhook <code>{tpl.data.whatsapp.webhookUrl}</code>
              {!tpl.data.whatsapp.webhookConfigured && <> — <strong>faltam WHATSAPP_APP_SECRET e WHATSAPP_VERIFY_TOKEN no servidor</strong></>}.
            </Alert>
          ) : (
            <p className="muted small" style={{ margin: 0 }}>
              WhatsApp desligado: depende da conta oficial do WhatsApp Business na Meta e das variáveis WHATSAPP_TOKEN e
              WHATSAPP_PHONE_NUMBER_ID no servidor (passo a passo em docs/WHATSAPP.md).
            </p>
          )
        )}
        {tpl.isLoading ? <Loading /> : tpl.isError ? <ErrorState error={tpl.error} /> : (
          <>
            <p className="muted small" style={{ margin: 0 }}>
              Variáveis: {tpl.data!.variables.map((v) => <code key={v} style={{ marginRight: 6 }}>{`{{${v}}}`}</code>)}
              — “empresa” mostra o nome só quando a vaga não é confidencial.
            </p>
            <div className="grid grid-2">
              {tpl.data!.items.map((t) => <TemplateCard key={`${t.key}-${t.updatedAt}`} t={t} whatsapp={tpl.data!.whatsapp.configured} />)}
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
                  <thead><tr><th>Quando</th><th>Candidato</th><th>Canal</th><th>Mensagem</th><th>Assunto</th><th>Resultado</th></tr></thead>
                  <tbody>
                    {log.data!.items.map((m) => (
                      <tr key={m.id}>
                        <td data-label="Quando">{fmtDateTime(m.sentAt)}</td>
                        <td data-label="Candidato"><Link to={`/candidatos/${m.candidateId}`}>{m.candidateName}</Link><div className="muted small">{m.to}</div></td>
                        <td data-label="Canal">{m.channel === 'whatsapp' ? 'WhatsApp' : 'E-mail'}</td>
                        <td data-label="Mensagem">{templateLabel[m.templateKey] ?? m.templateKey}</td>
                        <td data-label="Assunto">{m.subject}</td>
                        <td data-label="Resultado">{m.ok ? <span className="badge badge-success">{m.deliveryStatus && m.deliveryStatus !== 'enviada' ? m.deliveryStatus : 'enviado'}</span> : <span className="badge badge-danger">{m.error ?? 'falhou'}</span>}</td>
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

function TemplateCard({ t, whatsapp }: { t: MessageTemplate; whatsapp: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [enabled, setEnabled] = useState(t.enabled);
  const [subject, setSubject] = useState(t.subject);
  const [body, setBody] = useState(t.body);
  const [waEnabled, setWaEnabled] = useState(t.waEnabled);
  const [waTemplate, setWaTemplate] = useState(t.waTemplate ?? '');
  const [waLanguage, setWaLanguage] = useState(t.waLanguage);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.put(`/api/message-templates/${t.key}`, { enabled, subject, body, waEnabled, waTemplate: waTemplate.trim() || null, waLanguage });
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
      <div className="card-header">
        <h2>{templateLabel[t.key]}</h2>
        <div className="row">
          {enabled ? <span className="badge badge-success">E-mail</span> : <span className="badge">E-mail desligado</span>}
          {whatsapp && (waEnabled ? <span className="badge badge-success">WhatsApp</span> : <span className="badge">WhatsApp desligado</span>)}
        </div>
      </div>
      <div className="card-body stack">
        <Checkbox label="Enviar por e-mail automaticamente" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <TextField label="Assunto" value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} error={errors.subject} />
        <TextArea label="Texto" value={body} rows={7} maxLength={5000} onChange={(e) => setBody(e.target.value)} error={errors.body} />
        {whatsapp && (
          <fieldset className="question">
            <legend>WhatsApp</legend>
            <div className="stack">
              <Checkbox label="Enviar também pelo WhatsApp (a quem autorizou)" checked={waEnabled} onChange={(e) => setWaEnabled(e.target.checked)} />
              <div className="grid grid-2">
                <TextField label="Nome do modelo aprovado na Meta" value={waTemplate} placeholder="ex.: candidatura_recebida"
                  onChange={(e) => setWaTemplate(e.target.value.toLowerCase())} error={errors.waTemplate} />
                <TextField label="Idioma do modelo" value={waLanguage} onChange={(e) => setWaLanguage(e.target.value)} error={errors.waLanguage} />
              </div>
              <span className="muted small">
                Crie o modelo na Meta com os parâmetros nesta ordem:{' '}
                {t.waParams.map((v, i) => <code key={v} style={{ marginRight: 6 }}>{`{{${i + 1}}} = ${v}`}</code>)}
              </span>
            </div>
          </fieldset>
        )}
        <div><Button variant="primary" loading={busy} onClick={save}>Salvar</Button></div>
      </div>
    </section>
  );
}
