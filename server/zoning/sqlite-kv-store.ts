import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { KVStore, StoredEntry } from '../../src/services/zoning/registry';

interface StoredRow {
  value_json: string;
  expires_at: number | null;
}

/** Small durable KV store for local development. Production continues to use
 * PostgreSQL, while this preserves discovered sources and cache entries across
 * local API restarts without introducing an ORM or native npm dependency. */
export class SqliteKVStore implements KVStore {
  private readonly database: DatabaseSync;
  private readonly select: StatementSync;
  private readonly upsert: StatementSync;
  private readonly remove: StatementSync;

  constructor(filename: string) {
    const resolved = filename === ':memory:' ? filename : resolve(filename);
    if (resolved !== ':memory:') mkdirSync(dirname(resolved), { recursive: true });
    this.database = new DatabaseSync(resolved);
    this.database.exec(`
      pragma journal_mode = WAL;
      pragma busy_timeout = 3000;
      create table if not exists zoning_kv (
        key text primary key,
        value_json text not null,
        expires_at integer
      );
      create index if not exists zoning_kv_expires_idx on zoning_kv(expires_at);
    `);
    this.select = this.database.prepare('select value_json, expires_at from zoning_kv where key = ?');
    this.upsert = this.database.prepare(`
      insert into zoning_kv(key, value_json, expires_at) values (?, ?, ?)
      on conflict(key) do update set value_json = excluded.value_json, expires_at = excluded.expires_at
    `);
    this.remove = this.database.prepare('delete from zoning_kv where key = ?');
  }

  async get(key: string): Promise<StoredEntry | null> {
    const row = this.select.get(key) as StoredRow | undefined;
    if (!row) return null;
    if (row.expires_at !== null && row.expires_at <= Date.now()) {
      this.remove.run(key);
      return null;
    }
    try {
      return { value: JSON.parse(row.value_json) as unknown, expiresAt: row.expires_at };
    } catch {
      this.remove.run(key);
      return null;
    }
  }

  async set(key: string, entry: StoredEntry): Promise<void> {
    this.upsert.run(key, JSON.stringify(entry.value), entry.expiresAt);
  }

  async delete(key: string): Promise<void> {
    this.remove.run(key);
  }

  close(): void {
    this.database.close();
  }
}
