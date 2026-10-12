import { rm } from 'node:fs/promises';
import { buffer } from 'node:stream/consumers';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../lib/context.js';
import { asUser, audit, isAdmin, requireUser } from '../../lib/context.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import type { MailAttachment } from '../../lib/mailer.js';
import { parse } from '../../lib/validate.js';
import { zUuid } from '../../lib/normalize.js';
import { contentDisposition, receiveUpload } from '../../lib/upload.js';

export type BillingFileKind = 'boleto' | 'nota_fiscal' | 'contrato';

const EXTENSIONS: Record<BillingFileKind, string[]> = {
  boleto: ['pdf'],
  nota_fiscal: ['pdf', 'xml'],
  contrato: ['pdf', 'docx', 'doc', 'odt'],
};

export const fileLabel: Record<BillingFileKind, string> = { boleto: 'Boleto', nota_fiscal: 'Nota fiscal', contrato: 'Contrato' };

/** Colunas dos anexos (json) de uma cobrança ou contrato, para as listagens. */
export const chargeFilesJson = (alias: string) => `coalesce((
  select json_agg(json_build_object('id', f.id, 'kind', f.kind, 'name', f.original_name, 'size', f.size_bytes, 'createdAt', f.created_at)
                  order by f.kind)
    from billing_files f where f.charge_id = ${alias}.id), '[]'::json)`;
export const contractFileJson = (alias: string) => `(
  select json_build_object('id', f.id, 'kind', f.kind, 'name', f.original_name, 'size', f.size_bytes, 'createdAt', f.created_at)
    from billing_files f where f.contract_id = ${alias}.id)`;

/** Anexos da cobrança para o e-mail (lidos pelo servidor). Falha de leitura não impede o envio. */
export async function chargeAttachments(deps: Deps, chargeId: string, kinds: BillingFileKind[]): Promise<MailAttachment[]> {
  if (!kinds.length) return [];
  const { rows } = await deps.pools.owner.query<{ storage_key: string; original_name: string; mime_type: string }>(
    'select storage_key, original_name, mime_type from billing_files where charge_id = $1 and kind = any($2) order by kind',
    [chargeId, kinds],
  );
  const out: MailAttachment[] = [];
  for (const r of rows) {
    try {
      const stream = await deps.storage.read(r.storage_key);
      if (stream) out.push({ filename: r.original_name, content: await buffer(stream), contentType: r.mime_type });
    } catch {
      /* segue sem o anexo */
    }
  }
  return out;
}

/** Remove arquivos do armazenamento depois do commit (falhas ficam para a limpeza de órfãos). */
export async function removeStored(deps: Deps, keys: string[]) {
  for (const k of keys) await deps.storage.remove(k).catch(() => undefined);
}

