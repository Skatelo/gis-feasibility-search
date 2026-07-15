import type {
  BoundaryLayerConfig,
  FieldMapping,
  JurisdictionSourceRecord,
  ParcelLayerConfig,
  SourceRegistry,
  ZoningLayerConfig,
} from '../types';
import { ENGINE_SCHEMA_VERSION } from '../types';

export interface SqlResult<Row> {
  rows: Row[];
}

export interface SqlExecutor {
  query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<SqlResult<Row>>;
}

export interface RegistryCache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
  delete?(key: string): Promise<void>;
}

interface SourceRow {
  jurisdiction_id: string;
  jurisdiction_name: string;
  state: string;
  county_name: string | null;
  jurisdiction_type: string;
  official_domain: string | null;
  zoning_status: string;
  source_id: string | null;
  dataset_type: string | null;
  source_type: string | null;
  source_name: string | null;
  publisher: string | null;
  source_official_domain: string | null;
  service_url: string | null;
  layer_url: string | null;
  layer_id: string | null;
  spatial_reference: number | null;
  zoning_code_field: string | null;
  zoning_name_field: string | null;
  zoning_description_field: string | null;
  parcel_id_field: string | null;
  address_field: string | null;
  validation_status: string | null;
  last_checked_at: string | null;
  last_success_at: string | null;
  metadata: Record<string, unknown> | null;
}

function parseLayerId(value: string | null): string | number {
  if (value !== null && /^\d+$/.test(value)) return Number(value);
  return value ?? '0';
}

