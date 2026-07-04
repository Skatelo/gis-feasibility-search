import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Dev-only: browsers can't call api.perplexity.ai directly (it sends no
      // CORS headers). In production the Netlify function at this same path
      // proxies the Perplexity Search API; plain `vite` doesn't serve Netlify
      // functions, so forward that path to the API here. The app's Authorization
      // header (the user's Perplexity key) and JSON body pass straight through,
      // so `npm run dev` gets live Perplexity search without `netlify dev`.
      '/.netlify/functions/perplexity': {
        target: 'https://api.perplexity.ai',
        changeOrigin: true,
        rewrite: () => '/search',
      },
    },
  },
})
