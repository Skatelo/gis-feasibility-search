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
  unitCost: number;    // current LOCAL $/tree to remove
  cost: number;        // count × unitCost
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
  trees: TreeRemovalLine[];        // by size
  treeRemovalCost: number;         // Σ trees[].cost
  stumpGrindUnit: number;          // $/stump
  stumpGrindCost: number;          // treeCount × stumpGrindUnit
  total: number;                   // treeRemovalCost + stumpGrindCost
  /** Bulk machine-clearing METHODS (forestry mulching vs. traditional) with
   *  real-time cost ranges for this parcel. */
  clearingMethods: ClearingMethod[];
  clearingFactors: string[];       // the cost-driving factors (diameter, stumps, haul-off)
  satelliteUrl: string;            // top-down image used for the count
  streetViewUrl?: string;          // ground-level street view used for tree size
  locality: string;
  pricingSources: string[];        // real-time pricing sources
  realTimePricing: boolean;        // true = grounded local rates; false = fallback
  generatedAt: number;
}

/** One utility line: public water/sewer (with tap/connection fee) OR the private
 *  alternative (well / septic) when public service isn't available. */
export interface UtilityLine {
  name: string;        // "Public water", "Public sewer", "Private well", "Septic system"
  kind: 'water' | 'sewer';
  isPublic: boolean;   // true = public hookup (tap fee); false = private (well/septic)
  status: 'available' | 'not-available' | 'unknown';
  low: number;         // cost range low ($)
  high: number;        // cost range high ($)
  note?: string;       // e.g. "tap/impact fee", "drill + pump", "perc test + install"
}

/** Utilities + connection-cost estimate for a parcel: public water/sewer tap fees
 *  when service is available, otherwise real-time local well + septic costs. */
export interface UtilitiesEstimate {
  locality: string;
  publicWater: 'available' | 'not-available' | 'unknown';
  publicSewer: 'available' | 'not-available' | 'unknown';
  lines: UtilityLine[];
  totalLow: number;
  totalHigh: number;
  summary: string;     // one-line recommendation
  provider?: string;   // water/sewer authority when known
  sources: string[];
  realTime: boolean;   // grounded live pricing vs. fallback
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
  countyName: string;
  grossSf: number;
  gisAcres: number;
  zoningCode: string;
  coordinates: Coordinates;
  boundaryRings?: number[][][];
  statePlaneRings?: number[][][];
  zoningDescription?: string;
  /** Where the zoning came from: the county's GIS, or a web search fallback. */
  zoningSource?: 'county-gis' | 'web';
  zoningSourceUrl?: string;
  gridics?: GridicsData;
  isSimulated?: boolean;

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

