/**
 * Fetch + trim public-domain demo datasets into demo/public/data/.
 * - OurAirports airports (public domain, https://ourairports.com/data)
 * - USGS earthquakes (public domain, https://earthquake.usgs.gov)
 *
 * Run: npm run data -w demo
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'public', 'data')
mkdirSync(outDir, { recursive: true })

function parseCsv(text) {
  const rows = []
  let field = ''
  let row = []
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      rows.push(row)
      field = ''
      row = []
    } else if (ch !== '\r') {
      field += ch
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

// ── Airports ──
const airportsRes = await fetch(
  'https://davidmegginson.github.io/ourairports-data/airports.csv'
)
if (!airportsRes.ok) throw new Error(`airports.csv fetch failed: ${airportsRes.status}`)
const airportsCsv = await airportsRes.text()
const rows = parseCsv(airportsCsv)
const header = rows[0]
const col = Object.fromEntries(header.map((name, i) => [name, i]))

const wantedTypes = new Set(['large_airport', 'medium_airport', 'small_airport'])
const typeCode = { large_airport: 'L', medium_airport: 'M', small_airport: 'S' }
const airports = []

for (const row of rows.slice(1)) {
  const type = row[col.type]
  if (!wantedTypes.has(type)) continue
  const lat = Number.parseFloat(row[col.latitude_deg])
  const lng = Number.parseFloat(row[col.longitude_deg])
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
  airports.push([
    row[col.iata_code] || row[col.ident],
    row[col.name],
    row[col.municipality] || '',
    row[col.iso_country] || '',
    typeCode[type],
    Math.round(lat * 1e4) / 1e4,
    Math.round(lng * 1e4) / 1e4,
  ])
}

writeFileSync(join(outDir, 'airports.json'), JSON.stringify(airports))
console.log(`airports.json: ${airports.length} rows`)

// ── Earthquakes (30-day snapshot used as offline fallback) ──
const quakesRes = await fetch(
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_month.geojson'
)
if (!quakesRes.ok) throw new Error(`earthquakes fetch failed: ${quakesRes.status}`)
const quakes = (await quakesRes.json()).features.map((f) => {
  const [lng, lat] = f.geometry.coordinates
  return [
    Math.round(lat * 1e4) / 1e4,
    Math.round(lng * 1e4) / 1e4,
    Math.round(f.properties.mag * 10) / 10,
    f.properties.place ?? '',
    f.properties.time ?? 0,
  ]
})

writeFileSync(join(outDir, 'earthquakes.json'), JSON.stringify(quakes))
console.log(`earthquakes.json: ${quakes.length} rows`)
