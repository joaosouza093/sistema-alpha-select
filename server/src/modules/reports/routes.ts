import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../lib/context.js';
import { asUser, isAdmin, isAlpha, requireUser } from '../../lib/context.js';
import { AppError, forbidden } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { zUuid } from '../../lib/normalize.js';

const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida.').refine((v) => !Number.isNaN(Date.parse(v)), 'Data inválida.');

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/**
 * Relatórios gerenciais (Marco 6). Todos os números saem de uma mesma base:
 * as participações criadas no período, filtradas por empresa/processo e
 * limitadas pela RLS ao que o usuário vê. Assim cada total é reproduzível a
 * partir dos registros operacionais e dos filtros exibidos.
 * Financeiro e mensagens: somente administradores.
 */
export function registerReportRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/api/reports', async (req) => {
    const u = requireUser(req);
    if (!isAlpha(u)) throw forbidden();
    const q = parse(
      z
        .object({ from: zDate, to: zDate, companyId: zUuid.optional(), processId: zUuid.optional() })
        .strict()
        .refine((v) => v.from <= v.to, { message: 'A data inicial deve ser anterior à final.', path: ['from'] }),
      req.query,
    );
    const days = (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000;
    if (days > 731) throw new AppError(422, 'invalid', 'Escolha um período de até 2 anos.');

    return asUser(deps, req, async (db, user) => {
      // Base comum: uma linha por participação criada no período (horário de Brasília).
      const base = `
        with base as (
          select a.id, a.process_id, p.title as process_title, p.company_id, co.name as company_name,
                 a.source, a.created_at, a.sent_at, a.sent_by, a.decision, a.decision_reason,
                 e.triage_status, e.reason as triage_reason, e.evaluated_by,
                 case when a.decision <> 'pendente' then (
                   select max(h.created_at) from application_history h
                    where h.application_id = a.id and h.to_decision = a.decision) end as decided_at
            from applications a
            join processes p on p.id = a.process_id
            join companies co on co.id = p.company_id
            left join application_evaluations e on e.application_id = a.id
           where a.created_at >= ($1::date)::timestamp at time zone 'America/Sao_Paulo'
             and a.created_at < ($2::date + 1)::timestamp at time zone 'America/Sao_Paulo'
             and ($3::uuid is null or p.company_id = $3)
             and ($4::uuid is null or a.process_id = $4)
        )`;
      const params = [q.from, q.to, q.companyId ?? null, q.processId ?? null];
      const metrics = `
        count(*)::int as applications,
        count(*) filter (where triage_status in ('aprovado_interno', 'reprovado_interno'))::int as screened,
        count(*) filter (where triage_status = 'aprovado_interno')::int as "approvedInternal",
        count(*) filter (where triage_status = 'reprovado_interno')::int as "rejectedInternal",
        count(*) filter (where sent_at is not null)::int as sent,
        count(*) filter (where sent_at is not null and decision = 'pendente')::int as "awaitingFeedback",
        count(*) filter (where decision = 'aprovado')::int as hired,
        count(*) filter (where decision in ('reprovado', 'desistiu'))::int as "rejectedClient",
        round(avg(extract(epoch from (sent_at - created_at)) / 86400)::numeric, 1)::float as "avgDaysToSend",
        round(avg(extract(epoch from (decided_at - sent_at)) / 86400)
              filter (where sent_at is not null and decided_at is not null)::numeric, 1)::float as "avgResponseDays"`;

      const [summary, byCompany, byProcess, bySource, byMonth, byRecruiter, triageReasons, clientReasons] = await Promise.all([
        db.query(`${base} select ${metrics} from base`, params),
        db.query(
          `${base} select company_id as id, company_name as name, ${metrics}
             from base group by company_id, company_name order by count(*) desc, company_name limit 200`,
          params,
        ),
        db.query(
          `${base} select process_id as id, process_title as name, company_name as "companyName", ${metrics}
             from base group by process_id, process_title, company_name order by count(*) desc, process_title limit 200`,
          params,
        ),
        db.query(`${base} select source as id, ${metrics} from base group by source order by source`, params),
        db.query(
          `${base} select to_char(date_trunc('month', created_at at time zone 'America/Sao_Paulo'), 'YYYY-MM') as id, ${metrics}
             from base group by 1 order by 1`,
          params,
        ),
        // Produtividade: quem triou e quem enviou (pessoas diferentes podem aparecer em cada coluna).
        db.query(
          `${base}, people as (
             select evaluated_by as uid from base where evaluated_by is not null
             union select sent_by from base where sent_by is not null)
           select pe.uid as id, app.person_label(pe.uid) as name,
                  (select count(*) from base b where b.evaluated_by = pe.uid
                     and b.triage_status in ('aprovado_interno', 'reprovado_interno'))::int as screened,
                  (select count(*) from base b where b.sent_by = pe.uid)::int as sent,
                  (select count(*) from base b where b.sent_by = pe.uid and b.decision = 'aprovado')::int as hired,
                  (select round(avg(extract(epoch from (b.sent_at - b.created_at)) / 86400)::numeric, 1)::float
                     from base b where b.sent_by = pe.uid) as "avgDaysToSend"
             from people pe order by 4 desc, 3 desc, 2`,
          params,
        ),
        db.query(
          `${base} select triage_reason as reason, count(*)::int as count from base
            where triage_status = 'reprovado_interno' group by 1 order by 2 desc`,
          params,
        ),
        db.query(
          `${base} select coalesce(decision_reason, 'outro') as reason, count(*)::int as count from base
            where decision in ('reprovado', 'desistiu') group by 1 order by 2 desc`,
          params,
        ),
      ]);

      let messages = null;
      let finance = null;
      if (isAdmin(user)) {
        const m = await db.query(
          `select l.template_key as id, count(*)::int as total, count(*) filter (where l.ok)::int as delivered,
                  count(*) filter (where not l.ok)::int as failed
             from message_log l
             left join applications a on a.id = l.application_id
             left join processes p on p.id = a.process_id
            where l.sent_at >= ($1::date)::timestamp at time zone 'America/Sao_Paulo'
              and l.sent_at < ($2::date + 1)::timestamp at time zone 'America/Sao_Paulo'
              and ($3::uuid is null or p.company_id = $3)
              and ($4::uuid is null or a.process_id = $4)
            group by 1 order by 2 desc`,
          params,
        );
        const optOut = await db.query<{ n: number }>(
          `select count(*)::int as n from candidates
            where email_opt_out_at >= ($1::date)::timestamp at time zone 'America/Sao_Paulo'
              and email_opt_out_at < ($2::date + 1)::timestamp at time zone 'America/Sao_Paulo'`,
          [q.from, q.to],
        );
        messages = { byTemplate: m.rows, optOuts: optOut.rows[0]?.n ?? 0 };

        // Financeiro por empresa: cobranças com vencimento no período (o processo não se aplica).
        const f = await db.query(
          `select co.id, co.name,
                  coalesce(sum(c.amount_cents), 0)::bigint as "billedCents",
                  coalesce(sum(c.amount_cents) filter (where c.status = 'pago'), 0)::bigint as "paidCents",
                  coalesce(sum(c.amount_cents) filter (where c.status = 'pendente' and c.due_date < (now() at time zone 'America/Sao_Paulo')::date), 0)::bigint as "overdueCents",
                  coalesce(sum(c.amount_cents) filter (where c.status = 'pendente' and c.due_date >= (now() at time zone 'America/Sao_Paulo')::date), 0)::bigint as "openCents",
                  round(avg((c.paid_at at time zone 'America/Sao_Paulo')::date - c.due_date)
                        filter (where c.status = 'pago')::numeric, 1)::float as "avgPayDelayDays"
             from charges c join companies co on co.id = c.company_id
            where c.status <> 'cancelado' and c.due_date between $1::date and $2::date
              and ($3::uuid is null or c.company_id = $3)
            group by co.id, co.name order by 3 desc, co.name`,
          [q.from, q.to, q.companyId ?? null],
        );
        const rows = f.rows.map((r) => ({
          ...r,
          billedCents: Number(r.billedCents),
          paidCents: Number(r.paidCents),
          overdueCents: Number(r.overdueCents),
          openCents: Number(r.openCents),
          avgPayDelayDays: num(r.avgPayDelayDays),
        }));
        const sum = (k: 'billedCents' | 'paidCents' | 'overdueCents' | 'openCents') => rows.reduce((s, r) => s + r[k], 0);
        const due = sum('paidCents') + sum('overdueCents');
        finance = {
          byCompany: rows,
          totals: {
            billedCents: sum('billedCents'),
            paidCents: sum('paidCents'),
            overdueCents: sum('overdueCents'),
            openCents: sum('openCents'),
            // Adimplência: pago sobre o que já venceu (pago + vencido em aberto).
            complianceRate: due > 0 ? Math.round((sum('paidCents') / due) * 1000) / 10 : null,
          },
        };
      }

      return {
        filters: q,
        summary: summary.rows[0],
        byCompany: byCompany.rows,
        byProcess: byProcess.rows,
        bySource: bySource.rows,
        byMonth: byMonth.rows,
        byRecruiter: byRecruiter.rows,
        triageReasons: triageReasons.rows,
        clientReasons: clientReasons.rows,
        messages,
        finance,
      };
    });
  });
}
