import type { Decision, ProcessStatus, UserKind } from '../api/types';

const dateTime = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const dateOnly = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' });
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

export const fmtDateTime = (v: string | null | undefined) => (v ? dateTime.format(new Date(v)) : '—');
export const fmtDate = (v: string | null | undefined) => (v ? dateOnly.format(new Date(v)) : '—');
export const fmtMoney = (v: number | null | undefined) => (v === null || v === undefined ? '—' : brl.format(v));

export function fmtPhone(v: string | null | undefined) {
  if (!v) return '—';
  const m = v.match(/^\+55(\d{2})(\d{4,5})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : v;
}

export function fmtSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function daysSince(v: string) {
  const d = Math.floor((Date.now() - new Date(v).getTime()) / 86_400_000);
  return d <= 0 ? 'hoje' : d === 1 ? 'há 1 dia' : `há ${d} dias`;
}

export const kindLabel: Record<UserKind, string> = {
  alpha_admin: 'Administrador Alpha Select',
  alpha_staff: 'Equipe Alpha Select / RH Externo',
  client_user: 'Cliente / RH Interno',
  client_manager: 'Gestor / CEO',
};

export const statusLabel: Record<ProcessStatus, string> = {
  em_andamento: 'Em andamento',
  concluido: 'Concluído',
  arquivado: 'Arquivado',
};

export const decisionLabel: Record<Decision, string> = {
  pendente: 'Em avaliação',
  aprovado: 'Aprovado',
  reprovado: 'Não aprovado',
  desistiu: 'Desistiu',
};

export const docKindLabel = { curriculo: 'Currículo', documento: 'Documento', outro: 'Outro' } as const;

export const isAlphaKind = (k: UserKind | undefined) => k === 'alpha_admin' || k === 'alpha_staff';

export const fmtCents = (c: number | null | undefined) => (c === null || c === undefined ? '—' : brl.format(c / 100));

/** "1.500,00", "1500.5", "R$ 99" → centavos; null se inválido. */
export function parseMoneyToCents(v: string): number | null {
  let s = v.replace(/[R$\s]/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

/** Data "AAAA-MM-DD" (sem fuso) → "dd/mm/aaaa". */
export const fmtDay = (iso: string | null | undefined) => (iso ? iso.split('-').reverse().join('/') : '—');

export function fmtCnpj(v: string | null | undefined) {
  if (!v || v.length !== 14) return v || '—';
  return `${v.slice(0, 2)}.${v.slice(2, 5)}.${v.slice(5, 8)}/${v.slice(8, 12)}-${v.slice(12)}`;
}

export const situacaoLabel = { pendente: 'A vencer', vencida: 'Vencida', pago: 'Paga', cancelado: 'Cancelada' } as const;
export const noticeLabel = {
  criada: 'Cobrança enviada',
  lembrete: 'Lembrete',
  vencimento: 'Aviso de vencimento',
  atraso: 'Aviso de atraso',
  pagamento: 'Recibo de pagamento',
  manual: 'Reenvio manual',
} as const;

export const workModelLabel = { presencial: 'Presencial', hibrido: 'Híbrido', remoto: 'Remoto' } as const;
export const employmentTypeLabel = { clt: 'CLT', pj: 'PJ', estagio: 'Estágio', temporario: 'Temporário', outro: 'Outro' } as const;
export const publicationLabel = { rascunho: 'Não publicada', publicada: 'Publicada', pausada: 'Pausada', encerrada: 'Encerrada' } as const;

export function fmtSalaryRange(min: number | null | undefined, max: number | null | undefined) {
  if (min == null && max == null) return null;
  if (min != null && max != null) return min === max ? fmtCents(min) : `${fmtCents(min)} a ${fmtCents(max)}`;
  return min != null ? `a partir de ${fmtCents(min)}` : `até ${fmtCents(max!)}`;
}

export const reasonLabel = {
  perfil_tecnico: 'Perfil técnico não atende',
  experiencia: 'Experiência insuficiente',
  pretensao_salarial: 'Pretensão salarial',
  localizacao: 'Localização',
  disponibilidade: 'Disponibilidade',
  comportamental: 'Perfil comportamental',
  sem_retorno: 'Candidato sem retorno',
  vaga_cancelada: 'Vaga cancelada/congelada',
  desistencia_candidato: 'Desistência do candidato',
  outro: 'Outro',
} as const;

export const triageLabel = { em_triagem: 'Em triagem', aprovado_interno: 'Aprovado na triagem', reprovado_interno: 'Reprovado na triagem' } as const;

export const fmtScore = (s: number | null | undefined) => (s == null ? null : s.toFixed(1).replace('.', ','));
