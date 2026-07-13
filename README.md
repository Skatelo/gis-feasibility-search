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
* **Zoning & Setbacks Capacity**: Approximates setbacks, max heights, floor-area ratios, and net buildable envelope dimensions.
* **Hybrid Live Web Data**: the Perplexity Search API handles fast ranked searches and source discovery; a bounded Crawlee scraper reads harder zoning, utility, fee, cost, and report sources plus linked PDF, DOCX, XLSX, CSV, JSON, XML, and text documents.
* **Comparable Sold Listings**: Scrapes verified sold properties from Realtor.com via Google Search grounding to calculateDeveloped After Repair Value (ARV).
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
