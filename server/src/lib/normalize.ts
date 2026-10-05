import { z } from 'zod';

/** Remove espaços extras e caracteres de controle. */
export function cleanText(v: string): string {
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
}

export function normalizeEmail(v: string): string {
  return cleanText(v).toLowerCase();
}

/**
 * Normaliza telefone para dígitos com "+" opcional. Números brasileiros com
 * 10 ou 11 dígitos recebem o prefixo +55.
 */
export function normalizePhone(v: string): string | null {
  const raw = cleanText(v);
  if (!raw) return null;
  const plus = raw.startsWith('+');
  let digits = raw.replace(/\D/g, '');
  if (!plus && digits.startsWith('0')) digits = digits.replace(/^0+/, '');
  if (!plus && (digits.length === 10 || digits.length === 11)) return `+55${digits}`;
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}

export const zText = (min: number, max: number) =>
  z.string().transform(cleanText).pipe(z.string().min(min, 'Campo obrigatório.').max(max, `Máximo de ${max} caracteres.`));

export const zOptionalText = (max: number) =>
  z
    .string()
    .nullish()
    .transform((v) => (v == null ? null : cleanText(v) || null))
    .pipe(z.string().max(max, `Máximo de ${max} caracteres.`).nullable());

export const zEmail = z
  .string()
  .transform(normalizeEmail)
  .pipe(z.string().max(254).regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, 'E-mail inválido.'));

export const zOptionalEmail = z
  .string()
  .nullish()
  .transform((v) => (v == null ? null : normalizeEmail(v) || null))
  .pipe(z.string().max(254).regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, 'E-mail inválido.').nullable());

export const zOptionalPhone = z
  .string()
  .nullish()
  .transform((v, ctx) => {
    if (v == null || !cleanText(v)) return null;
    const p = normalizePhone(v);
    if (!p) {
      ctx.addIssue({ code: 'custom', message: 'Telefone inválido.' });
      return z.NEVER;
    }
    return p;
  });

export const zUuid = z.string().uuid('Identificador inválido.');

export const zPassword = z
  .string()
  .min(10, 'A senha deve ter ao menos 10 caracteres.')
  .max(128, 'A senha deve ter no máximo 128 caracteres.');

export const zPage = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(5).max(100).default(20),
});

/** Padrão seguro para ILIKE: escapa curingas digitados pelo usuário. */
export function likePattern(q: string): string {
  return `%${cleanText(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
