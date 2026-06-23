# Scope — Redfin per-county / per-product-type market data for §17

**Goal:** give the report's *§17 Market Saturation & Absorption* a hard,
**per-product-type** anchor (single-family / townhouse / condo / multi-family)
with **months of supply, median DOM, inventory, homes sold, new listings** —
something the free FRED county series can't do (it's all-residential only).

## 1. Data source (verified)
Redfin Data Center, county tracker (free, monthly, attribution required):

- URL: `https://redfin-public-data.s3.us-west-2.amazonaws.com/redfin_market_tracker/county_market_tracker.tsv000.gz`
- Size: **~230 MB gzipped** (HEAD `200`). The ZIP-level file is ~1.48 GB — out of scope.
- Format: gzipped TSV, **58 columns** (verified header), one row per
  **county × property_type × period**. Relevant columns:
  `PERIOD_BEGIN/END/DURATION`, `REGION` (e.g. "Gaston County, NC"), `STATE_CODE`,
  `PROPERTY_TYPE`, `MEDIAN_SALE_PRICE(+MOM/+YOY)`, `MEDIAN_LIST_PRICE(+…)`,
  `HOMES_SOLD(+…)`, `NEW_LISTINGS(+…)`, `INVENTORY(+…)`,
  **`MONTHS_OF_SUPPLY(+MOM/+YOY)`**, **`MEDIAN_DOM(+MOM/+YOY)`**,
  `AVG_SALE_TO_LIST`, `SOLD_ABOVE_LIST`, `PRICE_DROPS`, `OFF_MARKET_IN_TWO_WEEKS`.
- Trend is **already computed** by Redfin (MOM/YOY columns) — no need to derive it.
- License: free to use **with attribution "Data source: Redfin"**; surface that in §17.

## 2. The digest job
A Node script (`scripts/redfin-digest.mjs`):
1. `fetch` the county `.gz` and **stream** through `zlib.createGunzip()` + line reader
   (never hold the whole file in memory).
2. Keep rows where `STATE_CODE === 'NC'` and `PERIOD_DURATION` = the monthly table
   (filter to the standard duration; ignore the 1/4/12-week rolling rows).
3. For each `(county, property_type)`, keep only the **latest period** row's
   metrics + the MoM/YoY columns (and optionally the prior 12 months if we want
   our own sparkline later).
4. Map `REGION` ("X County, NC") → county name (+ FIPS via the existing
   `ncCountyFips` map) and normalize `PROPERTY_TYPE` to: `single_family`,
   `townhouse`, `condo`, `multifamily`, `all`.
5. Emit compact JSON: `{ updated, source:"Redfin", counties: { "Gaston": {
   single_family:{monthsOfSupply, medianDom, inventory, homesSold, newListings,
   medianSalePrice, momDom, yoyDom, …}, townhouse:{…}, condo:{…}, … } } }`.

**Output size:** ~100 counties × ~5 types × ~12 fields → **~50–150 KB** JSON
(latest-month only ≈ ~40 KB). Trivial for the app to fetch.

## 3. Where it runs + cadence
**Recommended (Option A):** a **GitHub Action** on a monthly cron (~6th of each
month, after Redfin's mid-month refresh):
- runs `redfin-digest.mjs`, writes `public/market/nc-county-redfin.json`,
  commits if changed → Netlify auto-deploys the static asset.
- Pros: free, versioned, zero runtime cost, no per-request heavy work.
- ~230 MB download in CI runs in ~1–2 min; well within Action limits.

**Option B:** a **Netlify Scheduled Function** writing to **Netlify Blobs**, and a
read function the app calls. Avoids repo commits but adds Blobs + a read endpoint.
Option A is simpler and preferred unless we want to avoid committing data.

## 4. App integration
- `fetchRedfinCountyMarket(countyName)` in `feasibilityService.ts` reads
  `/market/nc-county-redfin.json` once (cached), returns the per-type metrics.
- The report packet **§2.7** becomes a **per-product-type table** (months of
  supply, median DOM, inventory by single-family/townhouse/condo/multifamily)
  with the Redfin "as of" date + attribution — the real §17 anchor.
- Keep the existing **FRED** call as a fallback / freshness cross-check (FRED is
  weekly-ish all-residential; Redfin is monthly but per-type). If Redfin JSON is
  missing the county/type, fall back to FRED, then to search.
- The §17 prompt instruction already asks for the per-type table; it will now be
  grounded in real numbers instead of search-only.

## 5. Effort & risks
- **Effort:** ~0.5–1 day. Digest script (~80 lines), Action (~30 lines), app
  reader + packet formatting (~50 lines).
- **Risks / mitigations:**
  - *Schema drift* (column renames) → parse by header name, defensive nulls,
    fail the Action loudly so stale-but-valid JSON stays deployed.
  - *Sparse small counties* → Redfin suppresses thin cells; mark "n/a (low
    volume)" and fall back to FRED all-residential.
  - *Latency* → monthly data is fine for feasibility; FRED covers fresher reads.
  - *Attribution* → always render "Data source: Redfin" in §17.

## 6. Phasing
- **P1** — digest + publish `nc-county-redfin.json` (GitHub Action). *(ship first)*
- **P2** — app reader + per-product-type §17 table in the report packet.
- **P3 (optional)** — extend to metro/ZIP for the top NC metros (bigger files,
  only if per-ZIP precision is wanted; ZIP file is 1.5 GB so do it metro-first).

## 7. Decision needed
- Option **A (GitHub Action → committed JSON)** vs **B (Netlify Scheduled Fn +
  Blobs)** — recommend **A**.
- NC-only now, or include neighboring states for cross-border metros (Charlotte
  ↔ SC)? NC-only first; SC border counties are a small P3 add.
