import type { Deps } from '../../lib/context.js';

/**
 * E-mails automáticos de cobrança. Executado pela tarefa agendada (a cada
 * hora) e logo após criar cobranças. Cada envio fica registrado em
 * charge_notifications; só envios bem-sucedidos contam para não repetir.
 */

export type NoticeKind = 'criada' | 'lembrete' | 'vencimento' | 'atraso' | 'pagamento' | 'manual';

export interface BillingSettings {
  auto_email: boolean;
  pix_key: string | null;
  beneficiary: string | null;
  instructions: string | null;
  reminder_days_before: number;
  overdue_every_days: number;
  overdue_max_reminders: number;
}

interface ChargeRow {
  id: string;
  company_name: string;
  description: string;
  amount_cents: number;
  due_date: string; // YYYY-MM-DD
  billing_email: string;
  payment_link: string | null;
  created_date: string;
  n_criada: number;
  n_lembrete: number;
  n_vencimento: number;
  n_atraso: number;
  last_fail: Date | null;
}

const TZ = 'America/Sao_Paulo';

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export const fmtCents = (c: number) => brl.format(c / 100);
export const fmtDay = (iso: string) => {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
};

const dayNumber = (iso: string) => Math.round(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86_400_000);

/** Qual aviso (se algum) deve sair hoje para esta cobrança pendente. */
export function nextNotice(c: Pick<ChargeRow, 'due_date' | 'created_date' | 'n_criada' | 'n_lembrete' | 'n_vencimento' | 'n_atraso'>, today: string, s: BillingSettings): NoticeKind | null {
  const daysToDue = dayNumber(c.due_date) - dayNumber(today);
  const leadTime = dayNumber(c.due_date) - dayNumber(c.created_date);
  if (daysToDue > 0) {
    if (c.n_criada === 0) return 'criada';
    if (daysToDue <= s.reminder_days_before && c.n_lembrete === 0 && leadTime > s.reminder_days_before) return 'lembrete';
    return null;
  }
  if (daysToDue === 0) {
    if (c.n_vencimento === 0 && c.n_criada === 0) return 'criada';
    if (c.n_vencimento === 0 && leadTime > 0) return 'vencimento';
    return null;
  }
  const overdue = -daysToDue;
  if (c.n_atraso < s.overdue_max_reminders && overdue >= 1 + c.n_atraso * s.overdue_every_days) return 'atraso';
  return null;
}

export function composeNotice(
  kind: NoticeKind,
  c: { company_name: string; description: string; amount_cents: number; due_date: string; payment_link: string | null },
  s: BillingSettings,
  today?: string,
) {
  const valor = fmtCents(c.amount_cents);
  const venc = fmtDay(c.due_date);
  const subject: Record<NoticeKind, string> = {
    criada: `Nova cobrança — ${c.description} — vence em ${venc}`,
    lembrete: `Lembrete: cobrança vence em ${venc}`,
    vencimento: `Sua cobrança vence hoje — ${c.description}`,
    atraso: `Cobrança em atraso — ${c.description}`,
    pagamento: `Pagamento confirmado — ${c.description}`,
    manual: `Cobrança — ${c.description} — vencimento ${venc}`,
  };
  let intro: string;
  switch (kind) {
    case 'criada':
      intro = 'Segue a cobrança referente aos serviços da Alpha Select.';
      break;
    case 'lembrete': {
      const dias = today ? dayNumber(c.due_date) - dayNumber(today) : null;
      intro = dias ? `Lembrete: esta cobrança vence em ${dias} dia${dias > 1 ? 's' : ''}.` : 'Lembrete de cobrança.';
      break;
    }
    case 'vencimento':
      intro = 'Esta cobrança vence hoje.';
      break;
    case 'atraso':
      intro = 'Não identificamos o pagamento da cobrança abaixo, que está vencida.';
      break;
    case 'pagamento':
      intro = 'Confirmamos o recebimento do pagamento abaixo. Obrigado!';
      break;
    default:
      intro = 'Segue a cobrança abaixo.';
  }
  const lines = [`Olá, ${c.company_name}.`, '', intro, '', `Descrição: ${c.description}`, `Valor: ${valor}`, `Vencimento: ${venc}`];
  if (kind !== 'pagamento') {
    if (c.payment_link) lines.push('', `Pagar pelo link: ${c.payment_link}`);
    if (s.pix_key) lines.push('', `Pix: ${s.pix_key}${s.beneficiary ? ` (favorecido: ${s.beneficiary})` : ''}`);
    if (s.instructions) lines.push('', s.instructions);
    lines.push('', 'Se o pagamento já foi feito, desconsidere esta mensagem.');
  }
  lines.push('', 'Alpha Select Consultoria de Recursos Humanos');
  return { subject: `${subject[kind]} — Alpha Select`, text: lines.join('\n') };
}

export async function loadSettings(deps: Deps): Promise<BillingSettings> {
  const { rows } = await deps.pools.owner.query<BillingSettings>(
    `select auto_email, pix_key, beneficiary, instructions, reminder_days_before, overdue_every_days, overdue_max_reminders
       from billing_settings limit 1`,
  );
  return rows[0]!;
}

export const billingEmailEnabled = (deps: Deps) => deps.config.mailMode !== 'manual';

