# leaflet-webgl-markers

A Leaflet plugin for rendering **millions of point markers** on a single WebGL
canvas, with GPU-side Mercator projection, FBO color-coded picking, and zero
redraw while the map is dragged or zoomed.

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

The demo uses [AMap](https://www.amap.com/) tiles; no API key is required for
the demo.

## License

[MIT](./LICENSE)
