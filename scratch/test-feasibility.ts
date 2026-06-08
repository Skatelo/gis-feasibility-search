import { executeLandAnalysis } from '../src/services/feasibilityService';

async function testAddress(county: string, address: string) {
  console.log(`\n==================================================`);
  console.log(`Testing Feasibility Analysis for ${address} (${county} County)`);
  console.log(`==================================================`);
  
  try {
    const data = await executeLandAnalysis(county, address, (stage) => {
      console.log(`   [Stage]: ${stage}`);
    });
    
    console.log(`✅ Success!`);
    console.log(`   Parcel ID:`, data.parcelId);
    console.log(`   County:`, data.countyName);
    console.log(`   Acreage:`, data.gisAcres);
    console.log(`   Assessed Value: $`, data.assessedPropertyValue);
    console.log(`   Owner:`, data.ownerName);
    console.log(`   Zoning:`, data.zoningCode, `(${data.zoningDescription})`);
    console.log(`   Geometry Rings Count:`, data.boundaryRings ? data.boundaryRings.length : 0);
    console.log(`   Coordinates:`, data.coordinates);
    console.log(`   Slope ProfileVerdict:`, data.slopeProfile?.verdict);
    console.log(`   Comps Found:`, data.comps ? data.comps.length : 0);
    if (data.comps && data.comps.length > 0) {
      console.log(`   First Comp:`, data.comps[0].address, `($${data.comps[0].price})`);
    }
  } catch (e: any) {
    console.error(`❌ Feasibility analysis failed for ${address}:`, e.message);
  }
}

async function run() {
  // Load environment variables from .env.local dynamically so we do not expose API keys
  try {
    const fs = await import('fs');
    const path = await import('path');
    // Note: in ESM context, __dirname is not available unless defined. We can construct it or use path.resolve.
    const envPath = path.resolve(process.cwd(), '.env.local');
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      content.split(/\r?\n/).forEach(line => {
        const parts = line.split('=');
        if (parts.length >= 2) {
          const key = parts[0].trim();
          const val = parts.slice(1).join('=').trim();
          if (key) process.env[key] = val;
        }
      });
    }
  } catch (e) {
    console.warn("Could not load local env variables from .env.local:", e);
  }

  // Set fallback values if they are not in the loaded environment
  if (!process.env.VITE_OPENTOPOGRAPHY_API_KEY) {
    process.env.VITE_OPENTOPOGRAPHY_API_KEY = "23f20d48de995277b1d5a9d3a00291f";
  }
  if (!process.env.VITE_GOOGLE_MAPS_API_KEY) {
    process.env.VITE_GOOGLE_MAPS_API_KEY = "AIzaSyAoMZvEZnisPQ0KgyHx11deQXJZKj6AJHo";
  }

  // Wake County Test
  await testAddress("Wake", "7712 Bill Love Rd, Holly Springs, NC 27592");
  
  // Gaston County Test
  await testAddress("Gaston", "1516 N Weldon St, Gastonia, NC 28052");

  // Cabarrus County Test
  await testAddress("Cabarrus", "6317 Miller Rd, Kannapolis, NC 28081");
}

run();
