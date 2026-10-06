import type { Deps } from '../../lib/context.js';
import { withTx, type Db } from '../../lib/db.js';
import { insertAudit } from '../auth/service.js';
import { eraseCandidates } from '../candidates/erase.js';
import { candidatePortalLink, createCandidateToken } from '../candidate-portal/routes.js';

/**
 * Regra de retenção do banco de talentos (LGPD), executada pela tarefa
 * periódica. Candidatos sem atividade há mais de N meses e fora de
 * processos em andamento recebem um aviso; se nada mudar em X dias, são
 * eliminados. Qualquer atividade depois do aviso (renovação pelo
 * candidato, edição, nova participação, "manter" do administrador)
 * cancela o aviso.
 */
const BATCH = 200;

/** Condição comum: sem participação em processo em andamento e sem atividade no prazo. */
export const inactiveWhere = `
  not exists (select 1 from applications a join processes p on p.id = a.process_id
               where a.candidate_id = c.id and p.status = 'em_andamento')
  and app.candidate_last_activity(c.id) < now() - make_interval(months => s.retention_months)`;

export async function runRetention(deps: Deps) {
  const owner = deps.pools.owner;
  const s = (
    await owner.query<{ retention_enabled: boolean; retention_months: number; notice_days: number }>(
      'select retention_enabled, retention_months, notice_days from privacy_settings',
    )
  ).rows[0];
  if (!s?.retention_enabled) return { noticed: 0, erased: 0, canceled: 0 };

  // 1. Avisos cancelados: houve atividade depois do aviso ou entrou em processo ativo.
  const canceled = await owner.query(
    `update candidate_retention r set notice_at = null, notice_sent = false
       from candidates c, privacy_settings s
      where c.id = r.candidate_id and r.notice_at is not null and not (${inactiveWhere})`,
  );

  // 2. Eliminação: aviso há mais de X dias e nada mudou.
  const due = await owner.query<{ id: string }>(
    `select c.id from candidates c join candidate_retention r on r.candidate_id = c.id cross join privacy_settings s
      where r.notice_at < now() - make_interval(days => s.notice_days) and ${inactiveWhere}
      limit ${BATCH}`,
  );
  let erased = 0;
  for (const { id } of due.rows) {
    const keys = await withTx(owner, async (db) => {
      const k = await eraseCandidates(db, [id]);
      await insertAudit(db, null, 'candidate.retention_erased', 'candidate', id, null, { documents: k.length });
      return k;
    });
    erased++;
    for (const k of keys) await deps.storage.remove(k).catch(() => undefined);
  }

  // 3. Novos avisos.
  const toNotice = await owner.query<{ id: string; full_name: string; email: string | null; opt_out: boolean }>(
    `select c.id, c.full_name, c.email::text as email, (c.email_opt_out_at is not null) as opt_out
       from candidates c cross join privacy_settings s left join candidate_retention r on r.candidate_id = c.id
      where r.notice_at is null and ${inactiveWhere}
      order by c.email nulls last
      limit ${BATCH}`,
  );
  const deadline = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'long', timeZone: 'America/Sao_Paulo' }).format(
    new Date(Date.now() + s.notice_days * 86_400_000),
  );
  // Resultado do envio por e-mail nesta execução (cadastros com o mesmo e-mail recebem um aviso só).
  const mailed = new Map<string, boolean>();
  let noticed = 0;
  for (const c of toNotice.rows) {
    const canMail = !!c.email && !c.opt_out && deps.config.mailMode !== 'manual';
    let sent = false;
    const key = c.email?.toLowerCase() ?? '';
    if (canMail && !mailed.has(key)) {
      const token = await createCandidateToken(owner as unknown as Db, c.email!, 'retencao', s.notice_days * 24 * 60);
      const subject = 'Seus dados no banco de talentos — Alpha Select';
      try {
        await deps.mailer.send({
          to: c.email!,
          subject,
          text:
            `Olá, ${c.full_name.split(' ')[0]}.\n\nSeu currículo está no banco de talentos da Alpha Select, mas não houve ` +
            `atividade nos últimos ${s.retention_months} meses. Pela nossa política de privacidade, seus dados serão ` +
            `excluídos em ${deadline}.\n\nQuer continuar participando dos nossos processos seletivos? Acesse o link abaixo e ` +
            `clique em "Quero continuar no banco de talentos" (você também pode atualizar seus dados e currículo):\n\n` +
            `${candidatePortalLink(deps, token)}\n\nSe preferir sair, não precisa fazer nada.\n\nAlpha Select Consultoria de Recursos Humanos`,
        });
        sent = true;
      } catch {
        sent = false;
      }
      mailed.set(key, sent);
      await owner.query(
        `insert into message_log (template_key, candidate_id, to_address, subject, ok, error)
         values ('aviso_retencao', $1, $2, $3, $4, $5)`,
        [c.id, c.email, subject, sent, sent ? null : 'falha no envio'],
      );
    } else if (canMail) {
      sent = mailed.get(key)!;
    }
    // Falha no envio: sem aviso registrado, tenta de novo na próxima execução (o prazo só corre depois do aviso).
    if (canMail && !sent) continue;
    noticed++;
    await owner.query(
      `insert into candidate_retention (candidate_id, notice_at, notice_sent) values ($1, now(), $2)
       on conflict (candidate_id) do update set notice_at = now(), notice_sent = excluded.notice_sent`,
      [c.id, sent],
    );
  }
  return { noticed, erased, canceled: canceled.rowCount ?? 0 };
}
