import { createHash } from 'node:crypto';
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { GeocodedAddress, UniversalZoningResult } from '../../src/services/zoning/types';
import { getLayerMetadata, queryLayerWhere } from '../../src/services/zoning/arcgis';
import { CACHE_TTL } from '../../src/services/zoning/registry/source-registry.repository';
import { jurisdictionKey } from '../../src/services/zoning/registry';
import { OPENAPI_DOCUMENT } from './openapi';
import type { ZoningRuntime } from './runtime';

const AddressSchema = z.object({ address: z.string().trim().min(5).max(400), forceRefresh: z.boolean().optional() });
const JurisdictionSchema = z.object({
  address: z.string().trim().min(5).max(400).optional(),
  latitude: z.number().gte(30).lte(38).optional(),
  longitude: z.number().gte(-85).lte(-75).optional(),
}).refine((value) => !!value.address || (value.latitude !== undefined && value.longitude !== undefined), {
  message: 'Provide an address or latitude/longitude',
});
const ZoningRequestSchema = z.object({
  address: z.string().trim().min(5).max(400),
  parcelId: z.string().trim().max(120).optional(),
  includeParcel: z.boolean().default(true),
  includeOverlays: z.boolean().default(true),
  includeGeometry: z.boolean().default(false),
  includeSourceEvidence: z.boolean().default(true),
  forceRefresh: z.boolean().default(false),
  mode: z.enum(['fast', 'verified', 'deep']).default('verified'),
});
const ParcelRequestSchema = z.object({
  address: z.string().trim().min(5).max(400),
  parcelId: z.string().trim().max(120).optional(),
  includeGeometry: z.boolean().default(false),
});
const SourceIdSchema = z.string().uuid();
const AdminUpdateSchema = z.object({
  validationStatus: z.enum(['candidate', 'manual_review', 'likely', 'high_confidence', 'verified', 'degraded', 'disabled', 'rejected']).optional(),
  active: z.boolean().optional(),
  zoningCodeField: z.string().trim().max(160).nullable().optional(),
  zoningDescriptionField: z.string().trim().max(160).nullable().optional(),
  classification: z.enum(['verified_current_zoning', 'likely_current_zoning', 'possible_zoning', 'future_land_use', 'non_zoning', 'rejected', 'manual_review', 'overlay', 'parcel']).optional(),
}).refine((value) => Object.values(value).some((entry) => entry !== undefined), { message: 'No update supplied' });
const HttpsUrl = z.string().url().refine((value) => new URL(value).protocol === 'https:', 'Official GIS URLs must use HTTPS');
const AdminSourceCreateSchema = z.object({
  jurisdictionId: z.string().min(3).max(180),
  datasetType: z.enum(['zoning', 'parcels', 'overlays']),
  sourceType: z.enum(['arcgis-mapserver', 'arcgis-featureserver']),
  sourceName: z.string().trim().min(2).max(240),
  publisher: z.string().trim().min(2).max(240),
  officialDomain: z.string().trim().min(3).max(240),
  viewerUrl: HttpsUrl.optional(),
  serviceUrl: HttpsUrl,
  layerUrl: HttpsUrl,
  layerId: z.union([z.string().trim().min(1).max(30), z.number().int().nonnegative()]),
  zoningCodeField: z.string().trim().max(160).nullable().optional(),
  zoningDescriptionField: z.string().trim().max(160).nullable().optional(),
});
const JurisdictionUpdateSchema = z.object({
  zoningStatus: z.enum(['adopted', 'partial', 'no_zoning', 'unknown', 'manual_review']),
});
const DiscoveryJobSchema = z.object({
  jurisdictionId: z.string().min(3),
  state: z.enum(['NC', 'SC']),
  county: z.string().min(2),
  municipality: z.string().optional(),
  datasetType: z.literal('zoning').default('zoning'),
});

function jsonHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function stateFips(stateCode: string | undefined): string | null {
  return stateCode === 'NC' ? '37' : stateCode === 'SC' ? '45' : null;
}

