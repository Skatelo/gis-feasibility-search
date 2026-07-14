import { Worker, type Job } from 'bullmq';
import { arcgisToGeoJSON } from '@terraformer/arcgis';
import type { MultiPolygon, Polygon } from 'geojson';
import { getLayerMetadata, queryLayerAtPoint, queryLayerWhere } from '../../src/services/zoning/arcgis';
import { selectAdapter } from '../../src/services/zoning/adapters';
import { SourceDiscoveryService, httpPageFetcher, perplexitySearchProvider } from '../../src/services/zoning/discovery';
import { metadataHash } from '../../src/services/zoning/registry';
import { parcelInteriorPoint } from '../../src/services/zoning/parcel';
import { fetchJson } from '../../src/services/zoning/utils/http';
import type { JurisdictionResult, Logger } from '../../src/services/zoning/types';
import { readZoningServerConfig } from './config';
import { createZoningRuntime, MAINTENANCE_QUEUE, type ZoningRuntime } from './runtime';
import { inspectDynamicViewer } from './browser-discovery';
import { crawlSources } from '../../netlify/functions/lib/crawlee-scraper.js';

interface SourceRow {
  id: string;
  jurisdiction_id: string;
  dataset_type: string;
  source_type: string;
  source_name: string;
  publisher: string;
  official_domain: string;
  service_url: string;
  layer_url: string;
  layer_id: string;
  zoning_code_field: string | null;
  schema_hash: string | null;
}

interface DiscoveryData {
  jurisdictionId: string;
  state: 'NC' | 'SC';
  county: string;
  municipality?: string;
  datasetType: 'zoning';
}

const log: Logger = {
  debug(message, metadata) { console.debug(JSON.stringify({ level: 'debug', message, ...metadata })); },
  info(message, metadata) { console.info(JSON.stringify({ level: 'info', message, ...metadata })); },
  warn(message, metadata) { console.warn(JSON.stringify({ level: 'warn', message, ...metadata })); },
  error(message, metadata) { console.error(JSON.stringify({ level: 'error', message, ...metadata })); },
};

function asPolygon(value: unknown): Polygon | MultiPolygon | null {
  if (!value || typeof value !== 'object') return null;
  const converted = arcgisToGeoJSON({ ...(value as Record<string, unknown>), spatialReference: { wkid: 4326 } });
  return converted.type === 'Polygon' || converted.type === 'MultiPolygon' ? converted : null;
}

async function sourceRow(runtime: ZoningRuntime, sourceId: string): Promise<SourceRow> {
  if (!runtime.sql) throw new Error('PostgreSQL is required');
  const result = await runtime.sql.query<SourceRow>(
    `select id::text, jurisdiction_id, dataset_type, source_type, source_name,
            publisher, official_domain, service_url, layer_url, layer_id,
            zoning_code_field, schema_hash
       from public.zoning_gis_sources where id = $1`,
    [sourceId],
  );
  if (!result.rows[0]) throw new Error(`Source ${sourceId} not found`);
  return result.rows[0];
}

