# Official GIS Source Onboarding

## Authority first

1. Confirm the controlling zoning authority from an official planning page.
2. Confirm its PostGIS boundary, parent county, and any ETJ or joint-planning
   relationship. Mailing-city text is not routing evidence.
3. Set the jurisdiction to `adopted`, `partial`, `no_zoning`, or
   `manual_review` with official evidence.

## Layer review

1. Add the exact numbered `MapServer/{id}` or `FeatureServer/{id}` URL as a
   candidate through the authenticated zoning registry API.
2. Inspect layer metadata and sample records.
3. Confirm polygon geometry and query capability.
4. Reject future land use, comprehensive plans, tax-use classes, voting,
   school, fire, and assessment layers.
5. Map the local zoning-code and optional description fields.
6. Run validation. It performs metadata, sample, and real point queries.
7. Compare several known parcels near jurisdiction boundaries against the
   official viewer.
8. Approve only after the authority, field, and spatial coverage agree.

Parcel and overlay layers are separate source records. A county layer must not
be reused inside a municipality unless the official service and authority
configuration explicitly cover that municipality.

## Discovery worker

Discovery is an administrative BullMQ job. It may use Perplexity Search to find
candidate official pages, direct HTTP inspection, bounded Crawlee extraction,
and finally Playwright for JavaScript-only viewers. It never promotes a result
to verified and it never runs during an address lookup.

The worker does not solve CAPTCHAs, enter credentials, cross payment gates, or
disable access controls. Restricted viewers remain `manual_review` with their
official manual-verification URL.

## Replacement and rollback

Disable a broken source before approving a replacement. Every update creates a
row in `zoning_gis_source_versions`; review that history before rollback. Never
substitute future land use because the current-zoning endpoint moved.