function geographyCode(address: GeocodedAddress, layerPattern: RegExp, field: string): string | null {
  const raw = address.raw as { geographies?: Record<string, Array<Record<string, unknown>>> } | null;
  for (const [layer, rows] of Object.entries(raw?.geographies ?? {})) {
    if (!layerPattern.test(layer)) continue;
    const value = rows[0]?.[field];
    if (typeof value === 'string' || typeof value === 'number') return String(value).padStart(field === 'COUNTY' ? 3 : 2, '0');
  }
  return null;
}

function assertSupportedGeocode(address: GeocodedAddress): void {
  if (!address.stateCode || !['NC', 'SC'].includes(address.stateCode.toUpperCase())) {
    throw new ApiError(422, 'Address must resolve inside North Carolina or South Carolina');
  }
  if (address.partialMatch || ['locality', 'approximate', 'unknown'].includes(address.locationType ?? 'unknown')) {
    throw new ApiError(422, `Address precision is too low (${address.locationType ?? 'unknown'})`);
  }
}

async function geocode(runtime: ZoningRuntime, address: string, forceRefresh = false): Promise<GeocodedAddress> {
  const key = address.trim().toLowerCase();
  if (!forceRefresh) {
    const cached = await runtime.registry.cacheGet<GeocodedAddress>('geocode', key);
    if (cached) {
      assertSupportedGeocode(cached);
      return cached;
    }
  }
  const result = await runtime.geocoder.geocode(address);
  assertSupportedGeocode(result);
  await runtime.registry.cacheSet('geocode', key, result, CACHE_TTL.geocoding);
  return result;
}

function publicGeocode(address: GeocodedAddress) {
  const precisionScore: Record<string, number> = { rooftop: 0.98, parcel: 0.97, interpolated: 0.82 };
  return {
    inputAddress: address.inputAddress,
    normalizedAddress: address.formattedAddress,
    coordinates: { latitude: address.latitude, longitude: address.longitude },
    precision: address.locationType ?? 'unknown',
    state: address.stateCode,
    stateFips: geographyCode(address, /^states?$/i, 'STATE') ?? stateFips(address.stateCode),
    county: address.county,
    countyFips: geographyCode(address, /^count(y|ies)$/i, 'COUNTY'),
    provider: address.provider,
    confidence: precisionScore[address.locationType ?? ''] ?? 0.7,
  };
}

function publicStatus(status: UniversalZoningResult['status']): string {
  if (status === 'manual-review-required') return 'manual_review';
  if (status === 'not-found') return 'not_found';
  if (status === 'no-zoning') return 'no_zoning';
  return status;
}

