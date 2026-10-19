import { rm } from 'node:fs/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../lib/context.js';
import { newToken, sha256 } from '../../lib/crypto.js';
import { withTx, type Db } from '../../lib/db.js';
import { AppError, badRequest } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { zEmail, zOptionalPhone, zOptionalText, zText } from '../../lib/normalize.js';
import { receiveUpload } from '../../lib/upload.js';
import { insertAudit } from '../auth/service.js';
import { eraseCandidates } from '../candidates/erase.js';
import { CONSENT_VERSION } from '../public/routes.js';
import { PROFILE_COLUMNS, PROFILE_KEYS, profileSelect, zProfile } from '../candidates/profile.js';
import { ADMISSION_CONSENT, admissionSelect, approvedCandidate, zAdmission } from '../candidates/admission.js';

/**
 * Área do candidato: acesso aos próprios dados por link enviado ao e-mail
 * (sem senha). O link vale para todos os cadastros com aquele e-mail. O
 * token vai no cabeçalho X-Candidate-Token (nunca em cookie), então não há
 * risco de CSRF. Observações internas, avaliações e motivos nunca aparecem.
 */
export const ACCESS_TTL_MINUTES = 60;
const RESUME_EXTENSIONS = ['pdf', 'doc', 'docx', 'odt'];
const INVALID = new AppError(401, 'invalid_token', 'Link inválido ou expirado. Peça um novo link de acesso.');

export function candidatePortalLink(deps: Deps, token: string) {
  return `${deps.config.APP_URL.replace(/\/$/, '')}/meus-dados#token=${token}`;
}

/** Cria um token de acesso aos dados do e-mail (usado também pelo aviso de retenção). */
export async function createCandidateToken(db: Db, email: string, purpose: 'acesso' | 'retencao' | 'admissao', minutes: number) {
  const token = newToken();
  // Um link novo invalida os anteriores do mesmo tipo para aquele e-mail.
  await db.query('delete from candidate_access_tokens where email = $1 and purpose = $2', [email, purpose]);
  await db.query(
    `insert into candidate_access_tokens (token_hash, email, purpose, expires_at)
     values ($1, $2, $3, now() + make_interval(mins => $4))`,
    [sha256(token), email, purpose, minutes],
  );
  return token;
}

const appStatus = (processStatus: string, decision: string, sent: boolean) => {
  if (decision === 'aprovado') return 'Aprovado(a)';
  if (decision !== 'pendente' || processStatus !== 'em_andamento') return 'Encerrada';
  return sent ? 'Em avaliação pela empresa' : 'Em análise pela Alpha Select';
};

