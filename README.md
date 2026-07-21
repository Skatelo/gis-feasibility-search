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
* **Hybrid Live Web Data**: the Perplexity Search API handles non-zoning ranked searches and source discovery; a bounded Crawlee scraper reads harder utility, fee, cost, and report sources plus linked PDF, DOCX, XLSX, CSV, JSON, XML, and text documents.
* **Comparable Sold Listings**: Scrapes verified sold properties from Realtor.com via Google Search grounding to calculateDeveloped After Repair Value (ARV).
* **Mortgage & Sales Transactions**: Runs an explicit, on-demand RealEstateAPI.com Property Detail lookup for the exact NC or SC address and displays recorded mortgage and sale history in the left report column.
* **Interactive Gemini Q&A Chatbot**: A contextual chatbot capable of explaining setbacks, zoning rules, or construction options utilizing the current parcel context.
* **Printable Feasibility Report**: Generates vector PDF-ready feasibility reports for wholesalers and developers.

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

Crawlee runs inside the Netlify backend and does not require a separate API key. Configure a Perplexity key in **Account & API Settings** so the app can discover source URLs; scrape-heavy searches are then automatically sent to Crawlee for page and document extraction.

The crawler uses HTTP + Cheerio rather than a browser for speed. Each run is limited by page count, crawl depth, concurrency, request timeout, and a 12 MB response cap. It follows only relevant same-site links, respects `robots.txt`, blocks private-network targets, and is rate-limited per visitor in production.

For local testing of the crawler endpoint, use `npx netlify dev`. Plain `npm run dev` still supports Perplexity search, but it does not execute Netlify functions.

## Mortgage & Sales History

The left-side **Mortgage & Sales Transactions** card does not run during a normal parcel search. Press **Pull Mortgage & Sales History** to make a fresh, uncached RealEstateAPI.com Property Detail request for the complete NC or SC address.

Configure `REALESTATEAPI_KEY` as a Netlify server environment variable, or add a personal RealEstateAPI.com key in **Account & API Settings**. Plain `npm run dev` forwards the same route to the official Property Detail endpoint and uses the personal key. The existing `realtyApi` setting remains separate and continues to power Realtor/Redfin/Zillow comps through RealtyAPI.io.

## Zoning Search

The in-report **Zoning & Allowances** section uses Gemini 3.6 Flash with its built-in Google Search grounding tool. Each lookup includes the complete street, city, state name, ZIP code, and `United States`; the request uses `cache: "no-store"`. The grounded response must include source citations before the app accepts a district or its adopted standards.

Configure the Gemini API key in **Account & API Settings**. No separate search credential or search-engine configuration is required.

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
