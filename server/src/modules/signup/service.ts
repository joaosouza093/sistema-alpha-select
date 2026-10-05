import type { Deps } from '../../lib/context.js';
import { withTx } from '../../lib/db.js';
import { hashPassword, newToken, sha256 } from '../../lib/crypto.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { INVITE_TTL_HOURS, createInvite, insertAudit, inviteLink } from '../auth/service.js';

export const VERIFY_TTL_HOURS = 48;

export interface SignupInput {
  companyName: string;
  cnpj: string | null;
  fullName: string;
  email: string;
  phone: string | null;
}

const appUrl = (deps: Deps, path: string) => `${deps.config.APP_URL.replace(/\/$/, '')}${path}`;

/** Sem SMTP (modo manual) não há como confirmar o e-mail: o administrador confere por outro canal. */
export const emailVerificationEnabled = (deps: Deps) => deps.config.mailMode !== 'manual';

/**
 * Pedido de cadastro feito pelo site. A resposta é sempre a mesma, exista ou
 * não conta com o e-mail (não revela quem é cliente). A senha só é definida
 * pelo link enviado ao e-mail — quem não controla o e-mail não consegue
 * criar acesso em nome de outra pessoa. Nada é liberado sem aprovação de um
 * administrador.
 */
export async function requestSignup(deps: Deps, input: SignupInput, ip: string) {
  await deps.limiters.signupIp.consume(`ip:${ip}`);
  const verify = emailVerificationEnabled(deps);
  const token = verify ? newToken() : null;
  const tokenHash = token ? sha256(token) : null;

  const outcome = await withTx(deps.pools.owner, async (db): Promise<'created' | 'exists'> => {
    const user = await db.query('select 1 from users where email = $1', [input.email]);
    if (user.rowCount) return 'exists';
    // Pedido pendente ainda não confirmado: atualiza os dados e reenvia o link.
    const upd = await db.query<{ id: string }>(
      `update signup_requests
          set company_name = $2, cnpj = $3, full_name = $4, phone = $5, verify_token_hash = $6,
              verify_expires_at = case when $6::bytea is null then null else now() + make_interval(hours => $7) end,
              consent_at = now(), ip = $8, created_at = now()
        where email = $1 and status = 'pendente' and email_verified_at is null
        returning id`,
      [input.email, input.companyName, input.cnpj, input.fullName, input.phone, tokenHash, VERIFY_TTL_HOURS, ip],
    );
    if (upd.rows[0]) {
      await insertAudit(db, null, 'signup.requested', 'signup_request', upd.rows[0].id, ip, { reenvio: true });
      return 'created';
    }
    const { rows } = await db.query<{ id: string }>(
      `insert into signup_requests
         (company_name, cnpj, full_name, email, phone, verify_token_hash, verify_expires_at, consent_at, ip)
       values ($1, $2, $3, $4, $5, $6, case when $6::bytea is null then null else now() + make_interval(hours => $7) end, now(), $8)
       on conflict do nothing
       returning id`,
      [input.companyName, input.cnpj, input.fullName, input.email, input.phone, tokenHash, VERIFY_TTL_HOURS, ip],
    );
    if (!rows[0]) return 'exists';
    await insertAudit(db, null, 'signup.requested', 'signup_request', rows[0].id, ip);
    return 'created';
  });

  if (!verify) return;
  try {
    await deps.limiters.signupAccount.consume(`acc:${input.email}`);
  } catch {
    return; // evita usar o formulário para lotar a caixa de alguém
  }
  if (outcome === 'created' && token) {
    await deps.mailer.send({
      to: input.email,
      subject: 'Confirme seu cadastro — Alpha Select',
      text:
        `Olá, ${input.fullName}.\n\nRecebemos o cadastro da empresa ${input.companyName} no sistema da Alpha Select.\n` +
        `Para confirmar seu e-mail e criar sua senha, acesse o link abaixo (válido por ${VERIFY_TTL_HOURS} horas):\n\n` +
        `${appUrl(deps, `/confirmar-email#token=${token}`)}\n\n` +
        'Depois disso, a equipe da Alpha Select analisa o cadastro e avisa por e-mail quando o acesso for liberado.\n\n' +
        'Se você não fez este cadastro, ignore esta mensagem.',
    });
  } else {
    await deps.mailer.send({
      to: input.email,
      subject: 'Cadastro no sistema — Alpha Select',
      text:
        'Olá.\n\nAlguém tentou criar um cadastro com este e-mail, mas ele já possui conta ou um cadastro em análise.\n' +
        `Se esqueceu sua senha, use "Esqueci minha senha" em ${appUrl(deps, '/esqueci-senha')}.\n\n` +
        'Se não foi você, ignore esta mensagem.',
    });
  }
}

