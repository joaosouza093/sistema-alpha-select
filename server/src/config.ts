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
  /** Conexões por instância. Em funções serverless use 1–2 com o pooler do Supabase. */
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(15),
  /** Certificado da autoridade do banco (PEM). No Supabase: Database → SSL Configuration. */
  DATABASE_SSL_CA: z.string().optional(),
  /** disk = disco local/volume; supabase = Supabase Storage (bucket privado). */
  STORAGE_DRIVER: z.enum(['disk', 'supabase']).default('disk'),
  /** Diretório de arquivos (disk) ou apenas de temporários (supabase). */
  STORAGE_DIR: z.string().min(1),
  SUPABASE_URL: z.string().url().optional(),
  /** Chave service_role: SOMENTE no servidor. Nunca no frontend. */
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  /** Região do projeto Supabase (ex.: sa-east-1), usada para descobrir o pooler automaticamente. */
  SUPABASE_REGION: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/).optional(),
  SUPABASE_BUCKET: z.string().regex(/^[a-z0-9-]{3,63}$/).default('documentos-candidatos'),
  /** smtp = envia e-mails; manual = o administrador copia o link e envia por canal seguro. */
  MAIL_MODE: z.enum(['smtp', 'manual']).optional(),
  /** limites de tentativas: memory (uma instância) ou postgres (serverless / várias instâncias). */
  RATE_LIMIT_STORE: z.enum(['memory', 'postgres']).default('memory'),
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
  mailMode: 'smtp' | 'manual' | 'dev';
};

/** Erro de configuração: lista apenas NOMES de variáveis (nunca valores). */
export class ConfigError extends Error {
  constructor(
    readonly fields: string[],
    message: string,
  ) {
    super(message);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Variáveis definidas mas vazias (ex.: "MAIL_MODE=" no .env) contam como não definidas.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ''));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))];
    throw new ConfigError(fields, `Configuração inválida ou ausente: ${fields.join(', ')}`);
  }
  const c = parsed.data;
  const isProd = c.APP_ENV === 'production' || c.APP_ENV === 'staging';
  const mailMode = c.MAIL_MODE ?? (c.SMTP_URL ? 'smtp' : isProd ? undefined : 'dev');
  if (!mailMode) {
    throw new ConfigError(['MAIL_MODE'], 'Em homologação/produção defina SMTP_URL ou MAIL_MODE=manual (links entregues pelo administrador).');
  }
  if (mailMode === 'smtp' && !c.SMTP_URL) throw new ConfigError(['SMTP_URL'], 'MAIL_MODE=smtp exige SMTP_URL.');
  if (isProd && !c.APP_URL.startsWith('https://')) throw new ConfigError(['APP_URL'], 'APP_URL deve usar https em homologação/produção.');
  if (c.STORAGE_DRIVER === 'supabase' && (!c.SUPABASE_URL || !c.SUPABASE_SERVICE_ROLE_KEY)) {
    throw new ConfigError(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'], 'STORAGE_DRIVER=supabase exige SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.');
  }
  return {
    ...c,
    isProd,
    secureCookies: c.APP_URL.startsWith('https://'),
    corsOrigins: c.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    maxUploadBytes: Math.floor(c.MAX_UPLOAD_MB * 1024 * 1024),
    mailMode,
  };
}
