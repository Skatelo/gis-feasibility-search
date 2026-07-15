# Zoning Errors And Security

## Public result statuses

- `verified`: an official current-zoning polygon returned a mapped district.
- `verified-with-warnings`: an official district returned with a recoverable
  parcel, geometry, overlay, or confidence warning.
- `possible-match`: evidence exists but does not meet verified confidence.
- `manual_review`: no verified current-zoning layer returned a district for the
  controlling authority.
- `not_found`: the address did not produce a high-quality NC or SC geocode.
- `no_zoning`: the authority is explicitly recorded as having no general zoning.
- `error`: validation, geocoding, or upstream processing failed.

HTTP `400` means malformed input. HTTP `422` means the address is outside NC/SC
or too imprecise. HTTP `502` means an official upstream request failed. A valid
request with no configured source returns HTTP `200` and `manual_review`; it is
not disguised as a transport failure.

The preferred `POST /api/zoning/lookup` contract uses verification statuses
`verified_official`, `official_but_ambiguous`, `manual_review_required`, and
`not_found`. It also returns per-stage timings and the official sources checked.

## Security controls

- Administrative routes require `x-admin-key` in production.
- CORS is restricted by `ZONING_CORS_ORIGINS` in production.
- Public and admin responses send `Cache-Control: no-store` and
  `X-Content-Type-Options: nosniff`.
- Discovery URL validation blocks credentials, private networks, loopback,
  metadata services, and non-HTTP protocols.
- Source creation accepts HTTPS GIS URLs and creates candidates only.
- Browser discovery refuses CAPTCHA, Turnstile, login, and payment controls.
- API bodies are capped at 256 KB; ArcGIS responses have size and timeout caps.
- Public adaptive lookups are rate-limited per client and have a 29-second hard
  discovery budget inside the 35-second API request deadline.
- The lookup log stores normalized address, location, parcel ID, authority,
  result, source version, confidence, and timing. It does not store owner names,
  contact enrichment, or unrelated personal data.
- Secrets remain server-side. Do not put database, Redis, admin, Perplexity, or
  Google credentials in `VITE_*` variables.

TLS certificate verification remains enabled. A government endpoint with an
invalid certificate is not silently trusted.