export function registerCandidatePortalRoutes(app: FastifyInstance, deps: Deps) {
  const owner = deps.pools.owner;
  const pub = { config: { public: true } };

  /** E-mail e cadastros do token; recusa token inválido ou sem cadastro. */
  async function resolve(req: FastifyRequest, db: Db = owner as unknown as Db) {
    const raw = req.headers['x-candidate-token'];
    if (typeof raw !== 'string' || raw.length < 20 || raw.length > 200) throw INVALID;
    const t = await db.query<{ email: string }>(
      'select email::text as email from candidate_access_tokens where token_hash = $1 and expires_at > now()',
      [sha256(raw)],
    );
    const email = t.rows[0]?.email;
    if (!email) throw INVALID;
    const c = await db.query<{ id: string }>('select id from candidates where email = $1 order by created_at desc', [email]);
    if (!c.rowCount) throw INVALID;
    return { email, ids: c.rows.map((r) => r.id) };
  }

  app.post('/api/public/my-data/request', pub, async (req) => {
    const body = parse(z.object({ email: zEmail }).strict(), req.body);
    await deps.limiters.resetIp.consume(`cand-ip:${req.ip}`);
    if (deps.config.mailMode === 'manual') {
      return { ok: true, message: 'No momento o acesso pelo e-mail não está disponível. Fale com a Alpha Select para consultar ou corrigir seus dados.' };
    }
    const message = 'Se houver um cadastro com este e-mail, você receberá o link de acesso em instantes. Ele vale por 60 minutos.';
    try {
      await deps.limiters.resetAccount.consume(`cand:${body.email}`);
    } catch {
      return { ok: true, message }; // mesma resposta: não revela se o e-mail existe
    }
    const target = await withTx(owner, async (db) => {
      const c = await db.query<{ id: string; full_name: string }>(
        'select id, full_name from candidates where email = $1 order by created_at desc limit 1',
        [body.email],
      );
      if (!c.rows[0]) return null;
      const token = await createCandidateToken(db, body.email, 'acesso', ACCESS_TTL_MINUTES);
      await insertAudit(db, null, 'candidate.portal_link_requested', 'candidate', c.rows[0].id, req.ip);
      return { ...c.rows[0], token };
    });
    if (!target) {
      // Mesmo tempo de resposta exista ou não o cadastro (não revela quem está no banco de talentos).
      await new Promise((r) => setTimeout(r, 300 + Math.floor(Math.random() * 700)));
    } else {
      await deps.mailer
        .send({
          to: body.email,
          subject: 'Acesso aos seus dados — Alpha Select',
          text:
            `Olá, ${target.full_name.split(' ')[0]}.\n\nUse o link abaixo para ver, corrigir ou excluir os dados que a Alpha Select ` +
            `guarda sobre você (vale por ${ACCESS_TTL_MINUTES} minutos):\n\n${candidatePortalLink(deps, target.token)}\n\n` +
            'Se você não pediu este acesso, ignore esta mensagem.\n\nAlpha Select Consultoria de Recursos Humanos',
        })
        .catch(() => undefined);
    }
    return { ok: true, message };
  });

  app.get('/api/public/my-data', pub, async (req) => {
    await deps.limiters.tokenIp.consume(`cand-view:${req.ip}`);
    const { email, ids } = await resolve(req);
    const c = await owner.query(
      `select full_name as "fullName", email::text as email, phone, city, salary_expectation as "salaryExpectation",
              consent_at as "consentAt", email_opt_out_at as "emailOptOutAt", created_at as "createdAt",
              whatsapp_opt_in_at as "whatsappOptInAt", ${profileSelect('candidates')}
         from candidates where id = $1`,
      [ids[0]],
    );
    const apps = await owner.query<{ title: string; company: string | null; created_at: Date; status: string; decision: string; sent: boolean; source: string }>(
      `select p.title, case when p.show_company then co.name end as company, a.created_at, p.status, a.decision,
              (a.sent_at is not null) as sent, a.source
         from applications a join processes p on p.id = a.process_id join companies co on co.id = p.company_id
        where a.candidate_id = any($1::uuid[]) order by a.created_at desc`,
      [ids],
    );
    const docs = await owner.query(
      `select original_name as name, kind, size_bytes as size, created_at as "createdAt"
         from documents where candidate_id = any($1::uuid[]) order by created_at desc`,
      [ids],
    );
    const msgs = await owner.query(
      `select subject, sent_at as "sentAt" from message_log where candidate_id = any($1::uuid[]) and ok
        order by sent_at desc limit 50`,
      [ids],
    );
    const ret = await owner.query<{ notice_at: Date | null; notice_days: number; enabled: boolean }>(
      `select (select max(notice_at) from candidate_retention where candidate_id = any($1::uuid[])) as notice_at,
              s.notice_days, s.retention_enabled as enabled
         from privacy_settings s`,
      [ids],
    );
    const r = ret.rows[0];
    // Dados para admissão: só depois da aprovação em algum processo.
    const approvedId = await approvedCandidate(owner, ids);
    const adm = approvedId
      ? await owner.query(`select ${admissionSelect} from candidate_admission_data where candidate_id = $1`, [approvedId])
      : null;
    const deletionScheduledFor = r?.enabled && r.notice_at ? new Date(r.notice_at.getTime() + r.notice_days * 86_400_000) : null;
    return {
      ...c.rows[0],
      email,
      salaryExpectation: c.rows[0]!.salaryExpectation === null ? null : Number(c.rows[0]!.salaryExpectation),
      records: ids.length,
      applications: apps.rows.map((a) => ({
        title: a.title,
        company: a.company,
        appliedAt: a.created_at,
        source: a.source,
        status: appStatus(a.status, a.decision, a.sent),
      })),
      documents: docs.rows,
      messages: msgs.rows,
      deletionScheduledFor,
      admission: { available: !!approvedId, data: adm?.rows[0] ?? null, consentText: ADMISSION_CONSENT },
    };
  });

  /** Formulário de dados pessoais para admissão (candidato aprovado). */
  app.put('/api/public/my-data/admission', pub, async (req) => {
    await deps.limiters.tokenIp.consume(`cand-adm:${req.ip}`);
    const { ids } = await resolve(req);
    const body = parse(zAdmission, req.body);
    const candidateId = await approvedCandidate(owner, ids);
    if (!candidateId) throw new AppError(403, 'forbidden', 'O formulário fica disponível depois da aprovação no processo seletivo.');
    await withTx(owner, async (db) => {
      await db.query(
        `insert into candidate_admission_data (candidate_id, full_name, birth_date, sex, marital_status, nationality, birthplace_city,
           birthplace_state, cpf, rg, rg_issuer, rg_state, rg_issue_date, address, mobile_phone, mother_name, father_name,
           consent_text, consent_at)
         values ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::date, $14, $15, $16, $17, $18, now())
         on conflict (candidate_id) do update set full_name = excluded.full_name, birth_date = excluded.birth_date, sex = excluded.sex,
           marital_status = excluded.marital_status, nationality = excluded.nationality, birthplace_city = excluded.birthplace_city,
           birthplace_state = excluded.birthplace_state, cpf = excluded.cpf, rg = excluded.rg, rg_issuer = excluded.rg_issuer,
           rg_state = excluded.rg_state, rg_issue_date = excluded.rg_issue_date, address = excluded.address,
           mobile_phone = excluded.mobile_phone, mother_name = excluded.mother_name, father_name = excluded.father_name,
           consent_text = excluded.consent_text, consent_at = now(), updated_at = now()`,
        [candidateId, body.fullName, body.birthDate, body.sex, body.maritalStatus, body.nationality, body.birthplaceCity,
          body.birthplaceState, body.cpf, body.rg, body.rgIssuer, body.rgState, body.rgIssueDate, body.address, body.mobilePhone,
          body.motherName, body.fatherName, ADMISSION_CONSENT],
      );
      await insertAudit(db, null, 'candidate.admission_submitted', 'candidate', candidateId, req.ip);
    });
    return { ok: true };
  });

  app.patch('/api/public/my-data', pub, async (req) => {
    const body = parse(
      zProfile
        .extend({
          fullName: zText(2, 160),
          phone: zOptionalPhone,
          salaryExpectation: z.number().min(0).max(10_000_000).nullish().transform((v) => v ?? null),
        })
        .strict(),
      req.body,
    );
    await withTx(owner, async (db) => {
      const { ids } = await resolve(req, db);
      await db.query(
        `update candidates set full_name = $2, phone = $3, salary_expectation = $4,
                ${PROFILE_KEYS.map((k, i) => `${PROFILE_COLUMNS[k]} = $${i + 5}`).join(', ')}
          where id = any($1::uuid[])`,
        [ids, body.fullName, body.phone, body.salaryExpectation, ...PROFILE_KEYS.map((k) => body[k])],
      );
      for (const id of ids) await insertAudit(db, null, 'candidate.self_updated', 'candidate', id, req.ip);
    });
    return { ok: true };
  });

  /** Renova o consentimento: continua no banco de talentos e cancela aviso de exclusão. */
  app.post('/api/public/my-data/consent', pub, async (req) => {
    await withTx(owner, async (db) => {
      const { ids } = await resolve(req, db);
      await db.query('update candidates set consent_at = now(), consent_version = $2 where id = any($1::uuid[])', [ids, CONSENT_VERSION]);
      await db.query(
        `insert into candidate_retention (candidate_id, kept_at)
         select unnest($1::uuid[]), now()
         on conflict (candidate_id) do update set kept_at = now(), notice_at = null, notice_sent = false, kept_by = null`,
        [ids],
      );
      for (const id of ids) await insertAudit(db, null, 'candidate.consent_renewed', 'candidate', id, req.ip);
      // O link do aviso de exclusão cumpriu o papel: vale só mais 1 hora (o suficiente para terminar esta visita).
      await db.query(
        `update candidate_access_tokens set expires_at = least(expires_at, now() + interval '1 hour')
          where email = (select email from candidates where id = $1) and purpose = 'retencao'`,
        [ids[0]],
      );
    });
    return { ok: true };
  });

  app.post('/api/public/my-data/email-preferences', pub, async (req) => {
    const body = parse(z.object({ optOut: z.boolean() }).strict(), req.body);
    await withTx(owner, async (db) => {
      const { ids } = await resolve(req, db);
      await db.query(
        `update candidates set email_opt_out_at = case when $2 then coalesce(email_opt_out_at, now()) end where id = any($1::uuid[])`,
        [ids, body.optOut],
      );
      for (const id of ids) await insertAudit(db, null, body.optOut ? 'candidate.email_opt_out' : 'candidate.email_opt_in', 'candidate', id, req.ip);
    });
    return { ok: true };
  });

  /** Autoriza ou cancela avisos pelo WhatsApp (no telefone do cadastro). */
  app.post('/api/public/my-data/whatsapp', pub, async (req) => {
    const body = parse(z.object({ optIn: z.boolean() }).strict(), req.body);
    await withTx(owner, async (db) => {
      const { ids } = await resolve(req, db);
      const r = await db.query(
        `update candidates set whatsapp_opt_in_at = case when $2 then coalesce(whatsapp_opt_in_at, now()) end
          where id = any($1::uuid[]) and ($2 = false or phone is not null)`,
        [ids, body.optIn],
      );
      if (body.optIn && !r.rowCount) throw new AppError(422, 'invalid', 'Cadastre um telefone para receber pelo WhatsApp.');
      for (const id of ids) await insertAudit(db, null, body.optIn ? 'candidate.whatsapp_opt_in' : 'candidate.whatsapp_opt_out', 'candidate', id, req.ip);
    });
    return { ok: true };
  });

  /** Novo currículo: entra no cadastro mais recente; a equipe vê o mais novo primeiro. */
  app.post('/api/public/my-data/resume', pub, async (req, reply) => {
    await deps.limiters.publicApplyIp.consume(`cand-up:${req.ip}`);
    const { ids } = await resolve(req);
    if (!req.isMultipart()) throw badRequest('Anexe o currículo.');
    const part = await req.file({ limits: { fileSize: deps.config.maxUploadBytes, files: 1, fields: 0 } });
    if (!part) throw new AppError(422, 'invalid', 'Anexe o currículo.');
    const tmp = deps.storage.tmpPath();
    let committed: string | null = null;
    try {
      const file = await receiveUpload(deps, part, tmp, RESUME_EXTENSIONS);
      await withTx(owner, async (db) => {
        const key = deps.storage.newKey();
        const d = await db.query<{ id: string }>(
          `insert into documents (candidate_id, kind, storage_key, original_name, mime_type, size_bytes, sha256)
           values ($1, 'curriculo', $2, $3, $4, $5, $6) returning id`,
          [ids[0], key, file.originalName, file.mime, file.size, file.sha256],
        );
        await deps.storage.commitTmp(tmp, key);
        committed = key;
        await insertAudit(db, null, 'candidate.self_resume', 'document', d.rows[0]!.id, req.ip);
      });
      committed = null;
    } finally {
      await rm(tmp, { force: true }).catch(() => undefined);
      if (committed) await deps.storage.remove(committed).catch(() => undefined);
    }
    reply.code(201);
    return { ok: true };
  });

  /** Cópia dos dados pessoais (acesso/portabilidade). */
  app.get('/api/public/my-data/export', pub, async (req, reply) => {
    const { ids } = await resolve(req);
    const cands = await owner.query(
      `select full_name as nome, email::text as email, phone as telefone, city as cidade,
              salary_expectation as "pretensaoSalarial", source as origem, consent_at as "consentimentoEm",
              email_opt_out_at as "descadastroEmailEm", whatsapp_opt_in_at as "whatsappAutorizadoEm", ${profileSelect('candidates')}, created_at as "cadastradoEm", updated_at as "atualizadoEm"
         from candidates where id = any($1::uuid[]) order by created_at`,
      [ids],
    );
    const apps = await owner.query(
      `select p.title as vaga, case when p.show_company then co.name end as empresa, a.created_at as "candidaturaEm",
              a.source as origem, p.status as "situacaoDoProcesso", a.decision, (a.sent_at is not null) as sent
         from applications a join processes p on p.id = a.process_id join companies co on co.id = p.company_id
        where a.candidate_id = any($1::uuid[]) order by a.created_at`,
      [ids],
    );
    const docs = await owner.query(
      `select original_name as nome, mime_type as formato, size_bytes as "tamanhoBytes", created_at as "enviadoEm"
         from documents where candidate_id = any($1::uuid[]) order by created_at`,
      [ids],
    );
    const msgs = await owner.query(
      `select subject as assunto, to_address::text as para, sent_at as "enviadoEm", ok as entregue
         from message_log where candidate_id = any($1::uuid[]) order by sent_at`,
      [ids],
    );
    const adm = await owner.query(`select ${admissionSelect} from candidate_admission_data where candidate_id = any($1::uuid[])`, [ids]);
    await insertAudit(owner as unknown as Db, null, 'candidate.self_exported', 'candidate', ids[0]!, req.ip);
    reply
      .header('Content-Type', 'application/json; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="meus-dados-alpha-select.json"');
    return JSON.stringify(
      {
        geradoEm: new Date().toISOString(),
        cadastros: cands.rows,
        candidaturas: apps.rows.map(({ decision, sent, ...a }) => ({ ...a, situacao: appStatus(a.situacaoDoProcesso, decision, sent) })),
        documentos: docs.rows,
        mensagens: msgs.rows,
        dadosParaAdmissao: adm.rows,
        observacao:
          'Avaliações e anotações internas da equipe não são exibidas aqui. Para uma cópia completa, peça à Alpha Select.',
      },
      null,
      2,
    );
  });

  /** Exclusão pedida pelo próprio candidato: imediata e definitiva. */
  app.post('/api/public/my-data/delete', pub, async (req) => {
    parse(z.object({ confirm: z.literal(true) }).strict(), req.body);
    const keys = await withTx(owner, async (db) => {
      const { email, ids } = await resolve(req, db);
      const k = await eraseCandidates(db, ids);
      await db.query('delete from candidate_access_tokens where email = $1', [email]);
      for (const id of ids) await insertAudit(db, null, 'candidate.self_erased', 'candidate', id, req.ip, { documents: k.length });
      return k;
    });
    for (const k of keys) await deps.storage.remove(k).catch(() => undefined);
    return { ok: true };
  });
}
