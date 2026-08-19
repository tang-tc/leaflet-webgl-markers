# Changelog

All notable changes to `leaflet-webgl-markers` are documented here.

## 0.2.0 — 2026-08-19

First public release.

- WebGL point-marker rendering with GPU Mercator projection (EPSG:3857 only,
  enforced at `addTo`)
- FBO color-coded picking with an atomic snapshot and
  `hit / miss / unavailable` tri-state results
- Leaflet-compatible events: `mouseover / mouseout / click / dblclick /
  contextmenu` plus `add / remove / load / error`
- Append-only incremental vertex buffer with `compact()` and bulk `setMarkers()`
- `setIconSize()` with input validation; no built-in LOD policy
- Optional `popup` submodule (`openMarkerPopup` + CSS)
- ESM-only distribution with TypeScript declarations
