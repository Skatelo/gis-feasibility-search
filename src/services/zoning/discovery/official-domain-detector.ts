// Official-domain detection — scores whether a URL's host is an authoritative
// government source. Third-party aggregators are never treated as official
// unless the caller explicitly opts in elsewhere.

export interface OfficialDomainAssessment {
  official: boolean;
  score: number; // 0..1
  reason: string;
}

// Hosts that are government-run infrastructure or vendors operating official
// government instances (the ArcGIS hubs are only "possibly official" because
// ownership can't be proven from the host alone).
const GOV_TLD_RE = /(^|\.)(gov|mil)$/i;
const US_STATE_LOCAL_RE = /(^|\.)[a-z-]+\.us$/i; // e.g. co.wake.nc.us, ci.raleigh.nc.us
const ESRI_HOSTED_RE = /(^|\.)(arcgis\.com|arcgisonline\.com)$/i;
const KNOWN_THIRD_PARTY_RE = /(^|\.)(zillow|realtor|redfin|trulia|loopnet|regrid|zoneomics|municipalonline|revize|granicus)\b/i;
const GIS_HOSTISH_RE = /(^|[.-])(gis|maps?|arcgis|geo|mapserver|opendata|data|hub)([.-]|$)/i;

function compact(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function assessOfficialDomain(
  urlOrHost: string,
  jurisdiction?: { municipality?: string | null; county?: string | null; stateCode?: string | null },
): OfficialDomainAssessment {
  let host = urlOrHost;
  try {
    host = new URL(urlOrHost).hostname;
  } catch {
    /* treat the input as a bare host */
  }
  host = host.toLowerCase().replace(/^\[|\]$/g, '');

  if (KNOWN_THIRD_PARTY_RE.test(host)) {
    return { official: false, score: 0.1, reason: `third-party aggregator host (${host})` };
  }

  const jurTokens = [jurisdiction?.municipality, jurisdiction?.county?.replace(/county$/i, ''), jurisdiction?.stateCode]
    .map((t) => (t ? compact(t) : ''))
    .filter((t) => t.length >= 3);
  const compactHost = compact(host);
  const hostMatchesJurisdiction = jurTokens.some((t) => compactHost.includes(t));

  if (GOV_TLD_RE.test(host)) {
    const score = 0.9 + (hostMatchesJurisdiction ? 0.1 : 0);
    return { official: true, score: Math.min(1, score), reason: `government TLD (${host})${hostMatchesJurisdiction ? ' matching jurisdiction' : ''}` };
  }
  if (US_STATE_LOCAL_RE.test(host)) {
    return { official: true, score: hostMatchesJurisdiction ? 0.95 : 0.85, reason: `state/local .us domain (${host})` };
  }
  if (ESRI_HOSTED_RE.test(host)) {
    // ArcGIS-hosted: authoritative only if the org is a government publisher,
    // which the discovery layer verifies separately. Flag as possibly-official.
    return {
      official: hostMatchesJurisdiction,
      score: hostMatchesJurisdiction ? 0.6 : 0.4,
      reason: `Esri-hosted service (${host}) — publisher must be verified`,
    };
  }
  // A jurisdiction-named GIS host on another TLD (e.g. wakegov.com, gcgis.org)
  // is commonly an official instance; medium confidence pending verification.
  if (hostMatchesJurisdiction && GIS_HOSTISH_RE.test(host)) {
    return { official: true, score: 0.7, reason: `GIS host matching jurisdiction (${host})` };
  }
  if (hostMatchesJurisdiction) {
    return { official: true, score: 0.55, reason: `host matches jurisdiction name (${host})` };
  }
  return { official: false, score: 0.2, reason: `unrecognized host (${host})` };
}
