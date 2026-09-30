/**
 * Reconcilia armazenamento e banco:
 *  - remove arquivos temporários de uploads interrompidos (> 1 h);
 *  - lista (e com --apply remove) arquivos físicos sem registro no banco;
 *  - lista registros cujo arquivo físico não existe (requer análise manual).
 *
 *   npm run storage:cleanup            (somente relatório)
 *   npm run storage:cleanup -- --apply (remove órfãos físicos)
 */
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { loadDotEnv } from '../src/lib/dotenv.js';

loadDotEnv();
const apply = process.argv.includes('--apply');
const root = process.env.STORAGE_DIR;
const url = process.env.DATABASE_OWNER_URL;
if (!root || !url) {
  console.error('Defina STORAGE_DIR e DATABASE_OWNER_URL.');
  process.exit(1);
}

const tmpDir = path.join(root, 'tmp');
const filesDir = path.join(root, 'files');
let tmpRemoved = 0;
for (const f of await readdir(tmpDir).catch(() => [] as string[])) {
  const p = path.join(tmpDir, f);
  const s = await stat(p);
  if (Date.now() - s.mtimeMs > 3600_000) {
    await rm(p, { force: true });
    tmpRemoved++;
  }
}

const onDisk = new Set<string>();
for (const d of await readdir(filesDir).catch(() => [] as string[])) {
  for (const f of await readdir(path.join(filesDir, d)).catch(() => [] as string[])) onDisk.add(`${d}/${f}`);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
const { rows } = await client.query<{ id: string; storage_key: string }>('select id, storage_key from documents');
await client.end();
const inDb = new Set(rows.map((r) => r.storage_key));

const orphanFiles = [...onDisk].filter((k) => !inDb.has(k));
const missing = rows.filter((r) => !onDisk.has(r.storage_key)).map((r) => r.id);

console.log(`Temporários removidos: ${tmpRemoved}`);
console.log(`Arquivos sem registro: ${orphanFiles.length}`);
console.log(`Registros sem arquivo: ${missing.length}${missing.length ? ` (ids: ${missing.join(', ')})` : ''}`);
if (apply) {
  for (const k of orphanFiles) {
    // Evita remover arquivo de upload em andamento (gravado há menos de 10 min).
    const p = path.join(filesDir, k);
    const s = await stat(p);
    if (Date.now() - s.mtimeMs > 600_000) await rm(p, { force: true });
  }
  console.log('Órfãos físicos removidos.');
}
