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

import { getUserKeys } from './feasibilityService';

export type SearchMode = 'house' | 'land' | 'builder';

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

Return ONLY a JSON object inside a \`\`\`json code block. Use numeric 0-100 scores (integers) and booleans exactly as specified. If a field cannot be judged from the imagery, use a conservative value and lower your overall "confidence".`;

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
For the *_score fields: 0 = pristine/well-maintained, 100 = severe distress.`;
  }

  if (mode === 'builder') {
    return `${shared}

This is a BUILDER-LOT assessment: would a homebuilder buy this parcel? Detect whether the parcel is vacant/buildable, road frontage, visible utilities/power lines, tree coverage, water/wetland indicators, terrain slope, flood signals, and especially DEVELOPMENT ACTIVITY nearby (adjacent new construction, graded lots, similar-sized residential lots).

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
slope_score: 0 = flat, 100 = steep. flood_indicator_score: 0 = none, 100 = strong wetland/flood signal. development_activity_score: 0 = none, 100 = heavy adjacent new construction.`;
  }

  // land
  return `${shared}

This is a VACANT-LAND buildability assessment. Detect whether the parcel is vacant/cleared, road frontage / access roads, visible utilities/power lines, tree coverage percentage, water/wetland indicators, terrain slope, flood signals, nearby development, and any agricultural/commercial use or encroachments.

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

function parseVisionJson(text: string): VisionObservations | null {
  const m = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/\{[\s\S]*\}/);
  const jsonStr = m ? (m[1] || m[0]) : '';
  if (!jsonStr) return null;
  try {
    return JSON.parse(jsonStr) as VisionObservations;
  } catch {
    return null;
  }
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

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Gemini Vision API error ${res.status}: ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('') || '';
  const obs = parseVisionJson(text);
  if (!obs) throw new Error('Gemini Vision returned no parseable JSON observations.');
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

/** Buildability score. Weights: road frontage 20%, utilities 20%, slope 20%, flood 20%, dev proximity 20%. */
export function computeBuildabilityScore(o: VisionObservations): number {
  const frontage = o.road_frontage ? 100 : 25;
  const utilities = o.utility_visibility ? 100 : 40;
  const slope = clamp(100 - num(o.slope_score));            // flatter = better
  const flood = clamp(100 - num(o.flood_indicator_score));  // less flood = better
  const dev = clamp(num(o.development_activity_score));
  let score = frontage * 0.2 + utilities * 0.2 + slope * 0.2 + flood * 0.2 + dev * 0.2;
  if (o.water_or_wetland_indicators) score -= 8;
  if (o.encroachments) score -= 6;
  return Math.round(clamp(score));
}

/** Builder-interest score: leans on nearby development + buildability fundamentals. */
export function computeBuilderScore(o: VisionObservations): number {
  const build = computeBuildabilityScore(o);
  const dev = clamp(num(o.development_activity_score));
  const vacantBonus = o.vacant ? 5 : -10;
  const treePenalty = num(o.tree_coverage_percent) > 70 ? -8 : 0;
  return Math.round(clamp(build * 0.5 + dev * 0.5 + vacantBonus + treePenalty));
}

function buildReasons(mode: SearchMode, o: VisionObservations): string[] {
  if (Array.isArray(o.reasons) && o.reasons.length) return o.reasons.slice(0, 6);
  const r: string[] = [];
  if (mode === 'house') {
    if (num(o.roof_condition_score) >= 50) r.push('roof deterioration');
    if (num(o.exterior_condition_score) >= 50) r.push('exterior deterioration');
    if (num(o.yard_condition_score) >= 50) r.push('overgrown / unkempt yard');
    if (o.vacant || num(o.vacancy_indicator_score) >= 50) r.push('vacancy indicators');
  } else {
    if (o.road_frontage) r.push('road frontage');
    if (o.utility_visibility) r.push('utilities nearby');
    if (num(o.development_activity_score) >= 50) r.push('nearby development activity');
    if (num(o.tree_coverage_percent) >= 60) r.push('heavy tree coverage');
    if (o.water_or_wetland_indicators) r.push('possible wetlands/water');
  }
  return r.length ? r : ['see AI summary'];
}

