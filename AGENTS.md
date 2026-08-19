# AGENTS.md

Guidance for AI agents (and contributors) working on this repository. Read this
before changing the library.

## Layout

- `packages/leaflet-webgl-markers` — ESM-only library. Vite lib mode produces the
  JS bundles; `tsc --emitDeclarationOnly` produces the type declarations; the
  public surface is exactly what `src/index.ts` exports.
- `demo` — React/Leaflet demo that consumes the library as a workspace package.
  In dev (`npm run dev`) Vite aliases the library to its source for hot reload;
  production builds resolve the built `dist` exactly like a real consumer.

## Commands

```bash
npm install
npm run dev          # demo against library source
npm run build        # library first, then demo (against dist)
npm run build:lib    # library only
npm run lint         # oxlint over library + demo
```

## Non-negotiable invariants

Do not break any of these while refactoring:

1. Pick pixels and the slot decode table are published **atomically** inside the
   same synchronous render call; `_pick` reads only the published snapshot.
2. Picking returns `hit | miss | unavailable`. `unavailable` must never be
   treated as `miss` — hover keeps its state and click stays silent.
3. `CustomCanvasLayer.isAligned()` is the single authority for pixel-safe
   alignment. Do not enumerate Leaflet private animation flags anywhere else.
4. `WebGLMarker` is a pure data object: no EventEmitter, no DOM/GPU references,
   no layer-private state. One instance may join many layers.
5. Layer-private state (slot index, hover target) lives outside markers.
6. Slots are append-only: slot order == insertion order == z-order. Dead slots
   are never reused; `_rebuildBuffer` rebuilds from `_markerMap`.
7. The package provides capabilities, never strategies: no LOD curves, no size
   hooks, no selection state. `setIconSize(number)` is the only size mutation.
8. Events are subscription-enabled: with no pointer listeners there is no pick
   FBO and no `readPixels`.
9. Only EPSG:3857 is supported; `addTo` must fail fast on any other CRS.
10. Public-facing text (errors, docs, commit messages) is English. Keep the
    public API minimal and stable.

## Release checklist

- `npm run lint && npm run build` before committing.
- `npm publish` runs `prepublishOnly`, which rebuilds the package.
- `dist/` is gitignored and regenerated at publish time; never commit it.
- Keep `README.md` (package-level) in sync with the public API.

## Deferred work (by design)

- Automated tests (vitest) — not set up yet.
- CPU-side pre-projection + generic affine transform (arbitrary CRS support).
- float32 precision at deep zooms (~z18, several-pixel quantization).
- Built-in LOD/subsampling — intentionally left to consumers via `setIconSize`.
