// Pluggable key/value storage backing the registry + caches.
//
// The engine runs in the browser (localStorage/IndexedDB), on a server (SQL/
// Redis behind this interface), and in tests (in-memory) without code changes.
// Values carry their own expiry so TTL logic lives in one place.

export interface StoredEntry {
  value: unknown;
  /** Epoch ms when this entry expires; null = no expiry. */
  expiresAt: number | null;
}

export interface KVStore {
  get(key: string): Promise<StoredEntry | null>;
  set(key: string, entry: StoredEntry): Promise<void>;
  delete(key: string): Promise<void>;
}

export class InMemoryKVStore implements KVStore {
  private readonly map = new Map<string, StoredEntry>();

  async get(key: string): Promise<StoredEntry | null> {
    return this.map.get(key) ?? null;
  }

  async set(key: string, entry: StoredEntry): Promise<void> {
    this.map.set(key, entry);
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Browser localStorage/sessionStorage-backed store (JSON-serialized). Falls
 *  back gracefully: a serialization/quota error drops the write rather than
 *  throwing, so caching never breaks a lookup. */
export class WebStorageKVStore implements KVStore {
  private readonly storage: WebStorageLike;
  private readonly prefix: string;

  constructor(storage: WebStorageLike, prefix = 'zoning:') {
    this.storage = storage;
    this.prefix = prefix;
  }

  async get(key: string): Promise<StoredEntry | null> {
    try {
      const raw = this.storage.getItem(this.prefix + key);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as StoredEntry;
      return parsed && typeof parsed === 'object' && 'value' in parsed ? parsed : null;
    } catch {
      return null;
    }
  }

  async set(key: string, entry: StoredEntry): Promise<void> {
    try {
      this.storage.setItem(this.prefix + key, JSON.stringify(entry));
    } catch {
      /* quota exceeded / non-serializable — skip caching */
    }
  }

  async delete(key: string): Promise<void> {
    try {
      this.storage.removeItem(this.prefix + key);
    } catch {
      /* ignore */
    }
  }
}

/** Pick the best available store for the current environment. */
export function defaultKVStore(): KVStore {
  const g = globalThis as unknown as { localStorage?: WebStorageLike };
  if (g.localStorage && typeof g.localStorage.getItem === 'function') {
    return new WebStorageKVStore(g.localStorage);
  }
  return new InMemoryKVStore();
}
