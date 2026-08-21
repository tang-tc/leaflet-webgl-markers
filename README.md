# leaflet-webgl-markers

[![npm version](https://img.shields.io/npm/v/leaflet-webgl-markers)](https://www.npmjs.com/package/leaflet-webgl-markers)

A Leaflet plugin for rendering **millions of point markers** on a single WebGL
canvas, with GPU-side Mercator projection, FBO color-coded picking, and zero
redraw while the map is dragged or zoomed.

## Install

```bash
npm install leaflet leaflet-webgl-markers
```

Then create a layer and add markers:

```js
import L from 'leaflet'
import { WebGLMarker, WebGLMarkerLayer } from 'leaflet-webgl-markers'

const map = L.map('map').setView([39.9, 116.4], 10)
const layer = new WebGLMarkerLayer({ iconSize: 24 }).addTo(map)

layer.addMarker(new WebGLMarker({ latlng: [39.9, 116.4], color: [1, 0.5, 0] }))
layer.on('click', (e) => console.log(e.marker.data))
```

## Repository layout

```
packages/leaflet-webgl-markers/   # the library (npm package)
demo/                             # React + Leaflet demo (1M markers)
```

## Packages

- [leaflet-webgl-markers](packages/leaflet-webgl-markers) — full API reference,
  behavior notes, and usage examples.

## Development

```bash
npm install
npm run dev       # start the demo (dev server points at the library source)
npm run build     # build the library, then the demo (demo consumes dist like a real consumer)
npm run lint      # lint the library and the demo
```

The demo uses [CARTO](https://carto.com/) dark basemap tiles with OSM + CARTO
attribution; no API key is required.

## License

[MIT](./LICENSE)
