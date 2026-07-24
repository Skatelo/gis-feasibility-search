export interface Coordinates {
  lat: number;
  lng: number;
  ncStatePlaneX: number;
  ncStatePlaneY: number;
}

export interface GridicsData {
  frontageLengthFt: number;
  /** True lot width & depth (ft) from the parcel polygon's min-area bounding box. */
  lotWidthFt?: number;
  lotDepthFt?: number;
  lotType: string;
  maxBuildingFootprintSqft: number;
  maxHeightFt: number;
  floorAreaRatio: number;
  setbacks: {
    frontFt: number;
    rearFt: number;
    sideFt: number;
  };
  netBuildableAreaSqft: number;
}

export interface SlopeProfile {
  avgSlope: number;
  maxSlope: number;
  avgElevation: number;
  minElevation: number;
  maxElevation: number;
  verdict: 'BUILDABLE' | 'REQUIRES ENGINEERING' | 'NON-BUILDABLE';
}

export type ResidentialCompType =
  | 'single-family'
  | 'mobile'
  | 'townhouse'
  | 'condo'
  | 'duplex'
  | 'triplex'
  | 'quadplex'
  | 'multi-family'
  | 'multi-structure';

export interface CompDateWindow {
  /** Local calendar date when the fresh comp search ran (YYYY-MM-DD). */
  asOfDate: string;
  /** Inclusive rolling twelve-month cutoff (YYYY-MM-DD). */
  soldSinceDate: string;
  /** Previous calendar year, used as the dynamic new-construction floor. */
  minYearBuilt: number;
  /** Current calendar year, used as the dynamic new-construction ceiling. */
  maxYearBuilt: number;
}

export interface CompProperty {
  address: string;
  price: number;
  /** Driving miles (Google Distance Matrix) — the primary distance. */
  distanceMiles: number;
  durationMins: number;
  saleDate: string;
  coords?: { lat: number; lng: number };
  yearBuilt?: number;
  propertyType?: string;
  /** Exact zoning-aware residential form used to include this sold record. */
  compType?: ResidentialCompType;
  /** Published dwelling-unit count when RealtyAPI exposes it. */
  unitCount?: number;
  /** Published count of separate residential structures, when available. */
  structureCount?: number;
  /** Source-backed explanation for the exact type classification. */
  typeEvidence?: string;
  /** Why this property form is included under the subject parcel's zoning. */
  zoningMatchReason?: string;
  /** Living area in square feet. */
  sqft?: number;
  /** Sold price per square foot (rounded). */
  pricePerSqft?: number;
  /** Haversine straight-line miles (secondary, shown in parentheses). */
  straightLineMiles?: number;
  /** True when Google driving distance was unavailable and straight-line was used. */
  drivingFallback?: boolean;
  /** True when the sold price/date were verified on the Realtor.com detail page. */
  verified?: boolean;
  verifiedNote?: string;
  /** Set when the detail-page price differed from the search result by > $500. */
  priceDiscrepancy?: string;
  /** Realtor.com detail page URL. */
  url?: string;
  zip?: string;
  /** Listing photo URL from the source feed (Realtor/Redfin/Zillow CDN), when available. */
  imageUrl?: string;
  /** All listing photos (cover-first) — used to pick the exterior shot. */
  photoUrls?: string[];
}

/** One line item in the instant construction-cost estimate. */
export interface CostLineItem {
  category: string;   // "Site Work", "Foundation", "Framing", "Exterior", "Mechanical", "Interior", "Permits & Fees"
  item: string;       // "Clearing & grading"
  detail?: string;    // "~1.3 ac, light tree cover"
  cost: number;       // USD for this home/lot
}

/** Instant, locally-priced new-construction cost estimate (Handoff-style). */
export interface ConstructionCostEstimate {
  locality: string;        // "Concord / Cabarrus County metro"
  plannedSqft: number;     // home size used (sized to local comps)
  lineItems: CostLineItem[];
  hardCostTotal: number;   // sum of line items
  builderFee: number;
  contingency: number;
  totalCost: number;       // hardCostTotal + builderFee + contingency
  costPerSqft: number;     // totalCost / plannedSqft
  laborBasis?: string;     // e.g. "Labor: BLS Charlotte metro median wages (2025)"
  assumptions: string[];
  sources: string[];
  generatedAt: number;
}

