export interface GeminiZoningSearchEvidence {
  fullAddress: string;
  requestedQuery: string;
  searchQueries: string[];
  raw: string;
  urls: string[];
}

export interface OfficialZoningEvidenceHint {
  code: string;
  description?: string | null;
  sourceUrl?: string;
  jurisdiction?: string;
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

// Zoning search model. Keep this list-shaped contract because the lookup loop
// handles retries consistently even when only one production model is enabled.
export const GEMINI_ZONING_MODELS = ['gemini-3.6-flash'] as const;
export const GEMINI_ZONING_MODEL = GEMINI_ZONING_MODELS[0];

// Zoning district identification needs the model's full agentic search depth.
// 'low' thinking made it flip to the WRONG district (e.g. S-R / City of Belmont
// instead of R-1 / unincorporated Gaston County) and return sparse permittedUses
// (which also starved the comps type filter). 'high' (the model default) reliably
// pins the correct district + full permitted uses. Slower (~30-60s), but accuracy
// is the whole point and the 120s timeout covers it.
export const GEMINI_ZONING_THINKING_LEVEL = 'high';
export const GEMINI_INTERACTIONS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';

const ZONING_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    zoningCode: { type: 'string' },
    zoningDescription: { type: 'string' },
    jurisdiction: { type: 'string' },
    matchMethod: {
      type: 'string',
      enum: [
        'parcel-gis',
        'official-address-result',
        'official-parcel-report',
        'corroborated-listings',
        'listing-address-result',
        'unresolved',
      ],
    },
    parcelSource: { type: 'string' },
    listingSources: { type: 'array', items: { type: 'string' } },
    ordinanceSource: { type: 'string' },
    standards: {
      type: 'object',
      additionalProperties: false,
      properties: {
        lotType: { type: 'string' },
        maxHeightFt: { type: 'number' },
        floorAreaRatio: { type: 'number' },
        frontSetbackFt: { type: 'number' },
        rearSetbackFt: { type: 'number' },
        sideSetbackFt: { type: 'number' },
        setbackNotes: { type: 'array', items: { type: 'string' } },
        minimumLotAreaSqft: { type: 'number' },
        maxLotCoveragePct: { type: 'number' },
        restrictions: { type: 'array', items: { type: 'string' } },
      },
    },
    permittedUses: { type: 'array', items: { type: 'string' } },
    sources: { type: 'array', items: { type: 'string' } },
  },
  required: ['zoningCode', 'zoningDescription', 'jurisdiction', 'matchMethod', 'sources'],
} as const;

const ZONING_SYSTEM = `You are a source-grounded zoning research analyst. Use Gemini's built-in Google Search tool for every answer. Search the exact complete property address and keep the full address in every parcel-identification query. Prefer official parcel GIS, official address results, and official parcel reports. If official parcel-assignment evidence cannot be found, an exact-address Zillow, Realtor, or Redfin record may be reported, and two independent matching listing providers may be corroborated. Never call listing evidence official. An ordinance alone cannot assign a zoning district to a parcel. Setbacks, dimensional standards, permitted uses, and restrictions require an adopted ordinance or official zoning-code source after the parcel district is identified. Include direct source URLs in the JSON. Never fabricate a district, URL, setback, restriction, or allowance.`;

function compactText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function cleanUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

/** Keep the exact street/city/ZIP supplied by the address search, expand the
 * Carolina abbreviation, and include the country in every zoning lookup. */
export function normalizeFullAddressForZoning(value: string): string {
  const compact = String(value || '').replace(/\s+/g, ' ').trim().replace(/,+$/, '');
  if (!compact) return '';
  const withoutCountry = compact
    .replace(/,?\s*(?:United States(?: of America)?|USA|U\.S\.A\.|US)\.?$/i, '')
    .replace(/,+$/, '')
    .trim();
  const expandedState = withoutCountry
    .replace(/(?:,\s*|\s+)NC\b(?=\s+\d{5}(?:-\d{4})?(?:,|$)|,|$)/i, ', North Carolina')
    .replace(/(?:,\s*|\s+)SC\b(?=\s+\d{5}(?:-\d{4})?(?:,|$)|,|$)/i, ', South Carolina');
  return `${expandedState}, United States`;
}

