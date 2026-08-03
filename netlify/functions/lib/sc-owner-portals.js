const SC_LAND_RECORDS_URL = 'https://www.sclandrecords.com/sclr/';
const SC_ROD_DIRECTORY_URL = 'https://www.sccourts.org/courts/court-officials/register-of-deeds/';

// These are official, credential-free county property systems that publish a
// current owner or an exact deed reference. They are queried only after the
// county GIS/treasurer path needs owner enrichment.
const SC_OWNER_PORTALS = {
  allendale: {
    propertyProvider: 'restricted',
    propertyUrl: 'https://www.qpublic.net/sc/allendale/',
  },
  anderson: {
    propertyProvider: 'restricted',
    propertyUrl: 'https://acpass.andersoncountysc.org/index.htm',
    deedUrl: 'https://acpass.andersoncountysc.org/index.htm',
  },
  bamberg: {
    propertyProvider: 'restricted',
    propertyUrl: 'https://www.qpublic.net/sc/bamberg/',
    deedProvider: 'restricted',
    deedUrl: 'https://BambergSC.avenuinsights.com/Public/BambergSC/',
  },
  beaufort: {
    deedProvider: 'publicsearch',
    deedUrl: 'https://beaufort.sc.publicsearch.us/',
  },
  berkeley: {
    propertyProvider: 'berkeley',
    propertyUrl: 'https://assessor.berkeleycountysc.gov/prop_card_search.php',
    deedProvider: 'berkeley',
    deedUrl: 'https://search.berkeleydeeds.com/',
  },
  charleston: {
    propertyProvider: 'aumentum',
    propertyUrl: 'https://sc-charleston.publicaccessnow.com/RealPropertyRecordSearch.aspx',
  },
  greenville: {
    propertyProvider: 'greenville',
    propertyUrl: 'https://www.greenvillecounty.org/appsAS400/RealProperty/',
    deedProvider: 'restricted',
    deedUrl: 'https://greenville.sc.publicsearch.us/',
  },
  greenwood: {
    propertyProvider: 'greenwood',
    propertyUrl: 'https://www.greenwoodsc.gov/Property_Report_TS/Default.aspx',
    deedProvider: 'publicsearch',
    deedUrl: 'https://greenwood.sc.publicsearch.us/',
  },
  lee: {
    deedProvider: 'publicsearch',
    deedUrl: 'https://lee.sc.publicsearch.us/',
  },
  oconee: {
    deedProvider: 'publicsearch',
    deedUrl: 'https://oconee.sc.publicsearch.us/',
  },
  richland: {
    propertyProvider: 'spatialest',
    propertyUrl: 'https://property.spatialest.com/sc/richland#/',
  },
};

const SC_LAND_RECORDS_COUNTIES = new Set([
  'bamberg', 'cherokee', 'chester', 'chesterfield', 'dillon', 'edgefield',
  'fairfield', 'hampton', 'kershaw', 'lee', 'newberry', 'williamsburg',
]);

function countyKey(county) {
  return String(county || '')
    .replace(/,\s*SC$/i, '')
    .replace(/\s+County$/i, '')
    .trim()
    .toLowerCase();
}

export function scOwnerPortalFor(county) {
  const key = countyKey(county);
  const configured = SC_OWNER_PORTALS[key] || {};
  if (configured.deedUrl || !SC_LAND_RECORDS_COUNTIES.has(key)) return configured;
  return {
    ...configured,
    deedProvider: 'avenu',
    deedUrl: SC_LAND_RECORDS_URL,
  };
}

export function scOwnerVerificationUrl(county, fallbackUrl = '') {
  const portal = scOwnerPortalFor(county);
  return portal.propertyUrl || portal.deedUrl || fallbackUrl || SC_ROD_DIRECTORY_URL;
}

export const __testables = {
  SC_LAND_RECORDS_COUNTIES,
  SC_OWNER_PORTALS,
  countyKey,
};
