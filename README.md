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
