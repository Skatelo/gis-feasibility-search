import { Queue, type ConnectionOptions } from 'bullmq';
import type Redis from 'ioredis';
import {
  PostgresSourceRegistry,
  KvSourceRegistry,
  INITIAL_NC_SC_SOURCE_RECORDS,
  createInMemoryRegistry,
  seedInitialSourceRecords,
  type RegistryCache,
  type SourceRegistry,
  type SqlExecutor,
} from '../../src/services/zoning/registry';
import { createGeocoder } from '../../src/services/zoning/geocoding';
import { resolveJurisdiction, resolveJurisdictionFromPostgis } from '../../src/services/zoning/jurisdiction';
import { ZoningLookupEngine } from '../../src/services/zoning/orchestrator';
import type { GeocodedAddress, Geocoder, JurisdictionResult, Logger, ZoningLookupInput } from '../../src/services/zoning/types';
import { MemoryJsonCache, RedisJsonCache, SingleFlightResultCache, connectRedis } from './cache';
import { createZoningDatabase, type ZoningDatabase } from './database';
import type { ZoningServerConfig } from './config';
import { SqliteKVStore } from './sqlite-kv-store';
import { AdaptiveZoningLookupService, type AdaptiveLookupOutcome } from './adaptive-lookup';
import { ZoningMetrics } from './metrics';

export const MAINTENANCE_QUEUE = 'zoning-maintenance';

export interface ZoningRuntime {
  config: ZoningServerConfig;
  engine: ZoningLookupEngine;
  geocoder: Geocoder;
  registry: SourceRegistry;
  registryCache: RegistryCache;
  resultCache: SingleFlightResultCache;
  sql?: SqlExecutor;
  database?: ZoningDatabase;
  redis?: Redis;
  bullConnection?: ConnectionOptions;
  maintenanceQueue?: Queue;
  adaptiveLookup(input: ZoningLookupInput): Promise<AdaptiveLookupOutcome>;
  metrics: ZoningMetrics;
  resolveJurisdiction(address: GeocodedAddress): Promise<JurisdictionResult>;
  close(): Promise<void>;
}

const structuredLogger: Logger = {
  debug(message, metadata) { if (process.env.NODE_ENV !== 'production') console.debug(JSON.stringify({ level: 'debug', message, ...metadata })); },
  info(message, metadata) { console.info(JSON.stringify({ level: 'info', message, ...metadata })); },
  warn(message, metadata) { console.warn(JSON.stringify({ level: 'warn', message, ...metadata })); },
  error(message, metadata) { console.error(JSON.stringify({ level: 'error', message, ...metadata })); },
};

function createBullConnection(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  const database = url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0;
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: Number.isInteger(database) ? database : 0,
    tls: url.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null,
  };
}

export async function createZoningRuntime(config: ZoningServerConfig): Promise<ZoningRuntime> {
  let redis: Redis | undefined;
  let registryCache: RegistryCache = new MemoryJsonCache();
  if (config.redisUrl) {
    try {
      redis = await connectRedis(config.redisUrl);
      registryCache = new RedisJsonCache(redis);
    } catch (error) {
      structuredLogger.warn('Redis unavailable; using process-local cache', { error: String(error) });
    }
  }

  let database: ZoningDatabase | undefined;
  let sql: SqlExecutor | undefined;
  let registry: SourceRegistry;
  let sqliteStore: SqliteKVStore | undefined;
  if (config.databaseUrl) {
    database = createZoningDatabase(config.databaseUrl, config.databaseSsl);
    sql = database.sql;
    await sql.query('select 1');
    registry = new PostgresSourceRegistry(sql, registryCache);
  } else if (config.sqlitePath) {
    sqliteStore = new SqliteKVStore(config.sqlitePath);
    registry = new KvSourceRegistry(sqliteStore);
    for (const sourceRecord of INITIAL_NC_SC_SOURCE_RECORDS) {
      if (!(await registry.get(sourceRecord.id))) await registry.put(sourceRecord);
    }
    structuredLogger.info('Using durable local SQLite zoning registry', { path: config.sqlitePath });
  } else {
    registry = createInMemoryRegistry();
    await seedInitialSourceRecords(registry);
    structuredLogger.warn('DATABASE_URL and ZONING_SQLITE_PATH are unset; using a process-local zoning registry');
  }

  const geocoder = createGeocoder({ googleMapsApiKey: config.googleMapsApiKey });
  const jurisdictionResolver = async (address: GeocodedAddress): Promise<JurisdictionResult> => {
    if (sql) {
      const postgis = await resolveJurisdictionFromPostgis(sql, address);
      if (postgis) return postgis;
    }
    return resolveJurisdiction(address, { boundaryLookup: true });
  };
  const engine = new ZoningLookupEngine({
    geocoder,
    registry,
    jurisdictionResolver: jurisdictionResolver,
    log: structuredLogger,
  });
  const adaptiveLookup = new AdaptiveZoningLookupService({
    engine,
    registry,
    config,
    log: structuredLogger,
  });
  const metrics = new ZoningMetrics();
  const bullConnection = redis && config.redisUrl ? createBullConnection(config.redisUrl) : undefined;
  const maintenanceQueue = bullConnection
    ? new Queue(MAINTENANCE_QUEUE, { connection: bullConnection, defaultJobOptions: { attempts: 2, removeOnComplete: 250, removeOnFail: 500 } })
    : undefined;

  return {
    config,
    engine,
    geocoder,
    registry,
    registryCache,
    resultCache: new SingleFlightResultCache(registryCache),
    sql,
    database,
    redis,
    bullConnection,
    maintenanceQueue,
    adaptiveLookup: (input) => adaptiveLookup.lookup(input),
    metrics,
    resolveJurisdiction: jurisdictionResolver,
    async close() {
      await maintenanceQueue?.close();
      await redis?.quit();
      await database?.close();
      sqliteStore?.close();
    },
  };
}
