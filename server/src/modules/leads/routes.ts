import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../lib/context.js';
import { asUser, audit, isAdmin, isAlpha, requireUser } from '../../lib/context.js';
import { AppError, conflict, forbidden, notFound, staleVersion } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { zOptionalText, zUuid } from '../../lib/normalize.js';
import { loadProcess, processPermissions } from '../processes/routes.js';

/** Motivos padronizados de reprovação/desistência (os mesmos do banco). */
export const reasons = [
  'perfil_tecnico', 'experiencia', 'pretensao_salarial', 'localizacao', 'disponibilidade',
  'comportamental', 'sem_retorno', 'vaga_cancelada', 'desistencia_candidato', 'outro',
] as const;

const zCriteria = z.array(z.string().trim().min(2).max(80)).max(10);

export function registerLeadRoutes(app: FastifyInstance, deps: Deps) {
  const alphaOnly = (req: Parameters<typeof requireUser>[0]) => {
    const u = requireUser(req);
    if (!isAlpha(u)) throw forbidden();
    return u;
  };

  /** Critérios de avaliação e prazo (SLA) do processo — administrador. */
  app.put('/api/processes/:id/triage-config', async (req) => {
    if (!isAdmin(requireUser(req))) throw forbidden();
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(
      z.object({ expectedVersion: z.number().int().positive(), slaDays: z.number().int().min(1).max(60), evaluationCriteria: zCriteria }).strict(),
      req.body,
    );
    return asUser(deps, req, async (db) => {
      const p = await loadProcess(db, id);
      const { rowCount } = await db.query(
        'update processes set sla_days = $3, evaluation_criteria = $4::jsonb where id = $1 and version = $2',
        [id, body.expectedVersion, body.slaDays, JSON.stringify(body.evaluationCriteria)],
      );
      if (!rowCount) throw staleVersion();
      await audit(db, req, 'process.triage_config', 'process', id, p.companyId);
      return { ok: true };
    });
  });

  /** Ficha de avaliação da triagem (somente equipe Alpha). */
  app.get('/api/applications/:id/evaluation', async (req) => {
    alphaOnly(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return asUser(deps, req, async (db) => {
      const a = await db.query<{ process_id: string; criteria: string[] }>(
        `select a.process_id, p.evaluation_criteria as criteria
           from applications a join processes p on p.id = a.process_id where a.id = $1`,
        [id],
      );
      if (!a.rows[0]) throw notFound('Participação não encontrada.');
      const { rows } = await db.query(
        `select e.triage_status as "triageStatus", e.ratings, e.score::float as score, e.reason, e.notes,
                e.version, e.updated_at as "updatedAt", app.person_label(e.evaluated_by) as "evaluatedByName"
           from application_evaluations e where e.application_id = $1`,
        [id],
      );
      return { criteria: a.rows[0].criteria, evaluation: rows[0] ?? null };
    });
  });

  app.put('/api/applications/:id/evaluation', async (req) => {
    alphaOnly(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(
      z
        .object({
          expectedVersion: z.number().int().positive().nullable(),
          triageStatus: z.enum(['em_triagem', 'aprovado_interno', 'reprovado_interno']),
          ratings: z.array(z.object({ criterion: z.string().trim().min(1).max(80), score: z.number().int().min(1).max(5) }).strict()).max(10),
          reason: z.enum(reasons).nullable(),
          notes: zOptionalText(5000),
        })
        .strict()
        .refine((b) => b.triageStatus !== 'reprovado_interno' || b.reason, { message: 'Informe o motivo da reprovação.', path: ['reason'] }),
      req.body,
    );
    const score = body.ratings.length ? Math.round((body.ratings.reduce((s, r) => s + r.score, 0) / body.ratings.length) * 100) / 100 : null;
    return asUser(deps, req, async (db, user) => {
      const a = await db.query<{ process_id: string; company_id: string; sent_at: Date | null }>(
        `select a.process_id, p.company_id, a.sent_at from applications a join processes p on p.id = a.process_id where a.id = $1`,
        [id],
      );
      const cur = a.rows[0];
      if (!cur) throw notFound('Participação não encontrada.');
      const reason = body.triageStatus === 'reprovado_interno' ? body.reason : null;
      if (body.expectedVersion === null) {
        const ins = await db.query(
          `insert into application_evaluations (application_id, triage_status, ratings, score, reason, notes, evaluated_by)
           values ($1, $2, $3::jsonb, $4, $5, $6, $7) on conflict (application_id) do nothing`,
          [id, body.triageStatus, JSON.stringify(body.ratings), score, reason, body.notes, user.id],
        );
        if (!ins.rowCount) throw staleVersion();
      } else {
        const up = await db.query(
          `update application_evaluations set triage_status = $3, ratings = $4::jsonb, score = $5, reason = $6,
                  notes = $7, evaluated_by = $8
            where application_id = $1 and version = $2`,
          [id, body.expectedVersion, body.triageStatus, JSON.stringify(body.ratings), score, reason, body.notes, user.id],
        );
        if (!up.rowCount) throw staleVersion();
      }
      await audit(db, req, 'application.evaluated', 'application', id, cur.company_id, { triageStatus: body.triageStatus, score });
      return { ok: true, score };
    });
  });

  /**
   * Envia ao cliente uma ou várias participações aprovadas na triagem:
   * aplica o compartilhamento escolhido, move para a etapa do RH Interno
   * e registra o envio. Avisa os participantes do cliente por e-mail.
   */
  app.post('/api/processes/:id/send-leads', async (req) => {
    alphaOnly(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(
      z
        .object({
          items: z
            .array(
              z
                .object({
                  applicationId: zUuid,
                  summary: zOptionalText(5000),
                  shareEmail: z.boolean(),
                  sharePhone: z.boolean(),
                  shareSalary: z.boolean(),
                  shareDocuments: z.boolean(),
                })
                .strict(),
            )
            .min(1)
            .max(50),
          confirmDuplicate: z.boolean().default(false),
        })
        .strict(),
      req.body,
    );
    const ids = body.items.map((i) => i.applicationId);
    if (new Set(ids).size !== ids.length) throw new AppError(422, 'invalid', 'Candidato repetido na lista.');

    const result = await asUser(deps, req, async (db, user) => {
      const p = await loadProcess(db, id);
      if (p.status !== 'em_andamento') throw conflict('Somente processos em andamento enviam candidatos.');
      const perms = await processPermissions(db, user, id);
      if (!perms.canMoveStage) throw forbidden('Você precisa da permissão de mover etapas neste processo para enviar candidatos.');

      const { rows } = await db.query<{
        id: string; version: number; sent_at: Date | null; decision: string; stage_id: number; name: string;
        triage_status: string | null; candidate_id: string;
      }>(
        `select a.id, a.version, a.sent_at, a.decision, a.stage_id, c.full_name as name, e.triage_status, a.candidate_id
           from applications a
           join candidates c on c.id = a.candidate_id
           left join application_evaluations e on e.application_id = a.id
          where a.process_id = $1 and a.id = any($2::uuid[])
          for update of a`,
        [id, ids],
      );
      if (rows.length !== ids.length) throw notFound('Participação não encontrada neste processo.');
      const problems = rows.flatMap((r) => {
        if (r.sent_at) return [`${r.name}: já enviado`];
        if (r.triage_status !== 'aprovado_interno') return [`${r.name}: não foi aprovado na triagem`];
        if (r.decision !== 'pendente') return [`${r.name}: possui decisão registrada`];
        return [];
      });
      if (problems.length) throw new AppError(409, 'conflict', `Não é possível enviar: ${problems.join('; ')}.`);

      // Mesmo candidato (e-mail ou telefone) já enviado a esta empresa em outro processo.
      if (!body.confirmDuplicate) {
        const dup = await db.query<{ name: string; title: string }>(
          `select distinct c.full_name as name, p2.title
             from applications a
             join candidates c on c.id = a.candidate_id
             join applications a2 on a2.id <> a.id and a2.sent_at is not null
             join candidates c2 on c2.id = a2.candidate_id
             join processes p2 on p2.id = a2.process_id
            where a.id = any($1::uuid[])
              and p2.company_id = $2
              and (a2.candidate_id = a.candidate_id
                   or (c.email is not null and c2.email = c.email)
                   or (c.phone is not null and c2.phone = c.phone))`,
          [ids, p.companyId],
        );
        if (dup.rowCount) {
          const err = new AppError(409, 'possible_duplicate', 'Candidato(s) já enviado(s) a esta empresa em outro processo.');
          (err as AppError & { extra?: unknown }).extra = dup.rows;
          throw err;
        }
      }

      const batchId = rows.length > 1 ? randomUUID() : null;
      const stage2 = await db.query<{ id: number }>('select id from stages order by position offset 1 limit 1');
      for (const item of body.items) {
        const r = rows.find((x) => x.id === item.applicationId)!;
        const up = await db.query(
          `update applications set share_email = $3, share_phone = $4, share_salary = $5,
                  shared_summary = coalesce($6, shared_summary), stage_id = $7
            where id = $1 and version = $2`,
          [r.id, r.version, item.shareEmail, item.sharePhone, item.shareSalary, item.summary, stage2.rows[0]!.id],
        );
        if (!up.rowCount) throw staleVersion();
        if (item.shareDocuments) {
          await db.query('update application_documents set shared_with_client = true where application_id = $1', [r.id]);
        }
        await db.query(
          'insert into lead_submissions (application_id, process_id, batch_id, sent_by) values ($1, $2, $3, $4)',
          [r.id, id, batchId, user.id],
        );
        await audit(db, req, 'lead.sent', 'application', r.id, p.companyId, {
          shareEmail: item.shareEmail, sharePhone: item.sharePhone, shareSalary: item.shareSalary, shareDocuments: item.shareDocuments,
        });
      }
      return { process: p, count: rows.length };
    });

    await notifyClient(deps, id, result.process.title, result.count).catch(() => undefined);
    return { ok: true, count: result.count };
  });
}

/** Aviso aos participantes do cliente no processo (sem dados do candidato no e-mail). */
async function notifyClient(deps: Deps, processId: string, title: string, count: number) {
  if (deps.config.mailMode === 'manual') return;
  const { rows } = await deps.pools.owner.query<{ email: string; full_name: string }>(
    `select u.email, u.full_name from process_members m join users u on u.id = m.user_id
      left join companies c on c.id = u.company_id
     where m.process_id = $1 and u.kind in ('client_user', 'client_manager') and u.is_active and c.is_active`,
    [processId],
  );
  const link = `${deps.config.APP_URL.replace(/\/$/, '')}/processos/${processId}`;
  for (const r of rows) {
    await deps.mailer.send({
      to: r.email,
      subject: `${count === 1 ? 'Novo candidato' : `${count} novos candidatos`} para avaliação — ${title}`,
      text:
        `Olá, ${r.full_name}.\n\nA Alpha Select enviou ${count === 1 ? '1 candidato' : `${count} candidatos`} para a vaga "${title}".\n` +
        `Acesse para avaliar e registrar seu retorno:\n\n${link}\n\nAlpha Select Consultoria de Recursos Humanos`,
    });
  }
}