/** One line in the local material takeoff: quantity (from the building size via a
 *  recipe) × the current LOCAL unit price = cost. */
export interface MaterialTakeoffItem {
  material: string;
  unit: string;        // "cu yd", "sheet", "square", "board ft", "sqft", "each"
  quantity: number;
  unitPrice: number;   // current local $/unit
  cost: number;        // quantity × unitPrice
  phase?: string;      // build phase: "Foundation & Site", "Framing", "Roofing", etc.
}

/** Local material-cost takeoff for a parcel (ZIP-localized unit pricing). */
export interface MaterialTakeoff {
  zip: string;
  locality: string;
  plannedSqft: number;
  items: MaterialTakeoffItem[];
  materialTotal: number;
  sources: string[];
  generatedAt: number;
}

/** One tree-size tier in the removal estimate. */
export interface TreeRemovalLine {
  size: 'small' | 'medium' | 'large';
  count: number;       // trees of this size (AI-estimated from satellite)
  unitCost: number;    // midpoint kept for compatibility
  unitCostLow: number;
  unitCostHigh: number;
  cost: number;        // midpoint kept for compatibility
  costLow: number;
  costHigh: number;
}

/** A bulk site-clearing method (e.g. forestry mulching vs. traditional excavator
 *  clearing) with a real-time local cost RANGE for this parcel. */
export interface ClearingMethod {
  method: string;      // "Forestry Mulching" | "Traditional Land Clearing"
  what: string;        // what happens
  low: number;         // range low ($)
  high: number;        // range high ($)
  note?: string;       // e.g. "stumps left flush" / "includes root extraction + haul"
}

/** Land-clearing estimate by TREE COUNT × current local per-tree removal cost
 *  (AI counts trees from satellite; rates are real-time/local). A per-acre bulk
 *  figure is kept for comparison on large forested tracts. */
export interface LandClearingEstimate {
  acres: number;
  canopyCoverPct: number | null;   // AI tree-canopy cover (0–100)
  density: 'light' | 'medium' | 'heavy';
  treeCount: number;               // total trees to remove
  /** How the imagery count was produced. The local canopy model avoids a
   *  network/model timeout while still analyzing the cited satellite image. */
  treeCountMethod: 'gemini-vision' | 'satellite-canopy-analysis';
  trees: TreeRemovalLine[];        // by size
  treeRemovalCost: number;         // Σ trees[].cost
  treeRemovalCostLow: number;
  treeRemovalCostHigh: number;
  stumpGrindUnit: number;          // $/stump
  stumpGrindUnitLow: number;
  stumpGrindUnitHigh: number;
  stumpGrindCost: number;          // treeCount × stumpGrindUnit
  stumpGrindCostLow: number;
  stumpGrindCostHigh: number;
  total: number;                   // treeRemovalCost + stumpGrindCost
  totalLow: number;
  totalHigh: number;
  /** Bulk machine-clearing METHODS (forestry mulching vs. traditional) with
   *  real-time cost ranges for this parcel. */
  clearingMethods: ClearingMethod[];
  clearingFactors: string[];       // the cost-driving factors (diameter, stumps, haul-off)
  satelliteUrl: string;            // top-down image used for the count
  streetViewUrl?: string;          // ground-level street view used for tree size
  imagerySources: string[];        // public map/view links supporting the visual estimate
  locality: string;
  pricingSources: string[];        // real-time pricing sources
  pricingStatus: 'verified' | 'estimated' | 'unavailable';
  pricingScope?: 'local' | 'regional';
  realTimePricing: boolean;        // true = current sources were retrieved live
  generatedAt: number;
}

/** One utility line: public water/sewer (with tap/connection fee) OR the private
 *  alternative (well / septic) when public service isn't available. */
