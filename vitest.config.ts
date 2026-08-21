import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['packages/leaflet-webgl-markers/tests/**/*.test.ts'],
    setupFiles: ['packages/leaflet-webgl-markers/tests/setup.ts'],
  },
})
