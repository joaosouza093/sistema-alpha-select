import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../lib/context.js';
import { asUser, audit, isAdmin, requireUser } from '../../lib/context.js';
import { AppError, conflict, forbidden, notFound, staleVersion } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { Where } from '../../lib/sql.js';
import { likePattern, zOptionalEmail, zOptionalText, zPage, zText, zUuid } from '../../lib/normalize.js';
import { billingEmailEnabled, loadSettings, runBillingNotifications, sendNotice, todaySP } from './notify.js';
import { whatsappConfigured } from '../../lib/whatsapp.js';
import { AsaasError, applyPayment, asaasConfigured, asaasEnvironment, fetchPayment, gatewayActive, syncGateway, webhookAuthorized } from './asaas.js';

const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida.').refine((v) => !Number.isNaN(Date.parse(v)), 'Data inválida.');
const zCents = z.number().int('Valor inválido.').min(1, 'Informe o valor.').max(1_000_000_000, 'Valor muito alto.');
const zLink = z
  .string()
  .nullish()
  .transform((v) => (v ? v.trim() || null : null))
  .pipe(z.string().max(500).regex(/^https:\/\/\S+$/, 'O link deve começar com https://').nullable());

const chargeCols = `c.id, c.company_id as "companyId", co.name as "companyName", c.description,
  c.amount_cents as "amountCents", to_char(c.due_date, 'YYYY-MM-DD') as "dueDate", c.billing_email as "billingEmail",
  c.payment_link as "paymentLink", c.status, c.paid_at as "paidAt", c.paid_note as "paidNote", c.canceled_at as "canceledAt",
  c.reminders_paused as "remindersPaused", c.recurrence, c.series_index as "seriesIndex", c.created_at as "createdAt",
  c.version, c.gateway_id as "gatewayId", c.gateway_status as "gatewayStatus", c.gateway_error as "gatewayError",
  c.gateway_dirty as "gatewayPending", c.paid_via as "paidVia",
  case when c.status = 'pendente' and c.due_date < $1::date then 'vencida' else c.status::text end as situacao,
  (select json_build_object('kind', n.kind, 'sentAt', n.sent_at, 'ok', n.ok)
     from charge_notifications n where n.charge_id = c.id order by n.sent_at desc limit 1) as "lastNotice"`;