function metadataString(metadata: Record<string, unknown> | null, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function metadataNumber(metadata: Record<string, unknown> | null, key: string): number | undefined {
  const value = metadata?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function fieldMapping(row: SourceRow): FieldMapping {
  return {
    zoningCodeField: row.zoning_code_field,
    zoningDescriptionField: row.zoning_description_field ?? row.zoning_name_field,
    jurisdictionField: metadataString(row.metadata, 'jurisdictionField'),
    overlayField: metadataString(row.metadata, 'overlayField'),
    detectionConfidence: metadataNumber(row.metadata, 'fieldMappingConfidence') ?? 1,
    reasons: ['loaded from verified PostgreSQL source registry'],
  };
}

function zoningLayer(row: SourceRow): ZoningLayerConfig | null {
  if (!row.layer_url || row.layer_id === null || !row.source_name) return null;
  return {
    layerUrl: row.layer_url,
    layerId: parseLayerId(row.layer_id),
    layerName: row.source_name,
    role: row.dataset_type === 'overlays' ? 'overlay' : 'zoning',
    fieldMapping: fieldMapping(row),
    spatialReferenceWkid: row.spatial_reference,
  };
}

function parcelLayer(row: SourceRow): ParcelLayerConfig | null {
  if (!row.layer_url || row.layer_id === null) return null;
  return {
    layerUrl: row.layer_url,
    layerId: parseLayerId(row.layer_id),
    parcelIdField: row.parcel_id_field,
    addressField: row.address_field,
    acreageField: metadataString(row.metadata, 'acreageField'),
    sourceType:
      row.source_type === 'arcgis-featureserver' || row.source_type === 'arcgis-mapserver'
        ? row.source_type
        : undefined,
    maxNearestMeters: metadataNumber(row.metadata, 'maxNearestMeters'),
  };
}

function boundaryLayer(row: SourceRow): BoundaryLayerConfig | null {
  if (!row.layer_url || row.layer_id === null) return null;
  return {
    layerUrl: row.layer_url,
    layerId: parseLayerId(row.layer_id),
    nameField: metadataString(row.metadata, 'nameField'),
  };
}

function latestIso(rows: SourceRow[], field: 'last_checked_at' | 'last_success_at'): string | undefined {
  const values = rows.map((row) => row[field]).filter((value): value is string => !!value).sort();
  return values.at(-1);
}

function recordFromRows(rows: SourceRow[]): JurisdictionSourceRecord | null {
  const jurisdiction = rows[0];
  if (!jurisdiction) return null;
  const sourceRows = rows.filter((row) => row.source_id !== null);
  const zoningLayers = sourceRows
    .filter((row) => row.dataset_type === 'zoning' || row.dataset_type === 'overlays')
    .map(zoningLayer)
    .filter((value): value is ZoningLayerConfig => value !== null);
  const parcelLayers = sourceRows
    .filter((row) => row.dataset_type === 'parcels')
    .map(parcelLayer)
    .filter((value): value is ParcelLayerConfig => value !== null);
  const boundaryLayers = sourceRows
    .filter((row) => ['municipal_boundaries', 'county_boundaries', 'etj_boundaries', 'planning_boundaries'].includes(row.dataset_type ?? ''))
    .map(boundaryLayer)
    .filter((value): value is BoundaryLayerConfig => value !== null);
  const primary = sourceRows.find((row) => row.dataset_type === 'zoning') ?? sourceRows[0];
  const hasBroken = sourceRows.some((row) => row.validation_status === 'degraded');
  const verified = sourceRows.some((row) => ['verified', 'high_confidence'].includes(row.validation_status ?? ''));
  return {
    id: jurisdiction.jurisdiction_id,
    country: 'US',
    stateCode: jurisdiction.state,
    countyName: jurisdiction.county_name ?? undefined,
    municipalityName: jurisdiction.jurisdiction_type === 'municipality' ? jurisdiction.jurisdiction_name : undefined,
    jurisdictionType: jurisdiction.jurisdiction_type,
    agencyName: primary?.publisher ?? jurisdiction.jurisdiction_name,
    officialDomain: primary?.source_official_domain ?? jurisdiction.official_domain ?? '',
    sourceType: primary?.source_type ?? 'unknown',
    serviceUrl: primary?.service_url ?? '',
    zoningLayers,
    parcelLayers,
    boundaryLayers,
    lastVerifiedAt: latestIso(sourceRows, 'last_checked_at') ?? new Date(0).toISOString(),
    lastSuccessfulQueryAt: latestIso(sourceRows, 'last_success_at'),
    healthStatus: hasBroken ? 'degraded' : verified ? 'healthy' : 'unverified',
    schemaVersion: ENGINE_SCHEMA_VERSION,
  };
}

function layerServiceUrl(layerUrl: string): string {
  return layerUrl.replace(/\/\d+\/?$/, '');
}

/**
 * PostgreSQL-backed verified-source registry. It intentionally performs no
 * discovery: a missing row is a normal, fast registry miss.
 */
export class PostgresSourceRegistry implements SourceRegistry {
  private readonly sql: SqlExecutor;
  private readonly cache?: RegistryCache;

  constructor(sql: SqlExecutor, cache?: RegistryCache) {
    this.sql = sql;
    this.cache = cache;
  }

  async get(key: string): Promise<JurisdictionSourceRecord | null> {
    const cacheKey = `source:${key}:zoning`;
    const cached = await this.cache?.get<JurisdictionSourceRecord>(cacheKey);
    if (cached) return cached;
    const result = await this.sql.query<SourceRow>(
      `select
         j.id as jurisdiction_id,
         j.name as jurisdiction_name,
         j.state,
         j.county_name,
         j.jurisdiction_type,
         j.official_domain,
         j.zoning_status,
         s.id::text as source_id,
         s.dataset_type,
         s.source_type,
         s.source_name,
         s.publisher,
         s.official_domain as source_official_domain,
         s.service_url,
         s.layer_url,
         s.layer_id,
         s.spatial_reference,
         s.zoning_code_field,
         s.zoning_name_field,
         s.zoning_description_field,
         s.parcel_id_field,
         s.address_field,
         s.validation_status,
         s.last_checked_at::text,
         s.last_success_at::text,
         s.metadata
       from public.zoning_jurisdictions j
       left join public.zoning_gis_sources s
         on s.jurisdiction_id = j.id
        and s.active
        and s.official_source
        and s.validation_status in ('verified', 'high_confidence', 'degraded')
       where j.id = $1 and j.active
       order by
         case s.dataset_type when 'zoning' then 1 when 'overlays' then 2 when 'parcels' then 3 else 4 end,
         s.source_name`,
      [key],
    );
    const record = recordFromRows(result.rows);
    if (record) await this.cache?.set(cacheKey, record, 24 * 60 * 60 * 1000);
    return record;
  }

  async put(record: JurisdictionSourceRecord): Promise<void> {
    const normalizedName = (record.municipalityName ?? record.countyName ?? record.agencyName)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
    await this.sql.query(
      `insert into public.zoning_jurisdictions (
         id, name, normalized_name, state, state_fips, county_name,
         jurisdiction_type, official_domain, zoning_status, active
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,true)
       on conflict (id) do update set
         name = excluded.name,
         normalized_name = excluded.normalized_name,
         official_domain = excluded.official_domain,
         zoning_status = excluded.zoning_status,
         active = true`,
      [
        record.id,
        record.municipalityName ?? record.countyName ?? record.agencyName,
        normalizedName,
        record.stateCode,
        record.stateCode === 'NC' ? '37' : '45',
        record.countyName ?? null,
        record.jurisdictionType === 'municipal' ? 'municipality' : record.jurisdictionType,
        record.officialDomain,
        record.zoningLayers.length > 0 ? 'adopted' : 'manual_review',
      ],
    );

    for (const zoning of record.zoningLayers) {
      const datasetType = zoning.role === 'overlay' ? 'overlays' : 'zoning';
      await this.sql.query(
        `insert into public.zoning_gis_sources (
           jurisdiction_id, dataset_type, source_type, source_name, publisher,
           official_domain, service_url, layer_url, layer_id, geometry_type,
           spatial_reference, supports_query, zoning_code_field,
           zoning_description_field, official_source, confidence_score,
           validation_status, classification, last_checked_at, last_success_at,
           metadata, active
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'esriGeometryPolygon',$10,true,$11,$12,true,95,'verified',$13,$14,$15,$16,true)
         on conflict (jurisdiction_id, dataset_type, layer_url) do update set
           source_name = excluded.source_name,
           publisher = excluded.publisher,
           zoning_code_field = excluded.zoning_code_field,
           zoning_description_field = excluded.zoning_description_field,
           spatial_reference = excluded.spatial_reference,
           validation_status = excluded.validation_status,
           classification = excluded.classification,
           last_checked_at = excluded.last_checked_at,
           last_success_at = excluded.last_success_at,
           metadata = excluded.metadata,
           active = true`,
        [
          record.id,
          datasetType,
          record.sourceType,
          zoning.layerName,
          record.agencyName,
          record.officialDomain,
          layerServiceUrl(zoning.layerUrl),
          zoning.layerUrl,
          String(zoning.layerId),
          zoning.spatialReferenceWkid,
          zoning.fieldMapping.zoningCodeField,
          zoning.fieldMapping.zoningDescriptionField,
          zoning.role === 'overlay' ? 'overlay' : 'verified_current_zoning',
          record.lastVerifiedAt,
          record.lastSuccessfulQueryAt ?? null,
          JSON.stringify({
            overlayField: zoning.fieldMapping.overlayField,
            jurisdictionField: zoning.fieldMapping.jurisdictionField,
            fieldMappingConfidence: zoning.fieldMapping.detectionConfidence,
          }),
        ],
      );
    }

    for (const parcel of record.parcelLayers) {
      await this.sql.query(
        `insert into public.zoning_gis_sources (
           jurisdiction_id, dataset_type, source_type, source_name, publisher,
           official_domain, service_url, layer_url, layer_id, geometry_type,
           supports_query, parcel_id_field, address_field, official_source,
           confidence_score, validation_status, classification, last_checked_at,
           last_success_at, metadata, active
         ) values ($1,'parcels',$2,'Official parcels',$3,$4,$5,$6,$7,'esriGeometryPolygon',true,$8,$9,true,95,'verified','parcel',$10,$11,$12,true)
         on conflict (jurisdiction_id, dataset_type, layer_url) do update set
           parcel_id_field = excluded.parcel_id_field,
           address_field = excluded.address_field,
           last_checked_at = excluded.last_checked_at,
           last_success_at = excluded.last_success_at,
           metadata = excluded.metadata,
           active = true`,
        [
          record.id,
          parcel.sourceType ?? 'arcgis-mapserver',
          record.agencyName,
          new URL(parcel.layerUrl).hostname,
          layerServiceUrl(parcel.layerUrl),
          parcel.layerUrl,
          String(parcel.layerId),
          parcel.parcelIdField,
          parcel.addressField,
          record.lastVerifiedAt,
          record.lastSuccessfulQueryAt ?? null,
          JSON.stringify({ acreageField: parcel.acreageField, maxNearestMeters: parcel.maxNearestMeters }),
        ],
      );
    }
    await this.cache?.delete?.(`source:${record.id}:zoning`);
  }

  async delete(key: string): Promise<void> {
    await this.sql.query('update public.zoning_jurisdictions set active = false where id = $1', [key]);
    await this.cache?.delete?.(`source:${key}:zoning`);
  }

  async cacheGet<T>(namespace: string, key: string): Promise<T | null> {
    return (await this.cache?.get<T>(`${namespace}:${key}`)) ?? null;
  }

  async cacheSet<T>(namespace: string, key: string, value: T, ttlMs: number): Promise<void> {
    await this.cache?.set(`${namespace}:${key}`, value, ttlMs);
  }
}
