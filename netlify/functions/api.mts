// API da Alpha Select em Netlify Functions: mesmo servidor Fastify, mesmo domínio do site.
import { handleWebRequest } from '../../server/src/serverless.ts';

// Região do projeto Supabase de homologação (não é segredo). Permite descobrir
// o endereço do pooler automaticamente se o configurado não funcionar.
process.env.SUPABASE_REGION ??= 'sa-east-1';

interface NetlifyContext {
  ip: string;
}

export default async (request: Request, context: NetlifyContext) => handleWebRequest(request, context.ip);

export const config = { path: '/api/*' };
