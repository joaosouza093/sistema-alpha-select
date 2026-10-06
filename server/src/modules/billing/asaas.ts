import type { Deps } from '../../lib/context.js';
import { safeEqual } from '../../lib/crypto.js';
import type { Db } from '../../lib/db.js';
import { insertAudit } from '../auth/service.js';
import { billingEmailEnabled, loadSettings, sendNotice } from './notify.js';

/**
 * Cliente mínimo da API v3 do Asaas e sincronização das cobranças.
 * Documentação: https://docs.asaas.com (clientes, cobranças, webhooks).
 */

export interface AsaasPayment {
  id: string;
  status: string; // PENDING, RECEIVED, CONFIRMED, OVERDUE, RECEIVED_IN_CASH, REFUNDED, DELETED…
  value: number;
  dueDate: string;
  billingType?: string;
  invoiceUrl?: string;
  paymentDate?: string | null;
  clientPaymentDate?: string | null;
  externalReference?: string | null;
  deleted?: boolean;
}

export class AsaasError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const PAID = new Set(['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH']);

export const asaasConfigured = (deps: Deps) => !!deps.config.ASAAS_API_KEY;

export function asaasBaseUrl(deps: Deps) {
  if (deps.config.ASAAS_API_URL) return deps.config.ASAAS_API_URL.replace(/\/$/, '');
  // Chaves de produção começam com $aact_prod_; as de sandbox, com $aact_hmlg_.
  return deps.config.ASAAS_API_KEY?.startsWith('$aact_prod_') ? 'https://api.asaas.com/v3' : 'https://api-sandbox.asaas.com/v3';
}

export const asaasEnvironment = (deps: Deps) =>
  !asaasConfigured(deps) ? null : deps.config.ASAAS_API_KEY!.startsWith('$aact_prod_') ? 'producao' : 'sandbox';

