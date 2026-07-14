// Endpoint extraction — pulls structured GIS service URLs out of raw page HTML,
// JavaScript bundles, and ArcGIS app configuration JSON. Handles escaped slashes
// (\/) common in embedded JSON. Nothing here fetches; it only extracts + dedupes
// candidate URLs from text already retrieved by the crawler.

import type { ZoningSourceType } from '../types';
import { isSafeUrl } from '../utils/url-security';

// Run against text that has already had escaped JSON slashes (\/) normalized to
// /, so a single set of plain URL patterns covers HTML, JS bundles, and config.
const ARCGIS_RE = /https?:\/\/[^"'<>\s\\)]+?(?:MapServer|FeatureServer)(?:\/\d+)?/gi;
const WFS_RE = /https?:\/\/[^"'<>\s\\)]+?(?:\/geoserver\/[^"'<>\s\\)]*|service=wfs[^"'<>\s\\)]*|\/wfs\b[^"'<>\s\\)]*|\/ows\b[^"'<>\s\\)]*)/gi;
const GEOJSON_RE = /https?:\/\/[^"'<>\s\\)]+?\.geojson(?:\?[^"'<>\s\\)]*)?/gi;
const WEBMAP_ID_RE = /(?:itemId|webmap|webMap|item|id)["'\s:=]+([a-f0-9]{32})/gi;

function trimTrailing(url: string): string {
  return url.replace(/[),.;]+$/, '');
}

// Accept only true REST service endpoints; reject viewer/app wrappers (which
// embed a service URL in a ?url= param) and SOAP endpoints (…/services/… with
// no /rest/).
function isRestServiceUrl(url: string): boolean {
  return /\/rest\/services\//i.test(url) && !/\/(?:apps|home)\/|mapviewer|viewer\.html|webmap/i.test(url);
}

/** Decode service URLs embedded in ?url=… / &url=… params of viewer links so the
 *  clean REST endpoint is recovered instead of the wrapper. */
function embeddedUrlParams(text: string): string {
  const out: string[] = [];
  for (const m of text.matchAll(/[?&]url=([^"'&<>\s\\)]+)/gi)) {
    try {
      out.push(decodeURIComponent(m[1]));
    } catch {
      out.push(m[1]);
    }
  }
  return out.join('\n');
}

export interface ExtractedEndpoints {
  arcgisServices: string[];
  wfsEndpoints: string[];
  geojsonEndpoints: string[];
  arcgisItemIds: string[];
}

function collect(text: string, re: RegExp): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(re)) {
    const cleaned = trimTrailing(match[0]);
    if (isSafeUrl(cleaned)) out.add(cleaned);
  }
  return [...out];
}

/** Reduce an ArcGIS URL to its service root (drop trailing /{layerId}). */
export function toServiceRoot(url: string): string {
  return url
    .replace(/\/(?:MapServer|FeatureServer)\/\d+.*$/i, (m) => m.replace(/\/\d+.*$/, ''))
    .replace(/\?.*$/, '')
    .replace(/\/+$/, '');
}

export function extractEndpoints(text: string): ExtractedEndpoints {
  // Normalize escaped JSON slashes once so one set of patterns handles HTML,
  // JS bundles, and ArcGIS app config alike.
  const clean = String(text).replace(/\\\//g, '/');
  // Also scan URLs recovered from ?url= viewer params so wrapped REST endpoints
  // are captured standalone.
  const scan = `${clean}\n${embeddedUrlParams(clean)}`;
  const arcgisServices = [...new Set(collect(scan, ARCGIS_RE).filter(isRestServiceUrl).map(toServiceRoot))];
  const wfsEndpoints = collect(clean, WFS_RE);
  const geojsonEndpoints = collect(clean, GEOJSON_RE);
  const arcgisItemIds = [
    ...new Set(
      [...clean.matchAll(WEBMAP_ID_RE)].map((m) => m[1].toLowerCase()).filter((id) => /^[a-f0-9]{32}$/.test(id)),
    ),
  ];
  return { arcgisServices, wfsEndpoints, geojsonEndpoints, arcgisItemIds };
}

/** Classify an extracted endpoint URL into a source type. */
export function endpointSourceType(url: string): ZoningSourceType {
  if (/\/FeatureServer\b/i.test(url)) return 'arcgis-featureserver';
  if (/\/MapServer\b/i.test(url)) return 'arcgis-mapserver';
  if (/\/geoserver\//i.test(url)) return 'geoserver';
  if (/service=wfs|\/wfs\b|\/ows\b/i.test(url)) return 'wfs';
  if (/\.geojson\b/i.test(url)) return 'geojson';
  return 'unknown';
}
