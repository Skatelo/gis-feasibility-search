// ---------------------------------------------------------------------------
// AI Distressed Property & Vacant Land Finder — analysis pipeline.
//
// This is the orchestrator/scoring layer (the "Claude Code" role in the spec):
// it acquires imagery from Google (Static Maps satellite + Street View), sends
// it to Gemini Vision (the computer-vision specialist), parses the structured
// JSON Gemini returns, and computes the distress / buildability / builder
// scores from those observations. Claude-side code never interprets pixels
// itself — it only routes imagery to Gemini and applies real-estate logic to
// the result.
//
// Runs fully client-side using the user's own Google Maps + Gemini API keys
// (the same keys configured in Account Settings for the feasibility search).
// ---------------------------------------------------------------------------

import { getUserKeys, ncCountyConfig, fetchFemaFloodZone, fetchNwiWetlands } from './feasibilityService';
import type { FloodZoneInfo, WetlandsInfo } from '../types/feasibility';

// Two modes: distressed houses, and a combined "land" mode that covers both
// vacant land and builder lots (the spec asked to merge those two).
export type SearchMode = 'house' | 'land';

/** Structured observations Gemini returns from the imagery (the spec's JSON). */
export interface VisionObservations {
  // Shared
  vacant?: boolean;
  structures_detected?: number;
  confidence?: number; // 0..1
  summary?: string;
  reasons?: string[];

  // Distressed-house indicators (0..100 each, higher = worse condition)
  roof_condition_score?: number;       // 100 = severe roof damage / missing shingles
  exterior_condition_score?: number;   // 100 = heavy deterioration
  yard_condition_score?: number;       // 100 = overgrown / junk-filled
  vacancy_indicator_score?: number;    // 100 = strong abandonment signals
  misc_distress_score?: number;        // fire/storm damage, junk vehicles, etc.

  // Land indicators
  road_frontage?: boolean;
  tree_coverage_percent?: number;      // 0..100
  utility_visibility?: boolean;        // power lines / utility corridors visible
  water_or_wetland_indicators?: boolean;
  slope_score?: number;                // 0 = flat/buildable, 100 = steep/difficult
  flood_indicator_score?: number;      // 0 = none, 100 = strong flood/wetland signal
  development_activity_score?: number; // 0..100 nearby/adjacent construction
  agricultural_use?: boolean;
  commercial_use?: boolean;
  encroachments?: boolean;
}

export interface PropertyImagery {
  satelliteUrl: string;
  streetViewUrl: string | null;
  hasStreetView: boolean;
}

/** Parcel attributes carried over from the GIS discovery step (NC OneMap). */
export interface ParcelInfo {
  parcelId?: string;
  acres?: number;
  assessedValue?: number;
  landValue?: number;
  county?: string;
  /** (assessedValue - landValue) / assessedValue — share of value in structures. */
  improvementRatio?: number;

  // GIS-derived distress / motivated-seller lead signals (house mode)
  ownerName?: string;
  absenteeOwner?: boolean;
  outOfState?: boolean;
  ownerType?: 'individual' | 'estate' | 'company' | 'public';
  yearsSinceSale?: number;
  /** 0..100 likelihood-of-distress/motivation score from assessor data. */
  gisDistress?: number;
  /** Human-readable lead signals, e.g. "absentee owner (out-of-state)". */
  gisSignals?: string[];
}

/** A 0..100 sub-score with a human label and the authoritative source link. */
export interface EnvScore {
  score: number | null; // null = could not verify (service down / no coverage)
  label: string;
  detail: string;
  sourceUrl: string;
}

export interface PropertyResult {
  id: string;
  address: string;
  mode: SearchMode;
  lat: number;
  lng: number;
  imagery: PropertyImagery;
  observations: VisionObservations;
  confidence: number;        // 0..1
  score: number;             // 0..100 (the score relevant to the mode)
  scoreLabel: string;        // e.g. "Distress Score"
  reasons: string[];
  recommendation: string;
  analyzedAt: number;

  /** House mode: true only when the home actually LOOKS distressed (vision). */
  distressed?: boolean;

  // Land-mode enrichment
  parcel?: ParcelInfo;
  flood?: EnvScore;          // authoritative FEMA NFHL flood-zone score
  wetlands?: EnvScore;       // authoritative USFWS NWI wetlands score
  builderInterest?: 'high' | 'medium' | 'low';
}

const GEMINI_VISION_MODEL = 'gemini-3.5-flash';

// ---------------------------------------------------------------------------
// Imagery acquisition
// ---------------------------------------------------------------------------

const GEO_CACHE_PREFIX = 'gisfs:finder:geo:v1:';

/** Geocode an address → coordinates via Google Geocoding (90-day localStorage cache). */
export async function geocodeAddress(address: string, apiKey: string): Promise<{ lat: number; lng: number } | null> {
  const key = GEO_CACHE_PREFIX + address.toLowerCase().trim().replace(/\s+/g, ' ');
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const v = JSON.parse(raw);
      if (Number.isFinite(v?.lat) && Number.isFinite(v?.lng) && Date.now() - (v.t || 0) < 90 * 864e5) {
        return { lat: v.lat, lng: v.lng };
      }
    }
  } catch { /* ignore */ }

  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  if (data.status !== 'OK' || !data.results?.[0]) return null;
  const loc = data.results[0].geometry?.location;
  if (!loc) return null;
  const out = { lat: loc.lat, lng: loc.lng };
  try { localStorage.setItem(key, JSON.stringify({ ...out, t: Date.now() })); } catch { /* ignore */ }
  return out;
}

const REVGEO_CACHE_PREFIX = 'gisfs:finder:revgeo:v1:';

/**
 * Reverse-geocode a coordinate → a human street address via Google Geocoding.
 * Used to give discovered parcels (especially vacant land, which usually has no
 * situs address) a real ADDRESS instead of a "County parcel #" label. Prefers a
 * precise street_address/premise result; cached per rounded coordinate.
 */
export async function reverseGeocode(lat: number, lng: number, apiKey: string): Promise<string | null> {
  const key = `${REVGEO_CACHE_PREFIX}${lat.toFixed(5)},${lng.toFixed(5)}`;
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const v = JSON.parse(raw);
      if (typeof v?.a === 'string' && Date.now() - (v.t || 0) < 90 * 864e5) return v.a || null;
    }
  } catch { /* ignore */ }

  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status !== 'OK' || !Array.isArray(data.results) || !data.results.length) return null;
    // Prefer the most precise result that has a street number; fall back to the first.
    const precise = data.results.find((r: any) => r.types?.some((t: string) => ['street_address', 'premise', 'subpremise'].includes(t)));
    const address: string = (precise || data.results[0]).formatted_address || '';
    const cleaned = address.replace(/,?\s*USA$/i, '').trim();
    try { localStorage.setItem(key, JSON.stringify({ a: cleaned, t: Date.now() })); } catch { /* ignore */ }
    return cleaned || null;
  } catch {
    return null;
  }
}

/** High-zoom Google satellite tile centered on the parcel. */
export function buildSatelliteUrl(lat: number, lng: number, apiKey: string, zoom = 19): string {
  const params = new URLSearchParams({
    center: `${lat},${lng}`,
    zoom: String(zoom),
    size: '640x640',
    scale: '2',
    maptype: 'satellite',
    key: apiKey,
  });
  return `https://maps.googleapis.com/maps/api/staticmap?${params.toString()}`;
}

