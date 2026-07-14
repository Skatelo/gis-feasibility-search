// Jurisdiction source registry — the heart of the discover-once/verify/cache/
// reuse runtime loop. The first lookup in a jurisdiction discovers + verifies
// its GIS source and saves the record here; every later lookup in the same
// jurisdiction reads the record and queries ArcGIS directly, skipping discovery.
//
// Persistence is pluggable (KVStore). Records validate through Zod on read, and
// a record written by an older engine schema is treated as a miss so a stale
// layout can never produce a wrong result.

import {
  ENGINE_SCHEMA_VERSION,
  JurisdictionSourceRecordSchema,
  type JurisdictionSourceRecord,
  type JurisdictionSourceRecordRaw,
  type SourceRegistry,
  type ZoningLayerConfig,
  type ParcelLayerConfig,
  type BoundaryLayerConfig,
} from '../types';
import { InMemoryKVStore, defaultKVStore, type KVStore } from './kv-store';

// Suggested TTLs (ms) — government GIS changes, so nothing is cached forever.
export const CACHE_TTL = {
  geocoding: 90 * 24 * 60 * 60 * 1000, // 90 days
  jurisdiction: 30 * 24 * 60 * 60 * 1000, // 30 days
  serviceMetadata: 24 * 60 * 60 * 1000, // 24 hours
  fieldMapping: 7 * 24 * 60 * 60 * 1000, // 7 days
  zoningResult: 24 * 60 * 60 * 1000, // 1 day
  sourceHealth: 12 * 60 * 60 * 1000, // 12 hours
} as const;

const RECORD_NS = 'jurisdiction-source';

function norm(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/\bcounty\b/g, '').replace(/[^a-z0-9]/g, '') || '_';
}

export interface JurisdictionKeyParts {
  country?: string | null;
  stateCode?: string | null;
  county?: string | null;
  municipality?: string | null;
  jurisdictionType?: string | null;
}

/** Stable registry key for a jurisdiction. Municipal lookups key on the
 *  municipality; county/unincorporated lookups key on the county, so every
 *  address in the same authority resolves to the same record. */
export function jurisdictionKey(parts: JurisdictionKeyParts): string {
  const country = norm(parts.country ?? 'US');
  const state = norm(parts.stateCode);
  const type = norm(parts.jurisdictionType);
  const local = type === 'municipal' && parts.municipality ? `m:${norm(parts.municipality)}` : `c:${norm(parts.county)}`;
  return `${country}:${state}:${local}:${type}`;
}

function narrow(raw: JurisdictionSourceRecordRaw): JurisdictionSourceRecord {
  return {
    ...raw,
    zoningLayers: raw.zoningLayers as ZoningLayerConfig[],
    parcelLayers: raw.parcelLayers as ParcelLayerConfig[],
    boundaryLayers: raw.boundaryLayers as BoundaryLayerConfig[],
  };
}

/** SourceRegistry implemented over any KVStore. */
export class KvSourceRegistry implements SourceRegistry {
  private readonly store: KVStore;

  constructor(store: KVStore = defaultKVStore()) {
    this.store = store;
  }

  async get(key: string): Promise<JurisdictionSourceRecord | null> {
    const entry = await this.store.get(`${RECORD_NS}:${key}`);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt < Date.now()) {
      await this.store.delete(`${RECORD_NS}:${key}`);
      return null;
    }
    const parsed = JurisdictionSourceRecordSchema.safeParse(entry.value);
    if (!parsed.success) return null;
    // A record from an older engine schema is invalidated, not trusted.
    if (parsed.data.schemaVersion !== ENGINE_SCHEMA_VERSION) {
      await this.store.delete(`${RECORD_NS}:${key}`);
      return null;
    }
    return narrow(parsed.data);
  }

  async put(record: JurisdictionSourceRecord): Promise<void> {
    const toStore: JurisdictionSourceRecordRaw = { ...record, schemaVersion: ENGINE_SCHEMA_VERSION };
    // Validate before persisting so a malformed record never enters the cache.
    JurisdictionSourceRecordSchema.parse(toStore);
    await this.store.set(`${RECORD_NS}:${record.id}`, { value: toStore, expiresAt: null });
  }

  async delete(key: string): Promise<void> {
    await this.store.delete(`${RECORD_NS}:${key}`);
  }

  async cacheGet<T>(namespace: string, key: string): Promise<T | null> {
    const entry = await this.store.get(`cache:${namespace}:${key}`);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt < Date.now()) {
      await this.store.delete(`cache:${namespace}:${key}`);
      return null;
    }
    return entry.value as T;
  }

  async cacheSet<T>(namespace: string, key: string, value: T, ttlMs: number): Promise<void> {
    await this.store.set(`cache:${namespace}:${key}`, { value, expiresAt: Date.now() + ttlMs });
  }
}

/** In-memory registry — for servers without a store yet, and for tests. */
export function createInMemoryRegistry(): SourceRegistry {
  return new KvSourceRegistry(new InMemoryKVStore());
}

/** Environment-default registry (browser localStorage, else in-memory). */
export function createRegistry(store?: KVStore): SourceRegistry {
  return new KvSourceRegistry(store ?? defaultKVStore());
}
