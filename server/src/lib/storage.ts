import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type pg from 'pg';

/**
 * Armazenamento privado de documentos. Os arquivos nunca ficam em local
 * público: só são entregues pelo servidor após autorização.
 * Chave interna aleatória, sem dados pessoais: "ab/<uuid>".
 */
export interface FileStorage {
  init(): Promise<void>;
  newKey(): string;
  /** Caminho local temporário para receber o upload antes da validação. */
  tmpPath(): string;
  readonly tmpDir: string;
  /** Move/envia o arquivo temporário validado para o armazenamento definitivo. */
  commitTmp(tmp: string, key: string): Promise<void>;
  remove(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** Conteúdo do arquivo, ou null se não existir. */
  read(key: string): Promise<Readable | null>;
  /** Todas as chaves armazenadas (rotina de reconciliação de órfãos). */
  listKeys(): Promise<string[]>;
}

const KEY_RE = /^[0-9a-f]{2}\/[0-9a-f-]{36}$/;

function assertKey(key: string) {
  if (!KEY_RE.test(key)) throw new Error('Chave de armazenamento inválida.');
}

function newKey() {
  const id = randomUUID();
  return `${id.slice(0, 2)}/${id}`;
}

// ---------------------------------------------------------------------------
// Disco local (desenvolvimento, servidor próprio ou contêiner com volume)
// ---------------------------------------------------------------------------

export class DiskStorage implements FileStorage {
  constructor(private readonly root: string) {}

  async init() {
    await mkdir(this.tmpDir, { recursive: true, mode: 0o700 });
  }

  newKey = newKey;

  tmpPath() {
    return path.join(this.tmpDir, `${randomUUID()}.part`);
  }

  get tmpDir() {
    return path.join(this.root, 'tmp');
  }

  private get filesDir() {
    return path.join(this.root, 'files');
  }

  private resolve(key: string) {
    assertKey(key);
    return path.join(this.filesDir, key);
  }

  async commitTmp(tmp: string, key: string) {
    const dest = this.resolve(key);
    await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
    await rename(tmp, dest);
  }

  async remove(key: string) {
    await rm(this.resolve(key), { force: true });
  }

