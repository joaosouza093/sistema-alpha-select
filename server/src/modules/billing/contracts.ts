import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../lib/context.js';
import type { Db } from '../../lib/db.js';
import { asUser, audit, isAdmin, requireUser } from '../../lib/context.js';
import { AppError, forbidden, notFound, staleVersion } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { zOptionalText, zText, zUuid } from '../../lib/normalize.js';
import { chargeFilesJson, contractFileJson, removeStored } from './files.js';
import { todaySP } from './notify.js';

const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida.').refine((v) => !Number.isNaN(Date.parse(v)), 'Data inválida.');
const MODALITIES = ['mensalidade', 'pacote', 'sucesso', 'outro'] as const;
const STATUSES = ['ativo', 'suspenso', 'encerrado'] as const;

const contractFields = {
  plan: zText(2, 120),
  modality: z.enum(MODALITIES, { message: 'Escolha a modalidade.' }),
  amountCents: z.number().int('Valor inválido.').min(1, 'Valor inválido.').max(1_000_000_000, 'Valor muito alto.').nullable(),
  startDate: zDate,
  endDate: zDate.nullable(),
  status: z.enum(STATUSES),
  ownerId: zUuid.nullable(),
  notes: zOptionalText(2000),
};
const endAfterStart = (b: { startDate?: string; endDate?: string | null }) => !b.startDate || !b.endDate || b.endDate >= b.startDate;
const endMsg = { message: 'O fim da vigência deve ser depois do início.', path: ['endDate'] };

const contractCols = (alias: string) => `${alias}.id, ${alias}.company_id as "companyId", ${alias}.plan, ${alias}.modality,
  ${alias}.amount_cents as "amountCents", to_char(${alias}.start_date, 'YYYY-MM-DD') as "startDate",
  to_char(${alias}.end_date, 'YYYY-MM-DD') as "endDate", ${alias}.status, ${contractFileJson(alias)} as file`;

