import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../lib/context.js';
import { asUser, audit, isAlpha, requireUser } from '../../lib/context.js';
import { withTx } from '../../lib/db.js';
import { AppError, forbidden, notFound } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { normalizePhone, zText, zUuid } from '../../lib/normalize.js';
import { UFS } from './profile.js';
import { candidatePortalLink, createCandidateToken } from '../candidate-portal/routes.js';

/** Texto exato do termo pedido pela Alpha Select (gravado junto com o aceite). */
export const ADMISSION_CONSENT =
  'Ao enviar este formulário, declaro que as informações fornecidas são verdadeiras e autorizo o tratamento dos meus ' +
  'dados pessoais exclusivamente para as finalidades relacionadas ao processo de cadastro e processo seletivo, em ' +
  'conformidade com a Lei nº 13.709/2018 (LGPD).';

/** Link do candidato aprovado: 7 dias. */
export const ADMISSION_TTL_MINUTES = 7 * 24 * 60;

export const SEX = ['feminino', 'masculino', 'outro', 'nao_informado'] as const;
export const MARITAL = ['solteiro', 'casado', 'uniao_estavel', 'divorciado', 'separado', 'viuvo'] as const;

/** CPF com dígitos verificadores válidos. */
export function validCpf(d: string) {
  if (!/^\d{11}$/.test(d) || /^(\d)\1{10}$/.test(d)) return false;
  const dv = (len: number) => {
    let s = 0;
    for (let i = 0; i < len; i++) s += Number(d[i]) * (len + 1 - i);
    const r = (s * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
}

const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida.').refine((v) => !Number.isNaN(Date.parse(v)), 'Data inválida.')
  .refine((v) => v >= '1900-01-01' && v <= new Date().toISOString().slice(0, 10), 'Data inválida.');
const zUf = z.string().trim().toUpperCase().pipe(z.enum(UFS, { message: 'Escolha a UF.' }));

export const zAdmission = z
  .object({
    fullName: zText(2, 160),
    birthDate: zDate,
    sex: z.enum(SEX, { message: 'Escolha uma opção.' }),
    maritalStatus: z.enum(MARITAL, { message: 'Escolha uma opção.' }),
    nationality: zText(2, 60),
    birthplaceCity: zText(2, 120),
    birthplaceState: zUf,
    cpf: z.string().transform((v) => v.replace(/\D/g, '')).refine(validCpf, 'CPF inválido.'),
    rg: zText(3, 20),
    rgIssuer: zText(2, 20),
    rgState: zUf,
    rgIssueDate: zDate,
    address: zText(10, 300),
    mobilePhone: z.string().transform((v, ctx) => {
      const p = normalizePhone(v);
      if (!p) ctx.addIssue({ code: 'custom', message: 'Telefone inválido.' });
      return p ?? '';
    }),
    motherName: zText(2, 160),
    fatherName: z.string().nullish().transform((v) => (v?.trim() ? v.trim().slice(0, 160) : null)),
    acceptTerms: z.literal(true, { message: 'É necessário aceitar o termo.' }),
  })
  .strict();

export const admissionSelect = `full_name as "fullName", to_char(birth_date, 'YYYY-MM-DD') as "birthDate", sex,
  marital_status as "maritalStatus", nationality, birthplace_city as "birthplaceCity", birthplace_state as "birthplaceState",
  cpf, rg, rg_issuer as "rgIssuer", rg_state as "rgState", to_char(rg_issue_date, 'YYYY-MM-DD') as "rgIssueDate", address,
  mobile_phone as "mobilePhone", mother_name as "motherName", father_name as "fatherName", consent_at as "consentAt",
  submitted_at as "submittedAt", updated_at as "updatedAt"`;

type Q = { query: <R = unknown>(sql: string, params?: unknown[]) => Promise<{ rows: R[]; rowCount: number | null }> };

/**
 * Participação "a" que libera o formulário: aprovada pelo cliente, ou aprovada
 * na triagem da Alpha Select e ainda em avaliação (sem recusa ou desistência).
 */
export const admissionEligibleSql = `(a.decision = 'aprovado' or (a.decision = 'pendente' and exists (
  select 1 from application_evaluations e where e.application_id = a.id and e.triage_status = 'aprovado_interno')))`;

/** Cadastro aprovado em algum processo (o mais recente), entre os cadastros do mesmo e-mail. */
export async function approvedCandidate(db: Q, ids: string[]) {
  const r = await db.query<{ candidate_id: string }>(
    `select a.candidate_id from applications a where a.candidate_id = any($1::uuid[]) and ${admissionEligibleSql}
      order by a.updated_at desc limit 1`,
    [ids],
  );
  return r.rows[0]?.candidate_id ?? null;
}

/**
 * Gera o link do formulário de admissão (7 dias) e envia por e-mail quando
 * houver e-mail configurado. Retorna o link (a equipe pode copiar e enviar).
 */
export async function sendAdmissionInvite(deps: Deps, candidateId: string, opts: { send: boolean }) {
  const c = await deps.pools.owner.query<{ email: string | null; full_name: string; email_opt_out_at: Date | null }>(
    'select email::text as email, full_name, email_opt_out_at from candidates where id = $1',
    [candidateId],
  );
  const cand = c.rows[0];
  if (!cand?.email) return { link: null, emailed: false };
  const token = await withTx(deps.pools.owner, (db) => createCandidateToken(db, cand.email!, 'admissao', ADMISSION_TTL_MINUTES));
  const link = candidatePortalLink(deps, token);
  let emailed = false;
  if (opts.send && deps.config.mailMode !== 'manual') {
    const subject = 'Parabéns! Complete seus dados para a admissão — Alpha Select';
    let error: string | null = null;
    try {
      await deps.mailer.send({
        to: cand.email,
        subject,
        text:
          `Olá, ${cand.full_name.split(' ')[0]}.\n\nVocê foi aprovado(a) em nossa seleção. Para seguirmos, preencha seus dados ` +
          `pessoais no link abaixo (vale por 7 dias):\n\n${link}\n\nSe o link expirar, peça um novo em ${deps.config.APP_URL.replace(/\/$/, '')}/meus-dados ` +
          'ou fale com a Alpha Select.\n\nAlpha Select Consultoria de Recursos Humanos',
      });
      emailed = true;
    } catch {
      error = 'falha no envio';
    }
    await deps.pools.owner.query(
      `insert into message_log (channel, template_key, candidate_id, to_address, subject, ok, error)
       values ('email', 'dados_admissao', $1, $2, $3, $4, $5)`,
      [candidateId, cand.email, subject, !error, error],
    );
  }
  return { link, emailed };
}

export function registerAdmissionRoutes(app: FastifyInstance, deps: Deps) {
  const alphaOnly = (req: Parameters<typeof requireUser>[0]) => {
    const u = requireUser(req);
    if (!isAlpha(u)) throw forbidden();
    return u;
  };

  /** Equipe Alpha: situação e dados de admissão do candidato (o cliente nunca vê). */
  app.get('/api/candidates/:id/admission', async (req) => {
    alphaOnly(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return asUser(deps, req, async (db) => {
      const c = await db.query<{ email: string | null }>('select email::text as email from candidates where id = $1', [id]);
      if (!c.rows[0]) throw notFound('Candidato não encontrado.');
      const approved = await db.query(`select 1 from applications a where a.candidate_id = $1 and ${admissionEligibleSql} limit 1`, [id]);
      const { rows } = await db.query(`select ${admissionSelect} from candidate_admission_data where candidate_id = $1`, [id]);
      if (rows[0]) await audit(db, req, 'candidate.admission_viewed', 'candidate', id);
      return { approved: !!approved.rowCount, hasEmail: !!c.rows[0].email, data: rows[0] ?? null };
    });
  });

  /** Equipe Alpha: gera (e envia por e-mail, se possível) o link do formulário para o candidato aprovado. */
  app.post('/api/candidates/:id/admission-link', async (req) => {
    alphaOnly(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    await asUser(deps, req, async (db) => {
      const c = await db.query('select 1 from candidates where id = $1', [id]);
      if (!c.rowCount) throw notFound('Candidato não encontrado.');
      const approved = await db.query(`select 1 from applications a where a.candidate_id = $1 and ${admissionEligibleSql} limit 1`, [id]);
      if (!approved.rowCount) throw new AppError(409, 'conflict', 'O formulário fica disponível depois da aprovação na triagem ou no processo seletivo.');
      await audit(db, req, 'candidate.admission_link', 'candidate', id);
    });
    const r = await sendAdmissionInvite(deps, id, { send: true });
    if (!r.link) throw new AppError(422, 'invalid', 'O candidato não tem e-mail cadastrado.');
    return r;
  });
}
