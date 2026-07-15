# NC/SC Official Zoning Engine

The core engine accepts an NC or SC address, resolves the zoning authority,
loads a proven source record, locates the official parcel, and queries official
current-zoning polygons. The adaptive API adds a bounded discovery path only on
a registry miss. It never asks an AI model to decide the zoning code and never
infers zoning from tax use, future land use, or real-estate listings.

```text
address
  -> configured geocoder (Census fallback)
  -> PostGIS county/municipality/planning-boundary route
  -> PostgreSQL or local SQLite source record
  -> on miss: official web + ArcGIS portal discovery
  -> metadata inspection + real point-query proof
  -> save successful jurisdiction configuration
  -> containing or bounded-nearest official parcel
  -> parcel interior point and full-polygon intersection
  -> base zoning plus separate overlays
  -> evidence, confidence, warnings, and timing
```

A source is saved only after a current-zoning polygon returns a non-placeholder
district at the property coordinate. `N/A`, `OFFICIAL MAP REVIEW`, future land
use, and similar values are rejected. A miss returns `manual-review-required`;
the engine never fabricates a district.

## Service

```bash
npm run typecheck:zoning-server
npm run build:zoning-server
npm run zoning:api
```

Public endpoints:

- `POST /api/zoning/lookup` (preferred adaptive contract)
- `POST /v1/geocode`
- `POST /v1/jurisdictions/resolve`
- `POST /v1/parcels/lookup`
- `POST /v1/zoning/lookup`
- `GET /metrics`

Production uses PostgreSQL/PostGIS for authority routing and source history,
Redis for bounded caching and single-flight behavior, and BullMQ for scheduled
maintenance. Local development defaults to `.data/zoning.sqlite`, preserving
newly proven sources across restarts. See `docs/zoning-deployment.md`.

## Maintenance

`server/zoning/worker.ts` owns bulk onboarding, live validation, and recurring
health checks. The adaptive endpoint also performs single-jurisdiction discovery
with direct ArcGIS/HTTP first, optional Perplexity Search for ranked URLs, and a
single bounded browser fallback. Only an official, queryable zoning layer that
returns a valid point result enters the live registry.

The rollout manifest includes the requested 12 high-priority NC counties and
all 46 SC counties, with 10 SC counties marked first priority. The manifest is
an onboarding queue, not a claim that an unverified source is authoritative.

## Tests

```bash
npm run typecheck:zoning-engine
npm run typecheck:zoning-server
npm run test:zoning-engine
npm run test:zoning-server
```

Normal tests use fixtures. Network probes are isolated and opt-in.
