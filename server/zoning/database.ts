import { Pool } from 'pg';
import type { SqlExecutor } from '../../src/services/zoning/registry';

export interface ZoningDatabase {
  pool: Pool;
  sql: SqlExecutor;
  close(): Promise<void>;
}

export function createZoningDatabase(connectionString: string, ssl: boolean): ZoningDatabase {
  const pool = new Pool({
    connectionString,
    max: 12,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    keepAlive: true,
    ssl: ssl ? { rejectUnauthorized: false } : undefined,
  });
  const sql: SqlExecutor = {
    async query<Row>(text: string, values: readonly unknown[] = []) {
      const result = await pool.query(text, [...values]);
      return { rows: result.rows as Row[] };
    },
  };
  return { pool, sql, close: () => pool.end() };
}
