/**
 * copy-assets.mjs — copy static assets (CSS, etc.) into dist/ after build.
 * Invoked from npm run build after vite + tsc.
 */

import { cpSync } from 'node:fs'

// popup.css — copy CSS into dist/
cpSync('src/popup/leaflet-marker-popup.css', 'dist/popup.css')

console.log('[copy-assets] done')
