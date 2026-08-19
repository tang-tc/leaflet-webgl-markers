import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  build: {
    lib: {
      entry: {
        'leaflet-webgl-markers': resolve(__dirname, 'src/index.ts'),
        popup: resolve(__dirname, 'src/popup/index.ts'),
      },
      formats: ['es'],
    },
    rollupOptions: {
      external: ['leaflet'],
    },
  },
  css: {
    // Keep CSS as a standalone file instead of inlining it into JS; consumers
    // import it explicitly through the exports map.
  },
})
