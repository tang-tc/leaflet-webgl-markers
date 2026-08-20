/**
 * WebGLMarker — a pure data object representing one marker on the WebGL layer.
 *
 * ## Design principles
 * - Does not extend EventEmitter (avoids memory bloat for millions of instances)
 * - Holds no DOM references
 * - Holds no GPU resource references (resources are owned by WebGLMarkerLayer)
 * - Carries no layer-private state (slots, selection live in layer-owned
 *   WeakMap/Set structures), so one marker instance can safely join many layers
 */

import L from 'leaflet'

// Monotonically increasing id within one library copy; used only as a marker
// identity and layer-internal Map key. Note: ids do NOT participate in FBO pick
// colors - those encode the layer-local slot index (see WebGLMarkerLayer
// .indexToColor), so no random seed is needed and ids are not limited to 24 bits.
let _idCounter = 0

export interface WebGLMarkerOptions {
  /** Geographic position — L.LatLng or a [lat, lng] array */
  latlng: L.LatLng | [number, number]
  /** Rotation in radians; 0 = north, positive = clockwise */
  rotation?: number
  /** RGB tint; [1, 1, 1] = no tint */
  color?: [number, number, number]
  /** Icon size in CSS pixels; null = layer default */
  size?: number | null
  /** Whether the marker is visible */
  visible?: boolean
  /** Opacity from 0 to 1 */
  opacity?: number
  /** Arbitrary application data */
  data?: unknown
}

/** Updatable fields for `updateMarker(id, changes)`: every option is optional. */
export type WebGLMarkerUpdate = Partial<WebGLMarkerOptions>

export class WebGLMarker {
  /** Unique id within this library copy (identity/debugging only, not a pick color) */
  readonly id: number

  /** Geographic position */
  latlng: L.LatLng

  /** Rotation in radians; 0 = north, positive = clockwise */
  rotation: number

  /** RGB tint; [1, 1, 1] = no tint */
  color: [number, number, number]

  /** Icon size in CSS pixels; null = layer default */
  size: number | null

  /** Whether the marker is visible */
  visible: boolean

  /** Opacity from 0 to 1 */
  opacity: number

  /** Arbitrary application data */
  data: unknown

  constructor(opts: WebGLMarkerOptions | [number, number]) {
    // Shorthand support: new WebGLMarker([lat, lng])
    if (Array.isArray(opts)) {
      opts = { latlng: [opts[0], opts[1]] }
    }

    this.id = ++_idCounter

    this.latlng =
      opts.latlng instanceof L.LatLng
        ? opts.latlng
        : L.latLng(opts.latlng?.[0] ?? 0, opts.latlng?.[1] ?? 0)

    this.rotation = opts.rotation ?? 0
    this.color = opts.color ?? [1, 1, 1]
    this.size = opts.size ?? null

    this.visible = opts.visible ?? true
    this.opacity = opts.opacity ?? 1

    this.data = opts.data ?? null
  }
}

export default WebGLMarker
