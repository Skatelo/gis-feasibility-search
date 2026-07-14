create extension if not exists postgis;
create extension if not exists pgcrypto;

create table if not exists public.zoning_jurisdictions (
  id text primary key,
  name text not null,
  normalized_name text not null,
  state char(2) not null check (state in ('NC', 'SC')),
  state_fips char(2) not null check (state_fips in ('37', '45')),
  county_name text,
  county_fips char(3),
  place_fips char(5),
  jurisdiction_type text not null check (
    jurisdiction_type in (
      'state', 'county', 'municipality', 'township', 'etj',
      'planning_district', 'regional_authority', 'consolidated_government'
    )
  ),
  parent_jurisdiction_id text references public.zoning_jurisdictions(id),
  official_website text,
  official_domain text,
  boundary_geometry geometry(MultiPolygon, 4326),
  boundary_source_url text,
  zoning_authority_id text references public.zoning_jurisdictions(id),
  zoning_status text not null default 'unknown' check (
    zoning_status in ('adopted', 'partial', 'no_zoning', 'unknown', 'manual_review')
  ),
  routing_priority integer not null default 100,
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (state, jurisdiction_type, normalized_name, county_fips)
);

create index if not exists zoning_jurisdictions_boundary_gix
  on public.zoning_jurisdictions using gist (boundary_geometry);
create index if not exists zoning_jurisdictions_route_idx
  on public.zoning_jurisdictions (state, county_fips, active, routing_priority);

create table if not exists public.zoning_gis_sources (
  id uuid primary key default gen_random_uuid(),
  jurisdiction_id text not null references public.zoning_jurisdictions(id) on delete cascade,
  dataset_type text not null check (
    dataset_type in (
      'zoning', 'parcels', 'municipal_boundaries', 'county_boundaries',
      'etj_boundaries', 'planning_boundaries', 'overlays', 'address_points',
      'future_land_use', 'water_service', 'sewer_service', 'flood',
      'wetlands', 'permits'
    )
  ),
  source_type text not null check (
    source_type in (
      'arcgis-mapserver', 'arcgis-featureserver', 'arcgis-webmap',
      'arcgis-hub', 'ogc-api-features', 'wfs', 'geojson',
      'downloadable-dataset', 'interactive-viewer', 'pdf-map', 'manual'
    )
  ),
  source_name text not null,
  publisher text not null,
  official_domain text not null,
  viewer_url text,
  service_url text,
  layer_url text,
  server_root_url text,
  arcgis_item_id text,
  layer_id text,
  geometry_type text,
  spatial_reference integer,
  supports_query boolean not null default false,
  zoning_code_field text,
  zoning_name_field text,
  zoning_description_field text,
  parcel_id_field text,
  address_field text,
  effective_date_field text,
  official_source boolean not null default false,
  confidence_score integer not null default 0 check (confidence_score between 0 and 100),
  validation_status text not null default 'candidate' check (
    validation_status in (
      'candidate', 'manual_review', 'likely', 'high_confidence', 'verified',
      'degraded', 'disabled', 'rejected'
    )
  ),
  classification text not null default 'manual_review' check (
    classification in (
      'verified_current_zoning', 'likely_current_zoning', 'possible_zoning',
      'future_land_use', 'non_zoning', 'rejected', 'manual_review',
      'parcel', 'boundary', 'overlay'
    )
  ),
  last_checked_at timestamptz,
  last_success_at timestamptz,
  response_time_ms integer,
  failure_count integer not null default 0,
  schema_hash text,
  metadata jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (jurisdiction_id, dataset_type, layer_url)
);

create index if not exists zoning_gis_sources_active_idx
  on public.zoning_gis_sources (jurisdiction_id, dataset_type, validation_status)
  where active;

create table if not exists public.zoning_gis_source_versions (
  id bigint generated always as identity primary key,
  source_id uuid not null references public.zoning_gis_sources(id) on delete cascade,
  version_number integer not null,
  snapshot jsonb not null,
  change_reason text,
  changed_by uuid,
  created_at timestamptz not null default now(),
  unique (source_id, version_number)
);

create table if not exists public.zoning_gis_health_checks (
  id bigint generated always as identity primary key,
  source_id uuid not null references public.zoning_gis_sources(id) on delete cascade,
  checked_at timestamptz not null default now(),
  http_status integer,
  response_time_ms integer,
  query_success boolean not null default false,
  schema_hash text,
  important_fields_present boolean not null default false,
  status text not null check (status in ('healthy', 'degraded', 'broken', 'unverified')),
  error_message text,
  evidence jsonb not null default '{}'::jsonb
);