function publicZoningResult(
  result: UniversalZoningResult,
  cached: boolean,
  responseTimeMs: number,
  includeSourceEvidence = true,
) {
  const status = publicStatus(result.status);
  return {
    status,
    reason: status === 'manual_review'
      ? 'No verified current-zoning GIS source returned a district for this controlling jurisdiction.'
      : status === 'not_found'
        ? 'The address did not produce a high-quality NC or SC geocode.'
      : undefined,
    address: {
      input: result.input.address,
      normalized: result.address?.formattedAddress ?? result.input.address,
    },
    coordinates: result.address ? { latitude: result.address.latitude, longitude: result.address.longitude } : null,
    jurisdiction: {
      state: result.jurisdiction.stateCode,
      county: result.jurisdiction.county,
      municipality: result.jurisdiction.municipality,
      insideMunicipalBoundary: result.jurisdiction.incorporated,
      zoningAuthority: result.source?.agency ?? result.jurisdiction.zoningAuthority,
      authorityType: result.jurisdiction.jurisdictionType,
      evidence: result.jurisdiction.evidence,
    },
    parcel: result.parcel ? {
      parcelId: result.parcel.parcelId,
      situsAddress: result.parcel.situsAddress,
      acreage: result.parcel.acreage,
      matchMethod: result.parcel.matchMethod,
      addressMatched: result.parcel.addressMatched,
      distanceMeters: result.parcel.distanceFromGeocodePointMeters,
      splitZoned: result.zoning.splitZoned,
      geometry: result.parcel.geometry,
    } : null,
    baseZoning: result.zoning.found ? {
      localCode: result.zoning.code,
      localName: result.zoning.description,
      coveragePercent: result.zoning.coveragePercent,
      additionalDistricts: result.zoning.additionalDistricts,
    } : null,
    overlays: result.overlays.map((overlay) => ({ code: overlay.code, name: overlay.name, description: overlay.description })),
    confidence: {
      score: result.confidence.overall,
      level: result.confidence.overall >= 85 ? 'high' : result.confidence.overall >= 65 ? 'medium' : 'low',
      reasons: result.confidence.reasons,
    },
    sources: includeSourceEvidence && result.source ? [{
      publisher: result.source.agency,
      serviceUrl: result.source.serviceUrl,
      layerUrl: result.source.layerUrl,
      retrievedAt: result.source.accessedAt,
      lastSourceValidation: result.source.lastValidatedAt,
      official: result.source.official,
    }] : [],
    warnings: [
      ...result.confidence.warnings,
      'Confirm development rights, active conditions, and interpretations with the controlling zoning authority.',
    ],
    errors: result.errors,
    candidateSources: status === 'manual_review' ? [] : undefined,
    performance: { cached, responseTimeMs },
  };
}

async function logLookup(runtime: ZoningRuntime, result: UniversalZoningResult, elapsedMs: number, cached: boolean): Promise<void> {
  if (!runtime.sql) return;
  const sourceId = result.source?.layerUrl
    ? await runtime.sql.query<{ id: string }>('select id::text from public.zoning_gis_sources where layer_url = $1 and active limit 1', [result.source.layerUrl])
    : { rows: [] };
  await runtime.sql.query(
    `insert into public.zoning_lookup_logs (
       normalized_address, location, jurisdiction_id, parcel_id, source_id,
       zoning_result, confidence, response_time_ms, cache_status, error_status
     ) values (
       $1,
       case when $2::double precision is null then null else st_setsrid(st_makepoint($2,$3),4326) end,
       $4,$5,$6,$7,$8,$9,$10,$11
     )`,
    [
      result.address?.formattedAddress ?? result.input.address,
      result.address?.longitude ?? null,
      result.address?.latitude ?? null,
      jurisdictionKey({
        country: 'US',
        stateCode: result.jurisdiction.stateCode,
        county: result.jurisdiction.county,
        municipality: result.jurisdiction.municipality,
        jurisdictionType: result.jurisdiction.jurisdictionType,
      }),
      result.parcel?.parcelId ?? null,
      sourceId.rows[0]?.id ?? null,
      JSON.stringify({ status: result.status, code: result.zoning.code, splitZoned: result.zoning.splitZoned }),
      result.confidence.overall,
      elapsedMs,
      cached ? 'hit' : 'miss',
      result.errors[0]?.stage ?? null,
    ],
  );
}

class ApiError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

async function requireAdmin(runtime: ZoningRuntime, request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!runtime.config.adminApiKey && runtime.config.nodeEnv !== 'production') return;
  const supplied = request.headers['x-admin-key'];
  if (!runtime.config.adminApiKey || supplied !== runtime.config.adminApiKey) {
    await reply.code(401).send({ error: 'Administrative credentials required' });
  }
}

