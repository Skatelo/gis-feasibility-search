import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

function monidProxyPath(path: string): string {
  const request = new URL(path, 'http://localhost');
  const endpoint = request.searchParams.get('endpoint');
  if (endpoint === 'discover' || endpoint === 'inspect' || endpoint === 'run') {
    return `/v1/${endpoint}`;
  }
  if (endpoint === 'runs') {
    const runId = request.searchParams.get('runId') || '';
    return /^[0-9A-HJKMNP-TV-Z]{20,32}$/.test(runId)
      ? `/v1/runs/${runId}`
      : '/v1/runs/invalid';
  }
  return '/v1/invalid';
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Dev-only: browsers can't call api.perplexity.ai directly (it sends no
      // CORS headers). In production the Netlify functions at these same paths
      // proxy the Perplexity Search API; plain `vite` doesn't serve Netlify
      // functions, so forward the paths to the API here. The app's Authorization
      // header (the user's Perplexity key) and JSON body pass straight through,
      // so `npm run dev` gets live Perplexity search without `netlify dev`.
      '/.netlify/functions/perplexity-chat': {
        target: 'https://api.perplexity.ai',
        changeOrigin: true,
        rewrite: () => '/chat/completions',
      },
      '/.netlify/functions/perplexity': {
        target: 'https://api.perplexity.ai',
        changeOrigin: true,
        rewrite: () => '/search',
      },
      // Monid's direct HTTP API is used instead of MCP in the browser so local
      // and deployed searches share deterministic auth, timeouts, and routing.
      '/.netlify/functions/monid': {
        target: 'https://api.monid.ai',
        changeOrigin: true,
        rewrite: monidProxyPath,
      },
      // Property Detail includes mortgageHistory and saleHistory. Production
      // uses the Netlify function at this route; local Vite forwards the same
      // request directly so the feature can be exercised without netlify dev.
      '/.netlify/functions/realestateapi-property': {
        target: 'https://api.realestateapi.com',
        changeOrigin: true,
        rewrite: () => '/v2/PropertyDetail',
      },
    },
  },
})
