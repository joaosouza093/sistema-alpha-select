import { z } from 'zod';
import { cleanText } from '../../lib/normalize.js';

/**
 * Campos do perfil do candidato além de nome, e-mail, telefone e pretensão:
 * nascimento, endereço, área de interesse, LinkedIn e formação. Usados no
 * portal (obrigatórios os marcados pela Alpha Select), no cadastro interno,
 * em Meus dados e na importação (opcionais).
 */
export const UFS = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI',
  'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'] as const;
export const EDUCATION_LEVELS = ['fundamental_incompleto', 'fundamental', 'medio_incompleto', 'medio', 'tecnico',
  'superior_incompleto', 'superior', 'pos_graduacao', 'mestrado', 'doutorado'] as const;
export const EDUCATION_STATUS = ['concluido', 'cursando', 'trancado', 'incompleto'] as const;

const opt = (max: number) =>
  z
    .string()
    .nullish()
    .transform((v) => (v == null ? null : cleanText(v) || null))
    .pipe(z.string().max(max, `Máximo de ${max} caracteres.`).nullable());

const today = () => new Date().toISOString().slice(0, 10);
const zBirth = z
  .string()
  .nullish()
  .transform((v) => (v ? v.trim() || null : null))
  .pipe(
    z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida.')
      .refine((v) => !Number.isNaN(Date.parse(v)) && v >= '1900-01-01' && v <= today(), 'Data de nascimento inválida.')
      .nullable(),
  );
const zState = z
  .string()
  .nullish()
  .transform((v) => (v ? v.trim().toUpperCase() || null : null))
  .pipe(z.enum(UFS, { message: 'UF inválida.' }).nullable());
const zCep = z
  .string()
  .nullish()
  .transform((v) => (v ? v.replace(/\D/g, '') || null : null))
  .pipe(z.string().regex(/^\d{8}$/, 'CEP inválido.').nullable());
const zLinkedin = z
  .string()
  .nullish()
  .transform((v) => {
    const s = v ? v.trim() : '';
    if (!s) return null;
    return /^https?:\/\//i.test(s) ? s.replace(/^http:/i, 'https:') : `https://${s.replace(/^\/+/, '')}`;
  })
  .pipe(
    z
      .string()
      .max(300)
      .regex(/^https:\/\/([a-z]{2,3}\.)?linkedin\.com\//i, 'Informe o endereço do LinkedIn (linkedin.com/in/...).')
      .nullable(),
  );

/** Todos opcionais (cadastro interno, Meus dados, importação). */
export const zProfile = z.object({
  birthDate: zBirth,
  addressStreet: opt(160),
  addressNumber: opt(20),
  addressComplement: opt(80),
  addressDistrict: opt(80),
  city: opt(120),
  state: zState,
  postalCode: zCep,
  desiredRole: opt(120),
  linkedinUrl: zLinkedin,
  educationLevel: z.enum(EDUCATION_LEVELS, { message: 'Escolaridade inválida.' }).nullish().transform((v) => v ?? null),
  course: opt(120),
  institution: opt(160),
  educationStatus: z.enum(EDUCATION_STATUS, { message: 'Situação inválida.' }).nullish().transform((v) => v ?? null),
});
export type Profile = z.infer<typeof zProfile>;

/** Campos que o formulário público exige (pedido da Alpha Select). */
export const PORTAL_REQUIRED: (keyof Profile)[] = ['birthDate', 'city', 'state', 'postalCode', 'desiredRole', 'educationLevel'];

export const requireFields = <T extends Record<string, unknown>>(schema: z.ZodType<T>, fields: string[]) =>
  schema.superRefine((v, ctx) => {
    for (const f of fields) if (v[f] == null || v[f] === '') ctx.addIssue({ code: 'custom', path: [f], message: 'Campo obrigatório.' });
  });

/** Coluna do banco de cada campo. */
export const PROFILE_COLUMNS: Record<keyof Profile, string> = {
  birthDate: 'birth_date',
  addressStreet: 'address_street',
  addressNumber: 'address_number',
  addressComplement: 'address_complement',
  addressDistrict: 'address_district',
  city: 'city',
  state: 'state',
  postalCode: 'postal_code',
  desiredRole: 'desired_role',
  linkedinUrl: 'linkedin_url',
  educationLevel: 'education_level',
  course: 'course',
  institution: 'institution',
  educationStatus: 'education_status',
};
export const PROFILE_KEYS = Object.keys(PROFILE_COLUMNS) as (keyof Profile)[];

/** Para SELECT: `c.birth_date as "birthDate", …` (data como AAAA-MM-DD). */
export const profileSelect = (alias = 'c') =>
  PROFILE_KEYS.map((k) =>
    k === 'birthDate' ? `to_char(${alias}.birth_date, 'YYYY-MM-DD') as "birthDate"` : `${alias}.${PROFILE_COLUMNS[k]} as "${k}"`,
  ).join(', ');

/** Etiquetas: minúsculas, sem espaços nas pontas, sem repetição, até 20 de até 40 caracteres. */
export const zTags = z
  .array(z.string())
  .max(20, 'Máximo de 20 etiquetas.')
  .transform((a) => [...new Set(a.map((t) => cleanText(t).toLowerCase()).filter(Boolean))])
  .pipe(z.array(z.string().max(40, 'Etiqueta muito longa.')));
