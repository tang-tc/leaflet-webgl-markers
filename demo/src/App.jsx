/**
 * App.jsx — WebGLMarkerLayer + MarkerPopup demo
 */

import { useEffect } from 'react'
import { MapContainer, TileLayer, Marker, Popup, Circle, Polygon, useMap } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import L from 'leaflet'
import { WebGLMarker, WebGLMarkerLayer } from 'leaflet-webgl-markers'
import { openMarkerPopup } from 'leaflet-webgl-markers/popup'
import 'leaflet-webgl-markers/popup.css'
import './App.css'

// ============================================================
// Data generation
// ============================================================

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

function hslToRgb(h, s, l) {
  const a = s * Math.min(l, 1 - l)
  const f = (n) => {
    const k = (n + h * 12) % 12
    return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)))
  }
  return [f(0), f(8), f(4)]
}

// ============================================================
// WebGL layer + popup
// ============================================================

function WebGLOverlay() {
  const map = useMap()

  useEffect(() => {

    // Create the layer
    const layer = new WebGLMarkerLayer({
      iconSize: 38,
      textureUrl: '/airplane.png',
    })
    layer.addTo(map)

    // Generate 1M random planes (addMarker coalesces via rAF and renders once)
    const rng = mulberry32(99)
    const latRange = 54 - 18, lngRange = 135 - 73
    for (let i = 0; i < 1000000; i++) {
      const lat = 18 + rng() * latRange
      const lng = 73 + rng() * lngRange
      const rotation = rng() * Math.PI * 2
      const hue = 0.65 - ((lat - 18) / latRange) * 0.6
      const s = 0.7 + rng() * 0.3
      const l = 0.5 + rng() * 0.2
      const [r, g, b] = hslToRgb(hue, s, l)
      layer.addMarker(new WebGLMarker({
        latlng: [lat, lng], rotation, color: [r, g, b],
        data: { index: i, lat: lat.toFixed(4), lng: lng.toFixed(4), rotation: rotation.toFixed(2) },
      }))
    }

    // Zoom-based layer size: the policy lives in the caller; the package only
    // provides setIconSize. Low zooms show many markers and fill cost grows with
    // count x size², so shrink the size as zoom decreases. zoomend + a
    // change-guard avoid duplicate full redraws at the end of a zoom.
    let currentSize = null
    const sizeForZoom = (zoom) => {
      if (zoom <= 4) return 8
      if (zoom <= 6) return 12
      if (zoom <= 8) return 18
      if (zoom <= 10) return 26
      return 38
    }
    const applySizeForZoom = () => {
      const next = sizeForZoom(map.getZoom())
      if (next === currentSize) return
      currentSize = next
      layer.setIconSize(next)
    }
    applySizeForZoom()
    map.on('zoomend', applySizeForZoom)

    // Hover -> pointer cursor (mouseover / mouseout have transition semantics)
    let hovered = false
    layer.on('mouseover', () => {
      hovered = true
      map.getContainer().style.cursor = 'pointer'
    })
    layer.on('mouseout', () => {
      hovered = false
      map.getContainer().style.cursor = ''
    })

    // Click -> popup (fires only when a marker is hit; e.marker is always non-null)
    let activePopup = null
    layer.on('click', (e) => {
      if (activePopup) { activePopup.close(); activePopup = null }
      const m = e.marker
      activePopup = openMarkerPopup(map, m.latlng, {
        title: `Flight ${m.data.index}`,
        rows: [
          ['No.', `#${m.data.index}`],
          ['Latitude', m.data.lat],
          ['Longitude', m.data.lng],
          ['Heading', `${m.data.rotation} rad`],
          ['Marker ID', `#${m.id}`],
        ],
      })
    })

    // Blank clicks close the popup (blank space is map semantics, not layer semantics)
    const closePopupOnBlank = () => {
      if (hovered) return
      if (activePopup) { activePopup.close(); activePopup = null }
    }
    map.on('click', closePopupOnBlank)

    return () => {
      map.off('zoomend', applySizeForZoom)
      map.off('click', closePopupOnBlank)
      if (activePopup) activePopup.close()
      layer.remove()
    }
  }, [map])

  return null
}

// ============================================================
// Native Leaflet layers (coexisting with the WebGL overlay)
// ============================================================

function DemoLayers() {
  const canvasRenderer = L.canvas()

  return (
    <>
      <Circle center={[35, 105]} radius={300000}
        pathOptions={{ color: '#3b82f6', fillColor: '#3b82f6', fillOpacity: 0.1 }}
        renderer={canvasRenderer}>
        {/* <Popup>Central China, radius 300km</Popup> */}
      </Circle>
      <Polygon positions={[[40, 110], [38, 115], [36, 108]]}
        pathOptions={{ color: '#f59e0b', fillColor: '#f59e0b', fillOpacity: 0.15 }}
        renderer={canvasRenderer}>
        <Popup>Example polygon</Popup>
      </Polygon>
      <Marker position={[35, 105]} renderer={canvasRenderer}>
        <Popup>Map center</Popup>
      </Marker>
    </>
  )
}

// ============================================================
// Root component
// ============================================================

export default function App() {
  return (
    <div className="app">
      <div className="map-panel">
        <MapContainer
          center={[35, 105]} zoom={12}
          scrollWheelZoom={true}
          style={{ width: '100%', height: '100%' }}
        >
          <TileLayer
            attribution='&copy; AMap'
            url="https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}"
            subdomains="1234"
          />
          <WebGLOverlay />
          <DemoLayers />
        </MapContainer>
      </div>
    </div>
  )
}
