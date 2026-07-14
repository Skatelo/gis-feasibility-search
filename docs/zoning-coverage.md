# NC/SC Zoning Coverage

Status date: 2026-07-14

## Reviewed rollout registry

The bootstrap registry contains separate authority records for the first six
rollout counties:

| County | Reviewed authority scope | Current limitation |
| --- | --- | --- |
| Mecklenburg, NC | County, Charlotte, Cornelius, Davidson, Huntersville, Matthews, Mint Hill, Pineville | ETJ boundaries still require authority-specific onboarding |
| Gaston, NC | County and 11 separately mapped municipalities | Municipalities not present in the reviewed layer list remain manual review |
| Cabarrus, NC | County, Concord, Kannapolis, Harrisburg, Locust, Midland, Mount Pleasant | ETJ validation remains pending |
| Union, NC | County and Monroe | Other municipal authorities remain manual review |
| York, SC | County, Rock Hill, Clover, York, Fort Mill, Tega Cay | Remaining municipal authorities remain manual review |
| Lancaster, SC | City of Lancaster | No verified county-wide current-zoning layer is configured |

There are 37 bootstrap authority records. This is not statewide validated
coverage. The jurisdiction importer loads all 100 NC county boundaries, all 46
SC county boundaries, and incorporated-place boundaries for routing and future
onboarding; boundary presence does not imply a verified zoning source.

## Statewide status

- NC counties fully validated: not yet 100 of 100.
- SC counties fully validated: not yet 46 of 46.
- ETJ and special planning authorities fully validated: no.
- Every configured source live-probed after deployment: required before a
  statewide production claim.

The dashboard coverage view is calculated from PostGIS and verified source
rows. `manual_review`, `unknown`, and `no_zoning` are kept distinct.
