/**
 * App.jsx — leaflet-webgl-markers showcase
 *
 * Three datasets share one WebGLMarkerLayer:
 * - Synthetic: up to 1M random points (HSL colored, airplane icons)
 * - Airports: ~48k real airports from OurAirports (public domain)
 * - Earthquakes: last-30-days M2.5+ from USGS (public domain, live with fallback)
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  MapContainer,
  TileLayer,
  useMap,
} from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import L from 'leaflet'
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

// Great-circle interpolation + initial bearing (radians, 0 = north, clockwise).
function greatCircle(lat1, lng1, lat2, lng2, f) {
  const r1 = (lat1 * Math.PI) / 180
  const r2 = (lat2 * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const a = Math.sin(r1) * Math.sin(r2) + Math.cos(r1) * Math.cos(r2) * Math.cos(dLng)
  const d = Math.acos(Math.min(1, Math.max(-1, a)))
  if (d < 1e-9) return [lat1, lng1]
  const A = Math.sin((1 - f) * d) / Math.sin(d)
  const B = Math.sin(f * d) / Math.sin(d)
  const x = A * Math.cos(r1) * Math.cos((lng1 * Math.PI) / 180) + B * Math.cos(r2) * Math.cos((lng2 * Math.PI) / 180)
  const y = A * Math.cos(r1) * Math.sin((lng1 * Math.PI) / 180) + B * Math.cos(r2) * Math.sin((lng2 * Math.PI) / 180)
  const z = A * Math.sin(r1) + B * Math.sin(r2)
  return [(Math.atan2(z, Math.sqrt(x * x + y * y)) * 180) / Math.PI, (Math.atan2(y, x) * 180) / Math.PI]
}

function bearing(lat1, lng1, lat2, lng2) {
  const r1 = (lat1 * Math.PI) / 180
  const r2 = (lat2 * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const y = Math.sin(dLng) * Math.cos(r2)
  const x = Math.cos(r1) * Math.sin(r2) - Math.sin(r1) * Math.cos(r2) * Math.cos(dLng)
  return Math.atan2(y, x)
}

const HUB_IATAS = [
  'JFK', 'LHR', 'PEK', 'SFO', 'SIN', 'DXB', 'HND', 'SYD', 'LAX', 'CDG',
  'FRA', 'AMS', 'ICN', 'HKG', 'IST', 'GRU', 'JNB', 'MEX', 'BOM', 'DEL',
  'YYZ', 'ORD', 'ATL', 'MIA', 'MAD', 'FCO', 'ZRH', 'VIE', 'SEA', 'YVR',
  'AKL', 'KUL', 'BKK', 'DOH', 'AUH', 'RUH', 'CAI', 'LOS', 'NBO', 'CPT',
]

async function buildFlights(baseUrl) {
  const res = await fetch(`${baseUrl}data/airports.json`)
  if (!res.ok) throw new Error(`airports.json ${res.status}`)
  const rows = await res.json()
  const byIata = new Map()
  for (const [iata, name, city, country, , lat, lng] of rows) {
    if (iata) byIata.set(iata, { iata, name, city, country, lat, lng })
  }

  const hubs = HUB_IATAS.map((code) => byIata.get(code)).filter(Boolean)
  const routes = []
  for (let i = 0; i < hubs.length; i++) {
    const from = hubs[i]
    const to = hubs[(i * 7 + 3) % hubs.length]
    const latlngs = []
    for (let s = 0; s <= 64; s++) {
      latlngs.push(greatCircle(from.lat, from.lng, to.lat, to.lng, s / 64))
    }
    const marker = new WebGLMarker({
      latlng: [from.lat, from.lng],
      rotation: bearing(from.lat, from.lng, to.lat, to.lng),
      color: [0.35, 0.88, 1.0],
      data: { from: `${from.iata} · ${from.city}`, to: `${to.iata} · ${to.city}` },
    })
    routes.push({
      marker,
      from,
      to,
      latlngs,
      progress: Math.random() * 0.9,
      direction: 1,
      // One leg in 25-55 seconds.
      speed: 1 / (25 + Math.random() * 30),
    })
  }
  return routes
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
    iconSize: 16,
    lodFloor: 0.6,
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
  flights: {
    label: 'Flights',
    iconSize: 26,
    lodFloor: 0.65,
    texture: 'airplane',
    legend: [['#59d2ff', 'Planes on great-circle routes']],
  },
}

// ─────────────────────────────── layer overlay ───────────────────────────────

function WebGLOverlay({
  dataset,
  count,
  onStats,
  onQuakeRange,
  quakeFilter = { enabled: false, current: 0 },
  playing = false,
  flightsPlaying = true,
}) {
  const map = useMap()
  const layerRef = useRef(null)
  const sizeRef = useRef(0)
  const sortedRef = useRef([]) // [{ t, m }] sorted by quake time
  const shownRef = useRef(0)
  const popsRef = useRef(new Map())
  const flightsPlayingRef = useRef(flightsPlaying)

  useEffect(() => {
    flightsPlayingRef.current = flightsPlaying
  }, [flightsPlaying])

  // One-shot size pop; supports several concurrent markers (time-lapse ticks).
  const animatePop = useCallback((marker) => {
    const layer = layerRef.current
    if (!layer) return
    const active = popsRef.current.get(marker.id)
    if (active) cancelAnimationFrame(active)
    const base = sizeRef.current || 9
    const start = performance.now()
    const duration = 260
    const tick = () => {
      if (!popsRef.current.has(marker.id)) return
      const t = (performance.now() - start) / duration
      if (t >= 1) {
        popsRef.current.delete(marker.id)
        layer.updateMarker(marker.id, { size: null })
        return
      }
      const factor = 1 + 0.7 * Math.sin(Math.PI * Math.pow(t, 0.55))
      layer.updateMarker(marker.id, { size: Math.max(3, base * factor) })
      popsRef.current.set(marker.id, requestAnimationFrame(tick))
    }
    popsRef.current.set(marker.id, requestAnimationFrame(tick))
  }, [])

  useEffect(() => {
    const cfg = DATASETS[dataset]
    const baseUrl = import.meta.env.BASE_URL
    const textureUrl =
      cfg.texture === 'circle'
        ? circleTextureUrl()
        : `${baseUrl}airplane.svg`

    const layer = new WebGLMarkerLayer({ iconSize: cfg.iconSize, textureUrl })
    layer.addTo(map)
    const pops = popsRef.current
    layerRef.current = layer
    sizeRef.current = cfg.iconSize
    sortedRef.current = []
    shownRef.current = 0

    let markers = []
    let cancelled = false
    let activePopup = null
    let currentSize = null
    let hoverMarker = null
    let hovered = false
    let hoverRaf = null
    let flightRaf = null
    let polylines = []
    let lastTick = 0
    let lastStats = 0

    const baseSize = () => currentSize ?? cfg.iconSize

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

    const report = () => {
      let visible = null
      if (dataset !== 'synthetic' && markers.length > 0) {
        const bounds = map.getBounds()
        let n = 0
        for (const m of markers) {
          if (m.visible !== false && bounds.contains(m.latlng)) n++
        }
        visible = n
      }
      onStats({ markers: layer.count, zoom: map.getZoom(), visible })
    }

    const applySizeForZoom = () => {
      const z = map.getZoom()
      const f =
        z <= 4 ? 0.45 : z <= 6 ? 0.6 : z <= 8 ? 0.75 : z <= 10 ? 0.9 : 1
      const factor = Math.max(cfg.lodFloor ?? 0, f)
      const next = Math.max(3, Math.round(cfg.iconSize * factor * 10) / 10)
      if (next !== currentSize) {
        currentSize = next
        sizeRef.current = next
        layer.setIconSize(next)
      }
    }

    layer.on('mouseover', (e) => {
      map.getContainer().style.cursor = 'pointer'
      hovered = true
      startPulse(e.marker)
    })
    layer.on('mouseout', () => {
      map.getContainer().style.cursor = ''
      hovered = false
      stopPulse()
    })

    layer.on('click', (e) => {
      stopPulse()
      animatePop(e.marker)
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
      } else if (dataset === 'flights') {
        title = `${d.from} → ${d.to}`
        rows = [
          ['From', d.from],
          ['To', d.to],
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
      // Clicking a marker opens the popup in the layer's own click handler,
      // which runs first; keep it open when the pointer is on a marker.
      if (hovered) return
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
        } else if (dataset === 'flights') {
          const routes = await buildFlights(baseUrl)
          if (cancelled) return
          markers = routes.map((r) => r.marker)
          polylines = routes.map((r) =>
            L.polyline(r.latlngs, {
              color: '#38e1ff',
              weight: 1,
              opacity: 0.22,
              dashArray: '3 6',
            }).addTo(map)
          )
          layer.setMarkers(markers)
          applySizeForZoom()
          report()
          lastTick = performance.now()
          const stepFlights = () => {
            if (cancelled) return
            const now = performance.now()
            const dt = Math.min(0.05, (now - lastTick) / 1000)
            lastTick = now
            if (flightsPlayingRef.current) {
              for (const r of routes) {
                r.progress += r.direction * r.speed * dt
                if (r.progress >= 1) {
                  r.progress = 1
                  r.direction = -1
                } else if (r.progress <= 0) {
                  r.progress = 0
                  r.direction = 1
                }
                const [lat, lng] = greatCircle(
                  r.from.lat,
                  r.from.lng,
                  r.to.lat,
                  r.to.lng,
                  r.progress
                )
                // Heading = local tangent of the great-circle at the current
                // position, so the nose follows the curved path.
                const probe = Math.min(1, Math.max(0, r.progress + 0.01 * r.direction))
                const [lat2, lng2] = greatCircle(
                  r.from.lat,
                  r.from.lng,
                  r.to.lat,
                  r.to.lng,
                  probe
                )
                const rot = bearing(lat, lng, lat2, lng2)
                layer.updateMarker(r.marker.id, { latlng: [lat, lng], rotation: rot })
              }
              if (now - lastStats > 500) {
                lastStats = now
                report()
              }
            }
            flightRaf = requestAnimationFrame(stepFlights)
          }
          flightRaf = requestAnimationFrame(stepFlights)
          return
        } else if (dataset === 'airports') {
          markers = await makeAirportMarkers(baseUrl)
        } else {
          markers = await makeQuakeMarkers(baseUrl)
        }
        if (cancelled) return
        if (dataset === 'earthquakes') {
          const sorted = markers
            .map((m) => ({ t: m.data.time ?? 0, m }))
            .sort((a, b) => a.t - b.t)
          sortedRef.current = sorted
          shownRef.current = sorted.length
          if (sorted.length > 0) {
            onQuakeRange?.({ min: sorted[0].t, max: sorted[sorted.length - 1].t })
          }
        }
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
      if (flightRaf) cancelAnimationFrame(flightRaf)
      for (const p of polylines) map.removeLayer(p)
      polylines = []
      for (const raf of pops.values()) cancelAnimationFrame(raf)
      pops.clear()
      map.off('click', closeOnBlank)
      map.off('moveend', report)
      map.off('zoomend', applySizeForZoom)
      if (activePopup) activePopup.close()
      layer.remove()
    }
  }, [map, dataset, count, onStats, onQuakeRange, animatePop])

  // Apply the time filter without rebuilding the layer.
  useEffect(() => {
    const layer = layerRef.current
    const sorted = sortedRef.current
    if (!layer || dataset !== 'earthquakes' || sorted.length === 0) return

    if (!quakeFilter.enabled) {
      for (const item of sorted) {
        if (item.m.visible !== true) layer.updateMarker(item.m.id, { visible: true })
      }
      shownRef.current = sorted.length
    } else {
      let lo = 0
      let hi = sorted.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (sorted[mid].t <= quakeFilter.current) lo = mid + 1
        else hi = mid
      }
      const desired = lo
      const prev = shownRef.current
      if (desired < prev) {
        for (let i = desired; i < prev; i++) {
          layer.updateMarker(sorted[i].m.id, { visible: false })
        }
      } else if (desired > prev) {
        for (let i = prev; i < desired; i++) {
          layer.updateMarker(sorted[i].m.id, { visible: true })
          if (playing) animatePop(sorted[i].m)
        }
      }
      shownRef.current = desired
    }

    const bounds = map.getBounds()
    let onScreen = 0
    for (let i = 0; i < shownRef.current; i++) {
      if (bounds.contains(sorted[i].m.latlng)) onScreen++
    }
    onStats?.({ markers: layer.count, zoom: map.getZoom(), visible: onScreen })
  }, [quakeFilter, dataset, playing, map, onStats, animatePop])

  return null
}

// ─────────────────────────────── controls ───────────────────────────────

const SYNTHETIC_COUNTS = [50000, 200000, 1000000]

function Controls({
  dataset,
  setDataset,
  count,
  setCount,
  stats,
  quakeRange,
  quakeFilter,
  playing,
  onTogglePlay,
  onScrub,
  onReset,
  flightsPlaying,
  onToggleFlights,
}) {
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

      {dataset === 'earthquakes' && quakeRange && (
        <div className="timeline">
          <div className="seg">
            <button type="button" onClick={onTogglePlay}>
              {playing ? 'Pause' : 'Play'}
            </button>
            <button type="button" onClick={onReset}>
              Reset
            </button>
          </div>
          <input
            type="range"
            min={quakeRange.min}
            max={quakeRange.max}
            step={3600000}
            value={Math.min(
              Math.max(quakeFilter.current, quakeRange.min),
              quakeRange.max
            )}
            onChange={(e) => onScrub(Number(e.target.value))}
          />
          <div className="timeline-dates">
            <span>
              {new Date(quakeRange.min).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
              })}
            </span>
            <span>
              {new Date(quakeFilter.current).toLocaleString('en-US', {
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
            <span>
              {new Date(quakeRange.max).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
              })}
            </span>
          </div>
        </div>
      )}

      {dataset === 'flights' && (
        <div className="seg">
          <button type="button" onClick={onToggleFlights}>
            {flightsPlaying ? 'Pause' : 'Play'}
          </button>
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
  const [stats, setStats] = useState({ markers: 0, zoom: 2, visible: null })
  const [quakeRange, setQuakeRange] = useState(null)
  const [quakeFilter, setQuakeFilter] = useState({ enabled: false, current: 0 })
  const [playing, setPlaying] = useState(false)
  const [flightsPlaying, setFlightsPlaying] = useState(true)
  const playFromRef = useRef(0)

  const handleStats = useCallback((next) => setStats(next), [])
  const handleQuakeRange = useCallback(({ min, max }) => {
    setQuakeRange({ min, max })
    setQuakeFilter({ enabled: false, current: min })
    setPlaying(false)
  }, [])

  const selectDataset = useCallback((key) => {
    setPlaying(false)
    if (key === 'flights') setFlightsPlaying(true)
    setDataset(key)
  }, [])

  const toggleFlights = useCallback(() => {
    setFlightsPlaying((v) => !v)
  }, [])

  const togglePlay = useCallback(() => {
    if (!quakeRange) return
    if (playing) {
      setPlaying(false)
      return
    }
    const from =
      quakeFilter.current >= quakeRange.max - 1
        ? quakeRange.min
        : quakeFilter.current
    playFromRef.current = from
    setQuakeFilter({ enabled: true, current: from })
    setPlaying(true)
  }, [quakeRange, playing, quakeFilter])

  const handleScrub = useCallback((value) => {
    setPlaying(false)
    setQuakeFilter({ enabled: true, current: value })
  }, [])

  const handleReset = useCallback(() => {
    setPlaying(false)
    setQuakeFilter({ enabled: false, current: quakeRange?.min ?? 0 })
  }, [quakeRange])

  useEffect(() => {
    if (!playing || !quakeRange) return
    const from = playFromRef.current || quakeRange.min
    const span = quakeRange.max - from
    const durationMs = 16000
    const started = performance.now()
    let raf = 0
    const tick = () => {
      const next = from + (performance.now() - started) * (span / durationMs)
      if (next >= quakeRange.max) {
        setQuakeFilter({ enabled: true, current: quakeRange.max })
        setPlaying(false)
        return
      }
      setQuakeFilter({ enabled: true, current: next })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, quakeRange])

  return (
    <div className="app">
      <MapContainer
        center={[20, 10]}
        zoom={2}
        scrollWheelZoom
        style={{ width: '100%', height: '100%' }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          subdomains="abcd"
        />
        <WebGLOverlay
          dataset={dataset}
          count={count}
          onStats={handleStats}
          onQuakeRange={handleQuakeRange}
          quakeFilter={quakeFilter}
          playing={playing}
          flightsPlaying={flightsPlaying}
        />
      </MapContainer>
      <Controls
        dataset={dataset}
        setDataset={selectDataset}
        count={count}
        setCount={setCount}
        stats={stats}
        quakeRange={quakeRange}
        quakeFilter={quakeFilter}
        playing={playing}
        onTogglePlay={togglePlay}
        onScrub={handleScrub}
        onReset={handleReset}
        flightsPlaying={flightsPlaying}
        onToggleFlights={toggleFlights}
      />
    </div>
  )
}
