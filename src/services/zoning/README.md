# Universal U.S. Zoning Lookup Engine

Given any U.S. property address, this engine discovers, queries, validates, and
normalizes the best available **public** zoning data — deterministically, from
official GIS services. It is **jurisdiction-agnostic**: no county, city, state,
GIS vendor, or layer number is hardcoded. Everything is derived at runtime from
live service metadata and cached in a registry so later lookups are fast.

> The final zoning code always comes from an official zoning **polygon**
> intersected with the property coordinates via a GIS query. Search APIs
> (Perplexity) only *locate* the source; they never decide the zoning.

## The runtime loop (discover-once → verify → cache → reuse)

```
address
  → geocode (Google, else keyless U.S. Census)
  → resolve jurisdiction from authoritative boundaries (never the mailing city)
  → registry.get(jurisdictionKey)
       HIT  → query the recorded ArcGIS layers directly            (fast path)
       MISS → Perplexity Search finds candidate URLs
              → Crawlee/HTTP validates + extracts the REST endpoint
              → inspect service + classify layers + detect fields
              → SAVE the verified source to the registry
              → query                                              (slow path, once)
  → normalize fields + codes (base zoning ≠ future land use ≠ overlay)
  → score confidence (0–100, transparent)
  → UniversalZoningResult
```

The **first** address in a jurisdiction does discovery; **every later** address
in that jurisdiction reuses the saved record and just queries ArcGIS — typically
1–5 s.

## Usage

```ts
import { createZoningEngine } from './services/zoning';

const engine = createZoningEngine({
  googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY,   // optional (Census fallback)
  perplexityApiKey: process.env.PERPLEXITY_API_KEY,    // optional (discovery only)
});

const result = await engine.lookup({
  address: '634 Kentbrook Dr, Charlotte, NC 28213',
  mode: 'verified',          // 'fast' | 'verified' (default) | 'deep'
  includeOverlays: true,
});

console.log(result.zoning.code, result.status, result.confidence.overall);
```

`lookup()` never throws — failures surface as `result.status` (`verified`,
`verified-with-warnings`, `possible-match`, `manual-review-required`,
`not-found`, `no-zoning`, `error`) plus a per-stage `result.errors[]`.

### CLI / demo

```bash
# Discovery needs PERPLEXITY_API_KEY (or VITE_PERPLEXITY_API_KEY in .env.local):
node scripts/zoning-lookup.mjs "634 Kentbrook Dr, Charlotte, NC 28213"

# Or point straight at a known official service (skips discovery):
node scripts/zoning-lookup.mjs "227 Fayetteville St, Raleigh NC" \
  --service https://maps.wake.gov/arcgis/rest/services/Planning/Zoning/MapServer
# → Zoning: DX-40-SH — Downtown Mixed Use · status verified · confidence 85/100
```

## Lookup modes

| Mode       | Boundary lookup | Discovery | Geometry | Target |
| ---------- | --------------- | --------- | -------- | ------ |
| `fast`     | cached only     | registry only | no | < 5 s |
| `verified` | yes (default)   | on miss   | on demand | < 10 s |
| `deep`     | yes             | on miss   | split-zoning + parcel | longer |

## Module map

```
types.ts                 Zod-validated core types (source of truth)
geocoding/               Geocoder interface · Google · Census · chain
jurisdiction/            Census-boundary point-in-polygon resolver
arcgis/                  client · service inspector · layer classifier ·
                         field detector · spatial query   (deterministic core)
discovery/               Perplexity search · Crawlee/HTTP validation ·
                         official-domain detector · endpoint extractor
utils/url-security.ts    SSRF / unsafe-target defense for discovered URLs
registry/                KV store · jurisdiction registry · source health
normalization/           zoning + overlay normalizer (codes ≠ FLU ≠ overlay)
confidence/              transparent 0–100 scoring
orchestrator/            the engine + record mapper
```

## Adding a new source adapter

Adapters are independent and implement `ZoningSourceAdapter` (`types.ts`):

1. Create `adapters/<kind>.adapter.ts` implementing `canHandle`, `inspect`,
   `query`, and optionally `healthCheck`, returning `InspectedZoningSource` /
   `RawZoningMatch[]` in the same shapes the ArcGIS path uses.
2. Reuse `utils/http.ts` (guarded fetch) and `utils/url-security.ts`.
3. Register it where the orchestrator selects an adapter by `DiscoveredSource`.

The ArcGIS MapServer/FeatureServer path is fully implemented; WFS/GeoServer,
GeoJSON, Socrata/CKAN, PDF, and HTML-lookup adapters slot in the same way.

## Tests

```bash
npm run test:zoning-engine          # unit + offline (esbuild-bundled, node:test)
ZONING_LIVE=1 npm run test:zoning-engine   # + live network tests
```

## Status

Implemented and live-verified: geocoding, jurisdiction resolution, the
deterministic ArcGIS core, source discovery + URL security, the registry +
health, normalization, confidence, and the end-to-end orchestrator (fast +
verified modes).

Planned: value-sampled field detection for layers with misleading column names,
Turf-based split-zoning coverage % + parcel-first interior points, additional
source adapters (WFS/GeoJSON/Socrata), and PDF/ordinance fallbacks.