export function registerContractRoutes(app: FastifyInstance, deps: Deps) {
  const adminOnly = (req: FastifyRequest) => {
    const u = requireUser(req);
    if (!isAdmin(u)) throw forbidden();
    return u;
  };

  /** Valida o responsável: usuário ativo da Alpha Select. */
  const checkOwner = async (db: Db, ownerId: string | null | undefined) => {
    if (!ownerId) return;
    const r = await db.query("select 1 from users where id = $1 and kind in ('alpha_admin', 'alpha_staff') and is_active", [ownerId]);
    if (!r.rowCount) throw new AppError(422, 'invalid', 'Responsável inválido: escolha um usuário ativo da Alpha Select.');
  };

  app.get('/api/contracts', async (req) => {
    adminOnly(req);
    const q = parse(z.object({ companyId: zUuid.optional() }), req.query);
    return asUser(deps, req, async (db) => {
      const { rows } = await db.query(
        `select ${contractCols('k')}, co.name as "companyName", k.owner_id as "ownerId", app.person_label(k.owner_id) as "ownerName",
                k.notes, k.version, k.created_at as "createdAt"
           from contracts k join companies co on co.id = k.company_id
          where ($1::uuid is null or k.company_id = $1)
          order by (k.status = 'ativo') desc, k.start_date desc`,
        [q.companyId ?? null],
      );
      return { items: rows };
    });
  });

  app.post('/api/contracts', async (req, reply) => {
    adminOnly(req);
    const body = parse(z.object({ companyId: zUuid, ...contractFields }).strict().refine(endAfterStart, endMsg), req.body);
    const id = await asUser(deps, req, async (db) => {
      const co = await db.query('select 1 from companies where id = $1', [body.companyId]);
      if (!co.rowCount) throw notFound('Empresa não encontrada.');
      await checkOwner(db, body.ownerId);
      const { rows } = await db.query<{ id: string }>(
        `insert into contracts (company_id, plan, modality, amount_cents, start_date, end_date, status, owner_id, notes, created_by)
         values ($1, $2, $3, $4, $5::date, $6::date, $7, $8, $9, app.uid()) returning id`,
        [body.companyId, body.plan, body.modality, body.amountCents, body.startDate, body.endDate, body.status, body.ownerId, body.notes],
      );
      await audit(db, req, 'contract.created', 'contract', rows[0]!.id, body.companyId, { modality: body.modality, status: body.status });
      return rows[0]!.id;
    });
    reply.code(201);
    return { id };
  });

  app.patch('/api/contracts/:id', async (req) => {
    adminOnly(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(
      z.object(contractFields).partial().extend({ expectedVersion: z.number().int() }).strict(),
      req.body,
    );
    return asUser(deps, req, async (db) => {
      const cur = await db.query<{ version: number; company_id: string; start_date: string; end_date: string | null }>(
        "select version, company_id, to_char(start_date, 'YYYY-MM-DD') as start_date, to_char(end_date, 'YYYY-MM-DD') as end_date from contracts where id = $1",
        [id],
      );
      const c = cur.rows[0];
      if (!c) throw notFound('Contrato não encontrado.');
      if (c.version !== body.expectedVersion) throw staleVersion();
      const start = body.startDate ?? c.start_date;
      const end = body.endDate !== undefined ? body.endDate : c.end_date;
      if (end && end < start) throw new AppError(422, 'invalid', endMsg.message);
      await checkOwner(db, body.ownerId);
      const cols: Record<string, string> = {
        plan: 'plan', modality: 'modality', amountCents: 'amount_cents', startDate: 'start_date', endDate: 'end_date',
        status: 'status', ownerId: 'owner_id', notes: 'notes',
      };
      const sets: string[] = [];
      const params: unknown[] = [id];
      for (const [k, col] of Object.entries(cols)) {
        const v = (body as Record<string, unknown>)[k];
        if (v === undefined) continue;
        params.push(v);
        sets.push(`${col} = $${params.length}${col.endsWith('_date') ? '::date' : ''}`);
      }
      if (sets.length) await db.query(`update contracts set ${sets.join(', ')} where id = $1`, params);
      await audit(db, req, 'contract.updated', 'contract', id, c.company_id, { fields: Object.keys(body).filter((k) => k !== 'expectedVersion') });
      return { ok: true };
    });
  });

  app.delete('/api/contracts/:id', async (req) => {
    adminOnly(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const keys = await asUser(deps, req, async (db) => {
      const files = await db.query<{ storage_key: string }>('select storage_key from billing_files where contract_id = $1', [id]);
      const { rows } = await db.query<{ company_id: string }>('delete from contracts where id = $1 returning company_id', [id]);
      if (!rows[0]) throw notFound('Contrato não encontrado.');
      await audit(db, req, 'contract.deleted', 'contract', id, rows[0].company_id);
      return files.rows.map((f) => f.storage_key);
    });
    await removeStored(deps, keys);
    return { ok: true };
  });

  /**
   * Financeiro da empresa cliente: cobranças (sem as canceladas), boleto e
   * nota fiscal, e contratos. Somente o gestor da empresa (RLS limita à própria).
   */
  app.get('/api/client/finance', async (req) => {
    const u = requireUser(req);
    if (u.kind !== 'client_manager') throw forbidden('Disponível para o gestor da empresa.');
    const today = await todaySP(deps);
    return asUser(deps, req, async (db) => {
      const charges = await db.query(
        `select c.id, c.description, c.amount_cents as "amountCents", to_char(c.due_date, 'YYYY-MM-DD') as "dueDate",
                c.payment_link as "paymentLink", c.paid_at as "paidAt",
                case when c.status = 'pendente' and c.due_date < $1::date then 'vencida' else c.status::text end as situacao,
                ${chargeFilesJson('c')} as files
           from charges c
          where c.status <> 'cancelado'
          order by (c.status = 'pendente') desc, c.due_date desc
          limit 200`,
        [today],
      );
      const contracts = await db.query(`select ${contractCols('k')} from contracts k order by (k.status = 'ativo') desc, k.start_date desc`);
      const open = charges.rows.filter((c) => c.situacao === 'pendente' || c.situacao === 'vencida');
      const sum = (rows: { amountCents: number }[]) => rows.reduce((s, r) => s + r.amountCents, 0);
      const overdue = open.filter((c) => c.situacao === 'vencida');
      return {
        summary: { openCents: sum(open), openCount: open.length, overdueCents: sum(overdue), overdueCount: overdue.length },
        charges: charges.rows,
        contracts: contracts.rows,
        today,
      };
    });
  });

  /** Visão 360° da empresa cliente (administrador). */
  app.get('/api/companies/:id/overview', async (req) => {
    adminOnly(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const today = await todaySP(deps);
    return asUser(deps, req, async (db) => {
      const co = await db.query(
        `select id, name, is_active as "isActive", created_at as "createdAt", cnpj, billing_email as "billingEmail",
                billing_whatsapp as "billingWhatsapp"
           from companies where id = $1`,
        [id],
      );
      if (!co.rows[0]) throw notFound('Empresa não encontrada.');
      const users = await db.query(
        `select id, full_name as "fullName", email, kind, is_active as "isActive", last_login_at as "lastLoginAt"
           from users where company_id = $1 order by is_active desc, kind desc, full_name`,
        [id],
      );
      const processes = await db.query(
        `select p.id, p.title, p.status, p.created_at as "createdAt",
                (select count(*)::int from applications a where a.process_id = p.id) as candidates,
                (select count(*)::int from lead_submissions l where l.process_id = p.id) as leads
           from processes p where p.company_id = $1
          order by (p.status = 'em_andamento') desc, p.created_at desc limit 50`,
        [id],
      );
      const pipeline = await db.query(
        `select count(*) filter (where p.status = 'em_andamento')::int as "openProcesses",
                count(*) filter (where p.status = 'concluido')::int as "doneProcesses",
                (select count(*)::int from applications a join processes p2 on p2.id = a.process_id where p2.company_id = $1) as candidates,
                (select count(*)::int from applications a join processes p2 on p2.id = a.process_id
                  where p2.company_id = $1 and a.decision = 'aprovado') as approved
           from processes p where p.company_id = $1`,
        [id],
      );
      const leads = await db.query(
        `select count(*)::int as total, max(l.sent_at) as "lastSentAt",
                count(*) filter (where l.sent_at >= now() - interval '30 days')::int as "last30"
           from lead_submissions l join processes p on p.id = l.process_id where p.company_id = $1`,
        [id],
      );
      const messages = await db.query(
        `select count(*)::int as total, max(m.sent_at) as "lastSentAt"
           from message_log m join applications a on a.id = m.application_id join processes p on p.id = a.process_id
          where p.company_id = $1`,
        [id],
      );
      const finance = await db.query(
        `select coalesce(sum(amount_cents) filter (where status = 'pendente' and due_date >= $2::date), 0)::bigint as "openCents",
                coalesce(sum(amount_cents) filter (where status = 'pendente' and due_date < $2::date), 0)::bigint as "overdueCents",
                count(*) filter (where status = 'pendente' and due_date < $2::date)::int as "overdueCount",
                coalesce(sum(amount_cents) filter (where status = 'pago'), 0)::bigint as "paidCents"
           from charges where company_id = $1`,
        [id, today],
      );
      const charges = await db.query(
        `select c.id, c.description, c.amount_cents as "amountCents", to_char(c.due_date, 'YYYY-MM-DD') as "dueDate",
                case when c.status = 'pendente' and c.due_date < $2::date then 'vencida' else c.status::text end as situacao,
                ${chargeFilesJson('c')} as files
           from charges c where c.company_id = $1 order by c.due_date desc limit 12`,
        [id, today],
      );
      const contracts = await db.query(
        `select ${contractCols('k')}, k.owner_id as "ownerId", app.person_label(k.owner_id) as "ownerName", k.notes, k.version
           from contracts k where k.company_id = $1 order by (k.status = 'ativo') desc, k.start_date desc`,
        [id],
      );
      const activity = await db.query(
        `select e.action, e.occurred_at as "occurredAt", app.person_label(e.actor_id) as "actorName"
           from audit_events e where e.company_id = $1 order by e.occurred_at desc limit 15`,
        [id],
      );
      const f = finance.rows[0] as Record<string, string | number>;
      return {
        company: co.rows[0],
        users: users.rows,
        processes: processes.rows,
        pipeline: pipeline.rows[0],
        leads: leads.rows[0],
        messages: messages.rows[0],
        finance: { openCents: Number(f.openCents), overdueCents: Number(f.overdueCents), overdueCount: f.overdueCount, paidCents: Number(f.paidCents) },
        charges: charges.rows,
        contracts: contracts.rows,
        activity: activity.rows,
        today,
      };
    });
  });
}
