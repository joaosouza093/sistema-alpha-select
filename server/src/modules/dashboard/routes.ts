import type { FastifyInstance } from 'fastify';
import type { Deps } from '../../lib/context.js';
import { asUser } from '../../lib/context.js';

/**
 * Indicadores calculados sob RLS: cada contagem considera apenas o que o
 * usuário autenticado pode ver.
 */
export function registerDashboardRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/api/dashboard', async (req) => {
    return asUser(deps, req, async (db, user) => {
      const totals = await db.query<{ activeProcesses: number; candidates: number; openApplications: number }>(
        `select
           (select count(*)::int from processes where status = 'em_andamento') as "activeProcesses",
           (select count(distinct a.candidate_id)::int from applications a
              join processes p on p.id = a.process_id where p.status = 'em_andamento') as "candidates",
           (select count(*)::int from applications a
              join processes p on p.id = a.process_id
             where p.status = 'em_andamento' and a.decision = 'pendente') as "openApplications"`,
      );
      const byStage = await db.query(
        `select s.id as "stageId", s.name, count(a.id)::int as count
           from stages s
           left join (applications a join processes p on p.id = a.process_id and p.status = 'em_andamento')
             on a.stage_id = s.id and a.decision = 'pendente'
          group by s.id, s.name, s.position order by s.position`,
      );
      const mine = await db.query(
        `select a.id, s.full_name as "candidateName", p.title as "processTitle", st.name as "stageName",
                a.stage_changed_at as "stageChangedAt"
           from applications a
           join processes p on p.id = a.process_id
           join stages st on st.id = a.stage_id
           join shared_application_candidates s on s.application_id = a.id
          where a.owner_id = $1 and a.decision = 'pendente' and p.status = 'em_andamento'
          order by a.stage_changed_at limit 20`,
        [user.id],
      );
      const recent = await db.query(
        `select h.id, h.application_id as "applicationId", h.event, h.created_at as "createdAt",
                fs.name as "fromStage", ts.name as "toStage", h.from_decision as "fromDecision",
                h.to_decision as "toDecision", s.full_name as "candidateName", p.title as "processTitle",
                app.person_label(h.actor_id) as "actorName"
           from application_history h
           join applications a on a.id = h.application_id
           join processes p on p.id = a.process_id
           join shared_application_candidates s on s.application_id = a.id
           left join stages fs on fs.id = h.from_stage_id
           left join stages ts on ts.id = h.to_stage_id
          order by h.created_at desc, h.id desc limit 12`,
      );
      return { totals: totals.rows[0], byStage: byStage.rows, myPending: mine.rows, recent: recent.rows };
    });
  });

  app.get('/api/stages', async (req) =>
    asUser(deps, req, async (db) => {
      const { rows } = await db.query('select id, key, name, position from stages order by position');
      return { items: rows };
    }),
  );
}