/** Street View Static image looking at the property from the road. */
export function buildStreetViewUrl(lat: number, lng: number, apiKey: string): string {
  const params = new URLSearchParams({
    location: `${lat},${lng}`,
    size: '640x640',
    fov: '90',
    pitch: '5',
    source: 'outdoor',
    return_error_code: 'true',
    key: apiKey,
  });
  return `https://maps.googleapis.com/maps/api/streetview?${params.toString()}`;
}

/** Whether Street View imagery actually exists at this point (metadata endpoint is free). */
async function hasStreetView(lat: number, lng: number, apiKey: string): Promise<boolean> {
  try {
    const url = `https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lng}&source=outdoor&key=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) return false;
    const data = await res.json();
    return data.status === 'OK';
  } catch {
    return false;
  }
}

/** Fetch an image URL and convert to base64 inline data for Gemini. */
async function imageUrlToInlineData(url: string): Promise<{ mimeType: string; data: string } | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    const mimeType = blob.type || 'image/jpeg';
    const dataUrl: string = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
    const base64 = dataUrl.split(',')[1] || '';
    if (!base64) return null;
    return { mimeType, data: base64 };
  } catch (e) {
    console.warn('Image fetch/encode failed (likely CORS); continuing without it:', e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Gemini Vision — structured observation extraction
// ---------------------------------------------------------------------------

function visionPrompt(mode: SearchMode): string {
  const shared = `You are an expert real-estate computer-vision analyst. You are given a high-zoom SATELLITE/aerial image and (when available) a STREET VIEW image of a single property. Analyze them as a real-estate investor scanning for opportunities.

Respond with ONLY a single raw JSON object — no prose, no markdown, no code fences. Use numeric 0-100 scores (integers) and booleans exactly as specified. If a field cannot be judged from the imagery, use a conservative value and lower your overall "confidence". The JSON shape to follow is shown below.`;

  if (mode === 'house') {
    return `${shared}

Detect DISTRESSED-HOUSE indicators: roof damage / missing shingles / roof discoloration, exterior deterioration, broken or boarded windows, overgrown grass / excessive vegetation, junk vehicles, unmaintained driveway, structural / fire / storm damage, and vacancy/abandonment signals.

JSON shape:
\`\`\`json
{
  "structures_detected": 1,
  "vacant": false,
  "roof_condition_score": 0,
  "exterior_condition_score": 0,
  "yard_condition_score": 0,
  "vacancy_indicator_score": 0,
  "misc_distress_score": 0,
  "confidence": 0.0,
  "summary": "one sentence",
  "reasons": ["short phrase", "short phrase"]
}
\`\`\`
For the *_score fields: 0 = pristine/well-maintained, 100 = severe distress. Be decisive and honest: a clearly well-maintained, recently built, or pristine home (intact roof, tidy yard, no damage) should score UNDER 15 across the board — do not invent problems. Reserve scores above 50 for genuinely visible deterioration, damage, overgrowth, or abandonment.`;
  }

  // land = combined vacant-land + builder-lot assessment
  return `${shared}

This is a combined VACANT-LAND and BUILDER-LOT assessment. Detect whether the parcel is vacant/cleared, road frontage / access roads, visible utilities/power lines, tree coverage percentage, water/wetland indicators, terrain slope, flood signals, and especially DEVELOPMENT ACTIVITY nearby (adjacent new construction, graded lots, similar-sized residential lots — the signal a homebuilder would buy here), plus any agricultural/commercial use or encroachments.

JSON shape:
\`\`\`json
{
  "structures_detected": 0,
  "vacant": true,
  "road_frontage": true,
  "utility_visibility": true,
  "tree_coverage_percent": 0,
  "water_or_wetland_indicators": false,
  "slope_score": 0,
  "flood_indicator_score": 0,
  "development_activity_score": 0,
  "agricultural_use": false,
  "commercial_use": false,
  "encroachments": false,
  "confidence": 0.0,
  "summary": "one sentence",
  "reasons": ["short phrase", "short phrase"]
}
\`\`\`
slope_score: 0 = flat/buildable, 100 = steep. flood_indicator_score: 0 = none, 100 = strong wetland/flood signal. development_activity_score: 0 = none, 100 = heavy nearby development.`;
}

/**
 * Extracts the first balanced JSON object from a model response. Handles raw
 * JSON (JSON mode), ```json fenced blocks, and JSON embedded in prose. Returns
 * null if no `{` is found or the object is unbalanced (i.e. the response was
 * truncated), so the caller can retry rather than silently mis-parse.
 */
function extractJsonObject(text: string): string | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const body = fence ? fence[1] : text;
  const start = body.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return body.slice(start, i + 1);
    }
  }
  return null; // unbalanced — response was cut off
}

function parseVisionJson(text: string): VisionObservations | null {
  const jsonStr = extractJsonObject(text);
  if (!jsonStr) return null;
  // Tolerate trailing commas the model occasionally emits before } or ].
  const cleaned = jsonStr.replace(/,\s*([}\]])/g, '$1');
  try {
    return JSON.parse(cleaned) as VisionObservations;
  } catch {
    return null;
  }
}

/** Pull the text out of a Gemini response, joining multi-part candidates. */
function extractGeminiText(data: any): string {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('');
}

/** Send the acquired imagery to Gemini Vision and return its structured observations. */
export async function geminiVisionAnalyze(
  images: Array<{ mimeType: string; data: string }>,
  mode: SearchMode,
  geminiApiKey: string,
): Promise<VisionObservations> {
  if (images.length === 0) {
    throw new Error('No imagery could be loaded for vision analysis (the imagery host blocked the request).');
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_VISION_MODEL}:generateContent?key=${geminiApiKey}`;
  const parts: any[] = [{ text: visionPrompt(mode) }];
  for (const img of images) parts.push({ inline_data: { mime_type: img.mimeType, data: img.data } });

  // `responseMimeType: application/json` forces clean JSON (no prose / markdown
  // fences); a generous token budget avoids truncating the object. jsonMode is a
  // flag so we can fall back to plain mode if the model rejects JSON mode.
  const callOnce = async (temperature: number, jsonMode: boolean) => {
    const generationConfig: any = { temperature, maxOutputTokens: 2048 };
    if (jsonMode) generationConfig.responseMimeType = 'application/json';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const err: any = new Error(`Gemini Vision API error ${res.status}: ${detail.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    // Surface a blocked prompt or empty/truncated candidate clearly.
    const blockReason = data?.promptFeedback?.blockReason;
    if (blockReason) throw new Error(`Gemini blocked the request (${blockReason}).`);
    const finishReason = data?.candidates?.[0]?.finishReason;
    const text = extractGeminiText(data);
    return { text, finishReason };
  };

  // First attempt in JSON mode; if the model rejects JSON mode with a 4xx, retry
  // in plain mode (the parser handles fenced/embedded JSON too).
  let last: { text: string; finishReason?: string };
  try {
    last = await callOnce(0.2, true);
  } catch (e: any) {
    if (e?.status >= 400 && e?.status < 500) last = await callOnce(0.2, false);
    else throw e;
  }
  let obs = parseVisionJson(last.text);
  // On an empty/unparseable/truncated response, retry once at temperature 0.
  if (!obs) {
    last = await callOnce(0, true).catch(() => callOnce(0, false));
    obs = parseVisionJson(last.text);
  }
  if (!obs) {
    const hint =
      last.finishReason === 'MAX_TOKENS' ? ' (response hit the token limit)'
      : last.finishReason === 'SAFETY' || last.finishReason === 'RECITATION' ? ` (finishReason: ${last.finishReason})`
      : last.text.trim() === '' ? ' (model returned an empty response)'
      : '';
    throw new Error(`Gemini Vision returned no parseable JSON observations${hint}.`);
  }
  return obs;
}

