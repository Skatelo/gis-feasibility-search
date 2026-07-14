import type { GeocodedAddress, JurisdictionResult, JurisdictionType } from '../types';
import type { SqlExecutor } from '../registry/postgres-source-registry';

interface RouteRow {
  jurisdiction_id: string;
  jurisdiction_name: string;
  jurisdiction_type: string;
  state: string;
  county_name: string | null;
  municipality_name: string | null;
  zoning_authority_name: string;
  zoning_status: string;
}

function resultType(value: string): JurisdictionType {
  if (value === 'municipality') return 'municipal';
  if (value === 'etj') return 'extraterritorial';
  if (value === 'planning_district' || value === 'regional_authority') return 'joint-planning';
  if (value === 'county') return 'county';
  return 'unknown';
}

/** Resolve the configured zoning authority with PostGIS point-in-polygon data. */
export async function resolveJurisdictionFromPostgis(
  sql: SqlExecutor,
  address: GeocodedAddress,
): Promise<JurisdictionResult | null> {
  const result = await sql.query<RouteRow>(
    `with point as (
       select st_setsrid(st_makepoint($1,$2),4326) as geom
     ), selected as (
       select * from public.resolve_zoning_jurisdiction($1,$2)
     ), municipality as (
       select j.name
         from public.zoning_jurisdictions j, point p
        where j.active
          and j.jurisdiction_type = 'municipality'
          and st_covers(j.boundary_geometry,p.geom)
        order by st_area(j.boundary_geometry::geography)
        limit 1
     ), county as (
       select j.name
         from public.zoning_jurisdictions j, point p
        where j.active
          and j.jurisdiction_type = 'county'
          and st_covers(j.boundary_geometry,p.geom)
        order by st_area(j.boundary_geometry::geography)
        limit 1
     )
     select
       selected.jurisdiction_id,
       selected.jurisdiction_name,
       selected.jurisdiction_type,
       j.state,
       (select name from county) as county_name,
       (select name from municipality) as municipality_name,
       authority.name as zoning_authority_name,
       selected.zoning_status
     from selected
     join public.zoning_jurisdictions j on j.id = selected.jurisdiction_id
     join public.zoning_jurisdictions authority on authority.id = selected.zoning_authority_id`,
    [address.longitude, address.latitude],
  );
  const row = result.rows[0];
  if (!row) return null;
  const noZoning = row.zoning_status === 'no_zoning';
  return {
    state: address.state ?? row.state,
    stateCode: row.state,
    county: row.county_name,
    municipality: row.municipality_name,
    incorporated: row.municipality_name !== null,
    zoningAuthority: row.zoning_authority_name,
    jurisdictionType: noZoning ? 'no-zoning' : resultType(row.jurisdiction_type),
    confidence: 98,
    evidence: [
      {
        kind: 'boundary-intersection',
        detail: `PostGIS boundary routing selected ${row.zoning_authority_name} (${row.jurisdiction_type})`,
        confidence: 0.98,
      },
      {
        kind: 'registry',
        detail: `Configured jurisdiction record ${row.jurisdiction_id}; zoning status ${row.zoning_status}`,
        confidence: 1,
      },
    ],
  };
}
