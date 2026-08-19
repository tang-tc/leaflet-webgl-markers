import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'node:url'

const dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig(({ command }) => ({
  plugins: [react()],
  resolve:
    command === 'serve'
      ? {
          // Dev only: point at the library source for instant hot reload.
          // Production build resolves the workspace package (dist) exactly
          // like a real consumer would.
          alias: [
            {
              find: 'leaflet-webgl-markers/popup.css',
              replacement: path.resolve(
                dirname,
                '../packages/leaflet-webgl-markers/src/popup/leaflet-marker-popup.css'
              ),
            },
            {
              find: 'leaflet-webgl-markers/popup',
              replacement: path.resolve(
                dirname,
                '../packages/leaflet-webgl-markers/src/popup'
              ),
            },
            {
              find: 'leaflet-webgl-markers',
              replacement: path.resolve(
                dirname,
                '../packages/leaflet-webgl-markers/src'
              ),
            },
          ],
        }
      : undefined,
}))
