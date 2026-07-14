// Search-query builder — turns a resolved jurisdiction into the Perplexity
// Search queries most likely to surface the official GIS endpoint. Queries are
// ordered official-source-first; the discovery service stops early once a
// verified endpoint is found.

import type { JurisdictionResult } from '../types';

export function buildDiscoveryQueries(jurisdiction: JurisdictionResult): string[] {
  const muni = jurisdiction.municipality?.trim();
  const county = jurisdiction.county?.trim();
  const state = jurisdiction.stateCode?.trim() || jurisdiction.state?.trim();
  const authority = jurisdiction.zoningAuthority?.trim() || muni || county;
  if (!authority || !state) return [];

  const queries: string[] = [];
  const add = (q: string) => {
    const t = q.replace(/\s+/g, ' ').trim();
    if (t && !queries.includes(t)) queries.push(t);
  };

  // Municipal authority first (when the property is inside a municipality).
  if (muni && jurisdiction.jurisdictionType === 'municipal') {
    add(`"${muni}" "${state}" zoning GIS MapServer`);
    add(`"${muni}" "${state}" zoning ArcGIS REST services`);
    add(`site:gov "${muni}" ${state} zoning map`);
    add(`site:arcgis.com "${muni}" zoning`);
  }
  // County authority (always useful — covers unincorporated + county fallback).
  if (county) {
    add(`"${county}" "${state}" zoning GIS MapServer`);
    add(`"${county}" "${state}" planning zoning ArcGIS REST FeatureServer`);
    add(`site:gov "${county}" ${state} zoning GIS`);
  }
  // Generic authority catch-all.
  add(`"${authority}" ${state} zoning district map GIS rest services`);
  return queries.slice(0, 8);
}
