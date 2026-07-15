import type { AdaptiveLookupOutcome } from './adaptive-lookup';

const MAX_SAMPLES = 2_000;

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

export class ZoningMetrics {
  private total = 0;
  private successful = 0;
  private official = 0;
  private discovery = 0;
  private browser = 0;
  private registryHits = 0;
  private geocodeCacheHits = 0;
  private failedSources = 0;
  private readonly durations: number[] = [];

  record(outcome: AdaptiveLookupOutcome): void {
    const result = outcome.result;
    this.total += 1;
    if (result.zoning.found) this.successful += 1;
    if (result.zoning.found && result.source?.official) this.official += 1;
    if (outcome.discoveryAttempted) this.discovery += 1;
    if (outcome.browserFallbackUsed) this.browser += 1;
    if (result.diagnostics.registryHit) this.registryHits += 1;
    if (result.diagnostics.geocodeCacheHit) this.geocodeCacheHits += 1;
    this.failedSources += outcome.sourcesChecked.filter((source) => source.status === 'failed').length;
    this.durations.push(result.diagnostics.timings.totalMs);
    if (this.durations.length > MAX_SAMPLES) this.durations.shift();
  }

  snapshot() {
    const durationTotal = this.durations.reduce((sum, value) => sum + value, 0);
    return {
      lookups: this.total,
      successRate: ratio(this.successful, this.total),
      officialSourceSuccessRate: ratio(this.official, this.total),
      discoveryRate: ratio(this.discovery, this.total),
      browserFallbackRate: ratio(this.browser, this.total),
      registryHitRate: ratio(this.registryHits, this.total),
      geocodeCacheHitRate: ratio(this.geocodeCacheHits, this.total),
      averageLookupMs: this.durations.length ? durationTotal / this.durations.length : 0,
      p95LookupMs: percentile(this.durations, 0.95),
      failedSourceChecks: this.failedSources,
    };
  }

  prometheus(): string {
    const metrics = this.snapshot();
    const lines = [
      '# HELP zoning_lookups_total Total adaptive zoning lookups.',
      '# TYPE zoning_lookups_total counter',
      `zoning_lookups_total ${metrics.lookups}`,
      '# TYPE zoning_success_rate gauge',
      `zoning_success_rate ${metrics.successRate}`,
      '# TYPE zoning_official_source_success_rate gauge',
      `zoning_official_source_success_rate ${metrics.officialSourceSuccessRate}`,
      '# TYPE zoning_discovery_rate gauge',
      `zoning_discovery_rate ${metrics.discoveryRate}`,
      '# TYPE zoning_browser_fallback_rate gauge',
      `zoning_browser_fallback_rate ${metrics.browserFallbackRate}`,
      '# TYPE zoning_registry_hit_rate gauge',
      `zoning_registry_hit_rate ${metrics.registryHitRate}`,
      '# TYPE zoning_geocode_cache_hit_rate gauge',
      `zoning_geocode_cache_hit_rate ${metrics.geocodeCacheHitRate}`,
      '# TYPE zoning_lookup_duration_average_ms gauge',
      `zoning_lookup_duration_average_ms ${metrics.averageLookupMs}`,
      '# TYPE zoning_lookup_duration_p95_ms gauge',
      `zoning_lookup_duration_p95_ms ${metrics.p95LookupMs}`,
      '# TYPE zoning_failed_source_checks_total counter',
      `zoning_failed_source_checks_total ${metrics.failedSourceChecks}`,
    ];
    return `${lines.join('\n')}\n`;
  }
}
