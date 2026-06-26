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