/** Confirma o e-mail pelo link recebido e grava a senha escolhida. */
export async function verifySignupEmail(deps: Deps, token: string, password: string, ip: string) {
  await deps.limiters.tokenIp.consume(`ip:${ip}`);
  const hash = await hashPassword(password);
  const row = await withTx(deps.pools.owner, async (db) => {
    const { rows } = await db.query<{ id: string; company_name: string }>(
      `update signup_requests set email_verified_at = now(), verify_token_hash = null, password_hash = $2
        where verify_token_hash = $1 and status = 'pendente' and verify_expires_at > now()
        returning id, company_name`,
      [sha256(token), hash],
    );
    if (!rows[0]) throw badRequest('Link inválido, expirado ou já utilizado. Faça o cadastro novamente.');
    await insertAudit(db, null, 'signup.email_verified', 'signup_request', rows[0].id, ip);
    return rows[0];
  });
  await notifyAdmins(deps, row.company_name).catch(() => undefined);
}

/** Avisa os administradores ativos que há um cadastro aguardando aprovação. */
async function notifyAdmins(deps: Deps, companyName: string) {
  const { rows } = await deps.pools.owner.query<{ email: string }>(
    "select email from users where kind = 'alpha_admin' and is_active",
  );
  for (const r of rows) {
    await deps.mailer.send({
      to: r.email,
      subject: 'Novo cadastro aguardando aprovação — Alpha Select',
      text:
        `A empresa ${companyName} se cadastrou no sistema e confirmou o e-mail.\n\n` +
        `Para aprovar ou recusar, acesse: ${appUrl(deps, '/cadastros')}`,
    });
  }
}

interface RequestRow {
  id: string;
  company_name: string;
  cnpj: string | null;
  full_name: string;
  email: string;
  password_hash: string | null;
  status: string;
  email_verified_at: Date | null;
}

async function lockPending(db: import('../../lib/db.js').Db, id: string) {
  const { rows } = await db.query<RequestRow>(
    `select id, company_name, cnpj, full_name, email, password_hash, status, email_verified_at
       from signup_requests where id = $1 for update`,
    [id],
  );
  const r = rows[0];
  if (!r) throw notFound();
  if (r.status !== 'pendente') throw conflict('Este cadastro já foi analisado.');
  return r;
}

/**
 * Aprova o pedido: cria (ou usa) a empresa e cria o usuário de cliente com a
 * senha escolhida no cadastro. O usuário só vê processos aos quais for vinculado.
 */