export interface UtilityLine {
  name: string;        // "Public water", "Public sewer", "Private well", "Septic system"
  kind: 'water' | 'sewer';
  isPublic: boolean;   // true = public hookup (tap fee); false = private (well/septic)
  status: 'available' | 'not-available' | 'unknown';
  low: number;         // cost range low ($) — 0 when no verified local figure was found
  high: number;        // cost range high ($) — 0 when no verified local figure was found
  note?: string;       // e.g. "tap/impact fee", "drill + pump", "perc test + install"
  /** Fee-schedule specifics, e.g. '¾-inch service · City of Kannapolis fee schedule'. */
  detail?: string;
  /** true only when the figure came from a live, cited local source. */
  verified: boolean;
  /** Source supporting this line's availability and/or dollar amount. */
  sourceUrl?: string;
  /** All sources supporting a synthesized range. */
  sourceUrls?: string[];
  /** true when low/high is a source-backed budget range rather than an exact fee. */
  estimated?: boolean;
  /** Scenario lines are alternatives when address-level service is still unknown. */
  scenario?: boolean;
}

/** One residential permit fee from the jurisdiction's CURRENT fee schedule
 *  (zoning permit, driveway permit, building + trade permits). Only verified,
 *  cited figures are ever shown. */
export interface PermitFeeLine {
  name: string;
  low: number;
  high: number;
  note?: string;
  verified: boolean;
  /** Adopted fee schedule supporting this exact figure. */
  sourceUrl?: string;
  sourceUrls?: string[];
  /** true when the figure is a source-backed calculation or budget range. */
  estimated?: boolean;
}

/** Utilities + connection-cost estimate for a parcel: public water/sewer tap fees
 *  when service is available, otherwise real-time local well + septic costs. */
export interface UtilitiesEstimate {
  locality: string;
  /** Incorporated municipality at the parcel point (from Census TIGERweb), or a
   *  note that it's unincorporated county land — drives the availability call. */
  jurisdiction: string;
  incorporated: boolean;
  publicWater: 'available' | 'not-available' | 'unknown';
  publicSewer: 'available' | 'not-available' | 'unknown';
  lines: UtilityLine[];
  totalLow: number;
  totalHigh: number;
  /** Residential permit fees from the jurisdiction's current fee schedule
   *  (zoning / driveway / building + trades). Verified figures only. */
  permits: PermitFeeLine[];
  /** Caveat shown when public taps apply: developer may have already paid them. */
  tapNote?: string;
  summary: string;     // one-line recommendation
  provider?: string;   // water/sewer authority when known
  sources: string[];
  realTime: boolean;   // grounded live pricing vs. fallback
  researchRounds?: number;
  coverageStatus?: 'complete' | 'partial';
  generatedAt: number;
}

export interface FloodZoneInfo {
  /** FEMA flood zone code, e.g. "AE", "VE", "A", "X", or "UNKNOWN". */
  zone: string;
  /** True when the point falls in a Special Flood Hazard Area (1% annual chance, high risk). */
  inSFHA: boolean;
  /** Zone subtype detail, e.g. "0.2 PCT ANNUAL CHANCE FLOOD HAZARD". */
  subtype?: string;
  /** mapped = NFHL returned a zone; no-coverage = outside mapped NFHL; unavailable = service error. */
  status: 'mapped' | 'no-coverage' | 'unavailable';
  /** Citable FEMA source link for the coordinate. */
  sourceUrl: string;
}

export interface WetlandsInfo {
  /** true/false when NWI responds; null when the NWI service is unavailable. */
  present: boolean | null;
  /** NWI wetland classifications intersecting the point. */
  types: string[];
  status: 'mapped' | 'none-at-point' | 'unavailable';
  sourceUrl: string;
}

