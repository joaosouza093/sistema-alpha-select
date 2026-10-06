import { rm } from 'node:fs/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../lib/context.js';
import { withTx, type Db } from '../../lib/db.js';
import { AppError, badRequest, notFound } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { zEmail, zOptionalPhone, zOptionalText, zText } from '../../lib/normalize.js';
import { receiveUpload } from '../../lib/upload.js';
import { insertAudit } from '../auth/service.js';
import type { ScreeningQuestion } from '../jobs/routes.js';
import { sendCandidateMessage } from '../messages/service.js';

/**
 * Portal público de vagas. Rotas sem login, com a menor superfície possível:
 * só vagas publicadas de processos em andamento e de empresas ativas; nunca
 * expõe identificadores internos, respostas esperadas ou dados de candidatos.
 */

export const CONSENT_VERSION = 'portal-v2'; // v2: aviso cita a área Meus dados e a retenção
const RESUME_EXTENSIONS = ['pdf', 'doc', 'docx', 'odt'];

const publicCols = `p.public_slug as slug, p.title, p.job_location as location, p.work_model as "workModel",
  p.employment_type as "employmentType", p.published_at as "publishedAt",
  case when p.show_company then c.name end as "companyName",
  p.salary_min_cents as "salaryMinCents", p.salary_max_cents as "salaryMaxCents"`;

const publishedWhere = `p.publication = 'publicada' and p.status = 'em_andamento' and c.is_active`;

const zApplication = z
  .object({
    fullName: zText(2, 160),
    email: zEmail,
    phone: zOptionalPhone,
    city: zOptionalText(120),
    salaryExpectation: z.number().min(0).max(10_000_000).nullish().transform((v) => v ?? null),
    answers: z.array(z.object({ id: z.string().max(16), answer: z.enum(['sim', 'nao']) }).strict()).max(10).default([]),
    acceptPrivacy: z.literal(true, { message: 'É necessário aceitar o aviso de privacidade.' }),
    /** Campo isca: invisível para pessoas; robôs costumam preencher. */
    website: z.string().max(200).optional(),
  })
  .strict();

type ApplicationInput = z.infer<typeof zApplication>;