export async function buildZoningApi(runtime: ZoningRuntime): Promise<FastifyInstance> {
  const app = Fastify({ logger: true, trustProxy: true, bodyLimit: 256 * 1024, requestTimeout: 10_000 });
  await app.register(cors, {
    origin: runtime.config.nodeEnv === 'production' ? runtime.config.corsOrigins : true,
    methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-admin-key'],
  });
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'no-store, max-age=0');
    reply.header('X-Content-Type-Options', 'nosniff');
    return payload;
  });
  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: 'Invalid request', details: error.issues });
    if (error instanceof ApiError) return reply.code(error.statusCode).send({ error: error.message });
    app.log.error(error);
    const detail = error instanceof Error ? error.message : String(error);
    return reply.code(502).send({ error: 'Official GIS lookup failed', detail: detail.slice(0, 300) });
  });

  app.get('/health', async () => ({ status: 'ok', database: !!runtime.sql, redis: !!runtime.redis }));
  app.get('/documentation/openapi.json', async () => OPENAPI_DOCUMENT);

  app.post('/v1/geocode', async (request) => {
    const body = AddressSchema.parse(request.body);
    return publicGeocode(await geocode(runtime, body.address, body.forceRefresh));
  });

  app.post('/v1/jurisdictions/resolve', async (request) => {
    const body = JurisdictionSchema.parse(request.body);
    const address = body.address
      ? await geocode(runtime, body.address)
      : await runtime.geocoder.reverseGeocode(body.latitude as number, body.longitude as number);
    assertSupportedGeocode(address);
    const jurisdiction = await runtime.resolveJurisdiction(address);
    return {
      state: jurisdiction.stateCode,
      county: jurisdiction.county,
      municipality: jurisdiction.municipality,
      insideMunicipalBoundary: jurisdiction.incorporated,
      insideETJ: jurisdiction.jurisdictionType === 'extraterritorial',
      zoningAuthority: {
        name: jurisdiction.zoningAuthority,
        type: jurisdiction.jurisdictionType,
      },
      confidence: jurisdiction.confidence / 100,
      evidence: jurisdiction.evidence,
    };
  });

  app.post('/v1/parcels/lookup', async (request) => {
    const body = ParcelRequestSchema.parse(request.body);
    const result = await runtime.engine.lookup({
      address: body.address,
      parcelId: body.parcelId,
      includeParcel: true,
      includeGeometry: body.includeGeometry,
      includeOverlays: false,
      discoverSources: false,
      allowThirdParty: false,
      mode: 'verified',
    });
    return {
      status: publicStatus(result.status),
      address: result.address?.formattedAddress ?? body.address,
      jurisdiction: result.jurisdiction,
      parcel: result.parcel,
      sources: result.parcel ? [{ layerUrl: result.parcel.sourceUrl, official: true }] : [],
      warnings: result.parcel ? [] : ['No official parcel polygon was returned for this address.'],
      errors: result.errors.filter((error) => error.stage === 'parcel-query'),
    };
  });

  app.post('/v1/zoning/lookup', async (request) => {
    const body = ZoningRequestSchema.parse(request.body);
    const startedAt = Date.now();
    const cacheKey = `zoning:${jsonHash({ ...body, forceRefresh: false })}`;
    if (!body.forceRefresh) {
      const cached = await runtime.resultCache.get<UniversalZoningResult>(cacheKey);
      if (cached) {
        const elapsed = Date.now() - startedAt;
        await logLookup(runtime, cached, elapsed, true).catch((error) => app.log.warn({ error }, 'lookup logging failed'));
        return publicZoningResult(cached, true, elapsed, body.includeSourceEvidence);
      }
    }
    const result = await runtime.resultCache.run(cacheKey, () => runtime.engine.lookup({
      address: body.address,
      parcelId: body.parcelId,
      includeParcel: body.includeParcel,
      includeOverlays: body.includeOverlays,
      includeGeometry: body.includeGeometry,
      forceRefresh: body.forceRefresh,
      mode: body.mode,
      discoverSources: false,
      allowThirdParty: false,
    }));
    const ttl = result.status === 'verified' || result.status === 'verified-with-warnings'
      ? 24 * 60 * 60 * 1000
      : result.status === 'manual-review-required' || result.status === 'not-found'
        ? 30 * 60 * 1000
        : 15 * 60 * 1000;
    await runtime.resultCache.set(cacheKey, result, ttl);
    const elapsed = Date.now() - startedAt;
    await logLookup(runtime, result, elapsed, false).catch((error) => app.log.warn({ error }, 'lookup logging failed'));
    return publicZoningResult(result, false, elapsed, body.includeSourceEvidence);
  });

  app.get('/v1/admin/sources', { preHandler: (request, reply) => requireAdmin(runtime, request, reply) }, async () => {
    if (!runtime.sql) throw new ApiError(503, 'PostgreSQL is not configured');
    const result = await runtime.sql.query(
      `select s.id, s.jurisdiction_id, j.name as jurisdiction_name, j.state,
              s.dataset_type, s.source_type, s.source_name, s.publisher,
              s.viewer_url, s.service_url, s.layer_url, s.layer_id,
              s.zoning_code_field, s.zoning_description_field, s.classification,
              s.validation_status, s.last_checked_at, s.last_success_at,
              s.response_time_ms, s.failure_count, s.active
         from public.zoning_gis_sources s
         join public.zoning_jurisdictions j on j.id = s.jurisdiction_id
        order by j.state, j.name, s.dataset_type, s.source_name`,
    );
    return { sources: result.rows };
  });

  app.post('/v1/admin/sources', { preHandler: (request, reply) => requireAdmin(runtime, request, reply) }, async (request, reply) => {
    if (!runtime.sql) throw new ApiError(503, 'PostgreSQL is not configured');
    const body = AdminSourceCreateSchema.parse(request.body);
    const result = await runtime.sql.query(
      `insert into public.zoning_gis_sources (
         jurisdiction_id, dataset_type, source_type, source_name, publisher,
         official_domain, viewer_url, service_url, layer_url, layer_id,
         geometry_type, supports_query, zoning_code_field,
         zoning_description_field, official_source, confidence_score,
         validation_status, classification, metadata, active
       ) values (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
         'esriGeometryPolygon',true,$11,$12,true,0,
         'candidate','manual_review','{}'::jsonb,true
       )
       returning id, jurisdiction_id, dataset_type, source_name, validation_status, created_at`,
      [
        body.jurisdictionId, body.datasetType, body.sourceType, body.sourceName,
        body.publisher, body.officialDomain, body.viewerUrl ?? null,
        body.serviceUrl, body.layerUrl, String(body.layerId),
        body.zoningCodeField ?? null, body.zoningDescriptionField ?? null,
      ],
    );
    return reply.code(201).send(result.rows[0]);
  });

  app.get('/v1/admin/coverage', { preHandler: (request, reply) => requireAdmin(runtime, request, reply) }, async () => {
    if (!runtime.sql) throw new ApiError(503, 'PostgreSQL is not configured');
    const result = await runtime.sql.query(
      `select j.state, j.zoning_status, count(*)::integer as jurisdictions,
              count(*) filter (where exists (
                select 1 from public.zoning_gis_sources s
                 where s.jurisdiction_id = j.id and s.dataset_type = 'zoning'
                   and s.active and s.validation_status in ('verified','high_confidence')
              ))::integer as configured
         from public.zoning_jurisdictions j
        where j.active
        group by j.state, j.zoning_status
        order by j.state, j.zoning_status`,
    );
    return { coverage: result.rows };
  });

  app.get('/v1/admin/sources/:id/versions', { preHandler: (request, reply) => requireAdmin(runtime, request, reply) }, async (request) => {
    if (!runtime.sql) throw new ApiError(503, 'PostgreSQL is not configured');
    const id = SourceIdSchema.parse((request.params as { id?: unknown }).id);
    const result = await runtime.sql.query(
      'select version_number, snapshot, change_reason, created_at from public.zoning_gis_source_versions where source_id = $1 order by version_number desc',
      [id],
    );
    return { versions: result.rows };
  });

  app.get('/v1/admin/sources/:id/inspect', { preHandler: (request, reply) => requireAdmin(runtime, request, reply) }, async (request) => {
    if (!runtime.sql) throw new ApiError(503, 'PostgreSQL is not configured');
    const id = SourceIdSchema.parse((request.params as { id?: unknown }).id);
    const row = await runtime.sql.query<{
      service_url: string;
      layer_url: string;
      layer_id: string;
    }>('select service_url, layer_url, layer_id from public.zoning_gis_sources where id = $1', [id]);
    const source = row.rows[0];
    if (!source) throw new ApiError(404, 'Source not found');
    const layerId = /^\d+$/.test(source.layer_id) ? Number(source.layer_id) : source.layer_id;
    const [metadata, sample] = await Promise.all([
      getLayerMetadata(source.service_url, layerId, { timeoutMs: 8_000 }),
      queryLayerWhere(source.layer_url, layerId, { outFields: '*', returnGeometry: false, resultRecordCount: 3, timeoutMs: 8_000 }),
    ]);
    return { metadata, sample: sample.features ?? [] };
  });

  app.patch('/v1/admin/sources/:id', { preHandler: (request, reply) => requireAdmin(runtime, request, reply) }, async (request) => {
    if (!runtime.sql) throw new ApiError(503, 'PostgreSQL is not configured');
    const id = SourceIdSchema.parse((request.params as { id?: unknown }).id);
    const body = AdminUpdateSchema.parse(request.body);
    const result = await runtime.sql.query(
      `update public.zoning_gis_sources
          set validation_status = coalesce($2, validation_status),
              active = coalesce($3, active),
              zoning_code_field = coalesce($4, zoning_code_field),
              zoning_description_field = coalesce($5, zoning_description_field),
              classification = coalesce($6, classification)
        where id = $1
        returning id, validation_status, active, updated_at`,
      [
        id, body.validationStatus ?? null, body.active ?? null,
        body.zoningCodeField ?? null, body.zoningDescriptionField ?? null,
        body.classification ?? null,
      ],
    );
    if (!result.rows[0]) throw new ApiError(404, 'Source not found');
    return result.rows[0];
  });

  app.patch('/v1/admin/jurisdictions/:id', { preHandler: (request, reply) => requireAdmin(runtime, request, reply) }, async (request) => {
    if (!runtime.sql) throw new ApiError(503, 'PostgreSQL is not configured');
    const id = z.string().min(3).max(180).parse((request.params as { id?: unknown }).id);
    const body = JurisdictionUpdateSchema.parse(request.body);
    const result = await runtime.sql.query(
      'update public.zoning_jurisdictions set zoning_status = $2 where id = $1 returning id, zoning_status, updated_at',
      [id, body.zoningStatus],
    );
    if (!result.rows[0]) throw new ApiError(404, 'Jurisdiction not found');
    return result.rows[0];
  });

  app.post('/v1/admin/sources/:id/validate', { preHandler: (request, reply) => requireAdmin(runtime, request, reply) }, async (request) => {
    if (!runtime.maintenanceQueue) throw new ApiError(503, 'Redis/BullMQ is not configured');
    const id = SourceIdSchema.parse((request.params as { id?: unknown }).id);
    const job = await runtime.maintenanceQueue.add('validate-source', { sourceId: id });
    return { queued: true, jobId: job.id };
  });

  app.post('/v1/admin/discovery', { preHandler: (request, reply) => requireAdmin(runtime, request, reply) }, async (request) => {
    if (!runtime.maintenanceQueue) throw new ApiError(503, 'Redis/BullMQ is not configured');
    const body = DiscoveryJobSchema.parse(request.body);
    const job = await runtime.maintenanceQueue.add('discover-source', body);
    return { queued: true, jobId: job.id };
  });

  app.post('/v1/admin/health/run', { preHandler: (request, reply) => requireAdmin(runtime, request, reply) }, async () => {
    if (!runtime.maintenanceQueue) throw new ApiError(503, 'Redis/BullMQ is not configured');
    const job = await runtime.maintenanceQueue.add('health-scan', {});
    return { queued: true, jobId: job.id };
  });

  return app;
}
