# NC/SC Official Zoning Engine

The live engine accepts an NC or SC address, resolves the zoning authority,
loads a previously reviewed source record, locates the official parcel, and
queries official current-zoning polygons. It does not search the web, crawl a
viewer, invoke an AI model, or infer zoning from a tax-use field.

```text
address
  -> configured geocoder (Census fallback)
  -> PostGIS county/municipality/planning-boundary route
  -> verified PostgreSQL source record
  -> containing or bounded-nearest official parcel
  -> parcel interior point and full-polygon intersection
  -> base zoning plus separate overlays
  -> evidence, confidence, warnings, and timing
```

A missing source returns `manual-review-required`. A jurisdiction recorded from
official evidence as having no general zoning returns `no-zoning`. The engine
never fabricates a district.

## Service

```bash
npm run typecheck:zoning-server
npm run build:zoning-server
npm run zoning:api
```

Public endpoints:

- `POST /v1/geocode`
- `POST /v1/jurisdictions/resolve`
- `POST /v1/parcels/lookup`
- `POST /v1/zoning/lookup`

The server uses PostgreSQL/PostGIS for authority routing and source history,
Redis for bounded result caching and single-flight behavior, and BullMQ for
maintenance. See `docs/zoning-deployment.md`.

## Maintenance

`server/zoning/worker.ts` owns source discovery, live validation, and recurring
health checks. Discovery may use Perplexity Search, direct HTTP, Crawlee, and a
final Playwright viewer inspection. Candidates stay out of the live registry
until reviewed and validated.

## Tests

```bash
npm run typecheck:zoning-engine
npm run typecheck:zoning-server
npm run test:zoning-engine
npm run test:zoning-server
```

Normal tests use fixtures. Network probes are isolated and opt-in.
