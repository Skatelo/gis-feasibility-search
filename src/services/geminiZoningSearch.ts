export interface GeminiZoningSearchEvidence {
  fullAddress: string;
  requestedQuery: string;
  searchQueries: string[];
  raw: string;
  urls: string[];
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

// Zoning search models in priority order. gemini-3-flash-preview grounds as
// accurately as the flagship (same district across repeated tests) but answers
// ~2x faster; gemini-3.5-flash is the stable fallback if the preview model is
// ever retired (a retired model answers HTTP 404, which triggers the fallback).
export const GEMINI_ZONING_MODELS = ['gemini-3-flash-preview', 'gemini-3.5-flash'] as const;
export const GEMINI_ZONING_MODEL = GEMINI_ZONING_MODELS[0];
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

export function buildGeminiZoningSearchPrompt(address: string, countyName = ''): string {
  const fullAddress = normalizeFullAddressForZoning(address);
  const requestedQuery = `What is ${fullAddress} zoning code`;
  const jurisdictionHint = compactText(countyName)
    ? `The detected county is ${compactText(countyName)}; confirm the actual county or municipal zoning authority from sources.`
    : 'Confirm the county or municipal zoning authority from sources.';

  return `Search Google now for this exact query:
"${requestedQuery}"

The complete address must remain verbatim in every search used to identify this parcel. ${jurisdictionHint}

Continue with additional exact-address searches as needed to find the parcel-specific district. Search official county or municipal GIS and planning sources first. Exact-address Zillow, Realtor, and Redfin pages are fallback assignment evidence only. After identifying the district, find the adopted ordinance or official code that publishes its setbacks, restrictions, permitted uses, height, lot area, lot coverage, and floor-area ratio.

First, write a comprehensive, detailed zoning and development report for the property in clear markdown format. Explain the zoning district, setbacks (front, rear, side), height limits, building coverage limits, accessory dwelling unit (ADU) rules, and allowed uses. Include clear headings and bold key figures.

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
): Promise<GeminiZoningSearchEvidence> {
  const fullAddress = normalizeFullAddressForZoning(address);
  const key = apiKey.trim();
  if (!fullAddress) throw new Error('A full property address is required for zoning search.');
  if (!key) throw new Error('A Gemini API key is required for zoning search.');

  const requestedQuery = `What is ${fullAddress} zoning code`;
  const input = buildGeminiZoningSearchPrompt(fullAddress, countyName);

  // Try each model in priority order. A retired/unknown model answers HTTP 404,
  // so we transparently fall back to the next one instead of failing the lookup.
  let lastError: Error | null = null;
  for (let modelIndex = 0; modelIndex < GEMINI_ZONING_MODELS.length; modelIndex++) {
    const body = JSON.stringify({
      model: GEMINI_ZONING_MODELS[modelIndex],
      input,
      system_instruction: ZONING_SYSTEM,
      store: false,
      tools: [{ type: 'google_search' }],
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
        if (!parsed.raw) throw new Error('Gemini zoning search returned no structured answer.');
        return { fullAddress, requestedQuery, ...parsed };
      }

      // Model unavailable (e.g. a preview model was retired) — stop retrying it
      // and fall through to the next model in the list.
      if (response.status === 404 && modelIndex < GEMINI_ZONING_MODELS.length - 1) {
        lastError = new Error(`Gemini zoning model ${GEMINI_ZONING_MODELS[modelIndex]} is unavailable (HTTP 404).`);
        break;
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === 1) {
        throw new Error(`Gemini zoning search returned HTTP ${response.status}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(response, attempt)));
    }
  }

  throw lastError ?? new Error('Gemini zoning search did not return a response.');
}
