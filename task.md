# Active Task List: State-Agnostic Map Labels, Zoning, Utilities & Land Clearing

This task list details the division of labor between Antigravity, Claude Code, and Codex to make the GIS map labels, zoning map search, utility connections, and land clearing calculations work for both NC and SC addresses.

---

## 💻 [Claude Code (Lead Architect) Tasks]
- [x] Review the boundary check algorithm `getStateFromCoords` to verify it accurately separates NC and SC.
- [x] Verify that all web-search prompts and Perplexity query constructors correctly format state names.

## ⚡ [Codex (Senior Software Engineer) Tasks]
- [x] Implement `getStateFromCoords` in `src/services/feasibilityService.ts` to detect the state based on latitude and longitude.
- [x] Update `fetchParcelsInBbox` in `src/services/feasibilityService.ts` to query the correct MapServer (NC OneMap or SCDOT) and map the properties dynamically.
- [x] Update `fetchZoningViaWebSearch` in `src/services/feasibilityService.ts` to replace hardcoded state names with dynamic state parameters.
- [x] Update `fetchUtilitiesEstimate` in `src/services/feasibilityService.ts` to query using dynamic state parameters.
- [x] Update `fetchTreeRemovalRates` and `fetchLandClearingEstimate` in `src/services/feasibilityService.ts` to use dynamic state parameters.

## 🧠 [Antigravity Tasks] (Orchestrator)
- [x] Coordinate execution, run Vite compilation checks, commit changes, and push to GitHub.