function recommend(mode: SearchMode, score: number): string {
  if (mode === 'house') {
    if (score >= 75) return 'Strong wholesale / fix-and-flip candidate — prioritize outreach';
    if (score >= 50) return 'Moderate distress — worth a closer look / drive-by';
    return 'Low distress — likely owner-occupied / maintained';
  }
  if (mode === 'builder') {
    if (score >= 75) return 'High builder interest — comparable to active build areas';
    if (score >= 50) return 'Possible builder lot — verify utilities & zoning';
    return 'Unlikely builder target right now';
  }
  if (score >= 75) return 'Highly buildable — pursue feasibility / due diligence';
  if (score >= 50) return 'Buildable with constraints — verify access & utilities';
  return 'Significant constraints — slope/flood/access concerns';
}

// ---------------------------------------------------------------------------
// End-to-end: analyze one property
// ---------------------------------------------------------------------------

export async function analyzeProperty(
  address: string,
  mode: SearchMode,
  onStage?: (s: string) => void,
): Promise<PropertyResult> {
  const keys = getUserKeys();
  if (!keys.googleMaps) throw new Error('Google Maps API key required (set it in Account Settings).');
  if (!keys.gemini) throw new Error('Gemini API key required (set it in Account Settings).');

  onStage?.('Geocoding address…');
  const coords = await geocodeAddress(address, keys.googleMaps);
  if (!coords) throw new Error(`Could not geocode "${address}".`);

  onStage?.('Acquiring satellite + street-view imagery…');
  const satelliteUrl = buildSatelliteUrl(coords.lat, coords.lng, keys.googleMaps);
  const svExists = await hasStreetView(coords.lat, coords.lng, keys.googleMaps);
  const streetViewUrl = svExists ? buildStreetViewUrl(coords.lat, coords.lng, keys.googleMaps) : null;

  onStage?.('Encoding imagery for Gemini Vision…');
  const inlineImages: Array<{ mimeType: string; data: string }> = [];
  const sat = await imageUrlToInlineData(satelliteUrl);
  if (sat) inlineImages.push(sat);
  if (streetViewUrl) {
    const sv = await imageUrlToInlineData(streetViewUrl);
    if (sv) inlineImages.push(sv);
  }

  onStage?.('Gemini Vision analyzing imagery…');
  const observations = await geminiVisionAnalyze(inlineImages, mode, keys.gemini);

  const score =
    mode === 'house' ? computeDistressScore(observations)
    : mode === 'builder' ? computeBuilderScore(observations)
    : computeBuildabilityScore(observations);

  const scoreLabel =
    mode === 'house' ? 'Distress Score'
    : mode === 'builder' ? 'Builder Score'
    : 'Buildability Score';

  return {
    id: `${mode}-${coords.lat.toFixed(5)},${coords.lng.toFixed(5)}-${Date.now()}`,
    address,
    mode,
    lat: coords.lat,
    lng: coords.lng,
    imagery: { satelliteUrl, streetViewUrl, hasStreetView: svExists },
    observations,
    confidence: clamp(num(observations.confidence, 0.7) * 100, 0, 100) / 100,
    score,
    scoreLabel,
    reasons: buildReasons(mode, observations),
    recommendation: recommend(mode, score),
    analyzedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function resultsToCsv(results: PropertyResult[]): string {
  const headers = [
    'address', 'mode', 'score', 'score_label', 'confidence',
    'lat', 'lng', 'reasons', 'recommendation', 'ai_summary',
  ];
  const esc = (v: unknown) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = results.map((r) => [
    r.address, r.mode, r.score, r.scoreLabel, r.confidence.toFixed(2),
    r.lat, r.lng, r.reasons.join('; '), r.recommendation, r.observations.summary || '',
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
