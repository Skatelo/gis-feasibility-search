// Thin CLI client for the registry-backed zoning API.
//
//   npm run zoning:lookup -- "600 East Fourth Street, Charlotte, NC 28202"
//   npm run zoning:lookup -- "155 Johnston Street, Rock Hill, SC 29730" --json

function parseArgs(argv) {
  const args = { address: '', mode: 'verified', json: false, apiUrl: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--json') args.json = true;
    else if (value === '--mode') args.mode = argv[++index];
    else if (value === '--api-url') args.apiUrl = argv[++index];
    else if (!args.address) args.address = value;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.address) {
  console.error('Usage: npm run zoning:lookup -- "<address>" [--mode fast|verified|deep] [--api-url <url>] [--json]');
  process.exit(1);
}

const apiBaseUrl = (args.apiUrl || process.env.ZONING_API_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const startedAt = Date.now();
const response = await fetch(`${apiBaseUrl}/v1/zoning/lookup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ address: args.address, mode: args.mode }),
  signal: AbortSignal.timeout(20_000),
});

const payload = await response.json().catch(() => null);
if (!response.ok) {
  console.error(payload?.message || payload?.error || `Zoning API returned HTTP ${response.status}`);
  process.exit(1);
}

if (args.json) {
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

const district = payload.baseZoning;
console.log('');
console.log(`Address     : ${payload.address?.normalized || args.address}`);
console.log(`Coordinates : ${payload.coordinates ? `${payload.coordinates.latitude}, ${payload.coordinates.longitude}` : 'n/a'}`);
console.log(`Jurisdiction: ${payload.jurisdiction?.zoningAuthority || 'unknown'}`);
console.log(`Zoning      : ${district?.localCode || 'not resolved'}${district?.localName ? ` - ${district.localName}` : ''}`);
if (district?.additionalDistricts?.length) {
  console.log(`Split-zoned : yes (+${district.additionalDistricts.map((item) => item.code).join(', ')})`);
}
if (payload.overlays?.length) {
  console.log(`Overlays    : ${payload.overlays.map((item) => item.code || item.name).join(', ')}`);
}
console.log(`Source      : ${payload.sources?.[0]?.layerUrl || 'none'}`);
console.log(`Status      : ${payload.status} | confidence ${payload.confidence?.score ?? 0}/100 | ${Date.now() - startedAt} ms`);
if (payload.warnings?.length) console.log(`Warnings    : ${payload.warnings.join('; ')}`);
console.log('');
