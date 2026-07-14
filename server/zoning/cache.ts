import Redis from 'ioredis';
import type { RegistryCache } from '../../src/services/zoning/registry';

interface MemoryEntry {
  value: unknown;
  expiresAt: number;
}

export class MemoryJsonCache implements RegistryCache {
  private readonly entries = new Map<string, MemoryEntry>();

  async get<T>(key: string): Promise<T | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

export class RedisJsonCache implements RegistryCache {
  private readonly redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  async get<T>(key: string): Promise<T | null> {
    const value = await this.redis.get(key);
    if (!value) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      await this.redis.del(key);
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    await this.redis.set(key, JSON.stringify(value), 'PX', ttlMs);
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(key);
  }
}

export class SingleFlightResultCache {
  private readonly cache: RegistryCache;
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(cache: RegistryCache) {
    this.cache = cache;
  }

  get<T>(key: string): Promise<T | null> {
    return this.cache.get<T>(key);
  }

  set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    return this.cache.set(key, value, ttlMs);
  }

  async run<T>(key: string, factory: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const promise = factory().finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }
}

export async function connectRedis(url: string): Promise<Redis> {
  const redis = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    connectTimeout: 3_000,
  });
  await redis.connect();
  return redis;
}
