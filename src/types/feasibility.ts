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
  distanceMiles: number;
  durationMins: number;
  saleDate: string;
  coords?: { lat: number; lng: number };
  yearBuilt?: number;
  propertyType?: string;
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

  // Slope and Comps details
  slopeProfile?: SlopeProfile;
  comps?: CompProperty[];
}

