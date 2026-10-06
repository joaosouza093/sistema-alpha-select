import { createHmac } from 'node:crypto';
import type { Deps } from './context.js';
import { safeEqual } from './crypto.js';

/**
 * Envio pela WhatsApp Cloud API (Meta). Mensagens iniciadas pela empresa
 * usam modelos aprovados; os parâmetros entram no corpo do modelo na
 * ordem documentada em docs/WHATSAPP.md.
 */
export const whatsappConfigured = (deps: Deps) => !!deps.config.WHATSAPP_TOKEN && !!deps.config.WHATSAPP_PHONE_NUMBER_ID;

/** "+55 (11) 98888-7777" → "5511988887777" (formato que a API espera). */
export const waNumber = (phone: string) => phone.replace(/\D/g, '');

/** A Meta recusa parâmetro vazio, com quebra de linha, tabulação ou 4+ espaços seguidos. */
export const waParam = (v: string | null | undefined) => (v ?? '').replace(/\s+/g, ' ').trim().slice(0, 900) || '-';

export class WhatsAppError extends Error {}

export async function sendWhatsAppTemplate(
  deps: Deps,
  to: string,
  template: { name: string; language: string },
  params: (string | null | undefined)[],
): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  let res: Response;
  try {
    res = await fetch(`${deps.config.WHATSAPP_API_URL.replace(/\/$/, '')}/${deps.config.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${deps.config.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: waNumber(to),
        type: 'template',
        template: {
          name: template.name,
          language: { code: template.language },
          components: params.length ? [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: waParam(p) })) }] : [],
        },
      }),
      signal: ctrl.signal,
    });
  } catch {
    throw new WhatsAppError('WhatsApp indisponível no momento.');
  } finally {
    clearTimeout(timer);
  }
  const data = (await res.json().catch(() => null)) as { messages?: { id: string }[]; error?: { message?: string; code?: number } } | null;
  const id = data?.messages?.[0]?.id;
  if (!res.ok || !id) {
    const e = data?.error;
    throw new WhatsAppError(`WhatsApp: ${e?.message ?? `erro ${res.status}`}${e?.code ? ` (${e.code})` : ''}`.slice(0, 190));
  }
  return id;
}

/** Assinatura X-Hub-Signature-256 do webhook (HMAC-SHA256 do corpo com a chave do app). */
export function validWebhookSignature(deps: Deps, raw: Buffer, header: unknown) {
  const secret = deps.config.WHATSAPP_APP_SECRET;
  if (!secret || typeof header !== 'string') return false;
  const expected = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  return safeEqual(header, expected);
}
