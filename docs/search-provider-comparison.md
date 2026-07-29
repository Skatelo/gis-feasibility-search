# Perplexity and Monid Search Comparison

## Application Decision

Use Perplexity as the low-latency primary search provider. Use Monid concurrently for hard research and as an automatic top-up when Perplexity returns thin evidence. If only a Monid key is configured, Monid becomes the live-search provider. Crawlee remains the bounded page and document reader.

The app uses Monid's HTTP API rather than MCP. A web request can be routed through the same Netlify/Vite proxy in local and deployed builds, with explicit authentication, timeouts, provider-status checks, and price caps. MCP is useful for interactive agents, but it would add an external session boundary to normal address requests.

## Expected Tradeoffs

| Criterion | Perplexity Search API | Monid API |
| --- | --- | --- |
| Easy-query speed | Expected winner: one dedicated search request | More routing work; cold calls also discover and inspect a tool |
| Batch efficiency | Up to five independent queries in one request | The app runs up to three bounded provider calls concurrently |
| Search breadth | One continuously refreshed ranked index | Can dynamically select Exa or another qualified search provider |
| Content depth | Native per-page content extraction controls | Depends on the selected provider; Crawlee reads chosen pages afterward |
| Cost control | Controlled by request size and account pricing | Endpoint price is inspected before execution; the app rejects estimates over $0.05 |
| Failure isolation | Direct provider status and retry handling | Checks both Monid run state and the downstream provider HTTP status |
| Best app role | Fast primary search | Hard-search cross-check and thin-result recovery |

Perplexity documents ranked results, multi-query search, domain filtering, and content extraction at <https://docs.perplexity.ai/docs/search/quickstart>. Monid documents its discover, inspect, and run sequence at <https://docs.monid.ai/api/overview.html>. Monid can return synchronous results or an asynchronous run ID, so the app uses bounded polling and declines long-running tools on the normal request path.

## Reproducible Benchmark

Configure both `VITE_PERPLEXITY_API_KEY` and `VITE_MONID_API_KEY`, then run:

```bash
npm run benchmark:search -- --allow-paid
```

Add `--json` for machine-readable results. The benchmark sends five representative Carolina property-research queries to both providers concurrently and reports:

- End-to-end latency
- Result count and unique source domains
- Government-source rate
- Snippet/content coverage
- Query-term relevance
- Expected evidence terms and preferred official domains

The first Monid row includes cold tool discovery and inspection. The summary reports both overall and warm Monid median latency.

The evidence score is a repeatable search-quality proxy, not proof that every returned statement is true. Property, tax, zoning, and permit conclusions still require the application's official-record reconciliation and source citations.
