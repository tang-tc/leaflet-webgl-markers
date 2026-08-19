/**
 * LeafletMarkerPopup — a popup built on Leaflet's native Marker.
 * Zero dependencies (besides the leaflet peer), rendering HTML via divIcon.
 *
 * Consumers must import the CSS separately:
 *   import 'leaflet-webgl-markers/popup.css'
 */

import L from 'leaflet'

function escapeHtml(str: string): string {
  const div = document.createElement('div')
  div.appendChild(document.createTextNode(str))
  return div.innerHTML
}

function buildHTML(
  title: string,
  rows: [string, string][]
): string {
  const rowHTML = rows
    .map(
      ([label, value]) =>
        `<div class="pp-li"><span class="pp-label">${escapeHtml(label)}</span><span class="pp-value">${escapeHtml(value)}</span></div>`
    )
    .join('')

  return `
    <div class="pp-root">
      <div class="pp-line"></div>
      <div class="pp-card">
        <span class="pp-badge">${escapeHtml(title)}</span>
        <button class="pp-close">X</button>
        <div class="pp-body">${rowHTML}</div>
      </div>
    </div>
  `
}

export interface PopupData {
  title: string
  rows: [string, string][]
}

export interface PopupHandle {
  marker: L.Marker
  close: () => void
}

export function openMarkerPopup(
  map: L.Map,
  latlng: L.LatLng,
  data: PopupData
): PopupHandle {
  const icon = L.divIcon({
    className: '',
    html: buildHTML(data.title, data.rows),
    iconAnchor: [8, 0],
  })

  const marker = L.marker(latlng, {
    icon,
    interactive: true,
    keyboard: false,
    zIndexOffset: 1000,
  }).addTo(map)

  marker.on('click', function (e) {
    L.DomEvent.stopPropagation(e.originalEvent)
    if (
      (e.originalEvent.target as Element).classList.contains('pp-close')
    ) {
      map.removeLayer(marker)
    }
  })

  return {
    marker,
    close() {
      map.removeLayer(marker)
    },
  }
}

export default openMarkerPopup
