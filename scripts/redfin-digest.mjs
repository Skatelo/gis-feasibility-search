// Redfin county market digest — downloads the Redfin Data Center county tracker
// (per county × property_type × period), filters to NC, keeps the latest monthly
// snapshot per county + product type, and writes a compact JSON the app reads as
// the §17 Market Saturation anchor. Run by a monthly GitHub Action.
//
// Data source: Redfin (https://www.redfin.com/news/data-center/). Attribution
// "Data source: Redfin" is surfaced in the report.

import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import readline from 'node:readline';
import { mkdir, writeFile } from 'node:fs/promises';

const URL = 'https://redfin-public-data.s3.us-west-2.amazonaws.com/redfin_market_tracker/county_market_tracker.tsv000.gz';
const OUT = 'public/market/nc-county-redfin.json';

// Redfin PROPERTY_TYPE → our compact keys.
const PT = {
  'All Residential': 'all',
  'Single Family Residential': 'single_family',
  'Townhouse': 'townhouse',
  'Condo/Co-op': 'condo',
  'Multi-Family (2-4 Unit)': 'multifamily',
};

const strip = (s) => (s == null ? '' : String(s).replace(/^"|"$/g, ''));
const num = (s) => { const n = parseFloat(strip(s)); return Number.isFinite(n) ? n : null; };

async function main() {
  console.log('Downloading', URL);
  const res = await fetch(URL);
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`);

  const gz = Readable.fromWeb(res.body).pipe(zlib.createGunzip());
  const rl = readline.createInterface({ input: gz, crlfDelay: Infinity });

  let idx = null;
  const get = (cells, name) => cells[idx[name]];
  const counties = {};
  const latest = {}; // county|pt -> { periodEnd, duration }
  const durations = new Map();
  const ptSeen = new Map();
  let ncRows = 0;

  for await (const line of rl) {
    const cells = line.split('\t');
    if (!idx) {
      idx = {};
      cells.forEach((c, i) => { idx[strip(c)] = i; });
      for (const req of ['STATE_CODE', 'REGION', 'PROPERTY_TYPE', 'PERIOD_END', 'MONTHS_OF_SUPPLY', 'MEDIAN_DOM']) {
        if (idx[req] == null) throw new Error(`missing expected column: ${req}`);
      }
      continue;
    }
    if (strip(get(cells, 'STATE_CODE')) !== 'NC') continue;
    ncRows++;
    const region = strip(get(cells, 'REGION'));
    const m = region.match(/^(.*?)\s+County,\s*NC$/i);
    if (!m) continue;
    const county = m[1].trim();
    const ptRaw = strip(get(cells, 'PROPERTY_TYPE'));
    ptSeen.set(ptRaw, (ptSeen.get(ptRaw) || 0) + 1);
    const pt = PT[ptRaw];
    if (!pt) continue;
    const periodEnd = strip(get(cells, 'PERIOD_END'));
    const duration = num(get(cells, 'PERIOD_DURATION'));
    durations.set(duration, (durations.get(duration) || 0) + 1);

    // Keep the latest period; tie-break to the longest duration (the monthly row).
    const key = `${county}|${pt}`;
    const prev = latest[key];
    const better = !prev || periodEnd > prev.periodEnd || (periodEnd === prev.periodEnd && (duration || 0) > (prev.duration || 0));
    if (!better) continue;
    latest[key] = { periodEnd, duration };

    (counties[county] ||= {})[pt] = {
      periodBegin: strip(get(cells, 'PERIOD_BEGIN')),
      periodEnd,
      durationDays: duration,
      monthsOfSupply: num(get(cells, 'MONTHS_OF_SUPPLY')),
      medianDom: num(get(cells, 'MEDIAN_DOM')),
      medianDomYoy: num(get(cells, 'MEDIAN_DOM_YOY')),
      inventory: num(get(cells, 'INVENTORY')),
      inventoryYoy: num(get(cells, 'INVENTORY_YOY')),
      homesSold: num(get(cells, 'HOMES_SOLD')),
      newListings: num(get(cells, 'NEW_LISTINGS')),
      medianSalePrice: num(get(cells, 'MEDIAN_SALE_PRICE')),
      medianSalePriceYoy: num(get(cells, 'MEDIAN_SALE_PRICE_YOY')),
      soldAboveList: num(get(cells, 'SOLD_ABOVE_LIST')),
    };
  }

  const countyNames = Object.keys(counties).sort();
  console.log('NC rows:', ncRows, '| counties:', countyNames.length);
  console.log('PERIOD_DURATION counts:', [...durations.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8));
  console.log('PROPERTY_TYPE counts:', [...ptSeen.entries()]);
  if (counties['Gaston']) console.log('Gaston sample:', JSON.stringify(counties['Gaston'].single_family || counties['Gaston'].all));

  if (countyNames.length < 50) throw new Error(`only ${countyNames.length} NC counties parsed — aborting (schema/format issue)`);

  const payload = {
    updated: new Date().toISOString().slice(0, 10),
    source: 'Redfin',
    sourceUrl: 'https://www.redfin.com/news/data-center/',
    series: 'county_market_tracker',
    counties,
  };
  await mkdir('public/market', { recursive: true });
  await writeFile(OUT, JSON.stringify(payload));
  console.log('Wrote', OUT, `(${(JSON.stringify(payload).length / 1024).toFixed(0)} KB)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
