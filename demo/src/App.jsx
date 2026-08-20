/**
 * App.jsx — leaflet-webgl-markers showcase
 *
 * Three datasets share one WebGLMarkerLayer:
 * - Synthetic: up to 1M random points (HSL colored, airplane icons)
 * - Airports: ~48k real airports from OurAirports (public domain)
 * - Earthquakes: last-30-days M2.5+ from USGS (public domain, live with fallback)
 */

import { useCallback, useEffect, useState } from 'react'
import {
  MapContainer,
  TileLayer,
  useMap,
} from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { WebGLMarker, WebGLMarkerLayer } from 'leaflet-webgl-markers'
import { openMarkerPopup } from 'leaflet-webgl-markers/popup'
import 'leaflet-webgl-markers/popup.css'
import './App.css'

// ─────────────────────────────── data helpers ───────────────────────────────

function mulberry32(seed) {
  return function () {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
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

function makeSyntheticMarkers(count) {
  const rng = mulberry32(99)
  // Worldwide spread, like the real datasets (skip the poles).
  const latMin = -60
  const latMax = 75
  const markers = new Array(count)
  for (let i = 0; i < count; i++) {
    const lat = latMin + rng() * (latMax - latMin)
    const lng = -180 + rng() * 360
    const rotation = rng() * Math.PI * 2
    const hue = 0.15 + ((lat - latMin) / (latMax - latMin)) * 0.6
    const [r, g, b] = hslToRgb(hue, 0.7 + rng() * 0.3, 0.5 + rng() * 0.2)
    markers[i] = new WebGLMarker({
      latlng: [lat, lng],
      rotation,
      color: [r, g, b],
      data: {
        index: i,
        lat: lat.toFixed(4),
        lng: lng.toFixed(4),
        rotation: rotation.toFixed(2),
      },
    })
  }
  return markers
}

const AIRPORT_COLORS = {
  L: [1.0, 0.74, 0.3],
  M: [0.3, 0.78, 0.94],
  S: [0.56, 0.88, 0.94],
}
const AIRPORT_TYPES = { L: 'Large', M: 'Medium', S: 'Small' }

async function makeAirportMarkers(baseUrl) {
  const res = await fetch(`${baseUrl}data/airports.json`)
  if (!res.ok) throw new Error(`airports.json ${res.status}`)
  const rows = await res.json()
  return rows.map(
    ([iata, name, city, country, type, lat, lng]) =>
      new WebGLMarker({
        latlng: [lat, lng],
        rotation: 0,
        color: AIRPORT_COLORS[type],
        data: {
          iata: iata || '—',
          name,
          city: city || '—',
          country: country || '—',
          type: AIRPORT_TYPES[type],
        },
      })
  )
}

function quakeColor(mag) {
  if (mag >= 6) return [1.0, 0.22, 0.22]
  if (mag >= 5) return [1.0, 0.54, 0.15]
  if (mag >= 4) return [1.0, 0.85, 0.2]
  if (mag >= 3) return [0.4, 0.9, 0.6]
  return [0.35, 0.74, 0.9]
}

async function makeQuakeMarkers(baseUrl) {
  try {
    const res = await fetch(
      'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_month.geojson'
    )
    if (!res.ok) throw new Error(String(res.status))
    const json = await res.json()
    return json.features.map((f) => {
      const [lng, lat] = f.geometry.coordinates
      return new WebGLMarker({
        latlng: [lat, lng],
        rotation: 0,
        color: quakeColor(f.properties.mag),
        data: {
          mag: f.properties.mag,
          place: f.properties.place ?? '—',
          time: f.properties.time ?? 0,
        },
      })
    })
  } catch {
    // Offline fallback: bundled 30-day snapshot.
    const res = await fetch(`${baseUrl}data/earthquakes.json`)
    const rows = await res.json()
    return rows.map(
      ([lat, lng, mag, place, time]) =>
        new WebGLMarker({
          latlng: [lat, lng],
          rotation: 0,
          color: quakeColor(mag),
          data: { mag, place: place || '—', time },
        })
    )
  }
}

// Soft round sprite rendered at runtime (tinted by marker color).
function circleTextureUrl(size = 64) {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const radius = size / 2
  const gradient = ctx.createRadialGradient(
    radius,
    radius,
    radius * 0.05,
    radius,
    radius,
    radius * 0.96
  )
  gradient.addColorStop(0, 'rgba(255,255,255,1)')
  gradient.addColorStop(0.55, 'rgba(255,255,255,0.95)')
  gradient.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, size, size)
  return canvas.toDataURL('image/png')
}

const DATASETS = {
  synthetic: {
    label: 'Synthetic',
    iconSize: 22,
    texture: 'airplane',
    legend: [['#8ab6ff', 'Synthetic points (HSL by latitude)']],
  },
  airports: {
    label: 'Airports',
    iconSize: 11,
    texture: 'airplane',
    legend: [
      ['#ffbd4d', 'Large'],
      ['#4dc7f0', 'Medium'],
      ['#8fe0f0', 'Small'],
    ],
  },
  earthquakes: {
    label: 'Earthquakes',
    iconSize: 9,
    texture: 'circle',
    legend: [
      ['#ff3838', 'M 6+'],
      ['#ff8a26', 'M 5'],
      ['#ffd933', 'M 4'],
      ['#66e699', 'M 3'],
      ['#59bfe6', 'M 2.5'],
    ],
  },
}

// ─────────────────────────────── layer overlay ───────────────────────────────

function WebGLOverlay({ dataset, count, onStats }) {
  const map = useMap()

  useEffect(() => {
    const cfg = DATASETS[dataset]
    const baseUrl = import.meta.env.BASE_URL
    const textureUrl =
      cfg.texture === 'circle'
        ? circleTextureUrl()
        : `${baseUrl}airplane.svg`

    const layer = new WebGLMarkerLayer({ iconSize: cfg.iconSize, textureUrl })
    layer.addTo(map)

    let markers = []
    let cancelled = false
    let activePopup = null
    let currentSize = null
    let hoverMarker = null
    let hoverRaf = null
    let popMarkerId = null
    let popRaf = null

    const baseSize = () => currentSize ?? cfg.iconSize

    const stopPop = () => {
      if (popRaf) {
        cancelAnimationFrame(popRaf)
        popRaf = null
      }
      if (popMarkerId != null) {
        layer.updateMarker(popMarkerId, { size: null })
        popMarkerId = null
      }
    }

    const stopPulse = () => {
      if (hoverRaf) {
        cancelAnimationFrame(hoverRaf)
        hoverRaf = null
      }
      if (hoverMarker) {
        layer.updateMarker(hoverMarker.id, { size: null })
        hoverMarker = null
      }
    }

    const startPulse = (marker) => {
      stopPulse()
      hoverMarker = marker
      const start = performance.now()
      const tick = () => {
        if (hoverMarker !== marker) return
        const t = (performance.now() - start) / 1000
        const size = Math.max(
          3,
          Math.round(baseSize() * (1 + 0.16 * Math.sin(t * Math.PI * 2 * 0.9)) * 10) / 10
        )
        layer.updateMarker(marker.id, { size })
        hoverRaf = requestAnimationFrame(tick)
      }
      hoverRaf = requestAnimationFrame(tick)
    }

    const playPop = (marker) => {
      stopPop()
      stopPulse()
      popMarkerId = marker.id
      const start = performance.now()
      const duration = 260
      const tick = () => {
        if (popMarkerId !== marker.id) return
        const t = (performance.now() - start) / duration
        if (t >= 1) {
          popRaf = null
          popMarkerId = null
          layer.updateMarker(marker.id, { size: null })
          return
        }
        const factor = 1 + 0.7 * Math.sin(Math.PI * Math.pow(t, 0.55))
        layer.updateMarker(marker.id, {
          size: Math.max(3, baseSize() * factor),
        })
        popRaf = requestAnimationFrame(tick)
      }
      popRaf = requestAnimationFrame(tick)
    }

    const report = () => {
      let visible = null
      if (dataset !== 'synthetic' && markers.length > 0) {
        const bounds = map.getBounds()
        let n = 0
        for (const m of markers) {
          if (bounds.contains(m.latlng)) n++
        }
        visible = n
      }
      onStats({ markers: layer.count, zoom: map.getZoom(), visible })
    }

    const applySizeForZoom = () => {
      const z = map.getZoom()
      const f =
        z <= 4 ? 0.45 : z <= 6 ? 0.6 : z <= 8 ? 0.75 : z <= 10 ? 0.9 : 1
      const next = Math.max(3, Math.round(cfg.iconSize * f * 10) / 10)
      if (next !== currentSize) {
        currentSize = next
        layer.setIconSize(next)
      }
    }

    layer.on('mouseover', (e) => {
      map.getContainer().style.cursor = 'pointer'
      startPulse(e.marker)
    })
    layer.on('mouseout', () => {
      map.getContainer().style.cursor = ''
      stopPulse()
    })

    layer.on('click', (e) => {
      playPop(e.marker)
      if (activePopup) {
        activePopup.close()
        activePopup = null
      }
      const d = e.marker.data
      let title = ''
      let rows = []
      if (dataset === 'airports') {
        title = d.name
        rows = [
          ['IATA', d.iata],
          ['City', d.city],
          ['Country', d.country],
          ['Type', d.type],
        ]
      } else if (dataset === 'earthquakes') {
        title = `M ${d.mag.toFixed(1)} earthquake`
        rows = [
          ['Place', d.place],
          ['Time', new Date(d.time).toLocaleString()],
        ]
      } else {
        title = `Flight #${d.index}`
        rows = [
          ['Latitude', d.lat],
          ['Longitude', d.lng],
          ['Heading', `${d.rotation} rad`],
        ]
      }
      activePopup = openMarkerPopup(map, e.marker.latlng, { title, rows })
    })

    const closeOnBlank = () => {
      if (activePopup) {
        activePopup.close()
        activePopup = null
      }
    }
    map.on('click', closeOnBlank)
    map.on('moveend', report)
    map.on('zoomend', applySizeForZoom)

    const run = async () => {
      try {
        if (dataset === 'synthetic') {
          markers = makeSyntheticMarkers(count)
        } else if (dataset === 'airports') {
          markers = await makeAirportMarkers(baseUrl)
        } else {
          markers = await makeQuakeMarkers(baseUrl)
        }
        if (cancelled) return
        layer.setMarkers(markers)
        applySizeForZoom()
        report()
      } catch (err) {
        console.error('[demo] failed to load dataset', err)
      }
    }
    run()

    return () => {
      cancelled = true
      stopPulse()
      stopPop()
      map.off('click', closeOnBlank)
      map.off('moveend', report)
      map.off('zoomend', applySizeForZoom)
      if (activePopup) activePopup.close()
      layer.remove()
    }
  }, [map, dataset, count, onStats])

  return null
}

// Cinematic opening: fly from a world view down to the default region.
function IntroFlight() {
  const map = useMap()

  useEffect(() => {
    map.stop()
    const timer = window.setTimeout(() => {
      // Land on a full-world view: the datasets are global (airports + quakes).
      map.flyTo([20, 10], 2, { duration: 2.2 })
    }, 250)
    return () => window.clearTimeout(timer)
  }, [map])

  return null
}

// ─────────────────────────────── controls ───────────────────────────────

const SYNTHETIC_COUNTS = [50000, 200000, 1000000]

function Controls({ dataset, setDataset, count, setCount, stats }) {
  const cfg = DATASETS[dataset]
  const fmt = (n) => (n == null ? '—' : n.toLocaleString('en-US'))

  return (
    <aside className="controls">
      <h1>
        leaflet-webgl-markers
        <a href="https://github.com/tang-tc/leaflet-webgl-markers" target="_blank" rel="noreferrer">
          GitHub ↗
        </a>
      </h1>

      <div className="seg datasets">
        {Object.keys(DATASETS).map((key) => (
          <button
            key={key}
            type="button"
            className={dataset === key ? 'active' : ''}
            onClick={() => setDataset(key)}
          >
            {DATASETS[key].label}
          </button>
        ))}
      </div>

      {dataset === 'synthetic' && (
        <div className="seg counts">
          {SYNTHETIC_COUNTS.map((n) => (
            <button
              key={n}
              type="button"
              className={count === n ? 'active' : ''}
              onClick={() => setCount(n)}
            >
              {fmt(n)}
            </button>
          ))}
        </div>
      )}

      <div className="legend">
        {cfg.legend.map(([color, label]) => (
          <div key={label}>
            <span className="swatch" style={{ background: color }} />
            {label}
          </div>
        ))}
      </div>

      <div className="stats">
        <div>
          <span>Markers</span>
          <strong>{fmt(stats.markers)}</strong>
        </div>
        <div>
          <span>On screen</span>
          <strong>{fmt(stats.visible)}</strong>
        </div>
        <div>
          <span>Zoom</span>
          <strong>{stats.zoom}</strong>
        </div>
      </div>

      <p className="note">
        Airports: OurAirports (public domain). Earthquakes: USGS (public domain,
        live feed with offline fallback). Icon size follows zoom via a
        caller-side <code>setIconSize</code> policy.
      </p>
    </aside>
  )
}

// ─────────────────────────────── root ───────────────────────────────

export default function App() {
  const [dataset, setDataset] = useState('airports')
  const [count, setCount] = useState(200000)
  const [stats, setStats] = useState({ markers: 0, zoom: 5, visible: null })

  const handleStats = useCallback((next) => setStats(next), [])

  return (
    <div className="app">
      <MapContainer
        center={[5, 10]}
        zoom={1.5}
        scrollWheelZoom
        style={{ width: '100%', height: '100%' }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          subdomains="abcd"
        />
        <IntroFlight />
        <WebGLOverlay dataset={dataset} count={count} onStats={handleStats} />
      </MapContainer>
      <Controls
        dataset={dataset}
        setDataset={setDataset}
        count={count}
        setCount={setCount}
        stats={stats}
      />
    </div>
  )
}
