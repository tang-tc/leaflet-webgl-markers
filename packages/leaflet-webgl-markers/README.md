# leaflet-webgl-markers

[![npm version](https://img.shields.io/npm/v/leaflet-webgl-markers)](https://www.npmjs.com/package/leaflet-webgl-markers)

Leaflet plugin for rendering **millions of point markers** on a single WebGL canvas:
GPU Mercator projection + FBO picking + zero redraw while dragging/zooming.

## Features

- **Millions of markers**: lat/lng lives in a vertex buffer and the Mercator
  projection runs in the vertex shader. Dragging/zooming never rebuilds the
  buffer; the canvas follows via CSS transform with zero JS redraw and only
  redraws once on `moveend`.
- **FBO color-coded picking**: O(1) picking with a 3x3 Gaussian-weighted
  neighborhood to handle transparent icon edges.
- **Incremental buffer**: add/remove/update write in place via `bufferSubData`
  (append-only, holes are never reused); growth or `compact()` compacts in order.
- **No built-in visuals**: the layer only renders, picks, and notifies. Hover
  highlight, selection glow, etc. are implemented in your event handlers.
- **Coexists with native Leaflet layers**: the canvas uses
  `pointer-events: none` plus map event delegation, and interaction events fire
  only when a marker is actually hit.

## Install

```bash
npm install leaflet-webgl-markers
```

Peer dependency: `leaflet@^1.9.0` (install it yourself). `@types/leaflet` is
shipped as a regular dependency, so TypeScript users get the types automatically.

> ESM-only: there is no `main` field; you need a resolver that understands the
> `exports` field (modern bundlers).
>
> TypeScript: `moduleResolution: "bundler"` or `"nodenext"` is recommended. If
> your tsconfig turns `skipLibCheck` off, enable `esModuleInterop` (or
> `allowSyntheticDefaultImports`) because the declarations use a default leaflet
> import.

## Quick start

```ts
import L from 'leaflet'
import { WebGLMarker, WebGLMarkerLayer } from 'leaflet-webgl-markers'

const layer = new WebGLMarkerLayer({
  iconSize: 38,            // layer default icon size (CSS pixels)
  textureUrl: '/airplane.png',
})
layer.addTo(map)

// Add markers
const m = new WebGLMarker({
  latlng: [39.9, 116.4],
  rotation: 0.5,                // radians; 0 = pointing north
  color: [0.8, 0.3, 0.2],       // RGB tint; [1, 1, 1] = no tint
  size: 60,                     // optional; overrides layer iconSize (CSS pixels)
  data: { flightId: 'CA1234' },
})
layer.addMarker(m)

// Events (Leaflet interaction layer parity: mouseover / mouseout / click / dblclick / contextmenu)
layer.on('click', (e) => {
  /* Fires only when a marker is hit; e.marker is always non-null */
  console.log(e.marker.data)
})
layer.on('mouseover', () => {
  map.getContainer().style.cursor = 'pointer'
})
layer.on('mouseout', () => {
  map.getContainer().style.cursor = ''
})
```

Popup (optional submodule):

```ts
import { openMarkerPopup } from 'leaflet-webgl-markers/popup'
import 'leaflet-webgl-markers/popup.css'

const popup = openMarkerPopup(map, latlng, {
  title: 'Flight',
  rows: [['No.', '#123'], ['Latitude', '39.9']],
})
popup.close()
```

## API

### WebGLMarker (pure data object)

```ts
new WebGLMarker(opts | [lat, lng])
```

| Option | Type | Default | Description |
|------|------|------|------|
| `latlng` | `L.LatLng \| [number, number]` | — | Geographic position (required) |
| `rotation` | `number` | `0` | Rotation in radians; 0 = pointing north |
| `color` | `[number, number, number]` | `[1, 1, 1]` | RGB tint; `[1, 1, 1]` = no tint |
| `size` | `number \| null` | `null` | Icon size in CSS pixels; `null` or `<= 0` follows the layer `iconSize` |
| `visible` | `boolean` | `true` | When `false`, the vertex is pushed off screen: not rendered, not picked |
| `opacity` | `number` | `1` | Opacity 0..1 (clamped to `[0, 1]` before upload) |
| `data` | `unknown` | `null` | Application data; read via `e.marker.data` in event handlers |

- Markers are **pure data objects**: no EventEmitter, no DOM/GPU references; besides
  `latlng`/`data` they hold only ten scalar fields.
- The readonly `id` is unique per library copy and used only for identity/debugging;
  it does **not** participate in picking (picking uses layer-internal slots, see
  "Picking & multiple library copies").
- Markers carry no layer-private state (slots and selection live outside the
  marker), so one marker instance can safely join multiple layers.

### WebGLMarkerLayer

#### Options

| Option | Type | Default | Description |
|------|------|------|------|
| `iconSize` | `number` | `40` | Layer default icon size (CSS pixels); fallback for `marker.size` |
| `textureUrl` | `string` | none | Icon texture URL; omit to use a built-in 1x1 white texture (solid-color squares) |
| `capacityFactor` | `number` | `1.2` | Buffer growth factor (>= 1). Larger = fewer rebuilds, more GPU memory |

#### Events

The event machinery reuses `L.Evented` (`on / off / once / listens` all work and
`fire` injects `{ type, target }`). Every interaction event is
**subscription-enabled** — with no listeners there is no picking and no
`readPixels` cost. Interaction events do not bubble to the map by default (the
map already received the same DOM event, avoiding double firing). Parent event
propagation (`addEventParent`) is not wired and has been removed from the API.
Note this is a **prototype mixin, not inheritance**:
`layer instanceof L.Evented === false` (duck typing), so third-party tools that
rely on `instanceof` will not recognize it.

**Interaction events** (payload `MarkerPointerEvent`, aligned with Leaflet `Path`):

| Field | Type | Description |
|------|------|------|
| `marker` | `WebGLMarker` | The hit marker (always non-null) |
| `latlng` | `L.LatLng` | Pointer geographic position |
| `containerPoint?` | `L.Point` | Pointer position in container pixels |
| `layerPoint?` | `L.Point` | Pointer position in layer pixels |
| `originalEvent?` | `MouseEvent` | Original DOM event |
| `reason?` | `'move' \| 'remove' \| 'clear'` | `mouseout` only: why the hover ended |

| Event | When it fires |
|------|----------|
| `mouseover` | Hover enters a marker |
| `mouseout` | Hover leaves / switches to another marker / pointer leaves the map container (`reason:'move'`); synthesized without `originalEvent` when the hovered marker is removed (`'remove'`) or the data is cleared (`'clear'`) |
| `click` | The point hits a marker; blank clicks are not layer semantics — listen to the `map` for those |
| `dblclick` | Double-click hits a marker |
| `contextmenu` | Right-click hits a marker |

`mouseover / mouseout` have **transition semantics**: moving within the same
marker does not re-fire, and a quick sweep in-and-out is never swallowed (rAF
frame coalescing). Hover is suspended automatically during drag/zoom animations
and resumes afterwards.

**Lifecycle / ready / error events**:

| Event | When it fires | Key payload |
|------|----------|--------------|
| `add` | Synchronously after `addTo()` mounts the canvas | — |
| `remove` | Synchronously on `remove()` (synthesizes `mouseout` first if hovering) | — |
| `load` | First successful render (GL ready + shaders compiled + texture loaded + first frame); fires again after a context-loss rebuild | — |
| `error` | Initialization / render failure; deduplicated per `stage` within one mount session | `stage` (`'context' \| 'shader' \| 'texture' \| 'render'`), `message`, `error?` |

#### on / off

```ts
layer.on('click', handler)              // register
layer.on('click mouseover', handler)    // space-separated event string
layer.on({ click: fn1, mouseover: fn2 }) // object form
layer.once('load', handler)             // one-shot
layer.off('click', handler)             // remove one handler
layer.off('click')                      // remove all handlers for an event
```

#### Picking (internal capability)

Picking is only the internal engine behind the interaction events — **no public
pick API**:

- `mouseover / mouseout / click / dblclick / contextmenu` hit-testing all goes
  through an internal `_pick(containerPoint)` that reads an **atomically
  published snapshot** (FBO pixels + decode table packed from the same frame),
  sharing the projection and FBO layout with the display pass;
- hits are decided by texture `alpha`, exactly like the display pass; transparent
  areas are not pickable;
- while the view is moving (drag, inertia, panBy, flyTo, pinch, zoom animation)
  picking returns `unavailable`: it never guesses when the published frame does
  not match the current viewport;
- `moveend / zoomend` re-renders and publishes a fresh snapshot, after which
  picking recovers automatically;
- with no interaction listeners, the pick FBO is neither created nor refreshed —
  zero picking overhead.

#### CRUD

| Method | Description |
|------|------|
| `addMarker(marker)` | Add (incremental write; marks dirty and rebuilds on first frame when GL is not ready). Adding the same instance twice is idempotent; the same id with a different instance throws |
| `removeMarker(id)` | Remove (writes a NaN tombstone; dead slots are never reused and are compacted in order on growth or `compact()`; synthesizes `mouseout` if hovering) |
| `updateMarker(id, changes)` | Update in place (`WebGLMarkerUpdate` = `Partial<WebGLMarkerOptions>`; latlng accepts `L.LatLng` or `[lat, lng]`) |
| `setMarkers(markers)` | Bulk replace (clears, marks dirty, rebuilds on next render; elements must be `WebGLMarker` instances with unique ids, otherwise it throws). **Prefer this for bulk data** |
| `getMarker(id)` | Look up by id |
| `setIconSize(size)` | Set the layer default icon size (only affects markers with `size: null`). Must be a finite number > 0, otherwise throws; setting the current value skips the redraw |
| `compact()` | Manually compact holes and rebuild a contiguous buffer (usually unnecessary; growth compacts automatically) |
| `redraw()` | Manually trigger one render (skipped while the view is moving; `moveend` re-renders) |
| `remove()` | Remove from the map and release GL resources |
| `get count` | Number of live markers (deleted markers excluded) |

#### Selection semantics (implemented by you)

The layer keeps no selection state and ships no selection helper — a few lines
of app code suffice:

```ts
const selected = new Set<WebGLMarker>()

layer.on('click', (e) => {
  if (selected.has(e.marker)) {
    selected.delete(e.marker)
    layer.updateMarker(e.marker.id, { color: [0.2, 0.5, 0.8] })
  } else {
    selected.add(e.marker)
    layer.updateMarker(e.marker.id, { color: [1, 0.5, 0] })
  }
})

// Single selection: clear the Set before adding; clean the Set in the same code path that removes markers.
```

#### visible / opacity / size semantics

- **`visible`**: `false` writes NaN coordinates; the vertex shader pushes the
  point off screen with `gl_PointSize = 0` (not rendered, not picked). Setting it
  back to `true` restores it automatically.
- **`opacity`**: 0..1, `0` is fully transparent; out-of-range values are clamped
  to `[0, 1]` before upload. Both passes discard `alpha < 0.05` (not rendered,
  not picked).
- **`size`**: **absolute pixels** (CSS), overriding the layer `iconSize`;
  `null` or `<= 0` follows the layer `iconSize` (changes with `setIconSize`).
  A change only reaches the GPU after `updateMarker(id, { size })`.

### CustomCanvasLayer (internal, not exported)

`CustomCanvasLayer` is the internal canvas-lifecycle and drag/zoom-sync
implementation behind `WebGLMarkerLayer` and is **not exported**. See the source
at `src/overlay/CustomCanvasLayer.ts` for details.

## Behavior notes

### Hover pipeline & suspension

- after data changes (add / remove / update / setMarkers / compact) and before
  the next frame renders, picking keeps the previous frame's semantics
  (what-you-see-is-what-you-hit) and can never mismatch across markers;
- pointers over popups / tooltips / controls / DOM markers are treated as blank
  space (leaving the hovered marker fires `mouseout`);
- users who need mousemove-level tracking should listen to the map's
  `mousemove` themselves; this layer exposes no pick API.

### Multiple layers (no automatic dedup)

When several `WebGLMarkerLayer`s (or other map listeners) are stacked, the map
container's `click / dblclick / contextmenu / mousemove` are processed by every
layer independently — events are not deduplicated. Implement ownership yourself
in handlers if needed (e.g. via `e.marker`, a current-layer flag, or
`originalEvent`).

### dblclick & doubleClickZoom

Leaflet enables `doubleClickZoom` by default. If you also listen to `dblclick`,
a marker double-click **zooms the map first, then fires the event**. Set
`doubleClickZoom: false` in the map options if you only want the event.

### z-order

Later markers draw on top (slots grow in insertion order; draw order == insertion
order). Holes left by removals are compacted by growth or `compact()` with
relative order preserved; when markers overlap, picking also returns the
later-added one.

### High DPI

Icon sizes are declared in CSS pixels and multiplied by `devicePixelRatio` to
form `gl_PointSize`, so icons do not shrink on `dpr=2` displays.

### CRS support

Only Leaflet's default EPSG:3857 (Web Mercator, `L.CRS.EPSG3857`) is supported:
the vertex shader inlines that projection's math. Passing another CRS (e.g. a
proj4leaflet custom projection) makes `addTo` throw immediately instead of
silently misplacing markers. CPU-side pre-projection for arbitrary CRS is planned
for a future version.

### Low-zoom performance & LOD

GPU fill cost is proportional to "visible markers x icon area", and area grows
with `size²`. With very many markers visible at once (e.g. 1M across the whole
map), one redraw can take hundreds of milliseconds (measured: 38px ~ 200ms,
8px ~ 50ms), which stutters the `moveend` redraw after a drag.

The package ships no zoom curves, level thresholds, or sizing policy — only the
`setIconSize(number)` capability. When and how to change the size is entirely
your decision, for example shrinking with zoom:

```js
const layer = new WebGLMarkerLayer({ iconSize: 38 })

let current = 38
map.on('zoomend', () => {
  const next = map.getZoom() <= 8 ? 8 : 38
  if (next !== current) {
    current = next
    layer.setIconSize(next)
  }
})
```

- Keep a `current` change-guard to avoid an extra full redraw on every zoom
  (`setIconSize` already no-ops on the same value);
- `setIconSize` only affects markers with `marker.size === null`; explicit
  `marker.size` values stay absolute pixels;
- display and picking share the same size, so "what you see is what you hit"
  is preserved;
- to measure real GPU time, force synchronization with `redraw() +
  gl.readPixels()` — `gl.finish()` does not truly wait for rasterization on some
  D3D11/ANGLE setups;
- if the budget is still exceeded at the size floor, subsampling the marker count
  is the next lever; it is not built in.

### Picking & multiple library copies

Pick colors encode the **layer-internal storage slot index**, not the global
marker id. Passing a marker across two loaded copies of the library is rejected
by the `instanceof` check in `addMarker`.

### Context loss recovery

The layer listens to `webglcontextlost / webglcontextrestored`. On loss it drops
all GL resources and fires `error` (`stage: 'context'`); on restore it rebuilds
shaders + buffer + texture automatically and fires `load` again after a
successful rebuild, avoiding a black screen.

## Development

```bash
npm run build          # vite build + tsc declarations + copy static assets
npm run build:watch    # watch mode (vite build --watch)
```

## License

[MIT](./LICENSE)
