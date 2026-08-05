# Land Feasibility GIS Search Application

A high-performance real estate feasibility screening dashboard built with React, TypeScript, Vite, and Google Maps. This app performs real-time parcel boundary, zoning capacity, topography slope analysis, and comparable sold sales retrieval for properties across North Carolina.

## Key Features
* **100-County GIS Engine**: Leverages NC address geocoding and parcel intersection mapping.
* **Local MapServer Fallbacks**: Bypasses statewide GIS service outages by directly querying local endpoints for:
  - **Mecklenburg County** (Charlotte)
  - **Wake County** (Raleigh/Cary)
  - **Gaston County** (Gastonia/Mount Holly)
  - **Cabarrus County** (Concord/Kannapolis)
* **Topography & Elevation Metrics**: Integrates with OpenTopography (Copernicus COP30 DEM) to gauge site slope and buildability classification (Buildable vs. Non-Buildable).
* **Zoning & Allowances**: sends the complete NC or SC address to Gemini 3.6 Flash with Google Search grounding to return a source-backed district, setbacks, restrictions, and allowances.
* **Adaptive Live Web Data**: Perplexity handles the fast non-zoning search lane, Monid adds semantic coverage for hard or thin searches, and a bounded Crawlee scraper reads selected utility, fee, cost, and report pages plus linked PDF, DOCX, XLSX, CSV, JSON, XML, and text documents.
* **Comparable Sold Listings**: Scrapes verified sold properties from Realtor.com via Google Search grounding to calculateDeveloped After Repair Value (ARV).
* **Mortgage & Sales Transactions**: Runs an explicit, on-demand RealEstateAPI.com Property Detail lookup for the exact NC or SC address and displays recorded mortgage and sale history in the left report column.
* **Interactive Gemini Q&A Chatbot**: A contextual chatbot capable of explaining setbacks, zoning rules, or construction options utilizing the current parcel context.
* **Printable Feasibility Report**: Generates vector PDF-ready feasibility reports for wholesalers and developers.
* **Durable Background Reports**: Runs automatic or on-demand reports in a Netlify background function, saves them to the signed-in Supabase account, and can email the completed report through Resend.

## Get Started

### 1. Install Dependencies
```bash
npm install
```

### 2. Start the Development Server
```bash
npm run dev
```

### 3. Build for Production
```bash
npm run build
```

## Crawlee Research

Crawlee runs inside the Netlify backend and does not require a separate API key. Configure Perplexity, Monid, or both in **Account & API Settings** so the app can discover source URLs; scrape-heavy searches are then automatically sent to Crawlee for page and document extraction.

The crawler uses HTTP + Cheerio rather than a browser for speed. Each run is limited by page count, crawl depth, concurrency, request timeout, and a 12 MB response cap. It follows only relevant same-site links, respects `robots.txt`, blocks private-network targets, and is rate-limited per visitor in production.

For local testing of the crawler endpoint, use `npx netlify dev`. Plain `npm run dev` supports both Perplexity and Monid search through Vite proxies, but it does not execute the Crawlee Netlify function.

## Monid Research

The app uses Monid's direct HTTP API instead of its MCP server. That fits a browser application better: the same-origin proxy supplies deterministic authentication, strict timeouts, provider-status checks, and a maximum estimated price per call without requiring an interactive MCP session.

When both credentials are configured, easy searches stay on Perplexity. Hard searches run Perplexity and Monid concurrently, while an automatic Monid top-up runs only when Perplexity returns too few results, too few domains, or thin snippets. With only a Monid key, Monid supplies the normal live-search path. Crawlee remains responsible for reading the chosen pages and documents.

Only Monid endpoint metadata is cached in memory for 30 minutes. Search and address results are never cached or prefetched; every property lookup makes fresh source requests. Create a key at `https://app.monid.ai/access/api-keys` and set it in **Account & API Settings** or as `VITE_MONID_API_KEY`.

Run `npm run benchmark:search -- --allow-paid` with both keys configured to compare the providers on concurrent Carolina research cases. See `docs/search-provider-comparison.md` for the routing decision, scoring method, and tradeoffs.

## Mortgage & Sales History

The left-side **Mortgage & Sales Transactions** card does not run during a normal parcel search. Press **Pull Mortgage & Sales History** to make a fresh, uncached RealEstateAPI.com Property Detail request for the complete NC or SC address.

Configure `REALESTATEAPI_KEY` as a Netlify server environment variable, or add a personal RealEstateAPI.com key in **Account & API Settings**. Plain `npm run dev` forwards the same route to the official Property Detail endpoint and uses the personal key. The existing `realtyApi` setting remains separate and continues to power Realtor/Redfin/Zillow comps through RealtyAPI.io.

## Zoning Search

The in-report **Zoning & Allowances** section uses Gemini 3.6 Flash with its built-in Google Search grounding tool. Each lookup includes the complete street, city, state name, ZIP code, and `United States`; the request uses `cache: "no-store"`. The grounded response must include source citations before the app accepts a district or its adopted standards.

Configure the Gemini API key in **Account & API Settings**. No separate search credential or search-engine configuration is required.

## Background Reports & Email

Background execution requires Supabase cloud accounts and the `report_jobs`
migration. Users can choose **Generate Now** or **Run in Background** on a manual
report, or select **Background server** for automatic reports in Account & API
Settings. My Reports polls queued/running jobs and opens the saved report when it
completes. Email is always sent to the authenticated account address.

The background worker runs the full fusion pipeline: Perplexity Search discovers
sources; bounded Crawlee extracts selected pages and documents; Context.dev web
search and Markdown extraction plus Octen Extract run through the Monid API;
Gemini and DeepSeek/OpenRouter
produce independent drafts; and Gemini judges them into the saved final report.
It never substitutes a Gemini-only report when fusion credentials are missing.

Deploy the app on Netlify and configure `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`RESEND_API_KEY`, and a verified `REPORT_FROM_EMAIL`. Users can save the required
Gemini, DeepSeek/OpenRouter, Perplexity, and Monid credentials in Account & API
Settings; equivalent server environment variables are supported as fallbacks.
See `SETUP_SUPABASE.md` for the SQL and deployment steps. Use `npx netlify dev`
for local worker testing.

## Official NC/SC Zoning Service

The repository also contains a registry-only Fastify zoning service backed by
PostGIS, Redis, and BullMQ. Normal address lookups query previously reviewed
official ArcGIS layers only; Perplexity, Crawlee, Playwright, and AI are limited
to administrative source onboarding and maintenance.

```bash
npm run typecheck:zoning-server
npm run build:zoning-server
docker compose --env-file .env.zoning -f docker-compose.zoning.yml up --build
```

The adaptive manifest includes every NC and SC county, while source approval
remains evidence-based. See `docs/zoning-coverage.md`; source health and review
are managed through the zoning service API and registry tools, not a separate
property-search page.