create index if not exists zoning_gis_health_checks_source_idx
  on public.zoning_gis_health_checks (source_id, checked_at desc);

create table if not exists public.zoning_lookup_logs (
  id bigint generated always as identity primary key,
  request_id uuid not null default gen_random_uuid(),
  normalized_address text,
  location geometry(Point, 4326),
  jurisdiction_id text references public.zoning_jurisdictions(id),
  parcel_id text,
  source_id uuid references public.zoning_gis_sources(id),
  source_version_number integer,
  zoning_result jsonb,
  confidence smallint check (confidence between 0 and 100),
  response_time_ms integer,
  cache_status text check (cache_status in ('hit', 'miss', 'bypass', 'unavailable')),
  error_status text,
  created_at timestamptz not null default now()
);

create index if not exists zoning_lookup_logs_created_idx
  on public.zoning_lookup_logs (created_at desc);
create index if not exists zoning_lookup_logs_jurisdiction_idx
  on public.zoning_lookup_logs (jurisdiction_id, created_at desc);

create or replace function public.set_zoning_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists zoning_jurisdictions_set_updated_at on public.zoning_jurisdictions;
create trigger zoning_jurisdictions_set_updated_at
before update on public.zoning_jurisdictions
for each row execute function public.set_zoning_updated_at();

drop trigger if exists zoning_gis_sources_set_updated_at on public.zoning_gis_sources;
create trigger zoning_gis_sources_set_updated_at
before update on public.zoning_gis_sources
for each row execute function public.set_zoning_updated_at();

create or replace function public.version_zoning_gis_source()
returns trigger
language plpgsql
as $$
declare
  next_version integer;
begin
  if to_jsonb(old) - 'updated_at' is distinct from to_jsonb(new) - 'updated_at' then
    select coalesce(max(version_number), 0) + 1
      into next_version
      from public.zoning_gis_source_versions
      where source_id = old.id;

    insert into public.zoning_gis_source_versions (source_id, version_number, snapshot, change_reason)
    values (old.id, next_version, to_jsonb(old), 'source record updated');
  end if;
  return new;
end;
$$;

drop trigger if exists zoning_gis_sources_version_history on public.zoning_gis_sources;
create trigger zoning_gis_sources_version_history
before update on public.zoning_gis_sources
for each row execute function public.version_zoning_gis_source();

create or replace function public.resolve_zoning_jurisdiction(lng double precision, lat double precision)
returns table (
  jurisdiction_id text,
  jurisdiction_name text,
  jurisdiction_type text,
  zoning_status text,
  zoning_authority_id text,
  routing_priority integer
)
language sql
stable
as $$
  with point as (
    select st_setsrid(st_makepoint(lng, lat), 4326) as geom
  )
  select
    j.id,
    j.name,
    j.jurisdiction_type,
    j.zoning_status,
    coalesce(j.zoning_authority_id, j.id),
    j.routing_priority
  from public.zoning_jurisdictions j, point p
  where j.active
    and j.boundary_geometry is not null
    and st_covers(j.boundary_geometry, p.geom)
  order by
    case j.jurisdiction_type
      when 'planning_district' then 1
      when 'etj' then 2
      when 'municipality' then 3
      when 'consolidated_government' then 4
      when 'county' then 5
      else 10
    end,
    j.routing_priority,
    st_area(j.boundary_geometry::geography)
  limit 1;
$$;

alter table public.zoning_jurisdictions enable row level security;
alter table public.zoning_gis_sources enable row level security;
alter table public.zoning_gis_source_versions enable row level security;
alter table public.zoning_gis_health_checks enable row level security;
alter table public.zoning_lookup_logs enable row level security;

drop policy if exists "Public reads active zoning jurisdictions" on public.zoning_jurisdictions;
create policy "Public reads active zoning jurisdictions"
on public.zoning_jurisdictions for select
using (active);

drop policy if exists "Public reads verified zoning sources" on public.zoning_gis_sources;
create policy "Public reads verified zoning sources"
on public.zoning_gis_sources for select
using (
  active
  and official_source
  and validation_status in ('verified', 'high_confidence')
);

comment on table public.zoning_lookup_logs is
  'Operational zoning evidence only. Do not store owner names or unnecessary personal information.';
