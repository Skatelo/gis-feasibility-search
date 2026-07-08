# Active Task List: South Carolina GIS Integration

This task list details the division of labor between Antigravity, Claude Code, and Codex for adding all 46 South Carolina counties.

---

## 💻 [Claude Code (Lead Architect) Tasks]
- [x] Review the geocoding state-determination logic in `src/services/feasibilityService.ts`.
- [x] Verify handling of overlapping county names (Beaufort, Cherokee, Lee, Union) across both NC and SC.
- [x] Verify that TigerWeb queries detect both FIPS 37 (NC) and FIPS 45 (SC) points correctly.

## ⚡ [Codex (Senior Software Engineer) Tasks]
- [x] Add `SC_COUNTY_NAMES` array and SC county FIPS codes to `feasibilityService.ts`.
- [x] Add the 46 SC counties to `ncCountyConfig` mapping them to the SCDOT Statewide Parcel REST MapServer.
- [x] Add the 24 verified SC county ArcGIS servers to `countyParcelLayers` in `feasibilityService.ts`.
- [x] Update `detectNcCounty` to geocode SC/NC addresses and return state-qualified county names (e.g. `"Richland, SC"`).
- [x] Generalize `ncCountyAtPoint` to `countyAtPoint` supporting SC and NC state FIPS.
- [x] Update the `ncZoningRegistry` in `src/data/ncZoning.ts` to register the SC counties.
- [x] Modify layout/error messages in `src/components/FeasibilitySearch.tsx` to handle SC validation properly.

## 🧠 [Antigravity Tasks] (Orchestrator)
- [x] Coordinate execution, run Vite compilation checks, commit changes, and push to GitHub.

