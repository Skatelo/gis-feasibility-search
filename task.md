# Active Task List: Perplexity Zoning, Dynamic Utilities, & SC Owner Filters

This task list coordinates the implementation of Perplexity chat completions for Zoning, dynamic SC-specific permit fallbacks in the UI, joint owner name splitting and first-name-first formatting, and excluding roadway parcels in GIS lookups.

---

## 💻 [Claude Code (Lead Architect) Tasks]
- [x] Review the `formatOwnerName` implementation to ensure joint names split and format correctly without regressions.
- [x] Verify the Perplexity chat completion API invocation payload structure.

## ⚡ [Codex (Senior Software Engineer) Tasks]
- [x] Implement `zoningViaPerplexity` in `src/services/feasibilityService.ts`.
- [x] Update `fetchZoningViaWebSearch` in `src/services/feasibilityService.ts` to call `zoningViaPerplexity` first if a Perplexity key is available.
- [x] Update `formatOwnerName` in `src/services/feasibilityService.ts` to support joint owner splitting, ET AL stripping, and implied surname appending.
- [x] Update `executeLandAnalysis` in `src/services/feasibilityService.ts` to filter out roadway/highway features (e.g. SCDOT right-of-ways) from parcel lookup results.
- [x] Update `src/components/FeasibilitySearch.tsx` to dynamically render `typical SC estimate` or `typical NC estimate` based on `data.countyName`.

## 🧠 [Antigravity Tasks] (Orchestrator)
- [x] Coordinate execution, run Vite compilation checks, commit changes, and push to GitHub.