async function call<T>(deps: Deps, method: string, path: string, body?: unknown): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  let res: Response;
  try {
    res = await fetch(`${asaasBaseUrl(deps)}${path}`, {
      method,
      headers: {
        access_token: deps.config.ASAAS_API_KEY!,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'alpha-select',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch {
    throw new AsaasError(0, 'Asaas indisponível no momento.');
  } finally {
    clearTimeout(timer);
  }
  const data = (await res.json().catch(() => null)) as { errors?: { description?: string }[] } | null;
  if (!res.ok) {
    const msg = data?.errors?.map((e) => e.description).filter(Boolean).join('; ') || `erro ${res.status}`;
    throw new AsaasError(res.status, `Asaas: ${msg}`.slice(0, 280));
  }
  return data as T;
}

interface ChargeForGateway {
  id: string;
  status: 'pendente' | 'pago' | 'cancelado';
  description: string;
  amount_cents: number;
  due_date: string;
  paid_at: Date | null;
  gateway_id: string | null;
  company_id: string;
  company_name: string;
  cnpj: string | null;
  billing_email: string;
  asaas_customer_id: string | null;
}

async function ensureCustomer(deps: Deps, c: ChargeForGateway): Promise<string> {
  if (c.asaas_customer_id) return c.asaas_customer_id;
  if (!c.cnpj) throw new AsaasError(422, 'Cadastre o CNPJ da empresa (Empresas clientes → Editar) para gerar boleto/Pix no Asaas.');
  // Reaproveita cliente já existente no Asaas com o mesmo CNPJ.
  const found = await call<{ data: { id: string }[] }>(deps, 'GET', `/customers?cpfCnpj=${c.cnpj}&limit=1`);
  const id =
    found.data[0]?.id ??
    (
      await call<{ id: string }>(deps, 'POST', '/customers', {
        name: c.company_name,
        cpfCnpj: c.cnpj,
        email: c.billing_email,
        externalReference: c.company_id,
        // Os e-mails de cobrança saem do próprio sistema; evita avisos duplicados do Asaas.
        notificationDisabled: true,
      })
    ).id;
  await deps.pools.owner.query('update companies set asaas_customer_id = $2 where id = $1', [c.company_id, id]);
  return id;
}

const brDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(d);

/** Envia ao Asaas a alteração pendente de uma cobrança. */
async function pushCharge(deps: Deps, c: ChargeForGateway) {
  const owner = deps.pools.owner;
  const value = c.amount_cents / 100;
  if (c.status === 'pendente' && !c.gateway_id) {
    const customer = await ensureCustomer(deps, c);
    const p = await call<AsaasPayment>(deps, 'POST', '/payments', {
      customer,
      billingType: 'UNDEFINED', // o cliente escolhe boleto, Pix ou cartão na página de pagamento
      value,
      dueDate: c.due_date,
      description: c.description,
      externalReference: c.id,
    });
    await owner.query(
      `update charges set gateway_id = $2, gateway_status = $3, payment_link = $4, gateway_dirty = false,
              gateway_error = null, gateway_attempts = 0, gateway_synced_at = now() where id = $1`,
      [c.id, p.id, p.status, p.invoiceUrl ?? null],
    );
    return;
  }
  if (c.gateway_id && c.status === 'pendente') {
    const p = await call<AsaasPayment>(deps, 'POST', `/payments/${c.gateway_id}`, { value, dueDate: c.due_date, description: c.description });
    await owner.query(
      `update charges set gateway_status = $2, gateway_dirty = false, gateway_error = null, gateway_attempts = 0,
              gateway_synced_at = now() where id = $1`,
      [c.id, p.status],
    );
    return;
  }
  if (c.gateway_id && c.status === 'cancelado') {
    await call(deps, 'DELETE', `/payments/${c.gateway_id}`).catch((e) => {
      if (!(e instanceof AsaasError && e.status === 404)) throw e;
    });
    await owner.query(
      `update charges set gateway_status = 'DELETED', gateway_dirty = false, gateway_error = null, gateway_attempts = 0,
              gateway_synced_at = now() where id = $1`,
      [c.id],
    );
    return;
  }
  if (c.gateway_id && c.status === 'pago') {
    // Baixa manual no sistema: informa o Asaas para a cobrança não seguir em aberto lá.
    await call(deps, 'POST', `/payments/${c.gateway_id}/receiveInCash`, {
      paymentDate: brDate(c.paid_at ?? new Date()),
      value,
      notifyCustomer: false,
    }).catch((e) => {
      if (!(e instanceof AsaasError && e.status === 400)) throw e; // já recebida no Asaas
    });
  }
  await owner.query(
    `update charges set gateway_dirty = false, gateway_error = null, gateway_attempts = 0, gateway_synced_at = now() where id = $1`,
    [c.id],
  );
}

/** Gateway ligado: chave configurada no servidor e opção ativa nas configurações. */
export async function gatewayActive(deps: Deps) {
  if (!asaasConfigured(deps)) return false;
  const { rows } = await deps.pools.owner.query<{ gateway_enabled: boolean }>('select gateway_enabled from billing_settings limit 1');
  return !!rows[0]?.gateway_enabled;
}

/**
 * Processa as cobranças marcadas (gateway_dirty). Falhas ficam registradas
 * e são tentadas de novo na próxima execução (até 10 vezes).
 */
export async function syncGateway(deps: Deps, opts: { chargeIds?: string[]; budgetMs?: number } = {}) {
  const result = { synced: 0, failed: 0 };
  if (!(await gatewayActive(deps))) return result;
  const started = Date.now();
  const { rows } = await deps.pools.owner.query<ChargeForGateway>(
    `select c.id, c.status, c.description, c.amount_cents, to_char(c.due_date, 'YYYY-MM-DD') as due_date, c.paid_at,
            c.gateway_id, c.company_id, co.name as company_name, co.cnpj, c.billing_email::text as billing_email,
            co.asaas_customer_id
       from charges c join companies co on co.id = c.company_id
      where c.gateway_dirty and c.gateway_attempts < 10 and ($1::uuid[] is null or c.id = any($1))
      order by c.created_at limit 100`,
    [opts.chargeIds ?? null],
  );
  for (const c of rows) {
    if (Date.now() - started > (opts.budgetMs ?? 20_000)) break;
    try {
      await pushCharge(deps, c);
      result.synced++;
    } catch (e) {
      result.failed++;
      const msg = e instanceof AsaasError ? e.message : 'Falha ao comunicar com o Asaas.';
      await deps.pools.owner.query(
        'update charges set gateway_error = $2, gateway_attempts = gateway_attempts + 1 where id = $1',
        [c.id, msg.slice(0, 300)],
      );
    }
  }
  return result;
}

/**
 * Aplica o estado de um pagamento do Asaas à cobrança local (webhook ou
 * "Atualizar do Asaas"). Pagamento confirmado → baixa automática + recibo.
 */
export async function applyPayment(deps: Deps, p: AsaasPayment, source: 'webhook' | 'sync') {
  const owner = deps.pools.owner;
  const { rows } = await owner.query<{ id: string; status: string; company_id: string }>(
    'select id, status, company_id from charges where gateway_id = $1',
    [p.id],
  );
  const c = rows[0];
  if (!c) return { found: false, paid: false };
  const status = p.deleted ? 'DELETED' : p.status;
  await owner.query('update charges set gateway_status = $2, gateway_synced_at = now() where id = $1', [c.id, status]);
  if (!PAID.has(status) || c.status !== 'pendente') return { found: true, paid: false };
  const day = p.clientPaymentDate ?? p.paymentDate ?? null;
  const how = p.billingType === 'PIX' ? 'Pix' : p.billingType === 'BOLETO' ? 'boleto' : p.billingType === 'CREDIT_CARD' ? 'cartão' : null;
  const upd = await owner.query(
    `update charges set status = 'pago', paid_via = 'asaas', paid_note = $2,
            paid_at = coalesce(($3::date + time '12:00') at time zone 'America/Sao_Paulo', now())
      where id = $1 and status = 'pendente'`,
    [c.id, `Pago pelo Asaas${how ? ` (${how})` : ''}`, day],
  );
  if (!upd.rowCount) return { found: true, paid: false };
  await insertAudit(owner as unknown as Db, null, 'charge.paid_gateway', 'charge', c.id, null, { source, status });
  if (billingEmailEnabled(deps)) {
    const s = await loadSettings(deps);
    if (s.auto_email) await sendNotice(deps, 'pagamento', c.id, s).catch(() => false);
  }
  return { found: true, paid: true };
}

export async function fetchPayment(deps: Deps, gatewayId: string) {
  return call<AsaasPayment>(deps, 'GET', `/payments/${gatewayId}`);
}

/** Confere o token do webhook (o Asaas envia no cabeçalho asaas-access-token). */
export function webhookAuthorized(deps: Deps, header: unknown) {
  const expected = deps.config.ASAAS_WEBHOOK_TOKEN;
  return !!expected && typeof header === 'string' && safeEqual(header, expected);
}
