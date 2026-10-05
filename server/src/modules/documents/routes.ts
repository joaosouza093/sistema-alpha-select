import { rm } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../lib/context.js';
import { asUser, audit, isAlpha, requireUser } from '../../lib/context.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { zUuid } from '../../lib/normalize.js';
import { INLINE_MIMES, contentDisposition, receiveUpload } from '../../lib/upload.js';

export function registerDocumentRoutes(app: FastifyInstance, deps: Deps) {
  const { storage, config } = deps;

  app.post('/api/candidates/:id/documents', async (req, reply) => {
    const user = requireUser(req);
    if (!isAlpha(user)) throw forbidden();
    const { id: candidateId } = parse(z.object({ id: zUuid }), req.params);
    await deps.limiters.upload.consume(`u:${user.id}`);

    // Autoriza antes de receber o conteúdo.
    await asUser(deps, req, async (db) => {
      const c = await db.query('select 1 from candidates where id = $1', [candidateId]);
      if (!c.rowCount) throw notFound('Candidato não encontrado.');
    });

    if (!req.isMultipart()) throw badRequest('Envie o arquivo como multipart/form-data.');
    const part = await req.file({ limits: { fileSize: config.maxUploadBytes, files: 1, fields: 4, fieldSize: 200 } });
    if (!part) throw badRequest('Nenhum arquivo enviado.');

    const kindField = part.fields.kind as { value?: unknown } | undefined;
    const kind = parse(z.enum(['curriculo', 'documento', 'outro']).default('curriculo'), kindField?.value ?? undefined);
    const tmp = storage.tmpPath();
    let committedKey: string | null = null;

    try {
      const file = await receiveUpload(deps, part, tmp);
      const { originalName, size } = file;
      const storageKey = storage.newKey();
      const storedMime = file.mime;
      const docId = await asUser(deps, req, async (db) => {
        const { rows } = await db.query<{ id: string }>(
          `insert into documents (candidate_id, kind, storage_key, original_name, mime_type, size_bytes, sha256, uploaded_by)
           values ($1, $2, $3, $4, $5, $6, $7, app.uid()) returning id`,
          [candidateId, kind, storageKey, originalName, storedMime, size, file.sha256],
        );
        // Grava o arquivo definitivo dentro da transação: se falhar, o registro é desfeito.
        await storage.commitTmp(tmp, storageKey);
        committedKey = storageKey;
        await audit(db, req, 'document.uploaded', 'document', rows[0]!.id, null, {
          candidateId,
          size,
          mime: storedMime,
        });
        return rows[0]!.id;
      });
      committedKey = null;
      reply.code(201);
      return { id: docId };
    } finally {
      await rm(tmp, { force: true }).catch(() => undefined);
      // Commit do banco falhou depois de mover o arquivo: remove o arquivo para não deixar órfão.
      if (committedKey) await storage.remove(committedKey).catch(() => undefined);
    }
  });

  /**
   * Entrega autenticada do arquivo. A autorização é reavaliada a cada acesso,
   * então a revogação de vínculo/compartilhamento tem efeito imediato.
   */
  app.get('/api/documents/:id/content', async (req, reply) => {
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const q = parse(z.object({ download: z.enum(['1', '0']).optional() }), req.query);
    const doc = await asUser(deps, req, async (db) => {
      const { rows } = await db.query<{ storage_key: string; original_name: string; mime_type: string; size_bytes: number }>(
        'select storage_key, original_name, mime_type, size_bytes from documents where id = $1',
        [id],
      );
      if (!rows[0]) throw notFound('Documento não encontrado.');
      await audit(db, req, q.download === '1' ? 'document.downloaded' : 'document.viewed', 'document', id);
      return rows[0];
    });
    const content = await storage.read(doc.storage_key);
    if (!content) throw notFound('Arquivo indisponível.');
    const inline = q.download !== '1' && INLINE_MIMES.has(doc.mime_type);
    reply
      .header('Content-Type', doc.mime_type)
      .header('Content-Length', String(doc.size_bytes))
      .header('Content-Disposition', contentDisposition(inline ? 'inline' : 'attachment', doc.original_name))
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, no-store')
      .header('Cross-Origin-Resource-Policy', 'same-origin');
    if (!inline || doc.mime_type !== 'application/pdf') {
      reply.header('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    }
    return reply.send(content);
  });

  app.delete('/api/documents/:id', async (req) => {
    if (!isAlpha(requireUser(req))) throw forbidden();
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const key = await asUser(deps, req, async (db) => {
      const cur = await db.query<{ storage_key: string }>('select storage_key from documents where id = $1', [id]);
      if (!cur.rows[0]) throw notFound('Documento não encontrado.');
      const { rowCount } = await db.query('delete from documents where id = $1', [id]);
      if (!rowCount) throw forbidden('Somente quem enviou o documento ou um administrador pode removê-lo.');
      await audit(db, req, 'document.deleted', 'document', id);
      return cur.rows[0].storage_key;
    });
    // Remoção física após o commit. Falhas aqui são tratadas pela rotina de limpeza de órfãos.
    await storage.remove(key).catch(() => undefined);
    return { ok: true };
  });
}
