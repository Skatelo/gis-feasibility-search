import type { CompDateWindow, ResidentialCompType } from '../../types/feasibility';

export type CompSearchFamily = 'single-family' | 'townhouse' | 'condo' | 'multi-family' | 'mobile';
export type ClassifiedCompType = ResidentialCompType | 'land' | 'unknown';

export interface CompTypeClassification {
  type: ClassifiedCompType;
  label?: string;
  unitCount?: number;
  structureCount?: number;
  evidence?: string;
}

export const RESIDENTIAL_COMP_TYPE_ORDER: ResidentialCompType[] = [
  'single-family',
  'mobile',
  'townhouse',
  'condo',
  'duplex',
  'triplex',
  'quadplex',
  'multi-family',
  'multi-structure',
];

const TYPE_LABELS: Record<ResidentialCompType, string> = {
  'single-family': 'Single-Family',
  mobile: 'Mobile/Manufactured',
  townhouse: 'Townhouse',
  condo: 'Condo',
  duplex: 'Duplex',
  triplex: 'Triplex',
  quadplex: 'Quadplex',
  'multi-family': 'Multi-Family',
  'multi-structure': 'Multiple Residential Structures',
};

const PROHIBITED_USE_RE = /\b(?:not\s+permitted|not\s+allowed|prohibited|forbidden|excluded|shall\s+not|may\s+not)\b/i;
const SINGLE_FAMILY_RE = /\b(?:single[-\s]?family|one[-\s]?family|sfr|detached\s+(?:house|home|dwelling)|site[-\s]?built\s+(?:house|home|dwelling))\b/i;
const TOWNHOUSE_RE = /\b(?:town[-\s]?(?:home|house)s?|row[-\s]?houses?|attached\s+(?:single[-\s]?family|dwelling|home))\b/i;
const CONDO_RE = /\bcondo(?:minium)?s?\b/i;
const DUPLEX_RE = /\b(?:duplex(?:es)?|two[-\s]?family|2[-\s]?(?:family|unit)|two[-\s]?(?:unit|dwelling))\b/i;
const TRIPLEX_RE = /\b(?:triplex(?:es)?|three[-\s]?family|3[-\s]?(?:family|unit)|three[-\s]?(?:unit|dwelling))\b/i;
const QUADPLEX_RE = /\b(?:quad(?:ru)?plex(?:es)?|fourplex(?:es)?|four[-\s]?family|4[-\s]?(?:family|unit)|four[-\s]?(?:unit|dwelling))\b/i;
const MULTIFAMILY_RE = /\b(?:multi[-\s]?family|multifamily|apartment(?:s|\s+building)?|five[-\s]?family|5\+?[-\s]?(?:family|unit))\b/i;
const MOBILE_RE = /\b(?:manufactured\s+(?:home|housing|dwelling)|mobile\s+home|hud[-\s]?code\s+(?:home|housing))s?\b/i;
const MULTI_STRUCTURE_RE = /\b(?:multiple|more\s+than\s+one|two\s+or\s+more|several)\s+(?:principal\s+)?(?:residential\s+)?(?:buildings|structures|homes|houses|residences|dwellings)\b|\b(?:residential\s+compound|cottage\s+court|multi[-\s]?building\s+residential|multiple[-\s]?structure\s+residential)\b/i;
const LAND_RE = /\b(?:vacant\s+land|raw\s+land|residential\s+lot|land|acreage)\b/i;

const STREET_SUFFIXES: Record<string, string> = {
  street: 'st', avenue: 'ave', av: 'ave', drive: 'dr', road: 'rd', lane: 'ln', court: 'ct',
  circle: 'cir', boulevard: 'blvd', place: 'pl', terrace: 'ter', trail: 'trl', parkway: 'pkwy',
  highway: 'hwy', cove: 'cv', crossing: 'xing', square: 'sq', drives: 'dr', roads: 'rd',
};