export function registerBillingFileRoutes(app: FastifyInstance, deps: Deps) {
  const { storage, config } = deps;

  const adminOnly = (req: FastifyRequest) => {
    const u = requireUser(req);
    if (!isAdmin(u)) throw forbidden();
    return u;
  };

  /**
   * Recebe o arquivo e grava o anexo; substitui o anterior do mesmo tipo.
   * `owner` diz a que o arquivo pertence (cobrança ou contrato).
   */
  async function upload(req: FastifyRequest, owner: { chargeId?: string; contractId?: string }, kind: BillingFileKind | null) {
    const user = adminOnly(req);
    await deps.limiters.upload.consume(`u:${user.id}`);
    const companyId = await asUser(deps, req, async (db) => {
      const r = owner.chargeId
        ? await db.query<{ company_id: string }>('select company_id from charges where id = $1', [owner.chargeId])
        : await db.query<{ company_id: string }>('select company_id from contracts where id = $1', [owner.contractId]);
      if (!r.rows[0]) throw notFound(owner.chargeId ? 'Cobrança não encontrada.' : 'Contrato não encontrado.');
      return r.rows[0].company_id;
    });
    if (!req.isMultipart()) throw badRequest('Envie o arquivo como multipart/form-data.');
    const part = await req.file({ limits: { fileSize: config.maxUploadBytes, files: 1, fields: 4, fieldSize: 200 } });
    if (!part) throw badRequest('Nenhum arquivo enviado.');
    const k: BillingFileKind = kind ?? parse(z.enum(['boleto', 'nota_fiscal']), (part.fields.kind as { value?: unknown } | undefined)?.value);

    const tmp = storage.tmpPath();
    let committedKey: string | null = null;
    try {
      const file = await receiveUpload(deps, part, tmp, EXTENSIONS[k]);
      const storageKey = storage.newKey();
      const { id, replaced } = await asUser(deps, req, async (db) => {
        const old = await db.query<{ storage_key: string }>(
          owner.chargeId
            ? 'delete from billing_files where charge_id = $1 and kind = $2 returning storage_key'
            : 'delete from billing_files where contract_id = $1 and $2::text is not null returning storage_key',
          [owner.chargeId ?? owner.contractId, k],
        );
        const { rows } = await db.query<{ id: string }>(
          `insert into billing_files (charge_id, contract_id, kind, storage_key, original_name, mime_type, size_bytes, sha256, uploaded_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8, app.uid()) returning id`,
          [owner.chargeId ?? null, owner.contractId ?? null, k, storageKey, file.originalName, file.mime, file.size, file.sha256],
        );
        await storage.commitTmp(tmp, storageKey);
        committedKey = storageKey;
        await audit(db, req, 'billing_file.uploaded', owner.chargeId ? 'charge' : 'contract', owner.chargeId ?? owner.contractId!, companyId, {
          kind: k, size: file.size, replaced: old.rowCount! > 0,
        });
        return { id: rows[0]!.id, replaced: old.rows.map((r) => r.storage_key) };
      });
      committedKey = null;
      await removeStored(deps, replaced);
      return { id, kind: k, name: file.originalName, size: file.size };
    } finally {
      await rm(tmp, { force: true }).catch(() => undefined);
      if (committedKey) await storage.remove(committedKey).catch(() => undefined);
    }
  }

  app.post('/api/billing/charges/:id/files', async (req, reply) => {
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const r = await upload(req, { chargeId: id }, null);
    reply.code(201);
    return r;
  });

  app.post('/api/contracts/:id/file', async (req, reply) => {
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const r = await upload(req, { contractId: id }, 'contrato');
    reply.code(201);
    return r;
  });

  /** Download do anexo: administrador, ou gestor da empresa dona da cobrança/contrato (RLS). */
  app.get('/api/billing/files/:id/content', async (req, reply) => {
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const q = parse(z.object({ download: z.enum(['1', '0']).optional() }), req.query);
    const f = await asUser(deps, req, async (db) => {
      const { rows } = await db.query<{ storage_key: string; original_name: string; mime_type: string; size_bytes: number; kind: string; company_id: string }>(
        `select f.storage_key, f.original_name, f.mime_type, f.size_bytes, f.kind, coalesce(c.company_id, k.company_id) as company_id
           from billing_files f
           left join charges c on c.id = f.charge_id
           left join contracts k on k.id = f.contract_id
          where f.id = $1`,
        [id],
      );
      if (!rows[0]) throw notFound('Arquivo não encontrado.');
      await audit(db, req, 'billing_file.downloaded', 'billing_file', id, rows[0].company_id, { kind: rows[0].kind });
      return rows[0];
    });
    const content = await storage.read(f.storage_key);
    if (!content) throw notFound('Arquivo indisponível.');
    const inline = q.download !== '1' && f.mime_type === 'application/pdf';
    reply
      .header('Content-Type', f.mime_type)
      .header('Content-Length', String(f.size_bytes))
      .header('Content-Disposition', contentDisposition(inline ? 'inline' : 'attachment', f.original_name))
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, no-store')
      .header('Cross-Origin-Resource-Policy', 'same-origin');
    if (!inline) reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
    return reply.send(content);
  });

  app.delete('/api/billing/files/:id', async (req) => {
    adminOnly(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const key = await asUser(deps, req, async (db) => {
      const { rows } = await db.query<{ storage_key: string; kind: string; charge_id: string | null; contract_id: string | null }>(
        'delete from billing_files where id = $1 returning storage_key, kind, charge_id, contract_id',
        [id],
      );
      if (!rows[0]) throw notFound('Arquivo não encontrado.');
      const r = rows[0];
      await audit(db, req, 'billing_file.deleted', r.charge_id ? 'charge' : 'contract', (r.charge_id ?? r.contract_id)!, null, { kind: r.kind });
      return r.storage_key;
    });
    await removeStored(deps, [key]);
    return { ok: true };
  });
}