export async function approveSignup(
  deps: Deps,
  adminId: string,
  id: string,
  opts: { kind: 'client_user' | 'client_manager'; companyId: string | null },
  ip: string,
) {
  const result = await withTx(deps.pools.owner, async (db) => {
    const r = await lockPending(db, id);
    if (emailVerificationEnabled(deps) && !r.email_verified_at) {
      throw new AppError(422, 'invalid', 'O solicitante ainda não confirmou o e-mail.');
    }
    const exists = await db.query('select 1 from users where email = $1', [r.email]);
    if (exists.rowCount) throw conflict('Já existe um usuário com este e-mail.');

    let companyId = opts.companyId;
    if (companyId) {
      const c = await db.query('select 1 from companies where id = $1 and is_active', [companyId]);
      if (!c.rowCount) throw new AppError(422, 'invalid', 'Empresa não encontrada ou inativa.');
    } else {
      const dup = await db.query(
        'select 1 from companies where lower(btrim(name)) = lower(btrim($1)) or ($2::text is not null and cnpj = $2)',
        [r.company_name, r.cnpj],
      );
      if (dup.rowCount) {
        throw conflict('Já existe uma empresa com este nome ou CNPJ. Escolha a empresa existente para vincular o usuário.');
      }
      const c = await db.query<{ id: string }>(
        'insert into companies (name, cnpj, billing_email) values ($1, $2, $3) returning id',
        [r.company_name, r.cnpj, r.email],
      );
      companyId = c.rows[0]!.id;
      await insertAudit(db, adminId, 'company.created', 'company', companyId, ip, { origem: 'cadastro' });
    }
    const u = await db.query<{ id: string }>(
      'insert into users (email, full_name, kind, company_id) values ($1, $2, $3, $4) returning id',
      [r.email, r.full_name, opts.kind, companyId],
    );
    const userId = u.rows[0]!.id;
    // Com e-mail confirmado a senha já foi escolhida; sem e-mail (modo manual) gera convite.
    let inviteToken: string | null = null;
    if (r.password_hash) {
      await db.query('insert into user_credentials (user_id, password_hash) values ($1, $2)', [userId, r.password_hash]);
    } else {
      inviteToken = await createInvite(deps, db, userId, adminId);
    }
    await db.query(
      `update signup_requests set status = 'aprovado', decided_at = now(), decided_by = $2, password_hash = null,
              verify_token_hash = null, company_id = $3, user_id = $4
        where id = $1`,
      [id, adminId, companyId, userId],
    );
    await insertAudit(db, adminId, 'signup.approved', 'signup_request', id, ip, { userId, companyId, kind: opts.kind });
    return { email: r.email, name: r.full_name, userId, companyId, inviteToken };
  });

  if (result.inviteToken) {
    // Modo manual: o link é mostrado só ao administrador, que o envia por canal seguro.
    return {
      userId: result.userId,
      companyId: result.companyId,
      inviteLink: inviteLink(deps, result.inviteToken),
      validHours: INVITE_TTL_HOURS,
    };
  }
  if (deps.config.mailMode !== 'manual') {
    await deps.mailer
      .send({
        to: result.email,
        subject: 'Acesso liberado — Alpha Select',
        text:
          `Olá, ${result.name}.\n\nSeu cadastro foi aprovado. Entre com seu e-mail e a senha que você escolheu:\n\n` +
          `${appUrl(deps, '/entrar')}\n\nOs processos seletivos aparecem assim que a equipe da Alpha Select liberá-los para você.`,
      })
      .catch(() => undefined);
  }
  return { userId: result.userId, companyId: result.companyId };
}

export async function rejectSignup(deps: Deps, adminId: string, id: string, note: string | null, ip: string) {
  const r = await withTx(deps.pools.owner, async (db) => {
    const row = await lockPending(db, id);
    await db.query(
      `update signup_requests set status = 'recusado', decided_at = now(), decided_by = $2, decision_note = $3,
              password_hash = null, verify_token_hash = null
        where id = $1`,
      [id, adminId, note],
    );
    await insertAudit(db, adminId, 'signup.rejected', 'signup_request', id, ip);
    return row;
  });
  if (deps.config.mailMode !== 'manual' && r.email_verified_at) {
    await deps.mailer
      .send({
        to: r.email,
        subject: 'Cadastro não aprovado — Alpha Select',
        text:
          `Olá, ${r.full_name}.\n\nO cadastro da empresa ${r.company_name} não foi aprovado.\n` +
          'Em caso de dúvida, entre em contato com a equipe da Alpha Select.',
      })
      .catch(() => undefined);
  }
}
