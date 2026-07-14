import { z } from 'zod';
import type { SqlExecutor } from '../registry/postgres-source-registry';
import { buildUrl, fetchJson } from '../utils/http';

const COUNTY_LAYER =
  'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1';
const PLACE_LAYER =
  'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer/4';

const GeometrySchema = z.object({
  type: z.enum(['Polygon', 'MultiPolygon']),
  coordinates: z.unknown(),
});

const FeatureSchema = z.object({
  type: z.literal('Feature'),
  properties: z.record(z.string(), z.unknown()),
  geometry: GeometrySchema,
});

const FeatureCollectionSchema = z.object({
  type: z.literal('FeatureCollection'),
  features: z.array(FeatureSchema),
});

export interface JurisdictionImportResult {
  states: string[];
  counties: number;
  municipalities: number;
}

const STATE_CONFIG = {
  NC: { fips: '37', name: 'North Carolina' },
  SC: { fips: '45', name: 'South Carolina' },
} as const;

type SupportedState = keyof typeof STATE_CONFIG;

function propertyString(properties: Record<string, unknown>, names: readonly string[]): string | null {
  for (const name of names) {
    const entry = Object.entries(properties).find(([key]) => key.toLowerCase() === name.toLowerCase());
    const value = entry?.[1];
    if ((typeof value === 'string' || typeof value === 'number') && String(value).trim()) return String(value).trim();
  }
  return null;
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/\b(city|town|village|county)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}

function keyToken(name: string): string {
  return normalizeName(name).replace(/[^a-z0-9]/g, '') || '_';
}

async function queryGeoJson(
  layerUrl: string,
  stateFips: string,
  outFields: string,
  signal?: AbortSignal,
): Promise<z.infer<typeof FeatureCollectionSchema>> {
  const url = buildUrl(`${layerUrl}/query`, {
    where: `STATE='${stateFips}'`,
    outFields,
    returnGeometry: true,
    outSR: 4326,
    spatialRel: 'esriSpatialRelIntersects',
    f: 'geojson',
  });
  return FeatureCollectionSchema.parse(await fetchJson(url, { signal, timeoutMs: 30_000, maxBytes: 48 * 1024 * 1024 }));
}

async function upsertCounty(
  sql: SqlExecutor,
  state: SupportedState,
  feature: z.infer<typeof FeatureSchema>,
): Promise<boolean> {
  const name = propertyString(feature.properties, ['BASENAME', 'NAME']);
  const countyFips = propertyString(feature.properties, ['COUNTY']);
  if (!name || !countyFips) return false;
  const countyName = /county$/i.test(name) ? name : `${name} County`;
  const id = `us:${state.toLowerCase()}:c:${keyToken(countyName)}:county`;
  await sql.query(
    `insert into public.zoning_jurisdictions (
       id, name, normalized_name, state, state_fips, county_name, county_fips,
       jurisdiction_type, boundary_geometry, boundary_source_url, zoning_status,
       routing_priority, active
     ) values (
       $1,$2,$3,$4,$5,$2,$6,'county',
       st_multi(st_collectionextract(st_makevalid(st_setsrid(st_geomfromgeojson($7),4326)),3)),
       $8,'unknown',500,true
     )
     on conflict (id) do update set
       name = excluded.name,
       normalized_name = excluded.normalized_name,
       county_name = excluded.county_name,
       county_fips = excluded.county_fips,
       boundary_geometry = excluded.boundary_geometry,
       boundary_source_url = excluded.boundary_source_url,
       active = true`,
    [
      id,
      countyName,
      normalizeName(countyName),
      state,
      STATE_CONFIG[state].fips,
      countyFips.padStart(3, '0'),
      JSON.stringify(feature.geometry),
      COUNTY_LAYER,
    ],
  );
  return true;
}

async function upsertMunicipality(
  sql: SqlExecutor,
  state: SupportedState,
  feature: z.infer<typeof FeatureSchema>,
): Promise<boolean> {
  const name = propertyString(feature.properties, ['BASENAME', 'NAME']);
  const placeFips = propertyString(feature.properties, ['PLACE']);
  if (!name || !placeFips) return false;
  const cleanName = name.replace(/\s+(city|town|village|borough)$/i, '').trim();
  const id = `us:${state.toLowerCase()}:m:${keyToken(cleanName)}:municipal`;
  await sql.query(
    `insert into public.zoning_jurisdictions (
       id, name, normalized_name, state, state_fips, place_fips,
       jurisdiction_type, boundary_geometry, boundary_source_url, zoning_status,
       routing_priority, active
     ) values (
       $1,$2,$3,$4,$5,$6,'municipality',
       st_multi(st_collectionextract(st_makevalid(st_setsrid(st_geomfromgeojson($7),4326)),3)),
       $8,'unknown',300,true
     )
     on conflict (id) do update set
       name = excluded.name,
       normalized_name = excluded.normalized_name,
       place_fips = excluded.place_fips,
       boundary_geometry = excluded.boundary_geometry,
       boundary_source_url = excluded.boundary_source_url,
       active = true`,
    [
      id,
      cleanName,
      normalizeName(cleanName),
      state,
      STATE_CONFIG[state].fips,
      placeFips.padStart(5, '0'),
      JSON.stringify(feature.geometry),
      PLACE_LAYER,
    ],
  );
  return true;
}

async function attachMunicipalitiesToCounties(sql: SqlExecutor, state: SupportedState): Promise<void> {
  await sql.query(
    `with ranked as (
       select
         municipality.id as municipality_id,
         county.id as county_id,
         county.name as county_name,
         county.county_fips,
         row_number() over (
           partition by municipality.id
           order by st_area(st_intersection(county.boundary_geometry, municipality.boundary_geometry)::geography) desc
         ) as rank
       from public.zoning_jurisdictions municipality
       join public.zoning_jurisdictions county
         on county.state = municipality.state
        and county.jurisdiction_type = 'county'
        and st_intersects(county.boundary_geometry, municipality.boundary_geometry)
       where municipality.state = $1
         and municipality.jurisdiction_type = 'municipality'
         and municipality.boundary_geometry is not null
     )
     update public.zoning_jurisdictions municipality
        set county_name = ranked.county_name,
            county_fips = ranked.county_fips,
            parent_jurisdiction_id = ranked.county_id
       from ranked
      where ranked.rank = 1
        and municipality.id = ranked.municipality_id`,
    [state],
  );
}

/** Import current Census county and incorporated-place boundaries into PostGIS. */
export async function importNcScJurisdictions(
  sql: SqlExecutor,
  states: readonly SupportedState[] = ['NC', 'SC'],
  signal?: AbortSignal,
): Promise<JurisdictionImportResult> {
  let counties = 0;
  let municipalities = 0;
  for (const state of states) {
    const config = STATE_CONFIG[state];
    const [countyFeatures, placeFeatures] = await Promise.all([
      queryGeoJson(COUNTY_LAYER, config.fips, 'STATE,COUNTY,BASENAME,NAME,GEOID', signal),
      queryGeoJson(PLACE_LAYER, config.fips, 'STATE,PLACE,BASENAME,NAME,GEOID', signal),
    ]);
    for (const feature of countyFeatures.features) if (await upsertCounty(sql, state, feature)) counties += 1;
    for (const feature of placeFeatures.features) if (await upsertMunicipality(sql, state, feature)) municipalities += 1;
    await attachMunicipalitiesToCounties(sql, state);
  }
  return { states: [...states], counties, municipalities };
}
