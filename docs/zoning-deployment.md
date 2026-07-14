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
4. Open the React application at `/#/zoning-admin` and use the same
   `ZONING_ADMIN_API_KEY` for administrative requests.

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
the U.S. Census geocoder is the keyless fallback. Perplexity is optional and is
read only by the maintenance worker.

## Rollout

Run source validation from the dashboard after import. A source should remain
`candidate` or `manual_review` until its metadata, geometry, mapped field,
sample, and real point query pass. Do not route production traffic to a new
jurisdiction solely because its boundary was imported.

Use separate API and worker replicas. Keep API request timeouts below the
platform timeout and allow outbound HTTPS to official ArcGIS and Census hosts.
Back up PostGIS before registry changes; the source-version trigger preserves
every prior configuration.
