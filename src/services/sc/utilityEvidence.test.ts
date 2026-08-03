import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyUtilityLayer,
  utilityFinding,
  utilityWarnings,
  strongerConfidence,
  serviceAreaAtPoint,
  nearestMainDistanceFt,
  MAIN_ADJACENT_FT,
} from './utilityEvidence';

test('service areas and mains are told apart', () => {
  assert.equal(classifyUtilityLayer('Sewer Service Area'), 'sewer-service-area');
  assert.equal(classifyUtilityLayer('Water Service Districts'), 'water-service-area');
  assert.equal(classifyUtilityLayer('Sanitary Sewer Mains'), 'sewer-main');
  assert.equal(classifyUtilityLayer('Water Distribution Lines'), 'water-main');
  assert.equal(classifyUtilityLayer('Gravity Sewer'), 'sewer-main');
  assert.equal(classifyUtilityLayer('Force Main'), 'sewer-main');
});

test('stormwater and watersheds are never read as sanitary sewer or potable water', () => {
  // These are the false positives that would otherwise turn a drainage layer
  // into a claim that the parcel has sewer.
  for (const name of ['Storm Sewer', 'Stormwater Drainage', 'Watershed Boundaries',
    'Water Bodies', 'Irrigation Lines', 'Reclaimed Water', 'Floodplain']) {
    assert.equal(classifyUtilityLayer(name), null, name);
  }
});

test('a parcel inside a district is never reported as connected', () => {
  // The distinction the whole module exists for: a planning boundary is not
  // installed infrastructure.
  const f = utilityFinding({ kind: 'sewer', insideServiceArea: true });
  assert.equal(f.status, 'inside-service-area');
  assert.equal(f.confidence, 'inside-service-area');
  assert.notEqual(f.confidence, 'parcel-connected');
  assert.match(f.caveat, /not proof a tap/i);
});

test('spatial evidence can never claim a connection or a utility record', () => {
  // No combination of inputs may produce the two strongest levels — only a
  // utility can establish those, and this module has no utility record.
  const combos = [
    { insideServiceArea: true, distanceFt: 10 },
    { insideServiceArea: true, distanceFt: 0 },
    { insideServiceArea: false, distanceFt: 5 },
  ];
  for (const c of combos) {
    const f = utilityFinding({ kind: 'water', ...c });
    assert.notEqual(f.confidence, 'parcel-connected');
    assert.notEqual(f.confidence, 'confirmed-by-utility-record');
  }
});

test('an adjacent main outranks mere service-area membership', () => {
  const adjacent = utilityFinding({ kind: 'water', insideServiceArea: true, distanceFt: MAIN_ADJACENT_FT });
  assert.equal(adjacent.status, 'main-adjacent');
  const farther = utilityFinding({ kind: 'water', insideServiceArea: true, distanceFt: 900 });
  assert.equal(farther.status, 'inside-service-area', 'a distant main does not beat the service area');
});

test('no layer means unknown, which is not the same as not-found', () => {
  const missing = utilityFinding({ kind: 'sewer', hadLayer: false });
  assert.equal(missing.status, 'unknown');
  assert.match(missing.caveat, /could not be established/i);

  const searched = utilityFinding({ kind: 'sewer' });
  assert.equal(searched.status, 'not-found');
  assert.match(searched.caveat, /private well or septic/i);
});

test('confidence ordering is usable for merging findings', () => {
  assert.equal(strongerConfidence('inside-service-area', 'nearby-only'), 'inside-service-area');
  assert.equal(strongerConfidence('not-found', 'unknown'), 'not-found');
  assert.equal(strongerConfidence('main-adjacent', 'inside-service-area'), 'main-adjacent');
});

test('warnings carry the limitation next to the finding', () => {
  const w = utilityWarnings([
    utilityFinding({ kind: 'sewer', insideServiceArea: true }),
    utilityFinding({ kind: 'water', distanceFt: 120 }),
  ]);
  assert.ok(w.some((x) => /does not confirm an installed tap/i.test(x)));
  assert.ok(w.some((x) => /does not confirm a connection/i.test(x)));
});

