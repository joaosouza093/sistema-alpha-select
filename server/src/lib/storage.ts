import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Armazenamento privado em disco. Os arquivos ficam fora de qualquer pasta
 * pública e só são entregues pelo servidor após autorização.
 * Chave interna aleatória, sem dados pessoais: "ab/<uuid>".
 */
export class DiskStorage {
  constructor(private readonly root: string) {}

  async init() {
    await mkdir(path.join(this.root, 'tmp'), { recursive: true, mode: 0o700 });
  }

  newKey(): string {
    const id = randomUUID();
    return `${id.slice(0, 2)}/${id}`;
  }

  tmpPath(): string {
    return path.join(this.root, 'tmp', `${randomUUID()}.part`);
  }

  private resolve(key: string): string {
    if (!/^[0-9a-f]{2}\/[0-9a-f-]{36}$/.test(key)) throw new Error('Chave de armazenamento inválida.');
    return path.join(this.root, 'files', key);
  }

  async commitTmp(tmp: string, key: string) {
    const dest = this.resolve(key);
    await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
    await rename(tmp, dest);
  }

  async remove(key: string) {
    await rm(this.resolve(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  read(key: string) {
    return createReadStream(this.resolve(key));
  }

  get filesDir() {
    return path.join(this.root, 'files');
  }

  get tmpDir() {
    return path.join(this.root, 'tmp');
  }
}
