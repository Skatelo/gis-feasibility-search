# Zoning Service Deployment

## Local Docker stack

1. Create a local environment file from `.env.zoning.example` and replace both
   placeholder secrets.
2. Start the database, Redis, jurisdiction import, API, and worker:

   ```bash
   docker compose --env-file .env.zoning -f docker-compose.zoning.yml up --build
   ```

3. Check `http://localhost:8787/health` and
   `http://localhost:8787/documentation/openapi.json`.
4. Use the documented administrative API with `ZONING_ADMIN_API_KEY` for source
   review and validation. The property-search UI has no separate admin page.
5. Set the web app's `VITE_ZONING_API_URL` to the externally reachable API base
   URL. The property workflow calls `/api/zoning/lookup` and falls back to the
   legacy `/v1` route only during a rolling deployment.

The `bootstrap` service imports current Census TIGER county and incorporated
place boundaries into PostGIS, then imports the reviewed rollout source records.
It is idempotent. The API does not start until that import succeeds.

## Processes

- `node dist-server/main.js`: Fastify API, registry reads, PostGIS routing, and
  Redis result caching.
- `node dist-server/worker.js`: BullMQ discovery, validation, and scheduled
  12-hour health scans.
- `node dist-server/import.js`: TIGER boundary and source-record importer.

Build without Docker:

```bash
npm run typecheck:zoning-server
npm run build:zoning-server
```

Required production variables are `DATABASE_URL`, `REDIS_URL`,
`ZONING_ADMIN_API_KEY`, and `ZONING_CORS_ORIGINS`. Google is optional because
the U.S. Census geocoder is the keyless fallback. Perplexity is optional; when
configured, the adaptive API uses the raw Search API only on registry misses.
It discovers official URLs but never supplies the zoning designation.

For local development without `DATABASE_URL`, the API defaults to
`.data/zoning.sqlite`. Override it with `ZONING_SQLITE_PATH` or set it to
`:memory:` for an ephemeral run. Production should continue to use PostgreSQL.

## Rollout

Run source validation from the dashboard after import. A source should remain
`candidate` or `manual_review` until its metadata, geometry, mapped field,
sample, and real point query pass. Do not route production traffic to a new
jurisdiction solely because its boundary was imported.

Use separate API and worker replicas. Allow at least 35 seconds at the platform
edge for the hard browser-fallback deadline and allow outbound HTTPS to official
ArcGIS, Census, and configured Search API hosts. Known registry lookups remain
on the direct path. Scrape `/metrics` for success, official-source, registry-hit,
browser-fallback, average latency, and P95 latency gauges.
Back up PostGIS before registry changes; the source-version trigger preserves
every prior configuration.
