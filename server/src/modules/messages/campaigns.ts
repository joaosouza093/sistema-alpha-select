import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../lib/context.js';
import { asUser, audit, isAlpha, requireUser } from '../../lib/context.js';
import { AppError, conflict, forbidden, notFound } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { zPage, zText, zUuid } from '../../lib/normalize.js';
import { render } from './service.js';

/** Variáveis aceitas nos comunicados. */
export const campaignVars = ['candidato', 'nome_completo', 'vaga', 'empresa'] as const;
const MAX_RECIPIENTS = 500;

/**
 * Envia os comunicados vencidos (ou só o indicado), destinatário por
 * destinatário, dentro do tempo disponível. Cada destinatário é "reservado"
 * antes do envio, então duas execuções simultâneas nunca mandam em dobro.
 */
export async function runCampaigns(deps: Deps, opts: { campaignId?: string; budgetMs?: number } = {}) {
  const started = Date.now();
  const budget = opts.budgetMs ?? 20_000;
  const owner = deps.pools.owner;
  const result = { sent: 0, failed: 0, skipped: 0, pending: 0 };
  if (deps.config.mailMode === 'manual') return result;
  const due = await owner.query<{ id: string; subject: string; body: string; process_title: string | null; company: string | null }>(
    `update message_campaigns m set status = 'enviando'
       from message_campaigns x
       left join processes p on p.id = x.process_id
       left join companies co on co.id = p.company_id
      where m.id = x.id and m.status in ('agendada', 'enviando') and m.scheduled_at <= now()
        and ($1::uuid is null or m.id = $1)
      returning m.id, m.subject, m.body, p.title as process_title, case when p.show_company then co.name end as company`,
    [opts.campaignId ?? null],
  );
  const base = deps.config.APP_URL.replace(/\/$/, '');
  for (const m of due.rows) {
    for (;;) {
      if (Date.now() - started > budget) break;
      const next = await owner.query<{
        candidate_id: string; full_name: string; email: string | null; email_opt_out_at: Date | null; unsubscribe_token: string;
        application_id: string | null; title: string | null; company: string | null;
      }>(
        // Reserva um destinatário (marca como enviado antes de enviar: no máximo uma vez).
        `update message_campaign_recipients r set status = 'enviado', sent_at = now()
           from candidates c
          where r.campaign_id = $1 and r.candidate_id = c.id
            and r.candidate_id = (select candidate_id from message_campaign_recipients
                                   where campaign_id = $1 and status = 'pendente' limit 1 for update skip locked)
          returning r.candidate_id, c.full_name, c.email::text as email, c.email_opt_out_at, c.unsubscribe_token, r.application_id,
                    (select p.title from applications a join processes p on p.id = a.process_id where a.id = r.application_id) as title,
                    (select case when p.show_company then co.name end from applications a join processes p on p.id = a.process_id
                       join companies co on co.id = p.company_id where a.id = r.application_id) as company`,
        [m.id],
      );
      const r = next.rows[0];
      if (!r) break;
      const mark = (status: 'falhou' | 'ignorado', detail: string) =>
        owner.query('update message_campaign_recipients set status = $3, detail = $4 where campaign_id = $1 and candidate_id = $2', [
          m.id, r.candidate_id, status, detail,
        ]);
      if (!r.email) {
        await mark('ignorado', 'sem e-mail');
        result.skipped++;
        continue;
      }
      if (r.email_opt_out_at) {
        await mark('ignorado', 'descadastrado dos e-mails');
        result.skipped++;
        continue;
      }
      const vars = {
        candidato: r.full_name.split(' ')[0],
        nome_completo: r.full_name,
        vaga: r.title ?? m.process_title ?? '',
        empresa: r.company ?? m.company ?? 'uma empresa parceira',
      };
      const subject = render(m.subject, vars).replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
      const text =
        `${render(m.body, vars)}\n\n—\nConsultar, corrigir ou excluir seus dados: ${base}/meus-dados\n` +
        `Para não receber mais e-mails sobre processos seletivos: ${base}/descadastrar#token=${r.unsubscribe_token}`;
      let error: string | null = null;
      try {
        await deps.mailer.send({ to: r.email, subject, text });
      } catch (e) {
        const code = (e as { code?: string; responseCode?: number }).code ?? (e as { responseCode?: number }).responseCode;
        error = `falha no envio${code ? ` (${String(code).slice(0, 40)})` : ''}`;
      }
      if (error) {
        await mark('falhou', error);
        result.failed++;
      } else result.sent++;
      await owner.query(
        `insert into message_log (channel, template_key, candidate_id, application_id, to_address, subject, ok, error)
         values ('email', 'comunicado', $1, $2, $3, $4, $5, $6)`,
        [r.candidate_id, r.application_id, r.email, subject, !error, error],
      );
    }
    const left = await owner.query<{ n: number }>(
      `with c as (
         select count(*) filter (where status = 'enviado')::int as sent, count(*) filter (where status = 'falhou')::int as failed,
                count(*) filter (where status = 'ignorado')::int as skipped, count(*) filter (where status = 'pendente')::int as pending
           from message_campaign_recipients where campaign_id = $1)
       update message_campaigns set sent = c.sent, failed = c.failed, skipped = c.skipped,
              status = case when c.pending = 0 and status = 'enviando' then 'enviada' else status end,
              finished_at = case when c.pending = 0 then coalesce(finished_at, now()) else finished_at end
         from c where id = $1
       returning c.pending as n`,
      [m.id],
    );
    result.pending += left.rows[0]?.n ?? 0;
  }
  return result;
}

