import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../lib/context.js';
import { asUser, audit, isAdmin, requireUser } from '../../lib/context.js';
import { AppError, conflict, forbidden, notFound } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { zText } from '../../lib/normalize.js';

const zStageId = z.coerce.number().int().min(1).max(32767);
const cols = 'id, key, name, position, is_active as "isActive", is_approval as "isApproval"';

/**
 * Etapas do processo seletivo, iguais para todos os processos. O
 * administrador renomeia, cria, reordena, desativa e exclui (sem uso).
 */
export function registerStageRoutes(app: FastifyInstance, deps: Deps) {
  const adminOnly = (req: FastifyRequest) => {
    if (!isAdmin(requireUser(req))) throw forbidden();
  };

  /** Ativas, na ordem. Com all=1 (administrador): todas, com o uso de cada uma. */
  app.get('/api/stages', async (req) => {
    const q = parse(z.object({ all: z.enum(['1', '0']).optional() }), req.query);
    if (q.all === '1') adminOnly(req);
    return asUser(deps, req, async (db) => {
      if (q.all !== '1') {
        const { rows } = await db.query(`select ${cols} from stages where is_active order by position`);
        return { items: rows };
      }
      const { rows } = await db.query(
        `select ${cols.replace(/(^|, )(\w+)/g, '$1s.$2')},
                (select count(*)::int from applications a join processes p on p.id = a.process_id
                  where a.stage_id = s.id and p.status = 'em_andamento' and a.decision = 'pendente') as "openCount",
                (exists (select 1 from applications a where a.stage_id = s.id)
                  or exists (select 1 from application_history h where h.from_stage_id = s.id or h.to_stage_id = s.id)) as used
           from stages s order by s.is_active desc, s.position`,
      );
      return { items: rows };
    });
  });

  app.post('/api/stages', async (req, reply) => {
    adminOnly(req);
    const body = parse(z.object({ name: zText(2, 40) }).strict(), req.body);
    const id = await asUser(deps, req, async (db) => {
      const dup = await db.query('select 1 from stages where lower(btrim(name)) = lower($1)', [body.name]);
      if (dup.rowCount) throw conflict('Já existe uma etapa com esse nome.');
      // Entra antes da etapa de aprovação (que normalmente é a última).
      const appr = await db.query<{ position: number }>('select position from stages where is_approval');
      const pos = appr.rows[0]?.position ?? null;
      if (pos !== null) await db.query('update stages set position = position + 1 where position >= $1', [pos]);
      const { rows } = await db.query<{ id: number }>(
        `insert into stages (key, name, position, is_active)
         values ($1, $2, coalesce($3, (select coalesce(max(position), 0) + 1 from stages)), true) returning id`,
        [`etapa_${randomUUID().slice(0, 8)}`, body.name, pos],
      );
      await audit(db, req, 'stage.created', 'stage', String(rows[0]!.id), null, { name: body.name });
      return rows[0]!.id;
    });
    reply.code(201);
    return { id };
  });

  app.patch('/api/stages/:id', async (req) => {
    adminOnly(req);
    const { id } = parse(z.object({ id: zStageId }), req.params);
    const body = parse(z.object({ name: zText(2, 40).optional(), isActive: z.boolean().optional() }).strict(), req.body);
    return asUser(deps, req, async (db) => {
      const cur = await db.query<{ is_active: boolean; is_approval: boolean }>('select is_active, is_approval from stages where id = $1', [id]);
      const s = cur.rows[0];
      if (!s) throw notFound('Etapa não encontrada.');
      if (body.name) {
        const dup = await db.query('select 1 from stages where lower(btrim(name)) = lower($1) and id <> $2', [body.name, id]);
        if (dup.rowCount) throw conflict('Já existe uma etapa com esse nome.');
      }
      if (body.isActive === false && s.is_active) {
        if (s.is_approval) throw conflict('A etapa de aprovação não pode ser desativada.');
        const active = await db.query<{ n: number }>('select count(*)::int as n from stages where is_active');
        if (active.rows[0]!.n <= 2) throw conflict('Mantenha ao menos duas etapas ativas.');
        const open = await db.query<{ n: number }>(
          `select count(*)::int as n from applications a join processes p on p.id = a.process_id
            where a.stage_id = $1 and p.status = 'em_andamento' and a.decision = 'pendente'`,
          [id],
        );
        if (open.rows[0]!.n) {
          throw conflict(`Há ${open.rows[0]!.n} candidato(s) em avaliação nesta etapa em processos em andamento. Mova-os antes de desativar.`);
        }
      }
      await db.query('update stages set name = coalesce($2, name), is_active = coalesce($3, is_active) where id = $1', [
        id, body.name ?? null, body.isActive ?? null,
      ]);
      await audit(db, req, 'stage.updated', 'stage', String(id), null, body);
      return { ok: true };
    });
  });

  /** Nova ordem: todas as etapas, na sequência desejada. */
  app.put('/api/stages/order', async (req) => {
    adminOnly(req);
    const body = parse(z.object({ ids: z.array(zStageId).min(2).max(50) }).strict(), req.body);
    return asUser(deps, req, async (db) => {
      const all = await db.query<{ id: number }>('select id from stages');
      const known = new Set(all.rows.map((r) => r.id));
      if (body.ids.length !== known.size || new Set(body.ids).size !== known.size || body.ids.some((i) => !known.has(i))) {
        throw new AppError(422, 'invalid', 'Envie todas as etapas, cada uma uma vez.');
      }
      await db.query(
        `update stages s set position = o.pos from unnest($1::smallint[]) with ordinality as o(id, pos) where s.id = o.id`,
        [body.ids],
      );
      await audit(db, req, 'stage.reordered', 'stage', null, null, { ids: body.ids });
      return { ok: true };
    });
  });

  app.delete('/api/stages/:id', async (req) => {
    adminOnly(req);
    const { id } = parse(z.object({ id: zStageId }), req.params);
    return asUser(deps, req, async (db) => {
      const cur = await db.query<{ is_approval: boolean; name: string }>('select is_approval, name from stages where id = $1', [id]);
      if (!cur.rows[0]) throw notFound('Etapa não encontrada.');
      if (cur.rows[0].is_approval) throw conflict('A etapa de aprovação não pode ser excluída.');
      const used = await db.query(
        `select 1 where exists (select 1 from applications where stage_id = $1)
            or exists (select 1 from application_history where from_stage_id = $1 or to_stage_id = $1)`,
        [id],
      );
      if (used.rowCount) throw conflict('Esta etapa já foi usada e faz parte do histórico. Desative-a em vez de excluir.');
      const active = await db.query<{ n: number }>('select count(*)::int as n from stages where is_active and id <> $1', [id]);
      if (active.rows[0]!.n < 2) throw conflict('Mantenha ao menos duas etapas ativas.');
      await db.query('delete from stages where id = $1', [id]);
      await audit(db, req, 'stage.deleted', 'stage', String(id), null, { name: cur.rows[0].name });
      return { ok: true };
    });
  });
}
