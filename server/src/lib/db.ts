import pg from 'pg';
import type { Config } from '../config.js';

// numeric -> number (pretensão salarial), bigint -> number (tamanhos de arquivo)
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

export type Db = pg.PoolClient;

export interface Pools {
  /** Papel alpha_app: sujeito a RLS. */
  app: pg.Pool;
  /** Papel proprietário: somente autenticação e tarefas administrativas do servidor. */
  owner: pg.Pool;
}

export function createPools(config: Config): Pools {
  const ssl = config.DATABASE_SSL ? { rejectUnauthorized: true } : undefined;
  return {
    app: new pg.Pool({ connectionString: config.DATABASE_URL, max: 15, ssl }),
    owner: new pg.Pool({ connectionString: config.DATABASE_OWNER_URL, max: 5, ssl }),
  };
}

/**
 * Executa `fn` em uma transação com o usuário autenticado definido para a RLS.
 * O identificador vem da sessão validada no servidor — nunca do navegador.
 */
export async function withUser<T>(pool: pg.Pool, userId: string, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.user_id', $1, true)", [userId]);
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function withTx<T>(pool: pg.Pool, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