export function buildGeminiZoningSearchPrompt(
  address: string,
  countyName = '',
  jurisdiction = '',
  officialEvidence?: OfficialZoningEvidenceHint,
): string {
  const fullAddress = normalizeFullAddressForZoning(address);
  const requestedQuery = `What is ${fullAddress} zoning code`;
  const jurisdictionHint = compactText(jurisdiction)
    ? `AUTHORITATIVE JURISDICTION (from U.S. Census place boundaries at the exact parcel point): this parcel is ${compactText(jurisdiction)}. Use THAT authority's adopted zoning ordinance for the code. Do NOT assume the postal/mailing city is the zoning authority — a mailing address like "Belmont" is frequently UNINCORPORATED county land governed by the COUNTY's zoning code, not the city's.`
    : compactText(countyName)
      ? `The detected county is ${compactText(countyName)}; confirm the actual county or municipal zoning authority from sources.`
      : 'Confirm the county or municipal zoning authority from sources.';
  const officialHint = officialEvidence?.code
    ? `An official zoning polygon queried at this parcel point returned district "${compactText(officialEvidence.code)}"${officialEvidence.description ? ` (${compactText(officialEvidence.description)})` : ''}${officialEvidence.jurisdiction ? ` for ${compactText(officialEvidence.jurisdiction)}` : ''}${officialEvidence.sourceUrl ? ` from ${officialEvidence.sourceUrl}` : ''}. Treat this as the parcel-assignment lead, verify it in Google Search, and focus the remaining search on the adopted standards for that exact district. Do not replace it with a listing's different code.`
    : '';

  return `Search Google now for this exact query:
"${requestedQuery}"

The complete address must remain verbatim in every search used to identify this parcel. ${jurisdictionHint} ${officialHint}

Continue with additional exact-address searches as needed to find the parcel-specific district. Search official county or municipal GIS and planning sources first. Exact-address Zillow, Realtor, and Redfin pages are fallback assignment evidence only. After identifying the district, find the adopted ordinance or official code that publishes its setbacks, restrictions, permitted uses, height, lot area, lot coverage, and floor-area ratio. For the STANDARDS, open the jurisdiction's adopted zoning ordinance and read the DIMENSIONAL-STANDARDS TABLE for THIS EXACT district — report that district's own row: front, side, and rear setbacks, maximum height, minimum lot area, maximum lot coverage, and floor-area ratio, and cite the ordinance section. Report only figures explicitly published for this district; omit a value rather than estimating it or borrowing it from a different district.

The permittedUses array drives sold-comparable searches. Read the official use table and enumerate every residential form that is permitted by right or conditionally permitted in this exact district. Check each form separately: single-family detached, manufactured/mobile home, townhouse, condominium, duplex/two-family, triplex/three-family, quadplex/four-family, multifamily with five or more units, and multiple principal residential buildings or dwellings on one lot. Include only forms the ordinance affirmatively allows, label conditional uses as conditional, and do not copy prohibited uses into permittedUses.

First, write a comprehensive, detailed zoning and development report for the property in clear markdown format. Lead with the EXACT adopted zoning CODE (e.g. R-1, RS-8, MF-2) as published by the jurisdiction's official GIS/ordinance — the specific code, not a generic label. Then explain that district, its setbacks (front, rear, side), height limits, building coverage limits, accessory dwelling unit (ADU) rules, and allowed uses. Include clear headings and bold key figures.

Then, at the very end of your response, output a single JSON block wrapped in \`\`\`json and \`\`\` containing the structured fields matching the following schema. Use an empty string, empty array, or omit an optional standards field when grounded sources do not publish it. Set matchMethod to "unresolved" if the district cannot be confirmed.

JSON SCHEMA:
${JSON.stringify(ZONING_RESPONSE_SCHEMA, null, 2)}

Every URL in the JSON must come from the Google Search results used for this answer.`;
}

function annotationsFrom(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function addSearchQuery(target: Set<string>, value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => addSearchQuery(target, entry));
    return;
  }
  if (typeof value === 'string') {
    const query = compactText(value);
    if (query) target.add(query);
  }
}

function addCitationUrls(target: Set<string>, annotations: unknown): void {
  for (const annotation of annotationsFrom(annotations)) {
    if (String(annotation?.type || '').toLowerCase() !== 'url_citation') continue;
    const url = cleanUrl(annotation?.url ?? annotation?.url_citation?.url);
    if (url) target.add(url);
  }
}