export function registerPublicRoutes(app: FastifyInstance, deps: Deps) {
  const owner = deps.pools.owner;

  app.get('/api/public/jobs', { config: { public: true } }, async () => {
    const { rows } = await owner.query(
      `select ${publicCols} from processes p join companies c on c.id = p.company_id
        where ${publishedWhere} order by p.published_at desc nulls last limit 200`,
    );
    return { items: rows };
  });

  app.get('/api/public/jobs/:slug', { config: { public: true } }, async (req) => {
    const { slug } = parse(z.object({ slug: z.string().regex(/^[a-z0-9-]{3,120}$/) }), req.params);
    const { rows } = await owner.query<Record<string, unknown> & { questions: ScreeningQuestion[] }>(
      `select ${publicCols}, p.description, p.requirements, p.benefits, p.screening_questions as questions
         from processes p join companies c on c.id = p.company_id
        where p.public_slug = $1 and ${publishedWhere}`,
      [slug],
    );
    const job = rows[0];
    if (!job) throw notFound('Vaga não encontrada ou encerrada.');
    // Somente o texto das perguntas: a resposta esperada nunca sai do servidor.
    return { ...job, questions: job.questions.map((q) => ({ id: q.id, text: q.text })) };
  });

  /** Candidatura a uma vaga publicada (multipart: campo "dados" em JSON + arquivo "curriculo"). */
  app.post('/api/public/jobs/:slug/apply', { config: { public: true } }, async (req, reply) => {
    const { slug } = parse(z.object({ slug: z.string().regex(/^[a-z0-9-]{3,120}$/) }), req.params);
    await deps.limiters.publicApplyIp.consume(`ip:${req.ip}`);
    const job = await owner.query<{ id: string; title: string; company_id: string; questions: ScreeningQuestion[] }>(
      `select p.id, p.title, p.company_id, p.screening_questions as questions
         from processes p join companies c on c.id = p.company_id
        where p.public_slug = $1 and ${publishedWhere}`,
      [slug],
    );
    const process = job.rows[0];
    if (!process) throw notFound('Vaga não encontrada ou encerrada.');
    await receiveApplication(req, reply, { processId: process.id, title: process.title, companyId: process.company_id, questions: process.questions });
    return { ok: true, message: 'Candidatura recebida. Obrigado! Se o seu perfil avançar, entraremos em contato.' };
  });

  /** Cadastro no banco de talentos sem vaga específica. */
  app.post('/api/public/talent', { config: { public: true } }, async (req, reply) => {
    await deps.limiters.publicApplyIp.consume(`ip:${req.ip}`);
    await receiveApplication(req, reply, null);
    return { ok: true, message: 'Currículo recebido. Obrigado! Entraremos em contato quando houver uma oportunidade compatível.' };
  });

  async function receiveApplication(
    req: FastifyRequest,
    reply: import('fastify').FastifyReply,
    target: { processId: string; title: string; companyId: string; questions: ScreeningQuestion[] } | null,
  ) {
    if (!req.isMultipart()) throw badRequest('Envie o formulário com o currículo anexado.');
    const part = await req.file({ limits: { fileSize: deps.config.maxUploadBytes, files: 1, fields: 2, fieldSize: 20_000 } });
    if (!part) throw new AppError(422, 'invalid', 'Anexe o currículo.');
    const raw = (part.fields.dados as { value?: unknown } | undefined)?.value;
    let data: ApplicationInput;
    try {
      data = parse(zApplication, typeof raw === 'string' ? JSON.parse(raw) : undefined);
    } catch (e) {
      part.file.resume();
      if (e instanceof SyntaxError) throw badRequest('Dados do formulário inválidos.');
      throw e;
    }
    if (data.website) {
      // Robô: descarta sem revelar.
      part.file.resume();
      return;
    }
    const questions = target?.questions ?? [];
    const answers = questions.map((q) => {
      const a = data.answers.find((x) => x.id === q.id);
      return { id: q.id, text: q.text, eliminatory: q.eliminatory, expected: q.expected, answer: a?.answer ?? null };
    });
    if (answers.some((a) => a.answer === null)) {
      part.file.resume();
      throw new AppError(422, 'invalid', 'Responda todas as perguntas.');
    }
    const screeningFailed = answers.some((a) => a.eliminatory && a.answer !== a.expected);

    const tmp = deps.storage.tmpPath();
    let committedKey: string | null = null;
    try {
      const file = await receiveUpload(deps, part, tmp, RESUME_EXTENSIONS);
      const result = await withTx(owner, async (db) => {
        if (target && (await alreadyApplied(db, target.processId, data.email))) return 'duplicate' as const;
        const cand = await db.query<{ id: string }>(
          `insert into candidates (full_name, email, phone, salary_expectation, city, source, consent_at, consent_version)
           values ($1, $2, $3, $4, $5, 'portal', now(), $6) returning id`,
          [data.fullName, data.email, data.phone, data.salaryExpectation, data.city, CONSENT_VERSION],
        );
        const candidateId = cand.rows[0]!.id;
        const storageKey = deps.storage.newKey();
        const doc = await db.query<{ id: string }>(
          `insert into documents (candidate_id, kind, storage_key, original_name, mime_type, size_bytes, sha256)
           values ($1, 'curriculo', $2, $3, $4, $5, $6) returning id`,
          [candidateId, storageKey, file.originalName, file.mime, file.size, file.sha256],
        );
        let applicationId: string | null = null;
        if (target) {
          const a = await db.query<{ id: string }>(
            "insert into applications (candidate_id, process_id, source) values ($1, $2, 'portal') returning id",
            [candidateId, target.processId],
          );
          applicationId = a.rows[0]!.id;
          await db.query(
            'insert into application_documents (application_id, document_id, candidate_id) values ($1, $2, $3)',
            [applicationId, doc.rows[0]!.id, candidateId],
          );
          await db.query(
            'insert into application_intake (application_id, answers, screening_failed) values ($1, $2::jsonb, $3)',
            [applicationId, JSON.stringify(answers), screeningFailed],
          );
        }
        await deps.storage.commitTmp(tmp, storageKey);
        committedKey = storageKey;
        await insertAudit(db, null, target ? 'portal.application_received' : 'portal.talent_received',
          target ? 'application' : 'candidate', applicationId ?? candidateId, req.ip, { screeningFailed });
        return { candidateId, applicationId };
      });
      committedKey = null;
      if (result !== 'duplicate') {
        if (result.applicationId) await confirmByTemplate(data, result.candidateId, result.applicationId);
        else await confirm(data, null);
      }
    } finally {
      await rm(tmp, { force: true }).catch(() => undefined);
      if (committedKey) await deps.storage.remove(committedKey).catch(() => undefined);
    }
    reply.code(201);
  }

  async function alreadyApplied(db: Db, processId: string, email: string) {
    const r = await db.query(
      `select 1 from applications a join candidates c on c.id = a.candidate_id
        where a.process_id = $1 and c.email = $2 limit 1`,
      [processId, email],
    );
    return !!r.rowCount;
  }

  /** Confirmação da candidatura pelo modelo "candidatura_recebida" (limitada por e-mail). */
  async function confirmByTemplate(data: ApplicationInput, candidateId: string, applicationId: string) {
    try {
      await deps.limiters.signupAccount.consume(`cand:${data.email}`);
    } catch {
      return;
    }
    await sendCandidateMessage(deps, 'candidatura_recebida', { candidateId, applicationId });
  }

  /** Confirmação automática ao candidato (limitada por e-mail para evitar abuso). */
  async function confirm(data: ApplicationInput, title: string | null) {
    if (deps.config.mailMode === 'manual') return;
    try {
      await deps.limiters.signupAccount.consume(`cand:${data.email}`);
      await deps.mailer.send({
        to: data.email,
        subject: title ? `Candidatura recebida — ${title}` : 'Currículo recebido — Alpha Select',
        text:
          `Olá, ${data.fullName}.\n\n` +
          (title
            ? `Recebemos sua candidatura para a vaga "${title}". `
            : 'Recebemos seu currículo no banco de talentos da Alpha Select. ') +
          'Nossa equipe vai analisar seu perfil e, se ele avançar, entraremos em contato.\n\n' +
          `Seus dados são usados somente para processos seletivos. Para consultar, corrigir ou excluir seus dados: ${deps.config.APP_URL.replace(/\/$/, '')}/meus-dados\n\n` +
          'Alpha Select Consultoria de Recursos Humanos',
      });
    } catch {
      // Falha no aviso não invalida a candidatura.
    }
  }
}
