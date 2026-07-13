import { SC_ZONING_COVERAGE } from '../netlify/functions/lib/sc-zoning-manifest.js';

const requested = new Set(process.argv.slice(2).map((value) => value.toLowerCase()));
const entries = SC_ZONING_COVERAGE.filter((entry) => !requested.size || requested.has(entry.county.toLowerCase()));

async function getJson(url) {
  try {
    const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(12_000) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

for (const entry of entries) {
  const query = encodeURIComponent(`"${entry.county} County" South Carolina zoning`);
  const search = await getJson(`https://www.arcgis.com/sharing/rest/search?f=json&num=15&sortField=modified&sortOrder=desc&q=${query}`);
  const results = await Promise.all((search?.results || []).slice(0, 10).map(async (searchItem) => {
    const item = await getJson(`https://www.arcgis.com/sharing/rest/content/items/${searchItem.id}?f=json`) || searchItem;
    const portal = item.orgId
      ? await getJson(`https://www.arcgis.com/sharing/rest/portals/${item.orgId}?f=json`)
      : null;
    return {
      id: item.id,
      title: item.title,
      type: item.type,
      owner: item.owner,
      organization: portal?.name || null,
      url: item.url || null,
    };
  }));
  console.log(JSON.stringify({ county: entry.county, results }));
}