export function registerBillingRoutes(app: FastifyInstance, deps: Deps) {
  const adminOnly = (req: FastifyRequest) => {
    const u = requireUser(req);
    if (!isAdmin(u)) throw forbidden();
    return u;
  };

  /** Envio imediato (best-effort) dentro do tempo da requisição; o restante sai na tarefa agendada. */
  const sendSoon = (ids: string[]) =>
    runBillingNotifications(deps, { chargeIds: ids, budgetMs: 6000 }).catch(() => ({ sent: 0, failed: 0, pending: ids.length }));

  app.get('/api/billing/summary', async (req) => {
    adminOnly(req);
    const today = await todaySP(deps);
    return asUser(deps, req, async (db) => {
      const { rows } = await db.query(
        `select
           coalesce(sum(amount_cents) filter (where status = 'pendente' and due_date >= $1::date), 0)::bigint as "openCents",
           count(*) filter (where status = 'pendente' and due_date >= $1::date)::int as "openCount",
           coalesce(sum(amount_cents) filter (where status = 'pendente' and due_date < $1::date), 0)::bigint as "overdueCents",
           count(*) filter (where status = 'pendente' and due_date < $1::date)::int as "overdueCount",
           coalesce(sum(amount_cents) filter (where status = 'pago' and paid_at >= date_trunc('month', $1::date)), 0)::bigint as "paidMonthCents",
           count(*) filter (where status = 'pago' and paid_at >= date_trunc('month', $1::date))::int as "paidMonthCount"
         from charges`,
        [today],
      );
      const r = rows[0] as Record<string, string | number>;
      const settings = await db.query('select auto_email from billing_settings limit 1');
      return {
        openCents: Number(r.openCents),
        openCount: r.openCount,
        overdueCents: Number(r.overdueCents),
        overdueCount: r.overdueCount,
        paidMonthCents: Number(r.paidMonthCents),
        paidMonthCount: r.paidMonthCount,
        emailEnabled: billingEmailEnabled(deps),
        autoEmail: settings.rows[0]?.auto_email ?? false,
        today,
      };
    });
  });

  app.get('/api/billing/charges', async (req) => {
    adminOnly(req);
    const q = parse(
      zPage.extend({
        situacao: z.enum(['pendente', 'vencida', 'pago', 'cancelado', 'abertas']).optional(),
        companyId: zUuid.optional(),
        q: z.string().max(100).optional(),
      }),
      req.query,
    );
    const today = await todaySP(deps);
    return asUser(deps, req, async (db) => {
      const w = new Where();
      w.param(today); // $1 = hoje (usado em chargeCols)
      w.raw('$1::date is not null');
      if (q.situacao === 'vencida') w.raw("c.status = 'pendente' and c.due_date < $1::date");
      else if (q.situacao === 'pendente') w.raw("c.status = 'pendente' and c.due_date >= $1::date");
      else if (q.situacao === 'abertas') w.raw("c.status = 'pendente'");
      else if (q.situacao) w.add('c.status = ?::charge_status', q.situacao);
      if (q.companyId) w.add('c.company_id = ?', q.companyId);
      if (q.q) w.add('(c.description ilike ? or co.name ilike ?)', likePattern(q.q));
      const total = await db.query<{ n: number }>(
        `select count(*)::int as n from charges c join companies co on co.id = c.company_id ${w.clause}`,
        w.params,
      );
      const lim = w.param(q.pageSize);
      const off = w.param((q.page - 1) * q.pageSize);
      const { rows } = await db.query(
        `select ${chargeCols} from charges c join companies co on co.id = c.company_id ${w.clause}
          order by (c.status = 'pendente') desc, c.due_date asc, co.name limit ${lim} offset ${off}`,
        w.params,
      );
      return { items: rows, total: total.rows[0]!.n, page: q.page, pageSize: q.pageSize };
    });
  });

  app.get('/api/billing/charges/:id', async (req) => {
    adminOnly(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const today = await todaySP(deps);
    return asUser(deps, req, async (db) => {
      const { rows } = await db.query(
        `select ${chargeCols} from charges c join companies co on co.id = c.company_id where c.id = $2`,
        [today, id],
      );
      if (!rows[0]) throw notFound();
      const notices = await db.query(
        `select id, kind, sent_to as "sentTo", ok, error, sent_at as "sentAt", channel
           from charge_notifications where charge_id = $1 order by sent_at desc limit 100`,
        [id],
      );
      return { ...rows[0], notices: notices.rows };
    });
  });

  /**
   * Cria cobranças para uma ou várias empresas de uma vez (mesmo valor e
   * vencimento). O e-mail de cobrança vem do cadastro da empresa.
   */
  app.post('/api/billing/charges', async (req, reply) => {
    const admin = adminOnly(req);
    const body = parse(
      z
        .object({
          companyIds: z.array(zUuid).max(500).optional(),
          allActive: z.boolean().optional(),
          description: zText(2, 200),
          amountCents: zCents,
          dueDate: zDate,
          recurrence: z.enum(['nenhuma', 'mensal']).default('nenhuma'),
          paymentLink: zLink,
          billingEmail: zOptionalEmail,
        })
        .strict()
        .refine((b) => b.allActive || (b.companyIds && b.companyIds.length > 0), {
          message: 'Escolha ao menos uma empresa.',
          path: ['companyIds'],
        }),
      req.body,
    );
    const useGateway = await gatewayActive(deps);
    const ids = await asUser(deps, req, async (db) => {
      const companies = await db.query<{ id: string; name: string; email: string | null }>(
        `select co.id, co.name,
                coalesce(co.billing_email::text,
                  (select u.email::text from users u where u.company_id = co.id and u.is_active
                    order by (u.kind = 'client_manager') desc, u.created_at limit 1)) as email
           from companies co
          where co.is_active and ($1::boolean or co.id = any($2::uuid[]))
          order by co.name`,
        [body.allActive === true, body.companyIds ?? []],
      );
      if (!companies.rowCount) throw new AppError(422, 'invalid', 'Nenhuma empresa ativa selecionada.');
      if (!body.allActive && body.companyIds && companies.rowCount !== new Set(body.companyIds).size) {
        throw new AppError(422, 'invalid', 'Há empresas inativas ou inexistentes na seleção.');
      }
      const single = companies.rowCount === 1;
      const missing = companies.rows.filter((c) => !(single && body.billingEmail) && !c.email).map((c) => c.name);
      if (missing.length) {
        const err = new AppError(422, 'invalid', `Sem e-mail de cobrança: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? '…' : ''}. Cadastre o e-mail em Empresas clientes.`);
        throw err;
      }
      const batchId = companies.rowCount > 1 ? crypto.randomUUID() : null;
      const created: string[] = [];
      for (const c of companies.rows) {
        const { rows } = await db.query<{ id: string }>(
          `insert into charges (company_id, description, amount_cents, due_date, billing_email, payment_link,
                                recurrence, series_start, batch_id, created_by, gateway_dirty)
           values ($1, $2, $3, $4::date, $5, $6, $7, $4::date, $8, $9, $10) returning id`,
          [c.id, body.description, body.amountCents, body.dueDate, single && body.billingEmail ? body.billingEmail : c.email,
            body.paymentLink, body.recurrence, batchId, admin.id, useGateway],
        );
        created.push(rows[0]!.id);
        await audit(db, req, 'charge.created', 'charge', rows[0]!.id, c.id, {
          amountCents: body.amountCents, dueDate: body.dueDate, recurrence: body.recurrence, batch: !!batchId,
        });
      }
      return created;
    });
    // Gera boleto/Pix no Asaas antes do e-mail, para que o link de pagamento vá junto.
    const gateway = useGateway ? await syncGateway(deps, { chargeIds: ids, budgetMs: 6000 }).catch(() => null) : null;
    const sent = await sendSoon(ids);
    reply.code(201);
    return { ids, count: ids.length, emails: sent, gateway };
  });

  app.patch('/api/billing/charges/:id', async (req) => {
    adminOnly(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(
      z
        .object({
          expectedVersion: z.number().int(),
          description: zText(2, 200).optional(),
          amountCents: zCents.optional(),
          dueDate: zDate.optional(),
          billingEmail: zOptionalEmail.optional(),
          paymentLink: zLink.optional(),
          remindersPaused: z.boolean().optional(),
          recurrence: z.enum(['nenhuma', 'mensal']).optional(),
        })
        .strict(),
      req.body,
    );
    await asUser(deps, req, async (db) => {
      const cur = await db.query<{ status: string; version: number; company_id: string }>(
        'select status, version, company_id from charges where id = $1 for update',
        [id],
      );
      const c = cur.rows[0];
      if (!c) throw notFound();
      if (c.version !== body.expectedVersion) throw staleVersion();
      if (c.status !== 'pendente') throw conflict('Só é possível alterar cobranças pendentes.');
      if (body.billingEmail === null) throw new AppError(422, 'invalid', 'Informe o e-mail de cobrança.');
      await db.query(
        `update charges set
           description = coalesce($2, description), amount_cents = coalesce($3, amount_cents),
           due_date = coalesce($4::date, due_date), billing_email = coalesce($5, billing_email),
           payment_link = case when $6::boolean then $7 else payment_link end,
           reminders_paused = coalesce($8, reminders_paused), recurrence = coalesce($9, recurrence),
           gateway_dirty = gateway_dirty or (gateway_id is not null and ($2::text is not null or $3::int is not null or $4::date is not null)),
           gateway_attempts = 0
         where id = $1`,
        [id, body.description ?? null, body.amountCents ?? null, body.dueDate ?? null, body.billingEmail ?? null,
          body.paymentLink !== undefined, body.paymentLink ?? null, body.remindersPaused ?? null, body.recurrence ?? null],
      );
      await audit(db, req, 'charge.updated', 'charge', id, c.company_id, {
        fields: Object.keys(body).filter((k) => k !== 'expectedVersion'),
      });
    });
    await syncGateway(deps, { chargeIds: [id], budgetMs: 6000 }).catch(() => null);
    return { ok: true };
  });

  app.post('/api/billing/charges/:id/pay', async (req) => {
    adminOnly(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(
      z.object({ expectedVersion: z.number().int(), note: zOptionalText(300), paidOn: zDate.optional(), sendReceipt: z.boolean().default(true) }).strict(),
      req.body,
    );
    await asUser(deps, req, async (db) => {
      const cur = await db.query<{ status: string; version: number; company_id: string }>(
        'select status, version, company_id from charges where id = $1 for update',
        [id],
      );
      const c = cur.rows[0];
      if (!c) throw notFound();
      if (c.version !== body.expectedVersion) throw staleVersion();
      if (c.status !== 'pendente') throw conflict('Esta cobrança não está pendente.');
      await db.query(
        `update charges set status = 'pago', paid_note = $2, paid_via = 'manual',
                paid_at = coalesce(($3::date + time '12:00') at time zone 'America/Sao_Paulo', now()),
                gateway_dirty = gateway_id is not null, gateway_attempts = 0
          where id = $1`,
        [id, body.note, body.paidOn ?? null],
      );
      await audit(db, req, 'charge.paid', 'charge', id, c.company_id);
    });
    await syncGateway(deps, { chargeIds: [id], budgetMs: 6000 }).catch(() => null);
    let receipt = false;
    if (body.sendReceipt && billingEmailEnabled(deps)) {
      const s = await loadSettings(deps);
      if (s.auto_email) receipt = await sendNotice(deps, 'pagamento', id, s).catch(() => false);
    }
    return { ok: true, receipt };
  });

  app.post('/api/billing/charges/:id/cancel', async (req) => {
    adminOnly(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(z.object({ expectedVersion: z.number().int() }).strict(), req.body);
    await asUser(deps, req, async (db) => {
      const cur = await db.query<{ status: string; version: number; company_id: string }>(
        'select status, version, company_id from charges where id = $1 for update',
        [id],
      );
      const c = cur.rows[0];
      if (!c) throw notFound();
      if (c.version !== body.expectedVersion) throw staleVersion();
      if (c.status !== 'pendente') throw conflict('Esta cobrança não está pendente.');
      await db.query(
        `update charges set status = 'cancelado', canceled_at = now(), gateway_dirty = gateway_id is not null, gateway_attempts = 0
          where id = $1`,
        [id],
      );
      await audit(db, req, 'charge.canceled', 'charge', id, c.company_id);
    });
    await syncGateway(deps, { chargeIds: [id], budgetMs: 6000 }).catch(() => null);
    return { ok: true };
  });

  /**
   * "Asaas": gera a cobrança lá (se ainda não existe), reenvia uma alteração
   * pendente ou busca a situação atual (pagamentos sem webhook).
   */
  app.post('/api/billing/charges/:id/gateway-sync', async (req) => {
    adminOnly(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    if (!(await gatewayActive(deps))) throw new AppError(422, 'invalid', 'Integração com o Asaas desligada.');
    const cur = await asUser(deps, req, async (db) => {
      const { rows } = await db.query<{ status: string; gateway_id: string | null; company_id: string }>(
        'select status, gateway_id, company_id from charges where id = $1 for update',
        [id],
      );
      const c = rows[0];
      if (!c) throw notFound();
      if (!c.gateway_id && c.status !== 'pendente') throw conflict('Esta cobrança não está no Asaas.');
      if (!c.gateway_id) await db.query('update charges set gateway_dirty = true, gateway_attempts = 0 where id = $1', [id]);
      else await db.query('update charges set gateway_attempts = 0 where id = $1 and gateway_dirty', [id]);
      await audit(db, req, 'charge.gateway_sync', 'charge', id, c.company_id);
      return c;
    });
    const r = await syncGateway(deps, { chargeIds: [id], budgetMs: 8000 });
    let paid = false;
    if (cur.gateway_id && r.synced === 0 && r.failed === 0) {
      try {
        paid = (await applyPayment(deps, await fetchPayment(deps, cur.gateway_id), 'sync')).paid;
      } catch (e) {
        throw new AppError(502, 'gateway', e instanceof AsaasError ? e.message : 'Falha ao consultar o Asaas.');
      }
    }
    const err = await deps.pools.owner.query<{ gateway_error: string | null }>('select gateway_error from charges where id = $1', [id]);
    if (r.failed) throw new AppError(502, 'gateway', err.rows[0]?.gateway_error ?? 'Falha ao comunicar com o Asaas.');
    return { ok: true, paid };
  });

  /**
   * Webhook do Asaas (Configurações → Integrações → Webhooks, eventos de
   * cobrança). Autenticado pelo token do cabeçalho asaas-access-token.
   */
  app.post('/api/webhooks/asaas', { config: { public: true } }, async (req, reply) => {
    if (!webhookAuthorized(deps, req.headers['asaas-access-token'])) {
      reply.code(401);
      return { ok: false };
    }
    const body = req.body as { event?: unknown; payment?: { id?: unknown } } | null;
    const p = body?.payment;
    if (!p || typeof p.id !== 'string' || p.id.length > 60) return { ok: true, ignored: true };
    const r = await applyPayment(deps, p as never, 'webhook');
    return { ok: true, ...r };
  });

  /** Reenvia a cobrança agora (botão "Enviar e-mail"). */
  app.post('/api/billing/charges/:id/send', async (req) => {
    adminOnly(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    if (!billingEmailEnabled(deps)) {
      throw new AppError(422, 'invalid', 'Envio de e-mail não configurado no servidor (SMTP).');
    }
    await deps.limiters.invite.consume(`charge:${id}`);
    const companyId = await asUser(deps, req, async (db) => {
      const { rows } = await db.query<{ status: string; company_id: string }>('select status, company_id from charges where id = $1', [id]);
      if (!rows[0]) throw notFound();
      if (rows[0].status !== 'pendente') throw conflict('Esta cobrança não está pendente.');
      await audit(db, req, 'charge.email_sent', 'charge', id, rows[0].company_id);
      return rows[0].company_id;
    });
    const ok = await sendNotice(deps, 'manual', id);
    if (!ok) throw new AppError(502, 'mail_failed', 'Não foi possível enviar o e-mail agora. Confira a configuração de e-mail.');
    return { ok: true, companyId };
  });

  app.get('/api/billing/settings', async (req) => {
    adminOnly(req);
    return asUser(deps, req, async (db) => {
      const { rows } = await db.query(
        `select auto_email as "autoEmail", pix_key as "pixKey", beneficiary, instructions,
                reminder_days_before as "reminderDaysBefore", overdue_every_days as "overdueEveryDays",
                overdue_max_reminders as "overdueMaxReminders", updated_at as "updatedAt"
           from billing_settings limit 1`,
      );
      const g = await db.query<{ gateway_enabled: boolean; wa_enabled: boolean; wa_templates: Record<string, string> }>(
        'select gateway_enabled, wa_enabled, wa_templates from billing_settings limit 1',
      );
      return {
        ...rows[0],
        whatsappEnabled: g.rows[0]?.wa_enabled ?? false,
        whatsappTemplates: g.rows[0]?.wa_templates ?? {},
        whatsappConfigured: whatsappConfigured(deps),
        emailEnabled: billingEmailEnabled(deps),
        gatewayEnabled: g.rows[0]?.gateway_enabled ?? false,
        asaas: {
          configured: asaasConfigured(deps),
          environment: asaasEnvironment(deps),
          webhookConfigured: !!deps.config.ASAAS_WEBHOOK_TOKEN,
          webhookUrl: `${deps.config.APP_URL.replace(/\/$/, '')}/api/webhooks/asaas`,
        },
      };
    });
  });

  app.put('/api/billing/settings', async (req) => {
    const admin = adminOnly(req);
    const body = parse(
      z
        .object({
          autoEmail: z.boolean(),
          pixKey: zOptionalText(140),
          beneficiary: zOptionalText(140),
          instructions: zOptionalText(2000),
          reminderDaysBefore: z.number().int().min(0).max(30),
          overdueEveryDays: z.number().int().min(1).max(60),
          overdueMaxReminders: z.number().int().min(0).max(12),
          gatewayEnabled: z.boolean().optional(),
          whatsappEnabled: z.boolean().optional(),
          whatsappTemplates: z
            .partialRecord(z.enum(['criada', 'lembrete', 'vencimento', 'atraso', 'pagamento', 'manual']),
              z.string().trim().regex(/^[a-z0-9_]{1,512}$/, 'Nome de modelo inválido (letras minúsculas, números e _).'))
            .optional(),
        })
        .strict(),
      req.body,
    );
    if (body.gatewayEnabled && !asaasConfigured(deps)) {
      throw new AppError(422, 'invalid', 'Configure a chave ASAAS_API_KEY no servidor (Netlify) antes de ligar o Asaas.');
    }
    await asUser(deps, req, async (db) => {
      await db.query(
        `update billing_settings set auto_email = $1, pix_key = $2, beneficiary = $3, instructions = $4,
                reminder_days_before = $5, overdue_every_days = $6, overdue_max_reminders = $7,
                updated_at = now(), updated_by = $8, gateway_enabled = coalesce($9, gateway_enabled),
                wa_enabled = coalesce($10, wa_enabled), wa_templates = coalesce($11::jsonb, wa_templates)`,
        [body.autoEmail, body.pixKey, body.beneficiary, body.instructions, body.reminderDaysBefore,
          body.overdueEveryDays, body.overdueMaxReminders, admin.id, body.gatewayEnabled ?? null,
          body.whatsappEnabled ?? null, body.whatsappTemplates ? JSON.stringify(body.whatsappTemplates) : null],
      );
      await audit(db, req, 'billing.settings_updated', 'billing_settings', null);
    });
    return { ok: true };
  });
}