const campaignCols = `m.id, m.subject, m.body, m.process_id as "processId", p.title as "processTitle", m.scheduled_at as "scheduledAt",
  m.status, m.total, m.sent, m.failed, m.skipped, m.created_at as "createdAt", m.finished_at as "finishedAt",
  m.canceled_at as "canceledAt", app.person_label(m.created_by) as "createdByName"`;

export function registerCampaignRoutes(app: FastifyInstance, deps: Deps) {
  const alphaOnly = (req: FastifyRequest) => {
    const u = requireUser(req);
    if (!isAlpha(u)) throw forbidden();
    return u;
  };

  app.get('/api/campaigns', async (req) => {
    alphaOnly(req);
    const q = parse(zPage, req.query);
    return asUser(deps, req, async (db) => {
      const total = await db.query<{ n: number }>('select count(*)::int as n from message_campaigns');
      const { rows } = await db.query(
        `select ${campaignCols} from message_campaigns m left join processes p on p.id = m.process_id
          order by (m.status in ('agendada', 'enviando')) desc, m.scheduled_at desc limit $1 offset $2`,
        [q.pageSize, (q.page - 1) * q.pageSize],
      );
      return { items: rows, total: total.rows[0]!.n, page: q.page, pageSize: q.pageSize, emailEnabled: deps.config.mailMode !== 'manual', variables: campaignVars };
    });
  });

  app.get('/api/campaigns/:id', async (req) => {
    alphaOnly(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return asUser(deps, req, async (db) => {
      const { rows } = await db.query(`select ${campaignCols} from message_campaigns m left join processes p on p.id = m.process_id where m.id = $1`, [id]);
      if (!rows[0]) throw notFound('Comunicado não encontrado.');
      const rec = await db.query(
        `select r.candidate_id as "candidateId", c.full_name as "fullName", c.email, r.status, r.detail, r.sent_at as "sentAt"
           from message_campaign_recipients r join candidates c on c.id = r.candidate_id
          where r.campaign_id = $1 order by (r.status = 'falhou') desc, c.full_name limit 500`,
        [id],
      );
      return { ...rows[0], recipients: rec.rows };
    });
  });

  /**
   * Cria o comunicado. Destinatários: candidatos escolhidos e/ou todos os
   * candidatos de um processo (opcionalmente de uma etapa). Sem data, sai na
   * hora; com data, a tarefa periódica envia (até 1 hora após o horário).
   */
  app.post('/api/campaigns', async (req, reply) => {
    alphaOnly(req);
    if (deps.config.mailMode === 'manual') throw new AppError(422, 'invalid', 'Envio de e-mail não configurado no servidor (SMTP).');
    const body = parse(
      z
        .object({
          subject: zText(3, 200),
          body: zText(10, 5000),
          candidateIds: z.array(zUuid).max(MAX_RECIPIENTS).default([]),
          processId: zUuid.nullish(),
          stageId: z.number().int().min(1).max(10).nullish(),
          onlyPending: z.boolean().default(false),
          scheduledAt: z.iso.datetime({ offset: true, message: 'Data inválida.' }).nullish(),
        })
        .strict()
        .refine((b) => b.candidateIds.length > 0 || b.processId, { message: 'Escolha os destinatários.', path: ['candidateIds'] }),
      req.body,
    );
    const when = body.scheduledAt ? new Date(body.scheduledAt) : null;
    if (when && when.getTime() > Date.now() + 366 * 86_400_000) throw new AppError(422, 'invalid', 'Agende para no máximo 1 ano à frente.');
    const created = await asUser(deps, req, async (db) => {
      if (body.processId) {
        const p = await db.query('select 1 from processes where id = $1', [body.processId]);
        if (!p.rowCount) throw notFound('Processo não encontrado.');
      }
      const { rows } = await db.query<{ id: string }>(
        `insert into message_campaigns (subject, body, process_id, scheduled_at, created_by)
         values ($1, $2, $3, coalesce($4::timestamptz, now()), app.uid()) returning id`,
        [body.subject, body.body, body.processId ?? null, when],
      );
      const id = rows[0]!.id;
      // Do processo (com a participação, para {{vaga}}); depois os escolhidos à mão. RLS filtra quem a pessoa não pode ver.
      if (body.processId) {
        await db.query(
          `insert into message_campaign_recipients (campaign_id, candidate_id, application_id)
           select $1, a.candidate_id, a.id from applications a join candidates c on c.id = a.candidate_id
            where a.process_id = $2 and c.archived_at is null and ($3::int is null or a.stage_id = $3)
              and (not $4::boolean or a.decision = 'pendente') and app.can_view_candidate(a.candidate_id)
            limit ${MAX_RECIPIENTS}
           on conflict do nothing`,
          [id, body.processId, body.stageId ?? null, body.onlyPending],
        );
      }
      if (body.candidateIds.length) {
        await db.query(
          `insert into message_campaign_recipients (campaign_id, candidate_id)
           select $1, c.id from candidates c where c.id = any($2::uuid[]) and app.can_view_candidate(c.id)
           on conflict do nothing`,
          [id, body.candidateIds],
        );
      }
      const n = await db.query<{ n: number }>('select count(*)::int as n from message_campaign_recipients where campaign_id = $1', [id]);
      const total = n.rows[0]!.n;
      if (!total) throw new AppError(422, 'invalid', 'Nenhum destinatário encontrado.');
      if (total > MAX_RECIPIENTS) throw new AppError(422, 'invalid', `Máximo de ${MAX_RECIPIENTS} destinatários por comunicado.`);
      await db.query('update message_campaigns set total = $2 where id = $1', [id, total]);
      await audit(db, req, 'campaign.created', 'campaign', id, null, { total, scheduled: !!when, processId: body.processId ?? null });
      return { id, total };
    });
    const now = !when || when.getTime() <= Date.now();
    const sent = now ? await runCampaigns(deps, { campaignId: created.id, budgetMs: 6000 }).catch(() => null) : null;
    reply.code(201);
    return { ...created, scheduled: !now, result: sent };
  });

  app.post('/api/campaigns/:id/cancel', async (req) => {
    alphaOnly(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return asUser(deps, req, async (db) => {
      const cur = await db.query<{ status: string }>('select status from message_campaigns where id = $1', [id]);
      if (!cur.rows[0]) throw notFound('Comunicado não encontrado.');
      if (cur.rows[0].status !== 'agendada') throw conflict('Só é possível cancelar comunicados ainda não enviados.');
      const r = await db.query("update message_campaigns set status = 'cancelada', canceled_at = now() where id = $1 and status = 'agendada'", [id]);
      if (!r.rowCount) throw conflict('O envio já começou.');
      await audit(db, req, 'campaign.canceled', 'campaign', id);
      return { ok: true };
    });
  });
}