/** Envia um aviso e registra o resultado (sem guardar o conteúdo do e-mail). */
export async function sendNotice(
  deps: Deps,
  kind: NoticeKind,
  chargeId: string,
  settings?: BillingSettings,
  today?: string,
): Promise<boolean> {
  const s = settings ?? (await loadSettings(deps));
  const { rows } = await deps.pools.owner.query<{
    company_name: string; description: string; amount_cents: number; due_date: string; payment_link: string | null; billing_email: string;
  }>(
    `select co.name as company_name, c.description, c.amount_cents, to_char(c.due_date, 'YYYY-MM-DD') as due_date,
            c.payment_link, c.billing_email::text as billing_email
       from charges c join companies co on co.id = c.company_id where c.id = $1`,
    [chargeId],
  );
  const c = rows[0];
  if (!c) return false;
  const msg = composeNotice(kind, c, s, today);
  let ok = true;
  let error: string | null = null;
  try {
    await deps.mailer.send({ to: c.billing_email, ...msg });
  } catch (e) {
    ok = false;
    const code = (e as { code?: string; responseCode?: number }).code ?? (e as { responseCode?: number }).responseCode;
    error = `falha no envio${code ? ` (${String(code).slice(0, 40)})` : ''}`;
  }
  await deps.pools.owner.query(
    'insert into charge_notifications (charge_id, kind, sent_to, ok, error) values ($1, $2, $3, $4, $5)',
    [chargeId, kind, c.billing_email, ok, error],
  );
  return ok;
}

/** Gera as próximas parcelas das cobranças mensais cujo vencimento chegou. */
export async function generateRecurring(deps: Deps, today: string) {
  for (let i = 0; i < 24; i++) {
    const r = await deps.pools.owner.query(
      `with src as (
         select * from charges
          where recurrence = 'mensal' and not next_generated and status <> 'cancelado' and due_date <= $1::date
          for update skip locked
          limit 200
       ), ins as (
         insert into charges (company_id, description, amount_cents, due_date, billing_email, payment_link,
                              recurrence, series_id, series_start, series_index, created_by, gateway_dirty)
         select s.company_id, s.description, s.amount_cents,
                (s.series_start + make_interval(months => s.series_index + 1))::date,
                coalesce(co.billing_email, s.billing_email),
                -- o link do Asaas é de cada parcela: a nova recebe o seu ao ser criada lá
                case when s.gateway_id is null then s.payment_link end,
                'mensal', s.series_id, s.series_start, s.series_index + 1, s.created_by, s.gateway_id is not null
           from src s join companies co on co.id = s.company_id
          where co.is_active
         on conflict (series_id, series_index) do nothing
         returning id
       )
       update charges set next_generated = true where id in (select id from src)`,
      [today],
    );
    if (!r.rowCount) break;
  }
}

export async function todaySP(deps: Deps): Promise<string> {
  const { rows } = await deps.pools.owner.query<{ d: string }>(
    `select to_char((now() at time zone '${TZ}')::date, 'YYYY-MM-DD') as d`,
  );
  return rows[0]!.d;
}

/**
 * Processa os avisos pendentes. `chargeIds` limita às cobranças informadas
 * (envio imediato após criar). Respeita um orçamento de tempo para caber no
 * limite das funções serverless; o restante sai na próxima execução.
 */
export async function runBillingNotifications(
  deps: Deps,
  opts: { chargeIds?: string[]; budgetMs?: number } = {},
): Promise<{ sent: number; failed: number; pending: number }> {
  const started = Date.now();
  const budget = opts.budgetMs ?? 20_000;
  const today = await todaySP(deps);
  if (!opts.chargeIds) await generateRecurring(deps, today);
  const result = { sent: 0, failed: 0, pending: 0 };
  if (!billingEmailEnabled(deps)) return result;
  const s = await loadSettings(deps);
  if (!s.auto_email) return result;
  // Com o Asaas ligado, a cobrança nova espera o link de pagamento (até 3 tentativas de criação).
  const waitGateway = (await deps.pools.owner.query<{ on: boolean }>('select gateway_enabled as on from billing_settings limit 1')).rows[0]?.on === true
    && !!deps.config.ASAAS_API_KEY;

  const { rows } = await deps.pools.owner.query<ChargeRow>(
    `select c.id, co.name as company_name, c.description, c.amount_cents,
            to_char(c.due_date, 'YYYY-MM-DD') as due_date, c.billing_email::text as billing_email, c.payment_link,
            to_char((c.created_at at time zone '${TZ}')::date, 'YYYY-MM-DD') as created_date,
            count(*) filter (where n.ok and n.kind = 'criada')::int as n_criada,
            count(*) filter (where n.ok and n.kind = 'lembrete')::int as n_lembrete,
            count(*) filter (where n.ok and n.kind = 'vencimento')::int as n_vencimento,
            count(*) filter (where n.ok and n.kind = 'atraso')::int as n_atraso,
            max(n.sent_at) filter (where not n.ok) as last_fail
       from charges c
       join companies co on co.id = c.company_id
       left join charge_notifications n on n.charge_id = c.id
      where c.status = 'pendente' and not c.reminders_paused and co.is_active
        and ($1::uuid[] is null or c.id = any($1))
        and not ($2::boolean and c.gateway_dirty and c.gateway_id is null and c.gateway_attempts < 3)
      group by c.id, co.name
      order by c.due_date
      limit 500`,
    [opts.chargeIds ?? null, waitGateway],
  );
  for (const c of rows) {
    const kind = nextNotice(c, today, s);
    if (!kind) continue;
    // Após falha, espera ~1 hora antes de tentar de novo.
    if (c.last_fail && Date.now() - c.last_fail.getTime() < 50 * 60_000) continue;
    if (Date.now() - started > budget) {
      result.pending++;
      continue;
    }
    if (await sendNotice(deps, kind, c.id, s, today)) result.sent++;
    else result.failed++;
  }
  return result;
}