/** Extract the final structured answer and direct Google Search citations from
 * the current Interactions API `steps` response. */
export function parseGeminiZoningInteraction(data: any): {
  raw: string;
  urls: string[];
  searchQueries: string[];
} {
  const steps = Array.isArray(data?.steps) ? data.steps : [];
  const modelOutputs: string[] = [];
  const urls = new Set<string>();
  const searchQueries = new Set<string>();

  for (const step of steps) {
    const type = String(step?.type || '').toLowerCase();
    if (type === 'google_search_call') {
      addSearchQuery(searchQueries, step?.query);
      addSearchQuery(searchQueries, step?.queries);
      addSearchQuery(searchQueries, step?.arguments?.query);
      addSearchQuery(searchQueries, step?.arguments?.queries);
      addSearchQuery(searchQueries, step?.input?.query);
      addSearchQuery(searchQueries, step?.input?.queries);
    }
    if (type !== 'model_output') continue;

    const blocks = Array.isArray(step?.content) ? step.content : [];
    const text = blocks
      .map((block: any) => typeof block?.text === 'string' ? block.text : '')
      .filter(Boolean)
      .join('\n')
      .trim();
    if (text) modelOutputs.push(text);
    blocks.forEach((block: any) => addCitationUrls(urls, block?.annotations));
    addCitationUrls(urls, step?.annotations);
  }

  return {
    raw: modelOutputs.at(-1) || '',
    urls: [...urls],
    searchQueries: [...searchQueries],
  };
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = Number(response.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(2500, retryAfter * 1000);
  return Math.min(2500, 1000 * (2 ** attempt));
}

export async function fetchGeminiZoningSearchEvidence(
  address: string,
  apiKey: string,
  countyName = '',
  fetcher: FetchLike = fetch,
  jurisdiction = '',
  officialEvidence?: OfficialZoningEvidenceHint,
): Promise<GeminiZoningSearchEvidence> {
  const fullAddress = normalizeFullAddressForZoning(address);
  const key = apiKey.trim();
  if (!fullAddress) throw new Error('A full property address is required for zoning search.');
  if (!key) throw new Error('A Gemini API key is required for zoning search.');

  const requestedQuery = `What is ${fullAddress} zoning code`;
  const input = buildGeminiZoningSearchPrompt(fullAddress, countyName, jurisdiction, officialEvidence);

  // Try each model in priority order. If a model is unavailable, errors, or
  // returns an unusable answer, transparently fall back to the next one instead
  // of failing the whole zoning lookup. Only the last model's failure surfaces.
  let lastError: Error | null = null;
  for (let modelIndex = 0; modelIndex < GEMINI_ZONING_MODELS.length; modelIndex++) {
    const model = GEMINI_ZONING_MODELS[modelIndex];
    const isLastModel = modelIndex === GEMINI_ZONING_MODELS.length - 1;
    const body = JSON.stringify({
      model,
      input,
      system_instruction: ZONING_SYSTEM,
      store: false,
      tools: [{ type: 'google_search' }],
      generation_config: { thinking_level: GEMINI_ZONING_THINKING_LEVEL },
    });

    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetcher(GEMINI_INTERACTIONS_ENDPOINT, {
        method: 'POST',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'x-goog-api-key': key,
        },
        body,
      });

      if (response.ok) {
        const parsed = parseGeminiZoningInteraction(await response.json());
        if (parsed.raw) return { fullAddress, requestedQuery, ...parsed };
        // 200 OK but no usable answer — record it and fall back to the next model.
        lastError = new Error(`Gemini zoning model ${model} returned no structured answer.`);
        break;
      }

      // Retry transient errors once on the SAME model before moving on.
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs(response, attempt)));
        continue;
      }

      // Any other failure (404, 400, 401/403, or exhausted retries) — stop
      // retrying this model and fall back to the next one in the list.
      lastError = new Error(`Gemini zoning model ${model} returned HTTP ${response.status}.`);
      break;
    }

    // This model produced no usable answer. Fall back to the next model; if this
    // was the last one, stop and surface the error below.
    if (isLastModel) break;
  }

  throw lastError ?? new Error('Gemini zoning search did not return a response.');
}