// ---------------------------------------------------------------------------
// Scoring engine (real-estate logic — applied to Gemini's observations)
// ---------------------------------------------------------------------------

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const num = (v: unknown, d = 0) => (Number.isFinite(v as number) ? (v as number) : d);

/** Distressed-house score. Weights: roof 25%, exterior 25%, yard 20%, vacancy 20%, misc 10%. */
export function computeDistressScore(o: VisionObservations): number {
  const roof = clamp(num(o.roof_condition_score));
  const ext = clamp(num(o.exterior_condition_score));
  const yard = clamp(num(o.yard_condition_score));
  const vac = clamp(num(o.vacancy_indicator_score, o.vacant ? 70 : 0));
  const misc = clamp(num(o.misc_distress_score));
  return Math.round(roof * 0.25 + ext * 0.25 + yard * 0.2 + vac * 0.2 + misc * 0.1);
}

/**
 * Whether a home actually LOOKS distressed in the imagery — the hard gate so a
 * perfectly-maintained house is NEVER shown in house mode. True when the weighted
 * distress score is meaningful, or any single indicator is severe (e.g. a
 * fire-damaged or clearly vacant home with one dominant problem).
 */
export function looksDistressed(o: VisionObservations): boolean {
  const maxIndicator = Math.max(
    clamp(num(o.roof_condition_score)),
    clamp(num(o.exterior_condition_score)),
    clamp(num(o.yard_condition_score)),
    clamp(num(o.vacancy_indicator_score, o.vacant ? 70 : 0)),
    clamp(num(o.misc_distress_score)),
  );
  return computeDistressScore(o) >= 38 || maxIndicator >= 65;
}

export interface GisDistress {
  score: number; // 0..100 targeting signal (motivation/likelihood, NOT physical condition)
  absenteeOwner: boolean;
  outOfState: boolean;
  ownerType: 'individual' | 'estate' | 'company' | 'public';
  yearsSinceSale?: number;
  signals: string[];
}

const MS_PER_YEAR = 31557600000;

/**
 * Normalize a US street address for comparison: lowercase, strip punctuation,
 * standardize the common street-type and directional abbreviations, drop unit/
 * suite designators, and collapse whitespace. Lets us tell whether the owner's
 * MAILING street is the SAME as the property's SITUS street (owner-occupied).
 */
