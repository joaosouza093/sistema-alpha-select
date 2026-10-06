import type { Db } from '../../lib/db.js';

/**
 * Eliminação definitiva de candidatos: participações (com comentários,
 * histórico, avaliações e envios), documentos e o cadastro. Devolve as
 * chaves dos arquivos para remoção física depois do commit.
 */
export async function eraseCandidates(db: Db, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const docs = await db.query<{ storage_key: string }>('select storage_key from documents where candidate_id = any($1::uuid[])', [ids]);
  await db.query('delete from applications where candidate_id = any($1::uuid[])', [ids]);
  await db.query('delete from documents where candidate_id = any($1::uuid[])', [ids]);
  await db.query('delete from candidates where id = any($1::uuid[])', [ids]);
  return docs.rows.map((d) => d.storage_key);
}
