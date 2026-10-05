import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { MultipartFile } from '@fastify/multipart';
import { fileTypeFromFile } from 'file-type';
import type { Deps } from './context.js';
import { AppError, badRequest } from './errors.js';
import { cleanText } from './normalize.js';

/**
 * Formatos aceitos. A extensão informada precisa corresponder ao tipo
 * detectado pelo conteúdo (assinatura do arquivo). HTML, SVG, scripts e
 * executáveis nunca são aceitos.
 */
const ALLOWED: Record<string, { mimes: string[]; detected: string[]; inline: boolean }> = {
  pdf: { mimes: ['application/pdf'], detected: ['application/pdf'], inline: true },
  png: { mimes: ['image/png'], detected: ['image/png'], inline: true },
  jpg: { mimes: ['image/jpeg'], detected: ['image/jpeg'], inline: true },
  jpeg: { mimes: ['image/jpeg'], detected: ['image/jpeg'], inline: true },
  docx: {
    mimes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    detected: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    inline: false,
  },
  doc: { mimes: ['application/msword'], detected: ['application/x-cfb'], inline: false },
  odt: {
    mimes: ['application/vnd.oasis.opendocument.text'],
    detected: ['application/vnd.oasis.opendocument.text'],
    inline: false,
  },
};

export const ALLOWED_EXTENSIONS = Object.keys(ALLOWED);

export const INLINE_MIMES = new Set(['application/pdf', 'image/png', 'image/jpeg']);

export function sanitizeName(name: string): string {
  const base = path.basename(cleanText(name).replace(/\\/g, '/'));
  const safe = base.replace(/[<>:"/\\|?*]/g, '_').slice(-200);
  return safe || 'arquivo';
}

export function contentDisposition(type: 'inline' | 'attachment', name: string) {
  const ascii = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

async function hasPdfHeader(file: string) {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(5);
    await fh.read(buf, 0, 5, 0);
    return buf.toString('latin1') === '%PDF-';
  } finally {
    await fh.close();
  }
}


export interface ReceivedFile {
  originalName: string;
  mime: string;
  size: number;
  sha256: string;
}

/**
 * Recebe o arquivo em `tmp` e valida extensão, tipo declarado, tamanho e
 * assinatura do conteúdo. Em caso de erro, apaga o temporário e lança.
 */
export async function receiveUpload(
  deps: Deps,
  part: MultipartFile,
  tmp: string,
  extensions: string[] = ALLOWED_EXTENSIONS,
): Promise<ReceivedFile> {
  const originalName = sanitizeName(part.filename || 'arquivo');
  const ext = path.extname(originalName).slice(1).toLowerCase();
  const rule = extensions.includes(ext) ? ALLOWED[ext] : undefined;
  try {
    if (!rule || !rule.mimes.includes(part.mimetype)) {
      part.file.resume();
      throw new AppError(415, 'unsupported', `Formato não permitido. Aceitos: ${extensions.join(', ')}.`);
    }
    const hash = createHash('sha256');
    let size = 0;
    await pipeline(
      part.file,
      new Transform({
        transform(chunk, _enc, cb) {
          hash.update(chunk);
          size += chunk.length;
          cb(null, chunk);
        },
      }),
      createWriteStream(tmp, { mode: 0o600 }),
    );
    if (part.file.truncated) {
      throw new AppError(413, 'too_large', `Arquivo acima do limite de ${deps.config.MAX_UPLOAD_MB} MB.`);
    }
    if (size === 0) throw badRequest('Arquivo vazio.');
    const detected = await fileTypeFromFile(tmp);
    if (!detected || !rule.detected.includes(detected.mime)) {
      throw new AppError(415, 'unsupported', 'O conteúdo do arquivo não corresponde à extensão informada.');
    }
    if (detected.mime === 'application/pdf' && !(await hasPdfHeader(tmp))) {
      throw new AppError(415, 'unsupported', 'PDF inválido.');
    }
    return { originalName, mime: rule.mimes[0]!, size, sha256: hash.digest('hex') };
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}
