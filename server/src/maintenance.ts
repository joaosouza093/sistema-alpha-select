import type { Deps } from './lib/context.js';
import { runBillingNotifications } from './modules/billing/notify.js';
import { sendFeedbackReminders } from './modules/messages/service.js';
import { runRetention } from './modules/privacy/retention.js';

/**
 * Tarefa periódica (a cada hora): limpeza de sessões, tokens e contadores
 * vencidos, de pedidos de cadastro abandonados, regra de retenção (LGPD) e
 * envio dos e-mails de cobrança.
 */
export async function runMaintenance(deps: Deps) {
  await deps.pools.owner.query(
    `delete from sessions where expires_at < now();
     delete from password_resets where expires_at < now() - interval '7 days';
     delete from invites where expires_at < now() - interval '30 days' and used_at is null;
     delete from rate_limit_counters where expires_at < now() - interval '1 hour';
     delete from mfa_challenges where expires_at < now();
     delete from candidate_access_tokens where expires_at < now();
     delete from signup_requests
      where status = 'pendente' and email_verified_at is null and verify_expires_at < now() - interval '5 days';
     delete from signup_requests where status = 'recusado' and decided_at < now() - interval '90 days';`,
  );
  await sendFeedbackReminders(deps).catch(() => 0);
  await runRetention(deps).catch(() => undefined);
  return runBillingNotifications(deps);
}
