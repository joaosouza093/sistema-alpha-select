/**
 * Reconcilia armazenamento e banco (disco local ou Supabase Storage):
 *  - remove temporários locais de uploads interrompidos (> 1 h);
 *  - lista (e com --apply remove) arquivos sem registro no banco;
 *  - lista registros cujo arquivo não existe (requer análise manual).
 *
 *   npm run storage:cleanup -w server            (somente relatório)
 *   npm run storage:cleanup -w server -- --apply (remove órfãos)
 */
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { loadDotEnv } from '../src/lib/dotenv.js';
import { loadConfig } from '../src/config.js';
import { createStorage } from '../src/deps.js';
import { sslFromEnv } from '../src/lib/db.js';

loadDotEnv();
const apply = process.argv.includes('--apply');
const config = loadConfig();
const storage = createStorage(config);
await storage.init();

let tmpRemoved = 0;
for (const f of await readdir(storage.tmpDir).catch(() => [] as string[])) {
  const p = path.join(storage.tmpDir, f);
  if (Date.now() - (await stat(p)).mtimeMs > 3600_000) {
    await rm(p, { force: true });
    tmpRemoved++;
  }
}

const client = new pg.Client({ connectionString: config.DATABASE_OWNER_URL, ssl: sslFromEnv() });
await client.connect();
// Considera apenas registros criados há mais de 10 min para não disputar com uploads em andamento.
const { rows } = await client.query<{ id: string; storage_key: string; recent: boolean }>(
  "select id, storage_key, created_at > now() - interval '10 minutes' as recent from documents",
);
await client.end();

const inDb = new Set(rows.map((r) => r.storage_key));
const stored = await storage.listKeys();
const storedSet = new Set(stored);
const orphanFiles = stored.filter((k) => !inDb.has(k));
const missing = rows.filter((r) => !r.recent && !storedSet.has(r.storage_key)).map((r) => r.id);

console.log(`Armazenamento: ${config.STORAGE_DRIVER}`);
console.log(`Temporários removidos: ${tmpRemoved}`);
console.log(`Arquivos sem registro: ${orphanFiles.length}`);
console.log(`Registros sem arquivo: ${missing.length}${missing.length ? ` (ids: ${missing.join(', ')})` : ''}`);
if (apply) {
  for (const k of orphanFiles) await storage.remove(k);
  console.log('Órfãos removidos.');
}