const normStreet = (s?: string) =>
  String(s || '')
    .toLowerCase()
    .replace(/[.,#]/g, ' ')
    .replace(/\b(street|str)\b/g, 'st')
    .replace(/\b(avenue|av)\b/g, 'ave')
    .replace(/\broad\b/g, 'rd')
    .replace(/\bdrive\b/g, 'dr')
    .replace(/\blane\b/g, 'ln')
    .replace(/\bboulevard\b/g, 'blvd')
    .replace(/\bcourt\b/g, 'ct')
    .replace(/\bcircle\b/g, 'cir')
    .replace(/\bplace\b/g, 'pl')
    .replace(/\bhighway\b/g, 'hwy')
    .replace(/\b(north)\b/g, 'n').replace(/\b(south)\b/g, 's').replace(/\b(east)\b/g, 'e').replace(/\b(west)\b/g, 'w')
    .replace(/\b(apt|unit|ste|suite|lot|bldg)\b.*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const isPoBox = (s?: string) => /\bp\.?\s*o\.?\s*box\b|\bpost\s+office\s+box\b/i.test(String(s || ''));

/** Classify an owner-of-record name into individual / company / estate / public. */
export function classifyOwner(name?: string): 'individual' | 'company' | 'estate' | 'public' {
  const own = String(name || '');
  if (/\b(CITY|TOWN|COUNTY|STATE|HOUSING AUTH|AUTHORITY|CHURCH|MINISTR|USA|UNITED STATES|DEPT|DEPARTMENT|BOARD OF|SCHOOL)\b/i.test(own)) return 'public';
  // Estate/probate = "HEIRS" or a standalone "ESTATE" — but NOT "REAL ESTATE".
  if (/\bHEIRS?\b/i.test(own) || (/\bESTATE\b/i.test(own) && !/\bREAL\s+ESTATE\b/i.test(own))) return 'estate';
  if (/\b(LLC|INC|CORP|CO|TRUST|LP|LLP|COMPANY|PROPERTIES|HOLDINGS|HOMES|INVESTMENTS?|CAPITAL|GROUP|REALTY|RENTALS?|VENTURES?|PARTNERS)\b/i.test(own)) return 'company';
  return 'individual';
}

/**
 * GIS / assessor distress-lead score. Uses the parcel's ownership + mailing +
 * sale-history attributes to flag the motivated-seller signals investors target:
 * absentee owners, out-of-state owners, estates/heirs (probate), long tenure
 * (deferred maintenance), and company/landlord ownership. This TARGETS likely
 * distressed/motivated parcels; it does not claim the structure is physically
 * distressed (that's the vision step's job).
 *
 * ACCURATE absentee detection: an owner is "absentee" only when their MAILING
 * STREET ADDRESS differs from the property's SITUS STREET ADDRESS (or mail goes
 * out of state / to a PO box). We do NOT compare cities — the situs-city field
 * sometimes holds a district name (e.g. "GAST DOWNTOWN SD"), which falsely
 * flagged on-site owners as absentee. When the mailing street matches the situs
 * street, the owner lives there → never flagged absentee.
 */
export function computeGisDistress(a: {
  siteadd?: string; scity?: string; mailadd?: string; mcity?: string; mstate?: string; ownname?: string; saleEpoch?: number;
}): GisDistress {
  const ownerType = classifyOwner(a.ownname);

  const mS = String(a.mstate || '').trim().toUpperCase();
  const outOfState = !!mS && mS !== 'NC';
  const poBox = isPoBox(a.mailadd);
  // Situs street = portion before the first comma (siteadd may embed city/unit).
  const situsStreet = normStreet(String(a.siteadd || '').split(',')[0]);
  const mailStreet = normStreet(a.mailadd);
  // Owner lives at the property when the mailing street matches the situs street
  // (and mail isn't out-of-state / a PO box).
  const ownerOccupied = !!situsStreet && !!mailStreet && situsStreet === mailStreet && !outOfState && !poBox;
  // Absentee only on confident evidence; when we can't tell (no mailing street),
  // do NOT flag — better to miss a lead than mislabel a resident.
  const absenteeOwner = !ownerOccupied && (outOfState || poBox || (!!mailStreet && !!situsStreet && mailStreet !== situsStreet));
  const yearsSinceSale = a.saleEpoch && a.saleEpoch > 0 ? Math.max(0, (Date.now() - a.saleEpoch) / MS_PER_YEAR) : undefined;

  // Government/institution-owned parcels are not wholesale leads.
  if (ownerType === 'public') {
    return { score: 0, absenteeOwner, outOfState, ownerType, yearsSinceSale, signals: ['government / institution owned'] };
  }

  const signals: string[] = [];
  let score = 0;
  if (absenteeOwner) {
    score += 22;
    signals.push(outOfState ? 'absentee owner (out-of-state)' : poBox ? 'absentee owner (PO box)' : 'absentee owner');
  }
  if (outOfState && absenteeOwner) score += 16; // out-of-state stacks
  if (ownerType === 'estate') { score += 26; signals.push('estate / heirs owner'); }
  if (ownerType === 'company') { score += 8; signals.push('company / investor owned'); }
  if (yearsSinceSale !== undefined) {
    const y = Math.round(yearsSinceSale);
    if (yearsSinceSale >= 25) { score += 22; signals.push(`owned ${y} yrs`); }
    else if (yearsSinceSale >= 15) { score += 14; signals.push(`owned ${y} yrs`); }
    else if (yearsSinceSale >= 8) { score += 7; signals.push(`owned ${y} yrs`); }
  }
  return { score: clamp(score), absenteeOwner, outOfState, ownerType, yearsSinceSale, signals };
}

/** High-risk FEMA Special Flood Hazard Area zone codes (1% annual chance). */
const SFHA_ZONES = /^(A|AE|AH|AO|AR|A99|V|VE)$/;

/**
 * Authoritative flood-zone sub-score (0..100, higher = safer/more buildable)
 * derived from the FEMA National Flood Hazard Layer. Returns score=null when
 * FEMA is unverifiable so the caller can fall back to the visual estimate.
 */
export function scoreFloodZone(f?: FloodZoneInfo): EnvScore {
  const sourceUrl = f?.sourceUrl || 'https://msc.fema.gov/portal/search';
  if (!f || f.status === 'unavailable') return { score: null, label: 'Flood: unverified', detail: 'FEMA NFHL unavailable', sourceUrl };
  if (f.status === 'no-coverage') return { score: null, label: 'Flood: no NFHL coverage', detail: 'Outside mapped NFHL', sourceUrl };
  const z = (f.zone || '').toUpperCase();
  if (f.inSFHA || SFHA_ZONES.test(z)) return { score: 8, label: 'High-risk flood (SFHA)', detail: `FEMA Zone ${z}`, sourceUrl };
  if (/0\.2/.test(f.subtype || '')) return { score: 68, label: 'Moderate flood risk', detail: `Zone ${z} · 0.2% annual`, sourceUrl };
  if (z === 'X') return { score: 95, label: 'Minimal flood risk', detail: 'FEMA Zone X', sourceUrl };
  if (z === 'D') return { score: 50, label: 'Undetermined flood risk', detail: 'FEMA Zone D', sourceUrl };
  return { score: 80, label: `Flood zone ${z || 'n/a'}`, detail: `FEMA Zone ${z || 'n/a'}`, sourceUrl };
}

/**
 * Authoritative wetlands sub-score (0..100, higher = less wetland constraint)
 * from the USFWS National Wetlands Inventory. score=null when NWI is unverifiable.
 */
export function scoreWetlands(w?: WetlandsInfo): EnvScore {
  const sourceUrl = w?.sourceUrl || 'https://www.fws.gov/program/national-wetlands-inventory/wetlands-mapper';
  if (!w || w.status === 'unavailable') return { score: null, label: 'Wetlands: unverified', detail: 'USFWS NWI unavailable', sourceUrl };
  if (w.present === false || w.status === 'none-at-point') return { score: 95, label: 'No mapped wetlands', detail: 'NWI: none at point', sourceUrl };
  if (w.present) return { score: 18, label: 'Mapped wetlands present', detail: w.types.slice(0, 2).join(', ') || 'NWI wetland at point', sourceUrl };
  return { score: null, label: 'Wetlands: unverified', detail: '', sourceUrl };
}

/**
 * Combined land score (0..100) — merges vacant-land buildability with builder
 * interest. Weights mirror the spec: road frontage 20%, utilities 20%, slope
 * 20%, flood 20%, development proximity 20% — but the flood/wetland inputs use
 * the AUTHORITATIVE FEMA/NWI scores when available, falling back to Gemini's
 * visual estimate only when those services can't confirm.
 */
export function computeLandScore(o: VisionObservations, flood: EnvScore, wetlands: EnvScore): number {
  const frontage = o.road_frontage ? 100 : 25;
  const utilities = o.utility_visibility ? 100 : 40;
  const slope = clamp(100 - num(o.slope_score));
  const floodComponent = flood.score != null ? flood.score : clamp(100 - num(o.flood_indicator_score));
  const dev = clamp(num(o.development_activity_score));
  let score = frontage * 0.2 + utilities * 0.2 + slope * 0.2 + floodComponent * 0.2 + dev * 0.2;

  const wet = wetlands.score != null ? wetlands.score : (o.water_or_wetland_indicators ? 20 : 90);
  if (wet < 40) score -= 14;
  else if (wet < 80) score -= 5;
  if (o.encroachments) score -= 6;
  if (num(o.tree_coverage_percent) > 80) score -= 5; // heavy clearing cost
  return Math.round(clamp(score));
}

/** Builder-interest bucket from nearby development activity + buildability. */
export function builderInterestLevel(o: VisionObservations, landScore: number): 'high' | 'medium' | 'low' {
  const dev = clamp(num(o.development_activity_score));
  if (dev >= 60 && landScore >= 65) return 'high';
  if (dev >= 35 || landScore >= 55) return 'medium';
  return 'low';
}

function buildReasons(mode: SearchMode, o: VisionObservations, flood?: EnvScore, wetlands?: EnvScore, gisSignals?: string[]): string[] {
  const r: string[] = [];
  if (mode === 'house') {
    // Visual distress reasons first (what the AI sees), then GIS lead signals.
    const visual = Array.isArray(o.reasons) && o.reasons.length ? o.reasons.slice(0, 4) : [];
    if (!visual.length) {
      if (num(o.roof_condition_score) >= 50) visual.push('roof deterioration');
      if (num(o.exterior_condition_score) >= 50) visual.push('exterior deterioration');
      if (num(o.yard_condition_score) >= 50) visual.push('overgrown / unkempt yard');
      if (o.vacant || num(o.vacancy_indicator_score) >= 50) visual.push('vacancy indicators');
    }
    for (const v of visual) if (r.length < 5) r.push(v);
    if (gisSignals) for (const g of gisSignals) if (r.length < 6 && !r.includes(g)) r.push(g);
  } else {
    if (o.road_frontage) r.push('road frontage');
    if (o.utility_visibility) r.push('utilities nearby');
    if (num(o.development_activity_score) >= 50) r.push('nearby development activity');
    // Prefer authoritative environmental flags over the visual guess.
    if (flood && flood.score != null && flood.score < 40) r.push('FEMA high-risk flood zone');
    if (wetlands && wetlands.score != null && wetlands.score < 40) r.push('NWI mapped wetlands');
    if (num(o.tree_coverage_percent) >= 60) r.push('heavy tree coverage');
    if (Array.isArray(o.reasons)) for (const x of o.reasons) if (r.length < 6 && !r.includes(x)) r.push(x);
  }
  return r.length ? r : ['see AI summary'];
}

function recommend(mode: SearchMode, score: number, flood?: EnvScore): string {
  if (mode === 'house') {
    if (score >= 75) return 'Strong wholesale / fix-and-flip candidate — prioritize outreach';
    if (score >= 50) return 'Moderate distress — worth a closer look / drive-by';
    return 'Low distress — likely owner-occupied / maintained';
  }
  if (flood && flood.score != null && flood.score < 20) return 'In a FEMA flood hazard area — verify before pursuing';
  if (score >= 75) return 'High-potential lot — pursue feasibility / builder outreach';
  if (score >= 50) return 'Buildable with constraints — verify access, utilities & zoning';
  return 'Significant constraints — slope/flood/wetlands/access concerns';
}

// ---------------------------------------------------------------------------
// End-to-end: analyze one property
// ---------------------------------------------------------------------------

/**
 * Core per-point analysis used by both manual address entry and GIS discovery.
 * Acquires imagery → Gemini Vision → (land) authoritative FEMA flood + NWI
 * wetlands → score. Coordinates are passed in so discovery doesn't re-geocode.
 */
export async function analyzeAtPoint(
  args: { address: string; lat: number; lng: number; mode: SearchMode; parcel?: ParcelInfo },
  onStage?: (s: string) => void,
): Promise<PropertyResult> {
  const { address, lat, lng, mode, parcel } = args;
  const keys = getUserKeys();
  if (!keys.googleMaps) throw new Error('Google Maps API key required (set it in Account Settings).');
  if (!keys.gemini) throw new Error('Gemini API key required (set it in Account Settings).');

  onStage?.('Acquiring satellite + street-view imagery…');
  const satelliteUrl = buildSatelliteUrl(lat, lng, keys.googleMaps);
  const svExists = await hasStreetView(lat, lng, keys.googleMaps);
  const streetViewUrl = svExists ? buildStreetViewUrl(lat, lng, keys.googleMaps) : null;

  onStage?.('Encoding imagery for Gemini Vision…');
  const inlineImages: Array<{ mimeType: string; data: string }> = [];
  const sat = await imageUrlToInlineData(satelliteUrl);
  if (sat) inlineImages.push(sat);
  if (streetViewUrl) {
    const sv = await imageUrlToInlineData(streetViewUrl);
    if (sv) inlineImages.push(sv);
  }

  // For land, fetch authoritative FEMA flood + NWI wetlands in parallel with the
  // (sequential) vision call so it adds no extra wall-clock time.
  const envPromise: Promise<[FloodZoneInfo | undefined, WetlandsInfo | undefined]> =
    mode === 'land'
      ? Promise.all([
          fetchFemaFloodZone(lat, lng).catch(() => undefined),
          fetchNwiWetlands(lat, lng).catch(() => undefined),
        ])
      : Promise.resolve([undefined, undefined]);

  onStage?.('Gemini Vision analyzing imagery…');
  const observations = await geminiVisionAnalyze(inlineImages, mode, keys.gemini);

  let result: PropertyResult;
  if (mode === 'house') {
    const score = computeDistressScore(observations);
    result = {
      id: '', address, mode, lat, lng,
      imagery: { satelliteUrl, streetViewUrl, hasStreetView: svExists },
      observations,
      confidence: clamp(num(observations.confidence, 0.7) * 100, 0, 100) / 100,
      score, scoreLabel: 'Distress Score',
      // Only flag as distressed when the home actually LOOKS distressed — this is
      // what keeps perfectly-fine houses out of the results.
      distressed: looksDistressed(observations),
      reasons: buildReasons(mode, observations, undefined, undefined, parcel?.gisSignals),
      recommendation: recommend(mode, score),
      analyzedAt: Date.now(), parcel,
    };
  } else {
    onStage?.('Checking FEMA flood + USFWS wetlands…');
    const [floodInfo, wetInfo] = await envPromise;
    const flood = scoreFloodZone(floodInfo);
    const wetlands = scoreWetlands(wetInfo);
    const score = computeLandScore(observations, flood, wetlands);
    result = {
      id: '', address, mode, lat, lng,
      imagery: { satelliteUrl, streetViewUrl, hasStreetView: svExists },
      observations,
      confidence: clamp(num(observations.confidence, 0.7) * 100, 0, 100) / 100,
      score, scoreLabel: 'Land Score',
      reasons: buildReasons(mode, observations, flood, wetlands),
      recommendation: recommend(mode, score, flood),
      analyzedAt: Date.now(),
      parcel, flood, wetlands,
      builderInterest: builderInterestLevel(observations, score),
    };
  }
  result.id = `${mode}-${lat.toFixed(5)},${lng.toFixed(5)}-${Date.now()}`;
  return result;
}

/** Manual entry: geocode the address, then run the core analysis. */
export async function analyzeProperty(
  address: string,
  mode: SearchMode,
  onStage?: (s: string) => void,
): Promise<PropertyResult> {
  const keys = getUserKeys();
  if (!keys.googleMaps) throw new Error('Google Maps API key required (set it in Account Settings).');
  onStage?.('Geocoding address…');
  const coords = await geocodeAddress(address, keys.googleMaps);
  if (!coords) throw new Error(`Could not geocode "${address}".`);
  return analyzeAtPoint({ address, lat: coords.lat, lng: coords.lng, mode }, onStage);
}

// ---------------------------------------------------------------------------
// Automatic discovery — find candidate parcels across an area via the NC OneMap
// GIS parcel layer, then prefilter cheaply on parcel attributes (the spec's
// "use cheaper filters first; only send high-potential parcels to the expensive
// AI"). Vision is only run on the survivors.
// ---------------------------------------------------------------------------

/** All 100 NC county names available for an area scan (sorted). */
export const ncCountyNames: string[] = Object.keys(ncCountyConfig).sort();

export interface Candidate {
  parcelId: string;
  address: string;
  scity?: string;
  lat: number;
  lng: number;
  acres: number;
  assessedValue: number;
  landValue: number;
  improvementRatio?: number; // share of value in structures
  saleEpoch?: number;
  /** True when `address` came from the parcel's situs address (not a fallback). */
  addressFromSitus?: boolean;
  // GIS distress lead signals (house mode)
  ownerName?: string;
  absenteeOwner?: boolean;
  outOfState?: boolean;
  ownerType?: 'individual' | 'estate' | 'company' | 'public';
  yearsSinceSale?: number;
  gisDistress?: number;
  gisSignals?: string[];
}

export interface DiscoverParams {
  county: string;
  city?: string;
  zip?: string;
  mode: SearchMode;
  radiusMiles: number;   // half-size of the scan box around the area center
  minAcres: number;
  maxAcres: number;
}

function fetchTimeout(url: string, ms: number): Promise<Response> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return fetch(url, { signal: c.signal }).finally(() => clearTimeout(t));
}

/** Representative point (bounding-box center) of a GeoJSON parcel geometry. */
function geomCenter(geom: any): { lat: number; lng: number } | null {
  if (!geom) return null;
  const ring =
    geom.type === 'Polygon' ? geom.coordinates?.[0]
    : geom.type === 'MultiPolygon' ? geom.coordinates?.[0]?.[0]
    : null;
  if (!ring || !ring.length) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { lng: (minX + maxX) / 2, lat: (minY + maxY) / 2 };
}

const numOf = (v: unknown): number => {
  const n = typeof v === 'string' ? parseFloat(v) : (v as number);
  return Number.isFinite(n) ? n : NaN;
};

/**
 * Discover candidate parcels in an area and prefilter them by mode:
 *  - land:  near-vacant parcels (little/no structure value) within the acreage band
 *  - house: developed residential-sized lots (assessment values are sparse in the
 *           statewide layer, so lot size is the gate), ranked by GIS distress lead
 * Returns the FULL ranked candidate pool (the GIS step is not capped) — the
 * caller decides how many to hand to the vision step.
 */
export async function discoverCandidates(
  params: DiscoverParams,
  onProgress?: (s: string) => void,
): Promise<Candidate[]> {
  const { county, city, zip, mode, radiusMiles, minAcres, maxAcres } = params;
  const keys = getUserKeys();
  if (!keys.googleMaps) throw new Error('Google Maps API key required (set it in Account Settings).');
  const cfg = ncCountyConfig[county];
  if (!cfg) throw new Error(`Unsupported county: ${county}`);

  onProgress?.('Locating scan area…');
  const areaQuery = city ? `${city}, NC` : zip ? `${zip}, NC` : `${county} County, NC`;
  const center = await geocodeAddress(areaQuery, keys.googleMaps);
  if (!center) throw new Error(`Could not locate "${areaQuery}".`);

  // Build a lat/lng envelope of half-size radiusMiles around the center.
  const dLat = radiusMiles / 69;
  const dLng = radiusMiles / (69 * Math.cos((center.lat * Math.PI) / 180) || 1);
  const xmin = center.lng - dLng, xmax = center.lng + dLng;
  const ymin = center.lat - dLat, ymax = center.lat + dLat;

  // Page through ALL parcels in the envelope so the GIS step isn't capped by the
  // server's per-request limit. We page until a short page (the last one), the
  // server stops honoring the offset, or a generous safety ceiling. Geometry is
  // simplified (maxAllowableOffset ≈ 30m) so we only carry a coarse outline for
  // the centroid — that keeps payloads small enough to page deeply uncapped.
  const baseUrl =
    `${cfg.parcelUrl}?where=${encodeURIComponent(cfg.extraWhere)}` +
    `&geometry=${xmin},${ymin},${xmax},${ymax}&geometryType=esriGeometryEnvelope&inSR=4326` +
    `&spatialRel=esriSpatialRelIntersects` +
    `&outFields=${encodeURIComponent('parno,siteadd,scity,mailadd,mcity,mstate,ownname,gisacres,parval,landval,saledate')}` +
    `&returnGeometry=true&maxAllowableOffset=0.0003&outSR=4326&f=geojson`;
  const PAGE = 2000;
  const MAX_PAGES = 30; // up to 60k parcels — effectively uncapped for any realistic scan
  const features: any[] = [];
  let prevFirstParno: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const pageUrl = `${baseUrl}&resultRecordCount=${PAGE}&resultOffset=${page * PAGE}`;
    let fs: any[] = [];
    try {
      const res = await fetchTimeout(pageUrl, 25000);
      if (!res.ok) throw new Error(`GIS HTTP ${res.status}`);
      const data = await res.json();
      if (data?.error) throw new Error(data.error?.message || 'GIS query error');
      fs = Array.isArray(data?.features) ? data.features : [];
    } catch (e: any) {
      if (page === 0) throw new Error(`NC OneMap parcel query failed (${e?.message || 'timeout'}). Try a smaller radius.`);
      break; // a partial pool is fine
    }
    if (!fs.length) break;
    // Guard against servers that ignore resultOffset (would re-send the first page).
    const firstParno = String(fs[0]?.properties?.parno ?? '');
    if (page > 0 && firstParno && firstParno === prevFirstParno) break;
    prevFirstParno = firstParno;
    features.push(...fs);
    onProgress?.(`Querying NC OneMap parcels… (${features.length})`);
    if (fs.length < PAGE) break; // last page
  }

  if (!features.length) throw new Error('No parcels returned for this area. Try a larger radius or a different city/ZIP.');

  onProgress?.(`Prefiltering ${features.length} parcels…`);
  const seen = new Set<string>();
  const seenStreets = new Set<string>(); // collapses condo/townhome units at one address (house mode)
  const candidates: Candidate[] = [];
  for (const f of features) {
    const p = f?.properties || {};
    const parcelId = String(p.parno ?? '').trim();
    if (!parcelId || seen.has(parcelId)) continue;
    const center2 = geomCenter(f.geometry);
    if (!center2) continue;

    const acres = numOf(p.gisacres);
    const assessedValue = numOf(p.parval);
    const landValue = numOf(p.landval);
    const improvementRatio =
      Number.isFinite(assessedValue) && assessedValue > 0
        ? clamp((assessedValue - (Number.isFinite(landValue) ? landValue : 0)) / assessedValue, 0, 1)
        : undefined;
    const siteadd = String(p.siteadd ?? '').trim();
    const scity = String(p.scity ?? '').trim();
    const saleEpoch = numOf(p.saledate);

    if (mode === 'land') {
      if (!Number.isFinite(acres) || acres < minAcres || acres > maxAcres) continue;
      // Near-vacant: <15% of value in structures, or no assessment at all.
      const nearVacant = improvementRatio === undefined ? (landValue > 0 || !(assessedValue > 0)) : improvementRatio < 0.15;
      if (!nearVacant) continue;
    } else {
      // House: a developed, residential-sized lot. The statewide NC OneMap layer
      // leaves parval/landval EMPTY in many counties (Mecklenburg keeps them in a
      // separate CAMA layer), so we must NOT require them. Lot size is the gate;
      // assessment values, when present, only drop clearly-vacant parcels. Vision
      // then judges actual condition/occupancy.
      if (Number.isFinite(acres) && (acres < 0.04 || acres > 6)) continue; // slivers / large tracts
      if (improvementRatio !== undefined && improvementRatio < 0.1) continue; // confirmed raw land
      // Collapse multiple units sharing one street address (condo/townhome towers)
      // so a single building can't consume the whole vision budget.
      const streetKey = siteadd ? siteadd.split(',')[0].trim().toLowerCase().replace(/\s+/g, ' ') : '';
      if (streetKey) {
        if (seenStreets.has(streetKey)) continue;
        seenStreets.add(streetKey);
      }
    }

    seen.add(parcelId);
    const cand: Candidate = {
      parcelId,
      address: siteadd ? `${siteadd}${scity ? `, ${scity}` : ''}, NC` : `${scity || county} County parcel ${parcelId}`,
      addressFromSitus: !!siteadd,
      scity, lat: center2.lat, lng: center2.lng,
      acres: Number.isFinite(acres) ? acres : 0,
      assessedValue: Number.isFinite(assessedValue) ? assessedValue : 0,
      landValue: Number.isFinite(landValue) ? landValue : 0,
      improvementRatio, saleEpoch: Number.isFinite(saleEpoch) ? saleEpoch : undefined,
    };
    if (mode === 'house') {
      // GIS distress / motivated-seller targeting from assessor + ownership data.
      const gd = computeGisDistress({
        siteadd, scity, mailadd: String(p.mailadd ?? ''), mcity: String(p.mcity ?? ''), mstate: String(p.mstate ?? ''),
        ownname: String(p.ownname ?? ''), saleEpoch: cand.saleEpoch,
      });
      cand.ownerName = String(p.ownname ?? '').trim() || undefined;
      cand.absenteeOwner = gd.absenteeOwner;
      cand.outOfState = gd.outOfState;
      cand.ownerType = gd.ownerType;
      cand.yearsSinceSale = gd.yearsSinceSale;
      cand.gisDistress = gd.score;
      cand.gisSignals = gd.signals;
    }
    candidates.push(cand);
  }

  if (!candidates.length) {
    throw new Error(
      mode === 'land'
        ? 'No near-vacant parcels matched in this area/acreage band. Widen the acreage range or radius.'
        : 'No residential parcels matched in this area. Try a larger radius or a different city/ZIP.',
    );
  }

  // Rank the FULL pool best-first (ranking never drops anything — it only orders).
  // The caller then works straight DOWN the ranked list and keeps going until it
  // hits its target or the whole area is exhausted, so ranking never caps the scan.
  if (mode === 'land') {
    // Most-vacant first (lowest share of value in structures), then larger lots.
    candidates.sort((a, b) => (a.improvementRatio ?? 1) - (b.improvementRatio ?? 1) || b.acres - a.acres);
  } else {
    // Likeliest distressed/motivated first: GIS distress-lead score (absentee/
    // out-of-state/estate/long-tenure), then a structure signal (confirmed
    // building > addressed > other), then longest tenure.
    const structureSignal = (c: Candidate) =>
      c.improvementRatio !== undefined ? c.improvementRatio : (/^[1-9]/.test(c.address) ? 0.5 : 0.2);
    candidates.sort(
      (a, b) =>
        (b.gisDistress ?? 0) - (a.gisDistress ?? 0) ||
        structureSignal(b) - structureSignal(a) ||
        (a.saleEpoch ?? Infinity) - (b.saleEpoch ?? Infinity),
    );
  }
  return candidates;
}

/** Convenience: turn a discovered candidate into a full analyzed result. */
export async function analyzeCandidate(c: Candidate, mode: SearchMode, onStage?: (s: string) => void): Promise<PropertyResult> {
  // When the parcel has no situs address (common for vacant land), resolve a real
  // street address from its coordinates instead of showing "County parcel #".
  let address = c.address;
  if (!c.addressFromSitus) {
    onStage?.('Resolving address…');
    const keys = getUserKeys();
    const rev = keys.googleMaps ? await reverseGeocode(c.lat, c.lng, keys.googleMaps) : null;
    if (rev) address = rev;
  }
  return analyzeAtPoint(
    {
      address, lat: c.lat, lng: c.lng, mode,
      parcel: {
        parcelId: c.parcelId, acres: c.acres, assessedValue: c.assessedValue,
        landValue: c.landValue, improvementRatio: c.improvementRatio,
        ownerName: c.ownerName, absenteeOwner: c.absenteeOwner, outOfState: c.outOfState,
        ownerType: c.ownerType, yearsSinceSale: c.yearsSinceSale,
        gisDistress: c.gisDistress, gisSignals: c.gisSignals,
      },
    },
    onStage,
  );
}

// ---------------------------------------------------------------------------
// Investor Buyer List — build a cash-buyer / investor list from county GIS+tax
// records by aggregating parcels per owner. Multi-property owners, LLCs, and
// out-of-state portfolio holders are the people who BUY investment deals.
// Pure GIS (no imagery / AI): fast and free, works for any of NC's 100 counties.
// ---------------------------------------------------------------------------

export interface BuyerListParams {
  county: string;
  city?: string;
  zip?: string;
  radiusMiles: number;   // envelope half-size; a large radius ≈ the whole county
  minProperties: number; // keep owners holding at least this many parcels
  /** Optional deal/subject address (the property you're SELLING). When set, the
   *  search centers on it and each buyer is tagged with the distance from the
   *  deal to their nearest holding — so you can target buyers active in the area. */
  dealAddress?: string;
}

export interface BuyerRecord {
  ownerName: string;
  mailingAddress: string; // street, city, state, zip (as recorded)
  mailCity?: string;
  mailState?: string;
  ownerType: 'individual' | 'company' | 'estate';
  outOfState: boolean;
  propertyCount: number;
  /** How many of their parcels are improved (houses) vs vacant (land). */
  houseCount: number;
  landCount: number;
  /** What they buy, from portfolio mix: 'house', 'land', 'mixed', or 'unknown'. */
  buyerType: 'house' | 'land' | 'mixed' | 'unknown';
  totalAssessedValue: number;
  exampleProperties: string[];     // up to 6 situs addresses they own
  /** Date (epoch ms) of the owner's most recent purchase across their holdings. */
  mostRecentPurchaseEpoch?: number;
  /** The property (situs address) acquired in that most recent purchase. */
  mostRecentProperty?: string;
  /** Miles from the deal address to this owner's NEAREST holding (deal set only). */
  nearestMiles?: number;
}

/** Great-circle distance between two lat/lng points, in miles. */
function haversineMiles(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 3958.8;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Normalize an owner name for grouping (drop punctuation, suffixes, "ET AL"). */
const normOwner = (s?: string) =>
  String(s || '')
    .toUpperCase()
    .replace(/[^A-Z0-9 &]/g, ' ')
    .replace(/\b(ET AL|ETAL|ETUX|ET UX|ETVIR|ET VIR|JR|SR|III|II|IV|TRUSTEE|TRUSTEES)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Build an investor/cash-buyer list for an area from the county GIS parcel/tax
 * records. Pages through every parcel in the envelope (geometry off, so it's
 * light enough to cover a city or most of a county), groups parcels by owner
 * identity (normalized name + mailing street), and returns owners holding at
 * least `minProperties` parcels — the active landlords/investors to market to.
 */
export async function buildBuyerList(
  params: BuyerListParams,
  onProgress?: (s: string) => void,
  shouldStop?: () => boolean,
): Promise<BuyerRecord[]> {
  const { county, city, zip, radiusMiles, minProperties, dealAddress } = params;
  const keys = getUserKeys();
  if (!keys.googleMaps) throw new Error('Google Maps API key required (set it in Account Settings).');
  const cfg = ncCountyConfig[county];
  if (!cfg) throw new Error(`Unsupported county: ${county}`);

  // With a deal address, center the search on it (so the buyers are in its area)
  // and search spatially across county lines. Otherwise center on the city/ZIP/
  // county and restrict to the selected county.
  let center: { lat: number; lng: number };
  let deal: { lat: number; lng: number } | undefined;
  if (dealAddress && dealAddress.trim()) {
    onProgress?.('Locating the deal address…');
    const d = await geocodeAddress(dealAddress.trim(), keys.googleMaps);
    if (!d) throw new Error(`Could not locate the deal address "${dealAddress.trim()}".`);
    deal = d;
    center = { lat: d.lat, lng: d.lng };
  } else {
    onProgress?.('Locating area…');
    const areaQuery = city ? `${city}, NC` : zip ? `${zip}, NC` : `${county} County, NC`;
    const c = await geocodeAddress(areaQuery, keys.googleMaps);
    if (!c) throw new Error(`Could not locate "${areaQuery}".`);
    center = c;
  }

  const dLat = radiusMiles / 69;
  const dLng = radiusMiles / (69 * Math.cos((center.lat * Math.PI) / 180) || 1);
  const env = `${center.lng - dLng},${center.lat - dLat},${center.lng + dLng},${center.lat + dLat}`;

  // No deal → no geometry (tiny rows, page deeply across a county). With a deal we
  // request simplified geometry (geojson) so we can measure each owner's nearest
  // holding to the deal. `where=1=1` for deal mode keeps it spatial/cross-county.
  const where = deal ? '1=1' : cfg.extraWhere;
  const geomParams = deal
    ? '&returnGeometry=true&maxAllowableOffset=0.0003&outSR=4326&f=geojson'
    : '&returnGeometry=false&f=json';
  const baseUrl =
    `${cfg.parcelUrl}?where=${encodeURIComponent(where)}` +
    `&geometry=${env}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects` +
    `&outFields=${encodeURIComponent('parno,siteadd,scity,ownname,mailadd,mcity,mstate,mzip,parval,landval,saledate')}` +
    geomParams;
  const PAGE = 2000;
  const MAX_PAGES = 100; // up to 200k parcels — county-scale (rows are tiny w/o geometry)

  type Agg = {
    ownerName: string; mailadd: string; mcity: string; mstate: string; mzip: string;
    ownerType: 'individual' | 'company' | 'estate'; outOfState: boolean;
    count: number; houseCount: number; landCount: number;
    totalAssessed: number; examples: string[];
    recentSale?: number; recentProperty?: string;
    minDist?: number;
  };
  const groups = new Map<string, Agg>();
  let scanned = 0;
  let prevFirstParno: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    if (shouldStop?.()) break;
    const pageUrl = `${baseUrl}&resultRecordCount=${PAGE}&resultOffset=${page * PAGE}`;
    let rows: any[] = [];
    try {
      const res = await fetchTimeout(pageUrl, 25000);
      if (!res.ok) throw new Error(`GIS HTTP ${res.status}`);
      const data = await res.json();
      if (data?.error) throw new Error(data.error?.message || 'GIS query error');
      rows = Array.isArray(data?.features) ? data.features : [];
    } catch (e: any) {
      if (page === 0) throw new Error(`NC OneMap parcel query failed (${e?.message || 'timeout'}). Try a smaller radius.`);
      break;
    }
    if (!rows.length) break;
    // f=json rows carry `.attributes`; f=geojson rows carry `.properties` + `.geometry`.
    const attrsOf = (f: any) => f.attributes || f.properties || {};
    const firstParno = String(attrsOf(rows[0]).parno ?? '');
    if (page > 0 && firstParno && firstParno === prevFirstParno) break; // offset ignored
    prevFirstParno = firstParno;

    for (const f of rows) {
      const a = attrsOf(f);
      const owner = String(a.ownname ?? '').trim();
      if (!owner) continue;
      const ownerType = classifyOwner(owner);
      if (ownerType === 'public') continue; // governments aren't buyers
      const mailadd = String(a.mailadd ?? '').trim();
      const key = `${normOwner(owner)}|${normStreet(mailadd)}`;
      if (!key.replace('|', '').trim()) continue;

      let g = groups.get(key);
      if (!g) {
        const mstate = String(a.mstate ?? '').trim().toUpperCase();
        g = {
          ownerName: owner, mailadd, mcity: String(a.mcity ?? '').trim(), mstate,
          mzip: String(a.mzip ?? '').trim(),
          ownerType: ownerType === 'estate' ? 'estate' : ownerType, // never 'public' here
          outOfState: !!mstate && mstate !== 'NC',
          count: 0, houseCount: 0, landCount: 0, totalAssessed: 0, examples: [],
        };
        groups.set(key, g);
      }
      g.count++;
      const pv = numOf(a.parval);
      const lv = numOf(a.landval);
      if (Number.isFinite(pv)) g.totalAssessed += pv;
      // Classify this parcel as improved (house) vs vacant (land) from the
      // assessor's land-vs-total value — same near-vacant rule the finder uses
      // (<15% of value in structures = land). Parcels with no assessment on
      // record stay unclassified (they count toward the total only).
      if (Number.isFinite(pv) && pv > 0) {
        const imp = (pv - (Number.isFinite(lv) && lv > 0 ? lv : 0)) / pv;
        if (imp < 0.15) g.landCount++; else g.houseCount++;
      } else if (Number.isFinite(lv) && lv > 0) {
        g.landCount++;
      }
      const situs = String(a.siteadd ?? '').trim();
      if (situs && g.examples.length < 6 && !g.examples.includes(situs)) g.examples.push(situs);
      // Track the owner's MOST RECENT purchase (date + which property). The parcel
      // layer carries each parcel's last sale date, so the max across an owner's
      // holdings is their latest acquisition; re-running picks up new deeds.
      const sale = numOf(a.saledate);
      if (Number.isFinite(sale) && (g.recentSale == null || sale > g.recentSale)) {
        g.recentSale = sale;
        g.recentProperty = situs || undefined;
      }
      // Distance from the deal to this holding → track the owner's nearest.
      if (deal && f.geometry) {
        const c = geomCenter(f.geometry);
        if (c) {
          const d = haversineMiles(deal.lat, deal.lng, c.lat, c.lng);
          if (g.minDist == null || d < g.minDist) g.minDist = d;
        }
      }
    }
    scanned += rows.length;
    onProgress?.(`Scanning parcels… (${scanned})`);
    if (rows.length < PAGE) break; // last page
  }

  if (!scanned) throw new Error('No parcels returned for this area. Try a larger radius or a different city/ZIP.');

  const list: BuyerRecord[] = [];
  for (const g of groups.values()) {
    if (g.count < minProperties) continue;
    const mailingAddress = [g.mailadd, [g.mcity, g.mstate].filter(Boolean).join(', '), g.mzip].filter(Boolean).join(', ');
    list.push({
      ownerName: g.ownerName,
      mailingAddress: mailingAddress || 'N/A',
      mailCity: g.mcity || undefined,
      mailState: g.mstate || undefined,
      ownerType: g.ownerType,
      outOfState: g.outOfState,
      propertyCount: g.count,
      houseCount: g.houseCount,
      landCount: g.landCount,
      buyerType:
        g.houseCount > 0 && g.landCount > 0 ? 'mixed'
        : g.houseCount > 0 ? 'house'
        : g.landCount > 0 ? 'land'
        : 'unknown',
      totalAssessedValue: Math.round(g.totalAssessed),
      exampleProperties: g.examples,
      mostRecentPurchaseEpoch: g.recentSale,
      mostRecentProperty: g.recentProperty,
      nearestMiles: g.minDist != null ? Math.round(g.minDist * 100) / 100 : undefined,
    });
  }
  if (!list.length) {
    throw new Error(`No owners hold ${minProperties}+ parcels in this area. Lower the minimum, or widen the radius.`);
  }
  if (deal) {
    // Closest active buyers to the deal first, then biggest portfolios.
    list.sort((a, b) => (a.nearestMiles ?? Infinity) - (b.nearestMiles ?? Infinity) || b.propertyCount - a.propertyCount);
  } else {
    // Biggest portfolios first (strongest buyers), then highest total value.
    list.sort((a, b) => b.propertyCount - a.propertyCount || b.totalAssessedValue - a.totalAssessedValue);
  }
  return list;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function resultsToCsv(results: PropertyResult[]): string {
  const headers = [
    'address', 'mode', 'score', 'score_label', 'confidence',
    'lat', 'lng', 'parcel_id', 'acres', 'assessed_value', 'land_value',
    'owner', 'owner_type', 'absentee_owner', 'out_of_state', 'years_owned', 'gis_distress_score',
    'flood_zone', 'flood_score', 'wetlands', 'wetland_score', 'builder_interest',
    'reasons', 'recommendation', 'ai_summary',
  ];
  const esc = (v: unknown) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = results.map((r) => [
    r.address, r.mode, r.score, r.scoreLabel, r.confidence.toFixed(2),
    r.lat, r.lng,
    r.parcel?.parcelId ?? '', r.parcel?.acres ?? '', r.parcel?.assessedValue ?? '', r.parcel?.landValue ?? '',
    r.parcel?.ownerName ?? '', r.parcel?.ownerType ?? '', r.parcel?.absenteeOwner ?? '', r.parcel?.outOfState ?? '',
    r.parcel?.yearsSinceSale != null ? Math.round(r.parcel.yearsSinceSale) : '', r.parcel?.gisDistress ?? '',
    r.flood?.label ?? '', r.flood?.score ?? '', r.wetlands?.label ?? '', r.wetlands?.score ?? '', r.builderInterest ?? '',
    r.reasons.join('; '), r.recommendation, r.observations.summary || '',
  ].map(esc).join(','));
  return [headers.join(','), ...rows].join('\n');
}

export function buyersToCsv(buyers: BuyerRecord[]): string {
  const headers = [
    'owner', 'owner_type', 'buys', 'house_count', 'land_count', 'out_of_state',
    'property_count', 'total_assessed_value', 'nearest_miles_to_deal',
    'mailing_address', 'mail_city', 'mail_state',
    'most_recent_purchase_date', 'most_recent_property', 'example_properties',
  ];
  const esc = (v: unknown) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const fmtDate = (e?: number) => {
    if (!e) return '';
    const d = new Date(e);
    return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
  };
  const rows = buyers.map((b) => [
    b.ownerName, b.ownerType, b.buyerType, b.houseCount, b.landCount, b.outOfState,
    b.propertyCount, b.totalAssessedValue, b.nearestMiles ?? '',
    b.mailingAddress, b.mailCity ?? '', b.mailState ?? '',
    fmtDate(b.mostRecentPurchaseEpoch), b.mostRecentProperty ?? '', b.exampleProperties.join('; '),
  ].map(esc).join(','));
  return [headers.join(','), ...rows].join('\n');
}

export function downloadFile(filename: string, content: string, mime = 'text/plain') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