const UNIT_RE = /(?:\b(?:apt|apartment|unit|ste|suite|lot)\s*#?\s*([a-z0-9-]+)\b|#\s*([a-z0-9-]+)\b)/i;

function clean(value: unknown): string {
  return String(value ?? '').replace(/[_/]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function positiveInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function typeFromUnitCount(unitCount: number | undefined): ResidentialCompType | undefined {
  if (unitCount === 1) return 'single-family';
  if (unitCount === 2) return 'duplex';
  if (unitCount === 3) return 'triplex';
  if (unitCount === 4) return 'quadplex';
  if (unitCount != null && unitCount >= 5) return 'multi-family';
  return undefined;
}

function localIsoDate(date: Date): string {
  return [
    String(date.getFullYear()).padStart(4, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

/** Fresh rolling criteria: on July 13, 2027, include sales since July 13, 2026
 * and new builds from calendar years 2026-2027. */
export function getRollingCompDateWindow(now = new Date()): CompDateWindow {
  const asOf = Number.isNaN(now.getTime()) ? new Date() : new Date(now.getTime());
  const maxYearBuilt = asOf.getFullYear();
  const minYearBuilt = maxYearBuilt - 1;
  const priorMonthLastDay = new Date(minYearBuilt, asOf.getMonth() + 1, 0).getDate();
  const soldSince = new Date(
    minYearBuilt,
    asOf.getMonth(),
    Math.min(asOf.getDate(), priorMonthLastDay),
  );

  return {
    asOfDate: localIsoDate(asOf),
    soldSinceDate: localIsoDate(soldSince),
    minYearBuilt,
    maxYearBuilt,
  };
}

/** Canonical full-address key that standardizes unit designators without
 * discarding the unit number. This prevents condo/townhome units from merging. */
export function compAddressMatchKey(address: string): string {
  return String(address)
    .toLowerCase()
    .replace(/\b(?:apartment|apt|ste|suite)\b/g, 'unit')
    .replace(/\bunit\s*#?\s*([a-z0-9-]+)/g, ' unit $1')
    .replace(/#\s*([a-z0-9-]+)/g, ' unit $1')
    .replace(/[^a-z0-9]/g, '');
}

export interface CompAddressIdentity {
  streetCore: string;
  unit: string;
}

/** Number + normalized street name plus a separately preserved unit identity. */
export function compAddressIdentity(address: string): CompAddressIdentity {
  const parts = String(address).toLowerCase().trim().split(',').map((part) => part.trim());
  let street = parts[0] || '';
  if (parts[1] && UNIT_RE.test(parts[1])) street += ` ${parts[1]}`;
  const unitMatch = street.match(UNIT_RE);
  const unit = String(unitMatch?.[1] || unitMatch?.[2] || '').replace(/[^a-z0-9]/g, '');
  street = street.replace(UNIT_RE, ' ');
  street = street.replace(/\b[a-z]+\b/g, (word) => STREET_SUFFIXES[word] || word);
  return {
    streetCore: street.replace(/[^a-z0-9]/g, ''),
    unit,
  };
}

export function residentialCompTypeLabel(type: ResidentialCompType): string {
  return TYPE_LABELS[type];
}

export function inferZoningUseCategory(
  zoningCode: string,
  zoningDescription: string,
): 'residential' | 'commercial' | 'multifamily' {
  const code = clean(zoningCode).toUpperCase();
  const description = clean(zoningDescription).toLowerCase();

  if (
    code.startsWith('B-') ||
    code.startsWith('I-') ||
    code.startsWith('C-') ||
    code.startsWith('O-') ||
    code.startsWith('M-') ||
    code === 'UMUD' ||
    code.startsWith('TOD-U') ||
    /\b(?:commercial|business|industrial|office|retail)\b/.test(description)
  ) return 'commercial';

  if (
    code.startsWith('MF') ||
    code.includes('-MF') ||
    code.startsWith('UR-') ||
    code.startsWith('TOD-M') ||
    code.startsWith('TOD-CC') ||
    /\b(?:multi[-\s]?family|multifamily|apartment|townhome|townhouse|mixed[-\s]?use)\b/.test(description)
  ) return 'multifamily';

  return 'residential';
}

/**
 * Derive the residential sale types that can be compared under the parcel's
 * source-backed zoning. Only affirmative permitted-use text is considered;
 * restriction text is inspected solely for an affirmative multiple-building
 * allowance so a phrase such as "mobile homes prohibited" cannot add a type.
 */
export function zoningAllowedBuildingTypes(
  permittedUses: string[] | undefined,
  zoningCode: string,
  zoningDescription: string,
  restrictions: string[] = [],
): ResidentialCompType[] {
  const set = new Set<ResidentialCompType>();
  const affirmativeLines = [...(permittedUses || []), zoningDescription || '']
    .map(clean)
    .filter((line) => line && !PROHIBITED_USE_RE.test(line));

  for (const line of affirmativeLines) {
    if (MOBILE_RE.test(line)) set.add('mobile');
    if (TOWNHOUSE_RE.test(line)) set.add('townhouse');
    if (CONDO_RE.test(line)) set.add('condo');
    if (DUPLEX_RE.test(line)) set.add('duplex');
    if (TRIPLEX_RE.test(line)) set.add('triplex');
    if (QUADPLEX_RE.test(line)) set.add('quadplex');
    if (MULTIFAMILY_RE.test(line)) set.add('multi-family');
    if (SINGLE_FAMILY_RE.test(line)) set.add('single-family');
    if (MULTI_STRUCTURE_RE.test(line)) set.add('multi-structure');
  }

  for (const line of restrictions.map(clean)) {
    if (line && !PROHIBITED_USE_RE.test(line) && MULTI_STRUCTURE_RE.test(line)) {
      set.add('multi-structure');
    }
  }

  if (set.size === 0) {
    const category = inferZoningUseCategory(zoningCode, zoningDescription);
    if (category === 'multifamily') set.add('multi-family');
    if (category === 'residential') set.add('single-family');
  }

  return RESIDENTIAL_COMP_TYPE_ORDER.filter((type) => set.has(type));
}

/** Convert exact zoning-supported types to the broader filters RealtyAPI offers. */
export function compSearchFamiliesForAllowedTypes(types: ResidentialCompType[]): CompSearchFamily[] {
  const families = new Set<CompSearchFamily>();
  for (const type of types) {
    if (type === 'single-family') families.add('single-family');
    else if (type === 'mobile') families.add('mobile');
    else if (type === 'townhouse') families.add('townhouse');
    else if (type === 'condo') families.add('condo');
    else if (type === 'multi-structure') {
      families.add('single-family');
      families.add('multi-family');
    } else {
      families.add('multi-family');
    }
  }
  const order: CompSearchFamily[] = ['single-family', 'mobile', 'townhouse', 'condo', 'multi-family'];
  return order.filter((family) => families.has(family));
}

/** Exact result categories audited in the UI/summary. A broad multifamily
 * allowance can return source-confirmed duplex, triplex, and quadplex records. */
export function compCoverageTypesForAllowedTypes(types: ResidentialCompType[]): ResidentialCompType[] {
  const coverage = new Set(types);
  if (coverage.has('multi-family')) {
    coverage.add('duplex');
    coverage.add('triplex');
    coverage.add('quadplex');
  }
  return RESIDENTIAL_COMP_TYPE_ORDER.filter((type) => coverage.has(type));
}

/**
 * Classify a source record. Unit/structure counts and explicit subtype text win
 * over a broad source filter such as Multi_Family.
 */
export function classifyCompBuildingType(input: {
  propertyType?: unknown;
  sourceText?: unknown;
  unitCount?: unknown;
  structureCount?: unknown;
  fallbackType?: CompSearchFamily;
}): CompTypeClassification {
  const unitCount = positiveInteger(input.unitCount);
  const structureCount = positiveInteger(input.structureCount);
  const text = clean([input.propertyType, input.sourceText].filter(Boolean).join(' | '));

  if (structureCount != null && structureCount > 1) {
    return { type: 'multi-structure', label: TYPE_LABELS['multi-structure'], unitCount, structureCount, evidence: `${structureCount} residential structures published by the source` };
  }
  if (MULTI_STRUCTURE_RE.test(text)) {
    return { type: 'multi-structure', label: TYPE_LABELS['multi-structure'], unitCount, structureCount, evidence: 'multiple residential structures stated in the source record' };
  }
  if (MOBILE_RE.test(text)) return { type: 'mobile', label: TYPE_LABELS.mobile, unitCount, structureCount, evidence: 'manufactured/mobile type published by the source' };
  if (TOWNHOUSE_RE.test(text)) return { type: 'townhouse', label: TYPE_LABELS.townhouse, unitCount, structureCount, evidence: 'townhouse type published by the source' };
  if (CONDO_RE.test(text)) return { type: 'condo', label: TYPE_LABELS.condo, unitCount, structureCount, evidence: 'condominium type published by the source' };

  const countedType = typeFromUnitCount(unitCount);
  if (countedType) {
    return { type: countedType, label: TYPE_LABELS[countedType], unitCount, structureCount, evidence: `${unitCount} dwelling unit${unitCount === 1 ? '' : 's'} published by the source` };
  }
  if (DUPLEX_RE.test(text)) return { type: 'duplex', label: TYPE_LABELS.duplex, unitCount: unitCount ?? 2, structureCount, evidence: 'duplex/two-family use stated in the source record' };
  if (TRIPLEX_RE.test(text)) return { type: 'triplex', label: TYPE_LABELS.triplex, unitCount: unitCount ?? 3, structureCount, evidence: 'triplex/three-family use stated in the source record' };
  if (QUADPLEX_RE.test(text)) return { type: 'quadplex', label: TYPE_LABELS.quadplex, unitCount: unitCount ?? 4, structureCount, evidence: 'quadplex/four-family use stated in the source record' };
  if (MULTIFAMILY_RE.test(text)) return { type: 'multi-family', label: TYPE_LABELS['multi-family'], unitCount, structureCount, evidence: 'multifamily type published by the source' };
  if (SINGLE_FAMILY_RE.test(text) || /\b(?:house|detached|single_family)\b/i.test(String(input.propertyType ?? ''))) {
    return { type: 'single-family', label: TYPE_LABELS['single-family'], unitCount, structureCount, evidence: 'single-family type published by the source' };
  }
  if (LAND_RE.test(text)) return { type: 'land', unitCount, structureCount, evidence: 'vacant land/lot type published by the source' };

  if (input.fallbackType) {
    const fallback: ResidentialCompType = input.fallbackType;
    return { type: fallback, label: TYPE_LABELS[fallback], unitCount, structureCount, evidence: `${TYPE_LABELS[fallback]} RealtyAPI search filter` };
  }
  return { type: 'unknown', unitCount, structureCount };
}

export function compTypeFromDisplayLabel(value: unknown): ClassifiedCompType {
  return classifyCompBuildingType({ propertyType: value }).type;
}

/** Broad pre-detail gate used while a Multi_Family result may still be a 2-4 unit record. */
export function isSearchCompatibleCompType(
  type: ClassifiedCompType,
  allowed: ResidentialCompType[],
): boolean {
  if (type === 'land' || type === 'unknown') return false;
  if (type === 'multi-family') {
    return allowed.some((candidate) => ['duplex', 'triplex', 'quadplex', 'multi-family', 'multi-structure'].includes(candidate));
  }
  if (type === 'single-family' && allowed.includes('multi-structure')) return true;
  return isFinalCompTypeAllowed(type, allowed);
}

/** Exact post-detail zoning gate. Generic multifamily permission includes its concrete subtypes. */
export function isFinalCompTypeAllowed(
  type: ClassifiedCompType,
  allowed: ResidentialCompType[],
): boolean {
  if (type === 'land' || type === 'unknown') return false;
  if (allowed.includes(type)) return true;
  return allowed.includes('multi-family') && ['duplex', 'triplex', 'quadplex'].includes(type);
}

export function compClassificationSpecificity(type: ClassifiedCompType): number {
  if (type === 'multi-structure') return 4;
  if (['duplex', 'triplex', 'quadplex'].includes(type)) return 3;
  if (['single-family', 'mobile', 'townhouse', 'condo'].includes(type)) return 2;
  if (type === 'multi-family') return 1;
  return 0;
}
