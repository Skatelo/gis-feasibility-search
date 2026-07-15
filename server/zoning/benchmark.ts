import { readZoningServerConfig } from './config';
import { createZoningRuntime } from './runtime';

const DEFAULT_ADDRESSES = [
  '3714 Memorial Parkway, Charlotte, NC 28217',
  '155 Johnston Street, Rock Hill, SC 29730',
  '216 S Catawba Street, Lancaster, SC 29720',
];

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

const addresses = process.argv.slice(2).filter(Boolean);
const runtime = await createZoningRuntime(readZoningServerConfig());
const rows: Array<Record<string, unknown>> = [];
try {
  for (const address of addresses.length > 0 ? addresses : DEFAULT_ADDRESSES) {
    const outcome = await runtime.adaptiveLookup({
      address,
      includeParcel: true,
      includeOverlays: true,
      mode: 'verified',
      forceRefresh: true,
      allowThirdParty: false,
    });
    runtime.metrics.record(outcome);
    rows.push({
      address,
      status: outcome.result.status,
      zoning: outcome.result.zoning.code,
      official: outcome.result.source?.official ?? false,
      registryHit: outcome.result.diagnostics.registryHit,
      discoveryAttempted: outcome.discoveryAttempted,
      lookupMs: outcome.result.diagnostics.timings.totalMs,
      sourceUrl: outcome.result.source?.layerUrl ?? null,
      errors: outcome.result.errors,
      timings: outcome.result.diagnostics.timings,
    });
  }
  const durations = rows.map((row) => Number(row.lookupMs));
  const summary = {
    lookups: rows.length,
    verified: rows.filter((row) => row.official && row.zoning).length,
    averageMs: durations.reduce((sum, value) => sum + value, 0) / Math.max(1, durations.length),
    p95Ms: percentile(durations, 0.95),
    targetMet: durations.every((duration) => duration <= 30_000),
  };
  console.log(JSON.stringify({ rows, summary }, null, 2));
  if (!summary.targetMet) process.exitCode = 1;
} finally {
  await runtime.close();
}
