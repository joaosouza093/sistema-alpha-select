import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  APP_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('127.0.0.1'),
  /** URL pública da aplicação (usada em links de convite e recuperação de senha). */
  APP_URL: z.string().url(),
  /** Conexão com o papel "alpha_app" (sem BYPASSRLS). Usada em todas as operações de usuário. */
  DATABASE_URL: z.string().min(1),
  /** Conexão com o papel proprietário. Usada apenas em autenticação, migrações e scripts. */
  DATABASE_OWNER_URL: z.string().min(1),
  DATABASE_SSL: bool.default(false),
  STORAGE_DIR: z.string().min(1),
  MAX_UPLOAD_MB: z.coerce.number().positive().max(50).default(10),
  /** Origens adicionais permitidas (CORS). Vazio = somente a mesma origem. */
  CORS_ORIGINS: z.string().default(''),
  TRUST_PROXY: bool.default(false),
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default('Alpha Select <nao-responda@localhost>'),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().positive().default(12),
  SESSION_IDLE_MINUTES: z.coerce.number().positive().default(120),
  /** Diretório do build do frontend servido pelo backend em homologação/produção. */
  WEB_DIST_DIR: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'silent']).default('info'),
});

export type Config = z.infer<typeof schema> & {
  isProd: boolean;
  secureCookies: boolean;
  corsOrigins: string[];
  maxUploadBytes: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Configuração inválida ou ausente: ${fields}`);
  }
  const c = parsed.data;
  const isProd = c.APP_ENV === 'production' || c.APP_ENV === 'staging';
  if (isProd) {
    if (!c.SMTP_URL) throw new Error('SMTP_URL é obrigatório em homologação/produção.');
    if (!c.APP_URL.startsWith('https://')) throw new Error('APP_URL deve usar https em homologação/produção.');
  }
  return {
    ...c,
    isProd,
    secureCookies: c.APP_URL.startsWith('https://'),
    corsOrigins: c.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    maxUploadBytes: Math.floor(c.MAX_UPLOAD_MB * 1024 * 1024),
  };
}
