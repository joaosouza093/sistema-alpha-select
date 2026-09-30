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
