import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../lib/context.js';
import { asUser, audit, isAdmin, isAlpha, requireUser } from '../../lib/context.js';
import { AppError, conflict, forbidden, notFound, staleVersion } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { zOptionalText, zUuid } from '../../lib/normalize.js';
import { loadProcess } from '../processes/routes.js';

export const workModels = ['presencial', 'hibrido', 'remoto'] as const;
export const employmentTypes = ['clt', 'pj', 'estagio', 'temporario', 'outro'] as const;
export const publications = ['rascunho', 'publicada', 'pausada', 'encerrada'] as const;

export interface ScreeningQuestion {
  id: string;
  text: string;
  eliminatory: boolean;
  /** Resposta esperada quando eliminatória. Nunca enviada ao portal público. */
  expected: 'sim' | 'nao';
}

const zQuestion = z
  .object({
    id: z.string().regex(/^[a-z0-9]{4,16}$/).optional(),
    text: z.string().trim().min(3, 'Pergunta muito curta.').max(300),
    eliminatory: z.boolean(),
    expected: z.enum(['sim', 'nao']).default('sim'),
  })
  .strict();

const zCentsOpt = z.number().int().min(0).max(1_000_000_000).nullable();

/** Texto → trecho de endereço: sem acentos, minúsculas e hífens. */
export function slugify(title: string) {
  const base = title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '');
  return `${base || 'vaga'}-${randomBytes(3).toString('hex')}`;
}

const jobCols = `p.job_location as "jobLocation", p.work_model as "workModel", p.employment_type as "employmentType",
  p.requirements, p.benefits, p.salary_min_cents as "salaryMinCents", p.salary_max_cents as "salaryMaxCents",
  p.show_company as "showCompany", p.publication, p.public_slug as "publicSlug", p.published_at as "publishedAt",
  p.screening_questions as "screeningQuestions", p.version, p.status`;

export function registerJobRoutes(app: FastifyInstance, deps: Deps) {
  const adminOnly = (req: Parameters<typeof requireUser>[0]) => {
    if (!isAdmin(requireUser(req))) throw forbidden();
  };

  /** Dados da vaga (equipe Alpha). Clientes não veem as respostas esperadas das perguntas. */
  app.get('/api/processes/:id/job', async (req) => {
    const user = requireUser(req);
    if (!isAlpha(user)) throw forbidden();
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return asUser(deps, req, async (db) => {
      await loadProcess(db, id);
      const { rows } = await db.query(`select ${jobCols} from processes p where p.id = $1`, [id]);
      return rows[0];
    });
  });

  app.put('/api/processes/:id/job', async (req) => {
    adminOnly(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(
      z
        .object({
          expectedVersion: z.number().int().positive(),
          jobLocation: zOptionalText(120),
          workModel: z.enum(workModels).nullable(),
          employmentType: z.enum(employmentTypes).nullable(),
          requirements: zOptionalText(5000),
          benefits: zOptionalText(3000),
          salaryMinCents: zCentsOpt,
          salaryMaxCents: zCentsOpt,
          showCompany: z.boolean(),
          screeningQuestions: z.array(zQuestion).max(10),
        })
        .strict()
        .refine((b) => b.salaryMinCents === null || b.salaryMaxCents === null || b.salaryMinCents <= b.salaryMaxCents, {
          message: 'O salário mínimo não pode ser maior que o máximo.',
          path: ['salaryMaxCents'],
        }),
      req.body,
    );
    const questions: ScreeningQuestion[] = body.screeningQuestions.map((q) => ({
      id: q.id ?? randomBytes(4).toString('hex'),
      text: q.text,
      eliminatory: q.eliminatory,
      expected: q.expected,
    }));
    if (new Set(questions.map((q) => q.id)).size !== questions.length) {
      throw new AppError(422, 'invalid', 'Perguntas repetidas.');
    }
    return asUser(deps, req, async (db) => {
      const p = await loadProcess(db, id);
      const { rowCount } = await db.query(
        `update processes set job_location = $3, work_model = $4, employment_type = $5, requirements = $6,
                benefits = $7, salary_min_cents = $8, salary_max_cents = $9, show_company = $10,
                screening_questions = $11::jsonb
          where id = $1 and version = $2`,
        [id, body.expectedVersion, body.jobLocation, body.workModel, body.employmentType, body.requirements,
          body.benefits, body.salaryMinCents, body.salaryMaxCents, body.showCompany, JSON.stringify(questions)],
      );
      if (!rowCount) throw staleVersion();
      await audit(db, req, 'job.updated', 'process', id, p.companyId);
      return { ok: true };
    });
  });

  /** Publica, pausa ou encerra a vaga no portal público. */
  app.post('/api/processes/:id/publication', async (req) => {
    adminOnly(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(
      z.object({ expectedVersion: z.number().int().positive(), publication: z.enum(publications) }).strict(),
      req.body,
    );
    return asUser(deps, req, async (db) => {
      const p = await loadProcess(db, id);
      const cur = await db.query<{ public_slug: string | null; description: string | null }>(
        'select public_slug, description from processes where id = $1',
        [id],
      );
      if (body.publication === 'publicada') {
        if (p.status !== 'em_andamento') throw conflict('Somente processos em andamento podem ser publicados.');
        if (!cur.rows[0]!.description?.trim()) {
          throw new AppError(422, 'invalid', 'Preencha a descrição do processo antes de publicar a vaga.');
        }
      }
      const slug = cur.rows[0]!.public_slug ?? (body.publication === 'rascunho' ? null : slugify(p.title));
      const { rowCount } = await db.query(
        `update processes set publication = $3, public_slug = $4,
                published_at = case when $3 = 'publicada' then coalesce(published_at, now()) else published_at end
          where id = $1 and version = $2`,
        [id, body.expectedVersion, body.publication, slug],
      );
      if (!rowCount) throw staleVersion();
      await audit(db, req, 'job.publication', 'process', id, p.companyId, { publication: body.publication });
      return { ok: true, publicSlug: slug };
    });
  });

  /** Respostas do formulário público de uma participação (somente equipe Alpha). */
  app.get('/api/applications/:id/intake', async (req) => {
    if (!isAlpha(requireUser(req))) throw forbidden();
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return asUser(deps, req, async (db) => {
      const { rows } = await db.query(
        `select i.answers, i.screening_failed as "screeningFailed", i.created_at as "createdAt"
           from application_intake i where i.application_id = $1`,
        [id],
      );
      if (!rows[0]) throw notFound('Esta participação não veio do portal.');
      return rows[0];
    });
  });
}