  async exists(key: string) {
    try {
      await stat(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  async read(key: string) {
    return (await this.exists(key)) ? createReadStream(this.resolve(key)) : null;
  }

  async listKeys() {
    const keys: string[] = [];
    for (const d of await readdir(this.filesDir).catch(() => [] as string[])) {
      for (const f of await readdir(path.join(this.filesDir, d)).catch(() => [] as string[])) keys.push(`${d}/${f}`);
    }
    return keys;
  }
}

// ---------------------------------------------------------------------------
// Supabase Storage (bucket PRIVADO). A chave de serviço é usada apenas no
// servidor; o navegador nunca recebe URL do Storage nem link assinado.
// ---------------------------------------------------------------------------

export class SupabaseStorage implements FileStorage {
  private readonly base: string;

  constructor(
    url: string,
    private readonly serviceKey: string,
    private readonly bucket: string,
    private readonly localTmp: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = `${url.replace(/\/+$/, '')}/storage/v1`;
  }

  private headers(extra: Record<string, string> = {}) {
    return { Authorization: `Bearer ${this.serviceKey}`, apikey: this.serviceKey, ...extra };
  }

  async init() {
    await mkdir(this.localTmp, { recursive: true, mode: 0o700 });
  }

  newKey = newKey;

  tmpPath() {
    return path.join(this.localTmp, `${randomUUID()}.part`);
  }

  get tmpDir() {
    return this.localTmp;
  }

  private objectUrl(key: string) {
    assertKey(key);
    return `${this.base}/object/${encodeURIComponent(this.bucket)}/${key}`;
  }

  async commitTmp(tmp: string, key: string) {
    const body = await readFile(tmp);
    const res = await this.fetchImpl(this.objectUrl(key), {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/octet-stream', 'x-upsert': 'false' }),
      body,
    });
    if (!res.ok) throw new Error(`Falha ao gravar no armazenamento (HTTP ${res.status}).`);
    await rm(tmp, { force: true });
  }

  async remove(key: string) {
    assertKey(key);
    const res = await this.fetchImpl(`${this.base}/object/${encodeURIComponent(this.bucket)}`, {
      method: 'DELETE',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ prefixes: [key] }),
    });
    if (!res.ok) throw new Error(`Falha ao remover do armazenamento (HTTP ${res.status}).`);
  }

  async read(key: string) {
    assertKey(key);
    const res = await this.fetchImpl(`${this.base}/object/authenticated/${encodeURIComponent(this.bucket)}/${key}`, {
      headers: this.headers(),
    });
    if (res.status === 400 || res.status === 404) return null;
    if (!res.ok || !res.body) throw new Error(`Falha ao ler do armazenamento (HTTP ${res.status}).`);
    return Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
  }

  async exists(key: string) {
    const stream = await this.read(key);
    if (!stream) return false;
    stream.destroy();
    return true;
  }

  async listKeys() {
    const keys: string[] = [];
    const list = async (prefix: string) => {
      const out: { name: string; id: string | null }[] = [];
      for (let offset = 0; ; offset += 1000) {
        const res = await this.fetchImpl(`${this.base}/object/list/${encodeURIComponent(this.bucket)}`, {
          method: 'POST',
          headers: this.headers({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ prefix, limit: 1000, offset }),
        });
        if (!res.ok) throw new Error(`Falha ao listar o armazenamento (HTTP ${res.status}).`);
        const page = (await res.json()) as { name: string; id: string | null }[];
        out.push(...page);
        if (page.length < 1000) return out;
      }
    };
    for (const dir of await list('')) {
      if (dir.id !== null) continue; // só pastas no primeiro nível
      for (const f of await list(`${dir.name}/`)) if (f.id) keys.push(`${dir.name}/${f.name}`);
    }
    return keys;
  }
}

// ---------------------------------------------------------------------------
// PostgreSQL (tabela document_blobs, só o papel proprietário acessa). Usado
// quando o Supabase Storage não está configurado — documentos até 4 MB.
// ---------------------------------------------------------------------------

export class PgStorage implements FileStorage {
  constructor(
    private readonly pool: pg.Pool,
    private readonly localTmp: string,
  ) {}

  async init() {
    await mkdir(this.localTmp, { recursive: true, mode: 0o700 });
  }

  newKey = newKey;

  tmpPath() {
    return path.join(this.localTmp, `${randomUUID()}.part`);
  }

  get tmpDir() {
    return this.localTmp;
  }

  async commitTmp(tmp: string, key: string) {
    assertKey(key);
    const content = await readFile(tmp);
    await this.pool.query('insert into document_blobs (storage_key, content) values ($1, $2)', [key, content]);
    await rm(tmp, { force: true });
  }

  async remove(key: string) {
    assertKey(key);
    await this.pool.query('delete from document_blobs where storage_key = $1', [key]);
  }

  async exists(key: string) {
    assertKey(key);
    const r = await this.pool.query('select 1 from document_blobs where storage_key = $1', [key]);
    return !!r.rowCount;
  }

  async read(key: string) {
    assertKey(key);
    const r = await this.pool.query<{ content: Buffer }>('select content from document_blobs where storage_key = $1', [key]);
    return r.rows[0] ? Readable.from(r.rows[0].content) : null;
  }

  async listKeys() {
    const r = await this.pool.query<{ storage_key: string }>('select storage_key from document_blobs');
    return r.rows.map((x) => x.storage_key);
  }
}

/** Chave do Supabase com formato plausível (JWT "eyJ..." ou "sb_secret_..."); marcadores e vazios não contam. */
export function plausibleServiceKey(key?: string) {
  const k = key?.trim() ?? '';
  return /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(k) || /^sb_secret_[\w-]{10,}$/.test(k);
}

/** Verifica se o Storage aceita a chave (lista 1 item do bucket). Retorna o status HTTP. */
export async function probeSupabaseStorage(url: string, key: string, bucket: string, fetchImpl: typeof fetch = fetch) {
  const res = await fetchImpl(`${url.replace(/\/+$/, '')}/storage/v1/object/list/${encodeURIComponent(bucket)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix: '', limit: 1 }),
  });
  return res.status;
}
