# Active Task List: Put Mortgage & Sales Transactions Under a Button

This task list has been orchestrated by **Antigravity**. It details the division of labor between Antigravity, Claude Code, and Codex.

---

## 💻 [Claude Code (Lead Architect) Tasks]
- [ ] Review the conditional logic for rendering the Enformion card in `src/components/FeasibilitySearch.tsx`.
- [ ] Ensure that card state transitions correctly between Not Fetched, Loading, Success (showing assessor + deed/mortgage records), and Error.

## ⚡ [Codex (Senior Software Engineer) Tasks]
- [ ] Remove `fetchEnformionRecords(reportData, seq);` from `generateCostEstimates` inside `src/components/FeasibilitySearch.tsx`.
- [ ] Modify the Enformion card visibility condition to check only `enformionConfigured()`.
- [ ] Implement the placeholder card content with a button `Pull Deed, Mortgage & Transactions` when records are not yet fetched (`!enfProperty && !enfLoading && !enfErrors.property`).
- [ ] Wire the button click handler to invoke `fetchEnformionRecords(data, searchSeqRef.current)`.
- [ ] Run `npm run build` to verify compiling.

## 🧠 [Antigravity Tasks] (Orchestrator)
- [ ] Oversee coordination, perform visual checks in the browser, and publish the final report.
