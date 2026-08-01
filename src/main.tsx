import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './finder.css'
import './loading.css'
import App from './App.tsx'
import { registerSweptZoningLayers } from './data/ncZoning'
import zoningLayerManifest from './data/zoning-layer-manifest.json'

// Install the verified county/municipal zoning layers before anything renders,
// so the first lookup already has official GIS coverage rather than falling
// through to web research. ncZoning stays import-free on purpose (see there).
registerSweptZoningLayers(zoningLayerManifest)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Register the PWA service worker (production only, to keep Vite HMR clean in dev).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('SW registration failed:', err))
  })
}