async function persistHealth(
  runtime: ZoningRuntime,
  row: SourceRow,
  input: { status: 'healthy' | 'degraded' | 'broken'; elapsedMs: number; schemaHash?: string; querySuccess: boolean; fieldsPresent: boolean; error?: string },
): Promise<void> {
  if (!runtime.sql) return;
  await runtime.sql.query(
    `insert into public.zoning_gis_health_checks (
       source_id, http_status, response_time_ms, query_success, schema_hash,
       important_fields_present, status, error_message
     ) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [row.id, input.error ? null : 200, input.elapsedMs, input.querySuccess, input.schemaHash ?? null, input.fieldsPresent, input.status, input.error ?? null],
  );
  await runtime.sql.query(
    `update public.zoning_gis_sources
        set validation_status = $2,
            classification = case
              when dataset_type = 'zoning' and $2 = 'verified' then 'verified_current_zoning'
              when dataset_type = 'overlays' then 'overlay'
              when dataset_type = 'parcels' then 'parcel'
              else classification
            end,
            last_checked_at = now(),
            last_success_at = case when $2 = 'verified' then now() else last_success_at end,
            response_time_ms = $3,
            failure_count = case when $2 = 'verified' then 0 else failure_count + 1 end,
            schema_hash = coalesce($4, schema_hash)
      where id = $1`,
    [row.id, input.status === 'healthy' ? 'verified' : input.status, input.elapsedMs, input.schemaHash ?? null],
  );
}

async function validateSource(runtime: ZoningRuntime, sourceId: string) {
  const row = await sourceRow(runtime, sourceId);
  const startedAt = Date.now();
  try {
    const layerId = /^\d+$/.test(row.layer_id) ? Number(row.layer_id) : row.layer_id;
    const metadata = await getLayerMetadata(row.service_url, layerId, { timeoutMs: 8_000 });
    const fields = (metadata.fields ?? []).map((field) => field.name);
    const fieldsPresent = !row.zoning_code_field || fields.some((field) => field.toLowerCase() === row.zoning_code_field?.toLowerCase());
    const polygonLayer = /polygon/i.test(metadata.geometryType ?? '');
    const queryable = /query|data/i.test(metadata.capabilities ?? '') || !metadata.capabilities;
    if (!polygonLayer || !queryable || !fieldsPresent) throw new Error('Layer failed polygon/query/field validation');

    const sample = await queryLayerWhere(row.layer_url, layerId, {
      outFields: '*',
      returnGeometry: true,
      outSR: 4326,
      resultRecordCount: 1,
      timeoutMs: 8_000,
    });
    const sampleFeature = sample.features?.[0];
    const polygon = asPolygon(sampleFeature?.geometry);
    if (!sampleFeature?.attributes || !polygon) throw new Error('Layer returned no polygon sample');
    const interior = parcelInteriorPoint(polygon);
    const pointResult = await queryLayerAtPoint(row.layer_url, layerId, interior.longitude, interior.latitude, {
      outFields: '*',
      returnGeometry: false,
      timeoutMs: 8_000,
    });
    const pointAttributes = pointResult.features?.[0]?.attributes;
    if (!pointAttributes) throw new Error('Real point query returned no feature');
    if (row.dataset_type === 'zoning' && row.zoning_code_field) {
      const code = pointAttributes[row.zoning_code_field];
      if (code === null || code === undefined || String(code).trim() === '') throw new Error('Real point query returned an empty zoning code');
    }
    const schemaHash = metadataHash({ fieldNames: fields, geometryType: metadata.geometryType ?? null, codeField: row.zoning_code_field });
    await persistHealth(runtime, row, { status: 'healthy', elapsedMs: Date.now() - startedAt, schemaHash, querySuccess: true, fieldsPresent });
    return { sourceId, status: 'healthy', schemaHash };
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error).slice(0, 500);
    await persistHealth(runtime, row, { status: 'broken', elapsedMs: Date.now() - startedAt, querySuccess: false, fieldsPresent: false, error: message });
    throw error;
  }
}

async function healthScan(runtime: ZoningRuntime) {
  if (!runtime.sql) throw new Error('PostgreSQL is required');
  const rows = await runtime.sql.query<{ id: string }>(
    `select id::text from public.zoning_gis_sources
      where active and dataset_type in ('zoning','overlays','parcels')
      order by coalesce(last_checked_at, to_timestamp(0)) asc`,
  );
  const results: unknown[] = [];
  for (let index = 0; index < rows.rows.length; index += 4) {
    results.push(...await Promise.allSettled(rows.rows.slice(index, index + 4).map((row) => validateSource(runtime, row.id))));
  }
  return { checked: rows.rows.length, results };
}

async function crawleePage(url: string): Promise<string> {
  const result = await crawlSources({
    urls: [url],
    queries: ['official zoning ArcGIS MapServer FeatureServer'],
    maxPages: 4,
    maxDepth: 1,
    maxCharsPerPage: 20_000,
  });
  const staticEvidence = result.results.map((page) => `${page.content}\n${(page.endpoints ?? []).join('\n')}`).join('\n');
  if (/\/(?:MapServer|FeatureServer)\b/i.test(staticEvidence)) return staticEvidence;
  const dynamicEvidence = await inspectDynamicViewer(url).catch(() => '');
  return `${staticEvidence}\n${dynamicEvidence}`;
}

async function discoverSources(runtime: ZoningRuntime, data: DiscoveryData) {
  if (!runtime.sql) throw new Error('PostgreSQL is required');
  const search = runtime.config.perplexityApiKey
    ? perplexitySearchProvider({
        apiKey: runtime.config.perplexityApiKey,
        endpoint: runtime.config.perplexitySearchEndpoint,
        timeoutMs: 8_000,
      })
    : async () => [];
  const discovery = new SourceDiscoveryService(search, async (url) => {
    const direct = await httpPageFetcher(6_000)(url);
    if (/\/(?:MapServer|FeatureServer)\b/i.test(direct)) return direct;
    return crawleePage(url).catch(() => direct);
  });
  const jurisdiction: JurisdictionResult = {
    state: data.state === 'NC' ? 'North Carolina' : 'South Carolina',
    stateCode: data.state,
    county: /county$/i.test(data.county) ? data.county : `${data.county} County`,
    municipality: data.municipality ?? null,
    incorporated: data.municipality ? true : false,
    zoningAuthority: data.municipality ?? data.county,
    jurisdictionType: data.municipality ? 'municipal' : 'county',
    confidence: 90,
    evidence: [],
  };
  const candidates = await discovery.discover(jurisdiction, { maxCandidatePages: 6, log });
  let layersSaved = 0;
  for (const candidate of candidates.slice(0, 12)) {
    const adapter = selectAdapter(candidate);
    if (!adapter) continue;
    try {
      const inspected = await adapter.inspect(candidate, { fetchJson: (url, signal) => fetchJson(url, { signal }), log });
      for (const layer of inspected.layers.filter((item) => item.role === 'zoning' || item.role === 'overlay')) {
        await runtime.sql.query(
          `insert into public.zoning_gis_sources (
             jurisdiction_id, dataset_type, source_type, source_name, publisher,
             official_domain, service_url, layer_url, layer_id, geometry_type,
             spatial_reference, supports_query, zoning_code_field,
             zoning_description_field, official_source, confidence_score,
             validation_status, classification, metadata
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true,$15,'candidate',$16,$17)
           on conflict (jurisdiction_id, dataset_type, layer_url) do nothing`,
          [
            data.jurisdictionId,
            layer.role === 'overlay' ? 'overlays' : 'zoning',
            inspected.sourceType,
            layer.name,
            candidate.agency ?? jurisdiction.zoningAuthority ?? data.county,
            new URL(candidate.url).hostname,
            inspected.serviceUrl,
            layer.layerUrl,
            String(layer.id),
            layer.geometryType,
            layer.spatialReferenceWkid,
            layer.supportsQuery,
            layer.fieldMapping.zoningCodeField,
            layer.fieldMapping.zoningDescriptionField,
            Math.round(layer.roleConfidence * 100),
            layer.role === 'overlay' ? 'overlay' : 'possible_zoning',
            JSON.stringify({ discoveredFrom: candidate.discoveredFrom, fieldMapping: layer.fieldMapping, reasons: layer.reasons }),
          ],
        );
        layersSaved += 1;
      }
    } catch (error) {
      log.warn('candidate inspection failed', { url: candidate.url, error: String(error) });
    }
  }
  return { candidates: candidates.length, layersSaved };
}

async function processJob(runtime: ZoningRuntime, job: Job) {
  if (job.name === 'validate-source') return validateSource(runtime, String((job.data as { sourceId?: unknown }).sourceId));
  if (job.name === 'health-scan') return healthScan(runtime);
  if (job.name === 'discover-source') return discoverSources(runtime, job.data as DiscoveryData);
  throw new Error(`Unknown maintenance job ${job.name}`);
}

const config = readZoningServerConfig();
if (!config.redisUrl) throw new Error('REDIS_URL is required for the maintenance worker');
const runtime = await createZoningRuntime(config);
if (!runtime.bullConnection) throw new Error('Redis connection is unavailable');
await runtime.maintenanceQueue?.add('health-scan', {}, {
  jobId: 'scheduled-health-scan',
  repeat: { every: 12 * 60 * 60 * 1000 },
  removeOnComplete: 25,
  removeOnFail: 100,
});
const worker = new Worker(MAINTENANCE_QUEUE, (job) => processJob(runtime, job), {
  connection: runtime.bullConnection,
  concurrency: 3,
  lockDuration: 60_000,
});
worker.on('completed', (job) => log.info('maintenance job completed', { jobId: job.id, name: job.name }));
worker.on('failed', (job, error) => log.error('maintenance job failed', { jobId: job?.id, name: job?.name, error: error.message }));

const shutdown = async () => {
  await worker.close();
  await runtime.close();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
