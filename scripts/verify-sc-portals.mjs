import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/data/scCountySources.ts', import.meta.url), 'utf8');
const entries = [...source.matchAll(/\{ county: '([^']+)', fips: '([^']+)', provider: '([^']+)', portalUrl: '([^']+)'/g)]
  .map((match) => ({ county: match[1], fips: match[2], provider: match[3], portalUrl: match[4] }));
if (entries.length !== 46) throw new Error(`Expected 46 SC counties; found ${entries.length}`);

let cursor = 0;
const results = [];
async function worker() {
  while (cursor < entries.length) {
    const entry = entries[cursor++];
    const started = Date.now();
    try {
      const response = await fetch(entry.portalUrl, {
        method: 'GET',
        redirect: 'follow',
        cache: 'no-store',
        signal: AbortSignal.timeout(12_000),
        headers: { 'user-agent': 'LandFeasibilitySourceAudit/1.0' },
      });
      results.push({ ...entry, ok: response.ok, status: response.status, finalUrl: response.url, elapsedMs: Date.now() - started });
    } catch (error) {
      results.push({ ...entry, ok: false, error: String(error?.message || error), elapsedMs: Date.now() - started });
    }
  }
}
await Promise.all(Array.from({ length: 4 }, worker));
results.sort((a, b) => a.county.localeCompare(b.county));
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), counties: results }, null, 2));
if (results.some((result) => !result.ok)) process.exitCode = 1;
