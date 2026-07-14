# NC/SC Zoning Engine Implementation Checklist

This checklist maps the attached production build brief onto the existing Vite,
Netlify, Supabase, Crawlee, and strict-TypeScript zoning architecture. The
existing ArcGIS inspector, classifier, field detector, source health checker,
geocoder chain, and confidence engine are reused.

## Coverage Contract

- [x] Treat official current-zoning polygons as the only source of a district.
- [x] Keep source discovery, browser work, and AI out of normal address lookups.
- [x] Return `manual_review` when no verified digital layer is configured.
- [x] Keep base zoning, overlays, parcels, and future land use as separate roles.
- [x] Do not infer zoning from parcel tax use, a mailing city, or ordinance text.
- [ ] Validate every configured NC and SC authority before claiming statewide coverage.

## Phase 1: Data And Registry

- [x] Add PostgreSQL/PostGIS tables for jurisdictions, GIS sources, source
  versions, health checks, and lookup logs.
- [x] Add version-history triggers so source changes never overwrite evidence.
- [x] Add NC/SC county and incorporated-place boundary importer support.
- [x] Add manually reviewed source seeds for Mecklenburg, Gaston, Cabarrus,
  Union (NC), York, and Lancaster (SC).
- [x] Record separate municipal configurations where the county service exposes
  separate municipal layers.
- [x] Record City of Lancaster as supported and unincorporated Lancaster County
  as `manual_review` until a county-wide layer passes validation.

## Phase 2: Deterministic Lookup

- [x] Make the live engine registry-only; a registry miss must never discover.
- [x] Add ArcGIS GET/POST point and polygon query support with strict timeouts.
- [x] Add official parcel lookup and parcel-interior-point routing.
- [x] Add nearest-parcel fallback with a bounded search radius.
- [x] Add parcel/zoning intersection and split-zoning percentages.
- [x] Query overlay layers separately from base zoning.
- [x] Preserve raw zoning attributes and exact layer URLs in every result.
- [x] Keep the existing source-discovery service available only to maintenance jobs.

## Phase 3: Service Layer

- [x] Add `POST /v1/geocode`.
- [x] Add `POST /v1/jurisdictions/resolve`.
- [x] Add `POST /v1/parcels/lookup`.
- [x] Add `POST /v1/zoning/lookup`.
- [x] Add optional Redis caching with request single-flight behavior.
- [x] Add PostgreSQL lookup logging without owner or unnecessary personal data.
- [x] Add OpenAPI documentation and structured error responses.

## Phase 4: Operations

- [x] Add BullMQ discovery, validation, and health-check workers.
- [x] Add source-health and source-review administration APIs.
- [x] Add an administrative source dashboard in the existing React app.
- [x] Add Docker Compose for API, worker, PostGIS, and Redis.
- [x] Add source onboarding, deployment, error handling, and security docs.

## Verification

- [x] Unit-test registry-only behavior, including proof that discovery is never
  called by a normal lookup.
- [ ] Unit-test MapServer, FeatureServer, POST fallback, future-land-use
  rejection, empty results, and broken sources with fixtures.
- [x] Unit-test parcel interior points, nearest-parcel fallback, overlays, and
  split zoning.
- [x] Unit-test NC/SC authority routing and unsupported states.
- [x] Add isolated live probes for the first six rollout counties (36 unique
  official zoning, overlay, and parcel layers passed on 2026-07-14).
- [ ] Complete live point probes for every configured authority in all 100 NC
  counties and all 46 SC counties.
- [ ] Import and verify ETJ and special planning boundaries beyond the initial
  rollout.

## Statewide Expansion

- [ ] Onboard and validate remaining NC county authorities and municipalities.
- [ ] Onboard and validate remaining SC county authorities and municipalities.
- [ ] Record confirmed `no_zoning` jurisdictions with official evidence.
- [ ] Publish a generated coverage report from database validation records.

The unchecked statewide items are intentionally visible. The application must
not describe those jurisdictions as validated until their official source has
passed metadata, schema, sample, and real point-query checks.
