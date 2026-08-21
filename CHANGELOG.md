# Changelog

All notable changes to `leaflet-webgl-markers` are documented here.

## 0.2.4 — 2026-08-21

- Documentation and metadata refresh: README requirements (Leaflet 1.9.x,
  WebGL 1.0, browser compatibility), live demo link, accessibility notes,
  package author metadata, and the official Leaflet plugins list entry.

## 0.2.3 — 2026-08-20

- Fix marker rotation direction: positive radians now rotate clockwise on
  screen (compass heading from north) in both the display and pick passes.

## 0.2.2 — 2026-08-20

- Follow `flyTo` animations: the canvas now tracks pan+zoom per frame with a CSS
  transform instead of staying frozen until `moveend`.

## 0.2.1 — 2026-08-19

- Ship `@types/leaflet` as a regular dependency so TypeScript consumers no
  longer need to install it manually.

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
