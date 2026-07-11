import type { SiteFeasibilityData, SlopeProfile, CompProperty, FloodZoneInfo, WetlandsInfo, ConstructionCostEstimate, CostLineItem, MaterialTakeoff, MaterialTakeoffItem, LandClearingEstimate, TreeRemovalLine, ClearingMethod, UtilitiesEstimate, UtilityLine, PermitFeeLine } from '../types/feasibility';
import { fetchCountyZoningCode, hasCountyZoning, normalizeCountyKey } from '../data/ncZoning';
import { getSupabase, isSupabaseConfigured } from './supabaseClient';
import { fetchOfficialScParcel, mergeOfficialScParcelRecords, officialRecordFromCountyGis, shouldHideStatewideGeometry } from './scParcelVerification';
import { scCountySource } from '../data/scCountySources';

export interface UserKeys {
  googleMaps?: string;
  gemini?: string;
  /** OPTIONAL second Gemini key. When set, background lookups (cost estimate,
   *  takeoff, tree count/rates, utilities, comp photos) run on THIS key in
   *  their own parallel lane while the report/chat/zoning stay on the primary
   *  key — doubling the per-minute quota so sections finish faster. */
  gemini2?: string;
  /** Perplexity API key — when set, EVERY live web lookup (utilities, tree
   *  rates, cost estimate, takeoff, zoning, LLC trace, the report's research)
   *  runs on the Perplexity Search API (parallel batched queries, many ranked
   *  sources) instead of Gemini's Google-Search grounding. */
  perplexity?: string;
  /** Mapbox public access token (pk.…) — satellite base map for the parcel aerial view. */
  mapbox?: string;
  realtyApi?: string;
  deepSeek?: string;
  rentCast?: string;
  /** Enformion Go API credentials — skip tracing (phones, emails, relatives) for
   *  individuals & businesses from the GIS owner data. */
  enformionApName?: string;
  enformionApPassword?: string;
}

export function getUserKeys(): UserKeys {
  try {
    const hasLocal = typeof localStorage !== 'undefined';
    const hasSession = typeof sessionStorage !== 'undefined';
    const userStr = (hasLocal && localStorage.getItem('gis_active_user')) || (hasSession && sessionStorage.getItem('gis_active_user'));
    if (userStr) {
      const user = JSON.parse(userStr);
      return user.keys || {};
    }
  } catch (e) {
    console.error("Failed to read user keys:", e);
  }
  return {};
}

/** User comp-search preferences (set in Account & API Settings, persisted locally). */
export interface CompPrefs {
  /** Max DRIVING-mile radius for the comp search (3 / 5 / 10). */
  radiusMiles: number;
  /** Default property-type display filter: all | single-family | townhouse | condo | multi-family. */
  propertyType: string;
}
const COMP_PREFS_KEY = 'gis_comp_prefs';
const COMP_RADII = [3, 5, 10];
export function getCompPrefs(): CompPrefs {
  try {
    const p = JSON.parse(localStorage.getItem(COMP_PREFS_KEY) || '{}');
    return {
      radiusMiles: COMP_RADII.includes(p.radiusMiles) ? p.radiusMiles : 5,
      propertyType: typeof p.propertyType === 'string' ? p.propertyType : 'all',
    };
  } catch {
    return { radiusMiles: 5, propertyType: 'all' };
  }
}
export function setCompPrefs(prefs: CompPrefs): void {
  try { localStorage.setItem(COMP_PREFS_KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
}

/** AI report generation mode: auto (default) generates the report right after the
 *  search; manual waits for the user to click "Generate AI Report". */
const REPORT_MODE_KEY = 'gis_report_mode';
export function getReportAutoGenerate(): boolean {
  try { return localStorage.getItem(REPORT_MODE_KEY) !== 'manual'; } catch { return true; }
}
export function setReportAutoGenerate(auto: boolean): void {
  try { localStorage.setItem(REPORT_MODE_KEY, auto ? 'auto' : 'manual'); } catch { /* ignore */ }
}

/** Remove legacy property-search result caches left by earlier app versions. */
export function clearAddressSearchCache(): void {
  try {
    const prefixes = ['gisfs:geo:v1:', 'gisfs:zoning:v2:', 'gisfs:comps:v21:'];
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && prefixes.some((prefix) => key.startsWith(prefix))) localStorage.removeItem(key);
    }
  } catch { /* storage unavailable */ }
}



const NC_GEOCODER = "https://services.nconemap.gov/secure/rest/services/AddressNC/AddressNC_geocoder/GeocodeServer/findAddressCandidates";
const NC_PARCEL_ENGINE = "https://services.gis.nc.gov/secure/rest/services/NC1Map_Parcels/MapServer/1/query";
// Same statewide layer on NC OneMap's other host — tried when the primary is
// down (they fail independently more often than together).
const NC_PARCEL_ENGINE_MIRROR = "https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/MapServer/1/query";
const SC_STATEWIDE_PARCEL_LAYER = "https://smpesri.scdot.org/arcgis/rest/services/GISMapping/SC_Parcels/MapServer/0";

// Only the fields the app actually uses — requesting these instead of `*` keeps
// the response small so the (sometimes overloaded) statewide server is far less
// likely to hit a gateway timeout. The State Plane query needs geometry only.
const NC_PARCEL_FIELDS = "parno,siteadd,gisacres,ownname,ownname2,ownfrst,ownlast,mailadd,mcity,mstate,mzip,scity,parval,landval,saledate,reviseyear,sourceref,legdecfull,cntyname";
export const SC_PARCEL_FIELDS = "T_Map_Number,County,L_Value,M_Value,Ownership,Mailing_Add,Mailing_City,Mailing_St,Mailing_Zip,Zoning,Land_Use,Acreage";

/** Keyless address suggestions from the NC statewide geocoder — the always-
 *  available fallback for the search box when Google Places is unavailable,
 *  slow to initialize, or denied for the API key. */
export async function ncAddressSuggestions(query: string, max = 5): Promise<string[]> {
  const q = query.trim();
  if (q.length < 3) return [];

  // PRIMARY: Google geocoding covers BOTH North & South Carolina and returns the
  // real state in each result — so SC addresses autocomplete and keep their ", SC"
  // suffix instead of being force-labeled NC. Restricted to NC + SC only.
  const key = getUserKeys().googleMaps;
  if (key) {
    try {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}` +
        `&components=country:US&key=${key}`;
      const res = await fetchWithTimeout(url, 6000);
      if (res.ok) {
        const j = await res.json();
        const out: string[] = [];
        for (const r of (j.results || [])) {
          const comps = r.address_components || [];
          const st = comps.find((c: any) => c.types?.includes('administrative_area_level_1'));
          const sc = String(st?.short_name || '').toUpperCase();
          if (sc !== 'NC' && sc !== 'SC') continue; // Carolinas only
          const a = String(r.formatted_address || '').replace(/,?\s*USA$/i, '').trim();
          if (a && !out.includes(a)) out.push(a);
        }
        if (out.length) return out.slice(0, max);
      }
    } catch { /* fall through to the NC state geocoder */ }
  }

  // FALLBACK: NC statewide address locator (NC coverage only).
  try {
    const url = `${NC_GEOCODER}?SingleLine=${encodeURIComponent(q)}&maxLocations=${max}&outFields=&f=json`;
    const res = await fetchWithTimeout(url, 6000);
    if (!res.ok) return [];
    const j = await res.json();
    const out: string[] = [];
    for (const c of (j.candidates || [])) {
      let a = String(c.address || '').trim();
      if (!a) continue;
      if (!/\b(NC|SC)\b/i.test(a)) a += ', NC';
      if (!out.includes(a)) out.push(a);
    }
    return out.slice(0, max);
  } catch { return []; }
}

/** fetch() with an abort timeout so a hung GIS server fails fast instead of stalling the UI. */
async function fetchWithTimeout(url: string, ms = 20000, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * fetch() with per-attempt timeout and retries. The NC statewide GIS server is
 * intermittently slow, so a single hang shouldn't fail the whole search — we
 * retry a few times (with brief backoff) before giving up. Throws only if every
 * attempt fails or returns a non-OK status.
 */
async function fetchWithRetry(url: string, attempts = 3, timeoutMs = 8000, init?: RequestInit): Promise<Response> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchWithTimeout(url, timeoutMs, init);
      if (res.ok) return res;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastError = e;
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 500 * (i + 1)));
  }
  throw lastError instanceof Error ? lastError : new Error("request failed after retries");
}

// ---------------------------------------------------------------------------
// GEMINI REQUEST GATE — every Gemini API request in the app passes through this
// single-slot queue, so requests run ONE AT A TIME with a short spacing delay
// instead of bursting in parallel (a search fires the zoning lookup, cost
// estimate, takeoff, tree count, tree rates, utilities, comp-photo picks and
// the report on the SAME key at once — that burst is what trips the per-minute
// rate limit and made sections fail with 429s).
// Two priorities: 'high' (report/chat streams, zoning — user-facing, blocking)
// jumps ahead of pending 'low' background lookups. The gate is held only for
// the REQUEST itself (rate limits count requests), not for long SSE streams.
// ---------------------------------------------------------------------------
const GEMINI_SPACING_MS = 800;

/** The key BACKGROUND lookups run on: the optional second Gemini key when
 *  configured (its own quota + its own queue lane), else the primary key. */
export function getBackgroundGeminiKey(): string {
  const k = getUserKeys();
  return ((k.gemini2 || '').trim() || (k.gemini || '').trim());
}
/** True when a DISTINCT second Gemini key is configured — unlocks the second
 *  parallel request lane (each key has its own per-minute quota). */
function hasSecondGeminiKey(): boolean {
  const k = getUserKeys();
  const k2 = (k.gemini2 || '').trim();
  return !!k2 && k2 !== (k.gemini || '').trim();
}

// Priorities: 'high' = report/chat/zoning (user-facing, blocking) · 'low' =
// section lookups (cost, takeoff, trees, utilities) · 'idle' = cosmetic bulk
// work (comp exterior-photo picks) that must NEVER starve the sections — a
// low-priority retry re-enters ahead of every queued idle task.
type GeminiPriority = 'high' | 'low' | 'idle';
interface GeminiLane { high: (() => void)[]; low: (() => void)[]; idle: (() => void)[]; busy: boolean }
const geminiLanes: [GeminiLane, GeminiLane] = [
  { high: [], low: [], idle: [], busy: false }, // primary key lane
  { high: [], low: [], idle: [], busy: false }, // second key lane (when configured)
];
function pumpGeminiLane(lane: GeminiLane): void {
  if (lane.busy) return;
  const next = lane.high.shift() || lane.low.shift() || lane.idle.shift();
  if (!next) return;
  lane.busy = true;
  next();
}
function queueGemini<T>(task: () => Promise<T>, priority: GeminiPriority = 'low', laneKind: 'primary' | 'background' = 'primary'): Promise<T> {
  // Primary-key, user-facing work fires IMMEDIATELY and in PARALLEL so it stays
  // fast: the report, chat and zoning ('high'), plus any primary-lane 'low'.
  // Two kinds of work are SERIALIZED through a single-slot lane — one request at
  // a time, spaced by GEMINI_SPACING_MS:
  //  · 'idle' bulk work (comp exterior-photo picks) — must never eat the quota
  //    the sections need; and
  //  · BACKGROUND section lookups on key #2 ('low' + laneKind 'background') —
  //    cost estimate, takeoff, tree count/rates and utilities otherwise hit
  //    key #2 all at once and trip its per-minute quota (429). Running them
  //    one-at-a-time keeps the second key under its limit.
  const background = laneKind === 'background' && hasSecondGeminiKey();
  const serialize = priority === 'idle' || (background && priority !== 'high');
  if (!serialize) return task();
  const lane = geminiLanes[background ? 1 : 0];
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      task().then(resolve, reject).finally(() => {
        setTimeout(() => { lane.busy = false; pumpGeminiLane(lane); }, GEMINI_SPACING_MS);
      });
    };
    lane[priority].push(start);
    pumpGeminiLane(lane);
  });
}

// ---------------------------------------------------------------------------
// PERPLEXITY SEARCH API — the live web-search engine for every lookup that
// previously used Gemini's Google-Search grounding. Raw ranked results with
// extracted page content, fetched in PARALLEL BATCHES (up to 5 queries per
// request, multiple requests in flight) so each generation is grounded on MANY
// sources. The synthesis stays on Gemini; only the SEARCHING moves here.
// Docs: https://docs.perplexity.ai/docs/search/quickstart
// ---------------------------------------------------------------------------

export function getPerplexityKey(): string {
  const envVar = (typeof import.meta !== 'undefined' && import.meta.env)
    ? import.meta.env.VITE_PERPLEXITY_API_KEY
    : (globalThis as any).process?.env?.VITE_PERPLEXITY_API_KEY;
  return (getUserKeys().perplexity || (envVar as string | undefined) || '').trim();
}
export function perplexityConfigured(): boolean {
  return !!getPerplexityKey();
}

export function liveWebResearchConfigured(): boolean {
  return perplexityConfigured();
}

export interface PplxResult { title: string; url: string; snippet: string; date?: string }
export interface CrawleeResult {
  title: string;
  url: string;
  content: string;
  snippet: string;
  kind: 'html' | 'pdf' | 'docx' | 'xlsx' | 'csv' | 'json' | 'text';
  contentType?: string;
  date?: string;
}

type WebResearchMode = 'auto' | 'easy' | 'hard' | 'perplexity' | 'crawlee';
interface WebResearchOptions {
  maxResultsPerQuery?: number;
  maxSources?: number;
  mode?: WebResearchMode;
}

const SCRAPE_HEAVY_QUERY_RE = /\b(ordinance|code\s+of\s+ordinances|zoning\s+(map|ordinance|district|lookup)|parcel\s+viewer|gis|planning\s+department|permit\s+fees?|fee\s+schedule|tap\s+fees?|impact\s+fees?|water\s+sewer|utilities|well\s+septic|minimum\s+lot|setbacks?|subdivision|rezoning|registered\s+agent|secretary\s+of\s+state|annual\s+report|bizapedia|corporationwiki|contractor|material\s+prices?|construction\s+costs?)\b/i;

function wantsCrawleeResearch(queries: string[], opts?: WebResearchOptions): boolean {
  if (opts?.mode === 'crawlee' || opts?.mode === 'hard') return true;
  if (opts?.mode === 'perplexity' || opts?.mode === 'easy') return false;
  return queries.some((q) => SCRAPE_HEAVY_QUERY_RE.test(q));
}

async function crawleeScrapeBatch(urls: string[], queries: string[]): Promise<CrawleeResult[]> {
  const targets = [...new Set(urls.map((url) => url.trim()).filter(Boolean))].slice(0, 8);
  if (!targets.length) return [];
  try {
    const response = await fetchWithTimeout('/.netlify/functions/crawlee', 30000, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        urls: targets,
        queries,
        maxPages: Math.min(12, Math.max(6, targets.length + 4)),
        maxDepth: 1,
        maxCharsPerPage: 14000,
      }),
    });
    if (!response.ok) {
      console.warn(`Crawlee scraper HTTP ${response.status}:`, (await response.text().catch(() => '')).slice(0, 250));
      return [];
    }
    const payload = await response.json();
    return Array.isArray(payload?.data?.results) ? payload.data.results : [];
  } catch (error) {
    console.warn('Crawlee scraper failed:', error);
    return [];
  }
}

function formatCrawleeSources(results: CrawleeResult[], maxSources = 24, maxSnippetChars = 1400): string {
  return results.slice(0, maxSources).map((r, i) => {
    const body = (r.content || r.snippet || '').slice(0, maxSnippetChars);
    return `[${i + 1}] ${r.title}${r.date ? ` (${r.date})` : ''} [${r.kind}]\nURL: ${r.url}\n${body}`;
  }).join('\n\n');
}

async function crawleeResearchBlock(searchResults: PplxResult[], queries: string[], opts?: WebResearchOptions): Promise<{ block: string; urls: string[] }> {
  const results = await crawleeScrapeBatch(searchResults.map((result) => result.url), queries);
  if (!results.length) return { block: '', urls: [] };
  return {
    block: `\n\nLIVE WEB RESEARCH (Perplexity discovery + Crawlee page/document extraction). Base every figure on THESE extracted sources and cite their URLs in "sources"; do not invent anything beyond them:\n\n${formatCrawleeSources(results, opts?.maxSources ?? 24)}`,
    urls: results.map((r) => r.url),
  };
}

/** One POST to the Search API (one batch of up to 5 queries). Same-origin proxy
 *  FIRST — /.netlify/functions/perplexity works both in prod (Netlify function)
 *  and in dev (Vite server proxy), and skips the CORS-doomed browser-direct
 *  call; the direct URL stays only as a last-ditch route. 2 attempts per route. */
async function perplexitySearchRequest(body: Record<string, unknown>, key: string): Promise<any | null> {
  const payload = JSON.stringify(body);
  const routes: { url: string; timeout: number }[] = [
    { url: '/.netlify/functions/perplexity', timeout: 25000 },
    { url: 'https://api.perplexity.ai/search', timeout: 25000 },
  ];
  for (const route of routes) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetchWithTimeout(route.url, route.timeout, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: payload,
        });
        if (res.ok) return await res.json();
        if ((res.status === 429 || res.status >= 500) && attempt === 0) { await new Promise((r) => setTimeout(r, 1500)); continue; }
        // 4xx (bad key, bad request): same result on the other route — stop.
        if (res.status < 500 && res.status !== 429) {
          console.warn(`Perplexity search HTTP ${res.status}:`, (await res.text().catch(() => '')).slice(0, 200));
          return null;
        }
        break; // exhausted retries on this route — try the next route
      } catch {
        if (attempt === 0) { await new Promise((r) => setTimeout(r, 800)); continue; }
        // network/CORS failure — fall through to the proxy route
      }
    }
  }
  return null;
}

/** Flatten the Search API response (single-query = flat list; multi-query =
 *  grouped per query) into one PplxResult list. */
function flattenPplxResults(data: any): PplxResult[] {
  const out: PplxResult[] = [];
  const push = (r: any) => {
    if (r && typeof r.url === 'string' && r.url) {
      out.push({ title: String(r.title || r.url), url: r.url, snippet: String(r.snippet || ''), date: r.date ? String(r.date) : undefined });
    }
  };
  const results = data?.results;
  if (Array.isArray(results)) {
    for (const item of results) {
      if (Array.isArray(item)) item.forEach(push);        // grouped per query
      else if (Array.isArray(item?.results)) item.results.forEach(push);
      else push(item);                                     // flat list
    }
  }
  return out;
}

/**
 * PARALLEL BATCHED web search: any number of queries, chunked into multi-query
 * requests of up to 5, ALL chunks fired simultaneously (Promise.all), results
 * merged + deduped by URL. Returns [] when no key / everything failed.
 */
export async function perplexitySearchBatch(
  queries: string[],
  opts?: { maxResultsPerQuery?: number; maxTokensPerPage?: number; country?: string },
): Promise<PplxResult[]> {
  const key = getPerplexityKey();
  const qs = queries.map((q) => q.trim()).filter(Boolean);
  if (!key || qs.length === 0) return [];
  const chunks: string[][] = [];
  for (let i = 0; i < qs.length; i += 5) chunks.push(qs.slice(i, i + 5));
  const bodies = chunks.map((chunk) => ({
    query: chunk.length === 1 ? chunk[0] : chunk,
    max_results: Math.min(20, Math.max(1, opts?.maxResultsPerQuery ?? 6)),
    max_tokens_per_page: opts?.maxTokensPerPage ?? 1024,
    country: opts?.country ?? 'US',
  }));
  const responses = await Promise.all(bodies.map((b) => perplexitySearchRequest(b, key)));
  const seen = new Set<string>();
  const merged: PplxResult[] = [];
  for (const resp of responses) {
    for (const r of flattenPplxResults(resp)) {
      if (!seen.has(r.url)) { seen.add(r.url); merged.push(r); }
    }
  }
  return merged;
}

/** Format search results as a numbered source pack for a model prompt. */
function formatPplxSources(results: PplxResult[], maxSources = 24, maxSnippetChars = 1200): string {
  return results.slice(0, maxSources).map((r, i) =>
    `[${i + 1}] ${r.title}${r.date ? ` (${r.date})` : ''}\nURL: ${r.url}\n${r.snippet.slice(0, maxSnippetChars)}`,
  ).join('\n\n');
}

/** The research block injected into a Gemini prompt in place of Google-Search
 *  grounding: many ranked sources with extracted content. '' = nothing found. */
async function perplexityResearchBlock(queries: string[], opts?: WebResearchOptions): Promise<{ block: string; urls: string[] }> {
  const results = await perplexitySearchBatch(queries, { maxResultsPerQuery: opts?.maxResultsPerQuery ?? 6 });
  if (!results.length) return { block: '', urls: [] };
  if (wantsCrawleeResearch(queries, opts)) {
    const crawled = await crawleeResearchBlock(results, queries, opts);
    if (crawled.block) return crawled;
  }
  return {
    block: `\n\nLIVE WEB SEARCH RESULTS (Perplexity Search API — ranked, current, with extracted page content). Base every figure on THESE sources and cite their URLs in "sources"; do not invent anything beyond them:\n\n${formatPplxSources(results, opts?.maxSources ?? 24)}`,
    urls: results.map((r) => r.url),
  };
}

export interface ZoningStandards {
  lotType: string;
  maxHeightFt: number;
  floorAreaRatio: number;
  setbacks: { frontFt: number; rearFt: number; sideFt: number };
}

/**
 * Typical dimensional standards for a zoning district, inferred from the district
 * code / use category. These are ESTIMATES for early feasibility screening only —
 * actual setbacks, height, and FAR must be confirmed against the jurisdiction's
 * zoning ordinance. There is no free authoritative API publishing per-district
 * standards across NC's 100 counties, so we approximate by use category and label
 * the values as estimates throughout the UI.
 */
export function estimateZoningStandards(code: string, desc: string): ZoningStandards {
  const c = (code || "").toUpperCase();
  const d = (desc || "").toLowerCase();

  if (c.includes("UMUD") || /mixed.?use|uptown/.test(d)) {
    return { lotType: "interior", maxHeightFt: 80, floorAreaRatio: 2.5, setbacks: { frontFt: 10, rearFt: 10, sideFt: 0 } };
  }
  if (c.startsWith("TOD") || /transit/.test(d)) {
    return { lotType: "interior", maxHeightFt: 65, floorAreaRatio: 1.8, setbacks: { frontFt: 10, rearFt: 10, sideFt: 5 } };
  }
  if (/^(B-|CG|CB|C-|O-|M-|I-|HC|GB|LB)/.test(c) || /commercial|business|industrial|office|retail/.test(d)) {
    return { lotType: "interior", maxHeightFt: 50, floorAreaRatio: 0.8, setbacks: { frontFt: 20, rearFt: 15, sideFt: 8 } };
  }
  if (/^(MF|UR-|RM|RMX|MX)/.test(c) || /multi.?family|apartment|townhome|townhouse|condo/.test(d)) {
    return { lotType: "interior", maxHeightFt: 45, floorAreaRatio: 1.0, setbacks: { frontFt: 20, rearFt: 20, sideFt: 10 } };
  }
  // Default: low-density / single-family residential
  return { lotType: "interior", maxHeightFt: 35, floorAreaRatio: 0.35, setbacks: { frontFt: 30, rearFt: 25, sideFt: 12 } };
}


// All 100 NC counties share the same statewide geocoder + parcel engine, so the
// config is generated from the county list instead of 100 hand-written entries.
const NC_COUNTY_NAMES = [
  "Alamance", "Alexander", "Alleghany", "Anson", "Ashe", "Avery", "Beaufort", "Bertie", "Bladen", "Brunswick",
  "Buncombe", "Burke", "Cabarrus", "Caldwell", "Camden", "Carteret", "Caswell", "Catawba", "Chatham", "Cherokee",
  "Chowan", "Clay", "Cleveland", "Columbus", "Craven", "Cumberland", "Currituck", "Dare", "Davidson", "Davie",
  "Duplin", "Durham", "Edgecombe", "Forsyth", "Franklin", "Gaston", "Gates", "Graham", "Granville", "Greene",
  "Guilford", "Halifax", "Harnett", "Haywood", "Henderson", "Hertford", "Hoke", "Hyde", "Iredell", "Jackson",
  "Johnston", "Jones", "Lee", "Lenoir", "Lincoln", "Macon", "Madison", "Martin", "McDowell", "Mecklenburg",
  "Mitchell", "Montgomery", "Moore", "Nash", "New Hanover", "Northampton", "Onslow", "Orange", "Pamlico",
  "Pasquotank", "Pender", "Perquimans", "Person", "Pitt", "Polk", "Randolph", "Richmond", "Robeson", "Rockingham",
  "Rowan", "Rutherford", "Sampson", "Scotland", "Stanly", "Stokes", "Surry", "Swain", "Transylvania", "Tyrrell",
  "Union", "Vance", "Wake", "Warren", "Washington", "Watauga", "Wayne", "Wilkes", "Wilson", "Yadkin", "Yancey",
] as const;

const SC_COUNTY_NAMES = [
  "Abbeville", "Aiken", "Allendale", "Anderson", "Bamberg", "Barnwell", "Beaufort", "Berkeley", "Calhoun", "Charleston",
  "Cherokee", "Chester", "Chesterfield", "Clarendon", "Colleton", "Darlington", "Dillon", "Dorchester", "Edgefield", "Fairfield",
  "Florence", "Georgetown", "Greenville", "Greenwood", "Hampton", "Horry", "Jasper", "Kershaw", "Lancaster", "Laurens",
  "Lee", "Lexington", "Marion", "Marlboro", "McCormick", "Newberry", "Oconee", "Orangeburg", "Pickens", "Richland",
  "Saluda", "Spartanburg", "Sumter", "Union", "Williamsburg", "York",
] as const;

const SC_COUNTY_FIPS: Record<(typeof SC_COUNTY_NAMES)[number], string> = {
  Abbeville: '45001', Aiken: '45003', Allendale: '45005', Anderson: '45007', Bamberg: '45009',
  Barnwell: '45011', Beaufort: '45013', Berkeley: '45015', Calhoun: '45017', Charleston: '45019',
  Cherokee: '45021', Chester: '45023', Chesterfield: '45025', Clarendon: '45027', Colleton: '45029',
  Darlington: '45031', Dillon: '45033', Dorchester: '45035', Edgefield: '45037', Fairfield: '45039',
  Florence: '45041', Georgetown: '45043', Greenville: '45045', Greenwood: '45047', Hampton: '45049',
  Horry: '45051', Jasper: '45053', Kershaw: '45055', Lancaster: '45057', Laurens: '45059',
  Lee: '45061', Lexington: '45063', Marion: '45067', Marlboro: '45069', McCormick: '45065',
  Newberry: '45071', Oconee: '45073', Orangeburg: '45075', Pickens: '45077', Richland: '45079',
  Saluda: '45081', Spartanburg: '45083', Sumter: '45085', Union: '45087', Williamsburg: '45089', York: '45091',
};

type SupportedState = 'NC' | 'SC';
interface CountyAtPointResult { name: string; state: SupportedState }

const countyBaseName = (countyName: string): string =>
  String(countyName || '').split(',')[0].replace(/\s+County$/i, '').trim();

const countyState = (countyName: string): SupportedState => {
  const m = String(countyName || '').match(/,\s*(NC|SC)\s*$/i);
  if (m) return m[1].toUpperCase() as SupportedState;
  const base = countyBaseName(countyName);
  if (SC_COUNTY_NAMES.some((n) => n.toLowerCase() === base.toLowerCase()) &&
      !NC_COUNTY_NAMES.some((n) => n.toLowerCase() === base.toLowerCase())) return 'SC';
  return 'NC';
};

const countyDisplayName = (countyName: string): string =>
  `${countyBaseName(countyName)} County, ${countyState(countyName)}`;

const countyParcelLayerKey = (countyName: string): string => normalizeCountyKey(countyBaseName(countyName));

const countyParcelLayerFor = (countyName: string, state: SupportedState): string | undefined => {
  const key = countyParcelLayerKey(countyName);
  return state === 'SC'
    ? countyParcelLayers[`${key}_sc`] || countyParcelLayers[key]
    : countyParcelLayers[key];
};

const getStateFromCoords = (lat: number, lng: number): SupportedState => {
  if (lat > 35.25) return 'NC';
  if (lat < 32.0) return 'SC';
  if (lng > -78.5) return 'NC';
  const borderLat = 33.85 - 0.3325 * (lng + 78.54);
  if (lat < borderLat) return 'SC';
  return 'NC';
};

export const ncCountyConfig: Record<string, { geocodeUrl: string; parcelUrl: string; extraWhere: string }> =
  Object.fromEntries(
    [
      ...NC_COUNTY_NAMES.flatMap((name) => {
        const config = { geocodeUrl: NC_GEOCODER, parcelUrl: NC_PARCEL_ENGINE, extraWhere: `cntyname = '${name}'` };
        return [[name, config], [`${name}, NC`, config]] as const;
      }),
      ...SC_COUNTY_NAMES.flatMap((name) => {
        const config = { geocodeUrl: "", parcelUrl: SC_STATEWIDE_PARCEL_LAYER, extraWhere: `County = '${name.toUpperCase()}'` };
        const qualified = [`${name}, SC`, config] as const;
        const overlapsNc = NC_COUNTY_NAMES.some((n) => n.toLowerCase() === name.toLowerCase());
        return overlapsNc ? [qualified] : [qualified, [name, config] as const];
      }),
    ],
  );

/**
 * State Plane coordinate bounds lookup helper (Mecklenburg-specific)
 */
async function queryStatePlaneBounds(lng: number, lat: number) {
  const queryParams = new URLSearchParams({
    geometry: `${lng},${lat}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "*",
    returnGeometry: "true",
    f: "json"
  });
  
  const url = `https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/MapServer/1/query?${queryParams.toString()}`;
  try {
    const res = await fetchWithTimeout(url, 8000);
    if (res.ok) {
      const data = await res.json();
      if (data.features && data.features.length > 0) {
        const rings = data.features[0].geometry?.rings;
        if (rings && rings[0] && rings[0][0]) {
          return {
            x: rings[0][0][0],
            y: rings[0][0][1]
          };
        }
      }
    }
  } catch (e) {
    console.error("Error fetching state plane coordinates:", e);
  }
  return null;
}

/**
 * Title cases a string (e.g. "JEFFREY A HARPER" -> "Jeffrey A Harper")
 */
function toTitleCase(str: string): string {
  return str.toLowerCase().replace(/(?:^|\s|-|\/)\S/g, (m) => m.toUpperCase());
}

/**
 * Formats an owner name with the FIRST name first, then the LAST name.
 * County GIS records store personal names as "LAST, FIRST MIDDLE" or
 * "LAST FIRST MIDDLE" (no comma); both are reordered to "First Middle Last"
 * (suffixes like Jr/Sr/III stay after the last name). Business names
 * (LLC, INC, TRUST, etc.) are left as-is. Returns a title-cased string.
 */
/** Reorder ONE person's stored name to "First Middle Last [Suffix]" and title-case
 *  it. Handles both "LAST, FIRST MIDDLE" (comma) and "LAST FIRST MIDDLE [SUFFIX]"
 *  (surname-first, no comma) storage. Business detection is handled by the caller. */
function formatSingleOwnerName(name: string): string {
  name = name.trim().replace(/\s+/g, " ");
  if (!name) return "";
  if (name.includes(",")) {
    // "LAST, FIRST MIDDLE" → "First Middle Last"
    const idx = name.indexOf(",");
    const last = name.slice(0, idx).trim();
    const rest = name.slice(idx + 1).trim().replace(/,/g, " ").replace(/\s+/g, " ");
    if (last && rest) name = `${rest} ${last}`;
  } else {
    // "LAST FIRST MIDDLE [SUFFIX]" → "First Middle Last [Suffix]"
    const parts = name.split(" ");
    if (parts.length >= 2 && parts.length <= 4) {
      const suffixes: string[] = [];
      while (parts.length > 2 && /^(JR|SR|II|III|IV|V)\.?$/i.test(parts[parts.length - 1])) {
        suffixes.unshift(parts.pop() as string);
      }
      const last = parts.shift() as string;
      name = [...parts, last, ...suffixes].join(" ");
    }
  }
  return toTitleCase(name);
}

function formatOwnerName(raw?: string): string {
  if (!raw || !String(raw).trim()) return "N/A";
  let name = String(raw).trim().replace(/\s+/g, " ");
  // Strip a trailing "ET AL" / "ETAL" ("and others") so it isn't mistaken for a
  // business token or a co-owner name.
  name = name.replace(/[,\s]+ET\s?AL\.?\s*$/i, "").trim();
  if (!name) return "N/A";
  if (/^(N\/?A|NONE|UNKNOWN|NOT AVAILABLE)$/i.test(name)) return "N/A";

  const isBusiness = /\b(LLC|L\.?L\.?C|INC|CORP|CO|COMPANY|TRUST|TRUSTEES?|LP|LLP|PARTNERS(HIP)?|HOLDINGS|PROPERTIES|INVESTMENTS?|VENTURES?|GROUP|REALTY|HOMES|BUILDERS|DEVELOPMENT|ASSOCIATION|ASSOC|HOA|CHURCH|CITY|TOWN|COUNTY|STATE|ESTATE|BANK)\b/i.test(name);
  if (isBusiness) return toTitleCase(name);

  // Joint owners: "&", "/", or "AND" separates co-owners. Format each side; when a
  // co-owner has no surname of their own — e.g. "SMITH JOHN A & MARY B", where
  // "MARY B" is only a given name (+ middle initial) — borrow the first owner's
  // surname so it reads "Mary B Smith" instead of just "B Mary".
  const parts = name.split(/\s*(?:&|\/|\bAND\b)\s*/i).map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const first = parts[0];
    const firstHasComma = first.includes(",");
    const firstSurname = (firstHasComma ? first.slice(0, first.indexOf(",")) : first.split(" ")[0]).trim();
    const formatted = [formatSingleOwnerName(first)];
    for (let i = 1; i < parts.length; i++) {
      let co = parts[i];
      const coTokens = co.split(" ").filter(Boolean);
      const lacksSurname = !co.includes(",") &&
        (coTokens.length === 1 || (coTokens.length === 2 && /^[A-Z]\.?$/i.test(coTokens[1])));
      if (lacksSurname && firstSurname) {
        // Re-attach the first owner's surname in the same storage form so the
        // single-name formatter reorders it correctly.
        co = firstHasComma ? `${firstSurname}, ${co}` : `${firstSurname} ${co}`;
      }
      formatted.push(formatSingleOwnerName(co));
    }
    return formatted.join(" & ");
  }

  return formatSingleOwnerName(name);
}

/** True when a parcel owner is a roadway / DOT right-of-way rather than a private
 *  lot — e.g. "SCDOT", "NCDOT", "DEPT OF TRANSPORTATION", "HIGHWAY", "ROAD R/W",
 *  "RIGHT OF WAY". A point query near a property edge can intersect the adjacent
 *  road segment, so these are skipped in favor of the actual lot parcel. */
function isRoadwayOwner(owner?: string): boolean {
  if (!owner) return false;
  const s = String(owner).toUpperCase().replace(/\./g, "");
  return /\b(NCDOT|SCDOT|DEPT? OF TRANS(PORTATION)?|DEPARTMENT OF TRANSPORTATION|STATE HIGHWAY|HIGHWAYS?|RIGHT[\s-]?OF[\s-]?WAY|R\/W|ROADWAY)\b/.test(s)
    || /\bROAD (R\/?W|RIGHT|ROW)\b/.test(s);
}

/** Shoelace polygon area (sum of signed rings, so holes subtract) for rings of
 *  [x,y] coordinates in a planar unit. Returns the absolute area in that unit². */
function ringAreaPlanar(rings: number[][][]): number {
  if (!rings || !rings.length) return 0;
  let total = 0;
  for (const ring of rings) {
    if (!ring || ring.length < 4) continue;
    let a = 0;
    for (let i = 0; i < ring.length - 1; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    total += a / 2;
  }
  return Math.abs(total);
}

/** Area-weighted centroid of one polygon ring ([x,y][]); falls back to the
 *  vertex mean for degenerate rings. Used to place owner labels on parcels. */
function ringCentroid(ring: number[][]): [number, number] | null {
  if (!ring || ring.length < 3) return null;
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const cross = ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    a += cross;
    cx += (ring[i][0] + ring[i + 1][0]) * cross;
    cy += (ring[i][1] + ring[i + 1][1]) * cross;
  }
  a /= 2;
  if (Math.abs(a) < 1e-12) {
    const n = ring.length;
    return [ring.reduce((s, p) => s + p[0], 0) / n, ring.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (6 * a), cy / (6 * a)];
}

/**
 * All parcels (with owner names) intersecting a WGS84 bounding box, from the
 * NC OneMap statewide parcel layer — powers the LandGlide-style owner-name
 * labels on the satellite map. Returns GeoJSON: parcel outline polygons plus
 * one label point per parcel (owner, address, acres), or null on failure.
 */
export async function fetchParcelsInBbox(west: number, south: number, east: number, north: number, _countyName?: string): Promise<{ polygons: any; labels: any } | null> {
  try {
    const centerLat = (south + north) / 2;
    const centerLng = (west + east) / 2;
    const state = getStateFromCoords(centerLat, centerLng);
    const engineUrl = state === 'NC' ? NC_PARCEL_ENGINE : `${SC_STATEWIDE_PARCEL_LAYER}/query`;
    const outFields = state === 'NC' ? 'ownname,parno,siteadd,gisacres' : SC_PARCEL_FIELDS;

    const url = `${engineUrl}?geometry=${west},${south},${east},${north}` +
      `&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects` +
      `&outFields=${encodeURIComponent(outFields)}` +
      `&returnGeometry=true&outSR=4326&resultRecordCount=400&f=json`;
    const res = await fetchWithTimeout(url, 15000);
    if (!res.ok) return null;
    const data = await res.json();
    const feats = Array.isArray(data?.features) ? data.features : [];
    const polygons: any[] = [];
    const labels: any[] = [];
    for (const f of feats) {
      const rings: number[][][] = f?.geometry?.rings;
      if (!rings || !rings.length) continue;
      let rawOwner = '';
      let parno = '';
      let siteadd = '';
      let acresRaw: any;
      rawOwner = String((state === 'NC' ? f.attributes?.ownname : f.attributes?.Ownership) || '').trim();
      parno = String((state === 'NC' ? f.attributes?.parno : f.attributes?.T_Map_Number) || '');
      siteadd = String((state === 'NC' ? f.attributes?.siteadd : '') || '').trim();
      acresRaw = state === 'NC' ? f.attributes?.gisacres : f.attributes?.Acreage;
      const owner = rawOwner ? formatOwnerName(rawOwner).toUpperCase() : '';
      polygons.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: rings }, properties: { parno, owner, siteadd } });
      if (!owner || owner === 'N/A') continue;
      // Label at the centroid of the largest ring (outer boundary).
      let biggest = rings[0], biggestArea = -1;
      for (const r of rings) {
        const area = ringAreaPlanar([r]);
        if (area > biggestArea) { biggestArea = area; biggest = r; }
      }
      const c = ringCentroid(biggest);
      if (!c) continue;
      const acres = Number(acresRaw);
      labels.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: c },
        properties: { owner, parno, siteadd, acres: Number.isFinite(acres) && acres > 0.005 && acres < 100000 ? Math.round(acres * 100) / 100 : null },
      });
    }
    return {
      polygons: { type: 'FeatureCollection', features: polygons },
      labels: { type: 'FeatureCollection', features: labels },
    };
  } catch { return null; }
}

/** Parcel acreage computed from its polygon — State Plane feet preferred, else a
 *  local-projection of the WGS84 ring. Reliable when a county's recorded gisacres
 *  is missing/garbage (e.g. Cumberland stores a near-zero value). */
function acresFromGeometry(statePlaneRings: number[][][], wgs84Rings: number[][][], lat: number): number {
  const sp = ringAreaPlanar(statePlaneRings) / 43560; // State Plane is in feet
  if (sp > 0.0005) return sp;
  if (wgs84Rings && wgs84Rings.length) {
    const ftPerDegLat = 364320; // ~ft per degree latitude
    const ftPerDegLng = ftPerDegLat * Math.cos((lat * Math.PI) / 180);
    const ringsFt = wgs84Rings.map((r) => r.map((p) => [p[0] * ftPerDegLng, p[1] * ftPerDegLat]));
    return ringAreaPlanar(ringsFt) / 43560;
  }
  return 0;
}

/**
 * Minimum-area oriented bounding box of a polygon ring given in NC State Plane
 * feet. Returns the lot's true width (shorter side) and depth (longer side) by
 * testing the box aligned to each edge — accurate for irregular/angled lots,
 * unlike approximating the lot as a rectangle from its perimeter and area.
 */
function orientedBoundingBox(ring: number[][]): { width: number; depth: number } | null {
  const pts = ring.filter((p, i) => i === 0 || p[0] !== ring[i - 1][0] || p[1] !== ring[i - 1][1]);
  if (pts.length < 3) return null;
  let best: { area: number; w: number; d: number } | null = null;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const cos = Math.cos(-ang);
    const sin = Math.sin(-ang);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of pts) {
      const x = p[0] * cos - p[1] * sin;
      const y = p[0] * sin + p[1] * cos;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const w = maxX - minX;
    const d = maxY - minY;
    const area = w * d;
    if (!best || area < best.area) best = { area, w, d };
  }
  if (!best) return null;
  return { width: Math.min(best.w, best.d), depth: Math.max(best.w, best.d) };
}

// ---------------------------------------------------------------------------
// County parcel fallback. When the statewide NC OneMap parcel service is slow or
// down, we query the county's own parcel server (separate, reliable hosts).
// Field names vary widely per county, so attributes are mapped to the statewide
// schema heuristically; the State Plane query uses the layer's native SR
// (NC State Plane, EPSG:2264) for accurate measurements.
// ---------------------------------------------------------------------------

/** Base query URLs (no trailing /query) for single-layer county parcel servers. */
// 68 counties, every entry LIVE-VERIFIED (scratch/verify-county-gis.mjs): each
// layer answered the app's exact point query (geojson + native State Plane) at
// BOTH the county courthouse and a rural point, with PIN/owner-grade
// attributes — so it serves the whole county, not just a town. Mecklenburg is
// intentionally absent (it has its own two-layer CAMA-enriched path). The 31
// missing counties expose no public ArcGIS REST endpoint (viewer-only
// products); they fall back to the statewide hosts, then the simulated
// outline. Re-run the script to refresh/expand this list.
const countyParcelLayers: Record<string, string> = {
  alamance: "https://maps.regisnc.org/arcgis/rest/services/BASE/ParcelsOnline/MapServer/0",
  alexander: "https://services2.arcgis.com/Gg1zRGd1dMABDyPS/arcgis/rest/services/Smart_Gov/FeatureServer/0",
  alleghany: "https://www.webgis.net/arcgis/rest/services/NC/Alleghany/MapServer/11",
  anson: "https://services2.arcgis.com/gpWTUptGs0ubXJ8Q/arcgis/rest/services/Anson_WFL1/FeatureServer/3",
  ashe: "https://services1.arcgis.com/vj28eVZMB2OMIUh5/arcgis/rest/services/AsheCountyParcels_201706/FeatureServer/0",
  avery: "https://services1.arcgis.com/vj28eVZMB2OMIUh5/arcgis/rest/services/Avery_County_Parcels_covering_Banner_Elk_Town_Limits/FeatureServer/0",
  brunswick: "https://bcgis.brunswickcountync.gov/arcgis/rest/services/Layers/TaxParcels/MapServer/0",
  buncombe: "https://gis.buncombecounty.org/arcgis/rest/services/opendata/MapServer/1",
  burke: "https://services3.arcgis.com/axQ4OCSpcxALIQsV/arcgis/rest/services/Burke_County_Base_Data_WL/FeatureServer/10",
  cabarrus: "https://location.cabarruscounty.us/arcgisservices/rest/services/Tax_Parcels_Full/MapServer/0",
  camden: "https://services7.arcgis.com/f8vjF7CsMeTPBIVC/arcgis/rest/services/Parcels_View/FeatureServer/1",
  carteret: "https://arcgisweb.carteretcountync.gov/arcgis/rest/services/Layers/Parceldata/FeatureServer/0",
  caswell: "https://www.webgis.net/arcgis/rest/services/NC/Caswell/MapServer/9",
  catawba: "https://services1.arcgis.com/MsPajnMahHp6RYgB/arcgis/rest/services/Base_FS/FeatureServer/1",
  chatham: "https://gisservices.chathamcountync.gov/webapps/rest/services/DedicatedDatasets/LandReference/MapServer/17",
  cherokee: "https://services5.arcgis.com/UmQCfTNQbyTzAV5N/arcgis/rest/services/Parcels/FeatureServer/0",
  cleveland: "https://www.webgis.net/arcgis/rest/services/NC/Cleveland/MapServer/1",
  columbus: "https://services8.arcgis.com/XW1xe0eCMVrYcKIY/arcgis/rest/services/Columbus_Count_Parcels/FeatureServer/24",
  craven: "https://gis.newbernnc.gov/arcgis/rest/services/newbern_services/Craven_Parcels/FeatureServer/0",
  cumberland: "https://gis.co.cumberland.nc.us/server/rest/services/Tax/Parcels/MapServer/0",
  davidson: "https://webgis.co.davidson.nc.us/arcgis/rest/services/FrameworkData/FrameworkLayers/MapServer/3",
  durham: "https://gis-portal.townofchapelhill.org/server/rest/services/OpenData/DurhamCountyParcels/MapServer/0",
  edgecombe: "https://services.arcgis.com/4MdqIsNzxG7xyTvf/arcgis/rest/services/City_of_Rocky_Mount_Edgecombe_Parcels/FeatureServer/15",
  forsyth: "https://arcgis2.cityofws.org/arcgissmwa02/rest/services/OICv2/Property2/MapServer/3",
  gaston: "https://gis.gastoncountync.gov/publicgis/rest/services/PublicGIS/Parcels/MapServer/11",
  guilford: "https://gcgis.guilfordcountync.gov/arcgis/rest/services/GC_Cadastral_Current/GC_Parcels/FeatureServer/0",
  halifax: "https://services8.arcgis.com/0zS9csrI5fS6Bcym/arcgis/rest/services/OpenGov_RR_Layers/FeatureServer/22",
  harnett: "https://services6.arcgis.com/VIqR7UNKtUqQ1fzt/arcgis/rest/services/Harnett_County_Parcels/FeatureServer/0",
  haywood: "https://maps.haywoodcountync.gov/arcgis/rest/services/Land_Records/Open_Data/MapServer/3",
  henderson: "https://gisweb.hendersoncountync.gov/arcgis/rest/services/Parcels/FeatureServer/0",
  hyde: "https://services1.arcgis.com/XBhYkoXKJCRHbe7M/arcgis/rest/services/hydeco_parcels/FeatureServer/1",
  iredell: "https://maps.iredellcountync.gov/server/rest/services/Data/TaxSQL_Parcels/FeatureServer/0",
  johnston: "https://services.arcgis.com/klfX5Vz1Hy74tGIF/arcgis/rest/services/Environmental/FeatureServer/4",
  jones: "https://services3.arcgis.com/nJbIFHiSnaX0z0hS/arcgis/rest/services/Jones_Bitek/FeatureServer/0",
  lenoir: "https://services5.arcgis.com/oHyVM17u2FMyV4oB/arcgis/rest/services/CurrentParcels/FeatureServer/0",
  macon: "https://services1.arcgis.com/KUeKSLlMUcWvuPRM/arcgis/rest/services/Macon_WFL1/FeatureServer/11",
  mcdowell: "https://www.webgis.net/arcgis/rest/services/NC/McDowell/MapServer/2",
  mitchell: "https://services1.arcgis.com/KUeKSLlMUcWvuPRM/arcgis/rest/services/Mitchell_County_WFL1/FeatureServer/11",
  montgomery: "https://www.webgis.net/arcgis/rest/services/NC/Montgomery/MapServer/1",
  nash: "https://services.arcgis.com/4MdqIsNzxG7xyTvf/arcgis/rest/services/Nash_Parcels_in_the_RMMPO/FeatureServer/0",
  new_hanover: "https://gis.nhcgov.com/server/rest/services/Layers/Parcels/MapServer/0",
  northampton: "https://services8.arcgis.com/eJ9GuQwMsO1iIOw1/arcgis/rest/services/NC_County_Parcels_WFL1/FeatureServer/1",
  onslow: "https://gismaps.onslowcountync.gov/server/rest/services/WEB_PUBLICATIONS/County_Map_Layers/MapServer/0",
  orange: "https://gis.orangecountync.gov/arcgis/rest/services/WebParcelService/MapServer/0",
  pamlico: "https://services6.arcgis.com/krSNOBBGf8rF7cNp/arcgis/rest/services/Pamlico_County_Parcels/FeatureServer/0",
  pasquotank: "https://services.arcgis.com/jkjoY4K3AKme8wiO/arcgis/rest/services/OpenGov/FeatureServer/7",
  pender: "https://services7.arcgis.com/zHNS16tz3znqN3gM/arcgis/rest/services/Pender_County_RO_WTP_WFL1/FeatureServer/3",
  person: "https://gis.personcountync.gov/arcgis/rest/services/Tax/BitekParcelInfo/MapServer/1",
  pitt: "https://gis.pittcountync.gov/gis/rest/services/PittOpenData/CadastralPitt/MapServer/0",
  polk: "https://services1.arcgis.com/23uf7jKvz6SRPFWJ/arcgis/rest/services/Parcels/FeatureServer/0",
  randolph: "https://gis.randolphcountync.gov/arcgis/rest/services/PW/PW_ParcelMap/FeatureServer/14",
  robeson: "https://services7.arcgis.com/miWUVbMhSUq6a8y1/arcgis/rest/services/Robeson_County_Parcels/FeatureServer/0",
  rockingham: "https://www.webgis.net/arcgis/rest/services/NC/Rockingham/MapServer/8",
  rowan: "https://gis.rowancountync.gov/arcgis/rest/services/Public/RowanTaxParcels/MapServer/0",
  rutherford: "https://services1.arcgis.com/KUeKSLlMUcWvuPRM/arcgis/rest/services/Rutherford_County_Recovery_Data_WFL1/FeatureServer/13",
  sampson: "https://services3.arcgis.com/fM4kjZmPOS4ay2Ff/arcgis/rest/services/Sampson_County_Viewer/FeatureServer/9",
  scotland: "https://services3.arcgis.com/bgKigTDifCMNj8OU/arcgis/rest/services/Tax_Parcels_Scotland_County_view/FeatureServer/6",
  stanly: "https://services6.arcgis.com/w1igg0Q14weqYXUh/arcgis/rest/services/parcel_records_base/FeatureServer/3",
  surry: "https://services.arcgis.com/yJw0QBrxA9TD7hLs/arcgis/rest/services/Parcels/FeatureServer/0",
  swain: "https://maps.swaincountync.gov/server/rest/services/ParcelsForDownload/FeatureServer/0",
  transylvania: "https://www.webgis.net/arcgis/rest/services/NC/Transylvania/MapServer/10",
  vance: "https://services6.arcgis.com/pET3krhY1T0smsXf/arcgis/rest/services/Web_Map_Service/FeatureServer/3",
  wake: "https://maps.wake.gov/arcgis/rest/services/Property/Parcels/MapServer/0",
  watauga: "https://services2.arcgis.com/wdQEqhSQSuYA89VW/arcgis/rest/services/Watauga_County_Parcels/FeatureServer/0",
  wilkes: "https://services3.arcgis.com/xb2qUX5xzfQSbb1s/arcgis/rest/services/Wilkesboro_PublicTownWebMap/FeatureServer/8",
  wilson: "https://gis.wilson-co.com/arcgis/rest/services/Open_gov/Opengov_Address_Taxparcels/FeatureServer/0",
  yadkin: "https://services1.arcgis.com/NjPxXbprfWFvge6E/arcgis/rest/services/Yadkin_VAD_Map/FeatureServer/6",
  yancey: "https://services1.arcgis.com/KUeKSLlMUcWvuPRM/arcgis/rest/services/Yancey_County_WFL1/FeatureServer/11",
  // South Carolina parcel layers. Counties that share a name with NC use the
  // `_sc` suffix so NC county fallback lookups do not hit SC services.
  abbeville: SC_STATEWIDE_PARCEL_LAYER,
  aiken: SC_STATEWIDE_PARCEL_LAYER,
  allendale: SC_STATEWIDE_PARCEL_LAYER,
  anderson: "https://propertyviewer.andersoncountysc.org/arcgis/rest/services/QueryMap/MapServer/8", // county scrubs owner from GIS (ACPASS only), but MRKT_VALUE / deed / TAX_DIST / PHYS_ADDR are current, verified live
  bamberg: SC_STATEWIDE_PARCEL_LAYER,
  barnwell: SC_STATEWIDE_PARCEL_LAYER,
  beaufort_sc: "https://gis.beaufortcountysc.gov/server/rest/services/ArchiveParcels/MapServer/14", // 2024 parcels (Owner1 / GIS_ACRES), verified live
  berkeley: "https://services.arcgis.com/M2JiPNPcfxhLjlp7/arcgis/rest/services/ParcelsAndAddress/FeatureServer/1",
  calhoun: "https://services5.arcgis.com/B3Zo1xqTw8CidOoF/arcgis/rest/services/WebParcels/FeatureServer/0",
  charleston: "https://gisccapps.charlestoncounty.org/arcgis/rest/services/GIS_VIEWER/New_Public_Search/MapServer/7", // county Public_Search viewer parcels: PID / OWNER1 / ACREAGE / TAX_DISTRICT / MAIL_*, verified live
  cherokee_sc: SC_STATEWIDE_PARCEL_LAYER,
  chester: SC_STATEWIDE_PARCEL_LAYER,
  chesterfield: SC_STATEWIDE_PARCEL_LAYER,
  clarendon: SC_STATEWIDE_PARCEL_LAYER,
  colleton: "https://services1.arcgis.com/m0cnLGKdhwao8WvM/arcgis/rest/services/Public_Data/FeatureServer/2",
  darlington: "https://services5.arcgis.com/8FJikaProY6O3ncx/arcgis/rest/services/PARCELS/FeatureServer/1",
  dillon: SC_STATEWIDE_PARCEL_LAYER,
  dorchester: "https://gisportal.dorchestercounty.net/hosting/rest/services/County_Basemap/MapServer/3",
  edgefield: SC_STATEWIDE_PARCEL_LAYER,
  fairfield: SC_STATEWIDE_PARCEL_LAYER,
  florence: "https://services1.arcgis.com/40L6yX6OtdCifNez/arcgis/rest/services/TaxParcelInfo/FeatureServer/0", // was dead http:// (mixed-content); OWNERNAME / CALCULATED_ACREAGE, verified live
  georgetown: "https://gis1.georgetowncountysc.org/portal/rest/services/GCGIS_OpenData/MapServer/2", // geometry + TMS only; Owner1 etc. joined from the PARCELATTRIBUTES table via SC_COUNTY_ATTRIBUTE_JOINS, verified live
  greenville: "https://citygis.greenvillesc.gov/arcgis/rest/services/AddressSearch/Property/MapServer/3",
  greenwood: SC_STATEWIDE_PARCEL_LAYER, // was Online_Comprehensive_Map/2 — outline-only (6 fields, no owner); use statewide
  hampton: "https://services8.arcgis.com/6eabNhFouHU5vuYk/arcgis/rest/services/Parcels_Published_view/FeatureServer/1",
  horry: "https://www.horrycounty.org/gisweb/rest/services/Public/Parcels/MapServer/1", // county viewer parcels: OwnerName / Acreage / assessed+market+taxable values / deed, verified live (point misses on this server; envelope fallback matches)
  jasper: SC_STATEWIDE_PARCEL_LAYER, // was Parcels_View/2 — public view has no owner-name field; use statewide
  kershaw: SC_STATEWIDE_PARCEL_LAYER,
  lancaster: "https://services.arcgis.com/TL5Ii4EYksDBPH1o/arcgis/rest/services/Lancaster_Parcels/FeatureServer/0",
  laurens: "https://www.laurenscountygis.org/arcgis/rest/services/Pebble/TaxParcel/MapServer/5",
  lee_sc: "https://services5.arcgis.com/zg6ovB2KKN8L0zFv/arcgis/rest/services/Web_Parcels/FeatureServer/0",
  lexington: "https://maps.lex-co.com/agstserver/rest/services/Property/MapServer/4",
  marion: SC_STATEWIDE_PARCEL_LAYER,
  marlboro: SC_STATEWIDE_PARCEL_LAYER,
  mccormick: SC_STATEWIDE_PARCEL_LAYER,
  newberry: SC_STATEWIDE_PARCEL_LAYER,
  oconee: "https://arcserver2.oconeesc.com/arcgis/rest/services/PARCELDATA_owner_Assr/MapServer/1", // was PARCELDATA/1 (no owner); _owner_Assr layer has current_owner / GIS_ACRES, verified live
  orangeburg: "https://services2.arcgis.com/bUKn95BqgpYYTnx3/arcgis/rest/services/Main_Public_Tax_Parcel_Map_WFL1/FeatureServer/0",
  pickens: "https://services1.arcgis.com/59960rq18IxUcAVI/arcgis/rest/services/Energov_AGOL/FeatureServer/7",
  richland: "https://services1.arcgis.com/Mnt8FoJcogKtoVBs/arcgis/rest/services/EnergovInformationPublic/FeatureServer/13",
  saluda: "https://saludacountysc.net/arcgis/rest/services/ParcelViewers/PublicWebsite_Pro/MapServer/4", // parcels pre-joined w/ AssessorData (SDE.DBO.*: Name / Tot_Number_Acres / Tot_Assesd_Value / District), verified live
  spartanburg: "https://maps.spartanburgcounty.org/server/rest/services/DisplayMap0_11/MapServer/3", // was stale 2019 snapshot (no owner); live county Parcels has OwnerName / DEEDACREAGE, verified live
  sumter: SC_STATEWIDE_PARCEL_LAYER,
  union_sc: SC_STATEWIDE_PARCEL_LAYER,
  williamsburg: SC_STATEWIDE_PARCEL_LAYER,
  york: "https://services1.arcgis.com/2AGLxyiJoNiVHKwq/arcgis/rest/services/Parcels/FeatureServer/0",
};

/** Counties whose GIS splits parcel geometry and assessor attributes across a
 * spatial layer and a non-spatial table: after the polygon resolves, the table
 * is queried by parcel id and its attributes merged in (e.g. Georgetown, whose
 * PARCELATTRIBUTES table carries Owner1/BillingAddress/SaleDate per tax year). */
interface ScAttributeJoin {
  tableUrl: string;
  /** Raw field on the parcel polygon holding the join key (e.g. TMS). */
  parcelField: string;
  /** Field on the attribute table matched against the join key. */
  tableField: string;
  /** Optional ordering so multi-year tables return the newest roll first. */
  orderBy?: string;
}
const SC_COUNTY_ATTRIBUTE_JOINS: Record<string, ScAttributeJoin> = {
  georgetown: {
    tableUrl: "https://gis1.georgetowncountysc.org/portal/rest/services/GCGIS_OpenData/MapServer/7",
    parcelField: "TMS",
    tableField: "ParcelID",
    orderBy: "YearID DESC",
  },
};

/** Shoelace area (ft²) of a State Plane ring set, to derive acreage when absent. */
function ringAreaSqFt(rings?: number[][][]): number {
  if (!rings || !rings[0]) return 0;
  const r = rings[0];
  let area = 0;
  for (let i = 0; i < r.length - 1; i++) area += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
  return Math.abs(area) / 2;
}

const SC_STATEWIDE_FIELD_NAMES = new Set([
  "t_map_number", "county", "l_value", "m_value", "ownership", "mailing_add", "mailing_city", "mailing_st", "mailing_zip", "zoning", "land_use", "acreage",
]);

function normalizeScCountyDisplayName(value: any): string | undefined {
  const raw = String(value ?? '').trim();
  if (!raw) return undefined;
  const canonical = SC_COUNTY_NAMES.find((name) => name.toLowerCase() === raw.toLowerCase());
  return canonical ? `${canonical}, SC` : `${toTitleCase(raw)}, SC`;
}

function normalizeScStatewideParcelAttrs(a: Record<string, any>): Record<string, any> {
  const keys = Object.keys(a);
  const getExact = (name: string): any => {
    const k = keys.find((key) => key.toLowerCase() === name.toLowerCase());
    const v = k != null ? a[k] : undefined;
    return v != null && String(v).trim() !== "" && String(v).trim().toLowerCase() !== "null" ? v : undefined;
  };
  return {
    recordsource: 'scdot',
    parno: getExact("T_Map_Number") ?? "N/A",
    gisacres: getExact("Acreage"),
    ownname: getExact("Ownership") ?? "N/A",
    ownname2: "",
    // The statewide SC layer has mailing address fields, but no situs street.
    // Keep situs empty so the searched/reverse-geocoded property address remains
    // the property address and mailing data stays only in mailingAddress.
    siteadd: undefined,
    mailadd: getExact("Mailing_Add"),
    mcity: getExact("Mailing_City"),
    mstate: getExact("Mailing_St"),
    mzip: getExact("Mailing_Zip"),
    scity: undefined,
    sstate: "SC",
    // The snapshot stores 0 for unassessed parcels — don't surface "$0".
    parval: Number(getExact("M_Value")) > 0 ? getExact("M_Value") : undefined,
    landval: Number(getExact("L_Value")) > 0 ? getExact("L_Value") : undefined,
    saledate: undefined,
    reviseyear: undefined,
    sourceref: "N/A",
    legdecfull: getExact("Land_Use") ?? "SC Parcel",
    structyear: undefined,
    cntyname: normalizeScCountyDisplayName(getExact("County")),
    zoning: getExact("Zoning"),
  };
}

/** Maps a county parcel record (varied field names) onto the statewide schema. */
export function normalizeCountyParcelAttrs(a: Record<string, any>): Record<string, any> {
  // SDE/joined layers qualify field names ("SDE.DBO.AssessorData.Name",
  // "gispublic.DBO.PARCEL_LANDRECORDS_2.area"); strip everything up to the last
  // dot so the field regexes below can match (e.g. Saluda's parcels+assessor
  // join). First value wins when two source tables share a short name.
  if (Object.keys(a).some((k) => k.includes('.') && !/\(\)$/.test(k))) {
    const stripped: Record<string, any> = {};
    for (const [k, v] of Object.entries(a)) {
      const short = k.includes('.') && !/\(\)$/.test(k) ? k.slice(k.lastIndexOf('.') + 1) : k;
      if (!(short in stripped)) stripped[short] = v;
    }
    a = stripped;
  }
  const keys = Object.keys(a);
  const lowerKeySet = new Set(keys.map((k) => k.toLowerCase()));
  if (["t_map_number", "ownership", "mailing_add"].every((k) => lowerKeySet.has(k)) ||
      [...lowerKeySet].filter((k) => SC_STATEWIDE_FIELD_NAMES.has(k)).length >= 5) {
    return normalizeScStatewideParcelAttrs(a);
  }
  const hasValue = (v: any): boolean => v != null && String(v).trim() !== "" && String(v).trim().toLowerCase() !== "null";
  const get = (...res: RegExp[]): any => {
    for (const re of res) {
      const k = keys.find((k) => re.test(k));
      if (k != null && hasValue(a[k])) return a[k];
    }
    return undefined;
  };
  const joinFirstAddressGroup = (): string | undefined => {
    const groups = [
      [/^address_?1$/i, /^address_?2$/i, /^address_?3$/i],
      [/^mailaddr?1$/i, /^mailaddr?2$/i, /^mailaddr?3$/i],
      [/^mail_?addr_?1$/i, /^mail_?addr_?2$/i, /^mail_?addr_?3$/i],
      [/^cama_temp_address_?1$/i, /^cama_temp_address_?2$/i, /^cama_temp_address_?3$/i],
      [/^add1$/i, /^add2$/i, /^add3$/i],
      [/^owner_?addr(?:ess)?_?1$/i, /^owner_?addr(?:ess)?_?2$/i, /^owner_?addr(?:ess)?_?3$/i],
      [/^taxpayer_?addr(?:ess)?_?1$/i, /^taxpayer_?addr(?:ess)?_?2$/i, /^taxpayer_?addr(?:ess)?_?3$/i],
    ];
    for (const group of groups) {
      const parts = group.map((re) => get(re)).filter(hasValue).map((v) => String(v).trim());
      if (parts.length) return parts.join(' ');
    }
    return undefined;
  };
  const parseCityStateZip = (v: any): { city: string; state: string; zip?: string } | null => {
    if (!hasValue(v)) return null;
    const s = String(v).trim().replace(/,\s*/g, ' ').replace(/\s+/g, ' ');
    const m = s.match(/^([A-Za-z\s\.\-]+)\s+([A-Z]{2})(?:\s+(\d{5}(?:-\d{4})?))?$/);
    return m ? { city: m[1].trim(), state: m[2].trim(), zip: m[3]?.trim() } : null;
  };
  const getCombinedCityStateZip = (): { city: string; state: string; zip?: string } | null => {
    for (const re of [/^city_?state_?zip$/i, /^cama_temp_address_?3$/i, /^address_?2$/i, /^address_?3$/i]) {
      const parsed = parseCityStateZip(get(re));
      if (parsed) return parsed;
    }
    return null;
  };

  let ownname = get(/^ownname$/i, /^owner$/i, /ownername/i, /owner_?name/i, /^owner_?1$/i, /^acctname1?$/i, /^taxpayer$/i,
    /^name_?1$/i, /^n_?name$/i, /^ownam1$/i, /^own1$/i, /jan1_?name1?/i, /current_?owners?$/i, /^current_?ow$/i,
    /^curr_?name_?1$/i, /property_?owner/i, /^paname$/i, /primary_?owner/i, /owners_?name$/i, /^acct_?name$/i, /^name$/i, /ownership$/i,
    /cama_temp_name$/i);
  if (!ownname) {
    const last = get(/own.*lst.*n/i, /owner.*last/i, /lastname/i, /own_?last/i);
    const first = get(/own.*frst.*n/i, /owner.*first/i, /firstname/i, /own_?first/i);
    // Build "LAST, FIRST" so formatOwnerName reliably reorders to "First Last".
    if (last) ownname = first ? `${last}, ${first}` : last;
  }
  let ownname2 = get(/^ownname2$/i, /owner2name/i, /^acctname2$/i, /^name_?2$/i, /^ownam2$/i, /^own2$/i, /^owner_?2$/i, /secondary_?owner/i);
  if (!ownname2) {
    const last2 = get(/ownr?2.*lst|owner2.*last/i);
    const first2 = get(/ownr?2.*frst|owner2.*first/i);
    if (last2) ownname2 = first2 ? `${last2}, ${first2}` : last2;
  }
  // Situs address: single-field variants first; else compose it from
  // house-number + street-name pieces (several county schemas split it).
  let siteadd = get(/site_?address/i, /^siteadd/i, /whole_?address/i, /situs/i, /location_?addr/i, /parcel_?addr/i,
    /property_?address/i, /^phys_?addr/i, /physaddres/i, /^phylocat/i, /^prop_?locat/i, /physical_?(street_?address|location)$/i,
    /^physical_?address$/i,
    /^physstradd$/i, /^locationaddress$/i, /^locaddress/i, /^street_?address$/i, /legal_?addr/i, /^str_?addr/i, /^address$/i, /prop_?add/i, /^loc$/i,
    /^street$/i, /^locadd$/i, /street_?name/i);
  if (!siteadd) {
    const hn = get(/house_?num/i, /housenumbe/i, /house_?nr/i, /street_?nbr/i, /phys.?lc.?street_?number/i, /^stnum$/i, /^street_?number$/i);
    const sn = get(/^street_?name$/i, /^strname$/i, /^strtname$/i, /phys.?lc.?street_?name/i, /^pastna$/i, /^st_?name$/i);
    const st = get(/^street_?type$/i, /^strtype$/i, /^str_?type$/i, /phys.?lc.?str_?type/i, /^pastab$/i, /^st_?type$/i);
    if (hn && sn) siteadd = [hn, sn, st].filter(Boolean).map((v) => String(v).trim()).join(' ');
  } else if (!/^\d/.test(String(siteadd).trim())) {
    // The single-field match can land on a bare street name (e.g. Georgetown's
    // StreetName); prepend the parcel's own street number when one exists.
    const hn = get(/house_?num/i, /housenumbe/i, /street_?nbr/i, /^stnum$/i, /^street_?number$/i);
    if (hn) siteadd = `${String(hn).trim()} ${String(siteadd).trim()}`;
  }
  let sourceref = get(/^sourceref$/i, /deedref/i, /^legal_?reference$/i);
  if (!sourceref) {
    const book = get(/deed_?book/i, /^book$/i);
    const page = get(/deed_?page/i, /^page$/i);
    if (book) sourceref = page ? `${book}/${page}` : String(book);
  }
  let mailadd = get(/^mailadd$/i, /^mail_?address$/i, /^mailing_?(add|addr|address)$/i, /^mailing$/i,
    /^curr_?addr$/i, /^current_?ad$/i, /postal_?address/i, /^owner_?address$/i, /^taxpayer_?address$/i,
    /^curr_?addr_?1$/i, /^ownmailingline1$/i, /^acct_?addr$/i, /^owner_?street$/i, /^billing_?address$/i);
  if (!mailadd) mailadd = joinFirstAddressGroup();
  if (!mailadd) {
    // Charleston-style split mailing street: MAIL_ST_NO + MAIL_ST_NAME + MAIL_ST_TYPE.
    const mn = get(/^mail_?(st|street)_?(no|num|number)$/i);
    const ms = get(/^mail_?(st|street)_?name$/i);
    const mt = get(/^mail_?(st|street)_?type$/i);
    if (mn || ms) mailadd = [mn, ms, mt].filter(hasValue).map((v) => String(v).trim()).join(' ');
  }
  if (!mailadd) {
    mailadd = get(/mailaddr?1/i, /^addr1$/i, /curr_?addr1/i, /mailing/i, /mail_?add/i, /^address_?1$/i, /^address$/i,
      /taxpayer_?addr(ess)?_?1?/i, /^owadr1$/i, /owner_?addr(ess)?_?1?$/i);
  }
  let mcity = get(/mail.*city/i, /^mcity$/i, /curr_?city/i, /loccity/i, /^city$/i, /mailing_?city/i,
    /^owncity$/i, /^owner_?city$/i, /^mail_?addr_?city$/i);
  let mstate = get(/mail.*state/i, /^mstate$/i, /curr_?state/i, /^state$/i, /mailing_?st/i, /mailing_?state/i,
    /^ownstate$/i, /^owner_?state?$/i, /^mail_?addr_?state$/i, /^st$/i);
  let mzip = get(/mail.*zip/i, /^mzip$/i, /curr_?zip/i, /zipnum/i, /^zip_?(code)?$/i, /mailing_?zip/i,
    /^ownzip$/i, /^curr_?zipco$/i, /^owner_?zip(code)?$/i, /^mail_?addr_?zip$/i);
  if (!mcity || !mstate || !mzip) {
    const combined = getCombinedCityStateZip();
    if (combined) {
      if (!mcity) mcity = combined.city;
      if (!mstate) mstate = combined.state;
      if (!mzip && combined.zip) mzip = combined.zip;
    }
  }
  return {
    parno: get(/^pin_?num$/i, /^parno$/i, /parcel_?id/i, /^parcel_?id$/i, /^pid$/i, /^pin$/i, /^pin14$/i, /^nad83_?pin$/i, /parcel_?num/i, /^gis_?pin$/i, /gpin/i, /nc_?pin/i, /^newpin$/i, /^geo_?pin$/i, /^par_?code$/i, /^tms$/i, /_tms$/i, /tms_?number/i, /^pin/i, /t_map_number/i, /tax_?map_?number/i, /^taxmapid$/i, /^map_?number$/i, /^tax_?pin$/i, /^tms_?number$/i, /^cmplnn2?$/i) ?? "N/A",
    gisacres: get(/gis_?acres/i, /calc.*acre/i, /calculated_?acreage/i, /^calc_?ac(re)?$/i, /^cacres$/i, /acres_?gis/i, /deed(?:ed)?_?ac(?:res?|re)?/i, /^acres$/i, /acreage/i, /legal_?acres/i, /tax_?acres/i, /total_?acres/i, /tot_?number_?acres/i, /(?:^|_)number_?acres/i, /poly_?acres/i, /map_?acres/i, /assessed_?ac$/i, /^total_?calc/i, /land_?area/i, /^pacrea$/i, /^calculated$/i, /gross.*acres/i),
    ownname: ownname ?? get(/ownership/i, /owner_?ship/i) ?? "N/A",
    ownname2: ownname2 ?? "",
    siteadd,
    mailadd,
    mcity,
    mstate,
    mzip,
    scity: get(/^scity$/i, /loccity/i, /^city$/i, /mailing_?city/i),
    parval: get(/^parval$/i, /total_?value_?assd/i, /assessed_?value/i, /total_?value/i, /total_?prop_?value/i, /^totval$/i, /tot_?mark_?val/i, /market_?value/i, /appraised/i, /^totmkt$/i, /mkt_?total/i, /^mkt_?total$/i, /^tax_?value$/i, /^netval/i, /^par_?value$/i, /^adj_?value$/i, /^mkt_?value$/i, /total_?asses/i, /^assessed_?va?/i, /^assessed_?prop$/i, /^tot_?assesd/i, /^cost_?tot/i, /^tot_?val/i, /^cur_?tot_?tot$/i, /m_value/i, /^apr_?tot_?val$/i, /^fair_?mkt_?val$/i, /^tot_?market_?appr$/i, /^tax_?mkt_?val$/i, /^cama_temp_tot_taxable_appr$/i),
    landval: get(/^landval$/i, /land_?val(ue)?/i, /tot_?land_?val/i, /l_value/i, /^apr_?land_?val$/i, /^taxable_?land$/i, /^market_?land$/i),
    improvementvalue: get(/improvement_?value/i, /imprv_?value/i, /^fmv_?imprv$/i, /building_?value/i, /assessed_?improvements/i, /^market_?imprv$/i),
    marketvalue: get(/^market_?value$/i, /^fmv_?total$/i, /total_?market_?value/i, /total_?calculated/i, /^market_?prop$/i, /^mrkt_?value$/i),
    taxablevalue: get(/^taxable_?value$/i, /assessed_?property_?value/i, /^taxable_?prop$/i),
    totalassessedvalue: get(/^total_?assessed_?value$/i, /total_?assessed_?parcel_?value/i),
    taxcodearea: get(/^taxcodearea$/i, /^tax_?district$/i, /^tax_?distri/i, /^district$/i, /school_?dist/i),
    saledate: get(/^sale_?date$/i, /^saledate$/i, /deed_?date/i, /transfer_?date/i, /^recorded_?date$/i),
    reviseyear: get(/revis.*year/i, /^yearid$/i, /parcel_?year/i, /tax_?year/i, /^year_?$/i),
    sourceref: sourceref ?? "N/A",
    legdecfull: get(/legal_?desc/i, /^legdec/i, /prop_?desc/i, /^legaldesc$/i, /land_?use/i) ?? "County Parcel",
    structyear: get(/year_?built/i, /yearblt/i, /struct.*year/i, /yrbuilt/i),
    cntyname: get(/^cntyname$/i, /^county$/i, /county_?name/i),
    zoning: get(/^zoning$/i, /^zone$/i, /^zoning_?district$/i, /^zoning_?code$/i, /^zoning_?class$/i, /^zone_?code$/i, /^zoning_?class_?code$/i),
    // County/statewide merge re-normalizes already-normalized attributes, so
    // pass these markers straight through instead of dropping them (losing
    // recordsource silently demoted every county-GIS record to "unverified").
    recordsource: a.recordsource,
    officialmailingaddress: get(/^officialmailingaddress$/i),
  }
}

async function queryScStatewideParcelAttributes(lng: number, lat: number, where: string): Promise<Record<string, any> | null> {
  const endpoint = `${SC_STATEWIDE_PARCEL_LAYER}/query`;
  const buildUrl = (geometry: string, geometryType: "esriGeometryPoint" | "esriGeometryEnvelope") =>
    `${endpoint}?geometry=${geometry}` +
    `&geometryType=${geometryType}&inSR=4326&spatialRel=esriSpatialRelIntersects` +
    `&where=${encodeURIComponent(where)}` +
    `&outFields=${encodeURIComponent(SC_PARCEL_FIELDS)}` +
    `&returnGeometry=false&resultRecordCount=1&f=json`;

  const urls = [
    buildUrl(`${lng},${lat}`, "esriGeometryPoint"),
    buildUrl(`${lng - 0.00015},${lat - 0.00015},${lng + 0.00015},${lat + 0.00015}`, "esriGeometryEnvelope"),
  ];
  for (const url of urls) {
    try {
      const res = await fetchWithRetry(url, 2, 10000, { cache: 'no-store' });
      if (!res.ok) continue;
      const data = await res.json();
      const attrs = data?.features?.[0]?.attributes;
      if (attrs) return normalizeCountyParcelAttrs(attrs);
    } catch {
      // Try the buffered fallback or let the caller continue with local attrs.
    }
  }
  return null;
}

/**
 * Queries a county's own parcel server at a point. Returns geometry (GeoJSON +
 * State Plane Esri rings, native SR) with attributes normalized to the statewide
 * schema, or null if unavailable / no parcel at the point.
 */
async function queryCountyParcel(baseUrl: string, lng: number, lat: number, joinConfig?: ScAttributeJoin) {
  const runQuery = async (geometryParams: string) => {
    const common = `${geometryParams}&inSR=4326&spatialRel=esriSpatialRelIntersects&where=1%3D1&outFields=*&returnGeometry=true`;
    // Independent fetches: the WGS84 boundary is the critical result — don't
    // let a failed native-SR (measurement) query discard a good parcel.
    const [wgsRes, spRes] = await Promise.allSettled([
      fetchWithRetry(`${baseUrl}/query?${common}&outSR=4326&f=geojson`, 2, 10000, { cache: 'no-store' }),
      fetchWithRetry(`${baseUrl}/query?${common}&f=json`, 2, 10000, { cache: 'no-store' }), // native SR (State Plane feet)
    ]);
    if (wgsRes.status !== 'fulfilled') throw wgsRes.reason;
    const wgsJson = await wgsRes.value.json();
    let spJson: any = null;
    if (spRes.status === 'fulfilled') {
      try { spJson = await spRes.value.json(); } catch { /* optional */ }
    }
    return { wgsJson, spJson };
  };
  try {
    let { wgsJson, spJson } = await runQuery(`geometry=${lng},${lat}&geometryType=esriGeometryPoint`);
    if (!wgsJson?.features?.length) {
      // Some county servers (e.g. Horry's HARN State Plane 10.6) return nothing
      // for a reprojected point-in-polygon query but match a tiny envelope
      // around the same coordinate reliably.
      const d = 0.00012;
      ({ wgsJson, spJson } = await runQuery(
        `geometry=${lng - d},${lat - d},${lng + d},${lat + d}&geometryType=esriGeometryEnvelope`,
      ));
    }
    const feats: any[] = wgsJson?.features || [];
    // The envelope can clip the adjacent roadway/right-of-way parcel; prefer the
    // first feature whose owner is NOT a road segment (same rule as statewide).
    let pickedIdx = feats.findIndex((f) => f?.geometry && !isRoadwayOwner(normalizeCountyParcelAttrs(f?.properties || {}).ownname));
    if (pickedIdx < 0) pickedIdx = feats.findIndex((f) => f?.geometry);
    const wgsFeat = pickedIdx >= 0 ? feats[pickedIdx] : null;
    if (!wgsFeat || !wgsFeat.geometry) return null;
    // Align the native-SR measurement feature to the SAME parcel by id (the two
    // projection queries can order their features differently).
    const spFeats: any[] = Array.isArray(spJson?.features) ? spJson.features : [];
    const pickedParno = String(normalizeCountyParcelAttrs(wgsFeat.properties || {}).parno || '').trim();
    const spMatch = (pickedParno && pickedParno.toUpperCase() !== 'N/A')
      ? spFeats.find((f) => String(normalizeCountyParcelAttrs(f?.attributes || {}).parno || '').trim() === pickedParno)
      : null;
    const spFeat = spMatch || spFeats[pickedIdx] || spFeats[0] || null;

    let rawAttrs: Record<string, any> = wgsFeat.properties || {};
    if (joinConfig) {
      const joinKey = String(rawAttrs[joinConfig.parcelField] ?? '').trim();
      if (joinKey) {
        try {
          const where = `${joinConfig.tableField}='${joinKey.replace(/'/g, "''")}'`;
          const orderBy = joinConfig.orderBy ? `&orderByFields=${encodeURIComponent(joinConfig.orderBy)}` : '';
          const tblRes = await fetchWithRetry(
            `${joinConfig.tableUrl}/query?where=${encodeURIComponent(where)}&outFields=*&returnGeometry=false&resultRecordCount=1${orderBy}&f=json`,
            2, 10000, { cache: 'no-store' },
          );
          const tblAttrs = (await tblRes.json())?.features?.[0]?.attributes;
          if (tblAttrs) rawAttrs = { ...rawAttrs, ...tblAttrs };
        } catch { /* keep the geometry-only record */ }
      }
    }

    const norm = normalizeCountyParcelAttrs(rawAttrs);
    norm.recordsource = baseUrl === SC_STATEWIDE_PARCEL_LAYER ? 'scdot' : 'county-gis';
    if (!norm.gisacres) {
      const sqft = ringAreaSqFt(spFeat?.geometry?.rings);
      if (sqft > 0) norm.gisacres = sqft / 43560;
    }
    norm.gisacres = norm.gisacres != null ? String(norm.gisacres) : "0";

    return {
      wgs84Feature: { type: "Feature", properties: norm, geometry: wgsFeat.geometry },
      statePlaneFeature: spFeat,
    };
  } catch (err) {
    console.warn("County parcel query failed:", err);
    return null;
  }
}

/**
 * Mecklenburg stores parcel geometry (TaxParcelBoundaries) and CAMA attributes
 * (owner/value, TaxParcel_camadata) in separate layers, so we fetch the boundary
 * geometry and enrich it with the CAMA record at the same point.
 */
async function queryMecklenburgParcel(lng: number, lat: number) {
  const boundary = "https://meckgis.mecklenburgcountync.gov/server/rest/services/TaxParcelBoundaries/MapServer/0";
  const cama = "https://meckgis.mecklenburgcountync.gov/server/rest/services/TaxParcel_camadata/MapServer/0";
  const result = await queryCountyParcel(boundary, lng, lat);
  if (!result) return null;
  try {
    const common = `geometry=${lng},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&where=1%3D1&outFields=*&returnGeometry=false&f=json`;
    const res = await fetchWithRetry(`${cama}/query?${common}`, 2, 7000, { cache: 'no-store' });
    const camAttrs = (await res.json()).features?.[0]?.attributes;
    if (camAttrs) {
      const enriched = normalizeCountyParcelAttrs(camAttrs);
      // Keep the real geometry & acreage from the boundary layer; take richer CAMA attrs.
      result.wgs84Feature.properties = { ...result.wgs84Feature.properties, ...enriched, gisacres: result.wgs84Feature.properties.gisacres };
    }
  } catch (e) {
    console.warn("Mecklenburg CAMA enrichment failed:", e);
  }
  return result;
}

function generateSimulatedParcel(lng: number, lat: number, addressString: string, countyName: string) {
  const charCodeSum = (addressString || "").split("").reduce((sum: number, char: string) => sum + char.charCodeAt(0), 0);
  const parcelId = String(10000000 + (charCodeSum % 89999999));
  const state = countyState(countyName);
  
  const gisAcres = 0.25 + ((charCodeSum % 21) * 0.01);
  const grossSf = Math.round(gisAcres * 43560);
  
  const lotWidth = Math.sqrt(grossSf) * 0.9;
  const lotDepth = grossSf / lotWidth;
  
  const latDegreeFeet = 364000;
  const lngDegreeFeet = 364000 * Math.cos(lat * Math.PI / 180);
  
  const wHalf = (lotWidth / 2) / lngDegreeFeet;
  const dHalf = (lotDepth / 2) / latDegreeFeet;
  
  const wgs84Rings = [[
    [lng - wHalf, lat - dHalf],
    [lng + wHalf, lat - dHalf],
    [lng + wHalf, lat + dHalf],
    [lng - wHalf, lat + dHalf],
    [lng - wHalf, lat - dHalf]
  ]];
  
  const baseSPX = 1450000 + (charCodeSum % 50000);
  const baseSPY = 550000 + (charCodeSum % 50000);
  
  const statePlaneRings = [[
    [baseSPX - lotWidth / 2, baseSPY - lotDepth / 2],
    [baseSPX + lotWidth / 2, baseSPY - lotDepth / 2],
    [baseSPX + lotWidth / 2, baseSPY + lotDepth / 2],
    [baseSPX - lotWidth / 2, baseSPY + lotDepth / 2],
    [baseSPX - lotWidth / 2, baseSPY - lotDepth / 2]
  ]];
  
  const properties = {
    parno: parcelId,
    ownname: "N/A",
    mailadd: "",
    mcity: countyName,
    mstate: state,
    mzip: "",
    saledate: undefined,
    parval: 0,
    landval: 0,
    reviseyear: "2025",
    siteadd: addressString,
    legdecfull: `SIMULATED LOT #${parcelId} - ${state} GIS OFFLINE FALLBACK`,
    gisacres: gisAcres.toString()
  };
  
  return {
    wgs84Feature: {
      type: "Feature",
      properties,
      geometry: {
        type: "Polygon",
        coordinates: wgs84Rings
      }
    },
    statePlaneFeature: {
      geometry: {
        rings: statePlaneRings
      }
    }
  };
}

/**
 * Auto-detect the NC/SC county for an address (so the user never picks one).
 * Google geocodes the address, then TIGERweb verifies the true county boundary.
 * Returns a state-qualified county name (e.g. "Orange, NC" or "Richland, SC"),
 * or null if the address is not a resolvable NC/SC location.
 */
/**
 * Authoritative county for a coordinate via the U.S. Census TIGERweb county
 * boundaries (point-in-polygon). Unlike the parcel layer this has NO coverage
 * gaps (a point on a road still resolves), and unlike Google's geocoder county
 * it reflects the TRUE jurisdiction the point falls in. Supports NC (37) and
 * SC (45).
 */
async function countyAtPoint(lat: number, lng: number): Promise<CountyAtPointResult | null> {
  try {
    const url = `https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1/query` +
      `?geometry=${lng},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects` +
      `&outFields=BASENAME,NAME,STATE&returnGeometry=false&f=json`;
    const res = await fetchWithTimeout(url, 9000, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    const a = data?.features?.[0]?.attributes;
    const state: SupportedState | null = String(a?.STATE) === '37' ? 'NC' : String(a?.STATE) === '45' ? 'SC' : null;
    if (!a || !state) return null;
    const name = String(a.BASENAME || a.NAME || '').replace(/\s+County$/i, '').trim();
    const canonical = (state === 'NC' ? NC_COUNTY_NAMES : SC_COUNTY_NAMES).find((n) => n.toLowerCase() === name.toLowerCase());
    return canonical ? { name: canonical, state } : null;
  } catch { return null; }
}

/**
 * The incorporated municipality (city/town) whose limits contain a coordinate,
 * via the U.S. Census TIGERweb "Incorporated Places" layer (point-in-polygon).
 * Returns the place name (e.g. "Concord") or null when the point is in
 * UNINCORPORATED county land — the strongest address-specific signal for whether
 * public water/sewer are likely available vs. well/septic territory.
 */
async function incorporatedPlaceAtPoint(lat: number, lng: number): Promise<string | null> {
  try {
    const url = `https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer/4/query` +
      `?geometry=${lng},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects` +
      `&outFields=BASENAME,NAME&returnGeometry=false&f=json`;
    const res = await fetchWithTimeout(url, 9000, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    const a = data?.features?.[0]?.attributes;
    if (!a) return null;
    const name = String(a.BASENAME || a.NAME || '').replace(/\s+(city|town|village)$/i, '').trim();
    return name || null;
  } catch { return null; }
}

export async function detectNcCounty(address: string, googleKey: string): Promise<string | null> {
  if (!googleKey || !address.trim()) return null;
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}` +
      `&key=${googleKey}`;
    const res = await fetchWithTimeout(url, 8000, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status !== 'OK' || !data.results?.[0]) return null;
    const r0 = data.results[0];
    const comps = r0.address_components || [];
    const state = comps.find((c: any) => c.types?.includes('administrative_area_level_1'));
    const stateCode = String(state?.short_name || '').toUpperCase();
    if (stateCode !== 'NC' && stateCode !== 'SC') return null;

    // AUTHORITATIVE: the county whose boundary actually contains the geocoded
    // point. Google's administrative_area_level_2 is frequently wrong near county
    // lines or when the mailing city sits in a different county than the parcel.
    const loc = r0.geometry?.location;
    if (loc && typeof loc.lat === 'number' && typeof loc.lng === 'number') {
      const byPoint = await countyAtPoint(loc.lat, loc.lng);
      if (byPoint) return `${byPoint.name}, ${byPoint.state}`;
    }

    // Fallback only: Google's county component.
    const countyComp = comps.find((c: any) => c.types?.includes('administrative_area_level_2'));
    if (!countyComp) return null;
    const county = String(countyComp.long_name || countyComp.short_name || '').replace(/\s+County$/i, '').trim();
    const names = stateCode === 'NC' ? NC_COUNTY_NAMES : SC_COUNTY_NAMES;
    const canonical = names.find((n) => n.toLowerCase() === county.toLowerCase());
    return canonical ? `${canonical}, ${stateCode as SupportedState}` : null;
  } catch { return null; }
}

/**
 * Look up a property by its NC parcel ID (PIN) on the statewide NC OneMap parcel
 * layer. Returns the parcel's situs address (or a reverse-geocoded one for vacant
 * land) and county so the normal analysis can run from it. Null if not found.
 */
export async function lookupParcelById(pin: string, googleKey: string): Promise<{ address: string; county: string; lat?: number; lng?: number } | null> {
  const clean = pin.trim().replace(/'/g, "''");
  if (clean.length < 3) return null;
  const where = `UPPER(parno) = '${clean.toUpperCase()}'`;
  const url = `${NC_PARCEL_ENGINE}?where=${encodeURIComponent(where)}` +
    `&outFields=${encodeURIComponent('parno,siteadd,scity,cntyname')}&returnGeometry=true&outSR=4326&resultRecordCount=1&f=json`;
  try {
    const res = await fetchWithTimeout(url, 15000, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    const feat = data?.features?.[0];
    if (!feat) return null;
    const a = feat.attributes || {};
    const county = String(a.cntyname || '').trim();
    const situs = String(a.siteadd || '').trim();
    const scity = String(a.scity || '').trim();

    // The parcel's polygon centroid — the RELIABLE anchor. We return it so the
    // caller can drive the analysis off the exact parcel point instead of
    // re-geocoding an abbreviated county situs address (which often misses).
    let lat: number | undefined, lng: number | undefined;
    const ring: number[][] | undefined = feat.geometry?.rings?.[0];
    if (ring?.length) {
      const c = ringCentroid(ring);
      if (c) { lng = c[0]; lat = c[1]; }
    }

    if (situs) return { address: `${situs}${scity ? `, ${scity}` : ''}, NC`, county, lat, lng };

    // Vacant parcel with no situs address — reverse-geocode the polygon centroid.
    if (typeof lat === 'number' && typeof lng === 'number' && googleKey) {
      try {
        const gr = await fetchWithTimeout(`https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${googleKey}`, 8000, { cache: 'no-store' });
        if (gr.ok) {
          const gj = await gr.json();
          const best = gj.results?.find((r: any) => r.types?.some((t: string) => ['street_address', 'premise'].includes(t))) || gj.results?.[0];
          const addr = (best?.formatted_address || '').replace(/,?\s*USA$/i, '').trim();
          if (addr) return { address: addr, county, lat, lng };
        }
      } catch { /* fall through */ }
    }
    return county ? { address: `${county} County parcel ${a.parno}`, county, lat, lng } : null;
  } catch { return null; }
}

/**
 * 100-County dynamic geocoding and parcel boundary lookup engine.
 *
 * Progressive loading: `onPartial` is invoked as each independent data layer
 * resolves — (1) parcel/GIS registry data immediately, (2) zoning, (3) USGS
 * topography, (4) verified comps — so the UI can render results the moment
 * they're available instead of waiting for the slowest lookup.
 */
export async function executeLandAnalysis(
  countyName: string,
  addressString: string,
  onStageChange?: (stage: string) => void,
  onPartial?: (partial: Partial<SiteFeasibilityData>) => void,
  compRadiusMiles = 5,
  knownCoords?: { lat: number; lng: number },
): Promise<SiteFeasibilityData> {
  const config = ncCountyConfig[countyName];
  if (!config) {
    throw new Error(`Target county context for '${countyName}' is unconfigured.`);
  }
  const selectedState = countyState(countyName);

  onStageChange?.("Querying county GIS records...");

  // Step A: Convert Text Address String into Lat/Long Coordinates with fallback.
  // When the caller already knows the exact parcel point (e.g. a Parcel-ID lookup
  // returns the polygon centroid), use it directly — skips a fragile geocode of an
  // abbreviated county situs address that can miss the parcel entirely.
  let lng = 0;
  let lat = 0;

  if (knownCoords && Number.isFinite(knownCoords.lat) && Number.isFinite(knownCoords.lng)) {
    lat = knownCoords.lat;
    lng = knownCoords.lng;
  }

  if (!lng || !lat) {
    try {
      if (config.geocodeUrl) {
        const geocodeQuery = `${config.geocodeUrl}?SingleLine=${encodeURIComponent(addressString)}&outSR=4326&f=json`;
        const geoResponse = await fetchWithRetry(geocodeQuery, 2, 5000, { cache: 'no-store' }); // fail fast
        const geoData = await geoResponse.json();
        if (geoData.candidates && geoData.candidates.length > 0) {
          lng = geoData.candidates[0].location.x;
          lat = geoData.candidates[0].location.y;
        }
      }
    } catch (err) {
      console.warn("NC Geocoder failed, falling back to Google Geocoding:", err);
    }
  }

  if (!lng || !lat) {
    const googleApiKey = getUserKeys().googleMaps;
    if (!googleApiKey) {
      throw new Error("Google Maps API Key is required to geocode address coordinates. Please set it in Account Settings.");
    }
    const googleCoords = await geocodeAddress(addressString, googleApiKey);
    if (googleCoords) {
      lng = googleCoords.lng;
      lat = googleCoords.lat;
    } else {
      throw new Error("No geographic locations found matching this address. Neither the NC Geocoder nor the Google geocoding fallback could resolve it.");
    }
  }


  // Parcel resolution order:
  // - NC: statewide OneMap primary/mirror first, then local county fallback.
  // - SC: local county parcel layer first when known, then statewide SC fallback.
  // - Last resort: deterministic simulated outline.
  let parcelFeature: any = null;
  let statePlaneFeature: any = null;
  let isSimulated = false;
  const countyKeyLower = countyParcelLayerKey(countyName);
  const countyParcelLayer = countyParcelLayerFor(countyName, selectedState);
  const hasScLocalParcelLayer = selectedState === 'SC' &&
    !!countyParcelLayer &&
    countyParcelLayer !== SC_STATEWIDE_PARCEL_LAYER;
  const parcelHosts = selectedState === 'NC'
    ? [config.parcelUrl, NC_PARCEL_ENGINE_MIRROR]
    : [SC_STATEWIDE_PARCEL_LAYER];
  const parcelWhere = config.extraWhere || '1=1';
  const parcelOutFields = selectedState === 'NC' ? NC_PARCEL_FIELDS : SC_PARCEL_FIELDS;
  const measurementOutSr = selectedState === 'NC' ? '2264' : '2273';

  // 1) SC county parcel layer - preferred over the statewide SC layer when a
  //    true county-level endpoint is known.
  if (hasScLocalParcelLayer && countyParcelLayer) {
    onStageChange?.("Querying county parcel server...");
    try {
      const localRes = await queryCountyParcel(countyParcelLayer, lng, lat, SC_COUNTY_ATTRIBUTE_JOINS[countyKeyLower]);
      if (localRes) {
        const statewideAttrs = await queryScStatewideParcelAttributes(lng, lat, parcelWhere);
        if (statewideAttrs) {
          const localAttrs = localRes.wgs84Feature.properties || {};
          // County-local data is authoritative (it is the live source of record and is
          // spatially aligned to THIS parcel). The statewide SCDOT snapshot is only used
          // to FILL fields the county layer left blank/N-A — it must never overwrite a
          // good county owner/zoning/value, which previously produced "right outline,
          // wrong owner" results when the two layers disagreed at a point.
          const isBlank = (v: any) => v == null || String(v).trim() === '' ||
            String(v).trim().toLowerCase() === 'null' || String(v).trim() === 'N/A';
          const merged: Record<string, any> = { ...statewideAttrs };
          for (const [k, v] of Object.entries(localAttrs)) {
            if (!isBlank(v) || !(k in merged) || isBlank(merged[k])) merged[k] = v;
          }
          localRes.wgs84Feature.properties = merged;
        }
        parcelFeature = localRes.wgs84Feature;
        statePlaneFeature = localRes.statePlaneFeature;
        console.log(`${countyName} parcel resolved via county GIS server.`);
      }
    } catch (err) {
      console.warn(`County parcel query failed for ${countyName}:`, err);
    }
  }

  // 2) Statewide parcel layer. NC tries both OneMap hosts; SC only reaches this
  //    path when no local county layer exists or the local attempt missed.
  for (const parcelHost of parcelHosts.filter((v, i, arr) => arr.indexOf(v) === i)) {
    if (parcelFeature) break;
    onStageChange?.(selectedState === 'NC' ? "Querying statewide NC OneMap records..." : "Querying statewide SC parcel records...");
    const parcelEndpoint = /\/query$/i.test(parcelHost) ? parcelHost : `${parcelHost}/query`;

    let wgs84Data: any = null;
    let statePlaneData: any = null;

    let parcelQueryWgs84 = `${parcelEndpoint}` +
        `?geometry=${lng},${lat}` +
        `&geometryType=esriGeometryPoint` +
        `&inSR=4326` +
        `&spatialRel=esriSpatialRelIntersects` +
        `&where=${encodeURIComponent(parcelWhere)}` +
        `&outFields=${encodeURIComponent(parcelOutFields)}` +
        `&returnGeometry=true&outSR=4326&f=geojson`;

    let parcelQueryStatePlane = `${parcelEndpoint}` +
        `?geometry=${lng},${lat}` +
        `&geometryType=esriGeometryPoint` +
        `&inSR=4326` +
        `&spatialRel=esriSpatialRelIntersects` +
        `&where=${encodeURIComponent(parcelWhere)}` +
        `&outFields=${selectedState === 'NC' ? 'parno' : encodeURIComponent(parcelOutFields)}` + // State Plane query only needs geometry for measurements
        `&returnGeometry=true&outSR=${measurementOutSr}&f=json`;

    // The two projections are fetched INDEPENDENTLY (allSettled): the WGS84
    // parcel is the critical one — a 504 on the State Plane measurement query
    // must not throw away a good parcel and push the app to simulated bounds.
    // 2 attempts × 12s per query: the statewide server is often slow-but-alive,
    // and 5s single-shot was misreading "slow" as "offline".
    {
      const [wgsRes, spRes] = await Promise.allSettled([
        fetchWithRetry(parcelQueryWgs84, 2, 12000, { cache: 'no-store' }),
        fetchWithRetry(parcelQueryStatePlane, 2, 12000, { cache: 'no-store' }),
      ]);
      if (wgsRes.status === 'fulfilled' && wgsRes.value.ok) {
        try { wgs84Data = await wgsRes.value.json(); } catch { /* malformed body — treat as miss */ }
        if (spRes.status === 'fulfilled' && spRes.value.ok) {
          try { statePlaneData = await spRes.value.json(); } catch { /* optional — measurements only */ }
        }
      } else {
        const err = wgsRes.status === 'rejected' ? wgsRes.reason : `HTTP ${wgsRes.value.status}`;
        console.warn(`Direct point query failed on statewide ${selectedState} parcel service (${selectedState === 'NC' && parcelHost.includes('nconemap') ? 'mirror' : 'primary'} host):`, err);
      }
    }

    // If no direct point intersection is found, retry with a spatial envelope tolerance (e.g. 50 feet buffer)
    if (!wgs84Data || !wgs84Data.features || wgs84Data.features.length === 0) {
      console.log("Direct point intersection returned no parcels or failed. Retrying with spatial envelope buffer...");
      const delta = 0.00015;
      const envGeometry = `${lng - delta},${lat - delta},${lng + delta},${lat + delta}`;

      parcelQueryWgs84 = `${parcelEndpoint}?geometry=${envGeometry}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&where=${encodeURIComponent(parcelWhere)}&outFields=${encodeURIComponent(parcelOutFields)}&returnGeometry=true&outSR=4326&f=geojson`;
      parcelQueryStatePlane = `${parcelEndpoint}?geometry=${envGeometry}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&where=${encodeURIComponent(parcelWhere)}&outFields=${selectedState === 'NC' ? 'parno' : encodeURIComponent(parcelOutFields)}&returnGeometry=true&outSR=${measurementOutSr}&f=json`;

      const [wgsRes, spRes] = await Promise.allSettled([
        fetchWithTimeout(parcelQueryWgs84, 10000, { cache: 'no-store' }),
        fetchWithTimeout(parcelQueryStatePlane, 10000, { cache: 'no-store' }),
      ]);
      if (wgsRes.status === 'fulfilled' && wgsRes.value.ok) {
        try { wgs84Data = await wgsRes.value.json(); } catch { /* malformed body */ }
        if (spRes.status === 'fulfilled' && spRes.value.ok) {
          try { statePlaneData = await spRes.value.json(); } catch { /* optional */ }
        }
      } else {
        console.warn("Parcel envelope-buffer retry timed out.");
      }
    }

    if (wgs84Data && wgs84Data.features && wgs84Data.features.length > 0) {
      const feats: any[] = wgs84Data.features;
      // A point near a property edge can intersect the adjacent roadway parcel (a
      // state/SCDOT right-of-way or highway segment) instead of the private lot.
      // Prefer the first feature whose owner is NOT a roadway/DOT right-of-way,
      // falling back to the first feature when every match is a road segment.
      let pickedIdx = feats.findIndex((f) => !isRoadwayOwner(normalizeCountyParcelAttrs(f?.properties || {}).ownname));
      if (pickedIdx < 0) pickedIdx = 0;
      parcelFeature = feats[pickedIdx];
      const spFeats: any[] = statePlaneData && Array.isArray(statePlaneData.features) ? statePlaneData.features : [];
      if (spFeats.length) {
        // Align the State Plane measurement feature to the SAME parcel by id (the
        // two projection queries can order their features differently).
        const pickedParno = String(normalizeCountyParcelAttrs(parcelFeature.properties || {}).parno || '').trim();
        const spMatch = (pickedParno && pickedParno.toUpperCase() !== 'N/A')
          ? spFeats.find((f) => String(normalizeCountyParcelAttrs(f?.attributes || {}).parno || '').trim() === pickedParno)
          : null;
        statePlaneFeature = spMatch || spFeats[pickedIdx] || spFeats[0];
      } else {
        statePlaneFeature = null;
      }
      console.log(`${countyName} parcel resolved via statewide ${selectedState === 'NC' ? 'NC OneMap' : 'SC parcel service'}.`);
    }
  }

  // 3) NC county parcel server - fallback when the statewide OneMap service is down.
  if (!parcelFeature && selectedState === 'NC' && (countyKeyLower === "mecklenburg" || countyParcelLayer)) {
    onStageChange?.("Statewide GIS unavailable — trying county parcel server...");
    try {
      const localRes = countyKeyLower === "mecklenburg"
        ? await queryMecklenburgParcel(lng, lat)
        : countyParcelLayer ? await queryCountyParcel(countyParcelLayer, lng, lat) : null;
      if (localRes) {
        parcelFeature = localRes.wgs84Feature;
        statePlaneFeature = localRes.statePlaneFeature;
        console.log(`${countyName} parcel resolved via county GIS server (statewide fallback).`);
      }
    } catch (err) {
      console.warn(`County parcel query failed for ${countyName}:`, err);
    }
  }

  // 4) If both real GIS paths failed, never invent an SC parcel. NC retains the
  // legacy simulated outline for compatibility, but SC continues with an empty
  // record so the UI can link to the official county viewer.
  if (!parcelFeature) {
    if (selectedState === 'SC') {
      parcelFeature = {
        type: 'Feature',
        properties: { parno: 'N/A', ownname: 'N/A', cntyname: `${countyBaseName(countyName)}, SC`, recordsource: 'unavailable' },
        geometry: null,
      };
      statePlaneFeature = null;
    } else {
      console.log("Statewide GIS completely unresponsive and no local query succeeded. Generating deterministic simulated parcel outline.");
      const sim = generateSimulatedParcel(lng, lat, addressString, countyName);
      parcelFeature = sim.wgs84Feature;
      statePlaneFeature = sim.statePlaneFeature;
      isSimulated = true;
    }
  }

  let info = normalizeCountyParcelAttrs(parcelFeature.properties || {});

  // Self-correct the county from the ACTUAL parcel record (authoritative), for
  // BOTH states. The parcel point query is county-agnostic, so even if the county
  // was mis-detected up front, the resolved parcel's own County field is the truth
  // — use it for zoning, comps, tax rate, and display so a wrong county never
  // propagates. SC parcels carry cntyname as "<County>, SC"; NC as a bare name.
  if (!isSimulated && info?.cntyname) {
    const rawCnty = String(info.cntyname).trim();
    const isScParcel = /,\s*SC\s*$/i.test(rawCnty) || selectedState === 'SC';
    const parcelCnty = rawCnty.replace(/,\s*(NC|SC)\s*$/i, '').replace(/\s+County$/i, '').trim();
    const names = isScParcel ? SC_COUNTY_NAMES : NC_COUNTY_NAMES;
    const corrected = names.find((n) => n.toLowerCase() === parcelCnty.toLowerCase());
    if (corrected) {
      const qualified = `${corrected}, ${isScParcel ? 'SC' : 'NC'}`;
      const currentQualified = `${countyBaseName(countyName)}, ${countyState(countyName)}`;
      if (qualified.toLowerCase() !== currentQualified.toLowerCase()) {
        console.log(`County corrected "${countyName}" -> "${qualified}" from parcel County field.`);
        countyName = qualified;
      }
    }
  }

  const countyGisScRecord = selectedState === 'SC'
    ? officialRecordFromCountyGis(countyName, info)
    : null;
  // Structured treasurer and WTHGIS adapters can enrich a county GIS response
  // with current tax and assessment facts. When GIS already supplied an owner,
  // skip only the expensive browser fallback, not those structured adapters.
  const remoteOfficialScRecord = selectedState === 'SC'
    ? await fetchOfficialScParcel(
        countyName,
        addressString,
        String(info.parno || ''),
        { lat, lng },
        fetch,
        {
          candidateOwner: String(info.ownname || ''),
          skipBrowser: !!countyGisScRecord?.ownerName,
        },
      )
    : null;
  const officialScRecord = mergeOfficialScParcelRecords(remoteOfficialScRecord, countyGisScRecord);
  let geometryStatus: SiteFeasibilityData['geometryStatus'] = selectedState === 'SC'
    ? (info.recordsource === 'county-gis' ? 'verified' : info.recordsource === 'scdot' ? 'statewide-candidate' : 'unavailable')
    : 'verified';
  const parcelConflicts: string[] = [];

  if (selectedState === 'SC' && officialScRecord?.status === 'verified') {
    const candidateParcelId = info.parno;
    const candidateAcres = Number(info.gisacres || 0);
    const acreageConflicts = !!officialScRecord.acres && candidateAcres > 0 &&
      Math.abs(officialScRecord.acres - candidateAcres) / officialScRecord.acres > 0.1;
    const identityConflicts = info.recordsource === 'scdot' &&
      shouldHideStatewideGeometry(candidateParcelId, officialScRecord.parcelId);
    const statewideNotConfirmed = info.recordsource === 'scdot' &&
      /treasurer/i.test(officialScRecord.sourceName || '') && !officialScRecord.acres;
    if (identityConflicts || acreageConflicts || statewideNotConfirmed) {
      parcelFeature.geometry = null;
      statePlaneFeature = null;
      geometryStatus = 'stale-hidden';
      parcelConflicts.push(statewideNotConfirmed
        ? 'The current county tax record could not confirm the statewide SCDOT acreage, so the candidate boundary was hidden.'
        : 'The statewide SCDOT polygon conflicts with the current county assessor record and was hidden.');
    }

    info = {
      ...info,
      parno: officialScRecord.parcelId || info.parno,
      ownname: officialScRecord.ownerName || 'N/A',
      ownname2: '',
      siteadd: officialScRecord.situsAddress || info.siteadd,
      officialmailingaddress: officialScRecord.mailingAddress,
      gisacres: officialScRecord.acres && officialScRecord.acres > 0 ? officialScRecord.acres : (geometryStatus === 'stale-hidden' ? undefined : info.gisacres),
      reviseyear: officialScRecord.assessedYear,
      parval: officialScRecord.assessedPropertyValue,
      landval: officialScRecord.landValue,
      improvementvalue: officialScRecord.improvementValue,
      marketvalue: officialScRecord.marketValue,
      taxablevalue: officialScRecord.taxableValue,
      totalassessedvalue: officialScRecord.totalAssessedValue,
      taxcodearea: officialScRecord.taxCodeArea,
      taxamount: officialScRecord.taxAmount,
      taxyear: officialScRecord.taxYear,
      building: officialScRecord.building,
      recordsource: 'county-assessor',
    };
  } else if (selectedState === 'SC' && info.recordsource === 'scdot') {
    // No county source could confirm this parcel, so the statewide SCDOT
    // snapshot is the best real published record available. Keep its owner /
    // mailing / value data rather than blanking the report — the earlier
    // "wrong owner" bug was the snapshot OVERWRITING fresher county data, which
    // is fixed. The remaining risk is only snapshot lag, so the UI labels these
    // fields as the statewide record (ownerRecordType 'statewide') and links to
    // the county's own viewer for confirmation.
    parcelConflicts.push('Owner and value fields come from the statewide SCDOT parcel snapshot; the county assessor portal could not be queried automatically. Verify against the official county record before relying on them.');
  }

  // Extract WGS84 rings from geojson structure to draw the polygon boundary on Google Maps
  let boundaryRings: number[][][] = [];
  const geom = parcelFeature.geometry;
  if (geom) {
    if (geom.type === 'Polygon') {
      boundaryRings = geom.coordinates;
    } else if (geom.type === 'MultiPolygon') {
      boundaryRings = geom.coordinates[0];
    }
  }

  // Extract State Plane rings in feet for layout measurements (Esri JSON f=json format)
  let statePlaneRings: number[][][] = [];
  if (statePlaneFeature && statePlaneFeature.geometry && statePlaneFeature.geometry.rings) {
    statePlaneRings = statePlaneFeature.geometry.rings;
  }

  // Determine state plane coordinates from the first vertex of the first ring if available
  let ncStatePlaneX = 0;
  let ncStatePlaneY = 0;
  if (statePlaneRings && statePlaneRings[0] && statePlaneRings[0][0]) {
    ncStatePlaneX = statePlaneRings[0][0][0];
    ncStatePlaneY = statePlaneRings[0][0][1];
  }

  if (countyName.trim().toLowerCase() === "mecklenburg" && (!ncStatePlaneX || !ncStatePlaneY)) {
    // Mecklenburg coordinates fallback resolution
    const statePlaneCoords = await queryStatePlaneBounds(lng, lat);
    if (statePlaneCoords) {
      ncStatePlaneX = statePlaneCoords.x;
      ncStatePlaneY = statePlaneCoords.y;
    }
  }

  // Some counties store the parcel id as a number (e.g. Horry's PIN double) —
  // coerce to string so downstream .split()/.replace() calls can't crash.
  const parcelId = String(info.parno ?? '').trim() || "N/A";

  // Kick off the USGS 3DEP topography sampling NOW — it's independent of the
  // zoning/comps lookups below, so running it in parallel shaves several
  // seconds off the total search time. It's awaited just before returning.
  onStageChange?.("Evaluating site topography (USGS 3DEP)...");
  const slopeProfilePromise = fetchOpenTopographySlope(lat, lng, parcelId, boundaryRings);

  // Authoritative environmental constraints, queried by coordinate in parallel:
  // FEMA National Flood Hazard Layer (flood zone) and USFWS National Wetlands Inventory.
  const floodZonePromise = fetchFemaFloodZone(lat, lng);
  const wetlandsPromise = fetchNwiWetlands(lat, lng);

  // Zoning is resolved AFTER the base parcel data is emitted (further below) so
  // the GIS results render immediately. Variables declared here; assigned later.
  let zoningCode = "";
  let zoningDescription = "Determining zoning district...";
  let zoningSource: 'county-gis' | 'web' | undefined;
  let zoningSourceUrl: string | undefined;

  // Calculate perimeter of the parcel in feet from State Plane coordinates
  let perimeter = 0;
  if (statePlaneRings && statePlaneRings[0]) {
    const ring = statePlaneRings[0];
    for (let i = 0; i < ring.length - 1; i++) {
      const dx = ring[i+1][0] - ring[i][0];
      const dy = ring[i+1][1] - ring[i][1];
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > 3) {
        perimeter += dist;
      }
    }
  }

  let gisAcres = info.gisacres ? parseFloat(info.gisacres) : 0;
  // Some counties (e.g. Cumberland) store a missing/garbage gisacres value, so
  // compute the area from the parcel polygon and use it when the recorded value
  // is absent or implausibly off (> 5x difference) from the geometry.
  if (!isSimulated) {
    const computedAcres = acresFromGeometry(statePlaneRings, boundaryRings, lat);
    if (computedAcres > 0.0005 && (!(gisAcres > 0.005) || gisAcres / computedAcres > 5 || computedAcres / gisAcres > 5)) {
      gisAcres = computedAcres;
    }
  }
  const grossSf = Math.round(gisAcres * 43560);

  // Compute the lot's true width & depth from the actual parcel polygon using a
  // minimum-area bounding rectangle. Falls back to a perimeter/area rectangle
  // approximation only when geometry is unavailable.
  let W: number;
  let D: number;
  const obb = statePlaneRings && statePlaneRings[0] ? orientedBoundingBox(statePlaneRings[0]) : null;
  if (obb && obb.width > 0 && obb.depth > 0) {
    W = obb.width;
    D = obb.depth;
  } else {
    const P_2 = (perimeter > 0 ? perimeter : 4 * Math.sqrt(grossSf)) / 2;
    const A = grossSf > 0 ? grossSf : 29185;
    D = P_2;
    W = A / P_2;
    const discriminant = P_2 * P_2 - 4 * A;
    if (discriminant >= 0) {
      D = (P_2 + Math.sqrt(discriminant)) / 2;
      W = A / D;
    }
  }

  // B. Typical dimensional standards for this district. These are ESTIMATES by
  // use category for early feasibility screening — they're labeled as estimates
  // in the UI and must be confirmed against the jurisdiction's zoning ordinance.
  // Frontage comes from the real parcel geometry, not the estimate. Computed as
  // a function because it's re-derived once the real zoning district resolves.
  const buildGridics = () => {
    const standards = estimateZoningStandards(zoningCode, zoningDescription);
    const { frontFt, rearFt, sideFt } = standards.setbacks;
    const netWidth = Math.max(0, W - 2 * sideFt);
    const netDepth = Math.max(0, D - (frontFt + rearFt));
    // Only report a single Width x Depth when the lot is roughly rectangular
    // (its bounding box fills most of the parcel). For irregular lots a single
    // W x D would misrepresent the area, so it's omitted.
    const obbFill = W > 0 && D > 0 && grossSf > 0 ? grossSf / (W * D) : 1;
    const isRectangularish = obbFill >= 0.85;
    return {
      frontageLengthFt: W > 0 ? Math.round(W * 100) / 100 : 0,
      lotWidthFt: isRectangularish ? Math.round(W * 10) / 10 : undefined,
      lotDepthFt: isRectangularish ? Math.round(D * 10) / 10 : undefined,
      lotType: standards.lotType,
      // Max footprint ≈ a typical maximum lot coverage applied to the parcel area.
      maxBuildingFootprintSqft: Math.round(grossSf * 0.4),
      maxHeightFt: standards.maxHeightFt,
      floorAreaRatio: standards.floorAreaRatio,
      setbacks: { frontFt, rearFt, sideFt },
      netBuildableAreaSqft: Math.round(netWidth * netDepth),
    };
  };
  let gridics = buildGridics();

  // Owner name. The GIS's dedicated ownfrst/ownlast fields are AUTHORITATIVE for
  // first/last order when populated (counties vary: some store ownname surname-
  // first, others first-last — so parsing ownname alone gets the order wrong).
  const gisFirst = String(info.ownfrst ?? '').trim();
  const gisLast = String(info.ownlast ?? '').trim();
  let ownerName: string | undefined;
  let ownerFirst: string | undefined;
  let ownerLast: string | undefined;
  if (gisFirst && gisLast) {
    ownerName = toTitleCase(`${gisFirst} ${gisLast}`);
    ownerFirst = gisFirst;
    ownerLast = gisLast;
  } else if (info.ownname && String(info.ownname).trim().toUpperCase() !== 'N/A') {
    ownerName = formatOwnerName(info.ownname); // surname-first parse fallback
  }
  if (ownerName && info.ownname2 && String(info.ownname2).trim()) {
    ownerName += " & " + formatOwnerName(info.ownname2);
  }

  // Format mailing address
  let mailingAddress: string | undefined;
  const trimmed = (v: unknown) => String(v ?? '').trim(); // county fields can be fixed-width padded
  if (info.officialmailingaddress) {
    mailingAddress = toTitleCase(trimmed(info.officialmailingaddress));
  } else if (info.mailadd) {
    mailingAddress = '';
    mailingAddress += toTitleCase(trimmed(info.mailadd));
    if (trimmed(info.mcity)) mailingAddress += `, ${toTitleCase(trimmed(info.mcity))}`;
    if (trimmed(info.mstate)) mailingAddress += `, ${trimmed(info.mstate)}`;
    if (trimmed(info.mzip)) {
      mailingAddress += ` ${trimmed(info.mzip)}`;
    }
  }

  // Formulate dates
  let dateOfSale: string | undefined;
  if (info.saledate) {
    const d = new Date(info.saledate);
    if (!isNaN(d.getTime())) {
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      dateOfSale = `${yyyy}${mm}${dd}`;
    }
  }

  const charCodeSum = (parcelId || "").split("").reduce((sum: number, char: string) => sum + char.charCodeAt(0), 0);

  // The legacy NC flow retains its deterministic placeholders. SC registry
  // fields must only come from an official published record.
  const tractSuffix = String(charCodeSum % 999999).padStart(6, '0');
  const blockGroup = String(charCodeSum % 10);
  const censusTract = selectedState === 'SC' ? undefined : `00${tractSuffix.substring(0, 4)}${tractSuffix.substring(4, 6)}${blockGroup}`;

  // Formulate values
  const assessedYear = info.reviseyear ? parseInt(info.reviseyear) : (selectedState === 'SC' ? undefined : 2025);
  const assessedPropertyValue = info.parval != null ? parseFloat(info.parval) : undefined;
  const landValue = info.landval != null ? parseFloat(info.landval) : undefined;
  
  // Determine if contact by mail
  const contactByMail = selectedState === 'SC'
    ? (mailingAddress ? 'Yes' : undefined)
    : (info.mcity && info.scity && info.mcity.trim().toLowerCase() !== info.scity.trim().toLowerCase() ? 'Yes' : 'No');

  // Deed Type
  const deedType = selectedState === 'SC' ? undefined : "Warranty Deed";
  const deedBookPage = info.sourceref && info.sourceref !== 'N/A' ? info.sourceref : undefined;

  // Price Sold For & dynamic transaction history estimation
  let priceSoldFor: number | undefined;
  if (selectedState !== 'SC' && assessedPropertyValue && assessedPropertyValue > 0) {
    let factor = 0.7;
    const saleYear = info.saledate ? new Date(info.saledate).getFullYear() : 2000;
    if (saleYear < 1980) {
      factor = 0.0675; // e.g. 5000 for 74100 assessed value
    } else if (saleYear < 1990) {
      factor = 0.2;
    } else if (saleYear < 2000) {
      factor = 0.4;
    } else if (saleYear < 2010) {
      factor = 0.6;
    }
    priceSoldFor = Math.round(assessedPropertyValue * factor);
  }

  // Tax computation
  const taxCodeArea = info.taxcodearea != null
    ? String(info.taxcodearea)
    : selectedState === 'SC' ? undefined : String((charCodeSum % 15) + 1).padStart(2, '0');
  const taxRate = countyName.toLowerCase() === "mecklenburg" ? 0.00793 : 0.0065;
  const taxAmount = info.taxamount != null
    ? Number(info.taxamount)
    : selectedState === 'SC' || assessedPropertyValue == null ? undefined : Math.round(assessedPropertyValue * taxRate * 100) / 100;
  const taxYear = info.taxyear != null ? Number(info.taxyear) : selectedState === 'SC' ? undefined : assessedYear;
  const salePriceFull = selectedState === 'SC' ? undefined : "Financial consideration";
  const legalDescription = info.legdecfull && info.legdecfull !== 'SC Parcel'
    ? info.legdecfull.replace(/-/g, ' ')
    : selectedState === 'SC' ? undefined : ("Lot " + parcelId);
  const totalValueCalculated = info.marketvalue != null
    ? Number(info.marketvalue)
    : selectedState === 'SC' ? undefined : assessedPropertyValue;
  const typeOfTransaction = selectedState === 'SC' ? undefined : "Resale";
  const ownerRecordType: SiteFeasibilityData['ownerRecordType'] = ownerName
    ? (officialScRecord?.ownerRecordType || (info.recordsource === 'county-gis' ? 'gis' : info.recordsource === 'scdot' ? 'statewide' : 'unavailable'))
    : 'unavailable';

  // Detailed Property Registry data container
  const registryData = {
    ownerName,
    ownerFirst,
    ownerLast,
    mailingAddress,
    assessedYear,
    assessedPropertyValue,
    landValue,
    improvementValue: info.improvementvalue != null ? Number(info.improvementvalue) : undefined,
    marketValue: info.marketvalue != null ? Number(info.marketvalue) : undefined,
    taxableValue: info.taxablevalue != null ? Number(info.taxablevalue) : undefined,
    totalAssessedValue: info.totalassessedvalue != null ? Number(info.totalassessedvalue) : undefined,
    contactByMail,
    deedBookPage,
    deedType,
    censusTract,
    priceSoldFor,
    dateOfSale,
    taxCodeArea,
    taxAmount,
    taxYear,
    salePriceFull,
    legalDescription,
    totalValueCalculated,
    typeOfTransaction,
    building: info.building,
    parcelVerificationStatus: officialScRecord?.status,
    parcelSourceName: officialScRecord?.sourceName
      || (info.recordsource === 'county-gis' ? 'County GIS'
        : info.recordsource === 'scdot' ? 'SCDOT statewide parcel snapshot — verify with county' : undefined),
    parcelSourceUrl: officialScRecord?.sourceUrl
      || (selectedState === 'SC' ? scCountySource(countyName)?.portalUrl : undefined),
    parcelSourceAsOf: officialScRecord?.asOf,
    ownerRecordType,
    geometryStatus,
    parcelConflicts,
  };

  // -------------------------------------------------------------------------
  // STAGE 1 — emit the base parcel/GIS result IMMEDIATELY. Zoning, topography,
  // and comps stream in afterwards via further onPartial() emissions.
  // -------------------------------------------------------------------------
  const baseResult: SiteFeasibilityData = {
    inputAddress: info.siteadd || addressString,
    parcelId: info.parno || "N/A",
    countyName: countyName,
    grossSf,
    gisAcres,
    zoningCode,
    zoningDescription,
    zoningSource,
    zoningSourceUrl,
    isSimulated,
    coordinates: {
      lat,
      lng,
      ncStatePlaneX,
      ncStatePlaneY
    },
    boundaryRings,
    statePlaneRings,
    gridics,
    ...registryData,
    slopeProfile: undefined, // pending — emitted when USGS sampling completes
    comps: undefined,        // pending — emitted when comp verification completes
  };
  onPartial?.(baseResult);

  // STAGE 2 — topography: emit the slope profile the moment USGS sampling
  // finishes (it runs concurrently with the zoning + comps lookups below).
  const slopeEmitted = slopeProfilePromise.then((sp) => {
    onPartial?.({ slopeProfile: sp });
    return sp;
  });

  // STAGE 3 — zoning. COMBINE the county's authoritative GIS zoning layer with a
  // Gemini verification: the GIS code at the parcel point SEEDS the AI, which
  // confirms it against the official zoning map (or fills it in for city parcels
  // the county layer leaves blank). GIS stays authoritative — the AI confirms it,
  // fills gaps, or flags a discrepancy to verify. Never fabricated.
  // Always resolve the current district for each submitted search. Zoning and
  // official source pages can change, so repeat searches must not reuse a prior run.
  const parcelZoning = String(info.zoning || '').trim();
  if (parcelZoning && parcelZoning.toUpperCase() !== 'N/A') {
    zoningCode = parcelZoning;
    zoningDescription = `${countyName} County GIS parcel zoning district`;
    zoningSource = 'county-gis';
    zoningSourceUrl = undefined;
  } else {
    onStageChange?.("Resolving zoning (county GIS + AI)...");
    const gisZoning = await fetchCountyZoningCode(countyName, lng, lat).catch(() => null);
    const aiZoning = await fetchZoningViaWebSearch(info.siteadd || addressString, countyName, lat, lng, gisZoning?.code || null).catch(() => null);
    const normZ = (s: string) => (s || '').toUpperCase().replace(/\s+/g, '');

    if (gisZoning && aiZoning && normZ(gisZoning.code) === normZ(aiZoning.code)) {
      // Both agree → authoritative GIS code, AI-confirmed.
      zoningCode = gisZoning.code;
      zoningDescription = `${gisZoning.description || aiZoning.description || `${countyName} County GIS zoning district`} (county GIS — AI-confirmed)`;
      zoningSource = 'county-gis';
      zoningSourceUrl = aiZoning.sourceUrl;
    } else if (gisZoning) {
      // GIS has the authoritative code (AI couldn't confirm or differed → keep GIS, flag).
      zoningCode = gisZoning.code;
      zoningDescription = `${gisZoning.description || `${countyName} County GIS zoning district`}${aiZoning ? ` (county GIS; AI suggested ${aiZoning.code} — verify)` : ''}`;
      zoningSource = 'county-gis';
      zoningSourceUrl = aiZoning?.sourceUrl;
    } else if (aiZoning) {
      // City parcel / GIS gap → the AI lookup fills it in.
      zoningCode = aiZoning.code;
      zoningDescription = `${aiZoning.description} (AI web lookup — verify)`;
      zoningSource = 'web';
      zoningSourceUrl = aiZoning.sourceUrl;
    } else {
      // Never show "See map" — neither source resolved it; the report's grounded
      // zoning section verifies it against the authoritative county GIS.
      zoningCode = "N/A";
      zoningDescription = hasCountyZoning(countyName)
        ? `Not auto-resolved at the parcel point — to be verified against ${countyName} County GIS`
        : "No published county zoning GIS; web lookup found nothing";
    }
  }

  gridics = buildGridics(); // re-derive setback/height estimates from the real district
  onPartial?.({ zoningCode, zoningDescription, zoningSource, zoningSourceUrl, gridics });

  // STAGE 4 — comps (need the zoning use-category, so they start after zoning).
  // Pass the full input address (it has the city/ZIP) so the comp search targets
  // the right area — the parcel's situs field is often street-only.
  const compLocationAddress = `${addressString}${info.scity && !addressString.toLowerCase().includes(String(info.scity).toLowerCase()) ? `, ${info.scity}` : ''}`;
  const compRun = await fetchGoogleDistanceMatrixComps(lat, lng, parcelId, zoningCode, zoningDescription, compLocationAddress, countyName, onStageChange, compRadiusMiles);
  onPartial?.({ comps: compRun.comps, compRunSummary: compRun.summary });

  const slopeProfile = await slopeEmitted;
  const [floodZone, wetlands] = await Promise.all([
    floodZonePromise.catch(() => undefined),
    wetlandsPromise.catch(() => undefined),
  ]);

  return {
    ...baseResult,
    zoningCode,
    zoningDescription,
    zoningSource,
    zoningSourceUrl,
    gridics,
    slopeProfile,
    floodZone,
    wetlands,
    comps: compRun.comps,
    compRunSummary: compRun.summary
  };
}

/**
 * Current 30-year fixed mortgage rate (Freddie Mac PMMS via FRED, MORTGAGE30US).
 * Tries the serverless proxy first (FRED sends no browser CORS header), then a
 * direct CSV read as a fallback. Cached ~12h (the series is weekly). Returns null
 * if unavailable, so the report falls back to a Google-Search rate instead.
 */
export async function fetchCurrentMortgageRate(): Promise<{ rate: number; date: string } | null> {
  const ck = 'gisfs:mortgage30:v1';
  try {
    const raw = localStorage.getItem(ck);
    if (raw) {
      const v = JSON.parse(raw);
      if (v?.d && Number.isFinite(v.d.rate) && Date.now() - (v.t || 0) < 12 * 60 * 60 * 1000) return v.d;
    }
  } catch { /* ignore */ }

  const cache = (d: { rate: number; date: string }) => {
    try { localStorage.setItem(ck, JSON.stringify({ d, t: Date.now() })); } catch { /* ignore */ }
    return d;
  };

  // Serverless proxy only — a direct browser fetch to FRED always CORS-fails in
  // production, so we don't attempt it (it only created console errors). When the
  // proxy is unavailable the report researches the rate via Google Search instead.
  try {
    const res = await fetchWithTimeout('/.netlify/functions/mortgage-rate', 8000);
    if (res.ok && (res.headers.get('content-type') || '').includes('json')) {
      const data = await res.json();
      if (Number.isFinite(data?.rate)) return cache({ rate: data.rate, date: String(data.date || '') });
    }
  } catch { /* fall through */ }

  return null;
}

// NC county → 5-digit FIPS (state 37 + county code), for FRED's Realtor.com
// county housing series. Used to anchor the market-saturation section.
const ncCountyFips: Record<string, string> = {
  Alamance: '37001', Alexander: '37003', Alleghany: '37005', Anson: '37007', Ashe: '37009',
  Avery: '37011', Beaufort: '37013', Bertie: '37015', Bladen: '37017', Brunswick: '37019',
  Buncombe: '37021', Burke: '37023', Cabarrus: '37025', Caldwell: '37027', Camden: '37029',
  Carteret: '37031', Caswell: '37033', Catawba: '37035', Chatham: '37037', Cherokee: '37039',
  Chowan: '37041', Clay: '37043', Cleveland: '37045', Columbus: '37047', Craven: '37049',
  Cumberland: '37051', Currituck: '37053', Dare: '37055', Davidson: '37057', Davie: '37059',
  Duplin: '37061', Durham: '37063', Edgecombe: '37065', Forsyth: '37067', Franklin: '37069',
  Gaston: '37071', Gates: '37073', Graham: '37075', Granville: '37077', Greene: '37079',
  Guilford: '37081', Halifax: '37083', Harnett: '37085', Haywood: '37087', Henderson: '37089',
  Hertford: '37091', Hoke: '37093', Hyde: '37095', Iredell: '37097', Jackson: '37099',
  Johnston: '37101', Jones: '37103', Lee: '37105', Lenoir: '37107', Lincoln: '37109',
  McDowell: '37111', Macon: '37113', Madison: '37115', Martin: '37117', Mecklenburg: '37119',
  Mitchell: '37121', Montgomery: '37123', Moore: '37125', Nash: '37127', 'New Hanover': '37129',
  Northampton: '37131', Onslow: '37133', Orange: '37135', Pamlico: '37137', Pasquotank: '37139',
  Pender: '37141', Perquimans: '37143', Person: '37145', Pitt: '37147', Polk: '37149',
  Randolph: '37151', Richmond: '37153', Robeson: '37155', Rockingham: '37157', Rowan: '37159',
  Rutherford: '37161', Sampson: '37163', Scotland: '37165', Stanly: '37167', Stokes: '37169',
  Surry: '37171', Swain: '37173', Transylvania: '37175', Tyrrell: '37177', Union: '37179',
  Vance: '37181', Wake: '37183', Warren: '37185', Washington: '37187', Watauga: '37189',
  Wayne: '37191', Wilkes: '37193', Wilson: '37195', Yadkin: '37197', Yancey: '37199',
};

Object.assign(
  ncCountyFips,
  Object.fromEntries(
    SC_COUNTY_NAMES.flatMap((name) => {
      const fips = SC_COUNTY_FIPS[name];
      const qualified = [`${name}, SC`, fips] as const;
      const overlapsNc = NC_COUNTY_NAMES.some((n) => n.toLowerCase() === name.toLowerCase());
      return overlapsNc ? [qualified] : [qualified, [name, fips] as const];
    }),
  ),
);

export interface MarketMetric { value: number; date: string; prev3?: number | null; prevYear?: number | null; }
export interface CountyMarketStats {
  fips: string;
  medianDaysOnMarket?: MarketMetric | null;
  activeListings?: MarketMetric | null;
  medianListPrice?: MarketMetric | null;
  newListings?: MarketMetric | null;
}

/**
 * County housing-market stats (median days on market, active listings, median
 * list price, new listings — all residential, Realtor.com via FRED). Tries the
 * serverless proxy first, then a direct CSV read. Cached ~24h. Returns null when
 * unavailable so the report falls back to a Google-Search market read.
 */
export async function fetchCountyMarketStats(countyName: string): Promise<CountyMarketStats | null> {
  const rawCountyName = countyName?.trim() || '';
  const baseCountyName = countyBaseName(rawCountyName);
  const state = countyState(rawCountyName);
  const fips = ncCountyFips[rawCountyName] || ncCountyFips[`${baseCountyName}, ${state}`] || ncCountyFips[baseCountyName];
  if (!fips) return null;
  const ck = `gisfs:mktstats:v1:${fips}`;
  try {
    const raw = localStorage.getItem(ck);
    if (raw) {
      const v = JSON.parse(raw);
      if (v?.d && Date.now() - (v.t || 0) < 24 * 60 * 60 * 1000) return v.d;
    }
  } catch { /* ignore */ }

  const cache = (d: CountyMarketStats) => {
    try { localStorage.setItem(ck, JSON.stringify({ d, t: Date.now() })); } catch { /* ignore */ }
    return d;
  };

  // 1) Serverless proxy (one request, no CORS).
  try {
    const res = await fetchWithTimeout(`/.netlify/functions/market-stats?fips=${fips}`, 10000);
    if (res.ok && (res.headers.get('content-type') || '').includes('json')) {
      const data = await res.json();
      if (data && (data.medianDaysOnMarket || data.activeListings)) return cache({ fips, ...data });
    }
  } catch { /* fall through */ }

  // No direct browser FRED fallback — those cross-origin CSV fetches always
  // CORS-fail in production (they only spammed the console). The serverless proxy
  // above is the single path; on failure the report researches §17 via Google.
  return null;
}

// Redfin county market data (per product type) — pre-digested monthly by a
// GitHub Action into a small static JSON the app reads. The real §17 anchor.
export interface RedfinTypeMetrics {
  periodEnd: string;
  monthsOfSupply: number | null;
  medianDom: number | null;
  medianDomYoy: number | null;     // absolute day change YoY
  inventory: number | null;
  inventoryYoy: number | null;     // fraction (e.g. -0.008 = -0.8%)
  homesSold: number | null;
  newListings: number | null;
  medianSalePrice: number | null;
  medianSalePriceYoy: number | null; // fraction
  soldAboveList: number | null;      // fraction (share)
}
interface RedfinPayload {
  updated: string; source: string; sourceUrl: string;
  counties: Record<string, Record<string, RedfinTypeMetrics>>;
}

let _redfinPayload: RedfinPayload | null | undefined;

/** County market data by product type from the pre-digested Redfin JSON, or null. */
export async function fetchRedfinCountyMarket(
  countyName: string,
): Promise<{ updated: string; sourceUrl: string; byType: Record<string, RedfinTypeMetrics> } | null> {
  if (_redfinPayload === undefined) {
    try {
      const res = await fetchWithTimeout('/market/nc-county-redfin.json', 8000);
      _redfinPayload = res.ok && (res.headers.get('content-type') || '').includes('json') ? await res.json() : null;
    } catch {
      _redfinPayload = null;
    }
  }
  const byType = _redfinPayload?.counties?.[countyName?.trim()];
  if (!byType) return null;
  return { updated: _redfinPayload!.updated, sourceUrl: _redfinPayload!.sourceUrl, byType };
}

/** Build the per-product-type market-saturation markdown table for the packet. */
export function buildRedfinSaturationTable(
  countyName: string,
  data: { updated: string; sourceUrl: string; byType: Record<string, RedfinTypeMetrics> },
): string {
  const order: [string, string][] = [
    ['single_family', 'Single-family'], ['townhouse', 'Townhouse'],
    ['condo', 'Condo/Co-op'], ['multifamily', 'Multi-family (2-4u)'], ['all', 'All residential'],
  ];
  const n0 = (v: number | null) => (v == null ? 'n/a' : Math.round(v).toLocaleString());
  const mos = (v: number | null) => (v == null ? 'n/a' : v.toFixed(1));
  const dom = (m: RedfinTypeMetrics) =>
    m.medianDom == null ? 'n/a' : `${Math.round(m.medianDom)}${m.medianDomYoy != null ? ` (${m.medianDomYoy > 0 ? '+' : ''}${Math.round(m.medianDomYoy)}d YoY)` : ''}`;
  const inv = (m: RedfinTypeMetrics) =>
    m.inventory == null ? 'n/a' : `${Math.round(m.inventory).toLocaleString()}${m.inventoryYoy != null ? ` (${m.inventoryYoy >= 0 ? '+' : ''}${(m.inventoryYoy * 100).toFixed(0)}% YoY)` : ''}`;
  const price = (m: RedfinTypeMetrics) =>
    m.medianSalePrice == null ? 'n/a' : `$${Math.round(m.medianSalePrice).toLocaleString()}${m.medianSalePriceYoy != null ? ` (${m.medianSalePriceYoy >= 0 ? '+' : ''}${(m.medianSalePriceYoy * 100).toFixed(1)}% YoY)` : ''}`;
  const aboveList = (v: number | null) => (v == null ? 'n/a' : `${(v * 100).toFixed(0)}%`);

  const rows: string[] = [];
  let asOf = data.updated;
  for (const [key, label] of order) {
    const m = data.byType[key];
    if (!m) continue;
    asOf = m.periodEnd || asOf;
    rows.push(`| ${label} | ${mos(m.monthsOfSupply)} | ${dom(m)} | ${inv(m)} | ${n0(m.homesSold)} | ${n0(m.newListings)} | ${price(m)} | ${aboveList(m.soldAboveList)} |`);
  }
  if (!rows.length) return '';
  return [
    `Live per-PRODUCT-TYPE county market data — ${countyName} County, monthly, as of ${asOf} (Data source: Redfin). USE this table as the Section 17 anchor: read which product types are OVERSUPPLIED / slow (high months-of-supply, rising DOM) vs. absorbing fast (low supply, high % sold above list), recommend what to build, then refine to the ZIP/submarket via Google Search. Cite "Data source: Redfin" (${data.sourceUrl}).`,
    '',
    '| Product type | Months of supply | Median DOM | Active inventory | Homes sold/mo | New listings/mo | Median sale price | % sold above list |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

export interface LlcProperty { address: string; county: string; value: number; saleEpoch?: number; }

export interface LlcSkipTrace {
  entityName: string | null;
  sosId?: string | null;
  status?: string | null;
  entityType?: string | null;
  formationDate?: string | null;
  registeredAgentName?: string | null;
  registeredAgentAddress?: string | null;
  principalOffice?: string | null;
  mailingAddress?: string | null;
  officials?: { name: string; title?: string; address?: string }[];
  recentFiling?: string | null;
  notes?: string | null;
  sources?: string[];
  confidence?: 'high' | 'medium' | 'low' | string | null;

  // From NC GIS / county tax records (the reliable backbone — no Cloudflare)
  foundInGIS?: boolean;
  taxMailingAddress?: string | null;
  properties?: LlcProperty[];
  propertyCount?: number;
  propertyCountCapped?: boolean;
  countiesOwned?: string[];
  totalAssessedValue?: number;
}

/**
 * Look an entity up in the NC statewide parcel/tax layer by owner name. Returns
 * the LLC's MAILING address (where the county sends tax bills — the real
 * skip-trace contact) and every NC property it owns. Always available (no
 * Cloudflare), so this is the backbone of the skip trace.
 */
export async function skipTraceLLCViaGIS(name: string): Promise<{
  canonicalName: string; mailingAddress: string | null; properties: LlcProperty[];
  propertyCount: number; capped: boolean; counties: string[]; totalAssessed: number; mostRecentSaleEpoch?: number;
} | null> {
  // Owner names in the layer are stored UPPERCASE, so we uppercase the input and
  // skip the per-row UPPER() function and any server-side sort — this keeps the
  // statewide owner scan as cheap as possible (it's the kind of heavy query the
  // GIS WAF throttles, so cheaper = less likely to be blocked; we sort by value
  // on the client below).
  const clean = name.trim().toUpperCase().replace(/'/g, "''");
  if (clean.length < 3) return null;
  const where = `ownname LIKE '%${clean}%'`;
  const url = `${NC_PARCEL_ENGINE}?where=${encodeURIComponent(where)}` +
    `&outFields=${encodeURIComponent('parno,ownname,siteadd,scity,mailadd,mcity,mstate,mzip,parval,cntyname,saledate')}` +
    `&returnGeometry=false&resultRecordCount=200&f=json`;

  // Retry a couple of times (the statewide owner scan is occasionally throttled).
  let data: any = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchWithTimeout(url, 20000);
      if (res.ok) {
        const parsed = await res.json().catch(() => null);
        if (parsed && !parsed.error) { data = parsed; break; }
      }
    } catch { /* retry */ }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
  }
  if (!data) return null;

  const rows = (data.features || []).map((f: any) => f.attributes).filter((a: any) => a?.ownname);
  if (!rows.length) return null;

  // Canonical owner name = the most common exact ownname among the matches.
  const nameCount = new Map<string, number>();
  for (const a of rows) { const n = String(a.ownname).trim(); if (n) nameCount.set(n, (nameCount.get(n) || 0) + 1); }
  const canonicalName = [...nameCount.entries()].sort((a, b) => b[1] - a[1])[0][0];

  const fmtMail = (a: any) => [String(a.mailadd ?? '').trim(), [String(a.mcity ?? '').trim(), String(a.mstate ?? '').trim()].filter(Boolean).join(' '), String(a.mzip ?? '').trim()]
    .filter(Boolean).join(', ').replace(/\s+/g, ' ').trim();

  const mailCount = new Map<string, number>();
  const properties: LlcProperty[] = [];
  const counties = new Set<string>();
  let totalAssessed = 0;
  let mostRecentSaleEpoch: number | undefined;
  for (const a of rows) {
    const mail = fmtMail(a);
    if (mail) mailCount.set(mail, (mailCount.get(mail) || 0) + 1);
    const situs = String(a.siteadd ?? '').trim();
    const scity = String(a.scity ?? '').trim();
    const county = String(a.cntyname ?? '').trim();
    if (county) counties.add(county);
    const value = Number(a.parval) || 0;
    totalAssessed += value;
    const sale = Number(a.saledate);
    if (Number.isFinite(sale) && (mostRecentSaleEpoch == null || sale > mostRecentSaleEpoch)) mostRecentSaleEpoch = sale;
    properties.push({
      address: situs ? `${situs}${scity ? `, ${scity}` : ''}` : `${county} County parcel ${a.parno}`,
      county, value, saleEpoch: Number.isFinite(sale) ? sale : undefined,
    });
  }
  const mailingAddress = mailCount.size ? [...mailCount.entries()].sort((a, b) => b[1] - a[1])[0][0] : null;
  properties.sort((a, b) => b.value - a.value);

  return {
    canonicalName, mailingAddress, properties: properties.slice(0, 50),
    propertyCount: rows.length, capped: !!data.exceededTransferLimit,
    counties: [...counties].sort(), totalAssessed: Math.round(totalAssessed), mostRecentSaleEpoch,
  };
}

/**
 * Gemini + Google-Search grounded lookup of the SOS registration (registered
 * agent + managers/members). The live NC SOS site is Cloudflare-blocked and not
 * crawlable, but Google has INDEXED the public-records directories that republish
 * it — so grounded search reads those snippets without hitting any captcha. When
 * a GIS anchor is supplied (confirmed name + counties from the tax layer), the
 * model is told the entity definitely exists, which stops false "not found"
 * results and disambiguates similarly named entities. Persistent: it retries
 * more aggressively if the first pass finds no agent/officials.
 */
async function skipTraceLLCViaGemini(
  query: string,
  state: string,
  anchor?: { canonicalName?: string | null; counties?: string[] }
): Promise<LlcSkipTrace | null> {
  const geminiApiKey = getUserKeys().gemini || '';
  if (!geminiApiKey) return null;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${geminiApiKey}`;

  const name = anchor?.canonicalName || query;
  const registry = state === 'NC' ? 'the NC Secretary of State (sosnc.gov)' : `the ${state} Secretary of State business registry`;
  const anchorLine = anchor?.canonicalName
    ? `CONFIRMED REAL ENTITY: county tax records list "${anchor.canonicalName}" as the owner of real property${anchor.counties?.length ? ` in ${anchor.counties.join(', ')} County, ${state}` : ''}. Do NOT report that it cannot be found — it exists. Use this to pick the right entity among similar names.`
    : '';

  const buildPrompt = (aggressive: boolean) => `Find the ${state} Secretary of State registration for this LLC / business entity: "${name}".
${anchorLine}
PRIMARY GOAL: the REGISTERED AGENT and the COMPANY OFFICIALS (managers / members / officers) — the real people behind the LLC. That is the whole point of this lookup.
Use Google Search. The live SoS site is usually un-crawlable, so rely on the INDEXED public-records directories that republish it: ${registry} result snippets, bizapedia.com, corporationwiki.com, buzzfile.com, and news/legal filings. Do NOT use or cite OpenCorporates.${aggressive ? `
Search HARD with several queries and read the directory pages, e.g.:
  • "${name}" registered agent ${state}
  • "${name}" manager member ${state === 'NC' ? 'North Carolina' : state}
  • "${name}" bizapedia
  • "${name}" corporationwiki` : ''}
Return ONLY a JSON object inside a \`\`\`json code block:
\`\`\`json
{
  "entityName": "exact registered name",
  "sosId": "state SOSID / entity number | null",
  "status": "Active / Current-Active / Dissolved / Admin Dissolved | null",
  "entityType": "Limited Liability Company / Corporation | null",
  "formationDate": "YYYY-MM-DD | null",
  "registeredAgentName": "| null",
  "registeredAgentAddress": "| null",
  "principalOffice": "| null",
  "mailingAddress": "| null",
  "officials": [{ "name": "", "title": "Manager / Member / Officer / President", "address": "" }],
  "recentFiling": "most recent annual report or amendment + date | null",
  "confidence": "high | medium | low",
  "sources": ["https://...", "https://..."]
}
\`\`\`
Rules: NEVER invent names, addresses, IDs, or dates — use null for anything no source supports, and list the source URLs you actually used. Set "confidence" by how directly a credible source states the agent/officials. Do your best to fill registeredAgentName and at least one official; leave them null only if genuinely unavailable.`;

  // PERPLEXITY MODE: batched parallel searches over the SoS registry mirrors
  // feed the synthesis (no google_search tool); else legacy grounding.
  let llcResearch = '';
  if (liveWebResearchConfigured()) {
    const { block } = await perplexityResearchBlock([
      `"${name}" ${state} secretary of state registered agent`,
      `"${name}" bizapedia`,
      `"${name}" corporationwiki manager member`,
      `"${name}" LLC ${state} annual report officers`,
    ], { maxResultsPerQuery: 6, maxSources: 18, mode: 'hard' }).catch(() => ({ block: '', urls: [] as string[] }));
    llcResearch = block;
  }

  const callOnce = async (aggressive: boolean): Promise<LlcSkipTrace | null> => {
    try {
      const res = await queueGemini(() => fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: buildPrompt(aggressive) + llcResearch }] }],
          systemInstruction: { parts: [{ text: 'You are a meticulous corporate-records skip-tracer. You find the registered agent and the managers/members behind an LLC from the Secretary of State registry and indexed public-records directories. Report only source-supported facts; never fabricate. Return the requested JSON only.' }] },
          ...(llcResearch ? {} : { tools: [{ google_search: {} }] }),
        }),
      }), 'high');
      if (!res.ok) return null;
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.map((p: any) => p.text).filter(Boolean).join('') || '';
      const m = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/\{[\s\S]*\}/);
      const jsonStr = m ? (m[1] || m[0]) : '';
      if (!jsonStr) return null;
      const obj = JSON.parse(jsonStr.replace(/,\s*([}\]])/g, '$1')) as LlcSkipTrace;
      if (!obj) return null;
      if (!Array.isArray(obj.officials)) obj.officials = [];
      if (!Array.isArray(obj.sources)) obj.sources = [];
      return obj;
    } catch {
      return null;
    }
  };

  const hasContacts = (o: LlcSkipTrace | null) => !!(o && (o.registeredAgentName || (o.officials && o.officials.length)));

  let out = await callOnce(false);
  if (!hasContacts(out)) {
    const retry = await callOnce(true);
    if (hasContacts(retry) || (retry && !out)) out = retry;
  }
  if (out && !out.entityName) out.entityName = anchor?.canonicalName || query.trim();
  return out;
}

/**
 * Skip-trace an LLC. Backbone is NC GIS/tax records (the LLC's mailing address +
 * every property it owns — always available, no Cloudflare). Gemini + Google
 * Search supplements the SOS registration (registered agent + managers/members)
 * when it can. Returns a result whenever EITHER source finds the entity.
 */
export async function skipTraceLLC(query: string, state = 'NC'): Promise<LlcSkipTrace | null> {
  if (!getUserKeys().gemini) throw new Error('Gemini API key required (set it in Account Settings).');

  // GIS first (fast, reliable) so it can anchor the AI lookup — the confirmed
  // owner name + counties stop false "not found" results and disambiguate.
  const gis = state === 'NC' ? await skipTraceLLCViaGIS(query).catch(() => null) : null;

  // Registered agent / members from Gemini + indexed public records (the live SOS
  // site is Cloudflare-blocked). Enformion (in the Skip Trace UI) then layers the
  // real phones/emails on top.
  const ai = await skipTraceLLCViaGemini(
    query,
    state,
    gis ? { canonicalName: gis.canonicalName, counties: gis.counties } : undefined,
  ).catch(() => null);

  if (!gis && !ai) return null;

  const result: LlcSkipTrace = {
    entityName: gis?.canonicalName || ai?.entityName || query.trim(),
    sosId: ai?.sosId ?? null,
    status: ai?.status ?? null,
    entityType: ai?.entityType ?? null,
    formationDate: ai?.formationDate ?? null,
    registeredAgentName: ai?.registeredAgentName ?? null,
    registeredAgentAddress: ai?.registeredAgentAddress ?? null,
    principalOffice: ai?.principalOffice ?? null,
    mailingAddress: ai?.mailingAddress ?? null,
    officials: ai?.officials ?? [],
    recentFiling: ai?.recentFiling ?? null,
    sources: ai?.sources ?? [],
    confidence: ai?.confidence ?? null,
    // GIS backbone
    foundInGIS: !!gis,
    taxMailingAddress: gis?.mailingAddress ?? null,
    properties: gis?.properties ?? [],
    propertyCount: gis?.propertyCount ?? 0,
    propertyCountCapped: gis?.capped ?? false,
    countiesOwned: gis?.counties ?? [],
    totalAssessedValue: gis?.totalAssessed ?? 0,
  };
  return result;
}

// ===========================================================================
// Enformion Go — real skip tracing (phones, emails, addresses, relatives,
// associates) for the INDIVIDUALS and BUSINESSES behind GIS-owned properties.
// Proxied server-side (/.netlify/functions/enformion) to avoid CORS; the user's
// access-profile credentials are sent per call, never stored server-side.
// ===========================================================================

export interface SkipPhone { number: string; type?: string }
export interface OfficerContact { name: string; title?: string; phones: string[]; emails: string[] }
export interface SkipTraceContact {
  fullName?: string | null;
  age?: number | null;
  phones: SkipPhone[];
  emails: string[];
  addresses: string[];
  relatives?: string[];
  associates?: string[];
  /** Business mode: the members/officers behind an entity, each with their own
   *  skip-traced phones/emails. */
  officers?: OfficerContact[];
  isBusiness?: boolean;
  source: 'enformion';
}

/** True when both Enformion access-profile credentials are configured. */
export function enformionConfigured(): boolean {
  const k = getUserKeys();
  return !!(k.enformionApName && k.enformionApPassword);
}

/** Last Enformion call outcome, for surfacing a real reason in the UI. */
export interface EnformionDiag { status: number; host?: string; reason?: string; shape?: any; detail?: string; }
let lastEnformionDiag: EnformionDiag = { status: 0 };
export function getLastEnformionDiag(): EnformionDiag { return lastEnformionDiag; }
/** PII-safe shape (key names + types only) of the last Enformion response. */
export function getLastEnformionShape(): string {
  try { return lastEnformionDiag.shape ? JSON.stringify(lastEnformionDiag.shape) : ''; } catch { return ''; }
}
/** PII-safe outcome VALUES (message, totalResults, input errors/warnings, request
 *  type) of the last Enformion response — the actual reason for a 0-result. */
export function getLastEnformionDetail(): string { return lastEnformionDiag.detail || ''; }
export function enformionDiagMessage(): string {
  const d = lastEnformionDiag;
  // "Access Denied (Code 0)" arrives as HTTP 400 with an error body — it is an
  // ACCOUNT-side refusal (both hosts + the proxy were tried), not bad input.
  if (/access\s*denied/i.test(d.detail || '')) {
    return 'Enformion refused the request: Access Denied. This is account-side — verify in your Enformion dashboard (api.enformion.com) that the AP Name/Password in Account Settings are current, the access profile is ACTIVE with remaining credits, and no IP restriction is set on the profile (browser calls come from YOUR IP). Enformion support (supportgo@enformion.com) can confirm which of these tripped — then hit Retry.';
  }
  if (d.status === 401 || d.status === 403) return 'Enformion rejected the credentials — check the AP Name / AP Password in Account Settings.';
  if (d.status === 404) return 'Enformion endpoint not found (HTTP 404) — the API host/route may have changed.';
  if (d.status === 0) {
    if (d.reason === 'incomplete address') return 'Enformion was not called — this parcel\'s address is missing its city/state.';
    if (d.reason && /proxy error|timed out/i.test(d.reason)) return `Enformion did not answer in time (${d.reason}) — heavy searches like Property Records can be slow. Try again.`;
    if (!enformionConfigured()) return 'Enformion credentials are not set — add the AP Name / AP Password in Account Settings.';
    return `Could not reach Enformion${d.reason ? ` (${d.reason})` : ''} — network hiccup or a slow search. Try again.`;
  }
  if (d.status >= 500) return `Enformion service error (HTTP ${d.status}). Try again shortly.`;
  if (d.status >= 200 && d.status < 300) return 'No record matched this name/address in Enformion.';
  return `Enformion returned HTTP ${d.status}.`;
}

/** Human-readable Enformion error text (validation messages, input errors) —
 *  PII-safe: these are system fields about the REQUEST, not a person. */
function humanEnfError(d: any): string | undefined {
  if (!d || typeof d !== 'object') return undefined;
  const parts: string[] = [];
  const push = (v: any) => { const s = String(v ?? '').trim(); if (s && !parts.includes(s)) parts.push(s); };
  if (d.error && typeof d.error === 'object') {
    push(d.error.message); push(d.error.technicalErrorMessage);
    if (Array.isArray(d.error.inputErrors)) d.error.inputErrors.forEach(push);
    if (Array.isArray(d.error.warnings)) d.error.warnings.forEach(push);
  }
  push(d.title); // ASP.NET validation-problem shape
  if (d.errors && typeof d.errors === 'object') {
    for (const [k, v] of Object.entries(d.errors)) push(`${k}: ${Array.isArray(v) ? v.join('; ') : String(v)}`);
  }
  if (typeof d.message === 'string') push(d.message);
  return parts.length ? parts.join(' · ').slice(0, 300) : undefined;
}

// Enformion is called DIRECTLY from the browser: devapi.enformion.com serves
// every documented search type and answers preflight with
// Access-Control-Allow-Origin: * (verified live — ~0.4s response), so there is
// no serverless proxy in the hot path and no 10-second function limit to hit.
// devapi is tried first (api.enformion.com 404s PropertyV2Search); the Netlify
// proxy remains only as a last-resort fallback if a direct call can't connect.
const ENF_DIRECT_HOSTS = ['https://devapi.enformion.com', 'https://api.enformion.com'];

/** Remembered working direct host — once one answers, stick with it. */
let enfGoodHost: string | null = null;

async function enformionCall(path: string, searchType: string, body: any, timeoutMs = 45000): Promise<any | null> {
  const k = getUserKeys();
  if (!k.enformionApName || !k.enformionApPassword) { lastEnformionDiag = { status: 0, reason: 'not configured' }; return null; }
  const payload = JSON.stringify(body);

  // A refusal (400/402/403 — e.g. "Access Denied") on ONE host is NOT
  // definitive: Enformion access profiles are frequently valid on only ONE of
  // the two hosts (devapi vs api), so EVERY host — and then the server-side
  // proxy — gets a chance before giving up. Remembered for the final message.
  let refusal: typeof lastEnformionDiag | null = null;

  // 1. Direct browser → Enformion.
  const hosts = enfGoodHost ? [enfGoodHost, ...ENF_DIRECT_HOSTS.filter((h) => h !== enfGoodHost)] : ENF_DIRECT_HOSTS;
  for (const host of hosts) {
    try {
      const res = await fetchWithTimeout(`${host}${path}`, timeoutMs, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'galaxy-ap-name': k.enformionApName,
          'galaxy-ap-password': k.enformionApPassword,
          'galaxy-search-type': searchType,
          'galaxy-client-type': 'DevAPI', // per docs: required for JavaScript clients
        },
        body: payload,
      });
      const text = await res.text();
      let d: any = null;
      try { d = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
      const detail = humanEnfError(d) || (!res.ok && text ? text.slice(0, 200) : undefined);
      lastEnformionDiag = { status: res.status, host, reason: res.ok ? undefined : `HTTP ${res.status}`, shape: d != null ? describeShape(d) : undefined, detail };
      if (res.ok) { enfGoodHost = host; return d; } // success — pin this host
      if (res.status === 400 || res.status === 402 || res.status === 403) {
        // Refusal on THIS host — remember it, but keep trying the other host
        // and the proxy (the same credentials may be accepted there).
        refusal = lastEnformionDiag;
        console.warn(`Enformion ${path} via ${host}: HTTP ${res.status} — trying the next route.`, detail || '');
        continue;
      }
      console.warn(`Enformion ${path} via ${host}: HTTP ${res.status}.`, detail || '');
      // 404 / 5xx → try the next host.
    } catch { lastEnformionDiag = { status: 0, reason: 'network/CORS' }; }
  }

  // 2. Fallback: the serverless proxy (kept for environments where a direct
  //    call can't connect, e.g. if Enformion ever locks down CORS).
  // Prod first here: the proxy sends the server-to-server header set (no
  // galaxy-client-type), which is what api.enformion.com profiles expect.
  for (const host of ['prod', 'dev']) {
    try {
      const res = await fetchWithTimeout('/.netlify/functions/enformion', Math.min(timeoutMs, 20000), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-enformion-name': k.enformionApName,
          'x-enformion-password': k.enformionApPassword,
          'x-enformion-search-type': searchType,
          'x-enformion-path': path,
          'x-enformion-host': host,
        },
        body: payload,
      });
      if (!res.ok) { lastEnformionDiag = { status: 0, reason: `proxy error (HTTP ${res.status})` }; continue; }
      const env = await res.json(); // { ok, status, host, data, error }
      const d = env?.data;
      const detail = humanEnfError(d) || (typeof env?.error === 'string' ? env.error : undefined);
      lastEnformionDiag = { status: Number(env?.status) || 0, host: env?.host, reason: env?.error, shape: d != null ? describeShape(d) : undefined, detail };
      if (env?.ok) return d;
      const st = Number(env?.status) || 0;
      if (st === 400 || st === 402 || st === 403) {
        // Refusal via this route too — remember it and try the other host.
        refusal = lastEnformionDiag;
        console.warn(`Enformion ${path} via proxy(${host}): HTTP ${st} — trying the next route.`, detail || env?.error || '');
        continue;
      }
      console.warn(`Enformion ${path} via proxy(${host}): HTTP ${st}.`, detail || env?.error || '');
    } catch { lastEnformionDiag = { status: 0, reason: 'network' }; }
  }
  // Every route failed. Surface the REFUSAL (the most informative diagnosis)
  // rather than whatever transient error happened to come last.
  if (refusal) lastEnformionDiag = refusal;
  return null;
}

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s);

/** "123 Main St, Concord, NC 28027" → { line1: "123 Main St", line2: "Concord, NC 28027" }. */
function splitAddress(addr?: string | null): { addressLine1: string; addressLine2: string } {
  const s = String(addr || '').trim();
  if (!s) return { addressLine1: '', addressLine2: '' };
  const i = s.indexOf(',');
  if (i < 0) return { addressLine1: s, addressLine2: '' };
  return { addressLine1: s.slice(0, i).trim(), addressLine2: s.slice(i + 1).replace(/,?\s*USA$/i, '').trim() };
}

/** Detects an entity (LLC/INC/etc.) vs. a person. */
export function looksLikeBusiness(name: string): boolean {
  return /\b(llc|l\.l\.c|inc|incorporated|corp|corporation|company|co|ltd|lp|llp|holdings|properties|enterprises|group|associates|partners|ventures|investments|realty|builders|construction|homes|development|management|capital|fund|bank|church|ministries|hoa)\b/i.test(String(name || ''));
}

/** Parses "LAST, FIRST MIDDLE" or "FIRST MIDDLE LAST" into name parts. */
function parsePersonName(name: string): { firstName: string; middleName: string; lastName: string } | null {
  let n = String(name || '').trim().replace(/\s+/g, ' ');
  if (!n) return null;
  n = n.replace(/\b(jr|sr|ii|iii|iv|md|esq|trustee|trust|et al|etal|life estate|le)\b\.?/gi, '').replace(/\s+/g, ' ').trim();
  if (n.includes(',')) {
    const [last, rest] = n.split(',');
    const parts = rest.trim().split(' ').filter(Boolean);
    if (!last.trim() || !parts.length) return null;
    return { lastName: cap(last.trim()), firstName: cap(parts[0] || ''), middleName: parts.slice(1).map(cap).join(' ') };
  }
  const parts = n.split(' ').filter(Boolean);
  if (parts.length < 2) return null;
  return { firstName: cap(parts[0]), lastName: cap(parts[parts.length - 1]), middleName: parts.slice(1, -1).map(cap).join(' ') };
}

// Defensive normalizers — Enformion field names vary across endpoints, so accept
// the common shapes (objects/strings, several key spellings).
function normPhones(arr: any): SkipPhone[] {
  if (!Array.isArray(arr)) return [];
  return arr.map((p: any) => {
    if (!p) return null;
    if (typeof p === 'string') return { number: p };
    const number = p.phoneNumber || p.number || p.phone || '';
    const type = p.phoneType || p.type || p.lineType || undefined;
    return number ? { number: String(number), type: type ? String(type) : undefined } : null;
  }).filter(Boolean).slice(0, 8) as SkipPhone[];
}
function normEmails(arr: any): string[] {
  if (!Array.isArray(arr)) return [];
  return arr.map((e: any) => (typeof e === 'string' ? e : (e?.emailAddress || e?.email || ''))).filter(Boolean).map(String).slice(0, 8);
}
function normAddresses(arr: any): string[] {
  if (!Array.isArray(arr)) return [];
  return arr.map((a: any) => {
    if (!a) return '';
    if (typeof a === 'string') return a;
    if (a.fullAddress) return String(a.fullAddress);
    const l1 = a.addressLine1 || a.street || '';
    const l2 = a.addressLine2 || [a.city, a.state, a.zip || a.zipCode].filter(Boolean).join(' ');
    return [l1, l2].filter(Boolean).join(', ');
  }).filter(Boolean).slice(0, 6);
}
function normNames(arr: any): string[] {
  if (!Array.isArray(arr)) return [];
  return arr.map((r: any) => {
    if (!r) return '';
    if (typeof r === 'string') return r;
    const nm = r.name || r.fullName;
    if (nm && typeof nm === 'object') return [nm.firstName, nm.middleName, nm.lastName].filter(Boolean).join(' ');
    if (typeof nm === 'string') return nm;
    return [r.firstName, r.middleName, r.lastName].filter(Boolean).join(' ');
  }).filter(Boolean).slice(0, 12);
}
// Last-resort recursive scan — finds phones/emails ANYWHERE in the object so the
// integration works even if Enformion nests them under unexpected keys. Scoped to
// a single person/business object (the caller resolves that first).
function deepCollectContacts(root: any): { phones: SkipPhone[]; emails: string[] } {
  const phones: SkipPhone[] = [];
  const emails: string[] = [];
  const seenP = new Set<string>(), seenE = new Set<string>();
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const phoneRe = /^\+?1?[\s.\-]?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}$/;
  let nodes = 0;
  const addPhone = (n: string, type?: string) => { const v = n.trim(); if (v && !seenP.has(v)) { seenP.add(v); phones.push({ number: v, type: type || undefined }); } };
  const walk = (v: any, key: string) => {
    if (v == null || nodes++ > 5000) return;
    if (typeof v === 'string') {
      const s = v.trim();
      if (emailRe.test(s)) { const k = s.toLowerCase(); if (!seenE.has(k)) { seenE.add(k); emails.push(s); } }
      else if (/phone|cell|mobile|tel/i.test(key) && phoneRe.test(s)) addPhone(s);
      return;
    }
    if (Array.isArray(v)) { for (const x of v) walk(x, key); return; }
    if (typeof v === 'object') {
      const pn = v.phoneNumber ?? v.number ?? v.phone;
      if (pn != null && /\d{7,}/.test(String(pn))) addPhone(String(pn), v.phoneType || v.type || v.lineType);
      const em = v.emailAddress ?? v.email;
      if (typeof em === 'string' && emailRe.test(em.trim())) { const k = em.trim().toLowerCase(); if (!seenE.has(k)) { seenE.add(k); emails.push(em.trim()); } }
      for (const k of Object.keys(v)) walk(v[k], k);
    }
  };
  walk(root, '');
  return { phones: phones.slice(0, 8), emails: emails.slice(0, 8) };
}

/** Describes an object's SHAPE (nested key names + value types only — never the
 *  values) for safe debugging of the Enformion response without exposing PII. */
function describeShape(obj: any, depth = 0): any {
  if (depth > 4 || obj == null) return typeof obj;
  if (Array.isArray(obj)) return obj.length ? [describeShape(obj[0], depth + 1)] : [];
  if (typeof obj === 'object') {
    const o: Record<string, any> = {};
    for (const k of Object.keys(obj).slice(0, 40)) o[k] = describeShape(obj[k], depth + 1);
    return o;
  }
  return typeof obj;
}

function personToContact(person: any, isBusiness: boolean): SkipTraceContact | null {
  if (!person) return null;
  let phones = normPhones(person.phones || person.phoneNumbers || person.Phones);
  let emails = normEmails(person.emails || person.emailAddresses || person.Emails);
  const addresses = normAddresses(person.addresses || person.Addresses);
  // Bulletproof fallback: if the structured paths missed, scan the object.
  if (!phones.length && !emails.length) {
    const deep = deepCollectContacts(person);
    phones = deep.phones; emails = deep.emails;
  }
  if (!phones.length && !emails.length && !addresses.length) return null;
  const nm = person.name || person.fullName;
  const fullName = typeof nm === 'string' ? nm : (nm ? [nm.firstName, nm.middleName, nm.lastName].filter(Boolean).join(' ') : null);
  return {
    fullName,
    age: typeof person.age === 'number' ? person.age : (person.age ? Number(person.age) || null : null),
    phones, emails, addresses,
    relatives: normNames(person.relativesSummary || person.relatives || person.Relatives),
    associates: normNames(person.associatesSummary || person.associates || person.Associates),
    isBusiness,
    source: 'enformion',
  };
}

/** Enformion Contact Enrichment — top phones/emails/addresses for ONE person. */
export async function enformionContactEnrich(name: string, address?: string): Promise<SkipTraceContact | null> {
  const parsed = parsePersonName(name);
  if (!parsed || !parsed.firstName || !parsed.lastName) return null;
  const { addressLine1, addressLine2 } = splitAddress(address);
  const body: any = { FirstName: parsed.firstName, LastName: parsed.lastName };
  if (parsed.middleName) body.MiddleName = parsed.middleName;
  if (addressLine1) body.Address = { addressLine1, addressLine2 };
  const data = await enformionCall('/Contact/Enrich', 'DevAPIContactEnrich', body);
  if (!data) return null;
  const person = data.person || data.Person || (Array.isArray(data.persons) ? data.persons[0] : null) || data;
  const c = personToContact(person, false);
  if (!c) console.warn('Enformion Contact/Enrich: no contacts parsed. Response shape:', JSON.stringify(describeShape(data)));
  return c;
}

/** Enformion Person Search — richer record (relatives, associates, all phones). */
export async function enformionPersonSearch(name: string, address?: string): Promise<SkipTraceContact | null> {
  const parsed = parsePersonName(name);
  if (!parsed || !parsed.firstName || !parsed.lastName) return null;
  const { addressLine1, addressLine2 } = splitAddress(address);
  const body: any = { FirstName: parsed.firstName, LastName: parsed.lastName, Page: 1, ResultsPerPage: 1 };
  if (parsed.middleName) body.MiddleName = parsed.middleName;
  if (addressLine1 || addressLine2) body.Addresses = [{ addressLine1, addressLine2 }];
  const data = await enformionCall('/PersonSearch', 'Person', body);
  if (!data) return null;
  const person = (Array.isArray(data.persons) && data.persons[0]) || (Array.isArray(data.Persons) && data.Persons[0]) || data.person || null;
  const c = personToContact(person, false);
  if (!c) console.warn('Enformion PersonSearch: no contacts parsed. Response shape:', JSON.stringify(describeShape(data)));
  return c;
}

const normBiz = (s: string) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Picks the businessV2 record whose corp/business name best matches the query
 *  (exact → contains → first), and pulls its officers (members / registered
 *  agent) with name + address. */
function parseBusinessV2(data: any, queryName: string): { record: any; officers: { first: string; last: string; raw: string; title: string; address?: string }[] } | null {
  const records = data?.businessV2Records;
  if (!Array.isArray(records) || !records.length) return null;
  const q = normBiz(queryName);
  const nameOf = (r: any) => [...(r.usCorpFilings || []), ...(r.newBusinessFilings || [])].map((f: any) => f.name || f.company || '').find(Boolean) || '';
  let record = records.find((r: any) => normBiz(nameOf(r)) === q)
    || records.find((r: any) => q && (normBiz(nameOf(r)).includes(q) || q.includes(normBiz(nameOf(r)))))
    || records[0];
  const officers: { first: string; last: string; raw: string; title: string; address?: string }[] = [];
  const seen = new Set<string>();
  for (const f of [...(record.usCorpFilings || []), ...(record.newBusinessFilings || [])]) {
    for (const o of [...(f.officers || []), ...(f.contacts || [])]) {
      const nm = o.name || {};
      const first = String(nm.nameFirst || nm.firstName || '').trim();
      const last = String(nm.nameLast || nm.lastName || '').trim();
      const raw = String(nm.nameRaw || nm.fullName || [first, last].filter(Boolean).join(' ')).trim();
      if (!raw) continue;
      const key = raw.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const a = o.address;
      const address = a ? (a.fullAddress || [a.addressLine1, a.addressLine2].filter(Boolean).join(', ')) : undefined;
      officers.push({ first, last, raw, title: String(o.title || o.officerTitleDesc || '').trim(), address });
    }
  }
  return { record, officers };
}

/** Enformion Business Search (BusinessV2) — finds the entity, its officers
 *  (members / registered agent), and enriches the top officers for phones/emails.
 *  `maxOfficers` bounds the per-officer Contact Enrich calls (lower it for bulk). */
export async function enformionBusinessSearch(name: string, address?: string, maxOfficers = 4): Promise<SkipTraceContact | null> {
  // BusinessName: the entity name (drop any "& second owner" the GIS appends).
  const bizName = String(name || '').split('&')[0].trim();
  if (!bizName) return null;
  // BusinessV2 contract: BusinessName + top-level AddressLine2. Over-constraining
  // the address returns 0, so try the PROPERTY state (NC — this is an NC tool),
  // then NAME-ONLY (broadest), then the owner's mailing state. First hit wins.
  const usStates = /\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b/g;
  const states = (String(address || '').toUpperCase().match(usStates) || []);
  const ownerState = states.length ? states[states.length - 1] : '';
  const recs = (d: any) => (Array.isArray(d?.businessV2Records) ? d.businessV2Records : []);
  const callBiz = async (line2?: string) => {
    const body: any = { BusinessName: bizName, Page: 1, ResultsPerPage: 10 };
    if (line2) body.AddressLine2 = line2;
    return await enformionCall('/BusinessV2Search', 'BusinessV2', body);
  };
  let data = await callBiz('NC');
  if (!recs(data).length) data = await callBiz(undefined);
  if (!recs(data).length && ownerState && ownerState !== 'NC') data = await callBiz(ownerState);
  if (!data || !recs(data).length) { console.warn('Enformion BusinessV2: 0 records for', bizName); return null; }
  const parsed = parseBusinessV2(data, bizName);
  if (!parsed) { console.warn('Enformion BusinessV2: no parseable record. Shape:', JSON.stringify(describeShape(data))); return null; }

  // Business-level phones/emails from the matched record.
  const deep = deepCollectContacts(parsed.record);
  const phones = deep.phones;
  const emails = deep.emails;

  // Enformion's officer first/last are unreliable (often surname-first, e.g.
  // "CATCHPOLE TASHA"). Detect the shared family SURNAME — the token appearing
  // across multiple officers — to recover the correct first/last + display order.
  const stop = /^(jr|sr|ii|iii|iv|the|llc|inc|co|company|trust|and)$/i;
  const tokCount: Record<string, number> = {};
  for (const o of parsed.officers) for (const t of o.raw.split(/\s+/)) { const k = t.toLowerCase().replace(/[^a-z]/g, ''); if (k.length > 1 && !stop.test(k)) tokCount[k] = (tokCount[k] || 0) + 1; }
  const top = Object.entries(tokCount).sort((a, b) => b[1] - a[1])[0];
  const surname = top && top[1] >= 2 ? top[0] : '';
  const cap = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (m) => m.toUpperCase());
  const nameParts = (o: { first: string; last: string; raw: string }): { first: string; last: string } => {
    const toks = o.raw.split(/\s+/).filter((t) => t.replace(/[^a-z]/gi, '').length > 1 && !stop.test(t));
    if (surname && toks.length >= 2) {
      const li = toks.findIndex((t) => t.toLowerCase().replace(/[^a-z]/g, '') === surname);
      if (li >= 0) return { first: toks.filter((_, idx) => idx !== li).join(' '), last: toks[li] };
    }
    if (o.first && o.last) return { first: o.first, last: o.last };
    return { first: toks[0] || '', last: toks[toks.length - 1] || '' };
  };

  // Dedupe officers by the recovered first|last, then rank (registered agent first).
  const rank = (o: { title: string }) => (/REGISTERED AGENT/i.test(o.title) ? 3 : 0) + (/MEMBER|MANAGER|OWNER|PRESIDENT/i.test(o.title) ? 1 : 0);
  const uniq = new Map<string, { first: string; last: string; o: typeof parsed.officers[number] }>();
  for (const o of parsed.officers) {
    const { first, last } = nameParts(o);
    if (!first || !last) continue;
    const k = `${first} ${last}`.toLowerCase();
    if (!uniq.has(k)) uniq.set(k, { first, last, o });
  }
  const ranked = [...uniq.values()].sort((a, b) => rank(b.o) - rank(a.o));

  // Enrich each officer (top few). Try Person Search (broad) with the recovered
  // order + address, then name-only, then the reversed order name-only.
  const officers: OfficerContact[] = [];
  for (const { first, last, o } of ranked.slice(0, maxOfficers)) {
    const attempts: [string, string, string | undefined][] = [
      [first, last, o.address], [first, last, undefined], [last, first, undefined],
    ];
    let hit: SkipTraceContact | null = null;
    for (const [f, l, addr] of attempts) {
      hit = await enformionPersonSearch(`${f} ${l}`, addr).catch(() => null);
      if (hit && (hit.phones.length || hit.emails.length)) break;
      hit = null;
    }
    officers.push({
      name: hit?.fullName || cap(`${first} ${last}`),
      title: o.title || undefined,
      phones: hit ? hit.phones.map((p) => p.number) : [],
      emails: hit ? hit.emails : [],
    });
  }
  for (const { first, last, o } of ranked.slice(maxOfficers)) officers.push({ name: cap(`${first} ${last}`), title: o.title || undefined, phones: [], emails: [] });

  if (!phones.length && !emails.length && !officers.length) return null;
  return {
    fullName: name,
    age: null,
    phones,
    emails,
    addresses: [],
    officers,
    isBusiness: true,
    source: 'enformion',
  };
}

/** One-call skip trace from GIS owner data: picks Person vs. Business by the
 *  owner name. For people it prefers Person Search (richer), falling back to
 *  Contact Enrich. Returns null when Enformion isn't configured or finds nothing. */
export async function skipTraceContact(ownerName: string, address?: string): Promise<SkipTraceContact | null> {
  if (!enformionConfigured() || !ownerName.trim()) return null;
  if (looksLikeBusiness(ownerName)) {
    return await enformionBusinessSearch(ownerName, address).catch(() => null);
  }
  const viaSearch = await enformionPersonSearch(ownerName, address).catch(() => null);
  if (viaSearch && (viaSearch.phones.length || viaSearch.emails.length)) return viaSearch;
  return await enformionContactEnrich(ownerName, address).catch(() => null) || viaSearch;
}

// ===========================================================================
// Enformion Property Search V2 — deed, current owners, sale TRANSACTIONS, and
// recorded MORTGAGES for one address. Verified against the official
// EnformionGO API reference (enformiongo.readme.io):
//   POST /PropertyV2Search  galaxy-search-type: PropertyV2
// ===========================================================================

/** Case-insensitive property read — Enformion mixes PascalCase and camelCase
 *  across endpoints/hosts, so accept either. */
function ci(o: any, key: string): any {
  if (o == null || typeof o !== 'object') return undefined;
  if (key in o) return o[key];
  const lower = key.toLowerCase();
  for (const k of Object.keys(o)) if (k.toLowerCase() === lower) return o[k];
  return undefined;
}
const ciStr = (o: any, key: string): string => { const v = ci(o, key); return v == null ? '' : String(v).trim(); };
const ciNum = (o: any, key: string): number => { const n = Number(String(ci(o, key) ?? '').replace(/[^0-9.-]/g, '')); return Number.isFinite(n) ? n : 0; };
const ciArr = (o: any, key: string): any[] => { const v = ci(o, key); return Array.isArray(v) ? v : []; };

/** "04/17/2000", "4/17/2000", "20050928", or "2019" → display date (best-effort). */
function fmtEnfDate(raw: any): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (/^\d{8}$/.test(s)) return `${s.slice(4, 6)}/${s.slice(6, 8)}/${s.slice(0, 4)}`; // yyyymmdd
  return s;
}

export interface EnfPropertyTransaction {
  date: string; recordingDate: string; amount: number;
  buyers: string[]; sellers: string[]; docNumber: string; type: string;
}
export interface EnfMortgage {
  amount: number; date: string; lender: string; loanType: string; rateType: string; docNumber: string;
}
export interface EnformionPropertyRecord {
  apn: string;
  /** Unformatted APN exactly as keyed in the county assessor file. */
  apnUnformatted: string;
  fips: string;
  county: string;
  currentOwners: string[];
  purchasePrice: number; purchaseDate: string;
  assessedValue: number; assessedYear: string;
  taxAmount: number; taxYear: string;
  landUse: string; legalDescription: string;
  // --- Deep assessor characteristics (Property Search V2) ---
  /** County land-use CODE (raw flag, e.g. "100", "VAC") — filterable. */
  landUseCode: string;
  /** Property-type classification flag from the assessor file. */
  propertyType: string;
  /** Assessor zoning flag for the parcel. */
  zoning: string;
  /** Exact acreage from the county assessor file. */
  lotAcres: number;
  /** Land square footage. */
  lotSqft: number;
  /** TOTAL structural square footage — 0 means no building on record (raw land). */
  buildingSqft: number;
  yearBuilt: number;
  beds: number;
  baths: number;
  bathsPartial: number;
  stories: string;
  /** Construction materials / build style from the assessor file. */
  construction: string;
  exteriorWalls: string;
  /** true when the county record flags vacant/agricultural/timber/unimproved
   *  land use, or shows 0 structural sqft and no year built — i.e. raw land. */
  isVacantLand: boolean;
  transactions: EnfPropertyTransaction[];
  mortgages: EnfMortgage[];
  openLienCount: number;
  /** Whether Enformion's response even CONTAINED the RecorderRecords section
   *  (mortgages & sale transactions live there). false = the section was
   *  absent from the response — an account/include issue, not empty data. */
  recorderIncluded: boolean;
}
function enfName(n: any): string {
  const nm = ci(n, 'Name') ?? n;
  return ciStr(nm, 'FullName') || ciStr(nm, 'CompanyName') || ciStr(nm, 'BusinessName')
    || [ciStr(nm, 'FirstName'), ciStr(nm, 'MiddleName'), ciStr(nm, 'LastName')].filter(Boolean).join(' ');
}

/** Enformion Property Search V2 — deed/assessor/recorder record for ONE address:
 *  current owners, purchase price, assessed value & taxes, the recorded sale
 *  TRANSACTIONS with buyers/sellers, and every recorded MORTGAGE (amount,
 *  lender, loan type). Returns null when nothing matched (see diag for why). */
/** Google-NORMALIZED structured address for a coordinate — the same engine as
 *  the search box autocomplete. Returns clean USPS-style pieces
 *  ("333 S McPherson Church Rd" + "Fayetteville, NC 28303") that Enformion's
 *  address parser accepts (raw all-caps GIS situs strings can trip it with
 *  "Range Error"). Never throws; null when unavailable. */
async function structuredAddressFromPoint(lat: number, lng: number): Promise<{ line1: string; line2: string } | null> {
  const key = getUserKeys().googleMaps;
  if (!key) return null;
  try {
    const res = await fetchWithTimeout(`https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${key}`, 8000);
    if (!res.ok) return null;
    const j = await res.json();
    // Prefer precise results (street_address/premise) over area matches.
    const ranked = [...(j.results || [])].sort((x: any, y: any) => {
      const score = (r: any) => ((r.types || []).includes('street_address') || (r.types || []).includes('premise')) ? 0 : 1;
      return score(x) - score(y);
    });
    for (const r of ranked) {
      const comps = r.address_components || [];
      const get = (type: string) => (comps.find((c: any) => (c.types || []).includes(type)) || {}).short_name || '';
      const streetNum = get('street_number');
      const route = get('route');
      const city = get('locality') || get('sublocality') || get('administrative_area_level_3') || get('postal_town');
      const state = get('administrative_area_level_1');
      const zip = get('postal_code');
      if (route && city && state) {
        return { line1: [streetNum, route].filter(Boolean).join(' '), line2: `${city}, ${state}${zip ? ` ${zip}` : ''}` };
      }
    }
  } catch { /* ignore */ }
  return null;
}

export async function enformionPropertySearch(address: string, fallbackAddress?: string, coords?: { lat: number; lng: number }): Promise<EnformionPropertyRecord | null> {
  // Build candidate AddressLine1 (street) + AddressLine2 ("City, ST ZIP")
  // forms and try them in order until one matches:
  //   1. GIS situs street (authoritative for THE parcel) + best city/state tail
  //   2. Google-normalized address from the parcel's own coordinates — the
  //      same autocomplete engine as the search box, so Enformion's address
  //      parser gets a clean standardized form (fixes "Range Error" on raw
  //      all-caps county situs strings)
  //   3. The user's typed search address as-is
  const a = splitAddress(address);
  const b = splitAddress(fallbackAddress);
  const google = (coords && Number.isFinite(coords.lat) && Number.isFinite(coords.lng))
    ? await structuredAddressFromPoint(coords.lat, coords.lng)
    : null;

  const attempts: { line1: string; line2: string }[] = [];
  const push = (l1?: string, l2?: string) => {
    const line1 = (l1 || '').trim(), line2 = (l2 || '').trim();
    if (line1 && line2 && !attempts.some((x) => x.line1.toLowerCase() === line1.toLowerCase() && x.line2.toLowerCase() === line2.toLowerCase())) {
      attempts.push({ line1, line2 });
    }
  };
  push(a.addressLine1, a.addressLine2 || b.addressLine2 || google?.line2);
  push(google?.line1, google?.line2);
  push(b.addressLine1, b.addressLine2 || google?.line2);
  if (!attempts.length) {
    lastEnformionDiag = {
      status: 0,
      reason: 'incomplete address',
      detail: `Could not determine the city/state for "${address}" (no comma tail and reverse geocoding returned nothing). Search with the full address (e.g. "123 Main St, Town, NC 28000") and it will run.`,
    };
    return null;
  }

  // ResultsPerPage 1: we only use the top match (smaller, faster payload).
  let rec: any = null;
  for (const at of attempts) {
    const data = await enformionCall('/PropertyV2Search', 'PropertyV2', {
      AddressLine1: at.line1, AddressLine2: at.line2, Page: 1, ResultsPerPage: 1,
    });
    if (data) {
      rec = ciArr(data, 'PropertyV2Records')[0];
      if (rec) break; // matched — stop trying alternate address forms
    }
    // No match / parser rejection — try the next (differently formatted) form.
  }
  if (!rec) {
    // Surface exactly which address forms were searched, so a true no-match is
    // distinguishable from a formatting problem.
    const prev = lastEnformionDiag;
    const triedNote = `Searched as: ${attempts.map((x) => `"${x.line1} · ${x.line2}"`).join(' and ')}.`;
    lastEnformionDiag = { ...prev, detail: [prev.detail, triedNote].filter(Boolean).join(' ') };
    return null;
  }

  const summary = ci(ci(rec, 'Property'), 'Summary') || {};
  const assessor = ciArr(rec, 'AssessorRecords')[0] || {};
  const recorder = ciArr(rec, 'RecorderRecords');

  const purchase = ci(summary, 'PurchasePrice') || {};
  const assessed = ci(summary, 'AssessedValue') || {};
  const tax = ci(assessor, 'Tax') || {};
  const propId = ci(assessor, 'PropertyIdentification') || {};
  const legal = ci(assessor, 'PropertyLegal') || {};
  // Deep assessor sections — Enformion nests structural/geographic data under
  // several section names that vary by county feed; probe them all.
  const size = ci(assessor, 'PropertySize') || {};
  const useInfo = ci(assessor, 'PropertyUseInfo') || {};
  const rooms = ci(assessor, 'IntRoomInfo') || {};
  const structIn = ci(assessor, 'IntStructInfo') || {};
  const structEx = ci(assessor, 'ExtStructInfo') || {};
  const chars = ci(assessor, 'PropertyCharacteristics') || {};
  // First non-empty string / non-zero number across candidate keys × sections.
  const firstStr = (keys: string[], ...objs: any[]): string => {
    for (const k of keys) for (const o of objs) { const v = ciStr(o, k); if (v) return v; }
    return '';
  };
  const firstNum = (keys: string[], ...objs: any[]): number => {
    for (const k of keys) for (const o of objs) { const n = ciNum(o, k); if (n) return n; }
    return 0;
  };

  const transactions: EnfPropertyTransaction[] = [];
  const mortgages: EnfMortgage[] = [];
  for (const rr of recorder) {
    const ts = ci(rr, 'TransactionSummary') || {};
    const det = ci(ts, 'TransactioDetails') || ci(ts, 'TransactionDetails') || {};
    const buyers = ciArr(ts, 'Buyers').map(enfName).filter(Boolean);
    const sellers = ciArr(ts, 'Sellers').map(enfName).filter(Boolean);
    const saleAmount = ciNum(det, 'SaleAmount');
    const saleDate = fmtEnfDate(ciStr(det, 'SaleDate'));
    if (buyers.length || sellers.length || saleAmount || saleDate) {
      transactions.push({
        date: saleDate, recordingDate: fmtEnfDate(ciStr(det, 'SaleRecordningDate') || ciStr(det, 'SaleRecordingDate')),
        amount: saleAmount, buyers, sellers,
        docNumber: ciStr(det, 'RecordedSaleDocumentNumber'),
        type: ciStr(det, 'DeedCategoryTypeDescription') || ciStr(det, 'TransactionTypeDescription') || ciStr(det, 'SaleDocumentTypeDescription'),
      });
    }
    const md = ci(rr, 'MortgageDetails');
    if (md && (ciNum(md, 'MortgageAmount') || ciStr(md, 'MortgageDate'))) {
      mortgages.push({
        amount: ciNum(md, 'MortgageAmount'),
        date: fmtEnfDate(ciStr(md, 'MortgageDate') || ciStr(md, 'MortgageRecordingDate')),
        lender: ciArr(md, 'Lenders').map(enfName).filter(Boolean).join(', '),
        loanType: ciStr(md, 'MortgageLoanTypeCode'),
        rateType: ciStr(md, 'MortgageInterestRateType'),
        docNumber: ciStr(md, 'MortgageRecordedDocumentNumber'),
      });
    }
  }
  // The assessor's purchase transaction is often the authoritative last sale —
  // include it when the recorder set didn't already capture it.
  const pt = ci(assessor, 'PurchaseTransaction') || {};
  const ptDate = fmtEnfDate(ciStr(pt, 'SaleDate'));
  const ptAmount = ciNum(pt, 'SaleAmount');
  if ((ptDate || ptAmount) && !transactions.some((t) => t.date === ptDate && t.amount === ptAmount)) {
    transactions.push({
      date: ptDate, recordingDate: fmtEnfDate(ciStr(pt, 'SaleRecordingDate')), amount: ptAmount,
      buyers: [], sellers: ciArr(pt, 'SellerNames').map(enfName).filter(Boolean),
      docNumber: ciStr(pt, 'SaleRecordedDocumentNumber'), type: ciStr(pt, 'SaleDocumentTypeDescription') || 'Recorded sale',
    });
  }

  // Deep property characteristics: land-use flags, exact parcel size, and the
  // structural specs (0 building sqft + vacant-type use code = raw land).
  const landUse = firstStr(['CountyUseDescr', 'LandUseCodeDescription', 'PropertyUseStandardized', 'PropertyUseGroup', 'PropertyUseMuni', 'LandUseDescription', 'CountyLandUseDescription', 'StateLandUseDescription'], propId, useInfo, summary);
  const landUseCode = firstStr(['CountyLandUseCode', 'CountyUseCode', 'LandUseCode', 'StateLandUseCode', 'MuniLandUseCode', 'PropertyUseStandardizedCode'], propId, useInfo, summary);
  const propertyType = firstStr(['PropertyType', 'PropertyClass', 'PropertyTypeDetail', 'PropertyClassDescription'], summary, propId, useInfo);
  const buildingSqft = firstNum(['AreaBuilding', 'BuildingAreaSqFt', 'LivingAreaSqFt', 'UniversalBuildingAreaSqFt', 'AreaGross', 'GrossAreaSqFt', 'TotalBuildingAreaSqFt'], size, chars, summary);
  const yearBuilt = firstNum(['YearBuilt', 'EffectiveYearBuilt'], structIn, structEx, chars, summary, assessor);
  const vacantByUse = /vacant|unimproved|raw land|timber|agricultur|farm ?land|undeveloped|no structure/i.test(`${landUse} ${propertyType}`);
  const result: EnformionPropertyRecord = {
    apn: ciStr(summary, 'Apn') || ciStr(propId, 'ApnUnformatted'),
    apnUnformatted: ciStr(propId, 'ApnUnformatted') || ciStr(propId, 'Apn'),
    fips: firstStr(['Fips', 'FipsCode', 'SitusStateCountyFips', 'StateCountyFips'], propId, summary),
    county: firstStr(['County', 'CountyName', 'SitusCounty'], propId, summary, assessor),
    currentOwners: ciArr(summary, 'CurrentOwners').map(enfName).filter(Boolean),
    purchasePrice: ciNum(purchase, 'Price'),
    purchaseDate: fmtEnfDate(ciStr(purchase, 'Date')),
    assessedValue: ciNum(assessed, 'Price') || ciNum(tax, 'AssessedTotalValue'),
    assessedYear: ciStr(assessed, 'Date') || ciStr(tax, 'AssessedYear'),
    taxAmount: ciNum(tax, 'TaxAmount'),
    taxYear: ciStr(tax, 'TaxYear'),
    landUse,
    legalDescription: ciStr(legal, 'LegalDescription'),
    landUseCode,
    propertyType,
    zoning: firstStr(['Zoning', 'ZoningCode', 'AssessorZoning', 'ZoningDescription'], propId, legal, useInfo, summary, assessor),
    lotAcres: firstNum(['AreaLotAcres', 'LotSizeAcres', 'Acres', 'AreaAcres'], size, summary, propId, legal),
    lotSqft: firstNum(['AreaLotSF', 'AreaLotSf', 'LotSizeSqFt', 'LandSquareFootage', 'LotSquareFeet'], size, summary, propId),
    buildingSqft,
    yearBuilt,
    beds: firstNum(['BedroomsCount', 'Bedrooms', 'BedCount'], rooms, chars, summary, structIn),
    baths: firstNum(['BathCount', 'BathsTotal', 'BathTotalCalc', 'BathsFull', 'BathFullCount'], rooms, chars, summary, structIn),
    bathsPartial: firstNum(['BathPartialCount', 'BathsPartial', 'HalfBaths'], rooms, chars, structIn),
    stories: firstStr(['StoriesCount', 'Stories', 'StoriesDescription'], structIn, structEx, chars, summary),
    construction: firstStr(['Construction', 'ConstructionType', 'ConstructionDescription', 'StyleDescription', 'BuildingStyle'], structEx, structIn, chars, summary),
    exteriorWalls: firstStr(['ExteriorWalls', 'ExteriorWallsDescription', 'Exterior1Code'], structEx, structIn, chars),
    isVacantLand: vacantByUse || (buildingSqft === 0 && yearBuilt === 0),
    transactions: transactions.slice(0, 8),
    mortgages: mortgages.slice(0, 6),
    openLienCount: ciArr(rec, 'OpenLienRecords').length,
    recorderIncluded: ci(rec, 'RecorderRecords') != null,
  };
  // PII-safe shape log so "no mortgages/transactions" is verifiable against
  // what Enformion actually sent (open DevTools console after a search).
  if (!result.transactions.length && !result.mortgages.length) {
    console.log('[Enformion PropertyV2] deed matched but 0 mortgages/transactions parsed. Response sections:', {
      recorderIncluded: result.recorderIncluded,
      recorderCount: recorder.length,
      assessorIncluded: ci(rec, 'AssessorRecords') != null,
      topLevelKeys: Object.keys(rec || {}),
    });
  }
  return result;
}

/** Bulk skip trace for the finder's owner list — phones/emails for each owner
 *  (person via Contact Enrich, business via Business Search), concurrency-limited
 *  with progress. Keyed by the caller's row id. Skips rows with no usable name. */
export async function enformionSkipTraceOwners(
  owners: { id: string; firstName?: string; lastName?: string; ownerName?: string; address?: string }[],
  onProgress?: (done: number, total: number) => void,
): Promise<Record<string, { phones: string[]; emails: string[] }>> {
  const out: Record<string, { phones: string[]; emails: string[] }> = {};
  if (!enformionConfigured()) return out;
  const list = owners.filter((o) => (o.firstName && o.lastName) || o.ownerName);
  const total = list.length;
  let done = 0, i = 0;
  const worker = async () => {
    while (i < list.length) {
      const o = list[i++];
      let c: SkipTraceContact | null = null;
      try {
        const personName = o.firstName && o.lastName ? `${o.firstName} ${o.lastName}` : (o.ownerName || '');
        if (personName && (o.firstName || !looksLikeBusiness(personName))) {
          c = await enformionContactEnrich(personName, o.address);
        } else if (o.ownerName) {
          c = await enformionBusinessSearch(o.ownerName, o.address, 2); // bulk: enrich top 2 officers
        }
      } catch { /* skip this owner */ }
      if (c) {
        // Aggregate business officers' phones/emails into the owner row.
        const phones = [...c.phones.map((p) => p.number), ...((c.officers || []).flatMap((of) => of.phones))];
        const emails = [...c.emails, ...((c.officers || []).flatMap((of) => of.emails))];
        if (phones.length || emails.length) out[o.id] = { phones: [...new Set(phones)], emails: [...new Set(emails)] };
      }
      onProgress?.(++done, total);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, list.length) }, worker));
  return out;
}

/** Enrich several people (registered agent + officials) with phones/emails,
 *  concurrency-limited. Returns a map keyed by the input name. */
export async function enformionEnrichPeople(people: { name: string; address?: string }[]): Promise<Record<string, SkipTraceContact>> {
  const out: Record<string, SkipTraceContact> = {};
  if (!enformionConfigured()) return out;
  const list = people.filter((p) => p.name && !looksLikeBusiness(p.name)).slice(0, 6);
  let i = 0;
  const worker = async () => {
    while (i < list.length) {
      const p = list[i++];
      const c = await enformionContactEnrich(p.name, p.address).catch(() => null);
      if (c && (c.phones.length || c.emails.length)) out[p.name] = c;
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, list.length) }, worker));
  return out;
}

/**
 * FEMA National Flood Hazard Layer (NFHL) — authoritative flood-zone lookup by
 * coordinate. Returns the effective flood zone, whether the point is in a Special
 * Flood Hazard Area, and a citable FEMA source link. Degrades gracefully
 * (status 'unavailable') so the report flags verification instead of guessing.
 */
export async function fetchFemaFloodZone(lat: number, lng: number): Promise<FloodZoneInfo> {
  const sourceUrl = `https://msc.fema.gov/portal/search?AddressQuery=${encodeURIComponent(`${lat}, ${lng}`)}`;
  try {
    const url = `https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query?geometry=${lng},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=FLD_ZONE,ZONE_SUBTY,SFHA_TF&returnGeometry=false&f=json`;
    const res = await fetchWithTimeout(url, 12000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data?.error) throw new Error('NFHL query error');
    const feats: any[] = data?.features || [];
    if (feats.length === 0) return { zone: 'UNKNOWN', inSFHA: false, status: 'no-coverage', sourceUrl };
    // If the point straddles zones, prefer the Special Flood Hazard Area record.
    const chosen = feats.find((f) => String(f?.attributes?.SFHA_TF).toUpperCase() === 'T') || feats[0];
    const a = chosen.attributes || {};
    return {
      zone: a.FLD_ZONE || 'UNKNOWN',
      inSFHA: String(a.SFHA_TF).toUpperCase() === 'T',
      subtype: a.ZONE_SUBTY || undefined,
      status: 'mapped',
      sourceUrl,
    };
  } catch (e) {
    console.warn('FEMA NFHL flood lookup failed:', e);
    return { zone: 'UNKNOWN', inSFHA: false, status: 'unavailable', sourceUrl };
  }
}

/** NWI Wetlands MapServer/0 — the official FWS service is primary; the WIM-hosted
 *  mirror is the fallback. Same layer schema; both used for the map, report, and
 *  the land finder's wetland scoring. (See fws.gov NWI Web Mapping Services.) */
export const NWI_WETLANDS_SERVICE = 'https://www.fws.gov/wetlandsmapservice/rest/services/Wetlands/MapServer';
const NWI_WETLANDS_QUERY_HOSTS = [
  `${NWI_WETLANDS_SERVICE}/0/query`,
  'https://fwspublicservices.wim.usgs.gov/wetlandsmapservice/rest/services/Wetlands/MapServer/0/query',
];

/** Reads an attribute by base name across NWI schemas — the official service
 *  prefixes joined fields (e.g. "Wetlands.WETLAND_TYPE"), the mirror does not. */
function readNwiField(attrs: Record<string, any>, name: string): any {
  if (!attrs) return undefined;
  if (attrs[name] != null) return attrs[name];
  const k = Object.keys(attrs).find((key) => key === name || key.endsWith(`.${name}`));
  return k ? attrs[k] : undefined;
}

/**
 * USFWS National Wetlands Inventory (NWI) — wetlands presence/classification by
 * coordinate from the official FWS Wetlands web mapping service (WIM mirror as
 * fallback). Returns present=null with status 'unavailable' if NWI is down, so
 * the report verifies via the NWI Wetlands Mapper rather than assuming the site
 * is wetland-free.
 */
export async function fetchNwiWetlands(lat: number, lng: number): Promise<WetlandsInfo> {
  const sourceUrl = 'https://www.fws.gov/program/national-wetlands-inventory/wetlands-mapper';
  for (const base of NWI_WETLANDS_QUERY_HOSTS) {
    try {
      const url = `${base}?geometry=${lng},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=false&f=json`;
      const res = await fetchWithTimeout(url, 12000);
      if (!res.ok) continue;
      const data = await res.json();
      if (data?.error) continue;
      const feats: any[] = data?.features || [];
      // Human-readable type (e.g. "Freshwater Forested/Shrub Wetland"), with the
      // raw NWI code (e.g. "PFO4/1B") as a fallback label.
      const types = Array.from(new Set(
        feats.map((f) => readNwiField(f?.attributes, 'WETLAND_TYPE') || readNwiField(f?.attributes, 'ATTRIBUTE')).filter(Boolean)
      )) as string[];
      return {
        present: feats.length > 0,
        types,
        status: feats.length > 0 ? 'mapped' : 'none-at-point',
        sourceUrl,
      };
    } catch {
      // try the next host
    }
  }
  return { present: null, types: [], status: 'unavailable', sourceUrl };
}

/**
 * Computes an accurate slope/elevation profile for the parcel using USGS 3DEP
 * elevation (the National Map EPQS service, 1-meter resolution where available).
 * It samples an N×N grid of points across the parcel footprint, fetches each
 * point's true ground elevation, and derives slope by finite differences over
 * the grid (spacing computed in meters). Falls back to a simulated profile only
 * if the elevation service is unreachable.
 */
export async function fetchOpenTopographySlope(lat: number, lng: number, _parcelId: string, boundaryRings?: number[][][]): Promise<SlopeProfile> {
  // Parcel bounding box (or a small box around the point if no geometry).
  let minLat = lat - 0.0003, maxLat = lat + 0.0003, minLng = lng - 0.0003, maxLng = lng + 0.0003;
  if (boundaryRings && boundaryRings[0] && boundaryRings[0].length > 0) {
    const lats = boundaryRings[0].map(c => c[1]);
    const lngs = boundaryRings[0].map(c => c[0]);
    minLat = Math.min(...lats); maxLat = Math.max(...lats);
    minLng = Math.min(...lngs); maxLng = Math.max(...lngs);
  }

  // Sample a 5×5 grid across the parcel and query USGS 3DEP (EPQS) in parallel.
  const N = 5;
  const pts: { lat: number; lng: number; r: number; c: number }[] = [];
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      pts.push({
        lat: minLat + (maxLat - minLat) * (r / (N - 1)),
        lng: minLng + (maxLng - minLng) * (c / (N - 1)),
        r, c,
      });
    }
  }

  try {
    // ONE request for the whole 5×5 grid via the USGS 3DEP ImageServer getSamples
    // op (1-meter resolution). The per-point EPQS service is ~10 s/call and was
    // timing out — making this fall back to a SIMULATED profile. getSamples returns
    // every point in a single call; samples carry locationId = input point index.
    const geom = JSON.stringify({ points: pts.map((p) => [p.lng, p.lat]), spatialReference: { wkid: 4326 } });
    const url = `https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/getSamples` +
      `?geometry=${encodeURIComponent(geom)}&geometryType=esriGeometryMultipoint&returnFirstValueOnly=true&f=json`;
    const res = await fetchWithTimeout(url, 22000);
    if (!res.ok) throw new Error(`3DEP getSamples HTTP ${res.status}`);
    const data = await res.json();
    if (data?.error || !Array.isArray(data.samples)) throw new Error("3DEP getSamples returned no data");

    const grid: (number | null)[][] = Array.from({ length: N }, () => Array<number | null>(N).fill(null));
    for (const s of data.samples) {
      const i = Number(s?.locationId);
      if (!Number.isInteger(i) || i < 0 || i >= pts.length) continue;
      const v = parseFloat(s?.value);
      const p = pts[i];
      grid[p.r][p.c] = Number.isFinite(v) && v > -1000 ? v : null;
    }
    const valid = grid.flat().filter((e): e is number => e != null);
    if (valid.length < N * N * 0.6) throw new Error("Insufficient USGS 3DEP coverage at this location");

    // Grid spacing in meters.
    const midLat = (minLat + maxLat) / 2;
    const cellH = ((maxLat - minLat) / (N - 1)) * 111320;
    const cellW = ((maxLng - minLng) / (N - 1)) * 111320 * Math.cos((midLat * Math.PI) / 180);

    const slopes: number[] = [];
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const z = grid[r][c];
        if (z == null) continue;
        const zl = c > 0 ? grid[r][c - 1] : null;
        const zr = c < N - 1 ? grid[r][c + 1] : null;
        const zu = r > 0 ? grid[r - 1][c] : null;
        const zd = r < N - 1 ? grid[r + 1][c] : null;
        let dzdx = 0;
        if (zl != null && zr != null && cellW > 0) dzdx = (zr - zl) / (2 * cellW);
        else if (zr != null && cellW > 0) dzdx = (zr - z) / cellW;
        else if (zl != null && cellW > 0) dzdx = (z - zl) / cellW;
        let dzdy = 0;
        if (zu != null && zd != null && cellH > 0) dzdy = (zu - zd) / (2 * cellH);
        else if (zd != null && cellH > 0) dzdy = (z - zd) / cellH;
        else if (zu != null && cellH > 0) dzdy = (zu - z) / cellH;
        const slopePct = Math.sqrt(dzdx * dzdx + dzdy * dzdy) * 100;
        if (Number.isFinite(slopePct)) slopes.push(slopePct);
      }
    }
    if (slopes.length === 0) throw new Error("Could not compute slope from elevation grid");

    const minElevation = Math.min(...valid);
    const maxElevation = Math.max(...valid);
    const avgElevation = valid.reduce((a, b) => a + b, 0) / valid.length;
    const maxSlope = Math.max(...slopes);
    const avgSlope = slopes.reduce((a, b) => a + b, 0) / slopes.length;
    let verdict: 'BUILDABLE' | 'REQUIRES ENGINEERING' | 'NON-BUILDABLE' = 'BUILDABLE';
    if (maxSlope > 25) verdict = 'NON-BUILDABLE';
    else if (maxSlope >= 15) verdict = 'REQUIRES ENGINEERING';

    return {
      avgSlope: Math.round(avgSlope * 10) / 10,
      maxSlope: Math.round(maxSlope * 10) / 10,
      avgElevation: Math.round(avgElevation * 10) / 10,
      minElevation: Math.round(minElevation * 10) / 10,
      maxElevation: Math.round(maxElevation * 10) / 10,
      verdict,
    };
  } catch (err) {
    console.warn("USGS 3DEP (EPQS) slope query failed; using simulation fallback:", err);
    return generateMockSlope(lat, lng);
  }
}

function generateMockSlope(lat: number, lng: number): SlopeProfile {
  const hash = Math.abs(Math.round((lat + lng) * 100000)) % 100;
  let avgSlope = 3.5 + (hash % 15); // ranges 3.5% to 18.5%
  let maxSlope = avgSlope * (1.5 + (hash % 10) / 10); // max slope
  
  let verdict: 'BUILDABLE' | 'REQUIRES ENGINEERING' | 'NON-BUILDABLE' = 'BUILDABLE';
  if (maxSlope > 25) {
    verdict = 'NON-BUILDABLE';
  } else if (maxSlope >= 15) {
    verdict = 'REQUIRES ENGINEERING';
  }
  
  const avgElevation = 210 + (hash % 40);
  return {
    avgSlope: Math.round(avgSlope * 10) / 10,
    maxSlope: Math.round(maxSlope * 10) / 10,
    avgElevation: Math.round(avgElevation * 10) / 10,
    minElevation: Math.round((avgElevation - 5) * 10) / 10,
    maxElevation: Math.round((avgElevation + 8) * 10) / 10,
    verdict
  };
}

export interface Slope3DEP {
  avgSlope: number;       // percent
  maxSlope: number;       // percent
  avgElevation: number;   // meters
  verdict: 'BUILDABLE' | 'REQUIRES ENGINEERING' | 'NON-BUILDABLE';
  status: 'mapped' | 'unavailable';
  sourceUrl: string;
}

/**
 * Lightweight AUTHORITATIVE slope/topography at a point from USGS 3DEP (the
 * National Map EPQS elevation service), for the land finder. Samples a small
 * N×N grid (default 3×3 = 9 elevation probes) around the point and derives
 * avg/max slope by finite differences. Unlike fetchOpenTopographySlope it does
 * NOT fall back to a simulated value — it returns status 'unavailable' when 3DEP
 * can't be reached, so the finder marks slope unverified instead of guessing.
 */
export async function fetchSlope3DEP(lat: number, lng: number, halfDeg = 0.0004, N = 3): Promise<Slope3DEP> {
  const sourceUrl = 'https://www.usgs.gov/3d-elevation-program';
  const unavailable: Slope3DEP = { avgSlope: 0, maxSlope: 0, avgElevation: 0, verdict: 'BUILDABLE', status: 'unavailable', sourceUrl };
  const minLat = lat - halfDeg, maxLat = lat + halfDeg, minLng = lng - halfDeg, maxLng = lng + halfDeg;
  const pts: { lat: number; lng: number; r: number; c: number }[] = [];
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    pts.push({ lat: minLat + (maxLat - minLat) * (r / (N - 1)), lng: minLng + (maxLng - minLng) * (c / (N - 1)), r, c });
  }
  try {
    // ONE request for the whole grid via the USGS 3DEP ImageServer getSamples op
    // (the per-point EPQS service is ~10 s/call; this samples every point at once
    // at 1-meter resolution). Samples carry locationId = input point index.
    const geom = JSON.stringify({ points: pts.map((p) => [p.lng, p.lat]), spatialReference: { wkid: 4326 } });
    const url = `https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/getSamples` +
      `?geometry=${encodeURIComponent(geom)}&geometryType=esriGeometryMultipoint&returnFirstValueOnly=true&f=json`;
    const res = await fetchWithTimeout(url, 20000);
    if (!res.ok) return unavailable;
    const data = await res.json();
    if (data?.error || !Array.isArray(data.samples)) return unavailable;
    const grid: (number | null)[][] = Array.from({ length: N }, () => Array<number | null>(N).fill(null));
    for (const s of data.samples) {
      const i = Number(s?.locationId);
      if (!Number.isInteger(i) || i < 0 || i >= pts.length) continue;
      const v = parseFloat(s?.value);
      const p = pts[i];
      grid[p.r][p.c] = Number.isFinite(v) && v > -1000 ? v : null;
    }
    const valid = grid.flat().filter((e): e is number => e != null);
    if (valid.length < N * N * 0.6) return unavailable;

    const midLat = (minLat + maxLat) / 2;
    const cellH = ((maxLat - minLat) / (N - 1)) * 111320;
    const cellW = ((maxLng - minLng) / (N - 1)) * 111320 * Math.cos((midLat * Math.PI) / 180);
    const slopes: number[] = [];
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
      const z = grid[r][c]; if (z == null) continue;
      const zl = c > 0 ? grid[r][c - 1] : null, zr = c < N - 1 ? grid[r][c + 1] : null;
      const zu = r > 0 ? grid[r - 1][c] : null, zd = r < N - 1 ? grid[r + 1][c] : null;
      let dzdx = 0;
      if (zl != null && zr != null && cellW > 0) dzdx = (zr - zl) / (2 * cellW);
      else if (zr != null && cellW > 0) dzdx = (zr - z) / cellW;
      else if (zl != null && cellW > 0) dzdx = (z - zl) / cellW;
      let dzdy = 0;
      if (zu != null && zd != null && cellH > 0) dzdy = (zu - zd) / (2 * cellH);
      else if (zd != null && cellH > 0) dzdy = (z - zd) / cellH;
      else if (zu != null && cellH > 0) dzdy = (zu - z) / cellH;
      const sp = Math.sqrt(dzdx * dzdx + dzdy * dzdy) * 100;
      if (Number.isFinite(sp)) slopes.push(sp);
    }
    if (!slopes.length) return unavailable;

    const maxSlope = Math.round(Math.max(...slopes) * 10) / 10;
    const avgSlope = Math.round((slopes.reduce((a, b) => a + b, 0) / slopes.length) * 10) / 10;
    const avgElevation = Math.round((valid.reduce((a, b) => a + b, 0) / valid.length) * 10) / 10;
    let verdict: Slope3DEP['verdict'] = 'BUILDABLE';
    if (maxSlope > 25) verdict = 'NON-BUILDABLE';
    else if (maxSlope >= 15) verdict = 'REQUIRES ENGINEERING';
    return { avgSlope, maxSlope, avgElevation, verdict, status: 'mapped', sourceUrl };
  } catch {
    return unavailable;
  }
}

function getPermittedCategory(zoningCode: string, zoningDesc: string): 'residential' | 'commercial' | 'multifamily' {
  const code = (zoningCode || '').toUpperCase();
  const desc = (zoningDesc || '').toLowerCase();
  
  if (
    code.startsWith('R-') ||
    code.startsWith('N1-') ||
    code.startsWith('SF-') ||
    code.startsWith('SFT-') ||
    code === 'R1' || code === 'R2' || code === 'R3' || code === 'R4' ||
    desc.includes('single family') ||
    desc.includes('residential single') ||
    code === 'R-1' ||
    code === 'R-10' ||
    code === 'R-4' ||
    code === 'TOD-TR'
  ) {
    if (
      code.startsWith('TOD-M') || 
      code.startsWith('UR-') || 
      code.includes('MF') || 
      desc.includes('multi-family') || 
      desc.includes('apartment') || 
      desc.includes('townhome')
    ) {
      return 'multifamily';
    }
    return 'residential';
  }
  
  if (
    code.startsWith('B-') ||
    code.startsWith('I-') ||
    code.startsWith('C-') ||
    code.startsWith('O-') ||
    code.startsWith('M-') ||
    code === 'UMUD' ||
    code.startsWith('TOD-U') ||
    desc.includes('commercial') ||
    desc.includes('business') ||
    desc.includes('industrial') ||
    desc.includes('office') ||
    desc.includes('retail')
  ) {
    return 'commercial';
  }
  
  if (
    code.startsWith('MF') ||
    code.startsWith('UR-') ||
    code.startsWith('TOD-M') ||
    code.startsWith('TOD-CC') ||
    desc.includes('multi-family') ||
    desc.includes('condo') ||
    desc.includes('townhouse') ||
    desc.includes('mixed-use') ||
    desc.includes('apartment')
  ) {
    return 'multifamily';
  }
  
  return 'residential';
}


export function getUseCategory(zoningCode: string, zoningDesc: string): 'residential' | 'commercial' | 'multifamily' {
  return getPermittedCategory(zoningCode, zoningDesc);
}

async function geocodeAddress(address: string, apiKey: string): Promise<{ lat: number; lng: number } | null> {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}`;
  try {
    const res = await fetchWithTimeout(url, 8000, { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      if (data.status === "OK" && data.results && data.results[0]) {
        const result = data.results[0];
        
        // 1. Verify it represents an actual specific property.
        // It must have a street number or be a precise street address, premise, or subpremise.
        const hasStreetNumber = result.address_components?.some((comp: any) =>
          comp.types.includes("street_number")
        );
        const hasPropertyType = result.types?.some((t: string) =>
          ["street_address", "premise", "subpremise", "establishment", "point_of_interest"].includes(t)
        );
        
        // Exclude generic types that represent streets, cities, postal codes, etc.
        const isGeneric = result.types?.some((t: string) =>
          ["route", "locality", "postal_code", "administrative_area_level_1", "administrative_area_level_2", "country", "neighborhood"].includes(t)
        );

        if ((hasStreetNumber || hasPropertyType) && !isGeneric && result.geometry?.location) {
          const coords = {
            lat: result.geometry.location.lat,
            lng: result.geometry.location.lng
          };
          return coords;
        } else {
          console.warn(`Geocoding rejected address "${address}" because it does not resolve to a specific property. Types: ${JSON.stringify(result.types)}`);
        }
      }
    }
  } catch (e) {
    console.error("Geocoding failed for address:", address, e);
  }
  return null;
}

/**
 * Fallback zoning lookup for counties without a published zoning GIS: asks Gemini
 * (with Google Search grounding) for the official zoning district of a specific
 * address from government/official sources, returning a code + description +
 * source URL. Returns null if nothing credible is found. The result is clearly
 * labeled as a web lookup ("verify") in the UI — it is not authoritative.
 */
type ZoningResult = { code: string; description: string; sourceUrl?: string };

const ZONING_SYSTEM = "You are a zoning research assistant. Find the official zoning district code for a specific parcel from government/official sources (county/city GIS, zoning map, ordinance). Report the specific district code; never answer 'see map'. Only report a code you can support from a credible official source; otherwise return null. Never fabricate.";

/** Parse the zoning JSON ({zoningCode, zoningDescription, source}) out of a model
 *  reply, rejecting non-answers ("see map" / "varies" / null). */
function parseZoningResult(text: string): ZoningResult | null {
  const m = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/\{[\s\S]*\}/);
  const jsonStr = m ? (m[1] || m[0]) : '';
  if (!jsonStr) return null;
  try {
    const obj = JSON.parse(jsonStr.replace(/,\s*([}\]])/g, '$1'));
    const code = obj?.zoningCode;
    if (!code || typeof code !== 'string') return null;
    const c = code.trim();
    if (!c || /^(null|n\/?a|unknown|see\s*map|varies|tbd)$/i.test(c)) return null;
    return {
      code: c,
      description: (typeof obj.zoningDescription === 'string' && obj.zoningDescription.trim()) || 'Zoning (web lookup)',
      sourceUrl: typeof obj.source === 'string' ? obj.source : undefined,
    };
  } catch { return null; }
}

/** Zoning web lookup → parsed zoning result. PERPLEXITY MODE (key configured
 *  + queries): the searching runs on the Perplexity Search API (parallel
 *  batched queries over official zoning sources) and Gemini synthesizes from
 *  those results; fallback is Google-Search grounding. */
async function zoningViaGemini(promptText: string, geminiKey: string, searchQueries?: string[]): Promise<ZoningResult | null> {
  try {
    let effectivePrompt = promptText;
    let usePerplexity = false;
    if (searchQueries && searchQueries.length && liveWebResearchConfigured()) {
      const { block } = await perplexityResearchBlock(searchQueries, { maxResultsPerQuery: 6, maxSources: 18, mode: 'hard' });
      if (block) { effectivePrompt = promptText + block; usePerplexity = true; }
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${geminiKey}`;
    const res = await queueGemini(() => fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: effectivePrompt }] }],
        systemInstruction: { parts: [{ text: ZONING_SYSTEM }] },
        ...(usePerplexity ? {} : { tools: [{ google_search: {} }] }),
      }),
    }), 'high');
    if (!res.ok) return null;
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.map((p: any) => p.text).filter(Boolean).join('') || '';
    return parseZoningResult(text);
  } catch (e) {
    console.warn('Zoning web lookup failed:', e);
    return null;
  }
}

/** Zoning web lookup via DeepSeek V4 Pro using Perplexity Search API sources. */
async function zoningViaDeepSeek(promptText: string, searchQueries?: string[]): Promise<ZoningResult | null> {
  const key = getDeepSeekKey();
  if (!key) return null;
  try {
    let effectivePrompt = promptText;
    if (searchQueries && searchQueries.length && liveWebResearchConfigured()) {
      const { block } = await perplexityResearchBlock(searchQueries, { maxResultsPerQuery: 6, maxSources: 18, mode: 'hard' });
      if (block) { effectivePrompt = promptText + block; }
    }
    const body = JSON.stringify({
      model: 'deepseek-v4-pro',
      messages: [
        { role: 'system', content: ZONING_SYSTEM },
        { role: 'user', content: effectivePrompt },
      ],
      stream: false,
      thinking: { type: 'disabled' },
      temperature: 0.2,
      max_tokens: 2000,
    });
    const msg = await postDeepSeekOnce(body, key);
    const content = msg?.content;
    if (content) return parseZoningResult(content);
    return null;
  } catch (e) {
    console.warn('Zoning web lookup via DeepSeek failed:', e);
    return null;
  }
}

/** Zoning web lookup via Perplexity's `sonar` online chat model. Unlike the
 *  DeepSeek/Gemini paths, `sonar` runs its OWN live web search over the prompt's
 *  official sources, so we POST the prompt straight to the chat completions
 *  endpoint and parse the zoning JSON from the reply. Returns null on missing
 *  key / no confident answer. */
async function zoningViaPerplexity(promptText: string): Promise<ZoningResult | null> {
  const key = getPerplexityKey();
  if (!key) return null;
  try {
    const body = JSON.stringify({
      model: 'sonar',
      messages: [
        { role: 'system', content: ZONING_SYSTEM },
        { role: 'user', content: promptText },
      ],
      temperature: 0.2,
      max_tokens: 2000,
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetchWithTimeout('https://api.perplexity.ai/chat/completions', 30000, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body,
      });
      if (res.ok) {
        const data = await res.json();
        const content = data?.choices?.[0]?.message?.content;
        return content ? parseZoningResult(content) : null;
      }
      if ((res.status === 429 || res.status >= 500) && attempt === 0) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      console.warn(`Zoning web lookup via Perplexity HTTP ${res.status}.`);
      return null;
    }
    return null;
  } catch (e) {
    console.warn('Zoning web lookup via Perplexity failed:', e);
    return null;
  }
}

/**
 * Gemini 3.5 Flash or DeepSeek V4 Pro with Perplexity web search over the official
 * county/city zoning sources. The caller COMBINES this with the county GIS layer to
 * resolve the district (see executeLandAnalysis STAGE 3). Optionally seeded with the
 * GIS code so the AI can confirm/correct the authoritative layer.
 */
export async function fetchZoningViaWebSearch(
  address: string,
  countyName?: string,
  lat?: number,
  lng?: number,
  gisHint?: string | null,
): Promise<ZoningResult | null> {
  const perplexityKey = getPerplexityKey();
  const deepSeekKey = getDeepSeekKey();
  const geminiApiKey = getUserKeys().gemini || "";
  if (!perplexityKey && !deepSeekKey && !geminiApiKey) {
    console.warn("No Perplexity, DeepSeek, or Gemini API key is configured in Account Settings.");
    return null;
  }

  const state = countyName ? countyState(countyName) : 'NC';
  const stateFull = state === 'SC' ? 'South Carolina' : 'North Carolina';

  const countyLine = countyName ? ` It is in ${countyBaseName(countyName)} County, ${stateFull}.` : '';
  const coordLine = (lat != null && lng != null) ? ` The parcel is at coordinates ${lat.toFixed(6)}, ${lng.toFixed(6)}.` : '';
  const hintLine = gisHint
    ? `\nThe county GIS zoning layer returns "${gisHint}" at this parcel point — this is usually authoritative. CONFIRM it against the official zoning map, and only return a different code if you find clear official evidence the parcel's actual zoning is different (e.g. it sits inside a municipality with its own zoning).`
    : '';
  const lookupPrompt = `Find the official ZONING DISTRICT for this exact property: "${address}".${countyLine}${coordLine}${hintLine}
Search official sources: the county/municipal zoning map or ordinance, the local GIS/parcel viewer (look up the parcel and read its zoning attribute), or the planning department. Check whether the parcel is inside a municipality (its city zoning applies) or in the county's jurisdiction (county zoning applies).
Return ONLY a JSON object inside a markdown code block:
\`\`\`json
{ "zoningCode": "R-1", "zoningDescription": "Single-Family Residential", "source": "https://..." }
\`\`\`
Rules: "zoningCode" must be the actual district code that jurisdiction uses for THIS parcel (e.g. R-1, RA, C-2, PUD, MX, RR). Determine the specific code — do NOT answer "see the map" or "varies". If after a genuine search you truly cannot confirm it from a credible official/government source, return {"zoningCode": null}. Never guess or fabricate a code.`;

  // Parallel batched Perplexity searches over the official zoning sources.
  const cityPart = (address.split(',')[1] || '').trim();
  const queries = [
    `zoning district "${address}"`,
    `${countyName ? `${countyBaseName(countyName)} County ${state}` : cityPart ? `${cityPart} ${state}` : stateFull} zoning map GIS parcel viewer`,
    `${countyName ? `${countyBaseName(countyName)} County` : cityPart} ${state} zoning ordinance districts${gisHint ? ` ${gisHint}` : ''}`,
    `${cityPart || countyBaseName(countyName || '') || ''} ${state} planning department zoning lookup`.trim(),
  ];

  // Perplexity's `sonar` model runs its own live web search over official sources
  // — try it first when a key is configured, then fall back to DeepSeek/Gemini.
  if (perplexityKey) {
    const pplxResult = await zoningViaPerplexity(lookupPrompt);
    if (pplxResult) return pplxResult;
  }

  if (deepSeekKey) {
    return await zoningViaDeepSeek(lookupPrompt, queries);
  } else if (geminiApiKey) {
    return await zoningViaGemini(lookupPrompt, geminiApiKey, queries);
  }
  return null;
}

/**
 * Uses client-side Google Maps JavaScript SDK's DistanceMatrixService to fetch exact driving distances and times.
 */
async function fetchDrivingDistancesViaSDK(
  lat: number,
  lng: number,
  destinations: { lat: number; lng: number }[]
): Promise<({ distanceMiles: number; durationMins: number } | null)[] | null> {
  if (
    typeof window === "undefined" ||
    !(window as any).google ||
    !(window as any).google.maps ||
    !(window as any).google.maps.DistanceMatrixService
  ) {
    console.warn("Google Maps JS SDK DistanceMatrixService is not available in the global context.");
    return null;
  }
  const google = (window as any).google;
  const service = new google.maps.DistanceMatrixService();

  // Google's Distance Matrix allows max 25 destinations per request, so we batch
  // larger comp sets into chunks of 25 and stitch the results back together.
  const CHUNK = 25;
  const queryChunk = (chunk: { lat: number; lng: number }[]) =>
    new Promise<({ distanceMiles: number; durationMins: number } | null)[]>((resolve) => {
      try {
        service.getDistanceMatrix(
          {
            origins: [new google.maps.LatLng(lat, lng)],
            destinations: chunk.map(d => new google.maps.LatLng(d.lat, d.lng)),
            travelMode: google.maps.TravelMode.DRIVING,
            unitSystem: google.maps.UnitSystem.IMPERIAL
          },
          (response: any, status: any) => {
            if (status === google.maps.DistanceMatrixStatus.OK && response?.rows?.[0]?.elements) {
              resolve(response.rows[0].elements.map((el: any) =>
                el && el.status === "OK" && el.distance && el.duration
                  ? { distanceMiles: el.distance.value * 0.000621371, durationMins: el.duration.value / 60 }
                  : null
              ));
            } else {
              console.warn("Distance Matrix SDK chunk returned non-OK status:", status);
              resolve(chunk.map(() => null));
            }
          }
        );
      } catch (err) {
        console.error("Error calling Distance Matrix SDK Service:", err);
        resolve(chunk.map(() => null));
      }
    });

  const results: ({ distanceMiles: number; durationMins: number } | null)[] = [];
  for (let i = 0; i < destinations.length; i += CHUNK) {
    const chunkResults = await queryChunk(destinations.slice(i, i + CHUNK));
    results.push(...chunkResults);
  }
  return results.length === destinations.length ? results : null;
}

/** Normalized street key for de-duping / matching detail records to comps. */
function normalizeStreetKey(address: string): string {
  return String(address)
    .toLowerCase()
    .replace(/\b(apt|unit|ste|suite|lot|#)\s*[\w-]*$/i, "")
    .replace(/[^a-z0-9]/g, "");
}

// Canonical STREET core (number + normalized street name only — drops city/state/
// zip and standardizes suffix abbreviations) so the SAME home listed on Realtor,
// Redfin, and Zillow with slightly different text ("Main St" vs "Main Street, NC
// 28027") collapses to one key.
const STREET_SUFFIX: Record<string, string> = {
  street: 'st', avenue: 'ave', av: 'ave', drive: 'dr', road: 'rd', lane: 'ln', court: 'ct',
  circle: 'cir', boulevard: 'blvd', place: 'pl', terrace: 'ter', trail: 'trl', parkway: 'pkwy',
  highway: 'hwy', cove: 'cv', crossing: 'xing', square: 'sq', drives: 'dr', roads: 'rd',
};
function streetCoreKey(address: string): string {
  let s = String(address).toLowerCase().trim();
  const comma = s.indexOf(',');
  if (comma > 0) s = s.slice(0, comma);                       // street portion only
  s = s.replace(/\b(apt|unit|ste|suite|lot|#)\b.*$/i, "");    // strip unit/lot
  s = s.replace(/\b[a-z]+\b/g, (m) => STREET_SUFFIX[m] || m); // canonicalize suffixes
  return s.replace(/[^a-z0-9]/g, "");
}

/** Great-circle distance in meters between two lat/lng points. */
function metersBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Collapse duplicate listings of the SAME property (same home across Realtor /
 *  Redfin / Zillow). Two records match when their canonical street keys agree AND
 *  they're within ~1 mile (so identical street names in different towns don't
 *  merge). Keeps the richest record (verified > has photo > confirmed > most
 *  recent), filling in a missing photo/url from the duplicate. */
function dedupeComps(comps: any[]): any[] {
  const pickBetter = (a: any, b: any): any => {
    const score = (c: any) =>
      (c.verified ? 4 : 0) +
      ((Array.isArray(c.photoUrls) && c.photoUrls.length) || c.imageUrl ? 2 : 0) +
      (c.detailConfirmed ? 1 : 0);
    const sa = score(a), sb = score(b);
    const ta = Date.parse(a.saleDate) || 0, tb = Date.parse(b.saleDate) || 0;
    const winner = sa !== sb ? (sa > sb ? a : b) : (tb > ta ? b : a);
    const loser = winner === a ? b : a;
    if (!winner.imageUrl && loser.imageUrl) winner.imageUrl = loser.imageUrl;
    if ((!winner.photoUrls || !winner.photoUrls.length) && Array.isArray(loser.photoUrls)) winner.photoUrls = loser.photoUrls;
    if (!winner.url && loser.url) winner.url = loser.url;
    return winner;
  };
  const kept: any[] = [];
  for (const c of comps) {
    const ck = streetCoreKey(c.address);
    const idx = kept.findIndex((k) => {
      const kk = streetCoreKey(k.address);
      if (ck && kk && ck === kk) {
        if (!k.coords || !c.coords) return true;       // same street id, can't compare → dup
        return metersBetween(k.coords, c.coords) < 1609; // within 1 mile → same property
      }
      // Different street text but the SAME rooftop (tight 22m) → still a dup.
      return !!(k.coords && c.coords && metersBetween(k.coords, c.coords) < 22);
    });
    if (idx === -1) kept.push(c);
    else kept[idx] = pickBetter(kept[idx], c);
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Google Distance Matrix result cache (per origin/dest pair, rounded to 5
// decimals ≈ 1m). Only SUCCESSFUL driving results are cached — straight-line
// fallbacks are never cached.
// ---------------------------------------------------------------------------
const DM_CACHE_PREFIX = "gisfs:dm:v1:";

function dmCacheKey(oLat: number, oLng: number, dLat: number, dLng: number): string {
  return `${DM_CACHE_PREFIX}${oLat.toFixed(5)},${oLng.toFixed(5)}|${dLat.toFixed(5)},${dLng.toFixed(5)}`;
}

function readDmCache(key: string): { distanceMiles: number; durationMins: number } | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw);
    return Number.isFinite(v?.d) && Number.isFinite(v?.t) ? { distanceMiles: v.d, durationMins: v.t } : null;
  } catch { return null; }
}

function writeDmCache(key: string, r: { distanceMiles: number; durationMins: number }): void {
  try { localStorage.setItem(key, JSON.stringify({ d: r.distanceMiles, t: r.durationMins })); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// ZIP health: ZIPs that come back empty on 2+ consecutive runs are marked dead
// and skipped on later runs (28082 is seeded dead per spec).
// ---------------------------------------------------------------------------
const ZIP_HEALTH_KEY = "gisfs:zip_health:v1";

function readZipHealth(): Record<string, { empty: number; dead: boolean }> {
  try {
    const raw = localStorage.getItem(ZIP_HEALTH_KEY);
    const v = raw ? JSON.parse(raw) : null;
    if (v && typeof v === "object") return v;
  } catch { /* ignore */ }
  return { "28082": { empty: 2, dead: true } }; // seeded dead ZIP
}

function writeZipHealth(h: Record<string, { empty: number; dead: boolean }>): void {
  try { localStorage.setItem(ZIP_HEALTH_KEY, JSON.stringify(h)); } catch { /* ignore */ }
}

function updateZipHealth(zip: string, productive: boolean): void {
  if (!/^\d{5}$/.test(zip)) return;
  const h = readZipHealth();
  const cur = h[zip] || { empty: 0, dead: false };
  if (productive) {
    h[zip] = { empty: 0, dead: false };
  } else {
    const empty = cur.empty + 1;
    h[zip] = { empty, dead: empty >= 2 };
  }
  writeZipHealth(h);
}

// ---------------------------------------------------------------------------
// SOLE comp source: Google Search (Gemini grounding) over PUBLIC MLS sources —
// public MLS portals (Realtor.com, Zillow, Redfin, Homes.com, Trulia, Movoto),
// county register-of-deeds / tax records, and builder closing records. To
// MAXIMIZE coverage, several differently-angled searches run in PARALLEL and
// the unique results are merged.
// ---------------------------------------------------------------------------

/** One grounded Google search for sold new-construction comps. */
async function runGeminiCompQuery(
  geminiApiKey: string,
  subjectAddress: string,
  areaLine: string,
  sourceAngle: string,
  category: 'residential' | 'commercial' | 'multifamily',
  oneYearAgoIso: string,
): Promise<any[]> {
  const propertyTypePrompt = category === 'residential'
    ? 'single-family residential (SFR)'
    : category === 'commercial'
      ? 'commercial or retail'
      : 'multifamily townhome, condo, or apartment';

  const queryPrompt = `The SUBJECT PROPERTY is: ${subjectAddress}.
Use Google Search to find recently SOLD ${propertyTypePrompt} properties within 5 DRIVING MILES of that exact subject property — searching ${areaLine}.
${sourceAngle}

Criteria for each comp (ALL must hold):
- SOLD/CLOSED within the last 12 months (sale date on or after ${oneYearAgoIso}).
- NEW CONSTRUCTION: year built 2025 or 2026 ONLY.
- Within 5 driving miles of the subject property. THE CLOSER THE BETTER — sales on the subject's own street, in its own subdivision, and in its immediate neighborhood are the MOST valuable comps; never skip them for being too close. Cover the FULL radius: the subject's neighborhood, its ZIP, AND every adjacent town/ZIP that falls inside 5 miles (identify those adjacent areas yourself and search them too).
- Completed ${propertyTypePrompt} properties only — the type must match. NEVER vacant land, raw lots, or unbuilt pads.

BE THOROUGH — LAZINESS IS A FAILURE:
- Run AT LEAST 8 DISTINCT search queries across the sources above before answering, with different phrasings (street/subdivision names near the subject, "new construction sold 2025", "new construction sold 2026", builder community names, adjacent town names).
- Specifically hunt for NEW-CONSTRUCTION SUBDIVISIONS and builder communities near the subject (search "<area> new construction community" first, then find each community's closed sales).
- Do NOT stop at the first page of results or after finding a few comps. Keep searching until additional queries stop surfacing NEW qualifying sales.
- Return EVERY qualifying sold property you find — skipping a sale that meets the criteria is an error. NO maximum count.
- Include the living-area square footage when the source shows it. Never fabricate addresses, prices, sale dates, or year built — only real, verifiable closed sales.

Output ONLY a JSON array inside a markdown code block:
\`\`\`json
[
  { "address": "123 Example St, City, NC 28120", "price": 399900, "saleDate": "2026-01-20", "yearBuilt": 2025, "sqft": 1400, "propertyType": "Single-Family Residential (SFR)", "sourceName": "Realtor.com" }
]
\`\`\``;

  const res = await queueGemini(() => fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${geminiApiKey}`,
    120000,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: queryPrompt }] }],
        systemInstruction: {
          parts: [{ text: "You are an exhaustive real estate comps research agent specializing in PUBLIC MLS data. Use Google Search across public MLS portals and public records to find CLOSED/SOLD listings, returning them as structured JSON. Pull EVERY real, verifiable sold property meeting the criteria — there is no maximum; stopping at a handful is a failure. Never include vacant land, active/pending listings, list prices, or estimates — closed sold prices only. Never fabricate." }]
        },
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0 }
      }),
    },
  ), 'idle', 'background');
  if (!res.ok) return [];
  const text = (await res.json()).candidates?.[0]?.content?.parts?.[0]?.text || '';
  const parsed = parseCompsFromJsonText(text);
  if (!parsed) return [];
  return parsed
    .filter((c: any) => c && typeof c.address === 'string' && c.address.trim())
    .map((c: any) => ({
      address: String(c.address).trim(),
      price: Number(c.price) || 0,
      saleDate: String(c.saleDate || ''),
      yearBuilt: c.yearBuilt != null ? Number(c.yearBuilt) : undefined,
      sqft: Number(c.sqft) > 0 ? Number(c.sqft) : undefined,
      propertyType: typeof c.propertyType === 'string' ? c.propertyType : undefined,
      sourceName: typeof c.sourceName === 'string' ? c.sourceName : 'Public MLS (Google Search)',
      status: 'sold',
    }));
}

/**
 * Exhaustive comp discovery in TWO passes:
 *   Pass 1 — several PARALLEL grounded searches anchored to the subject
 *   address, each angled at a different slice of the public MLS ecosystem
 *   (portals by ZIP, public records by ZIP, portals city-wide, and a
 *   new-construction subdivision hunt covering adjacent towns).
 *   Pass 2 — a GAP-FILL search that is shown everything already found and
 *   ordered to dig for qualifying sales NOT yet on the list.
 * All results merged and de-duplicated by address.
 */
async function fetchGoogleMlsComps(
  subjectAddress: string,
  city: string,
  stateCode: string,
  zip: string,
  category: 'residential' | 'commercial' | 'multifamily',
  oneYearAgoIso: string,
  onStageChange?: (stage: string) => void,
): Promise<any[]> {
  const geminiApiKey = getUserKeys().gemini || "";
  if (!geminiApiKey) {
    console.warn("Gemini API key is not configured — cannot run the public-MLS comp search.");
    return [];
  }

  onStageChange?.("Searching public MLS sources for sold comps (Google)...");

  const portalAngle = "Search the PUBLIC MLS portals: Realtor.com sold listings, Zillow 'Sold' pages, Redfin 'Recently Sold', Homes.com, Trulia, and Movoto. Run separate site-scoped searches (site:realtor.com, site:zillow.com, site:redfin.com, site:homes.com, site:trulia.com, site:movoto.com) plus general queries like \"new construction sold 2025\" and \"new construction sold 2026\" with the area name.";
  const recordsAngle = "Search PUBLIC RECORDS: the county register of deeds, county tax assessor sales records, property transfer records, and local MLS public search portals. Also check national builders' communities in the area (D.R. Horton, Lennar, LGI, Meritage, True Homes, Smith Douglas, etc.) combined with 'sold' or 'closed' queries — new-construction closings often appear in public records before portals.";
  const subdivisionAngle = "Hunt NEW-CONSTRUCTION SUBDIVISIONS: first search for new-construction communities and builder developments near the subject (\"new construction community\", \"new homes\", builder names + the area), including in ADJACENT towns and ZIP codes within 5 miles. Then, for EACH community found, search for its recently CLOSED/SOLD homes across the portals and public records.";

  const merge = (byKey: Map<string, any>, rows: any[]) => {
    for (const c of rows) {
      const key = normalizeStreetKey(c.address);
      if (!key) continue;
      const existing = byKey.get(key);
      // Keep the record with the most complete data (price+sqft) on duplicates.
      if (!existing || (!existing.sqft && c.sqft) || (!existing.price && c.price)) {
        byKey.set(key, { ...existing, ...c });
      }
    }
  };

  // --- Pass 1: parallel angled searches ---
  const areaZip = zip ? `ZIP code ${zip} (${city}, ${stateCode}) and every adjacent ZIP within 5 miles` : `in and around ${city}, ${stateCode}`;
  const areaCity = `in and around ${city}, ${stateCode}, including neighboring towns within 5 miles`;
  const queries: Promise<any[]>[] = [
    runGeminiCompQuery(geminiApiKey, subjectAddress, areaZip, portalAngle, category, oneYearAgoIso),
    runGeminiCompQuery(geminiApiKey, subjectAddress, areaZip, recordsAngle, category, oneYearAgoIso),
    runGeminiCompQuery(geminiApiKey, subjectAddress, areaCity, portalAngle, category, oneYearAgoIso),
    runGeminiCompQuery(geminiApiKey, subjectAddress, areaCity, subdivisionAngle, category, oneYearAgoIso),
  ];
  const settled = await Promise.allSettled(queries);
  const byKey = new Map<string, any>();
  let total = 0;
  for (const s of settled) {
    if (s.status !== 'fulfilled') { console.warn('A comp search query failed:', s.reason); continue; }
    total += s.value.length;
    merge(byKey, s.value);
  }
  console.log(`Public-MLS pass 1: ${settled.length} parallel queries → ${total} rows → ${byKey.size} unique candidates.`);

  // --- Pass 2: gap-fill — show what was found, demand what was missed ---
  onStageChange?.("Gap-fill search — hunting comps the first pass missed...");
  try {
    const foundList = Array.from(byKey.values()).map((c) => c.address).slice(0, 80);
    const gapAngle = `The following qualifying sales were ALREADY FOUND:\n${foundList.length ? foundList.map((a) => `- ${a}`).join('\n') : '- (none found yet — search everything)'}\n\nYour job is to find qualifying sold properties NOT on that list. Use DIFFERENT search queries than the obvious ones: other portals (Movoto, Homes.com, local brokerage sites), county deed/transfer records, subdivision and street names near the subject, adjacent towns inside the 5-mile radius, and "sold" filters on builder community pages. Finding zero additional sales is only acceptable after genuinely exhausting these.`;
    const gapRows = await runGeminiCompQuery(geminiApiKey, subjectAddress, areaCity, gapAngle, category, oneYearAgoIso);
    const before = byKey.size;
    merge(byKey, gapRows);
    console.log(`Public-MLS pass 2 (gap-fill): ${gapRows.length} rows → ${byKey.size - before} NEW unique candidates.`);
  } catch (e) {
    console.warn('Gap-fill comp search failed (continuing with pass-1 results):', e);
  }

  const comps = Array.from(byKey.values());
  console.log(`Public-MLS Google search total: ${comps.length} unique candidates.`);
  return comps;
}

// ---------------------------------------------------------------------------
// RealtyAPI sold records (realtyapi.io) — unified access to Realtor, Redfin,
// and Zillow CLOSED sales. Each platform is queried with a coordinate-radius
// search, server-filtered to Sold + new construction (year built >= 2025)
// within the last 12 months, newest first; all three run in parallel and the
// results merge. ONE API key (sent as the `x-realtyapi-key` header) covers
// every platform.
//
// The published OpenAPI specs document request params precisely but NOT the
// response body, and each platform proxies a different source, so responses are
// parsed with a defensive, shape-agnostic normalizer (deep key search). On the
// first run a sample raw record is logged to the console so the field mapping
// can be verified/tightened if a platform changes its shape.
// ---------------------------------------------------------------------------
const REALTY_API_HOSTS: Record<'realtor' | 'redfin' | 'zillow', string> = {
  realtor: "https://realtor.realtyapi.io",
  redfin: "https://redfin.realtyapi.io",
  zillow: "https://zillow.realtyapi.io",
};

const MIN_COMP_YEAR_BUILT = 2025; // new-construction floor (criteria: built 2025-2026)
const MAX_COMP_YEAR_BUILT = 2026; // new-construction ceiling

function getRealtyApiKey(): string {
  const envVar = (typeof import.meta !== 'undefined' && import.meta.env)
    ? import.meta.env.VITE_REALTYAPI_KEY
    : (globalThis as any).process?.env?.VITE_REALTYAPI_KEY;
  return getUserKeys().realtyApi || (envVar as string | undefined) || "";
}

function getDeepSeekKey(): string {
  const envVar = (typeof import.meta !== 'undefined' && import.meta.env)
    ? import.meta.env.VITE_DEEPSEEK_API_KEY
    : (globalThis as any).process?.env?.VITE_DEEPSEEK_API_KEY;
  return getUserKeys().deepSeek || (envVar as string | undefined) || "";
}
/** Mapbox public access token for the satellite base map (Account Settings or env). */
export function getMapboxToken(): string {
  const envVar = (typeof import.meta !== 'undefined' && import.meta.env)
    ? import.meta.env.VITE_MAPBOX_TOKEN
    : (globalThis as any).process?.env?.VITE_MAPBOX_TOKEN;
  return (getUserKeys().mapbox || (envVar as string | undefined) || '').trim();
}

// Per-platform property-type vocabularies (exact tokens from each platform's
// OpenAPI spec). Land / lots are deliberately excluded — comps are completed
// HOMES only, never vacant land. Zillow's homeType tokens aren't documented, so
// it is left unrestricted and filtered client-side by matchesZoningUse() instead.
function realtorPropertyTypes(cat: 'residential' | 'commercial' | 'multifamily'): string {
  if (cat === 'multifamily') return "Townhome,Condo,Multi_Family,Co-op";
  if (cat === 'commercial') return "House,Condo,Townhome,Multi_Family";
  return "House";
}
function redfinHomeTypes(cat: 'residential' | 'commercial' | 'multifamily'): string {
  if (cat === 'multifamily') return "townhouse,condo,Multi family,Co-op";
  if (cat === 'commercial') return "House,condo,townhouse,Multi family";
  return "House";
}

/** Clean, human-readable property-type label (Single-Family / Townhome / Condo / Multi-Family / ...). */
function prettyPropertyType(t: any): string | undefined {
  const s = String(t ?? "").toLowerCase();
  if (!s.trim()) return undefined;
  if (/single|sfr|detached|\bhouse\b|\bhome\b/.test(s)) return "Single-Family";
  if (/town/.test(s)) return "Townhome";
  if (/condo/.test(s)) return "Condo";
  if (/multi|duplex|triplex|fourplex|apartment/.test(s)) return "Multi-Family";
  if (/co.?op/.test(s)) return "Co-op";
  if (/mobile|manufactured/.test(s)) return "Mobile/Manufactured";
  if (/\b(land|lot|acre)\b/.test(s)) return "Land";
  return undefined;
}

/** Does a comp's property type fit the subject's COUNTY ZONING use category? */
function matchesZoningUse(prettyType: string | undefined, category: 'residential' | 'commercial' | 'multifamily'): boolean {
  if (prettyType === "Land" || prettyType === "Mobile/Manufactured") return false; // never land/mobile
  if (!prettyType) return true; // unknown type — server-side type filters already applied
  if (category === 'residential') return prettyType === "Single-Family";
  if (category === 'multifamily') return ["Townhome", "Condo", "Multi-Family", "Co-op"].includes(prettyType);
  return true; // commercial zoning: any completed home type qualifies
}

/** Closed/SOLD only — reject under-contract, pending, coming-soon, for-sale, active listings. */
function isClosedSale(listingStatus: any, saleDate: string, price: number): boolean {
  if (!saleDate || !(price > 0)) return false; // a real closed sale needs a sold date + price
  const s = String(listingStatus ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (!s) return true; // no status exposed (some Redfin records) — sold date + price already required
  if (/(pending|contingent|undercontract|comingsoon|forsale|forrent|active|auction|preforeclosure|backup|accepting|inescrow)/.test(s)) return false;
  return true;
}

// --- response-shape helpers (defensive: the API does not document the body) ---
const _norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");
const _isStr = (v: any) => typeof v === "string" && v.trim() !== "";
const _isNum = (v: any) =>
  typeof v === "number" ? Number.isFinite(v)
  : (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v.replace(/[$,]/g, ""))));
const _toNum = (v: any) => (typeof v === "number" ? v : Number(String(v).replace(/[$,]/g, "")));

/** Depth-first search for the first value whose KEY matches `re` and whose value passes `ok`. */
function deepFind(obj: any, re: RegExp, ok: (v: any) => boolean, depth = 6): any {
  if (obj == null || depth < 0) return undefined;
  if (Array.isArray(obj)) {
    for (const it of obj) {
      const r = deepFind(it, re, ok, depth - 1);
      if (r !== undefined) return r;
    }
    return undefined;
  }
  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {       // direct keys first
      if (re.test(_norm(k)) && ok(v)) return v;
    }
    for (const v of Object.values(obj)) {             // then recurse
      if (v && typeof v === "object") {
        const r = deepFind(v, re, ok, depth - 1);
        if (r !== undefined) return r;
      }
    }
  }
  return undefined;
}

const REALTY_SOURCE_LABELS: Record<'realtor' | 'redfin' | 'zillow', string> = {
  realtor: "RealtyAPI · Realtor",
  redfin: "RealtyAPI · Redfin",
  zillow: "RealtyAPI · Zillow",
};

/** Coerce to a finite number ($/comma-tolerant); undefined if not numeric. */
function rNum(v: any): number | undefined {
  if (v == null) return undefined;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}
/** Coerce a date (ISO string or epoch s/ms) to an ISO string ("" if unparseable). */
function rIso(v: any): string {
  if (v == null || v === "") return "";
  if (typeof v === "number" || /^\d+$/.test(String(v))) {
    const n = Number(v);
    const ms = n > 1e12 ? n : n > 1e9 ? n * 1000 : n;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? "" : d.toISOString();
  }
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? String(v) : d.toISOString();
}
const _join = (street?: any, city?: any, state?: any, zip?: any): string =>
  [street, city, [state, zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");

/** Redfin returns propertyType as a numeric code; map the common ones to a label. */
function redfinTypeLabel(code: any): string | undefined {
  const m: Record<string, string> = { "1": "single_family", "2": "condo", "3": "townhouse", "4": "multi_family", "5": "land", "6": "single_family", "13": "townhouse" };
  return m[String(code)] ?? undefined;
}

/**
 * Pulls a usable comp candidate out of one raw RealtyAPI listing. Each platform
 * has a DIFFERENT, real response shape (verified against live responses), so
 * fields are read from explicit per-platform paths, with a generic deep-search
 * fallback for anything a platform omits or relocates.
 *
 * IMPORTANT: Realtor's search payload does NOT include year built (it is filtered
 * server-side via `yearBuiltRange=min:YYYY`), so `newConstructionFlag` is set
 * true by the caller for every record returned from a year-filtered query.
 */
/** Upgrades a listing-photo URL to the largest variant so it's crisp at full
 *  display size. Realtor's rdcpix uses a size token before .jpg (s/t/m/…); "od"
 *  is the original/full size. Idempotent and only touches rdcpix. */
function upscaleListingPhoto(url: string): string {
  if (/rdcpix\.com/i.test(url)) return url.replace(/(-[a-z]?\d+)[a-z]{1,3}\.jpg/i, "$1od.jpg");
  return url;
}

// Reject anything that isn't a photo of the building: maps, street view,
// floor plans, logos, icons, agent headshots, watermarks, placeholders.
const NON_HOUSE_IMG_RE = /staticmap|static_map|map.?image|maps?\.google|\/maps?\/|streetview|street.?view|floor.?plan|sprite|logo|favicon|\bicons?\b|avatar|headshot|\bagent|broker|watermark|placeholder|no.?photo|no.?image|coming.?soon/i;

/** True only for a real PROPERTY-photo URL (listing CDN or image file), never a
 *  map / floor plan / logo / agent headshot. */
function isHousePhotoUrl(s: any): s is string {
  return typeof s === "string"
    && /^https?:\/\//i.test(s)
    && (/(rdcpix|zillowstatic|cdn-redfin|ssl\.cdn)/i.test(s) || /\.(jpe?g|png|webp)(\?|$)/i.test(s))
    && !NON_HOUSE_IMG_RE.test(s);
}

/** Collects property-photo URLs from a value (cover-first, deduped), skipping
 *  maps / floor plans / logos. Order is preserved so element [0] is the cover. */
function collectHousePhotos(v: any, out: string[], depth = 0): void {
  if (v == null || depth > 8 || out.length >= 12) return;
  if (typeof v === "string") {
    if (isHousePhotoUrl(v)) { const u = upscaleListingPhoto(v.replace(/^http:/i, "https:")); if (!out.includes(u)) out.push(u); }
    return;
  }
  if (Array.isArray(v)) { for (const el of v) collectHousePhotos(el, out, depth + 1); return; }
  if (typeof v === "object") {
    for (const f of ["href", "url", "src", "large", "xl", "full", "medium", "highResolution"]) if (v[f] != null) collectHousePhotos(v[f], out, depth + 1);
    for (const k of Object.keys(v)) collectHousePhotos(v[k], out, depth + 1);
  }
}

/** Ordered list of a listing's property photos (cover-first), so Gemini Vision
 *  can later pick the one that actually shows the building EXTERIOR. */
function findPhotoUrls(raw: any, max = 6): string[] {
  if (!raw || typeof raw !== "object") return [];
  const out: string[] = [];
  const nodes = [raw, raw.property, raw.homeData, raw.hdpView, raw.description].filter((n) => n && typeof n === "object");
  for (const n of nodes) for (const k of ["primary_photo", "primaryPhoto", "coverPhoto", "cover_photo", "heroImage", "imgSrc", "img_src"]) if (n[k] != null) collectHousePhotos(n[k], out);
  for (const n of nodes) for (const k of ["photos", "carouselPhotos", "property_photos", "allPropertyPhotos", "media", "images", "photoData"]) if (n[k] != null) collectHousePhotos(n[k], out);
  if (!out.length) collectHousePhotos(raw, out);
  return out.slice(0, max);
}

/** The listing's cover photo (first property photo). Real exterior selection is
 *  done later by Gemini Vision over the full findPhotoUrls() set. */
function findPhotoUrl(raw: any): string | undefined {
  return findPhotoUrls(raw, 1)[0];
}

function normalizeRealtyListing(raw: any, platform: 'realtor' | 'redfin' | 'zillow'): any | null {
  if (!raw || typeof raw !== "object") return null;

  let price: number | undefined, saleDate = "", yearBuilt: number | undefined,
      sqft: number | undefined, propertyType: string | undefined,
      coords: { lat: number; lng: number } | undefined,
      address: string | undefined, zip: string | undefined,
      url: string | undefined, propertyId: any, rawStatus: any;

  if (platform === "realtor") {
    const a = raw.address || {};
    price = rNum(raw.last_sold_price) ?? rNum(raw.sold_price);            // SOLD price only
    saleDate = rIso(raw.last_sold_date ?? raw.sold_date);
    yearBuilt = rNum(raw.year_built ?? raw.description?.year_built);      // usually absent
    sqft = rNum(raw.sqft ?? raw.description?.sqft);
    propertyType = raw.property_type ?? raw.type;
    rawStatus = raw.status;
    const la = rNum(a.latitude), lo = rNum(a.longitude);
    if (la !== undefined && lo !== undefined) coords = { lat: la, lng: lo };
    address = _join(a.line, a.city, a.state_code ?? a.state, a.postal_code);
    zip = a.postal_code != null ? String(a.postal_code) : undefined;
    url = raw.href ?? raw.permalink;
    propertyId = raw.property_id;
  } else if (platform === "redfin") {
    const h = raw.homeData ?? raw;
    const ai = h.addressInfo ?? {};
    const cen = ai.centroid?.centroid ?? ai.centroid ?? {};
    price = rNum(h.priceInfo?.amount) ?? rNum(h.priceInfo?.homePrice?.int64Value);
    saleDate = rIso(h.lastSaleData?.lastSoldDate ?? h.lastSaleData?.lastSaleDate);
    yearBuilt = rNum(h.yearBuilt?.yearBuilt ?? h.yearBuilt);
    sqft = rNum(h.sqftInfo?.amount);
    propertyType = redfinTypeLabel(h.propertyType);
    rawStatus = (Array.isArray(h.sashes) ? h.sashes.map((x: any) => x?.sashTypeName).filter(Boolean).join(" ") : "") || (h.lastSaleData?.lastSoldDate ? "sold" : "");
    const la = rNum(cen.latitude), lo = rNum(cen.longitude);
    if (la !== undefined && lo !== undefined) coords = { lat: la, lng: lo };
    address = _join(ai.formattedStreetLine, ai.city, ai.state, ai.zip);
    zip = ai.zip != null ? String(ai.zip) : undefined;
    url = h.url ? `https://www.redfin.com${h.url}` : undefined;
    propertyId = h.propertyId ?? h.mlsId;
  } else { // zillow
    const pr = raw.property ?? raw;
    const loc = pr.location ?? {};
    const a = pr.address ?? {};
    price = rNum(pr.price?.value) ?? rNum(pr.hdpView?.price);
    saleDate = rIso(pr.lastSoldDate ?? pr.dateSold);
    yearBuilt = rNum(pr.yearBuilt);
    sqft = rNum(pr.livingArea ?? pr.livingAreaValue);
    propertyType = typeof pr.propertyType === "string" ? pr.propertyType : undefined;
    // marketingStatus is the TRUTHFUL market state ("closed" / "offMarket" /
    // "active" / "pending"); listingStatus is misleadingly "recentlySold" even for
    // homes that are actually for-sale or under-contract. Combine all three so
    // isClosedSale() rejects active/pending/coming-soon listings.
    rawStatus = [pr.listing?.marketingStatus, pr.listing?.listingStatus, pr.hdpView?.listingStatus, pr.homeStatus].filter(Boolean).join(" ");
    const la = rNum(loc.latitude), lo = rNum(loc.longitude);
    if (la !== undefined && lo !== undefined) coords = { lat: la, lng: lo };
    address = _join(a.streetAddress, a.city, a.state, a.zipcode);
    zip = a.zipcode != null ? String(a.zipcode) : undefined;
    // Canonical Zillow listing URL with the address SLUG (e.g.
    // /homedetails/3142-Dublin-Rd-Charlotte-NC-28208/6178388_zpid/). The bare
    // zpid form 302-redirects (which can trip Zillow's bot wall); the zpid is
    // what actually identifies the home, so a slightly-off slug still resolves.
    // hdpView.hdpUrl is a mobile-app deep link that does NOT open the listing.
    const _zslug = [a.streetAddress, a.city, a.state, a.zipcode].filter(Boolean).join(" ").replace(/[^A-Za-z0-9 ]/g, "").trim().replace(/\s+/g, "-");
    url = pr.zpid
      ? `https://www.zillow.com/homedetails/${_zslug ? _zslug + "/" : ""}${pr.zpid}_zpid/`
      : (pr.hdpView?.hdpUrl ? `https://www.zillow.com${pr.hdpView.hdpUrl}` : undefined);
    propertyId = pr.zpid;
  }

  // Generic fallbacks for anything a platform omitted or relocated.
  if (price === undefined) { const v = deepFind(raw, /(soldprice|lastsoldprice|saleprice|closeprice|^price$|pricevalue)/, _isNum); if (v !== undefined) price = _toNum(v); }
  if (!saleDate) { const v = deepFind(raw, /(solddate|lastsolddate|saledate|closedate|datesold)/, (x) => _isStr(x) || _isNum(x)); if (v !== undefined) saleDate = rIso(v); }
  if (yearBuilt === undefined) { const v = deepFind(raw, /(yearbuilt|builtyear|yrbuilt)/, _isNum); if (v !== undefined) yearBuilt = _toNum(v); }
  if (sqft === undefined) { const v = deepFind(raw, /(livingarea|finishedsqft|^sqft$|squarefeet)/, _isNum); if (v !== undefined) sqft = Math.round(_toNum(v)); }
  if (!coords) { const la = deepFind(raw, /(^lat$|latitude)/, _isNum); const lo = deepFind(raw, /(^lng$|^lon$|longitude)/, _isNum); if (_isNum(la) && _isNum(lo)) coords = { lat: _toNum(la), lng: _toNum(lo) }; }
  if (!_isStr(address)) { const ln = deepFind(raw, /(formattedstreetline|streetaddress|^line$|^address$|fulladdress)/, _isStr); if (ln) address = String(ln); }
  if (!_isStr(address)) return null; // no address -> unusable as a comp

  return {
    address: String(address).replace(/\s+/g, " ").trim(),
    price: price === undefined ? 0 : Math.round(price),
    saleDate,
    yearBuilt,
    sqft: sqft && sqft > 0 ? Math.round(sqft) : undefined,
    propertyType: prettyPropertyType(propertyType),
    coords,
    zip,
    imageUrl: findPhotoUrl(raw),
    photoUrls: findPhotoUrls(raw),
    status: "sold",
    listingStatus: _isStr(rawStatus) ? rawStatus : (rawStatus != null ? String(rawStatus) : undefined),
    newConstructionFlag: false, // set true by the caller (year-filtered query)
    propertyId: propertyId != null ? String(propertyId) : undefined,
    sourceName: REALTY_SOURCE_LABELS[platform],
    platform,
    detailConfirmed: true,
    url: _isStr(url) ? url : undefined,
  };
}

/**
 * Finds the listings array inside an unknown RealtyAPI response envelope. Each
 * platform nests differently (e.g. Realtor uses `data.home_search.results`,
 * others put the array at the top level), so this searches by preferred key at
 * EVERY depth and falls back to the first array-of-objects it finds.
 */
function extractRealtyListings(json: any): any[] {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== "object") return [];
  const PREFERRED = ["listings", "results", "properties", "homes", "props", "searchResults", "hits", "data", "listing", "soldHomes", "items"];
  const isObjArray = (v: any) => Array.isArray(v) && v.length > 0 && typeof v[0] === "object" && v[0] !== null;
  let fallback: any[] = [];
  const visit = (node: any, depth: number): any[] | null => {
    if (!node || typeof node !== "object" || depth > 6) return null;
    for (const k of PREFERRED) if (isObjArray((node as any)[k])) return (node as any)[k]; // strong signal
    for (const v of Object.values(node)) if (isObjArray(v) && fallback.length === 0) fallback = v as any[];
    for (const v of Object.values(node)) {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const r = visit(v, depth + 1);
        if (r) return r;
      }
    }
    return null;
  };
  return visit(json, 0) ?? fallback;
}

/** Reads the `nextPage`/`hasMore` flag from an unknown envelope (defaults to false). */
function realtyHasNextPage(json: any): boolean {
  const v = deepFind(json, /(^nextpage$|hasnext|hasmore|morepages)/, (x) => typeof x === "boolean" || x === "true" || x === "false");
  return v === true || v === "true";
}

/**
 * Queries ONE RealtyAPI platform's coordinate-radius SOLD search, paging until
 * the 12-month window is exhausted (or a small page cap). Returns normalized,
 * home-only candidates.
 */
async function fetchRealtyPlatform(
  platform: 'realtor' | 'redfin' | 'zillow',
  lat: number,
  lng: number,
  radiusMiles: number,
  category: 'residential' | 'commercial' | 'multifamily',
  oneYearAgo: Date,
  key: string,
  onStageChange?: (stage: string) => void,
): Promise<any[]> {
  const headers = { "x-realtyapi-key": key };
  const MAX_PAGES = 6;
  const out: any[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const q = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lng),
      radius: String(radiusMiles),
      page: String(page),
    });
    if (platform === "zillow") {
      q.set("listingStatus", "Sold");
      q.set("soldInLast", "12_months");
      q.set("yearBuiltRange", `min:${MIN_COMP_YEAR_BUILT}`);
      // Zillow ignores the year filter, so sort newest-built FIRST and page until
      // builds drop below the window — captures ALL 2025-2026 sales in range
      // instead of only those that happen to sort early by listing date.
      q.set("sortOrder", "Year_Built");
    } else {
      q.set("searchType", "Sold");
      q.set("sortOrder", "Most_Recently_Sold");
      q.set("resultCount", "200");
      if (platform === "realtor") {
        q.set("propertyType", realtorPropertyTypes(category));
        q.set("yearBuiltRange", `min:${MIN_COMP_YEAR_BUILT}`);
      } else {
        q.set("homeType", redfinHomeTypes(category));
        q.set("soldWithin", "Last_1_Year");
        q.set("minYearBuilt", String(MIN_COMP_YEAR_BUILT));
        q.set("maxYearBuilt", String(MAX_COMP_YEAR_BUILT));
      }
    }

    let json: any;
    try {
      const res = await fetchWithTimeout(`${REALTY_API_HOSTS[platform]}/search/bycoordinates?${q.toString()}`, 20000, { headers });
      if (!res.ok) {
        console.warn(`RealtyAPI ${platform} sold search returned HTTP ${res.status} on page ${page}.`);
        break; // auth/credit/other error — stop this platform, let the others run
      }
      json = await res.json();
    } catch (e) {
      console.warn(`RealtyAPI ${platform} sold search failed on page ${page}:`, e);
      break;
    }

    const listings = extractRealtyListings(json);
    if (page === 1) {
      const envKeys = json && typeof json === "object" && !Array.isArray(json) ? Object.keys(json) : (Array.isArray(json) ? ["<root array>"] : []);
      console.log(`RealtyAPI ${platform}: ${listings.length} listing(s) on page 1; envelope keys=[${envKeys.join(", ")}]`);
      if (listings.length > 0) console.log(`RealtyAPI ${platform} sample record:`, JSON.stringify(listings[0]).slice(0, 1800));
      else console.log(`RealtyAPI ${platform} raw envelope (no listings parsed):`, JSON.stringify(json).slice(0, 1200));
    }
    if (listings.length === 0) break;

    let pageOldest = Infinity;
    let pageMaxYear = -Infinity;
    for (const raw of listings) {
      const c = normalizeRealtyListing(raw, platform);
      if (!c) continue;
      const t = c.saleDate ? new Date(c.saleDate).getTime() : NaN;
      if (Number.isFinite(t)) pageOldest = Math.min(pageOldest, t);
      if (c.yearBuilt != null) pageMaxYear = Math.max(pageMaxYear, c.yearBuilt);
      // The query is year-filtered server-side (Realtor omits year_built from its
      // payload), so mark every returned record as new construction; when a
      // platform DOES expose the year, enforce the 2025-2026 window.
      if (c.yearBuilt != null && (c.yearBuilt < MIN_COMP_YEAR_BUILT || c.yearBuilt > MAX_COMP_YEAR_BUILT)) continue;
      c.newConstructionFlag = true;
      // CLOSED SALES ONLY — drop under-contract / pending / coming-soon / active
      // (Zillow ignores the Sold filter and leaks them), require sold price + date.
      if (!isClosedSale(c.listingStatus, c.saleDate, c.price)) continue;
      // Match the subject's COUNTY ZONING use (residential -> single-family;
      // multifamily -> townhome/condo/multi-family). Also drops land/lots.
      if (!matchesZoningUse(c.propertyType, category)) continue;
      out.push(c);
    }
    onStageChange?.(`Scanning ${platform} sold records... page ${page} (${out.length} found)`);

    if (!realtyHasNextPage(json)) break;
    if (platform === "zillow") {
      // Zillow is sorted newest-built first: once a whole page falls below the
      // 2025 floor, every later page is older too — stop paging.
      if (Number.isFinite(pageMaxYear) && pageMaxYear < MIN_COMP_YEAR_BUILT) break;
    } else if (Number.isFinite(pageOldest) && pageOldest < oneYearAgo.getTime()) {
      // Realtor/Redfin are sorted newest-SOLD first: stop once a page's oldest
      // sale predates the 12-month window.
      break;
    }
  }
  return out;
}

/**
 * Realtor + Redfin + Zillow SOLD comps via RealtyAPI, queried in parallel and
 * merged (de-duped by street key; higher-priority platform wins, others backfill
 * missing fields). This is the sole external sold-records source. Returns
 * candidates in the shape the comp engine expects (address, price, saleDate,
 * yearBuilt, sqft, coords, propertyType, status, sourceName, detailConfirmed,
 * url, zip, propertyId).
 */
async function fetchRealtyApiSoldComps(
  lat: number,
  lng: number,
  category: 'residential' | 'commercial' | 'multifamily',
  oneYearAgo: Date,
  onStageChange?: (stage: string) => void,
  radiusMiles = 5,
): Promise<any[]> {
  const key = getRealtyApiKey();
  if (!key) {
    console.warn("No RealtyAPI key configured (Settings -> RealtyAPI Key) — skipping the Realtor/Redfin/Zillow records source.");
    return [];
  }
  // The API search radius; the comp engine then applies the DRIVING-mile filter downstream.
  const RADIUS_MILES = radiusMiles;
  onStageChange?.("Scanning RealtyAPI sold records (Realtor, Redfin, Zillow)...");

  const platforms: ('realtor' | 'redfin' | 'zillow')[] = ["realtor", "redfin", "zillow"];
  const perPlatform = await Promise.all(
    platforms.map((pf) =>
      fetchRealtyPlatform(pf, lat, lng, RADIUS_MILES, category, oneYearAgo, key, onStageChange).catch((e) => {
        console.warn(`RealtyAPI ${pf} platform failed:`, e);
        return [] as any[];
      }),
    ),
  );

  // Merge across platforms by normalized street key. Realtor wins ties, then
  // Redfin, then Zillow — but any platform fills in fields the winner is missing.
  const order: Record<string, number> = { realtor: 0, redfin: 1, zillow: 2 };
  const byKey = new Map<string, any>();
  for (const list of perPlatform) {
    for (const c of list) {
      const k = normalizeStreetKey(c.address);
      if (!k) continue;
      const prev = byKey.get(k);
      if (!prev) { byKey.set(k, c); continue; }
      const winner = order[c.platform] <= order[prev.platform] ? c : prev;
      const filler = winner === c ? prev : c;
      byKey.set(k, {
        ...filler, ...winner,
        sqft: winner.sqft ?? filler.sqft,
        coords: winner.coords ?? filler.coords,
        yearBuilt: winner.yearBuilt ?? filler.yearBuilt,
        url: winner.url ?? filler.url,
        zip: winner.zip ?? filler.zip,
      });
    }
  }
  const merged = Array.from(byKey.values());
  const counts = perPlatform.map((l, i) => `${platforms[i]} ${l.length}`).join(", ");
  console.log(`RealtyAPI sold records: ${counts} -> ${merged.length} unique after cross-platform merge.`);
  return merged;
}

function parseCompsFromJsonText(text: string): any[] | null {
  try {
    const match = text.match(/```json\s*([\s\S]*?)\s*```/);
    let jsonString = '';
    if (match) {
      jsonString = match[1];
    } else {
      const startIdx = text.indexOf('[');
      const endIdx = text.lastIndexOf(']');
      if (startIdx !== -1 && endIdx !== -1) jsonString = text.substring(startIdx, endIdx + 1);
    }
    if (!jsonString) return null;
    const parsed = JSON.parse(jsonString);
    return Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    console.error("Failed to parse comps JSON from LLM response:", e);
    return null;
  }
}

/** Google Distance Matrix via REST (driving, imperial), chunked at 25 destinations. */
async function fetchDrivingDistancesViaREST(
  lat: number,
  lng: number,
  destinations: { lat: number; lng: number }[],
  apiKey: string,
): Promise<({ distanceMiles: number; durationMins: number } | null)[] | null> {
  if (!apiKey || destinations.length === 0) return destinations.length === 0 ? [] : null;
  const CHUNK = 25; // Google's per-request destination cap for 1 origin
  const out: ({ distanceMiles: number; durationMins: number } | null)[] = [];
  try {
    for (let i = 0; i < destinations.length; i += CHUNK) {
      const chunk = destinations.slice(i, i + CHUNK);
      const destStr = chunk.map((d) => `${d.lat},${d.lng}`).join('|'); // lat,lng order; | between pairs
      const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${lat},${lng}&destinations=${destStr}&mode=driving&units=imperial&key=${apiKey}`;
      const res = await fetchWithTimeout(url, 15000);
      if (!res.ok) { out.push(...chunk.map(() => null)); continue; }
      const data = await res.json();
      if (data.status === 'OK' && data.rows?.[0]?.elements) {
        for (const el of data.rows[0].elements) {
          out.push(
            el && el.status === 'OK' && el.distance && el.duration
              ? { distanceMiles: el.distance.value / 1609.344, durationMins: el.duration.value / 60 }
              : null, // NOT_FOUND / ZERO_RESULTS etc. → caller falls back to straight-line
          );
        }
      } else {
        out.push(...chunk.map(() => null)); // top-level non-OK → whole batch falls back
      }
    }
    return out.length === destinations.length ? out : null;
  } catch (e) {
    console.warn('Distance Matrix REST request failed:', e);
    return null;
  }
}

/** Conversational markdown summary: criteria line, per-comp blocks, Bottom Line. */
function buildCompRunSummary(opts: {
  subjectAddress: string;
  comps: CompProperty[];
  radiusExpanded: boolean;
  skippedZips: string[];
  locations: string[];
  candidateCount: number;
  scrapedCount?: number;
  inRadiusCount?: number;
}): string {
  const { subjectAddress, comps, radiusExpanded, skippedZips, locations, candidateCount, scrapedCount, inRadiusCount } = opts;
  const lines: string[] = [];
  lines.push(`## 🏘️ New-Construction Sold Comp Run — ${subjectAddress}`);
  lines.push('');
  lines.push(`Criteria: New construction (built 2025–2026) matching the subject's COUNTY ZONING use category, sold last 12 months, no sqft limits, within 5 driving miles (every qualifying CLOSED sale in range, closest first). Sources: RealtyAPI closed-sale records — Realtor, Redfin & Zillow (coordinate radius scan; under-contract/pending excluded). Distances: Google Distance Matrix driving miles (straight-line in parentheses).`);
  lines.push('');
  lines.push(`Searched: ${locations.join(' · ')}${skippedZips.length ? ` (skipped dead ZIPs: ${skippedZips.join(', ')})` : ''} — ${scrapedCount ?? candidateCount} sold listings collected → ${candidateCount} met the new-construction spec${inRadiusCount != null ? ` → ${inRadiusCount} inside the driving radius` : ''}.`);
  lines.push('');

  if (comps.length > 0) {
    // Property-type mix so the report states what the comps are (single-family,
    // townhome, condo, multi-family, etc.).
    const typeCounts = comps.reduce((m: Record<string, number>, c) => {
      const t = c.propertyType || 'Home'; m[t] = (m[t] || 0) + 1; return m;
    }, {} as Record<string, number>);
    const mix = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${n} × ${t}`).join(', ');
    lines.push(`Comp mix by type: ${mix}.`);
    lines.push('');
  }

  if (comps.length === 0) {
    const why = candidateCount === 0
      ? `None of the collected sold listings were built 2025–2026 — there may simply be no new-construction resales in this area yet.`
      : (inRadiusCount ?? 0) === 0
        ? `${candidateCount} new-construction sale${candidateCount === 1 ? '' : 's'} matched the spec, but none closed within 5 driving miles of the subject.`
        : `Comps inside the radius could not be confirmed.`;
    lines.push(`**No qualifying new-construction comps for this run.** ${why} Use the county tax-assessor values as the only valuation reference.`);
    return lines.join('\n');
  }

  comps.forEach((c, i) => {
    lines.push(`**${i + 1}. ${c.address}**`);
    lines.push(`- Distance: **${c.distanceMiles.toFixed(1)} mi driving** (${(c.straightLineMiles ?? c.distanceMiles).toFixed(1)} mi straight-line)`);
    if (c.drivingFallback) lines.push(`- ⚠ Driving distance unavailable from Google — straight-line used as fallback.`);
    const ppsf = c.pricePerSqft ? ` · $${c.pricePerSqft.toLocaleString()}/sqft` : '';
    const sqft = c.sqft ? ` · ${c.sqft.toLocaleString()} sqft` : '';
    lines.push(`- Sold: **$${c.price.toLocaleString()}** on ${c.saleDate}${sqft}${ppsf} · ${c.propertyType || 'Home'} · Built ${c.yearBuilt ?? 'N/A'}`);
    lines.push(`- ${c.verifiedNote || 'Source: RealtyAPI closed-sale record'}`);
    if (c.priceDiscrepancy) lines.push(`- Price discrepancy: ${c.priceDiscrepancy}`);
    lines.push('');
  });

  const avgPrice = Math.round(comps.reduce((s, c) => s + c.price, 0) / comps.length);
  const ppsfVals = comps.filter((c) => c.pricePerSqft).map((c) => c.pricePerSqft as number);
  const avgPpsf = ppsfVals.length ? Math.round(ppsfVals.reduce((s, v) => s + v, 0) / ppsfVals.length) : 0;
  const minP = Math.min(...comps.map((c) => c.price));
  const maxP = Math.max(...comps.map((c) => c.price));
  const fallbackCount = comps.filter((c) => c.drivingFallback).length;

  let bottom = `**Bottom Line:** ${comps.length} verified new-construction closing${comps.length === 1 ? '' : 's'} averaging **$${avgPrice.toLocaleString()}**`;
  if (avgPpsf) bottom += ` (avg **$${avgPpsf.toLocaleString()}/sqft**)`;
  bottom += `, ranging $${minP.toLocaleString()}–$${maxP.toLocaleString()}. A comparable new build around this site supports roughly that pricing window for ARV purposes.`;
  if (radiusExpanded) bottom += ` Note: fewer than 3 comps closed within 3 driving miles, so the radius was expanded to 5 miles.`;
  if (fallbackCount > 0) bottom += ` ${fallbackCount} comp${fallbackCount === 1 ? '' : 's'} used straight-line distance because Google driving data was unavailable.`;
  bottom += ` Confirm closed prices against the listed sources before contracting.`;
  lines.push(bottom);
  return lines.join('\n');
}

/** Persists the comp run + listings to Supabase (best-effort; never blocks the UI). */
async function persistCompRun(run: {
  targetAddress: string;
  targetLat: number;
  targetLng: number;
  locations: string[];
  skippedZips: string[];
  radiusExpanded: boolean;
  comps: CompProperty[];
  summary: string;
}): Promise<void> {
  try {
    if (!isSupabaseConfigured()) return;
    const mirror = localStorage.getItem('gis_active_user') || sessionStorage.getItem('gis_active_user');
    const userId = mirror ? JSON.parse(mirror).userId : null;
    if (!userId) return;
    const supabase = getSupabase();
    const ppsfVals = run.comps.filter((c) => c.pricePerSqft).map((c) => c.pricePerSqft as number);
    const { data, error } = await supabase
      .from('comp_runs')
      .insert({
        user_id: userId,
        target_address: run.targetAddress,
        target_lat: run.targetLat,
        target_lng: run.targetLng,
        zips_searched: run.locations.join(','),
        zips_skipped: run.skippedZips.join(','),
        radius_miles: 5,
        radius_expanded: run.radiusExpanded,
        comp_count: run.comps.length,
        avg_sold_price: run.comps.length ? Math.round(run.comps.reduce((s, c) => s + c.price, 0) / run.comps.length) : null,
        avg_price_per_sqft: ppsfVals.length ? Math.round(ppsfVals.reduce((s, v) => s + v, 0) / ppsfVals.length) : null,
        summary_md: run.summary,
      })
      .select('id')
      .single();
    if (error) throw error;
    if (run.comps.length > 0) {
      const rows = run.comps.map((c) => ({
        run_id: data.id,
        user_id: userId,
        address: c.address,
        zip: c.zip ?? null,
        driving_miles: c.distanceMiles,
        straight_line_miles: c.straightLineMiles ?? null,
        driving_distance_fallback: !!c.drivingFallback,
        sold_price: c.price,
        sold_date: c.saleDate,
        living_area_sqft: c.sqft ?? null,
        price_per_sqft: c.pricePerSqft ?? null,
        lat: c.coords?.lat ?? null,
        lng: c.coords?.lng ?? null,
        url: c.url ?? null,
        verified_note: c.verifiedNote ?? null,
        price_discrepancy: c.priceDiscrepancy ?? null,
        sources: 'RealtyAPI (Realtor/Redfin/Zillow) + Public MLS (Google Search)',
      }));
      const { error: e2 } = await supabase.from('comp_listings').insert(rows);
      if (e2) throw e2;
    }
    console.log('Comp run persisted to Supabase.');
  } catch (e) {
    console.warn('Comp-run persistence skipped/failed (run the comp_runs SQL in SETUP_SUPABASE.md):', e);
  }
}

export interface CompRunResult {
  comps: CompProperty[];
  summary: string;
}

// ---------------------------------------------------------------------------
// Zillow price verification. The coordinate search returns a sold price, but to
// GUARANTEE it is the true closing price we cross-check each Zillow comp against
// its MLS price history (/pricehistory) and use the "Sold" event matching the
// comp's sale date. Confirmed prices get a badge; mismatches are corrected to
// the MLS figure and flagged. Cached per zpid (7-day TTL) so repeats are free.
// ---------------------------------------------------------------------------
const ZPH_CACHE_PREFIX = "gisfs:zph:v1:";
const ZPH_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ZILLOW_VERIFY = 40;   // closest-N Zillow comps to MLS-verify per run (cost/latency guard)
const ZVERIFY_BATCH = 8;        // concurrent price-history lookups

/** A zpid's SOLD price-history events ({date,price}) from Zillow MLS data, cached. */
async function fetchZillowSoldEvents(zpid: string, key: string): Promise<{ date: string; price: number }[] | null> {
  const ck = ZPH_CACHE_PREFIX + zpid;
  try {
    const raw = localStorage.getItem(ck);
    if (raw) {
      const v = JSON.parse(raw);
      if (v && Array.isArray(v.e) && Date.now() - (v.t || 0) < ZPH_CACHE_TTL_MS) return v.e;
    }
  } catch { /* ignore */ }
  try {
    const res = await fetchWithTimeout(`${REALTY_API_HOSTS.zillow}/pricehistory?byzpid=${encodeURIComponent(zpid)}`, 15000, { headers: { "x-realtyapi-key": key } });
    if (!res.ok) return null;
    const data = await res.json();
    const hist: any[] = Array.isArray(data?.priceHistory) ? data.priceHistory
      : (Array.isArray(data?.priceHistory?.events) ? data.priceHistory.events : []);
    const events = hist
      .filter((h) => /sold/i.test(String(h?.event)))
      .map((h) => ({ date: String(h?.date || "").slice(0, 10), price: rNum(h?.price) ?? 0 }))
      .filter((e) => e.price > 0);
    try { localStorage.setItem(ck, JSON.stringify({ t: Date.now(), e: events })); } catch { /* ignore */ }
    return events;
  } catch {
    return null;
  }
}

/** The SOLD event whose date is closest to the comp's sale date (handles homes with multiple sales). */
function pickSoldEvent(events: { date: string; price: number }[], compSaleDate: string): { date: string; price: number } | null {
  if (!events.length) return null;
  const target = new Date(compSaleDate).getTime();
  if (!Number.isFinite(target)) return events[0];
  let best = events[0], bestDiff = Infinity;
  for (const e of events) {
    const t = new Date(e.date).getTime();
    const diff = Number.isFinite(t) ? Math.abs(t - target) : Infinity;
    if (diff < bestDiff) { bestDiff = diff; best = e; }
  }
  return best;
}

/**
 * Verifies the closest Zillow comps' prices against Zillow's MLS price history,
 * correcting any mismatch to the MLS closing price and tagging each confirmed.
 * Mutates `comps` in place (sets priceConfirmed, and priceDiscrepancy on a fix).
 */
async function verifyZillowCompPrices(
  comps: any[],
  key: string,
  onStageChange?: (stage: string) => void,
): Promise<void> {
  if (!key) return;
  const targets = comps
    .filter((c) => /zillow/i.test(String(c.sourceName)) && c.propertyId)
    .slice(0, MAX_ZILLOW_VERIFY);
  if (targets.length === 0) return;
  onStageChange?.(`Verifying ${targets.length} Zillow comp prices against MLS price history...`);
  for (let i = 0; i < targets.length; i += ZVERIFY_BATCH) {
    await Promise.all(targets.slice(i, i + ZVERIFY_BATCH).map(async (c) => {
      const events = await fetchZillowSoldEvents(String(c.propertyId), key);
      if (!events) return; // could not verify — keep the (MLS-sourced) search price
      const ev = pickSoldEvent(events, c.saleDate);
      if (!ev || !(ev.price > 0)) return;
      const before = c.price;
      if (Math.abs(ev.price - before) > Math.max(500, before * 0.005)) {
        c.priceDiscrepancy = `Search $${before.toLocaleString()} → MLS-confirmed $${ev.price.toLocaleString()}`;
        c.price = ev.price;               // trust the MLS price-history closing figure
        if (ev.date) c.saleDate = ev.date;
      }
      c.priceConfirmed = true;
    }));
  }
}

/**
 * Best-effort: fetch the REAL listing photo for comps that don't have one yet
 * (typically the Google-search-sourced comps). For each photoless comp with
 * coordinates, runs a tiny-radius RealtyAPI SOLD search at its point and matches
 * by street to pull THAT property's primary photo. Bounded + parallel; mutates
 * comp.imageUrl in place. Never throws.
 */
async function backfillCompPhotos(comps: CompProperty[], key: string): Promise<void> {
  if (!key) return;
  const targets = comps.filter((c) => !c.imageUrl && c.coords && typeof c.coords.lat === 'number');
  if (!targets.length) return;

  const lookOn = async (platform: 'realtor' | 'zillow' | 'redfin', c: CompProperty): Promise<string[] | undefined> => {
    try {
      const q = new URLSearchParams({ latitude: String(c.coords!.lat), longitude: String(c.coords!.lng), radius: '0.2', page: '1' });
      if (platform === 'zillow') { q.set('listingStatus', 'Sold'); q.set('soldInLast', '12_months'); }
      else { q.set('searchType', 'Sold'); q.set('sortOrder', 'Most_Recently_Sold'); q.set('resultCount', '25'); }
      const res = await fetchWithTimeout(`${REALTY_API_HOSTS[platform]}/search/bycoordinates?${q.toString()}`, 12000, { headers: { 'x-realtyapi-key': key } });
      if (!res.ok) return undefined;
      const want = normalizeStreetKey(c.address);
      for (const raw of extractRealtyListings(await res.json())) {
        const n = normalizeRealtyListing(raw, platform);
        if (n?.address && Array.isArray(n.photoUrls) && n.photoUrls.length && normalizeStreetKey(n.address) === want) return n.photoUrls as string[];
      }
    } catch { /* ignore */ }
    return undefined;
  };

  await Promise.all(targets.slice(0, 14).map(async (c) => {
    const photos = (await lookOn('realtor', c)) || (await lookOn('zillow', c)) || (await lookOn('redfin', c));
    if (photos && photos.length) { c.photoUrls = photos; c.imageUrl = photos[0]; }
  }));
}

/** Fetch an image URL and return it as Gemini inline_data (base64). Bounded. */
async function imageUrlToInline(url: string): Promise<{ mimeType: string; data: string } | null> {
  try {
    const res = await fetchWithTimeout(url, 10000);
    if (!res.ok) return null;
    const mime = (res.headers.get("content-type") || "image/jpeg").split(";")[0];
    if (!/^image\//i.test(mime)) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (!buf.length || buf.length > 4_000_000) return null;
    let bin = "";
    for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
    return { mimeType: mime, data: btoa(bin) };
  } catch { return null; }
}

/** Gemini Vision: index of the photo showing the building's FRONT EXTERIOR among
 *  a listing's images, or -1 if none. null on failure. */
async function geminiPickExteriorIndex(images: { mimeType: string; data: string }[], geminiKey: string): Promise<number | null> {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${geminiKey}`;
    const parts: any[] = [{
      text: `These ${images.length} images (indexed 0 to ${images.length - 1}, in order) are photos from ONE home listing. Reply with ONLY the single integer index of the image that best shows the BUILDING'S EXTERIOR — the whole house/structure seen from OUTSIDE (front facade preferred). It must NOT be an interior room (kitchen, bath, bedroom, living room), an aerial/satellite view, a map, a floor plan, a sign, a logo, or any cartoon/graphic. If NONE clearly shows a building exterior, reply -1. Reply with just the number.`,
    }];
    images.forEach((img) => parts.push({ inline_data: { mime_type: img.mimeType, data: img.data } }));
    // Large budget: thinking tokens count against maxOutputTokens — 256 got
    // truncated at MAX_TOKENS before the single-integer answer was emitted.
    const res = await queueGemini(() => fetchWithTimeout(url, 30000, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { temperature: 0, maxOutputTokens: 4096 } }) }), 'idle', 'background');
    if (!res.ok) return null;
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.map((p: any) => p.text).filter(Boolean).join("") || "";
    const m = text.match(/-?\d+/);
    return m ? parseInt(m[0], 10) : null;
  } catch { return null; }
}

/** Sets each comp's imageUrl to the photo that actually shows the building
 *  EXTERIOR (Gemini Vision over its photo set). When none of a comp's photos is an
 *  exterior, imageUrl is cleared so the UI shows a neutral placeholder instead of
 *  an interior / graphic. Bounded concurrency; never throws. */
async function selectExteriorComps(comps: CompProperty[], geminiKey: string): Promise<void> {
  if (!geminiKey) return;
  // Cap the vision picks (idle-priority queue work) so a big comp set can't
  // occupy the request lane for many minutes.
  const targets = comps.filter((c) => Array.isArray(c.photoUrls) && c.photoUrls.length).slice(0, 20);
  if (!targets.length) return;
  let i = 0;
  const worker = async () => {
    while (i < targets.length) {
      const c = targets[i++];
      const urls = (c.photoUrls || []).slice(0, 4);
      const encoded = await Promise.all(urls.map(async (u) => ({ u, img: await imageUrlToInline(u) })));
      const valid = encoded.filter((e): e is { u: string; img: { mimeType: string; data: string } } => !!e.img);
      if (!valid.length) continue; // couldn't fetch — keep the cover photo
      const idx = await geminiPickExteriorIndex(valid.map((e) => e.img), geminiKey);
      if (idx == null) continue; // vision unavailable — keep the cover photo
      c.imageUrl = idx >= 0 && idx < valid.length ? valid[idx].u : undefined; // -1 -> no exterior -> placeholder
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, targets.length) }, worker));
}

export async function fetchGoogleDistanceMatrixComps(
  lat: number,
  lng: number,
  _parcelId: string,
  zoningCode: string,
  zoningDesc: string,
  addressString: string,
  _countyName: string,
  onStageChange?: (stage: string) => void,
  maxRadiusMiles = 5,
): Promise<CompRunResult> {
  onStageChange?.("Searching sold listings...");

  // NEW CONSTRUCTION (built 2025–2026) matching the subject's ZONING use category,
  // SOLD within the last 12 months, within the requested DRIVING-mile radius.
  // NO minimum distance — same-subdivision sales next door are the BEST comps.
  // NO minimum or maximum square footage.
  const today = new Date();
  const oneYearAgo = new Date(today);
  oneYearAgo.setFullYear(today.getFullYear() - 1);
  const MIN_YEAR_BUILT = 2025;
  const MAX_YEAR_BUILT = 2026;
  const EXPANDED_RADIUS_MILES = Math.max(1, maxRadiusMiles); // selectable max driving radius (3 / 5 / 10)
  const MIN_DIST_MILES = 0;

  // Permitted use category (drives the Realtor search property type).
  const category = getPermittedCategory(zoningCode, zoningDesc);

  // Straight-line (haversine-approx) miles from the subject to a candidate.
  const straightMiles = (c: { coords: { lat: number; lng: number } }) => {
    const dLng = c.coords.lng - lng;
    const dLat = c.coords.lat - lat;
    const R = 3958.8;
    return Math.sqrt(
      Math.pow((dLat * Math.PI) / 180 * R, 2) +
      Math.pow((dLng * Math.PI) / 180 * R * Math.cos((lat * Math.PI) / 180), 2)
    );
  };

  const isNewConstruction = (yb: any) => {
    const y = Number(yb);
    return Number.isFinite(y) && y >= MIN_YEAR_BUILT && y <= MAX_YEAR_BUILT;
  };
  const soldWithinYear = (sd?: string) => {
    if (!sd) return false;
    const d = new Date(sd);
    return !isNaN(d.getTime()) && d >= oneYearAgo && d.getTime() <= today.getTime() + 86400000;
  };

  // Subject's city / ZIP / state from the input address.
  const addressParts = addressString.split(',');
  const city = addressParts[1] ? addressParts[1].trim() : 'Charlotte';
  const zipMatch = addressString.match(/\b\d{5}\b/);
  const zip = zipMatch ? zipMatch[0] : '';
  const stateMatch = addressString.match(/\b([A-Z]{2})\b/);
  const stateCode = stateMatch ? stateMatch[1] : 'NC';

  // ZIP health: skip ZIPs that have come back empty on 2+ consecutive runs.
  const zipHealth = readZipHealth();
  const skippedZips: string[] = [];
  const locations: string[] = [];
  if (zip) {
    if (zipHealth[zip]?.dead) skippedZips.push(zip);
    else locations.push(zip);
  }
  if (city) locations.push(`${city}, ${stateCode}`);
  if (locations.length === 0) locations.push(`${city}, ${stateCode}`);

  // STEP 4 — BOTH engines run in PARALLEL and merge to catch every comp:
  // (a) RealtyAPI sold records (Realtor + Redfin + Zillow) — one coordinate
  //     radius search per platform, server-filtered to Sold + new construction
  //     (year built >= 2025) within the 12-month window; and
  // (b) [disabled] the former Gemini/Google public-MLS search.
  //
  // RealtyAPI (Realtor + Redfin + Zillow) is now the SOLE comp source — it returns
  // authoritative CLOSED-sale records with reliable price, status, and property
  // type. The Gemini/Google search was LLM-extracted and could surface
  // under-contract listings or inaccurate prices, so it is disabled to keep every
  // comp a verified closed sale. Flip ENABLE_GOOGLE_MLS_COMPS to bring it back.
  const ENABLE_GOOGLE_MLS_COMPS = false;
  const realtyComps = await fetchRealtyApiSoldComps(lat, lng, category, oneYearAgo, onStageChange, EXPANDED_RADIUS_MILES).catch((e) => {
    console.warn("RealtyAPI sold comp search failed:", e);
    return [] as any[];
  });
  const googleComps: any[] = ENABLE_GOOGLE_MLS_COMPS
    ? await fetchGoogleMlsComps(addressString, city, stateCode, zip, category, oneYearAgo.toISOString().split('T')[0], onStageChange).catch((e) => {
        console.warn("Public-MLS Google comp search failed:", e);
        return [] as any[];
      })
    : [];

  // Merge — Realtor records win duplicates (coordinates + confirmed data).
  const mergedByKey = new Map<string, any>();
  for (const g of googleComps) {
    const k = normalizeStreetKey(g.address);
    if (k) mergedByKey.set(k, g);
  }
  for (const r of realtyComps) {
    const k = normalizeStreetKey(r.address);
    if (k) mergedByKey.set(k, { ...mergedByKey.get(k), ...r });
  }
  const compAddresses = Array.from(mergedByKey.values());
  console.log(`Sources merged: ${realtyComps.length} RealtyAPI records + ${googleComps.length} Google → ${compAddresses.length} unique candidates.`);

  // STEP 5 — filter to spec (no distance yet): sold, built 2025/26 (zoning
  // use-category already applied per source), sold ≤12 months, price > 0.
  // NO sqft limits. Cap at 100.
  let candidates = compAddresses.filter((c: any) =>
    String(c.status || 'sold').toLowerCase().includes('sold') &&
    // New construction: year built 2025–2026, or Realtor's official
    // new-construction flag when the record doesn't expose a year.
    (isNewConstruction(c.yearBuilt) || (c.newConstructionFlag === true && c.yearBuilt == null)) &&
    soldWithinYear(c.saleDate) &&
    (c.price || 0) > 0
  );
  if (zip && !skippedZips.includes(zip)) {
    updateZipHealth(zip, candidates.some((c: any) => c.zip === zip));
  }
  // Order by PROXIMITY (closest first) so the full 5-mile set is built from the
  // inside out — never lazily truncated to just the nearest few. Candidates
  // without coordinates sort last (geocoded below). Keep a generous closest-N.
  candidates.sort((a: any, b: any) => {
    const da = a.coords ? straightMiles(a) : Infinity;
    const db = b.coords ? straightMiles(b) : Infinity;
    if (da !== db) return da - db;
    return new Date(b.saleDate).getTime() - new Date(a.saleDate).getTime();
  });
  candidates = candidates.slice(0, 150);
  console.log(`Collected ${candidates.length} spec-qualifying sold-comp candidates (closest-first).`);

  onStageChange?.("Calculating driving distances (Google Distance Matrix)...");

  // STEP 6a — coordinates (Realtor items carry them; geocode the rare misses).
  const googleApiKey = getUserKeys().googleMaps || "";
  const resolved = await Promise.all(
    candidates.map(async (comp: any) => {
      if (comp.coords && typeof comp.coords.lat === 'number' && typeof comp.coords.lng === 'number') return comp;
      if (!googleApiKey) return null;
      const verifiedCoords = await geocodeAddress(comp.address, googleApiKey);
      if (verifiedCoords) return { ...comp, coords: verifiedCoords };
      console.log(`Skipping comp "${comp.address}" — could not geocode.`);
      return null;
    })
  );
  // Cheap straight-line pre-prune (allow ~10% slack over the driving-mile radius).
  const STRAIGHT_PRUNE_MILES = EXPANDED_RADIUS_MILES + Math.max(0.5, EXPANDED_RADIUS_MILES * 0.1);
  const prunedCands: any[] = resolved.filter((c): c is any => c !== null && straightMiles(c) <= STRAIGHT_PRUNE_MILES);
  // Collapse the SAME home listed across Realtor/Redfin/Zillow (different address
  // text but the same property) so the comp set has no duplicates.
  const finalCands: any[] = dedupeComps(prunedCands);
  if (finalCands.length < prunedCands.length) {
    console.log(`Deduped comps: ${prunedCands.length} → ${finalCands.length} unique properties.`);
  }

  // STEP 6b — driving distance via Google Distance Matrix, with per-pair cache.
  const dests = finalCands.map((c) => ({ lat: c.coords.lat, lng: c.coords.lng }));
  const dmResults: ({ distanceMiles: number; durationMins: number } | null)[] =
    dests.map((d) => readDmCache(dmCacheKey(lat, lng, d.lat, d.lng)));
  const missIdx = dmResults.map((r, i) => (r ? -1 : i)).filter((i) => i >= 0);
  if (missIdx.length > 0) {
    const missDests = missIdx.map((i) => dests[i]);
    let fetched: ({ distanceMiles: number; durationMins: number } | null)[] | null = null;
    try {
      fetched = await fetchDrivingDistancesViaSDK(lat, lng, missDests);
    } catch (e) {
      console.warn("Distance Matrix SDK failed:", e);
    }
    if (!fetched) fetched = await fetchDrivingDistancesViaREST(lat, lng, missDests, googleApiKey);
    missIdx.forEach((orig, j) => {
      const r = fetched ? fetched[j] : null;
      if (r) {
        dmResults[orig] = r;
        writeDmCache(dmCacheKey(lat, lng, dests[orig].lat, dests[orig].lng), r); // successes only
      }
    });
  }

  const compsAll = finalCands.map((c, idx) => {
    const r = dmResults[idx];
    const sl = Math.round(straightMiles(c) * 100) / 100;
    return {
      address: c.address,
      price: c.price,
      saleDate: c.saleDate,
      yearBuilt: c.yearBuilt,
      propertyType: c.propertyType,
      coords: c.coords,
      sqft: c.sqft,
      url: c.url,
      zip: c.zip,
      imageUrl: c.imageUrl,
      photoUrls: c.photoUrls,
      propertyId: c.propertyId,
      sourceName: c.sourceName,
      newConstructionFlag: c.newConstructionFlag,
      detailConfirmed: c.detailConfirmed,
      distanceMiles: r ? Math.round(r.distanceMiles * 100) / 100 : sl,
      durationMins: r ? Math.round(r.durationMins * 10) / 10 : Math.round(sl * 2.5 * 10) / 10,
      straightLineMiles: sl,
      drivingFallback: !r, // straight-line fallback; flagged in summary, never cached
    };
  });

  // STEP 6c — include EVERY qualifying comp from the closest out to the FULL 5
  // driving miles (no lazy 3-mile cap), ordered nearest-first.
  const chosen = compsAll
    .filter((c) => c.distanceMiles >= MIN_DIST_MILES && c.distanceMiles <= EXPANDED_RADIUS_MILES)
    .sort((a, b) => a.distanceMiles - b.distanceMiles);
  const radiusExpanded = false;

  // Cross-check the closest Zillow comps against Zillow's MLS price history and
  // correct/confirm their sold prices before they're shown or used.
  await verifyZillowCompPrices(chosen, getRealtyApiKey(), onStageChange);

  // STEP 7 — source attribution. Realtor records confirmed on their detail
  // record get a verified badge; Google-sourced comps carry a confirm note.
  const verified = chosen.map((c: any) => ({
    ...c,
    verified: !!c.detailConfirmed,
    verifiedNote: c.priceConfirmed
      ? `✓ ${c.sourceName || 'RealtyAPI'} — sold price MLS-confirmed${c.yearBuilt ? ` · built ${c.yearBuilt}` : ''}`
      : c.detailConfirmed
        ? `✓ ${c.sourceName || 'RealtyAPI'} closed-sale record${c.yearBuilt ? ` (built ${c.yearBuilt})` : ''}`
        : `Source: ${c.sourceName || 'RealtyAPI'} — confirm closed price before contracting`,
  }));

  // Final shape: $/sqft, nearest-first ordering, internal fields stripped.
  const result: CompProperty[] = verified
    .map((c: any) => ({ ...c, pricePerSqft: c.sqft ? Math.round(c.price / c.sqft) : undefined }))
    .sort((a: any, b: any) => a.distanceMiles - b.distanceMiles)
    .map((c: any) => {
      const { propertyId, propertyHistory, status, sourceName, newConstructionFlag, detailConfirmed, priceConfirmed, ...rest } = c;
      return rest as CompProperty;
    });

  const summary = buildCompRunSummary({
    subjectAddress: addressString,
    comps: result,
    radiusExpanded,
    skippedZips,
    locations,
    candidateCount: candidates.length,
    scrapedCount: compAddresses.length,
    inRadiusCount: chosen.length,
  });

  // Persist the run + listings to Supabase (best-effort, non-blocking).
  void persistCompRun({
    targetAddress: addressString,
    targetLat: lat,
    targetLng: lng,
    locations,
    skippedZips,
    radiusExpanded,
    comps: result,
    summary,
  });

  // Backfill REAL listing photos for any comp that still lacks one (e.g. the
  // Google-search comps) so every comp has a property photo set. Best-effort.
  onStageChange?.('Fetching listing photos…');
  await backfillCompPhotos(result, getRealtyApiKey());

  // Make each comp's photo the BUILDING EXTERIOR: Gemini Vision picks the exterior
  // shot from the listing's photos (new-construction covers are often interiors,
  // renderings, or marketing graphics). Clears the photo when none is an exterior.
  onStageChange?.('Selecting exterior photos…');
  await selectExteriorComps(result, getBackgroundGeminiKey());

  console.log(`Returning ${result.length} verified new-construction comps.`);
  return { comps: result, summary };
}

/** A grounded (Google-Search) Gemini text call with ONE retry on a transient
 *  rate-limit/5xx — so the cost estimate & material takeoff don't fail (and the
 *  card doesn't vanish) when they fire alongside the report's Gemini burst. */
async function groundedGeminiText(geminiKey: string, prompt: string, systemText: string, timeoutMs: number, searchQueries?: string[], diag?: { perplexityAttempted: boolean; perplexitySources: number; perplexityUrls?: string[] }): Promise<string | null> {
  // PERPLEXITY MODE (key configured + queries provided): the live searching
  // runs on the Perplexity Search API — all queries in parallel batches, many
  // ranked sources with extracted content — and Gemini synthesizes from those
  // sources WITHOUT the google_search tool (no grounding quota, no grounding
  // outages). Legacy Google-Search grounding remains the fallback. When a `diag`
  // object is passed, it records whether Perplexity was attempted and how many
  // sources came back, so callers can tell a Perplexity miss from a Gemini miss.
  let effectivePrompt = prompt;
  let usePerplexity = false;
  if (searchQueries && searchQueries.length && liveWebResearchConfigured()) {
    if (diag) diag.perplexityAttempted = true;
    const { block, urls } = await perplexityResearchBlock(searchQueries);
    if (diag) { diag.perplexitySources = urls.length; diag.perplexityUrls = urls; }
    if (block) { effectivePrompt = prompt + block; usePerplexity = true; }
  }
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: effectivePrompt }] }],
    systemInstruction: { parts: [{ text: systemText }] },
    ...(usePerplexity ? {} : { tools: [{ google_search: {} }] }),
  });
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${geminiKey}`;
  // 3 attempts with backoff on THIS key only. Background lookups stay on the
  // background key (#2) and the report/chat/zoning on the primary key — the two
  // keys keep their own quota lanes and never fall through to each other.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await queueGemini(() => fetchWithTimeout(url, timeoutMs, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }), 'low', 'background');
      if (res.ok) {
        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.map((p: any) => p.text).filter(Boolean).join('') || '';
        if (text) return text;
        if (attempt < 2) { await new Promise((r) => setTimeout(r, 2000)); continue; } // empty candidate — retry
        return '';
      }
      // 5xx = Google-side overload storms that can last minutes — space the
      // retries out (6s/12s) instead of hammering back inside the same storm.
      if ((res.status === 429 || res.status >= 500) && attempt < 2) { await new Promise((r) => setTimeout(r, (res.status === 429 ? 2500 : 6000) * (attempt + 1))); continue; }
      // Invalid key / API not enabled — surface it; no cross-key fallback.
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        console.warn(`Gemini key rejected (HTTP ${res.status}) — check the key is valid and its Google project has the Generative Language API enabled.`);
      }
      return null;
    } catch {
      // network error or per-attempt timeout abort — retry
      if (attempt < 2) { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); continue; }
      return null;
    }
  }
  return null;
}

// NC county → BLS OEWS metropolitan area code (CBSA zero-padded to 7). Counties
// not in a metro fall back to the NC statewide wage. Covers the state's main
// development markets; the rest use statewide.
const NC_COUNTY_MSA: Record<string, { code: string; name: string }> = (() => {
  const m: Record<string, { code: string; name: string }> = {};
  const add = (code: string, name: string, counties: string[]) => counties.forEach((c) => { m[c] = { code, name }; });
  add('0016740', 'Charlotte', ['Mecklenburg', 'Cabarrus', 'Gaston', 'Union', 'Iredell', 'Lincoln', 'Rowan', 'Anson']);
  add('0039580', 'Raleigh', ['Wake', 'Johnston', 'Franklin']);
  add('0020500', 'Durham–Chapel Hill', ['Durham', 'Orange', 'Chatham', 'Person', 'Granville']);
  add('0024660', 'Greensboro–High Point', ['Guilford', 'Randolph', 'Rockingham']);
  add('0049180', 'Winston-Salem', ['Forsyth', 'Davidson', 'Davie', 'Stokes', 'Yadkin']);
  add('0011700', 'Asheville', ['Buncombe', 'Haywood', 'Henderson', 'Madison']);
  add('0048900', 'Wilmington', ['New Hanover', 'Pender', 'Brunswick']);
  add('0022180', 'Fayetteville', ['Cumberland', 'Harnett', 'Hoke']);
  add('0025860', 'Hickory', ['Catawba', 'Burke', 'Caldwell', 'Alexander']);
  add('0024780', 'Greenville', ['Pitt']);
  add('0027340', 'Jacksonville', ['Onslow']);
  add('0015500', 'Burlington', ['Alamance']);
  add('0024140', 'Goldsboro', ['Wayne']);
  add('0040580', 'Rocky Mount', ['Nash', 'Edgecombe']);
  add('0035100', 'New Bern', ['Craven', 'Jones', 'Pamlico']);
  return m;
})();

// Construction trades and their SOC codes for the BLS OEWS wage query.
const BLS_TRADES: { soc: string; label: string }[] = [
  { soc: '472061', label: 'Construction laborers' },
  { soc: '472031', label: 'Carpenters' },
  { soc: '472051', label: 'Cement masons' },
  { soc: '472021', label: 'Brick/blockmasons' },
  { soc: '472111', label: 'Electricians' },
  { soc: '472152', label: 'Plumbers' },
  { soc: '499021', label: 'HVAC techs' },
  { soc: '472081', label: 'Drywall installers' },
  { soc: '472141', label: 'Painters' },
  { soc: '472181', label: 'Roofers' },
];

interface BlsLocalWages { areaName: string; year: string; wages: { label: string; hourly: number }[]; sourceUrl: string }

/** Real local construction-trade hourly MEDIAN wages from the U.S. BLS OEWS
 *  (datatype 08), by metro for the parcel's county (NC statewide fallback). This
 *  is the authoritative LABOR anchor for the cost estimate. Cached ~30 days. */
async function fetchBlsLocalWages(county: string): Promise<BlsLocalWages | null> {
  const msa = NC_COUNTY_MSA[county];
  const attempts = [
    ...(msa ? [{ type: 'M', area: msa.code, name: `${msa.name} metro` }] : []),
    { type: 'S', area: '3700000', name: 'North Carolina' },
  ];
  for (const at of attempts) {
    const ck = `gisfs:bls:v1:${at.type}${at.area}`;
    try {
      const cached = localStorage.getItem(ck);
      if (cached) {
        const v = JSON.parse(cached);
        if (v && Date.now() - (v.t || 0) < 30 * 864e5 && Array.isArray(v.wages) && v.wages.length) {
          return { areaName: at.name, year: v.year, wages: v.wages, sourceUrl: 'https://www.bls.gov/oes/' };
        }
      }
    } catch { /* ignore */ }
    try {
      const ids = BLS_TRADES.map((t) => `OEU${at.type}${at.area}000000${t.soc}08`);
      // api.bls.gov sends no CORS headers, so the browser can't call it
      // directly — go through our Netlify proxy (direct call kept as a
      // fallback for non-Netlify dev environments).
      const blsBody = { method: 'POST' as const, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seriesid: ids }) };
      let res = await fetchWithTimeout('/.netlify/functions/bls', 15000, blsBody).catch(() => null);
      if (!res || !res.ok) res = await fetchWithTimeout('https://api.bls.gov/publicAPI/v2/timeseries/data/', 15000, blsBody).catch(() => null);
      if (!res || !res.ok) continue;
      const j = await res.json();
      const wages: { label: string; hourly: number }[] = [];
      let year = '';
      for (const s of (j.Results?.series || [])) {
        const soc = String(s.seriesID).slice(17, 23);
        const trade = BLS_TRADES.find((t) => t.soc === soc);
        const d = (s.data || []).find((x: any) => x.value && x.value !== '-');
        if (trade && d && Number.isFinite(Number(d.value))) { wages.push({ label: trade.label, hourly: Math.round(Number(d.value) * 100) / 100 }); year = d.year || year; }
      }
      if (wages.length >= 4) {
        try { localStorage.setItem(ck, JSON.stringify({ t: Date.now(), year, wages })); } catch { /* ignore */ }
        return { areaName: at.name, year, wages, sourceUrl: 'https://www.bls.gov/oes/' };
      }
    } catch { /* try next attempt */ }
  }
  return null;
}

/**
 * INSTANT construction-cost estimate (Handoff-style): a detailed, ITEMIZED
 * new-construction budget at CURRENT LOCAL prices for building a single-family
 * home on this parcel. LABOR is anchored to REAL local wages from the U.S. BLS
 * OEWS (by metro); MATERIALS are researched at current local prices via Gemini +
 * Google Search. Sizes the home to the verified comps; adds site-specific costs
 * (clearing, grading, well/septic) from the parcel data. Returns null on failure;
 * never fabricates (cites sources).
 */
export async function fetchConstructionCostEstimate(reportData: SiteFeasibilityData): Promise<ConstructionCostEstimate | null> {
  const geminiKey = getBackgroundGeminiKey(); // second key when configured — own quota lane
  if (!geminiKey) return null;

  // Size the planned home to the local new-construction comps (median GLA).
  const sqfts = (reportData.comps || []).map((c) => c.sqft).filter((n): n is number => !!n && n > 0).sort((a, b) => a - b);
  const plannedSqft = sqfts.length ? Math.round(sqfts[Math.floor(sqfts.length / 2)] / 50) * 50 : 1600;
  const ppsfs = (reportData.comps || []).map((c) => c.pricePerSqft).filter((n): n is number => !!n && n > 0).sort((a, b) => a - b);
  const medianPpsf = ppsfs.length ? ppsfs[Math.floor(ppsfs.length / 2)] : null;

  const sp = reportData.slopeProfile;
  const slopeLine = sp ? `Topography (USGS 3DEP): avg slope ${sp.avgSlope}%, max ${sp.maxSlope}% — ${sp.verdict}.` : '';
  const fz = reportData.floodZone;
  const floodLine = fz && fz.status === 'mapped' ? `FEMA flood: Zone ${fz.zone}${fz.inSFHA ? ' (in SFHA)' : ''}.` : '';

  // Real local LABOR rates from the U.S. BLS (the authoritative labor anchor).
  const bls = await fetchBlsLocalWages(reportData.countyName).catch(() => null);
  const laborBlock = bls
    ? `\nLOCAL LABOR RATES — use these REAL U.S. BLS median hourly wages for ${bls.areaName} (${bls.year}) as the basis for the LABOR portion of every line item; do NOT invent labor rates (apply a realistic crew burden/overhead on top): ${bls.wages.map((w) => `${w.label} $${w.hourly}/hr`).join(', ')}.`
    : '';

  const prompt = `Produce a DETAILED, ITEMIZED new-construction cost estimate at CURRENT LOCAL prices for building ONE single-family home on this parcel.
PROPERTY: ${reportData.inputAddress} — ${reportData.countyName} County, North Carolina.
PLANNED HOME: ~${plannedSqft} sqft single-family (sized to the local new-construction comps), zoning ${reportData.zoningCode || 'residential'}.
SITE: lot ${reportData.gisAcres?.toFixed(2)} acres. ${slopeLine} ${floodLine}${medianPpsf ? ` Local comps sell around $${medianPpsf}/sqft finished.` : ''}${laborBlock}

For LABOR, base each line item on the BLS local wages above. For MATERIALS, use Google Search to find CURRENT LOCAL unit prices for THIS metro from MULTIPLE recent sources — do NOT use generic national averages. Build a complete itemized hard-cost budget covering: site clearing & tree removal, grading/earthwork, foundation (crawlspace/slab/basement), framing material + framing labor, roofing, windows, exterior doors, siding, plumbing, HVAC, electrical, insulation, drywall, interior trim & paint, cabinets, countertops, flooring, appliances, gutters, driveway/landscaping, and EITHER well drilling + septic system (if rural/no public utilities) OR water/sewer tap & impact fees, plus building permits and survey. Add site-specific ADDERS where the site warrants them (extra clearing if wooded, extra grading/retaining/engineering if slope >= 15%, well + septic if no public water/sewer).

Return ONLY a JSON object inside a \`\`\`json code block:
\`\`\`json
{
  "locality": "Concord / Cabarrus County metro, NC",
  "plannedSqft": ${plannedSqft},
  "lineItems": [
    { "category": "Site Work", "item": "Clearing & grading", "detail": "~1.3 ac, light tree cover", "cost": 12000 }
  ],
  "builderFee": 25000,
  "contingency": 8000,
  "assumptions": ["Crawlspace foundation", "Well + septic (no public sewer)"],
  "sources": ["https://...", "https://..."]
}
\`\`\`
Rules: every "cost" is a whole-dollar USD number for THIS home/lot from cited CURRENT LOCAL prices. Group line items by category in this order: Site Work, Foundation, Framing, Exterior, Mechanical, Interior, Permits & Fees. Put the builder fee and contingency in their OWN fields (not in lineItems). Do NOT include the land/lot purchase price. Never fabricate a number — cite the sources you used. Be EXTREMELY ACCURATE and local.`;

  try {
    const county = reportData.countyName || 'North Carolina';
    const yr = new Date().getFullYear();
    const text = await groundedGeminiText(
      geminiKey,
      prompt,
      "You are a senior residential construction estimator. Use the live web search results to price each line item at CURRENT LOCAL costs for the property's metro from multiple credible sources. Return only the requested JSON; never invent prices; cite sources.",
      120000,
      // Parallel batched Perplexity searches — many local pricing sources.
      [
        `cost per square foot to build a house ${county} County NC ${yr}`,
        `new home construction cost breakdown by trade ${county} County North Carolina`,
        `${county} County NC building permit fees new single family home`,
        `land clearing and grading cost ${county} County NC`,
        `foundation crawlspace slab cost ${county} County NC ${yr}`,
        `framing roofing siding installed cost per sqft North Carolina ${yr}`,
        `HVAC plumbing electrical rough-in cost new construction NC ${yr}`,
        `well drilling cost per foot North Carolina ${yr}`,
        `septic system installation cost ${county} County NC`,
        `water sewer tap impact fees ${county} County NC`,
      ],
    );
    if (!text) return null;
    const m = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/\{[\s\S]*\}/);
    const jsonStr = m ? (m[1] || m[0]) : "";
    if (!jsonStr) return null;
    const obj = JSON.parse(jsonStr.replace(/,\s*([}\]])/g, "$1"));

    const lineItems: CostLineItem[] = Array.isArray(obj.lineItems)
      ? obj.lineItems
          .filter((li: any) => li && typeof li.item === "string" && Number.isFinite(Number(li.cost)))
          .map((li: any) => ({ category: String(li.category || "Other").trim(), item: String(li.item).trim(), detail: li.detail ? String(li.detail).trim() : undefined, cost: Math.round(Number(li.cost)) }))
      : [];
    if (!lineItems.length) return null;

    const hardCostTotal = lineItems.reduce((s, li) => s + (li.cost || 0), 0);
    const builderFee = Math.round(Number(obj.builderFee) || 0);
    const contingency = Math.round(Number(obj.contingency) || 0);
    const totalCost = hardCostTotal + builderFee + contingency;
    const sqft = Math.round(Number(obj.plannedSqft) || plannedSqft) || plannedSqft;

    return {
      locality: String(obj.locality || countyDisplayName(reportData.countyName)).trim(),
      plannedSqft: sqft,
      lineItems,
      hardCostTotal,
      builderFee,
      contingency,
      totalCost,
      costPerSqft: sqft > 0 ? Math.round(totalCost / sqft) : 0,
      laborBasis: bls ? `Labor anchored to U.S. BLS OEWS median wages — ${bls.areaName} (${bls.year})` : undefined,
      assumptions: Array.isArray(obj.assumptions) ? obj.assumptions.map((a: any) => String(a)).filter(Boolean).slice(0, 8) : [],
      sources: [
        ...(bls ? [bls.sourceUrl] : []),
        ...(Array.isArray(obj.sources) ? obj.sources.map((s: any) => String(s)).filter((s: string) => /^https?:\/\//.test(s)) : []),
      ].slice(0, 8),
      generatedAt: Date.now(),
    };
  } catch (e) {
    console.warn("Construction cost estimate failed:", e);
    return null;
  }
}

// WHOLE-HOUSE material "recipe": engineering takeoff factors for a typical
// wood-framed NC single-family home, phase by phase. `qty(sqft)` derives the
// quantity from the planned floor area (per-sqft factors, or counts scaled by
// size); `priceDesc` tells the grounded pricing step exactly what local unit
// price to find. (Step 3 of the GIS + pricing blueprint — the full build.)
interface RecipeItem {
  key: string; material: string; unit: string; phase: string;
  qty: (sqft: number) => number; priceDesc: string;
}
const MATERIAL_RECIPE: RecipeItem[] = [
  // Foundation & Site
  { key: 'concrete_cuyd', material: 'Concrete — footings & slab (ready-mix)', unit: 'cu yd', phase: 'Foundation & Site', qty: (s) => s * 0.022, priceDesc: 'delivered ready-mix concrete per cubic yard' },
  { key: 'gravel_ton', material: 'Gravel base (crushed stone)', unit: 'ton', phase: 'Foundation & Site', qty: (s) => s * 0.012, priceDesc: 'crushed stone / #57 gravel per ton' },
  { key: 'vapor_barrier_sqft', material: 'Vapor barrier (6-mil poly)', unit: 'sqft', phase: 'Foundation & Site', qty: (s) => s * 1.05, priceDesc: '6-mil polyethylene vapor barrier per sqft' },
  // Framing
  { key: 'framing_lumber_bf', material: 'Framing lumber (2x SPF)', unit: 'board ft', phase: 'Framing', qty: (s) => s * 6.5, priceDesc: 'framing lumber per board-foot (derive from a current 2x4x8 stud price)' },
  { key: 'osb_wall_sheet', material: 'OSB wall sheathing (7/16" 4x8)', unit: 'sheet', phase: 'Framing', qty: (s) => s * 0.045, priceDesc: 'one 7/16" 4x8 OSB sheet' },
  { key: 'subfloor_sheet', material: 'Subfloor (3/4" T&G 4x8)', unit: 'sheet', phase: 'Framing', qty: (s) => s * 0.031, priceDesc: 'one 3/4" 4x8 tongue-and-groove subfloor sheet (OSB/plywood)' },
  { key: 'lvl_beam_lf', material: 'Engineered LVL beams', unit: 'linear ft', phase: 'Framing', qty: (s) => s * 0.02, priceDesc: 'LVL beam per linear foot (e.g. 1.75"x9.25")' },
  // Roofing
  { key: 'shingles_square', material: 'Roof shingles (architectural)', unit: 'square', phase: 'Roofing', qty: (s) => s * 0.014, priceDesc: 'architectural shingles per SQUARE (100 sqft, ~3 bundles)' },
  { key: 'underlayment_square', material: 'Roof underlayment (synthetic)', unit: 'square', phase: 'Roofing', qty: (s) => s * 0.014, priceDesc: 'synthetic roofing underlayment per square (100 sqft)' },
  // Exterior envelope
  { key: 'house_wrap_sqft', material: 'House wrap (weather barrier)', unit: 'sqft', phase: 'Exterior', qty: (s) => s * 0.9, priceDesc: 'house wrap / weather-resistive barrier per sqft' },
  { key: 'siding_square', material: 'Siding (vinyl / fiber-cement)', unit: 'square', phase: 'Exterior', qty: (s) => s * 0.009, priceDesc: 'exterior siding per square (100 sqft) — vinyl or fiber-cement' },
  { key: 'windows_ea', material: 'Windows (vinyl, installed size)', unit: 'each', phase: 'Exterior', qty: (s) => Math.max(6, Math.round(s / 130)), priceDesc: 'one standard vinyl double-hung window' },
  { key: 'exterior_doors_ea', material: 'Exterior doors', unit: 'each', phase: 'Exterior', qty: (s) => Math.max(2, Math.round(s / 1200)), priceDesc: 'one exterior entry door (steel/fiberglass)' },
  { key: 'garage_door_ea', material: 'Garage door', unit: 'each', phase: 'Exterior', qty: () => 1, priceDesc: 'one 16x7 sectional garage door' },
  // Insulation
  { key: 'wall_insulation_sqft', material: 'Wall insulation (R-15 batts)', unit: 'sqft', phase: 'Insulation', qty: (s) => s * 0.9, priceDesc: 'R-13/R-15 fiberglass batt wall insulation per sqft' },
  { key: 'attic_insulation_sqft', material: 'Attic insulation (blown R-38)', unit: 'sqft', phase: 'Insulation', qty: (s) => s * 1.0, priceDesc: 'blown-in R-38 attic insulation per sqft of coverage' },
  // Drywall & paint
  { key: 'drywall_sheet', material: 'Drywall (1/2" 4x8)', unit: 'sheet', phase: 'Drywall & Paint', qty: (s) => s * 0.11, priceDesc: 'one 1/2" 4x8 drywall sheet' },
  { key: 'interior_paint_gal', material: 'Interior paint', unit: 'gallon', phase: 'Drywall & Paint', qty: (s) => s * 0.012, priceDesc: 'one gallon of interior wall paint' },
  // Interior finishes
  { key: 'flooring_sqft', material: 'Flooring (LVP / carpet mix)', unit: 'sqft', phase: 'Interior Finishes', qty: (s) => s * 1.0, priceDesc: 'mid-grade flooring per sqft (luxury vinyl plank / carpet)' },
  { key: 'interior_doors_ea', material: 'Interior doors', unit: 'each', phase: 'Interior Finishes', qty: (s) => Math.max(6, Math.round(s / 220)), priceDesc: 'one prehung interior door' },
  { key: 'trim_lf', material: 'Trim & baseboard', unit: 'linear ft', phase: 'Interior Finishes', qty: (s) => s * 0.9, priceDesc: 'baseboard/trim molding per linear foot' },
  { key: 'cabinets_lf', material: 'Kitchen & bath cabinets', unit: 'linear ft', phase: 'Interior Finishes', qty: (s) => Math.max(15, Math.round(s * 0.012)), priceDesc: 'stock cabinets per linear foot (installed run)' },
  { key: 'countertop_sqft', material: 'Countertops', unit: 'sqft', phase: 'Interior Finishes', qty: (s) => Math.max(40, Math.round(s * 0.03)), priceDesc: 'countertop per sqft (granite/quartz mid-grade)' },
  // Mechanical
  { key: 'hvac_ton', material: 'HVAC equipment (heat pump)', unit: 'ton', phase: 'Mechanical', qty: (s) => Math.max(2, Math.ceil(s / 600)), priceDesc: 'central heat-pump/AC equipment per ton of capacity' },
  { key: 'water_heater_ea', material: 'Water heater', unit: 'each', phase: 'Mechanical', qty: (s) => (s > 2600 ? 2 : 1), priceDesc: 'one 50-gal water heater' },
  { key: 'electrical_wire_ft', material: 'Electrical wire (romex)', unit: 'ft', phase: 'Mechanical', qty: (s) => s * 1.0, priceDesc: 'NM-B (romex) wire per foot (12/2 average)' },
  { key: 'plumbing_pipe_ft', material: 'Plumbing pipe (PEX)', unit: 'ft', phase: 'Mechanical', qty: (s) => s * 0.5, priceDesc: 'PEX water-supply pipe per foot' },
  { key: 'plumbing_fixtures_set', material: 'Plumbing fixtures (per bath)', unit: 'bath set', phase: 'Mechanical', qty: (s) => Math.max(2, Math.round(s / 900)), priceDesc: 'one bathroom fixture set (toilet + sink/vanity + tub/shower)' },
];

/**
 * LOCAL MATERIAL TAKEOFF (the GIS + pricing blueprint): parcel ZIP → material
 * QUANTITY (building size × the whole-house recipe) × current LOCAL unit price =
 * material cost — every major material to build the house, phase by phase.
 * Direct big-box scraping (Home Depot/Lowe's) is Akamai-blocked from a server,
 * so the local unit prices are sourced via Gemini + Google Search for the
 * parcel's ZIP. Returns a transparent quantity × unit-price line per material.
 * Null on failure; never invents prices (cites sources).
 */
export async function fetchMaterialTakeoff(reportData: SiteFeasibilityData): Promise<MaterialTakeoff | null> {
  const geminiKey = getBackgroundGeminiKey(); // second key when configured — own quota lane
  if (!geminiKey) return null;

  const zip = (String(reportData.inputAddress || "").match(/\b(\d{5})(?:-\d{4})?\b/) || [])[1] || "";
  const sqfts = (reportData.comps || []).map((c) => c.sqft).filter((n): n is number => !!n && n > 0).sort((a, b) => a - b);
  const plannedSqft = sqfts.length ? Math.round(sqfts[Math.floor(sqfts.length / 2)] / 50) * 50 : 1600;
  const locality = zip ? `ZIP ${zip} (${countyDisplayName(reportData.countyName)})` : countyDisplayName(reportData.countyName);

  const priceLines = MATERIAL_RECIPE.map((r) => `- ${r.key}: ${r.priceDesc}`).join('\n');
  const keysJson = `{ ${MATERIAL_RECIPE.map((r) => `"${r.key}": 0`).join(', ')} }`;
  const prompt = `Find the CURRENT LOCAL retail UNIT prices to build a house — every material below — at the building suppliers nearest to ${locality} (the local Home Depot / Lowe's / building-supply yard / contractor supplier for that ZIP).
Return ONLY a JSON object inside a \`\`\`json code block:
\`\`\`json
{ "unitPrices": ${keysJson}, "sources": ["https://..."] }
\`\`\`
Each value is the current LOCAL price in USD for that ZIP:
${priceLines}
Use CURRENT LOCAL prices from credible sources; cite them; never invent a price (set a key to 0 / omit it if you cannot find it).`;

  try {
    const yr = new Date().getFullYear();
    const near = zip ? `${zip} NC` : `${reportData.countyName} County NC`;
    const text = await groundedGeminiText(
      geminiKey,
      prompt,
      "You are a construction-material pricing assistant. Use the live web search results to find CURRENT LOCAL retail unit prices near the given ZIP for a full house build. Return only the JSON; cite sources; never invent prices.",
      110000,
      // Parallel batched Perplexity searches — local supplier price sources.
      [
        `framing lumber 2x4 2x10 OSB sheathing prices ${near} ${yr}`,
        `ready mix concrete price per cubic yard ${near}`,
        `drywall insulation shingle prices Home Depot Lowes ${near}`,
        `windows exterior doors prices ${near} ${yr}`,
        `siding roofing material prices ${near}`,
        `kitchen cabinets countertops flooring material prices ${near} ${yr}`,
        `PEX plumbing HVAC unit electrical wire prices ${near}`,
      ],
    );
    if (!text) return null;
    const m = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const obj = JSON.parse((m[1] || m[0]).replace(/,\s*([}\]])/g, "$1"));
    const up = obj.unitPrices || {};

    const items: MaterialTakeoffItem[] = [];
    for (const r of MATERIAL_RECIPE) {
      const unitPrice = Number(up[r.key]);
      if (!Number.isFinite(unitPrice) || unitPrice <= 0) continue;
      const rawQty = r.qty(plannedSqft);
      const quantity = rawQty >= 50 ? Math.round(rawQty) : Math.round(rawQty * 10) / 10;
      items.push({
        material: r.material, unit: r.unit, quantity,
        unitPrice: Math.round(unitPrice * 100) / 100,
        cost: Math.round(quantity * unitPrice),
        phase: r.phase,
      });
    }
    if (items.length < 5) return null;

    return {
      zip,
      locality,
      plannedSqft,
      items,
      materialTotal: items.reduce((s, i) => s + i.cost, 0),
      sources: Array.isArray(obj.sources) ? obj.sources.map((s: any) => String(s)).filter((s: string) => /^https?:\/\//.test(s)).slice(0, 8) : [],
      generatedAt: Date.now(),
    };
  } catch (e) {
    console.warn("Material takeoff failed:", e);
    return null;
  }
}

// ===========================================================================
// Land-clearing estimate by TREE COUNT × real-time per-tree removal cost. Gemini
// Vision counts the trees (by size) on a top-down satellite crop; current LOCAL
// per-tree rates come from a grounded Google Search. A per-acre bulk figure is
// kept for comparison on large forested tracts.
// ===========================================================================

// Fallback per-tree rates (Southeast US, used only if the live lookup fails).
const TREE_RATE_FALLBACK = { small: 350, medium: 800, large: 1500, stumpGrind: 175 };

/** Static-map zoom that frames a parcel of the given acreage roughly full-bleed. */
function landZoomForAcres(acres: number): number {
  if (acres <= 0.3) return 19;
  if (acres <= 0.75) return 18;
  if (acres <= 2) return 18;
  if (acres <= 6) return 17;
  if (acres <= 15) return 16;
  if (acres <= 45) return 15;
  if (acres <= 120) return 14;
  return 13;
}

/** Returns a Street View Static URL for the point when imagery exists there. */
async function streetViewUrlIfAvailable(lat: number, lng: number, key: string): Promise<string | null> {
  try {
    const meta = await fetchWithTimeout(`https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lng}&key=${key}`, 6000);
    if (!meta.ok) return null;
    const j = await meta.json();
    if (j && j.status === 'OK') {
      return `https://maps.googleapis.com/maps/api/streetview?size=640x640&location=${lat},${lng}&fov=80&pitch=8&key=${key}`;
    }
  } catch { /* ignore */ }
  return null;
}

/** Gemini Vision: count trees by size + canopy/density from a top-down satellite
 *  crop PLUS (when available) a ground-level street-view to gauge tree size. */
async function countTreesFromSatellite(imageUrls: string[], acres: number, geminiKey: string): Promise<{ small: number; medium: number; large: number; canopyPct: number | null; density: 'light' | 'medium' | 'heavy' } | null> {
  const imgs = (await Promise.all(imageUrls.map((u) => imageUrlToInline(u)))).filter((x): x is { mimeType: string; data: string } => !!x);
  if (!imgs.length) throw new Error('Couldn\'t load the parcel satellite image (Google Static Maps) — check that the Google Maps key has Static Maps enabled with billing, then tap Retry.');
  const multi = imgs.length > 1;
  const prompt = `You are estimating TREE REMOVAL for a ~${acres.toFixed(2)}-acre raw land parcel.
${multi ? 'The FIRST image is a top-down SATELLITE view — use it to COUNT the trees and read canopy. The SECOND image is a ground-level STREET VIEW — use it to gauge tree SIZE/maturity and species.' : 'This is a top-down SATELLITE view of the parcel — count the trees and read canopy.'}
Estimate how many TREES would need removal to develop/build on it, by canopy size:
- "small": young/small trees, canopy under ~25 ft wide
- "medium": mature trees, canopy ~25-45 ft
- "large": big mature trees, canopy over ~45 ft
For dense continuous forest, ESTIMATE counts from typical spacing (~80-150 trees/acre) — do NOT return 0 when there is clearly tree canopy. Also give total tree-canopy cover % and overall density.
Return ONLY JSON: {"small":<int>,"medium":<int>,"large":<int>,"canopyCoverPct":<0-100>,"density":"light|medium|heavy"}`;
  const parts: any[] = [{ text: prompt }];
  imgs.forEach((img) => parts.push({ inline_data: { mime_type: img.mimeType, data: img.data } }));
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${geminiKey}`;
  // maxOutputTokens must be LARGE: on thinking models the internal reasoning
  // tokens count against this budget — 800 made every answer stop at
  // MAX_TOKENS mid-JSON ("the satellite tree count didn't answer").
  const body = JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature: 0, responseMimeType: 'application/json', maxOutputTokens: 8192 } });
  // 4 attempts with real backoff. The tree count fires alongside the cost
  // estimate, takeoff, utilities and report generation — all on the same
  // Gemini key — so a free-tier per-minute rate limit (429) is the most common
  // failure. Waiting through the rate window (rather than three quick retries
  // inside it) is what makes the card reliably appear like it used to.
  const LAST = 3;
  for (let attempt = 0; attempt <= LAST; attempt++) {
    try {
      const res = await queueGemini(() => fetchWithTimeout(url, 45000, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }), 'low', 'background');
      if (!res.ok) {
        if (attempt < LAST && res.status === 429) { await new Promise((r) => setTimeout(r, [8000, 16000, 28000][attempt])); continue; }
        if (attempt < LAST && res.status >= 500) { await new Promise((r) => setTimeout(r, 2500 * (attempt + 1))); continue; }
        // Second key rejected (invalid / API not enabled) → primary key fallback.
        {
          const primary = (getUserKeys().gemini || '').trim();
          if ((res.status === 400 || res.status === 401 || res.status === 403) && primary && geminiKey !== primary) {
            console.warn(`Gemini key #2 was rejected (HTTP ${res.status}) — running the tree count on the primary key instead.`);
            return countTreesFromSatellite(imageUrls, acres, primary);
          }
        }
        return null;
      }
      const data = await res.json();
      const t = data.candidates?.[0]?.content?.parts?.map((p: any) => p.text).filter(Boolean).join('') || '';
      const m = t.match(/```json\s*([\s\S]*?)\s*```/) || t.match(/\{[\s\S]*\}/);
      if (!m) {
        if (attempt < LAST) { await new Promise((r) => setTimeout(r, 1500)); continue; } // odd answer — retry
        return null;
      }
      const o = JSON.parse((m[1] || m[0]).replace(/,\s*([}\]])/g, '$1'));
      const n = (v: any) => Math.max(0, Math.round(Number(v) || 0));
      const d = String(o.density || '').toLowerCase();
      const density = (d === 'light' || d === 'heavy') ? d : 'medium';
      const c = Number(o.canopyCoverPct);
      return { small: n(o.small), medium: n(o.medium), large: n(o.large), canopyPct: Number.isFinite(c) ? Math.max(0, Math.min(100, Math.round(c))) : null, density };
    } catch {
      // network error or per-attempt timeout abort — retry
      if (attempt < LAST) { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); continue; }
      return null;
    }
  }
  return null;
}

interface TreeRates {
  small: number; medium: number; large: number; stumpGrind: number;
  mulchPerAcre: number; mulchDayRate: number;
  clearingPerAcre: number; clearingDayRate: number;
  haulOff: number;
  sources: string[];
}

/** Grounded Google Search for CURRENT LOCAL per-tree removal rates AND bulk
 *  clearing method rates (forestry mulching + traditional excavator clearing,
 *  per-acre + day-rate minimums + haul-off). */
async function fetchTreeRemovalRates(county: string, zip: string, geminiKey: string): Promise<TreeRates | null> {
  const state = countyState(county);
  const stateFull = state === 'SC' ? 'South Carolina' : 'North Carolina';
  const stateLower = state.toLowerCase();
  const stateFullLower = stateFull.toLowerCase().replace(/\s+/g, '');
  const baseCounty = countyBaseName(county);

  const locality = zip ? `ZIP ${zip} (${baseCounty} County, ${state})` : `${baseCounty} County, ${state}`;
  const prompt = `Find CURRENT LOCAL land-clearing prices near ${locality} (${new Date().getFullYear()}).
Return ONLY a JSON object in a \`\`\`json code block:
\`\`\`json
{ "small": 0, "medium": 0, "large": 0, "stumpGrind": 0, "mulchPerAcre": 0, "mulchDayRate": 0, "clearingPerAcre": 0, "clearingDayRate": 0, "haulOff": 0, "sources": ["https://..."] }
\`\`\`
- small/medium/large = remove ONE tree (<30ft / 30-60ft / 60-80+ft)
- stumpGrind = grind one stump
- mulchPerAcre = forestry MULCHING per acre; mulchDayRate = forestry mulcher day rate (1-day minimum)
- clearingPerAcre = TRADITIONAL excavator land clearing per acre (trees pulled by roots, debris removed); clearingDayRate = excavator crew day rate
- haulOff = typical debris haul-off / dump fee for a small lot
Use CURRENT LOCAL prices from credible tree-service / land-clearing / excavation sources; cite them; never invent (set unknown values to 0).`;
  const zipStr = zip ? `${zip} ` : '';
  const diag: { perplexityAttempted: boolean; perplexitySources: number; perplexityUrls?: string[] } = { perplexityAttempted: false, perplexitySources: 0 };
  const text = await groundedGeminiText(
    geminiKey,
    prompt,
    'You are a land-clearing / tree-service pricing assistant. Use the live web search results for current local prices. Return only the JSON; cite sources; never invent prices.',
    60000,
    // Parallel batched Perplexity searches — kept LOCAL to this county so the
    // cited sources are relevant to the address, not national averages.
    [
      `tree removal cost ${zipStr}${baseCounty} County ${state} ${new Date().getFullYear()}`,
      `stump grinding cost ${zip ? `${zip} ${state}` : `${baseCounty} County ${state}`}`,
      `forestry mulching cost per acre ${baseCounty} County ${state}`,
      `land clearing cost per acre ${baseCounty} County ${state}`,
      `excavator land clearing day rate debris haul off ${baseCounty} County ${state}`,
    ],
    diag,
  );
  if (!text) return null;
  const m = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse((m[1] || m[0]).replace(/,\s*([}\\]])/g, '$1'));
    const num = (v: any) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : 0; };
    const small = num(o.small), medium = num(o.medium), large = num(o.large);
    if (!small && !medium && !large) return null;
    const modelSources = Array.isArray(o.sources) ? o.sources.map((s: any) => String(s)) : [];
    const sources = filterLocalSources([...modelSources, ...(diag.perplexityUrls || [])], [baseCounty, `${baseCounty.toLowerCase()}county`, stateFullLower, stateLower]);
    return {
      small: small || TREE_RATE_FALLBACK.small,
      medium: medium || TREE_RATE_FALLBACK.medium,
      large: large || TREE_RATE_FALLBACK.large,
      stumpGrind: num(o.stumpGrind) || TREE_RATE_FALLBACK.stumpGrind,
      mulchPerAcre: num(o.mulchPerAcre),
      mulchDayRate: num(o.mulchDayRate),
      clearingPerAcre: num(o.clearingPerAcre),
      clearingDayRate: num(o.clearingDayRate),
      haulOff: num(o.haulOff),
      sources: sources.slice(0, 6),
    };
  } catch { return null; }
}

// Fallback method rates (Southeast US) when the live lookup omits them.
const CLEARING_FALLBACK = { mulchPerAcre: 2200, mulchDayRate: 2500, clearingPerAcre: 4500, clearingDayRate: 4000, haulOff: 600 };

/** Build the two bulk-clearing method options (forestry mulching vs. traditional
 *  excavator) with cost RANGES, applying day-rate minimums on small lots. */
function buildClearingMethods(acres: number, treeCount: number, largeCount: number, r: TreeRates): ClearingMethod[] {
  const mulchPerAcre = r.mulchPerAcre || CLEARING_FALLBACK.mulchPerAcre;
  const mulchDay = r.mulchDayRate || CLEARING_FALLBACK.mulchDayRate;
  const clearPerAcre = r.clearingPerAcre || CLEARING_FALLBACK.clearingPerAcre;
  const clearDay = r.clearingDayRate || CLEARING_FALLBACK.clearingDayRate;
  const haul = r.haulOff || CLEARING_FALLBACK.haulOff;

  // Forestry mulching: per-acre cost, floored by the 1–2 day machine minimum.
  const mulchAcreCost = acres * mulchPerAcre;
  const mulchLow = Math.round(Math.max(mulchAcreCost, mulchDay));
  const mulchHigh = Math.round(Math.max(mulchAcreCost * 1.6, mulchDay * 1.6));
  // Traditional: higher per-acre + crew day-rate floor; haul-off pushes the top.
  const clearAcreCost = acres * clearPerAcre;
  const clearLow = Math.round(Math.max(clearAcreCost, clearDay));
  const clearHigh = Math.round(Math.max(clearAcreCost * 1.6, clearDay * 1.75) + haul);

  const heavyHardwoods = largeCount >= Math.max(5, treeCount * 0.3);
  return [
    {
      method: 'Forestry Mulching',
      what: 'A drum/disc mulcher chews underbrush + small/medium trees to ground level, leaving a mulch layer. Stumps are left flush with the dirt.',
      low: mulchLow,
      high: mulchHigh,
      note: heavyHardwoods
        ? 'Best for brush + small/medium trees — the large hardwoods here may need an excavator instead. Stumps left in ground.'
        : 'Best for brush + small/medium trees. Stumps left flush (add grinding for a slab/utilities).',
    },
    {
      method: 'Traditional Land Clearing',
      what: 'An excavator pulls the trees out by the roots; debris is stacked, burned, or hauled away, leaving bare dirt — ready for a foundation.',
      low: clearLow,
      high: clearHigh,
      note: 'Best for building foundations — includes root extraction; haul-off/dump fees raise the top of the range.',
    },
  ];
}

/**
 * Land-clearing estimate by TREE COUNT × current local per-tree removal cost:
 * Gemini Vision counts the trees (by size) on a satellite crop, rates are pulled
 * live (grounded) for the parcel's county/ZIP, and the cost is count × rate +
 * stump grinding. Also returns a per-acre bulk-clearing figure for comparison.
 * Returns null when keys/coords/acres are missing or the count fails.
 */
export async function fetchLandClearingEstimate(reportData: SiteFeasibilityData): Promise<LandClearingEstimate | null> {
  const keys = getUserKeys();
  if (!keys.googleMaps || !keys.gemini) throw new Error('Add your Google Maps + Gemini API keys in Account Settings to run the tree/clearing estimate on this device.');
  const acres = Number(reportData.gisAcres);
  const lat = reportData.coordinates?.lat, lng = reportData.coordinates?.lng;
  if (!(acres > 0) || typeof lat !== 'number' || typeof lng !== 'number') throw new Error('The parcel\'s acreage or coordinates are unavailable, so the satellite tree count can\'t run for this address.');

  const zoom = landZoomForAcres(acres);
  const satelliteUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=${zoom}&size=600x600&scale=2&maptype=satellite&key=${keys.googleMaps}`;
  const zip = (String(reportData.inputAddress || '').match(/\b(\d{5})(?:-\d{4})?\b/) || [])[1] || '';
  const state = countyState(reportData.countyName || '');
  const baseCounty = countyBaseName(reportData.countyName || '');
  const locality = zip ? `ZIP ${zip} · ${baseCounty} County, ${state}` : `${baseCounty} County, ${state}`;

  // Add a ground-level street view (when available) so the AI can judge tree size.
  const streetViewUrl = await streetViewUrlIfAvailable(lat, lng, keys.googleMaps);
  const imageUrls = streetViewUrl ? [satelliteUrl, streetViewUrl] : [satelliteUrl];

  // Vision + rates pull SIMULTANEOUSLY. Rates are non-fatal (baseline rates
  // cover a miss); the vision call's DISTINCT errors (e.g. the static-map
  // image failed to load) propagate to the card.
  const ratesPromise = fetchTreeRemovalRates(reportData.countyName, zip, getBackgroundGeminiKey()).catch(() => null);
  const vision = await countTreesFromSatellite(imageUrls, acres, getBackgroundGeminiKey());
  if (!vision) throw new Error('The satellite tree count didn\'t answer (a slow or rate-limited moment) — tap Retry.');
  const rates = await ratesPromise;

  const r: TreeRates = rates || { ...TREE_RATE_FALLBACK, mulchPerAcre: 0, mulchDayRate: 0, clearingPerAcre: 0, clearingDayRate: 0, haulOff: 0, sources: [] as string[] };
  const sizes = ['small', 'medium', 'large'] as const;
  const trees: TreeRemovalLine[] = sizes
    .map((size) => ({ size, count: vision[size], unitCost: r[size], cost: Math.round(vision[size] * r[size]) }))
    .filter((t) => t.count > 0);
  const treeCount = vision.small + vision.medium + vision.large;
  const treeRemovalCost = trees.reduce((s, t) => s + t.cost, 0);
  const stumpGrindCost = Math.round(treeCount * r.stumpGrind);

  // Bulk machine-clearing METHODS (forestry mulching vs. traditional excavator),
  // each with a real-time cost range; plus the key cost-driving factors.
  const clearingMethods = buildClearingMethods(acres, treeCount, vision.large, r);
  const haul = r.haulOff || CLEARING_FALLBACK.haulOff;
  const clearingFactors = [
    vision.large >= Math.max(5, treeCount * 0.3)
      ? `Tree diameter: ~${vision.large} large/mature trees (>12 in) — too big for a mulcher, so an excavator + chainsaw crew is needed, pushing cost toward the high end.`
      : `Tree diameter: mostly small/medium trees — a forestry mulcher can clear these quickly (often a 1-day job).`,
    `Stump management: mulching leaves the root balls in the ground. For a slab/utilities, add stump grinding (~$${r.stumpGrind.toLocaleString()}/stump × ${treeCount.toLocaleString()} ≈ $${stumpGrindCost.toLocaleString()}).`,
    `Haul-off: leaving mulch on-site is cheapest; hauling the debris off adds roughly $${haul.toLocaleString()}+ in dump fees & fuel.`,
  ];

  return {
    acres: Math.round(acres * 100) / 100,
    canopyCoverPct: vision.canopyPct,
    density: vision.density,
    treeCount,
    trees,
    treeRemovalCost,
    stumpGrindUnit: r.stumpGrind,
    stumpGrindCost,
    total: treeRemovalCost + stumpGrindCost,
    clearingMethods,
    clearingFactors,
    satelliteUrl,
    streetViewUrl: streetViewUrl || undefined,
    locality,
    pricingSources: r.sources,
    realTimePricing: !!rates,
    generatedAt: Date.now(),
  };
}

/**
 * Utilities + connection-cost estimate: whether PUBLIC water/sewer serve the
 * parcel and their tap/impact fees, otherwise the real-time LOCAL cost of the
 * private alternative (well / septic). Grounded on Google Search. REAL PRICES
 * ONLY: a line gets a dollar figure only when the live search found it in a
 * citable local source — there are NO baseline/fallback numbers and no guesses.
 * Returns null only when keys/address are missing.
 */
// Typical current NC ranges used ONLY as a labeled fallback so a price always
// shows when the live local lookup can't verify an exact figure.
const UTIL_ESTIMATE = {
  waterTap: [1500, 6000] as [number, number],
  sewerTap: [3000, 9000] as [number, number],
  well: [6000, 15000] as [number, number],
  septic: [8000, 20000] as [number, number],
  zoningPermit: [50, 150] as [number, number],
  drivewayPermit: [50, 150] as [number, number],
  buildingPermits: [1500, 4000] as [number, number],
};

// National cost-aggregator / average-price sites — never address-specific, so
// they're the "irrelevant to the address" sources to drop from local pricing.
const NATIONAL_AGGREGATORS = [
  'homeadvisor', 'angi.', 'angieslist', 'thumbtack', 'homeguide', 'fixr.com', 'homewyse',
  'lawnstarter', 'lawnlove', 'bobvila', 'forbes.com', 'thisoldhouse', 'rocketmortgage',
  'bankrate', 'nerdwallet', 'yelp.com', 'porch.com', 'manta.com', 'buildzoom', 'houzz.com',
  'realtor.com', 'zillow.com', 'redfin.com', 'wikipedia.org', 'reddit.com', 'quora.com',
];

/**
 * Keep only source URLs RELEVANT to the searched locality. ALWAYS drops national
 * cost-aggregator sites (national averages, not address-specific). Then ranks the
 * rest so official (.gov/.us) and locality-matching (city/county/NC) sources come
 * first, followed by any remaining local contractor pages. Never returns empty
 * unless the input was.
 */
function filterLocalSources(urls: string[], tokens: string[]): string[] {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const toks = tokens.map(norm).filter((t) => t.length >= 3);
  const primary: string[] = [];   // strictly locality-matching or verifiably relevant
  const seen = new Set<string>();
  for (const raw of urls) {
    const u = String(raw);
    if (!/^https?:\/\//i.test(u)) continue;
    let host = '', path = '';
    try { const p = new URL(u); host = p.hostname.toLowerCase(); path = p.pathname; } catch { host = u.toLowerCase(); }
    const key = host + path;
    if (seen.has(key)) continue;
    if (NATIONAL_AGGREGATORS.some((a) => host.includes(a))) continue; // drop national averages
    seen.add(key);
    const hay = norm(host + path);
    // STRICT RELEVANCE RULE: The URL host or path must explicitly match one of our local/provider tokens
    if (toks.some((t) => hay.includes(t))) {
      primary.push(u);
    }
  }
  return primary.slice(0, 12);
}

export async function fetchUtilitiesEstimate(reportData: SiteFeasibilityData): Promise<UtilitiesEstimate | null> {
  const deepSeekKey = getDeepSeekKey();
  const geminiKey = getBackgroundGeminiKey();
  if (!deepSeekKey && !geminiKey) {
    throw new Error('Add your Gemini or DeepSeek API key in Account Settings to run the utilities & fees lookup on this device.');
  }
  const county = reportData.countyName || '';
  const state = countyState(county);
  const stateFull = state === 'SC' ? 'South Carolina' : 'North Carolina';
  const baseCounty = countyBaseName(county);
  const zip = (String(reportData.inputAddress || '').match(/\b(\d{5})(?:-\d{4})?\b/) || [])[1] || '';
  const locality = zip ? `${reportData.inputAddress} (ZIP ${zip}, ${baseCounty} County, ${state})` : `${reportData.inputAddress} (${baseCounty} County, ${state})`;

  // Look up the ACTUAL jurisdiction at the searched parcel's coordinates — the
  // strongest address-specific signal for public-utility availability.
  const lat = reportData.coordinates?.lat, lng = reportData.coordinates?.lng;
  const place = (typeof lat === 'number' && typeof lng === 'number') ? await incorporatedPlaceAtPoint(lat, lng) : null;
  const incorporated = !!place;
  const jurisdiction = incorporated
    ? `Inside the incorporated limits of ${place}, ${state}`
    : `Unincorporated ${baseCounty} County, ${state} (no municipal limits at this location)`;

  const prompt = `For the property at ${locality}, determine (A) whether the address is served by PUBLIC water and PUBLIC sewer, needs a private WELL / SEPTIC, or is a MIX of the two, and (B) the CURRENT LOCAL cost of each applicable connection as a SINGLE EXACT DOLLAR AMOUNT (not a range), for building a home (${new Date().getFullYear()}).
JURISDICTION AT THIS EXACT PARCEL (from the U.S. Census place boundaries): ${jurisdiction}.
${incorporated
    ? `Because this parcel is INSIDE ${place}'s municipal limits, public water & sewer are typically available — confirm each MAIN actually reaches this street/address, then find ${place}'s (or the county authority's) EXACT water and sewer tap/connection/impact fee.`
    : `Because this parcel is in UNINCORPORATED county land, public sewer is usually NOT available and often no public water either — treat it as private well + septic UNLESS you find evidence a public/community water or sewer main actually reaches this specific address/street. A MIX is common (e.g. a public water main on the road but a septic system for waste).`}
DETERMINE AVAILABILITY SEPARATELY for water and for sewer — a parcel can be public water + septic, well + public sewer, both public, or well + septic. Base each call on whether a main actually serves THIS address, not merely the city limits. Then give ONE EXACT COST for each applicable line:
1) PUBLIC/municipal WATER available at this address? If yes, the EXACT water tap / connection / impact fee for the STANDARD RESIDENTIAL SERVICE SIZE, with that size + fee-schedule name in waterTapDetail (e.g. "3/4-inch service — City of Kannapolis fee schedule"). These fees are fixed published amounts — give the exact figure, not a range.
2) PUBLIC/municipal SEWER available at this address? If yes, the EXACT sewer tap / connection / impact fee for the standard residential size, with the size + schedule name in sewerTapDetail.
3) If PUBLIC WATER is NOT available, the single MOST TYPICAL current LOCAL all-in cost to drill a private WELL (drilling + pump + connection) in this county.
4) If PUBLIC SEWER is NOT available, the single MOST TYPICAL current LOCAL all-in cost of a conventional SEPTIC system (perc/soil test + install) in this county.
5) The jurisdiction's CURRENT RESIDENTIAL PERMIT FEES from its adopted fee schedule: the flat residential ZONING permit fee, the flat DRIVEWAY permit fee (if it has one), and the typical TOTAL building + trade permits (building, electrical, plumbing, mechanical, inspections) for a NEW 1,400–1,800 sqft single-family home CALCULATED FROM the schedule's actual method (per-sqft or valuation-based). Note the calculation basis in permitNote.
Name the local water/sewer authority if known.
Return ONLY a JSON object in a \`\`\`json code block:
\`\`\`json
{ "publicWater": "available|not-available|unknown", "waterTap": 0, "waterTapDetail": "", "publicSewer": "available|not-available|unknown", "sewerTap": 0, "sewerTapDetail": "", "well": 0, "septic": 0, "zoningPermitFee": 0, "drivewayPermitFee": 0, "buildingPermitLow": 0, "buildingPermitHigh": 0, "permitNote": "", "provider": "", "sources": ["https://..."] }
\`\`\`
STRICT PRICING RULES — REAL FIGURES ONLY:
- Each cost is ONE EXACT DOLLAR AMOUNT, never a range. Public taps: the exact published fee for the standard residential size. Well & septic: the single most typical current LOCAL installed cost for this county.
- Every dollar figure MUST come from a page you actually found with Google Search: the utility authority's CURRENT published fee schedule / rate ordinance for tap-connection-impact fees, the jurisdiction's CURRENT adopted permit fee schedule, or named LOCAL well-drilling & septic contractors' current pricing for this county.
- List in "sources" EVERY distinct source URL you used across all the lines — aim for 6–12 different local sources (fee schedules, rate ordinances, contractor pages), not just one or two. A figure without a source URL is not allowed.
- If you cannot find a verifiable current local figure for a line, you MUST leave it 0. NEVER estimate, NEVER use national/regional averages, NEVER guess.`;
  const utilitiesSystem = `You are a site-development utilities and permit-fee analyst for ${stateFull} — any city, town, or county. Use web search to find the LOCAL water/sewer provider for the given jurisdiction, its CURRENT published tap/connection/impact fee schedule, the jurisdiction's CURRENT adopted residential permit fee schedule, and current local well & septic contractor pricing. Determine public-water and public-sewer availability SEPARATELY (a parcel may be public water + septic, well + public sewer, both, or neither) and report EACH cost as a single exact dollar amount. Return only the JSON. Every number must be traceable to a cited source URL; leave any unverifiable number 0 — never estimate or use regional averages.`;

  // Live searching on the Perplexity Search API (parallel batched queries →
  // many ranked fee-schedule sources), synthesis on Gemini/DeepSeek. Runs
  // IMMEDIATELY (no queue wait), in parallel with the tree count and the
  // other section lookups. The card's automatic retry covers a transient miss.
  const jur = place ? `${place} ${state}` : `${baseCounty} County ${state}`;
  const yr = new Date().getFullYear();
  const diag: { perplexityAttempted: boolean; perplexitySources: number; perplexityUrls?: string[] } = { perplexityAttempted: false, perplexitySources: 0 };

  const queries = [
    `"${reportData.inputAddress}" utilities public water sewer septic well`,
    `${reportData.inputAddress} water sewer well septic utilities`,
    `water sewer mains near ${reportData.inputAddress}`,
    `${jur} water sewer tap connection impact fee schedule ${yr}`,
    `${jur} water sewer authority residential connection fees`,
    `${jur} residential building permit fee schedule ${yr}`,
    `${jur} zoning permit driveway permit fee`,
    `well drilling cost ${baseCounty} County ${state} ${yr}`,
    `septic system installation cost perc test ${baseCounty} County ${state}`,
  ];

  let text: string | null = null;
  if (deepSeekKey) {
    text = await groundedDeepSeekText(prompt, utilitiesSystem, queries, diag);
  } else {
    text = await groundedGeminiText(geminiKey, prompt, utilitiesSystem, 90000, queries, diag);
  }

  // ALWAYS produce pricing. If the live search fails or answers oddly, fall back
  // to a fully-estimated result (availability from the jurisdiction, prices from
  // the typical-NC ranges) instead of erroring — the user asked to always see a
  // price. `o` stays {} so `resolve()` uses the jurisdiction and every line takes
  // its labeled estimate.
  let o: any = {};
  if (text) {
    const m = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/\{[\s\S]*\}/);
    if (m) { try { o = JSON.parse((m[1] || m[0]).replace(/,\s*([}\]])/g, '$1')); } catch { o = {}; } }
  }
  const num = (v: any) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : 0; };
  const norm = (v: any): 'available' | 'not-available' | 'unknown' => {
    const s = String(v || '').toLowerCase();
    if (s.startsWith('avail') || s === 'yes' || s === 'true') return 'available';
    if (s.includes('not') || s === 'no' || s === 'false' || s === 'unavailable') return 'not-available';
    return 'unknown';
  };
  // The AI's read, but when it's UNKNOWN fall back to the parcel's jurisdiction:
  // inside a municipality → assume public service; unincorporated → well/septic.
  const resolve = (v: any): 'available' | 'not-available' | 'unknown' => {
    const s = norm(v);
    return s !== 'unknown' ? s : (incorporated ? 'available' : 'not-available');
  };
  const publicWater = resolve(o.publicWater);
  const publicSewer = resolve(o.publicSewer);

  // REAL PRICES ONLY: a line is "verified" only when the grounded search
  // returned an actual figure. Each cost is now a SINGLE EXACT amount (low ===
  // high) — an exact published tap fee, or the single typical local well/septic
  // cost. Unverified lines carry NO dollar amount (no averages, no guesses). A
  // legacy low/high pair is tolerated and collapsed to one figure for resilience.
  const exact = (val: any, legacyLow?: any, legacyHigh?: any): { low: number; high: number; verified: boolean } => {
    let v = num(val);
    if (!v) { const lo = num(legacyLow), hi = num(legacyHigh); v = (lo && hi) ? Math.round((lo + hi) / 2) : (lo || hi); }
    if (!v) return { low: 0, high: 0, verified: false };
    return { low: v, high: v, verified: true };
  };

  const detailOf = (v: any) => { const s = String(v || '').trim(); return s ? s.slice(0, 120) : undefined; };
  // When no verified figure exists, ALWAYS still show a price using a typical NC
  // range, clearly labeled as an estimate (estimated:true) — never a blank line.
  const withFallback = (r: { low: number; high: number; verified: boolean }, range: [number, number]) =>
    r.verified ? r : { low: range[0], high: range[1], verified: false, estimated: true };

  const lines: UtilityLine[] = [];
  // WATER: public tap fee when served, else private well.
  if (publicWater === 'available') {
    const r = withFallback(exact(o.waterTap, o.waterTapLow, o.waterTapHigh), UTIL_ESTIMATE.waterTap);
    lines.push({ name: 'Public water tap fee', kind: 'water', isPublic: true, status: 'available', ...r, detail: detailOf(o.waterTapDetail), note: 'municipal water tap / connection / impact fee' });
  } else {
    const r = withFallback(exact(o.well, o.wellLow, o.wellHigh), UTIL_ESTIMATE.well);
    lines.push({ name: 'Private well', kind: 'water', isPublic: false, status: publicWater, ...r, note: 'drill + pump + connection (no public water)' });
  }
  // SEWER: public tap fee when served, else septic.
  if (publicSewer === 'available') {
    const r = withFallback(exact(o.sewerTap, o.sewerTapLow, o.sewerTapHigh), UTIL_ESTIMATE.sewerTap);
    lines.push({ name: 'Public sewer tap fee', kind: 'sewer', isPublic: true, status: 'available', ...r, detail: detailOf(o.sewerTapDetail), note: 'municipal sewer tap / connection / impact fee' });
  } else {
    const r = withFallback(exact(o.septic, o.septicLow, o.septicHigh), UTIL_ESTIMATE.septic);
    lines.push({ name: 'Septic system', kind: 'sewer', isPublic: false, status: publicSewer, ...r, note: 'perc/soil test + conventional system install (no public sewer)' });
  }

  // Residential permit fees from the jurisdiction's adopted fee schedule —
  // verified figures only, same no-guessing rule as the tap fees.
  const permits: PermitFeeLine[] = [];
  const zp = num(o.zoningPermitFee);
  permits.push(zp
    ? { name: 'Residential zoning permit', low: zp, high: zp, verified: true }
    : { name: 'Residential zoning permit', low: UTIL_ESTIMATE.zoningPermit[0], high: UTIL_ESTIMATE.zoningPermit[1], verified: false, estimated: true });
  const dp = num(o.drivewayPermitFee);
  permits.push(dp
    ? { name: 'Driveway permit', low: dp, high: dp, verified: true }
    : { name: 'Driveway permit', low: UTIL_ESTIMATE.drivewayPermit[0], high: UTIL_ESTIMATE.drivewayPermit[1], verified: false, estimated: true });
  const bl = num(o.buildingPermitLow), bh = num(o.buildingPermitHigh);
  permits.push((bl || bh)
    ? {
        name: 'Building + trade permits (new SFH, ~1,400–1,800 sqft)',
        low: bl || bh, high: Math.max(bl, bh),
        note: detailOf(o.permitNote) || 'calculated from square footage / construction valuation — exact amount depends on the plans',
        verified: true,
      }
    : {
        name: 'Building + trade permits (new SFH, ~1,400–1,800 sqft)',
        low: UTIL_ESTIMATE.buildingPermits[0], high: UTIL_ESTIMATE.buildingPermits[1],
        note: `typical ${state} total for building + electrical + plumbing + mechanical permits — confirm with the jurisdiction`,
        verified: false, estimated: true,
      });

  // Developer-prepaid caveat — tap fees on subdivision lots are often already
  // satisfied by the developer's infrastructure installation.
  const tapNote = (publicWater === 'available' || publicSewer === 'available')
    ? 'These tap fees are not necessarily still owed: if this lot is in a subdivision where the developer already installed and paid for the taps, the fees may be satisfied. Ask the utility whether taps were purchased for this lot before budgeting — it can change the development cost by thousands.'
    : undefined;

  const real = lines.some((l) => l.verified) || permits.some((p) => p.verified);
  // Totals sum every priced line (verified or estimated) so a total always shows.
  const totalLow = lines.reduce((s, l) => s + l.low, 0);
  const totalHigh = lines.reduce((s, l) => s + l.high, 0);
  const bothPublic = publicWater === 'available' && publicSewer === 'available';
  const neitherPublic = publicWater !== 'available' && publicSewer !== 'available';
  const summary = bothPublic
    ? 'Public water + sewer available — budget tap/impact fees.'
    : neitherPublic
      ? 'No public water/sewer — this parcel needs a private well + septic.'
      : `${publicWater === 'available' ? 'Public water' : 'Well'} + ${publicSewer === 'available' ? 'public sewer' : 'septic'} required.`;

  // Sources RELEVANT to this address only: filter strictly to domains/paths matching the city,
  // county, zip code, or specific local utility provider name (including regional acronyms like cfpua).
  const modelSources = Array.isArray(o.sources) ? o.sources.map((s: any) => String(s)) : [];
  const cityTok = (String(reportData.inputAddress || '').split(',')[1] || '').trim();
  
  const extraLocalTokens: string[] = [];
  const GENERIC_UTILITY_WORDS = new Set([
    'water', 'sewer', 'public', 'utility', 'authority', 'service', 'fee', 'schedule', 'standard',
    'tap', 'connection', 'residential', 'inch', 'rate', 'price', 'cost', 'estimate', 'estimated',
    'local', 'city', 'town', 'county', 'works', 'commission', 'department', 'system', 'district',
    'provider', 'billing', 'home', 'building', 'permit', 'zoning', 'driveway', 'development',
    'and', 'for', 'the', 'with', 'from'
  ]);
  const addExtraTokens = (text: string) => {
    if (!text) return;
    const words = text.split(/[^a-zA-Z0-9]+/).filter(w => w.length >= 2);
    for (const w of words) {
      const normalizedWord = w.toLowerCase();
      if (!GENERIC_UTILITY_WORDS.has(normalizedWord) && normalizedWord.length >= 3) {
        extraLocalTokens.push(w);
      }
    }
    if (words.length >= 3) {
      const acronym = words.map(w => w[0]).join('').toLowerCase();
      if (acronym.length >= 3 && !GENERIC_UTILITY_WORDS.has(acronym)) {
        extraLocalTokens.push(acronym);
      }
    }
  };
  if (o.provider) addExtraTokens(o.provider);
  if (o.waterTapDetail) addExtraTokens(o.waterTapDetail);
  if (o.sewerTapDetail) addExtraTokens(o.sewerTapDetail);

  const sources = filterLocalSources(
    [...modelSources, ...(diag.perplexityUrls || [])],
    [
      place || '',
      county,
      `${county}county`,
      cityTok,
      zip,
      ...extraLocalTokens
    ].filter(Boolean)
  );
  return {
    locality: zip ? `ZIP ${zip} - ${countyDisplayName(`${county}, ${state}`)}` : countyDisplayName(`${county}, ${state}`),
    jurisdiction, incorporated,
    publicWater, publicSewer, lines, totalLow, totalHigh, permits, tapNote, summary,
    provider: o.provider ? String(o.provider).slice(0, 120) : undefined,
    sources, realTime: real, generatedAt: Date.now(),
  };
}

export interface ChatSource {
  title: string;
  uri: string;
}

/** A file the user attached to a chat message (image, PDF, or text document). */
export interface ChatAttachment {
  name: string;
  mimeType: string;
  kind: 'image' | 'pdf' | 'text';
  /** base64 (no data: prefix) for image/pdf; the extracted text for kind 'text'.
   *  Omitted on messages loaded from history (only the preview is kept there). */
  data?: string;
  /** Small data-URL thumbnail for re-display (images only). */
  previewUrl?: string;
}

export interface ChatMessage {
  role: 'user' | 'model';
  content: string;
  sources?: ChatSource[];
  attachments?: ChatAttachment[];
}

// ---------------------------------------------------------------------------
// Fusion engine (mixture-of-agents): Gemini 3.5 Flash and DeepSeek V4 Pro
// answer the SAME prompt in PARALLEL, then Gemini 3.5 Flash acts as JUDGE and
// STREAMS the synthesized final answer. Falls back to single-model Gemini
// streaming when no DeepSeek key is configured or DeepSeek is unavailable.
// ---------------------------------------------------------------------------

/** Coarse mobile/tablet check — used to lighten the report workload on phones
 *  and tablets (fewer mid-draft web searches, shorter loops) for speed and to
 *  reduce the chance a flaky cellular link drops the long request. */
function isMobileDevice(): boolean {
  try {
    if (typeof navigator !== 'undefined') {
      const ua = navigator.userAgent || '';
      if (/Mobi|Android|iPhone|iPad|iPod|Tablet|Silk|Kindle|PlayBook/i.test(ua)) return true;
      // iPadOS 13+ masquerades as "Macintosh" with a desktop UA — distinguish a
      // real touch tablet by its touch points so tablets get the light path too.
      if (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1) return true;
    }
    if (typeof window !== 'undefined' && window.innerWidth <= 1024) return true;
  } catch { /* SSR / no DOM */ }
  return false;
}

/** Non-streaming Gemini call — used for the parallel draft. Returns text only. */
async function geminiGenerateText(url: string, body: any): Promise<string> {
  const res = await queueGemini(() => fetchWithTimeout(url, 90000, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), 'high');
  if (!res.ok) throw new Error(`Gemini API error: ${res.status}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.map((p: any) => p.text || '').join('') || '';
}

/** Non-streaming Gemini call that ALSO returns grounding sources — the robust
 *  fallback when an SSE stream drops (common on mobile): one request returns the
 *  whole report at once instead of a long-lived connection that can be killed. */
async function geminiGenerateWithSources(url: string, body: any): Promise<{ text: string; sources?: ChatSource[] }> {
  const res = await queueGemini(() => fetchWithTimeout(url, 120000, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), 'high');
  if (!res.ok) throw new Error(`Gemini API error: ${res.status}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p: any) => p.text || '').join('') || '';
  const seen = new Set<string>();
  const sources: ChatSource[] = [];
  for (const c of (data.candidates?.[0]?.groundingMetadata?.groundingChunks || [])) {
    const uri = c?.web?.uri;
    if (uri && !seen.has(uri)) { seen.add(uri); sources.push({ title: c.web.title || uri, uri }); }
  }
  return { text: text || 'No response generated.', sources: sources.length ? sources : undefined };
}

/** Streams a Gemini SSE response, invoking onToken per chunk; returns full text + sources. */
async function streamGeminiSSE(url: string, body: any, onToken?: (chunk: string) => void): Promise<{ text: string; sources?: ChatSource[] }> {
  // Gate only the request initiation (that's what rate limits count) — the gate
  // is released once the stream is open, so reading tokens doesn't block others.
  const res = await queueGemini(() => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), 'high');
  if (!res.ok || !res.body) {
    const detail = res.ok ? 'no response body' : `${res.status} - ${await res.text()}`;
    throw new Error(`Gemini API error: ${detail}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  const seen = new Set<string>();
  const sources: ChatSource[] = [];
  const handle = (obj: any) => {
    const t = obj?.candidates?.[0]?.content?.parts?.map((x: any) => x.text || '').join('') || '';
    if (t) { text += t; onToken?.(t); }
    const chunks = obj?.candidates?.[0]?.groundingMetadata?.groundingChunks;
    if (Array.isArray(chunks)) {
      for (const c of chunks) {
        const uri = c?.web?.uri;
        if (uri && !seen.has(uri)) { seen.add(uri); sources.push({ title: c.web.title || uri, uri }); }
      }
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try { handle(JSON.parse(payload)); } catch { /* JSON split across chunks — ignore */ }
    }
  }
  return { text: text || 'No response generated.', sources: sources.length ? sources : undefined };
}

/** One DeepSeek chat-completions POST with ONE retry on transient errors. Returns
 *  the parsed response message object (so callers can read content OR tool_calls),
 *  or null on missing key / repeated failure / timeout. */
async function postDeepSeekOnce(body: string, key: string): Promise<any | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchWithTimeout('https://api.deepseek.com/chat/completions', 90000, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body,
      });
      if (res.ok) {
        const data = await res.json();
        return data?.choices?.[0]?.message ?? null;
      }
      if ((res.status === 429 || res.status >= 500) && attempt === 0) {
        console.warn(`DeepSeek HTTP ${res.status} — retrying once...`);
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      console.warn(`DeepSeek HTTP ${res.status} — fusion will use Gemini only.`);
      return null;
    } catch (e) {
      if (attempt === 0) { console.warn('DeepSeek request error — retrying once:', e); await new Promise((r) => setTimeout(r, 1000)); continue; }
      console.warn('DeepSeek request failed — fusion will use Gemini only:', e);
      return null;
    }
  }
  return null;
}

/** Utilities-style grounded synthesis on DeepSeek instead of Gemini: Perplexity
 *  runs the live web search, DeepSeek V4 Pro synthesizes the strict JSON from
 *  those ranked sources. Mirrors groundedGeminiText's contract — returns the
 *  model text, or null on missing key / failure. `diag` records the Perplexity
 *  outcome so callers can tell a search miss from a synthesis miss. */
async function groundedDeepSeekText(prompt: string, systemText: string, searchQueries: string[], diag?: { perplexityAttempted: boolean; perplexitySources: number; perplexityUrls?: string[] }): Promise<string | null> {
  const key = getDeepSeekKey();
  if (!key) return null;
  let effectivePrompt = prompt;
  if (searchQueries && searchQueries.length && liveWebResearchConfigured()) {
    if (diag) diag.perplexityAttempted = true;
    // Pull a WIDE set of sources for the utilities lookup — more results per
    // query and a higher source cap so DeepSeek synthesizes from many fee
    // schedules / contractor pages, not one or two.
    const { block, urls } = await perplexityResearchBlock(searchQueries, { maxResultsPerQuery: 10, maxSources: 40, mode: 'hard' });
    if (diag) { diag.perplexitySources = urls.length; diag.perplexityUrls = urls; }
    if (block) effectivePrompt = prompt + block;
  }
  const body = JSON.stringify({
    model: 'deepseek-v4-pro',
    messages: [
      { role: 'system', content: systemText },
      { role: 'user', content: effectivePrompt },
    ],
    stream: false,
    thinking: { type: 'disabled' },
    temperature: 0.2,
    max_tokens: 4000,
  });
  const msg = await postDeepSeekOnce(body, key);
  const content = msg?.content;
  return (typeof content === 'string' && content.trim()) ? content : null;
}

/** A single live web search. PERPLEXITY MODE (key configured): raw ranked
 *  results with extracted content straight from the Search API — fast, no LLM
 *  in the loop. Fallback: Gemini's Google-Search grounding. This is what gives
 *  DeepSeek real web access inside the fusion. Never throws; returns a short
 *  status string on error. */
async function webSearchViaGemini(query: string, geminiKey: string): Promise<string> {
  if (perplexityConfigured()) {
    try {
      if (wantsCrawleeResearch([query])) {
        const { block } = await perplexityResearchBlock([query], { maxResultsPerQuery: 8, maxSources: 8 });
        if (block) return block;
      }
      const results = await perplexitySearchBatch([query], { maxResultsPerQuery: 8, maxTokensPerPage: 900 });
      if (results.length) {
        return results.slice(0, 8).map((r, i) => `[${i + 1}] ${r.title}${r.date ? ` (${r.date})` : ''} — ${r.snippet.slice(0, 700)}`).join('\n')
          + `\nSources: ${results.slice(0, 8).map((r) => r.url).join(' | ')}`;
      }
      return '(no results found)';
    } catch { /* fall through to grounding */ }
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${geminiKey}`;
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: `Search the live web and report the most CURRENT, specific facts for: "${query}". Give concrete numbers/dates and a source URL for each finding. Be concise — a few bullet lines, no preamble.` }] }],
    tools: [{ google_search: {} }],
  });
  // Retry transient rate-limit / server errors (the search burst can briefly trip
  // Gemini's per-minute grounding quota); never throw — the model reasons without
  // it on failure.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await queueGemini(() => fetchWithTimeout(url, 30000, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }), 'high');
      if (res.ok) {
        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.map((p: any) => p.text || '').join('') || '';
        const urls = (data.candidates?.[0]?.groundingMetadata?.groundingChunks || [])
          .map((c: any) => c?.web?.uri).filter(Boolean).slice(0, 5);
        return (text.trim() || '(no results found)') + (urls.length ? `\nSources: ${urls.join(' | ')}` : '');
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 2) { await new Promise((r) => setTimeout(r, 1200 * (attempt + 1))); continue; }
      return `(web search unavailable: HTTP ${res.status})`;
    } catch {
      if (attempt < 2) { await new Promise((r) => setTimeout(r, 1000)); continue; }
      return '(web search error)';
    }
  }
  return '(web search error)';
}

/** DeepSeek V4 Pro draft (OpenAI-compatible). When a Gemini key is supplied, DeepSeek
 *  is given a `web_search` TOOL (backed by Gemini grounding) so it can look up current
 *  facts mid-draft instead of guessing — bounded by hard round/search caps. Returns
 *  null on missing key / repeated failure / timeout (the fusion then uses Gemini only). */
async function fetchDeepSeekDraft(systemContent: string, userContent: string, key: string, geminiKey?: string, opts?: { maxRounds?: number; maxSearches?: number }): Promise<string | null> {
  if (!key) return null;

  // On phones/tablets, skip DeepSeek's own web searches entirely: they add extra
  // grounded fetches that compete with the report's Gemini calls over a cellular
  // link (a prime cause of "Load failed"). DeepSeek still drafts from the data
  // packet; desktop keeps the full live-search pass.
  const mobile = isMobileDevice();
  const webEnabled = !!geminiKey && !mobile;
  const tools = webEnabled ? [{
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the live web for CURRENT facts the static data packet does not contain — e.g. the current 30-year mortgage rate and its trend, local new-construction $/sqft and itemized costs near the address, market saturation (active inventory, days-on-market, months-of-supply) by product type, utilities/road access/schools, and recent local rezoning/subdivision cases. Returns a concise brief with source URLs.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'A focused search query.' } }, required: ['query'] },
    },
  }] : undefined;

  const messages: any[] = [
    { role: 'system', content: systemContent },
    { role: 'user', content: webEnabled ? `${userContent}\n\nYou have a web_search tool — USE IT to verify every figure that is not in the data packet (current mortgage rate, local construction costs, market inventory/DOM/months-of-supply by product type, utilities, recent rezoning cases) before stating it. Cite the source URLs it returns.` : userContent },
  ];

  // Desktop only (webEnabled is false on mobile): keep the grounding burst modest
  // so it doesn't starve the report's own Gemini calls.
  const MAX_ROUNDS = opts?.maxRounds ?? 4;
  const MAX_SEARCHES = opts?.maxSearches ?? 4;
  let searches = 0;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const body = JSON.stringify({
      model: 'deepseek-v4-pro',
      messages,
      ...(tools ? { tools, tool_choice: 'auto' } : {}),
      thinking: { type: 'disabled' }, // fast draft; the Gemini judge supplies the synthesis/reasoning
      stream: false,
      temperature: 0.4,
      max_tokens: 8000,
    });
    const msg = await postDeepSeekOnce(body, key);
    if (!msg) return null;

    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls.filter((t: any) => t?.function?.name === 'web_search') : [];
    if (webEnabled && toolCalls.length && searches < MAX_SEARCHES && round < MAX_ROUNDS - 1) {
      messages.push(msg); // assistant turn carrying the tool_calls
      // Run this round's searches in parallel, honoring the global cap.
      const results = await Promise.all(toolCalls.map(async (tc: any) => {
        if (searches >= MAX_SEARCHES) return { id: tc.id, content: '(search limit reached — answer from what you have)' };
        searches++;
        let q = '';
        try { q = JSON.parse(tc.function.arguments || '{}').query || ''; } catch { /* malformed args */ }
        const content = q ? await webSearchViaGemini(q, geminiKey!) : '(empty query)';
        return { id: tc.id, content };
      }));
      for (const r of results) messages.push({ role: 'tool', tool_call_id: r.id, content: r.content });
      continue; // let DeepSeek incorporate the results
    }

    // Final answer (no further tool calls, or caps reached).
    if (msg.content) return msg.content;
    // Edge case: caps hit while a tool call was pending — ask once more, tools off.
    const finalMsg = await postDeepSeekOnce(JSON.stringify({
      model: 'deepseek-v4-pro', messages, thinking: { type: 'disabled' }, stream: false, temperature: 0.4, max_tokens: 8000,
    }), key);
    return finalMsg?.content || null;
  }
  return null;
}

export async function chatWithGemini(
  messages: ChatMessage[],
  reportData: SiteFeasibilityData,
  onToken?: (chunk: string) => void
): Promise<{ text: string; sources?: ChatSource[] }> {

  const apiKey = getUserKeys().gemini || "";
  if (!apiKey) {
    throw new Error("Gemini API key is required. Please configure it in Account Settings.");
  }

  const systemPrompt = `
# AI Land Feasibility Report — Operating Standards

You operate as a senior land acquisition analyst, entitlement consultant, and residential development advisor. Your role is to investigate, verify, and deliver conclusions — not to behave like a conversational chatbot.

## Operating Principles
1. ACT, DON'T OVERPLAN. When sufficient information exists, perform the analysis now. Do not re-derive settled facts, repeat established conclusions, list options without a recommendation, or narrate your reasoning. Give the conclusion and move on.
2. LEAD WITH THE OUTCOME. Every major section must OPEN with the answer/finding (e.g. "The parcel appears suitable for a single-family residence.") and then give the supporting evidence.
3. GROUND EVERY CLAIM IN EVIDENCE. Only report findings supported by data gathered in the investigation. For each conclusion cite the source, explain the evidence, and label it:
   - **Verified** — supported by official records, GIS data, surveys, APIs, or market data.
   - **Likely** — strongly supported but not officially confirmed.
   - **Unknown** — insufficient evidence available.
   Never present assumptions as facts.
4. ASSESS BEFORE RECOMMENDING. Determine what is true, likely, and uncertain before recommending purchase, sale, development, or rezoning.
5. MATCH DEPTH TO RISK. Go deep on zoning, highest & best use, buildability, flood risk, environmental constraints, market valuation, and development economics. Be concise on basic demographics and routine, easily-verified facts.
6. FOCUS ON DEVELOPMENT FEASIBILITY. Every analysis must serve: Can it be built on? What can legally be built? What physical constraints exist? What approvals are required? What will development cost? What is the finished product worth? Is there sufficient margin? Minimize anything that does not.
7. USE THE REASON, NOT JUST THE REQUEST. Tie analysis to the development objective — why the property has value, what a builder cares about, what drives profit, what raises risk. If critical info is missing, identify it and explain its impact.
8. VERIFY BEFORE FINALIZING. Confirm address, parcel, jurisdiction, zoning, flood data, topography, utilities, comp criteria, and internal calculation consistency. List unresolved items separately.
9. DECIDE WHEN EVIDENCE SUPPORTS IT. Avoid excessive hedging and endless "possibilities." Instead of "may potentially be suitable depending on various factors," write "Available evidence supports development of one single-family residence, subject to septic approval."
10. DELIVER EXECUTIVE-LEVEL CONCLUSIONS. Write for land investors, builders, developers, private lenders, and acquisition managers — direct, evidence-based, financially focused.

## Evidence & Data Sources
- Treat the PROVIDED DATA PACKET (parcel/GIS, USGS 3DEP slope, FEMA flood zone, NWI wetlands, county zoning, verified SOLD comps, ownership/tax) as Verified evidence.
- For topics NOT in the packet — utilities, road access & frontage, schools, market trends, and comparable vacant-land sales — INVESTIGATE with live Google Search and cite the source; if still unconfirmed, label Likely or Unknown.
- FLOOD & WETLANDS: the packet carries the AUTHORITATIVE FEMA NFHL flood zone and USFWS NWI wetlands result, queried by the parcel's exact coordinate. USE those values verbatim and CITE the provided source links — do NOT guess or contradict them. Only when the packet marks flood or wetlands "unavailable"/"no-coverage" should you say so and direct verification to the FEMA/NWI source link, labeling the status Unknown rather than assuming the site is flood-free or wetland-free.
- HOA: determine whether the parcel is within a homeowners association; if so report the HOA name, dues, management company, any preferred/featured/approved BUILDER list, and the building requirements, architectural guidelines, and restrictions/covenants (CCRs) — only where publicly available, otherwise label Unknown.
- ZONING: state the ACTUAL zoning district code for this exact parcel (e.g. R-1, RA, C-2, PUD, MX). VERIFY the county-provided code against the official county/municipal zoning map, GIS parcel viewer, or ordinance via Google Search. If the provided code is "N/A" or unverified, look it up yourself from the official source and report the real code. NEVER write "See map", "see the zoning map", "varies", or similar — always give the specific district code; only if a genuine official-source search still cannot confirm it, label it Unknown and cite the county GIS link to check.
- CONSTRUCTION COST: be EXTREMELY ACCURATE and use CURRENT LOCAL costs for THIS address's metro/county found via Google Search across MULTIPLE sources near the address (not one source, never generic national averages), and ANCHOR to the itemized Construction Cost Reference Model below. Research and cite local figures for: per-sqft new single-family build cost; land/lot CLEARING and TREE removal ($/acre — heavier canopy costs more); GRADING/earthwork (more on sloped sites); foundation (crawlspace/slab/basement); WELL drilling ($/ft and typical total) and SEPTIC system install + perc test when no public water/sewer; public water/sewer TAP & impact fees when available; building permits and survey.
- Buildability from USGS 3DEP (1m) slope: under 15% = Buildable; 15-25% = Requires Special Engineering / increased cost; over 25% = Non-Buildable / high risk.

## Comparable Sales — use ONLY the verified comps provided
- The verified SOLD comps are supplied in the data packet. Use ONLY those exact homes. Never invent comps, never substitute older homes, never use vacant-land/raw-lot/active/pending listings, and never cite list prices or Zestimates.
- Criteria already applied to that set: closed within the last 12 months; new construction (built the current or previous year); single-family matching the subject's zoning use; within 1-5 driving miles (never beyond 5 unless too few sales exist); closest first.
- For EACH comp present: address, sale price, sale date, year built, living-area sqft, lot size (or "Unknown"), distance from subject, price/sqft, and one line on why it qualifies.
- If the provided comp list is EMPTY, say so plainly and base valuation on vacant-land sales (Google Search) plus the assessor reference; do not fabricate comps.

## Construction Cost Reference Model (itemized hard-cost baseline — localize every line)
Use this REAL, itemized new-construction budget as the BASELINE cost schedule for a ~1,600 sqft 3-bed/2-bath single-family home on a crawlspace foundation (total ≈ $250,000, ≈ $156/sqft, INCLUDING a $25,000 builder fee and a $3,500 contingency). Treat it as the STRUCTURE of the estimate, then ADJUST EACH LINE to CURRENT LOCAL prices for THIS address's market (Google Search, multiple sources) and SCALE to the planned home's size / the comps' typical sqft:
Clear/Grading $10,500 · Dumpster $3,650 · Survey/Plot plan $1,500 · Zoning & Building permits $14,500 · Tap Fees (water & septic) $12,500 · Crawlspace foundation $35,600 · Framing Package $20,500 · Framing Labor $10,800 · Roof Trusses & Floor Beams $7,400 · Windows $6,200 · Exterior Doors $2,800 · Siding (material+labor) $8,500 · Roof (labor+materials) $9,400 · Plumbing $12,500 · HVAC $7,400 · Electrical $7,450 · Fixtures $1,300 · Appliances $2,200 · Insulation $1,900 · Painting $3,100 · Sheetrock (labor+materials) $7,200 · Trim (labor+materials) $1,500 · Gutters $1,600 · Cabinets $4,200 · Countertops $8,700 · Cleaning $150 · Landscaping $1,250 · Floors $8,400 · Driveway & patio $8,800 · Contingency $3,500 · Builder Fee $25,000 → Total $250,000.
Present Section 20 (Development Cost Considerations) as an itemized TABLE mirroring this schedule with a LOCALIZED column (current local price + cited source) and a scaled TOTAL hard cost plus the resulting $/sqft. Always keep a builder fee and a 5–10% contingency.

## Developer Economics Standard (Sections 22 Land Valuation & 23 Builder/Developer Profitability)
Compute what a builder/developer would realistically PAY FOR THE LAND using a RESIDUAL LAND-VALUE pro-forma, and cross-check it against the lot-cost rule of thumb. Show every input and a pro-forma TABLE.
1. ARV (finished value): from the verified SOLD new-construction comps — median sale price and median $/sqft × the planned home's GLA (assume a typical new build matching the comps, e.g. ~1,600 sqft; state the assumption).
2. Total hard construction cost: from the localized Construction Cost Reference Model above, scaled to the planned GLA.
3. SITE-SPECIFIC cost ADDERS — research LOCAL prices near the address and ADD any that apply (these are exactly what REDUCES the land's value to a builder):
   - TREES / LOT CLEARING: if the parcel is wooded (USGS/imagery/Google), add land-clearing + tree-removal cost (local $/acre; heavier canopy = more). Deduct from land value.
   - STEEP SLOPE: if USGS 3DEP slope ≥15%, add extra grading/retaining/engineering cost (≥25% may be non-buildable). Deduct from land value.
   - WELL & SEPTIC: if no public water/sewer, add well drilling (local $/ft + total) and a septic system install + perc test (local cost). If public water/sewer exists, use tap/impact fees instead.
4. Soft & selling costs: permits/survey (already in the schedule) plus sales commission (~5–6% of ARV), closing, and construction-loan interest/carry as applicable.
5. DEVELOPER PROFIT — show THREE scenarios side by side: a little LESS than 20% of ARV (use 15%), EXACTLY 20% of ARV, and MORE than 20% of ARV (use 25%). State each profit dollar figure explicitly.
6. RESIDUAL LAND VALUE (what a builder would pay) = ARV − total hard construction − site-specific adders − soft/selling/financing − developer profit. Compute it for ALL THREE profit scenarios, yielding THREE land values in a single pro-forma TABLE with a column per scenario (15% / 20% / 25% profit). Note that a LOWER profit margin lets the builder pay MORE for the land, and a higher margin less.
7. CROSS-CHECK with the rule of thumb: builders typically pay ≈ 20% of ARV for a FINISHED lot. Start from 20% of ARV, then DEDUCT the site-specific adders (trees, slope, well/septic) to get an adjusted raw-land offer; reconcile this with the three residual figures and present a defensible RANGE (low/expected/high) that brackets them.
This residual land value is standard development feasibility ("what a builder would pay") — it is NOT a wholesale "maximum allowable offer"; do not use wholesaling/assignment terminology. Be EXTREMELY ACCURATE: every figure must trace to a cited current LOCAL source.

## Value-Add Opportunities Standard (Rezoning & Subdivision)
Actively assess whether a developer can unlock MORE value from the land than its current as-zoned use — this is often where the real upside is. Be specific and honest, never speculative:
- REZONING / UPZONING: compare the current zoning district to the FUTURE LAND USE / comprehensive-plan designation and to the zoning of ADJACENT parcels. Identify the highest-value district realistically attainable (e.g. single-family → townhome/attached, multifamily, or mixed-use), the units/density it unlocks, whether the comp plan and surrounding pattern SUPPORT approval, the jurisdiction's recent rezoning approval trend, the process/timeline/cost, the entitlement RISK, and the VALUE DELTA (as-zoned value vs. rezoned value, per door/unit or per buildable lot). If a rezoning is not supportable, say so plainly and do NOT invent upside.
- SUBDIVISION / LOT SPLIT: from the district's minimum lot size, frontage, and density plus the parcel's acreage/frontage/utilities, determine how many conforming buildable lots are realistic, the minor vs. major subdivision process, the likely infrastructure cost (road, utility extensions, stormwater), and the VALUE UPLIFT (sum of finished-lot values vs. whole-parcel value, net of cost). If it can't be split, say so and why.
Research current district standards, the comp plan/future-land-use map, and recent local rezoning cases via Google Search and cite sources. Carry any supportable upside into Highest-and-Best-Use and Land Valuation.

## Market Saturation, Absorption & Rate-Environment Standard
- SATURATION & ABSORPTION: be PRECISE and data-driven by PRODUCT TYPE — single-family detached, townhomes/attached, condos, and multifamily/rentals. For the area/ZIP, report current ACTIVE inventory, median DAYS ON MARKET (DOM), and MONTHS OF SUPPLY in a table (cite sources). Flag which product types are OVERSUPPLIED / sitting too long (slow absorption, buyer's market) vs. absorbing fast (low supply, seller's market), and recommend which product to BUILD and which to avoid here, with the numbers behind it. Never guess inventory/DOM without a cited source — mark Unknown if unavailable.
- INTEREST RATES: report the CURRENT 30-year mortgage rate and its recent trend — RISING / FALLING / STEADY — plus the Fed's posture (cite a current source). Explain in detail how that affects buyer demand, affordability, absorption pace, and exit timing, and give a brief SENSITIVITY read (what a rate move up vs. down does to demand and to the hold/sell decision).

## Land Valuation Standard
Derive land value from comparable vacant-land sales, builder lot demand, new-construction economics, market absorption, and highest-and-best-use — NOT solely county tax values or automated estimates. Reconcile it with the Developer Economics residual land value above, and reflect any supportable REZONING/SUBDIVISION upside and the current saturation/rate environment. Show the inputs and reasoning.

## Final Recommendation Standard
End with a clear recommendation stating: whether the property appears buildable, the most likely development strategy, the primary risks, the strongest value drivers, and an overall Feasibility Rating — **Excellent / Good / Moderate / Challenging / Poor**.

## Output Rules
- Produce the COMPLETE report in one response, following the required section structure given in the request. Do not stop to ask the user to confirm strategy or preferences.
- Lead each section with its conclusion. Use clean markdown: numbered section headers, bold key findings, tables for comps/calculations, concise bullets. No JSON, code blocks, map-layer/asset payloads, or "assistant mode" announcements.
- NO CODE OR RAW DATA: never use code blocks, backticks/inline code, JSON, variable-style text, or pseudo-code anywhere — not even for formulas. Write every formula and calculation in PLAIN ENGLISH or a clean markdown table showing the inputs and the result (e.g. "ARV of $400,000 minus construction of $250,000 minus a 20% profit of $80,000 leaves a land value of $70,000"). For multiplication use the word "times" or the × symbol and for division use ÷ — NEVER the asterisk (*) or slash for math. Do not use asterisks for emphasis; rely on the heading/table/bold formatting only.
- When linking a comp or address, use its provided verified listing URL if available; otherwise a Google Search URL (https://www.google.com/search?q=ADDRESS). NEVER fabricate a Realtor.com / Zillow / Redfin detail URL.
- Every dollar figure must trace to a shown input. Do not invent owner names, prices, dates, slopes, or zoning. This is a FEASIBILITY analysis — never include wholesaling, assignment-fee, "maximum allowable offer," or exit-strategy content.
- Do not finish until all required sections are completed or explicitly marked "Unknown — unverifiable due to lack of available evidence."

## Follow-up
After the report, answer follow-up questions conversationally from the stored context; use Google Search for niche municipal-code questions. Do not regenerate the full report unless asked.
`;

  // Authoritative flood (FEMA NFHL) & wetlands (USFWS NWI) lines for the packet.
  const fz = reportData.floodZone;
  const floodLine = !fz || fz.status === 'unavailable'
    ? 'FEMA NFHL did not return data at search time — VERIFY at the FEMA source before relying on flood status; do NOT assume the parcel is flood-free.'
    : fz.status === 'no-coverage'
      ? `No FEMA flood zone is mapped at this coordinate (unmapped or outside detailed study) — VERIFY via FEMA. Source: ${fz.sourceUrl}`
      : `Zone ${fz.zone}${fz.subtype ? ` (${fz.subtype})` : ''} — ${fz.inSFHA ? 'IN a Special Flood Hazard Area (high-risk 1% annual-chance floodplain; flood insurance typically required)' : 'NOT in a Special Flood Hazard Area (outside the 1% annual-chance floodplain)'}. Authoritative source (FEMA NFHL, queried by coordinate): ${fz.sourceUrl}`;
  const wl = reportData.wetlands;
  const wetlandsLine = !wl || wl.status === 'unavailable'
    ? 'USFWS NWI service was unavailable at search time — VERIFY at the NWI Wetlands Mapper before concluding; do NOT assume the parcel is wetland-free.'
    : wl.status === 'none-at-point'
      ? `No NWI-mapped wetlands intersect the parcel coordinate (NWI omits some small/forested wetlands; a field delineation is the legal authority). Source: ${wl.sourceUrl}`
      : `NWI-mapped wetlands present at/near the parcel: ${wl.types.join(', ') || 'classification unspecified'}. A jurisdictional delineation is required to confirm extent. Source: ${wl.sourceUrl}`;

  // Live market anchors for §17/§18. These three feeds are independent, so fetch
  // them IN PARALLEL (each cached) instead of one-after-another — shaves the
  // report's setup time with no change to the data used.
  const [mortgage, mkt, redfin] = await Promise.all([
    fetchCurrentMortgageRate().catch(() => null),
    fetchCountyMarketStats(reportData.countyName).catch(() => null),
    fetchRedfinCountyMarket(reportData.countyName).catch(() => null),
  ]);

  const mortgageLine = mortgage
    ? `30-Year Fixed Mortgage Rate: ${mortgage.rate.toFixed(2)}% as of ${mortgage.date} (Freddie Mac PMMS via FRED, series MORTGAGE30US). USE this as the live anchor for Section 18; confirm the recent rising/falling/steady TREND and the Fed posture via Google Search.`
    : `Live mortgage-rate feed unavailable at search time — research the CURRENT 30-year fixed mortgage rate and its trend via Google Search for Section 18, and cite the source.`;

  const trendOf = (m?: { value: number; prev3?: number | null; prevYear?: number | null } | null) => {
    if (!m || m.prev3 == null) return '';
    const dir = m.value > m.prev3 ? 'up' : m.value < m.prev3 ? 'down' : 'flat';
    const yoy = m.prevYear != null && m.prevYear !== 0 ? `, ${(((m.value - m.prevYear) / m.prevYear) * 100).toFixed(0)}% YoY` : '';
    return ` (${dir} vs 3mo ago${yoy})`;
  };
  // Prefer Redfin's per-product-type table (the real §17 anchor); fall back to
  // the FRED all-residential line when the county isn't in the digested JSON.
  const redfinTable = redfin ? buildRedfinSaturationTable(reportData.countyName, redfin) : '';
  const marketStatsLine = mkt
    ? `County housing market — ALL RESIDENTIAL (Realtor.com via FRED), ${reportData.countyName} County, as of ${mkt.medianDaysOnMarket?.date || mkt.activeListings?.date || 'recent'}: ` +
      [
        mkt.medianDaysOnMarket ? `median DAYS ON MARKET ${mkt.medianDaysOnMarket.value}${trendOf(mkt.medianDaysOnMarket)}` : '',
        mkt.activeListings ? `ACTIVE listings ${mkt.activeListings.value.toLocaleString()}${trendOf(mkt.activeListings)}` : '',
        mkt.newListings ? `NEW listings/mo ${mkt.newListings.value.toLocaleString()}` : '',
        mkt.medianListPrice ? `median LIST price $${mkt.medianListPrice.value.toLocaleString()}${trendOf(mkt.medianListPrice)}` : '',
      ].filter(Boolean).join('; ') +
      `. This is the COUNTY all-residential anchor — USE it in Section 17, then BREAK IT DOWN by PRODUCT TYPE (single-family / townhome / condo / multifamily) and tighter geography (ZIP/submarket) via Google Search, and derive months-of-supply. Source: FRED (Realtor.com), https://fred.stlouisfed.org/series/MEDDAYONMAR${mkt.fips}`
    : `No live county market feed available — research current ACTIVE inventory, median DAYS ON MARKET, and MONTHS OF SUPPLY by product type near this address via Google Search for Section 17, and cite sources.`;

  // Format report context
  const reportContext = `
## PROVIDED DATA PACKET — verified evidence to USE in the report (this is DATA, not the report's section layout)

### Subject & Buildability Summary
- Property Location: ${reportData.inputAddress}
- Target Price / Lot Size: $${reportData.priceSoldFor?.toLocaleString() || 'N/A'} / ${reportData.gisAcres?.toFixed(2) || 'N/A'} Acres
- Absolute Buildability Verdict: ${reportData.slopeProfile?.verdict || 'BUILDABLE'} based on USGS 3DEP (1-meter) elevation data.

### 2. USGS 3DEP Slope Profile (1-meter)
- Average Site Slope: ${reportData.slopeProfile?.avgSlope || 0}%
- Maximum Site Slope: ${reportData.slopeProfile?.maxSlope || 0}%
- Physical Feasibility Assessment: Average elevation is ${reportData.slopeProfile?.avgElevation || 0}m (Min: ${reportData.slopeProfile?.minElevation || 0}m, Max: ${reportData.slopeProfile?.maxElevation || 0}m). 

### 2.5 Flood Hazard & Wetlands (FEMA NFHL + USFWS NWI — authoritative, queried by the parcel coordinate. USE these values and cite the sources; only research further if marked unavailable)
- FEMA Flood Zone: ${floodLine}
- Wetlands: ${wetlandsLine}

### 2.6 Financing — Current Mortgage Rate (live anchor for Section 18)
- ${mortgageLine}

### 2.7 Market Saturation — County Housing by Product Type (live anchor for Section 17)
${redfinTable || `- ${marketStatsLine}`}

### 3. Zoning & Estimated Density Allowances
- Zoning Classification (from county GIS): ${reportData.zoningCode} (${reportData.zoningDescription})
- ESTIMATED Development Capacity (typical for the use category — must be confirmed against the local ordinance): Max Building Footprint: ${reportData.gridics?.maxBuildingFootprintSqft?.toLocaleString() || 'N/A'} SF, Max Height: ${reportData.gridics?.maxHeightFt || 'N/A'} ft, Floor Area Ratio (FAR): ${reportData.gridics?.floorAreaRatio || 'N/A'}
- Estimated Dimensional Setbacks: Front: ${reportData.gridics?.setbacks.frontFt || 0} ft | Rear: ${reportData.gridics?.setbacks.rearFt || 0} ft | Side: ${reportData.gridics?.setbacks.sideFt || 0} ft
- Estimated net buildable envelope: ${reportData.gridics?.netBuildableAreaSqft?.toLocaleString() || 'N/A'} SF

### 4. SOLD New-Construction Comps (built 2025–2026, zoning-use-matched, CLOSED sales only, no sqft limits, sold ≤12 months, within 5 driving miles, RealtyAPI: Realtor + Redfin + Zillow). Each comp lists its property type.
${reportData.comps && reportData.comps.length > 0
  ? reportData.comps.map((comp, idx) => `- Comp ${idx + 1}: ${comp.address} | ${comp.propertyType || 'Home'} | Built ${comp.yearBuilt ?? 'N/A'} | ${comp.sqft ? `${comp.sqft.toLocaleString()} sqft | ` : ''}Sold ${comp.saleDate || 'N/A'} for $${comp.price.toLocaleString()}${comp.pricePerSqft ? ` ($${comp.pricePerSqft}/sqft)` : ''} | ${comp.distanceMiles.toFixed(2)} mi driving${comp.straightLineMiles != null ? ` (${comp.straightLineMiles.toFixed(2)} mi straight-line)` : ''}${comp.drivingFallback ? ' [straight-line fallback]' : ''} | ${comp.verifiedNote || 'Public MLS (Google Search)'}${comp.priceDiscrepancy ? ` | discrepancy: ${comp.priceDiscrepancy}` : ''}`).join('\n')
  : "NONE FOUND: no new-construction (built 2025–2026) HOME sales matching the subject's zoning use closed within the last 12 months inside the 5-mile driving radius (RealtyAPI: Realtor, Redfin, Zillow). Do NOT substitute older homes, vacant-land, raw-lot, or unbuilt-pad sales. State plainly that no qualifying comps were available and note the county tax-assessor values as the only valuation reference."}

### 5. Ownership, Tax & Assessment Data (for report content — never output this as a JSON/asset payload)
- Center Coordinates: [${reportData.coordinates.lat}, ${reportData.coordinates.lng}]
- Parcel Owner (first name first): ${reportData.ownerName}
- Mailing Address: ${reportData.mailingAddress}
- Assessed Value: ${reportData.assessedPropertyValue ? `$${reportData.assessedPropertyValue.toLocaleString()}` : 'N/A — no assessed property value on record'}
- Land Value: ${reportData.landValue ? `$${reportData.landValue.toLocaleString()}` : 'N/A — no assessor land value on record'}
- Census Tract: ${reportData.censusTract}
- Tax Code Area: ${reportData.taxCodeArea}
- Tax Amount: $${reportData.taxAmount}
- Legal Description: ${reportData.legalDescription}
`;

  // PERPLEXITY MODE: a live research pack — parallel batched searches across
  // costs, market, rates, fees and rezoning for THIS county — replaces the
  // google_search grounding tool. Many ranked sources with extracted content.
  let researchUrls: string[] = [];
  let reportContextFull = reportContext;
  if (liveWebResearchConfigured()) {
    const county = reportData.countyName || 'North Carolina';
    const city = (String(reportData.inputAddress || '').split(',')[1] || '').trim() || county;
    const yr = new Date().getFullYear();
    const { block, urls } = await perplexityResearchBlock([
      `current 30 year mortgage rate trend`,
      `${county} County NC cost per square foot to build a house ${yr}`,
      `${city} NC housing market inventory months of supply days on market ${yr}`,
      `${county} County NC rezoning subdivision approvals ${yr}`,
      `${county} County NC water sewer tap fees well septic cost`,
      `${county} County NC residential building permit fees`,
      `residential lot land prices ${county} County NC ${yr}`,
      `${reportData.zoningCode ? `${reportData.zoningCode} zoning district ${county} County NC minimum lot size` : `${county} County NC zoning ordinance minimum lot size`}`,
    ], { maxResultsPerQuery: 5, maxSources: 30, mode: 'hard' }).catch(() => ({ block: '', urls: [] as string[] }));
    if (block) {
      reportContextFull = `${reportContext}\n### 6. LIVE WEB RESEARCH PACK${block}`;
      researchUrls = urls;
    }
  }
  const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
  const finish = (r: { text: string; sources?: ChatSource[] }): { text: string; sources?: ChatSource[] } =>
    (!r.sources || !r.sources.length) && researchUrls.length
      ? { ...r, sources: researchUrls.slice(0, 12).map((u) => ({ title: hostOf(u), uri: u })) }
      : r;

  const contents = [
    {
      role: 'user',
      parts: [
        {
          text: `You are starting a session. Here is the compiled Land Feasibility Report for context:\n\n${reportContextFull}\n\nUnderstood? Let the user know you have the report loaded and are ready to chat about this parcel.`
        }
      ]
    },
    {
      role: 'model',
      parts: [
        {
          text: `I have loaded the Land Feasibility Report for ${reportData.inputAddress} into my persistent memory state layer. I am ready to answer any questions about the zoning allowances, setbacks, USGS 3DEP slope profile, soil/grading impacts, or driving comps for this property.`
        }
      ]
    }
  ];

  for (const msg of messages) {
    contents.push({
      role: msg.role === 'user' ? 'user' : 'model',
      parts: [{ text: msg.content }]
    });
  }

  const GEN_BASE = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash`;
  // With the Perplexity research pack in context, the google_search tool is
  // dropped — the report synthesizes from the pack (faster, no grounding quota).
  // A HIGH maxOutputTokens is essential: Gemini 3.5 Flash spends "thinking" tokens
  // from the same output budget, so without a generous cap a long 25-section
  // report can exhaust it on reasoning and return an EMPTY candidate
  // ("No response generated."). 32k leaves room for thinking + the full report.
  const baseBody = {
    contents,
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: { maxOutputTokens: 32768, temperature: 1 },
    ...(researchUrls.length ? {} : { tools: [{ google_search: {} }] }),
  };

  // FUSION: when a DeepSeek key is configured, Gemini 3.5 Flash and DeepSeek V4
  // Pro draft the SAME task IN PARALLEL, then Gemini 3.5 Flash JUDGES and streams
  // the synthesized answer. Without a DeepSeek key, stream a single Gemini answer.
  const deepSeekKey = getDeepSeekKey();
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content || '';

  const streamURL = `${GEN_BASE}:streamGenerateContent?alt=sse&key=${apiKey}`;

  // Track whether any token reached the UI: a stream that fails AFTER emitting
  // can't be cleanly retried (it would duplicate partial text into the report),
  // but the common failure (a non-OK response before any token) can.
  let emitted = false;
  const guardedToken = onToken ? (c: string) => { emitted = true; onToken(c); } : onToken;

  const nonStreamURL = `${GEN_BASE}:generateContent?key=${apiKey}`;

  // Resilient generation. Streaming gives the nice progressive report, but a
  // long-lived SSE connection is the fragile part on mobile/cellular links (iOS
  // Safari surfaces a dropped fetch as "Load failed"). So:
  //   1. stream the primary body;
  //   2. on a PRE-token failure, retry the stream, then the fallback stream;
  //   3. on ANY remaining failure (incl. a MID-stream drop), fetch the whole
  //      report in ONE non-streaming request — no long connection to lose. The
  //      caller uses the returned text as the final report, so a partial stream
  //      is cleanly replaced rather than erroring out.
  // An EMPTY / placeholder result (no text, or Gemini returned an empty candidate)
  // must be treated as a FAILURE so the next fallback tier runs — otherwise the
  // user sees "No response generated." instead of the report.
  const isEmpty = (r: { text: string } | null | undefined) => !r || !r.text || !r.text.trim() || r.text.trim() === 'No response generated.';

  const streamResilient = async (primaryBody: any, fallbackBody?: any): Promise<{ text: string; sources?: ChatSource[] }> => {
    // 1) Preferred: progressive streaming (with a pre-token retry + fallback body).
    try {
      const r = await streamGeminiSSE(streamURL, primaryBody, guardedToken);
      if (!isEmpty(r)) return r;
      console.warn('Report stream returned empty — falling through to non-streaming.');
    } catch (e) {
      console.warn('Report stream failed:', e);
      if (!emitted) {
        await new Promise((r) => setTimeout(r, 1500));
        try { const r2 = await streamGeminiSSE(streamURL, primaryBody, guardedToken); if (!isEmpty(r2)) return r2; }
        catch (e2) {
          console.warn('Stream retry failed:', e2);
          if (fallbackBody && !emitted) {
            try { const r3 = await streamGeminiSSE(streamURL, fallbackBody, guardedToken); if (!isEmpty(r3)) return r3; } catch (e3) { console.warn('Fallback stream failed:', e3); }
          }
        }
      }
    }
    const body = fallbackBody || primaryBody;
    // 2) Non-streaming with grounding — one short-lived request (mobile-safe).
    try {
      const r = await geminiGenerateWithSources(nonStreamURL, body);
      if (!isEmpty(r)) return r;
      console.warn('Non-streaming (grounded) returned empty — retrying WITHOUT web grounding.');
    } catch (e4) {
      console.warn('Non-streaming (grounded) failed — retrying WITHOUT web grounding:', e4);
    }
    // 3) Last resort: non-streaming with NO google_search tool. Grounding has the
    //    tightest quota and is the most fragile call on mobile (extra concurrent
    //    connections); a plain synthesis from the provided data packet + drafts
    //    can't hit those limits, so the report still generates whenever the key
    //    itself is valid. Loses live citations but never fails the whole report.
    const { tools: _drop, ...noGrounding } = body;
    try {
      const r = await geminiGenerateWithSources(nonStreamURL, noGrounding);
      if (!isEmpty(r)) return r;
      throw new Error('the model returned an empty response');
    } catch (e5) {
      const detail = e5 instanceof Error ? e5.message : String(e5);
      throw new Error(`The report could not be generated after several retries (last error: ${detail}). Please check your internet connection and that your Gemini API key is valid with remaining quota, then try again.`);
    }
  };

  // FUSION runs on desktop only. On phones/tablets it triples the number of
  // calls (a separate grounded draft + a grounded judge, plus DeepSeek) and the
  // longer total time over a cellular link is the main cause of "Load failed" —
  // so mobile uses ONE grounded Gemini stream with the full fallback chain.
  if (deepSeekKey && lastUser && !isMobileDevice()) {
    const [gDraft, dDraft] = await Promise.all([
      geminiGenerateText(`${GEN_BASE}:generateContent?key=${apiKey}`, baseBody).catch((e) => { console.warn('Gemini draft failed:', e); return ''; }),
      fetchDeepSeekDraft(`${systemPrompt}\n\n# PROVIDED DATA PACKET (verified evidence)\n${reportContext}\n\n# YOUR ROLE\nProvide a substantive but CONCISE expert analytical draft — your key findings, figures, and risks per topic (zoning, REZONING/UPZONING upside, SUBDIVISION/lot-split potential, HOA/restrictions, buildability, flood, utilities, MARKET SATURATION & absorption by product type — single-family/townhome/condo/multifamily inventory, DOM, months-of-supply — the INTEREST-RATE environment and its demand effect, LOCAL itemized construction cost anchored to the Construction Cost Reference Model, and DEVELOPER ECONOMICS: ARV, residual land value = ARV − construction − site adders (trees/slope/well+septic) − 20%-of-ARV developer profit, cross-checked with the ~20%-of-ARV lot rule). A lead analyst synthesizes the final structured report from your input, so you need not format every numbered section.`, lastUser, deepSeekKey, apiKey).catch((e) => { console.warn('DeepSeek draft failed:', e); return null; }),
    ]);
    // If BOTH drafts failed, there's nothing to fuse — stream the base report.
    if (!gDraft && !dDraft) return finish(await streamResilient(baseBody));
    const judgeInstruction = `Two independent senior analysts each produced the DRAFT below for the SAME task. Acting as the JUDGE, synthesize the single best response that fully follows the Operating Standards:\n- Merge the strongest, most evidence-grounded content from both drafts.\n- Resolve any conflict in favor of cited/verified evidence; where they disagree and neither is verifiable, label it Likely or Unknown.\n- Keep the required section structure and the Verified / Likely / Unknown labels.\n- Output ONLY the final report. Do NOT mention drafts, judging, or model names.\n\n===== DRAFT A (Google Gemini 3.5 Flash) =====\n${gDraft || '(unavailable)'}\n\n===== DRAFT B (DeepSeek V4 Pro) =====\n${dDraft || '(DeepSeek draft unavailable — rely on Draft A and the data packet)'}`;
    const judgeBody = { ...baseBody, contents: [...contents, { role: 'user', parts: [{ text: judgeInstruction }] }] };
    // Judge first; if it fails before emitting, fall back to the plain base stream.
    return finish(await streamResilient(judgeBody, baseBody));
  }

  return finish(await streamResilient(baseBody));
}

/**
 * FAST follow-up chat — a single grounded Gemini stream (NO fusion, no judge), so
 * the assistant replies quickly. The full report is already in the conversation,
 * so this answers the user's question directly with a concise prompt. Falls back
 * to a non-streaming request (and finally without grounding) if the stream drops.
 */
export async function chatFollowUp(
  messages: ChatMessage[],
  reportData: SiteFeasibilityData,
  onToken?: (chunk: string) => void,
): Promise<{ text: string; sources?: ChatSource[] }> {
  const apiKey = getUserKeys().gemini || "";
  if (!apiKey) throw new Error("Gemini API key is required. Please configure it in Account Settings.");

  const acres = reportData.gisAcres ? reportData.gisAcres.toFixed(2) : '?';
  const parcelStateName = countyState(reportData.countyName) === 'SC' ? 'South Carolina' : 'North Carolina';
  const parcelCountyLabel = countyDisplayName(reportData.countyName);
  const system = `You are a sharp, concise land-development analyst answering FOLLOW-UP questions in a chat about ONE ${parcelStateName} parcel. The full AI feasibility report is already earlier in this conversation.
RULES:
- Answer the user's exact question DIRECTLY and BRIEFLY — a few sentences or a short bulleted list. Lead with the answer.
- Use the report + the facts below; only use Google Search when the question needs CURRENT external facts (rates, prices, codes, market) you don't already have.
- No preamble, no restating the question, no re-dumping the whole report. Plain markdown only — no code blocks; use × and ÷ for math, never the asterisk.
- If the user attaches images or documents (site plans, surveys, photos, listings, PDFs), ANALYZE them directly and tie your findings to this parcel and its development.
PARCEL: ${reportData.inputAddress} · ${parcelCountyLabel} · ${acres} acres · zoning ${reportData.zoningCode}${reportData.ownerName ? ` · owner ${reportData.ownerName}` : ''}.`;

  const contents = messages.map((m) => {
    const parts: any[] = [];
    let textPrefix = '';
    for (const att of m.attachments || []) {
      if ((att.kind === 'image' || att.kind === 'pdf') && att.data) {
        parts.push({ inline_data: { mime_type: att.mimeType, data: att.data } });
      } else if (att.kind === 'text' && att.data) {
        textPrefix += `\n\n[Attached document: ${att.name}]\n${att.data}\n`;
      }
    }
    parts.push({ text: `${textPrefix}${m.content}`.trim() || '(see attached files)' });
    return { role: m.role === 'user' ? 'user' : 'model', parts };
  });
  const GEN_BASE = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash`;
  // PERPLEXITY MODE: search the user's question live (question + localized
  // variant, batched in one request) and answer from those sources instead of
  // the google_search tool.
  let followUpResearch = '';
  const lastQuestion = [...messages].reverse().find((m) => m.role === 'user')?.content?.slice(0, 300) || '';
  if (liveWebResearchConfigured() && lastQuestion) {
    const { block } = await perplexityResearchBlock([
      lastQuestion,
      `${lastQuestion} ${reportData.countyName ? `${reportData.countyName} County NC` : 'North Carolina'}`,
    ], { maxResultsPerQuery: 5, maxSources: 10 }).catch(() => ({ block: '', urls: [] as string[] }));
    followUpResearch = block;
  }
  if (followUpResearch && contents.length) {
    const last = contents[contents.length - 1];
    if (last.role === 'user') last.parts.push({ text: followUpResearch });
  }
  const body: any = { contents, systemInstruction: { parts: [{ text: system }] }, ...(followUpResearch ? {} : { tools: [{ google_search: {} }] }) };

  let emitted = false;
  const guarded = onToken ? (c: string) => { emitted = true; onToken(c); } : onToken;
  try {
    return await streamGeminiSSE(`${GEN_BASE}:streamGenerateContent?alt=sse&key=${apiKey}`, body, guarded);
  } catch (e) {
    console.warn('Follow-up stream failed:', e);
    if (emitted) throw e;
    try { return await geminiGenerateWithSources(`${GEN_BASE}:generateContent?key=${apiKey}`, body); }
    catch {
      const { tools: _drop, ...noGrounding } = body;
      return await geminiGenerateWithSources(`${GEN_BASE}:generateContent?key=${apiKey}`, noGrounding);
    }
  }
}
// EOF
