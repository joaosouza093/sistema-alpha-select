import type { Deps } from '../../lib/context.js';

export const templateKeys = ['candidatura_recebida', 'perfil_enviado', 'entrevista_agendada', 'reprovacao'] as const;
export type TemplateKey = (typeof templateKeys)[number];

/** Variáveis aceitas nos modelos ({{nome}}). */
export const templateVars = ['candidato', 'vaga', 'empresa', 'data_entrevista', 'formato', 'local'] as const;

export function render(text: string, vars: Record<string, string | null | undefined>) {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k: string) => (k in vars ? vars[k] ?? '' : m));
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim().slice(0, 200);

/**
 * Envia ao candidato a mensagem do modelo, se ativo, se houver e-mail, se o
 * candidato não se descadastrou e se o servidor tiver e-mail configurado.
 * Registra o resultado (sem o corpo). Nunca lança: falha de aviso não
 * interrompe a operação principal.
 */
export async function sendCandidateMessage(
  deps: Deps,
  key: TemplateKey,
  opts: { candidateId: string; applicationId?: string | null; vars?: Record<string, string | null | undefined> },
): Promise<'sent' | 'failed' | 'skipped'> {
  try {
    if (deps.config.mailMode === 'manual') return 'skipped';
    const owner = deps.pools.owner;
    const t = await owner.query<{ enabled: boolean; subject: string; body: string }>(
      'select enabled, subject, body from message_templates where key = $1',
      [key],
    );
    const tpl = t.rows[0];
    if (!tpl?.enabled) return 'skipped';
    const c = await owner.query<{ full_name: string; email: string | null; email_opt_out_at: Date | null; unsubscribe_token: string }>(
      'select full_name, email::text as email, email_opt_out_at, unsubscribe_token from candidates where id = $1',
      [opts.candidateId],
    );
    const cand = c.rows[0];
    if (!cand?.email || cand.email_opt_out_at) return 'skipped';
    let ctx: Record<string, string | null> = {};
    if (opts.applicationId) {
      const a = await owner.query<{ title: string; company: string | null }>(
        `select p.title, case when p.show_company then co.name end as company
           from applications a join processes p on p.id = a.process_id join companies co on co.id = p.company_id
          where a.id = $1`,
        [opts.applicationId],
      );
      if (a.rows[0]) ctx = { vaga: a.rows[0].title, empresa: a.rows[0].company ?? 'uma empresa parceira' };
    }
    const vars = { candidato: cand.full_name.split(' ')[0], ...ctx, ...opts.vars };
    const subject = oneLine(render(tpl.subject, vars));
    const base = deps.config.APP_URL.replace(/\/$/, '');
    const link = `${base}/descadastrar#token=${cand.unsubscribe_token}`;
    const text =
      `${render(tpl.body, vars)}\n\n—\nConsultar, corrigir ou excluir seus dados: ${base}/meus-dados\n` +
      `Para não receber mais e-mails sobre processos seletivos: ${link}`;
    let ok = true;
    let error: string | null = null;
    try {
      await deps.mailer.send({ to: cand.email, subject, text });
    } catch (e) {
      ok = false;
      const code = (e as { code?: string; responseCode?: number }).code ?? (e as { responseCode?: number }).responseCode;
      error = `falha no envio${code ? ` (${String(code).slice(0, 40)})` : ''}`;
    }
    await owner.query(
      `insert into message_log (template_key, candidate_id, application_id, to_address, subject, ok, error)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [key, opts.candidateId, opts.applicationId ?? null, cand.email, subject, ok, error],
    );
    return ok ? 'sent' : 'failed';
  } catch {
    return 'failed';
  }
}

/** Data/hora no fuso de Brasília, para mensagens. */
export const fmtDateTimeBR = (d: Date) =>
  new Intl.DateTimeFormat('pt-BR', { dateStyle: 'full', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(d);

export const modeLabel = { presencial: 'Presencial', online: 'On-line', telefone: 'Telefone' } as const;

/**
 * Lembrete diário aos participantes do cliente: participações enviadas,
 * sem decisão e paradas além do prazo do processo. No máximo um por
 * processo por dia, a partir das 9h (Brasília).
 */
export async function sendFeedbackReminders(deps: Deps, opts: { anyHour?: boolean } = {}) {
  if (deps.config.mailMode === 'manual') return 0;
  const owner = deps.pools.owner;
  const hour = await owner.query<{ h: number; d: string }>(
    `select extract(hour from now() at time zone 'America/Sao_Paulo')::int as h,
            to_char((now() at time zone 'America/Sao_Paulo')::date, 'YYYY-MM-DD') as d`,
  );
  if (hour.rows[0]!.h < 9 && !opts.anyHour) return 0;
  const today = hour.rows[0]!.d;
  const { rows } = await owner.query<{ process_id: string; title: string; n: number }>(
    `select p.id as process_id, p.title, count(*)::int as n
       from applications a
       join processes p on p.id = a.process_id
       join companies co on co.id = p.company_id
      where p.status = 'em_andamento' and co.is_active and a.sent_at is not null and a.decision = 'pendente'
        and a.stage_changed_at < now() - make_interval(days => p.sla_days)
        and not exists (select 1 from feedback_reminders f where f.process_id = p.id and f.sent_on = $1::date)
      group by p.id, p.title
      limit 100`,
    [today],
  );
  let sent = 0;
  for (const r of rows) {
    const ins = await owner.query('insert into feedback_reminders (process_id, sent_on) values ($1, $2::date) on conflict do nothing', [r.process_id, today]);
    if (!ins.rowCount) continue;
    const members = await owner.query<{ email: string; full_name: string }>(
      `select u.email::text as email, u.full_name from process_members m join users u on u.id = m.user_id
         join companies c on c.id = u.company_id
        where m.process_id = $1 and u.kind in ('client_user', 'client_manager') and u.is_active and c.is_active
          and (m.can_decide or m.can_move_stage)`,
      [r.process_id],
    );
    const link = `${deps.config.APP_URL.replace(/\/$/, '')}/processos/${r.process_id}`;
    for (const m of members.rows) {
      await deps.mailer
        .send({
          to: m.email,
          subject: `Retorno pendente — ${r.title}`,
          text:
            `Olá, ${m.full_name}.\n\n${r.n === 1 ? 'Há 1 candidato aguardando' : `Há ${r.n} candidatos aguardando`} seu retorno na vaga "${r.title}" além do prazo combinado.\n` +
            `Acesse para registrar sua decisão:\n\n${link}\n\nAlpha Select Consultoria de Recursos Humanos`,
        })
        .then(() => sent++)
        .catch(() => undefined);
    }
  }
  return sent;
}
