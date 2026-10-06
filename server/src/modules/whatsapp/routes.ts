import type { FastifyInstance } from 'fastify';
import type { Deps } from '../../lib/context.js';
import type { Db } from '../../lib/db.js';
import { validWebhookSignature, waNumber } from '../../lib/whatsapp.js';
import { insertAudit } from '../auth/service.js';

/** Respostas do candidato que cancelam as mensagens pelo WhatsApp. */
const OPT_OUT = new Set(['sair', 'parar', 'pare', 'cancelar', 'stop', 'descadastrar']);
const STATUS: Record<string, string> = { sent: 'enviada', delivered: 'entregue', read: 'lida', failed: 'falhou' };

interface WebhookBody {
  entry?: {
    changes?: {
      value?: {
        statuses?: { id?: string; status?: string; errors?: { title?: string; message?: string; code?: number }[] }[];
        messages?: { from?: string; type?: string; text?: { body?: string }; button?: { text?: string } }[];
      };
    }[];
  }[];
}

/**
 * Webhook da WhatsApp Cloud API: confirmação da URL (GET) e eventos (POST)
 * com assinatura X-Hub-Signature-256 conferida sobre o corpo bruto.
 */
export function registerWhatsAppRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/api/webhooks/whatsapp', { config: { public: true } }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const expected = deps.config.WHATSAPP_VERIFY_TOKEN;
    if (q['hub.mode'] === 'subscribe' && expected && q['hub.verify_token'] === expected && q['hub.challenge']) {
      reply.header('Content-Type', 'text/plain');
      return q['hub.challenge'].slice(0, 200);
    }
    reply.code(403);
    return { ok: false };
  });

  // Plugin isolado: só esta rota recebe o JSON como Buffer (necessário para conferir a assinatura).
  app.register(async (sub) => {
    sub.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 1024 * 1024 }, (_req, body, done) => done(null, body));
    sub.post('/api/webhooks/whatsapp', { config: { public: true } }, async (req, reply) => {
      const raw = req.body as Buffer;
      if (!Buffer.isBuffer(raw) || !validWebhookSignature(deps, raw, req.headers['x-hub-signature-256'])) {
        reply.code(401);
        return { ok: false };
      }
      let body: WebhookBody;
      try {
        body = JSON.parse(raw.toString('utf8')) as WebhookBody;
      } catch {
        return { ok: true, ignored: true };
      }
      const owner = deps.pools.owner;
      let statuses = 0;
      let optOuts = 0;
      for (const entry of body.entry ?? []) {
        for (const change of entry.changes ?? []) {
          const v = change.value ?? {};
          for (const s of v.statuses ?? []) {
            const status = s.status && STATUS[s.status];
            if (!s.id || !status) continue;
            const err = s.errors?.[0];
            // Só avança (enviada → entregue → lida); "falhou" sempre vale.
            const r = await owner.query(
              `update message_log set delivery_status = $2,
                      ok = case when $2 = 'falhou' then false else ok end,
                      error = case when $2 = 'falhou' then left($3, 200) else error end
                where provider_id = $1
                  and (delivery_status is null or $2 = 'falhou'
                       or array_position(array['enviada','entregue','lida'], $2)
                          > coalesce(array_position(array['enviada','entregue','lida'], delivery_status), 0))`,
              [s.id, status, err ? `WhatsApp: ${err.title ?? err.message ?? 'falha'}${err.code ? ` (${err.code})` : ''}` : null],
            );
            statuses += r.rowCount ?? 0;
          }
          for (const m of v.messages ?? []) {
            const text = (m.text?.body ?? m.button?.text ?? '').trim().toLowerCase();
            if (!m.from || !OPT_OUT.has(text)) continue;
            const r = await owner.query<{ id: string }>(
              `update candidates set whatsapp_opt_in_at = null
                where whatsapp_opt_in_at is not null and regexp_replace(phone, '\\D', '', 'g') = $1 returning id`,
              [waNumber(m.from)],
            );
            for (const c of r.rows) await insertAudit(owner as unknown as Db, null, 'candidate.whatsapp_opt_out', 'candidate', c.id, null);
            optOuts += r.rowCount ?? 0;
          }
        }
      }
      return { ok: true, statuses, optOuts };
    });
  });
}
