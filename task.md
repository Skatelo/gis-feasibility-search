# Active Task List: Mortgage Button Styling & Strict Utility Sources

This task list details the division of labor between Antigravity, Claude Code, and Codex.

---

## 💻 [Claude Code (Lead Architect) Tasks]
- [ ] Review the `filterLocalSources` logic and address-relevance constraints in `src/services/feasibilityService.ts` to ensure it is robust.
- [ ] Verify that regional provider initials matching (e.g. `cfpua`, `owasa`) works correctly without false negatives.

## ⚡ [Codex (Senior Software Engineer) Tasks]
- [ ] Modify `src/components/FeasibilitySearch.tsx` to:
  - Style the "Pull Deed, Mortgage & Transactions" button to match the "Skip Trace Owner" button exactly (using `className="owner-skip-btn"`).
  - Adjust the layout and spacing of the `.enf-empty` container surrounding it.
- [ ] Update `src/services/feasibilityService.ts` to:
  - Implement the strict `filterLocalSources` logic so only URLs containing matching locality/provider tokens are returned.
  - Exclude general state tokens (`nc`, `northcarolina`) from the search tokens list in `fetchUtilitiesEstimate`.
  - Extract and split `provider`, `waterTapDetail`, and `sewerTapDetail` names into individual words/tokens, and generate provider initials (e.g. `cfpua`) to add to the matching tokens list.
- [ ] Run `npm run build` to verify there are no compilation or type errors in the project.

## 🧠 [Antigravity Tasks] (Orchestrator)
- [ ] Coordinate execution, monitor background processes, and run final browser checks using the browser agent.