export interface SiteFeasibilityData {
  inputAddress: string;
  parcelId: string;
  /** Grid PIN (e.g. NC `parno`) shown separately when distinct from the parcel ID. */
  pinNumber?: string;
  /** County parcel/account ID (NC `altparno` or a county parcel_id; SC TMS number). */
  countyParcelId?: string;
  countyName: string;
  grossSf: number;
  gisAcres: number;
  acreageSource?: 'assessor' | 'gis' | 'geometry' | 'unavailable';
  zoningCode: string;
  coordinates: Coordinates;
  boundaryRings?: number[][][];
  statePlaneRings?: number[][][];
  zoningDescription?: string;
  zoningTextReport?: string;
  /** Where the zoning came from. Zoning research currently reports `web` for
   *  Gemini 3.6 Flash responses grounded with Google Search citations. */
  zoningSource?: 'county-gis' | 'statewide-gis' | 'official-map' | 'web';
  zoningSourceUrl?: string;
  zoningSources?: string[];
  zoningVerificationStatus?: 'resolving' | 'official-gis' | 'official-research' | 'corroborated-research' | 'listing-research' | 'statewide-reported' | 'planning-designation' | 'review-required' | 'conflict' | 'unavailable';
  zoningJurisdiction?: string;
  zoningStandardsStatus?: 'resolving' | 'official' | 'mixed' | 'estimated' | 'unavailable';
  zoningStandardsSourceUrl?: string;
  zoningSetbacksStatus?: 'resolving' | 'official' | 'mixed' | 'estimated' | 'unavailable';
  zoningSetbacks?: {
    frontFt?: number;
    rearFt?: number;
    sideFt?: number;
  };
  zoningMaxHeightFt?: number;
  zoningFloorAreaRatio?: number;
  zoningSetbackNotes?: string[];
  zoningRestrictions?: string[];
  zoningMinimumLotAreaSqft?: number;
  zoningMaxLotCoveragePct?: number;
  zoningPermittedUses?: string[];
  /** Residential building types this zoning permits — drives the comps filter/chips. */
  compAllowedTypes?: ResidentialCompType[];
  /** Exact rolling date/year criteria used for this fresh comp run. */
  compDateWindow?: CompDateWindow;
  gridics?: GridicsData;
  isSimulated?: boolean;

  // Free official SC parcel verification. Values remain flat for backwards
  // compatibility while these fields explain exactly where they came from.
  parcelVerificationStatus?: 'verified' | 'unavailable' | 'blocked';
  parcelSourceName?: string;
  parcelSourceUrl?: string;
  parcelMapUrl?: string;
  parcelSourceAsOf?: string;
  /** 'statewide' = owner from the SCDOT statewide parcel snapshot (no county
   *  source could confirm it) — shown labeled so it isn't read as the live roll. */
  ownerRecordType?: 'assessor' | 'deed' | 'gis' | 'statewide' | 'unavailable';
  geometryStatus?: 'verified' | 'statewide-candidate' | 'stale-hidden' | 'unavailable';
  parcelConflicts?: string[];

  // Rich Property Registry fields
  ownerName?: string;
  /** Authoritative owner first/last from the GIS (ownfrst/ownlast) when populated;
   *  used for display order + skip trace. Empty in some counties. */
  ownerFirst?: string;
  ownerLast?: string;
  mailingAddress?: string;
  assessedYear?: number;
  assessedPropertyValue?: number;
  landValue?: number;
  improvementValue?: number;
  marketValue?: number;
  taxableValue?: number;
  totalAssessedValue?: number;
  contactByMail?: string;
  deedBookPage?: string;
  deedType?: string;
  censusTract?: string;
  priceSoldFor?: number;
  dateOfSale?: string;
  taxCodeArea?: string;
  taxAmount?: number;
  taxYear?: number;
  salePriceFull?: string;
  legalDescription?: string;
  totalValueCalculated?: number;
  typeOfTransaction?: string;
  building?: {
    livingSqft?: number;
    firstFloorSqft?: number;
    buildingSqft?: number;
    buildingCount?: number;
    stories?: number;
    baths?: number;
  };

  // Environmental constraints (queried by coordinate)
  /** FEMA NFHL flood zone. */
  floodZone?: FloodZoneInfo;
  /** USFWS National Wetlands Inventory result. */
  wetlands?: WetlandsInfo;

  // Slope and Comps details
  slopeProfile?: SlopeProfile;
  comps?: CompProperty[];
  /** Conversational markdown summary of the comp run (criteria, per-comp detail, Bottom Line). */
  compRunSummary?: string;
}
