/**
 * Dados FICTÍCIOS apenas para desenvolvimento local.
 * Recusa execução fora de APP_ENV=development. Senhas são geradas
 * aleatoriamente a cada execução e exibidas somente neste terminal.
 *
 *   npm run db:seed-dev
 */
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { sslFromEnv } from '../src/lib/db.js';
import { loadDotEnv } from '../src/lib/dotenv.js';
import { hashPassword } from '../src/lib/crypto.js';

loadDotEnv();
if (process.env.APP_ENV !== 'development') {
  console.error('Seed permitido somente com APP_ENV=development.');
  process.exit(1);
}
const url = process.env.DATABASE_OWNER_URL!;
const storageDir = process.env.STORAGE_DIR!;
const client = new pg.Client({ connectionString: url, ssl: sslFromEnv() });
await client.connect();

const existing = await client.query('select count(*)::int as n from users');
if (existing.rows[0].n > 0 && !process.argv.includes('--force')) {
  console.error('O banco já possui usuários. Use --force para adicionar dados fictícios mesmo assim.');
  await client.end();
  process.exit(1);
}

const suffix = randomBytes(2).toString('hex');
const creds: { perfil: string; email: string; senha: string }[] = [];

async function user(kind: string, name: string, email: string, companyId: string | null) {
  const pw = randomBytes(9).toString('base64url');
  const { rows } = await client.query<{ id: string }>(
    'insert into users (email, full_name, kind, company_id) values ($1, $2, $3, $4) returning id',
    [email, name, kind, companyId],
  );
  await client.query('insert into user_credentials (user_id, password_hash) values ($1, $2)', [rows[0]!.id, await hashPassword(pw)]);
  creds.push({ perfil: kind, email, senha: pw });
  return rows[0]!.id;
}

await client.query('begin');
const company = async (name: string) =>
  (await client.query<{ id: string }>('insert into companies (name) values ($1) returning id', [name])).rows[0]!.id;
const alfa = await company(`Empresa Demo Alfa ${suffix}`);
const beta = await company(`Empresa Demo Beta ${suffix}`);

const admin = await user('alpha_admin', 'Admin Demonstração', `admin.${suffix}@exemplo.invalid`, null);
const staff = await user('alpha_staff', 'Recrutadora Demonstração', `equipe.${suffix}@exemplo.invalid`, null);
const rhAlfa = await user('client_user', 'RH Interno Alfa', `rh.alfa.${suffix}@exemplo.invalid`, alfa);
const ceoAlfa = await user('client_manager', 'Gestor Alfa', `gestor.alfa.${suffix}@exemplo.invalid`, alfa);
const rhBeta = await user('client_user', 'RH Interno Beta', `rh.beta.${suffix}@exemplo.invalid`, beta);

const proc = async (companyId: string, title: string) =>
  (
    await client.query<{ id: string }>(
      'insert into processes (company_id, title, description, created_by) values ($1, $2, $3, $4) returning id',
      [companyId, title, 'Processo fictício para demonstração.', admin],
    )
  ).rows[0]!.id;
const p1 = await proc(alfa, 'Analista Administrativo (demo)');
const p2 = await proc(beta, 'Assistente Comercial (demo)');

const member = (p: string, u: string, move: boolean, decide: boolean) =>
  client.query('insert into process_members (process_id, user_id, can_move_stage, can_decide, can_comment) values ($1, $2, $3, $4, true)', [p, u, move, decide]);
await member(p1, staff, true, false);
await member(p2, staff, true, false);
await member(p1, rhAlfa, true, false);
await member(p1, ceoAlfa, true, true);
await member(p2, rhBeta, true, true);

const names = ['Pessoa Fictícia Um', 'Pessoa Fictícia Dois', 'Pessoa Fictícia Três', 'Pessoa Fictícia Quatro', 'Pessoa Fictícia Cinco'];
const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
for (const [i, name] of names.entries()) {
  const { rows } = await client.query<{ id: string }>(
    `insert into candidates (full_name, email, phone, salary_expectation, notes, created_by)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [name, `candidato${i + 1}.${suffix}@exemplo.invalid`, `+5511900000${String(i).padStart(3, '0')}`, 3000 + i * 750, 'Observação interna fictícia.', staff],
  );
  const cand = rows[0]!.id;
  const a = await client.query<{ id: string }>(
    // Participações fora da 1ª etapa já foram enviadas ao cliente.
    `insert into applications (candidate_id, process_id, stage_id, owner_id, share_email, sent_at)
     values ($1, $2, $3, $4, $5, case when $3::smallint > 1 then now() end) returning id`,
    [cand, i < 4 ? p1 : p2, (i % 4) + 1, i % 2 ? rhAlfa : staff, i === 0],
  );
  if (i >= 4) await client.query('update applications set owner_id = $2 where id = $1', [a.rows[0]!.id, rhBeta]);
  if (i === 0) {
    // Mesmo candidato em dois processos de empresas diferentes.
    await client.query('insert into applications (candidate_id, process_id, owner_id) values ($1, $2, $3)', [cand, p2, staff]);
  }
  const fileId = randomUUID();
  const k = `${fileId.slice(0, 2)}/${fileId}`;
  await mkdir(path.join(storageDir, 'files', fileId.slice(0, 2)), { recursive: true, mode: 0o700 });
  await writeFile(path.join(storageDir, 'files', k), pdf, { mode: 0o600 });
  const d = await client.query<{ id: string }>(
    `insert into documents (candidate_id, kind, storage_key, original_name, mime_type, size_bytes, sha256, uploaded_by)
     values ($1, 'curriculo', $2, $3, 'application/pdf', $4, $5, $6) returning id`,
    [cand, k, `curriculo-demo-${i + 1}.pdf`, pdf.length, createHash('sha256').update(pdf).digest('hex'), staff],
  );
  await client.query(
    'insert into application_documents (application_id, document_id, candidate_id, shared_with_client) values ($1, $2, $3, $4)',
    [a.rows[0]!.id, d.rows[0]!.id, cand, i % 2 === 0],
  );
  await client.query("insert into comments (application_id, author_id, visibility, body) values ($1, $2, 'internal', 'Comentário interno fictício.')", [a.rows[0]!.id, staff]);
  await client.query("insert into comments (application_id, author_id, visibility, body) values ($1, $2, 'shared', 'Comentário compartilhado fictício.')", [a.rows[0]!.id, staff]);
}
await client.query('commit');
await client.end();

const jsonIdx = process.argv.indexOf('--json');
if (jsonIdx > 0 && process.argv[jsonIdx + 1]) {
  // Usado pelos testes E2E locais (arquivo ignorado pelo git).
  const out = process.argv[jsonIdx + 1]!;
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify({ suffix, creds }, null, 2), { mode: 0o600 });
  console.log(`Credenciais fictícias gravadas em ${out}`);
} else {
  console.log('\nDados fictícios criados. Credenciais de DESENVOLVIMENTO (não reutilize):\n');
  console.table(creds);
}