test('a point outside every service area reports not-found, not inside', async () => {
  const deps = { fetchJson: async () => ({ features: [] }) };
  const r = await serviceAreaAtPoint('https://x/0', -81, 34, deps);
  assert.equal(r.inside, false);
});

test('the provider name is read from whichever field the county used', async () => {
  const deps = { fetchJson: async () => ({ features: [{ attributes: { SYSTEM_NAME: 'Rock Hill Utilities' } }] }) };
  const r = await serviceAreaAtPoint('https://x/0', -81, 34, deps);
  assert.equal(r.inside, true);
  assert.equal(r.provider, 'Rock Hill Utilities');
});

test('main distance is bounded by the buffer that matched, not invented', async () => {
  let calls = 0;
  const deps = {
    fetchJson: async () => {
      calls += 1;
      // Miss the tight buffer, hit the wider one.
      return calls === 1 ? { features: [] } : { features: [{ attributes: { AGENCY: 'York County' } }] };
    },
  };
  const r = await nearestMainDistanceFt('https://x/0', -81, 34, deps);
  assert.equal(r.distanceFt, 1000, 'reports the buffer that actually matched');
  assert.equal(r.provider, 'York County');
});

test('real Dorchester layer names classify correctly', () => {
  // Taken from the live service, not invented. The road-closure layers are the
  // trap: they contain "water" and were being read as a water service area,
  // which would have implied the parcel has public water.
  assert.equal(classifyUtilityLayer('Road Blocks from water'), null);
  assert.equal(classifyUtilityLayer('Roads Closed from Water'), null);

  assert.equal(classifyUtilityLayer('Water Service Areas'), 'water-service-area');
  assert.equal(classifyUtilityLayer('Sewer Service Areas'), 'sewer-service-area');
  assert.equal(classifyUtilityLayer('sewer main'), 'sewer-main');
  assert.equal(classifyUtilityLayer('force main'), 'sewer-main');

  // Equipment, not a boundary — these must not assert service-area coverage.
  assert.equal(classifyUtilityLayer('force main valves'), 'sewer-main');
  assert.equal(classifyUtilityLayer('sewer lateral'), 'sewer-main');
  assert.equal(classifyUtilityLayer('sewer network structure'), 'sewer-main');
});

test('an unrecognised utility-flavoured name is not assumed to be a service area', () => {
  // Service-area membership is the claim that drives availability, so an
  // unrecognised name must be null rather than defaulting to coverage.
  assert.equal(classifyUtilityLayer('Water Quality Samples'), null);
  assert.equal(classifyUtilityLayer('Sewer Complaints 2024'), null);
});

test('real NC layer names: an operational boundary is not a service area', () => {
  // From Raleigh's live utility service. "Sewer Maintenance Districts" is a
  // crew boundary that matched on "district" and asserted sewer availability —
  // being inside the area a crew maintains says nothing about whether service
  // reaches a parcel.
  assert.equal(classifyUtilityLayer('Sewer Maintenance Districts'), 'sewer-main');
  assert.notEqual(classifyUtilityLayer('Sewer Maintenance Districts'), 'sewer-service-area');

  for (const name of ['Water Meter Read Routes', 'Sewer Billing Zones',
    'Water Pressure Zones', 'Sewer Inspection Areas', 'Water Asset Districts']) {
    const role = classifyUtilityLayer(name);
    assert.ok(role !== 'water-service-area' && role !== 'sewer-service-area', `${name} must not claim coverage (got ${role})`);
  }
});

test('real NC layer names: equipment and stormwater stay out of coverage claims', () => {
  // Also from Raleigh live.
  assert.equal(classifyUtilityLayer('Sewer Pump Station'), 'sewer-main');
  assert.equal(classifyUtilityLayer('Sewer Manhole'), 'sewer-main');
  assert.equal(classifyUtilityLayer('Gravity Sewer'), 'sewer-main');
  assert.equal(classifyUtilityLayer('Force Main'), 'sewer-main');
  assert.equal(classifyUtilityLayer('Water Body'), null);
  assert.equal(classifyUtilityLayer('Drainage Basins'), null);
  assert.equal(classifyUtilityLayer('Sewer Monitoring Gauges'), null);
});
