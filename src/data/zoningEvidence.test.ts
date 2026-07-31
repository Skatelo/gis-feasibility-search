import test from 'node:test';
import assert from 'node:assert/strict';
import { listingUrlMatchesAddress, listingZoningEvidenceTier, zoningListingProvider } from './zoningEvidence';

const SUBJECT = '1992 Garland Avenue, Gastonia, North Carolina 28052';

test('a neighbour\'s listing is not evidence for this parcel', () => {
  // The exact failure seen live: asked about 1992 Garland Ave, the model cited
  // listings for 1908 Garland Ave and reported that parcel's RS-8. The official
  // GIS says this parcel is RS-12.
  assert.equal(
    listingUrlMatchesAddress('https://www.zillow.com/homedetails/1908-Garland-Ave-Gastonia-NC-28052/2054652252_zpid/', SUBJECT),
    false,
  );
  assert.equal(
    listingUrlMatchesAddress('https://www.realtor.com/realestateandhomes-detail/1908-Garland-Ave_Gastonia_NC_28052_M98695-18880', SUBJECT),
    false,
  );
});

test('the subject property\'s own listing is accepted', () => {
  for (const url of [
    'https://www.zillow.com/homedetails/1992-Garland-Ave-Gastonia-NC-28052/2054652999_zpid/',
    'https://www.realtor.com/realestateandhomes-detail/1992-Garland-Ave_Gastonia_NC_28052_M98695-18881',
    'https://www.redfin.com/NC/Gastonia/1992-Garland-Ave-28052/home/12345',
  ]) {
    assert.equal(listingUrlMatchesAddress(url, SUBJECT), true, url);
  }
});

test('street type spelling does not decide the match', () => {
  assert.equal(
    listingUrlMatchesAddress('https://www.zillow.com/homedetails/1992-Garland-Avenue-Gastonia-NC-28052/1_zpid/', SUBJECT),
    true,
  );
});

test('a house number colliding with a listing id does not pass', () => {
  // "1992" appears, but as part of the id — not followed by the street name.
  assert.equal(
    listingUrlMatchesAddress('https://www.zillow.com/homedetails/1908-Garland-Ave-Gastonia-NC-28052/1992_zpid/', SUBJECT),
    false,
  );
});

test('non-listing hosts and unverifiable inputs are refused', () => {
  assert.equal(listingUrlMatchesAddress('https://www.gastonianc.gov/planning', SUBJECT), false);
  assert.equal(listingUrlMatchesAddress('https://www.zillow.com/homedetails/1992-Garland-Ave/1_zpid/', ''), false, 'no subject address');
  assert.equal(listingUrlMatchesAddress('not a url', SUBJECT), false);
});

test('provider detection and tiers still behave', () => {
  assert.equal(zoningListingProvider('https://www.redfin.com/NC/Gastonia/x/home/1'), 'redfin.com');
  assert.equal(zoningListingProvider('https://www.gastonianc.gov/x'), null);
  assert.equal(listingZoningEvidenceTier([]), null);
  assert.equal(listingZoningEvidenceTier(['https://www.zillow.com/a']), 'reported');
  assert.equal(listingZoningEvidenceTier(['https://www.zillow.com/a', 'https://www.redfin.com/b']), 'corroborated');
});
