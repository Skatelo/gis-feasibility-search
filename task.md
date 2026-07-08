# Active Task List: South Carolina GIS Attribute Normalization Fix

This task list details the division of labor between Antigravity, Claude Code, and Codex to resolve the empty SC GIS search results by normalizing the attributes.

---

## 💻 [Claude Code (Lead Architect) Tasks]
- [x] Review the normalization key mappings in `normalizeCountyParcelAttrs` to ensure no collisions.
- [x] Verify that the normalized county name field correctly feeds into the county correction logic.

## ⚡ [Codex (Senior Software Engineer) Tasks]
- [x] Update `normalizeCountyParcelAttrs` in `src/services/feasibilityService.ts` to map the SC attributes:
  - Match `parno` with `/t_map_number|tms|tax_map_number/i`.
  - Match `ownname` with `/ownership|owner_ship/i`.
  - Match `mailadd` with `/mailing_add/i`.
  - Match `mcity` with `/mailing_city/i`.
  - Match `mstate` with `/mailing_st|mailing_state/i`.
  - Match `mzip` with `/mailing_zip/i`.
  - Match `parval` with `/m_value/i`.
  - Match `landval` with `/l_value/i`.
  - Match `legdecfull` with `/land_use/i`.
  - Add `cntyname` to the returned properties matching `/cntyname|county|county_name/i`.
- [x] Update `executeLandAnalysis` in `src/services/feasibilityService.ts` to normalize properties returned from the statewide queries using `normalizeCountyParcelAttrs`.

## 🧠 [Antigravity Tasks] (Orchestrator)
- [x] Coordinate execution, run Vite compilation checks, commit changes, and push to GitHub.

