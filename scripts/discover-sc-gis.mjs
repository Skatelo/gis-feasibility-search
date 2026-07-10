import { crawlSources } from '../netlify/functions/lib/crawlee-scraper.js';

const seeds = [
  'https://www.sciway.net/maps/sc-gis-county-maps.html',
  'https://www.bambergcounty.sc.gov/parcel-gis-maps',
  'https://www.allendalecounty.com/',
];

const result = await crawlSources({
  urls: seeds,
  queries: ['South Carolina county GIS parcel assessor ArcGIS qPublic Beacon WTHGIS'],
  maxPages: 12,
  maxDepth: 1,
  maxCharsPerPage: 8_000,
});

const links = [...new Set(result.results.flatMap((page) => page.links || []))]
  .filter((url) => /arcgis|qpublic|beacon|wthgis|gis|parcel|property/i.test(url));
const endpoints = [...new Set(result.results.flatMap((page) => page.endpoints || []))];
console.log(JSON.stringify({ links, endpoints, errors: result.errors, stats: result.stats }, null, 2));
