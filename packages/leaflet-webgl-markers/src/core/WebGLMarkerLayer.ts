/**
 * WebGLMarkerLayer — a Leaflet layer that renders markers with WebGL.
 *
 * ## Responsibilities
 * - GPU rendering: vertex buffer + display shader + texture
 * - FBO picking: offscreen pass -> color encoding -> internal _pick lookup (atomic snapshot)
 * - Events: Leaflet-compatible interaction / lifecycle / error events (reuse L.Evented)
 * - Marker management: addMarker / removeMarker / updateMarker (incremental buffer)
 *
 * ## Architecture
 * Composes CustomCanvasLayer (composition, not inheritance):
 *   WebGLMarkerLayer owns the CustomCanvasLayer instance
 *   CustomCanvasLayer owns canvas lifecycle + map drag/zoom sync
 *   WebGLMarkerLayer owns marker data + rendering + picking + events
 *
 * ## Usage
 * ```ts
 * const layer = new WebGLMarkerLayer({ iconSize: 20, textureUrl: '/airplane.png' })
 * layer.addTo(map)
 *
 * const m = new WebGLMarker({ latlng: [39.9, 116.4], rotation: 0.5, data: { id: 'CA1234' } })
 * layer.addMarker(m)
 *
 * layer.on('click', (e) => { console.log(e.marker.data) })
 * ```
 *
 * See docs/event-system-design.md for the event system design.
 */

import L from 'leaflet'
import {
  CustomCanvasLayer,
  type RenderContext,
} from '../overlay/CustomCanvasLayer.js'
import { createProgram, loadTexture, createSolidTexture } from '../utils/webgl.js'
import { mixinEvented } from '../utils/evented.js'
import { WebGLMarker, type WebGLMarkerUpdate } from './WebGLMarker.js'
import { VS_SOURCE, FS_DISPLAY_SOURCE, FS_PICK_SOURCE } from './shaders.js'

// ═══════════════════════════════════════════════════════════
// GPU buffer constants
// ═══════════════════════════════════════════════════════════

/** Per-vertex stride = 11 floats = 44 bytes
 *  latlng(2) + rotation(1) + color(3) + idColor(3) + opacity(1) + size(1)
 */
const STRIDE_FLOATS = 11
const STRIDE_BYTES = STRIDE_FLOATS * 4

/** Attribute byte offsets within the stride */
const OFF_LATLNG = 0    // vec2  a_latlng (lat, lng in degrees)
const OFF_ROTATION = 8  // float a_rotation
const OFF_COLOR = 12    // vec3  a_color
const OFF_ID_COLOR = 24 // vec3  a_id_color
const OFF_OPACITY = 36  // float a_opacity
const OFF_SIZE = 40     // float a_size (absolute pixels, 0 = follow layer iconSize)

/**
 * Pick colors encode the layer-local storage slot index, not the global marker id:
 * - slot indices are layer-local state and never collide across layers or library copies;
 * - encoding slot+1 keeps 0x000000 reserved for "no hit", so a black id stays pickable.
 */
let _warnedSlotOverflow = false
function indexToColor(slot: number): [number, number, number] {
  if (slot > 0xfffffe && !_warnedSlotOverflow) {
    _warnedSlotOverflow = true
    console.warn(
      `[WebGLMarkerLayer] slot ${slot} exceeds the 24-bit pick color range; picks may collide`
    )
  }
  const v = (slot + 1) & 0xffffff
  return [
    ((v >> 16) & 0xff) / 255,
    ((v >> 8) & 0xff) / 255,
    (v & 0xff) / 255,
  ]
}

/** Decode pick color ([R, G, B] -> slot+1, 0 = no hit) */
function colorToIndex(r: number, g: number, b: number): number {
  return (((r << 16) | (g << 8) | b) >>> 0)
}

/** NaN vertex: the VS pushes it off screen with zero point size (deleted/hidden marker) */
const DEAD_VERTEX = new Float32Array(STRIDE_FLOATS).fill(NaN)

// ═══════════════════════════════════════════════════════════
// 3x3 neighborhood weights (Gaussian kernel, sigma=1)
// ═══════════════════════════════════════════════════════════

const PICK_WEIGHTS_3X3 = [
  0.37, 0.61, 0.37,
  0.61, 1.0, 0.61,
  0.37, 0.61, 0.37,
]

// ═══════════════════════════════════════════════════════════
// Event types (see docs/event-system-design.md)
// ═══════════════════════════════════════════════════════════

export interface MarkerEventBase {
  type: string
  target: WebGLMarkerLayer
  /** Event source injected by Leaflet `fire`; this package never bubbles, so it always equals `target` */
  sourceTarget?: WebGLMarkerLayer
}

export type MarkerPointerType =
  | 'mouseover'
  | 'mouseout'
  | 'click'
  | 'contextmenu'
  | 'dblclick'

export type MouseOutReason = 'move' | 'remove' | 'clear'

export interface MarkerPointerEvent extends MarkerEventBase {
  type: MarkerPointerType
  marker: WebGLMarker
  latlng: L.LatLng
  containerPoint?: L.Point
  layerPoint?: L.Point
  originalEvent?: MouseEvent
  reason?: MouseOutReason // mouseout only
}

export type ErrorStage = 'context' | 'shader' | 'texture' | 'render'

export interface MarkerErrorEvent extends MarkerEventBase {
  type: 'error'
  stage: ErrorStage
  message: string
  error?: unknown
}

export interface WebGLMarkerLayerEventMap {
  add: MarkerEventBase & { type: 'add' }
  remove: MarkerEventBase & { type: 'remove' }
  load: MarkerEventBase & { type: 'load' }
  error: MarkerErrorEvent
  mouseover: MarkerPointerEvent & { type: 'mouseover' }
  mouseout: MarkerPointerEvent & { type: 'mouseout' }
  click: MarkerPointerEvent & { type: 'click' }
  contextmenu: MarkerPointerEvent & { type: 'contextmenu' }
  dblclick: MarkerPointerEvent & { type: 'dblclick' }
}

export interface WebGLMarkerLayerOptions {
  /** Default icon size in CSS pixels. Defaults to 40. */
  iconSize?: number
  /** Icon texture URL. Omit to use the built-in 1x1 white texture (solid-color squares). */
  textureUrl?: string
  /**
   * Buffer growth factor (>= 1). Defaults to 1.2.
   * Controls vertex buffer pre-allocation headroom: larger values grow less often
   * (fewer rebuilds) but use more GPU memory.
   */
  capacityFactor?: number
}

/** Attribute / uniform locations shared by the display and pick programs */
interface ShaderLocs {
  aLatlng: number
  aRotation: number
  aIdColor: number
  aOpacity: number
  aSize: number
  uScale: WebGLUniformLocation | null
  uOrigin: WebGLUniformLocation | null
  uBMin: WebGLUniformLocation | null
  uBSize: WebGLUniformLocation | null
  uPointSize: WebGLUniformLocation | null
  uDpr: WebGLUniformLocation | null
  uMaxPointSize: WebGLUniformLocation | null
  uTex: WebGLUniformLocation | null
}

/** Display pass only: a_color (tint) */
interface DisplayShaderLocs extends ShaderLocs {
  aColor: number
}

/** Full projection parameters (uniforms and viewport signature) for one render pass */
interface RenderFrame {
  zoom: number
  w: number
  h: number
  scale: number
  originX: number
  originY: number
  bMinX: number
  bMinY: number
  bSizeX: number
  bSizeY: number
  dpr: number
}

/**
 * Atomically published pick snapshot: FBO pixels, slot decode table, and viewport
 * signature are packed together right after the same frame finishes drawing, so
 * picking always reads one consistent whole - no "old pixels + new decode table" window.
 */
interface PublishedPickFrame {
  /** Decode table snapshot from the same frame as the FBO; reuse the reference when layoutRevision is unchanged, slice() otherwise */
  array: WebGLMarker[]
  zoom: number
  w: number
  h: number
  dpr: number
  layoutRevision: number
}

/** Pick result tri-state: hit = a marker is here; miss = no marker; unavailable = cannot tell right now */
type PickResult =
  | { status: 'hit'; marker: WebGLMarker }
  | { status: 'miss' }
  | { status: 'unavailable' }

// ═══════════════════════════════════════════════════════════
// WebGLMarkerLayer
// ═══════════════════════════════════════════════════════════

export class WebGLMarkerLayer {
  // ── Options ──
  private _iconSize: number
  private _textureUrl: string | null
  private _capacityFactor: number

  // ── Marker data ──
  private _markerMap: Map<number, WebGLMarker> = new Map()
  private _markerArray: WebGLMarker[] = []

  // Layer-private state lives outside the marker, so one marker can join many layers.
  private _storageIndexMap: WeakMap<WebGLMarker, number> = new WeakMap()

  // ── Incremental buffer state ──
  private _capacity = 0          // allocated slot count

  // ── Canvas / GL ──
  private _canvasLayer: CustomCanvasLayer | null = null
  private _map: L.Map | null = null
  private _gl: WebGLRenderingContext | null = null

  // ── Shader resources ──
  private _displayProgram: WebGLProgram | null = null
  private _pickProgram: WebGLProgram | null = null
  private _vertexBuffer: WebGLBuffer | null = null
  private _texture: WebGLTexture | null = null
  private _maxPointSize = 1024

  // ── FBO picking ──
  private _pickFBO: WebGLFramebuffer | null = null
  private _pickTexture: WebGLTexture | null = null
  private _fboSizeW: number | undefined = undefined
  private _fboSizeH: number | undefined = undefined

  // ── Render state ──
  private _locs: { display?: DisplayShaderLocs; pick?: ShaderLocs } = {}
  private _dirty = false
  // rAF frame coalescing: data changes schedule one render; multiple changes in the
  // same frame collapse into a single render.
  private _renderScheduled = false
  // Layout revision: only changes that alter the "slot -> marker" mapping
  // (add / setMarkers / compact) increment it. Pure data updates (update, or the NaN
  // tombstone from remove) keep the mapping and allow snapshot reference reuse.
  private _layoutRevision = 0

  // ── Pick state (atomic snapshot; _pick only reads this) ──
  private _published: PublishedPickFrame | null = null

  // ── Lifecycle state ──
  private _loaded = false
  private _renderedOnce = false
  private _reportedStages: Set<ErrorStage> = new Set()

  // ── Hover state machine ──
  private _hoveredMarker: WebGLMarker | null = null
  private _pendingHoverEvent: L.LeafletMouseEvent | null = null
  private _hoverFramePending = false

  // ── Map event handlers (references kept so remove() can unbind them) ──
  private _onMouseMove?: (e: L.LeafletMouseEvent) => void
  private _onMouseOut?: (e: L.LeafletMouseEvent) => void
  private _onClick?: (e: L.LeafletMouseEvent) => void
  private _onDblClick?: (e: L.LeafletMouseEvent) => void
  private _onContextMenu?: (e: L.LeafletMouseEvent) => void

  constructor(opts: WebGLMarkerLayerOptions = {}) {
    const iconSize = opts.iconSize ?? 40
    if (typeof iconSize !== 'number' || !Number.isFinite(iconSize) || iconSize <= 0) {
      throw new RangeError(`iconSize must be a finite number greater than 0, received ${iconSize}`)
    }

    const capacityFactor = opts.capacityFactor ?? 1.2
    if (
      typeof capacityFactor !== 'number' ||
      !Number.isFinite(capacityFactor) ||
      capacityFactor < 1
    ) {
      throw new RangeError(`capacityFactor must be a finite number >= 1, received ${capacityFactor}`)
    }

    const textureUrl = opts.textureUrl
    if (textureUrl !== undefined && typeof textureUrl !== 'string') {
      throw new TypeError(`textureUrl must be a string, received ${typeof textureUrl}`)
    }

    this._iconSize = iconSize
    this._capacityFactor = capacityFactor
    // Treat an empty string as "not provided": use the built-in 1x1 white texture
    // instead of fetching a default URL that would 404 and leave the layer blank.
    this._textureUrl = textureUrl && textureUrl.trim() ? textureUrl.trim() : null
  }

  // ════════════════════════════════════════════════
  // Lifecycle
  // ════════════════════════════════════════════════

  addTo(map: L.Map): this {
    // The vertex shader hardcodes EPSG:3857 (Web Mercator) projection math.
    // Any other CRS would silently misplace every marker, so fail fast
    // instead of rendering wrong positions.
    if (map.options.crs !== L.CRS.EPSG3857) {
      throw new Error(
        "WebGLMarkerLayer only supports Leaflet's default CRS (L.CRS.EPSG3857). " +
          'Custom CRS (e.g. proj4leaflet) is not supported yet: marker positions would be incorrect.'
      )
    }

    // Guard against double mounting / re-mounting: tear down the old canvas and
    // map events first, then rebuild. remove() keeps marker data; _dirty below
    // triggers a vertex buffer rebuild.
    if (this._canvasLayer || this._map) {
      this.remove()
    }

    this._map = map
    // Reset per-session error dedup before _reportError('context') below.
    this._reportedStages.clear()

    this._canvasLayer = new CustomCanvasLayer()
    this._canvasLayer.addTo(map)

    const canvas = this._canvasLayer.getCanvas()!
    this._gl = canvas.getContext('webgl')
    if (!this._gl) {
      this._reportError('context', 'Failed to create a WebGL context (getContext returned null)')
    }

    this._canvasLayer.setRenderCallback((ctx) => this._onRender(ctx))
    this._installMapEvents()

    // On re-mount, the vertex buffer must be rebuilt from marker data
    // (remove() has already dropped all GL resources).
    this._dirty = true
    this._requestRender()
    this._published = null
    this._loaded = false
    this._renderedOnce = false
    this._hoveredMarker = null
    this._pendingHoverEvent = null
    this._hoverFramePending = false

    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault()
      this._reportError('context', 'WebGL context lost')
      // Drop every GL resource; after restore, _onRender sees _displayProgram is
      // null and re-runs _initGL so invalid resources never cause a black screen.
      this._gl = null
      this._pickFBO = null
      this._pickTexture = null
      this._texture = null
      this._displayProgram = null
      this._pickProgram = null
      this._vertexBuffer = null
      this._locs = {}
      this._published = null
      this._loaded = false
      this._renderedOnce = false
    })

    canvas.addEventListener('webglcontextrestored', () => {
      this._gl = canvas.getContext('webgl')
      this._reportedStages.clear()
      this._dirty = true
      this._requestRender()
      this._published = null
      this._loaded = false
      this._renderedOnce = false
    })

    this.fire('add')
    return this
  }

  remove(): this {
    const wasMounted = !!this._map
    if (this._map) {
      if (this._onMouseMove) this._map.off('mousemove', this._onMouseMove)
      if (this._onMouseOut) this._map.off('mouseout', this._onMouseOut)
      if (this._onClick) this._map.off('click', this._onClick)
      if (this._onDblClick) this._map.off('dblclick', this._onDblClick)
      if (this._onContextMenu) this._map.off('contextmenu', this._onContextMenu)
    }

    // Clear pending events and frame flags on unmount so stale callbacks
    // never process outdated events.
    this._pendingHoverEvent = null
    this._hoverFramePending = false
    if (this._hoveredMarker) {
      this._synthesizeMouseOut('remove')
    }

    if (this._canvasLayer) {
      this._canvasLayer.remove()
      this._canvasLayer = null
    }

    this._map = null
    this._gl = null
    this._displayProgram = null
    this._pickProgram = null
    this._vertexBuffer = null
    this._pickFBO = null
    this._pickTexture = null
    this._texture = null
    this._locs = {}
    this._published = null

    if (wasMounted) this.fire('remove')
    return this
  }

  // ════════════════════════════════════════════════
  // Marker CRUD (incremental buffer)
  // ════════════════════════════════════════════════

  addMarker(marker: WebGLMarker): void {
    if (!(marker instanceof WebGLMarker)) {
      throw new Error('addMarker requires a WebGLMarker instance')
    }
    const existing = this._markerMap.get(marker.id)
    if (existing) {
      if (existing !== marker) {
        throw new Error(`addMarker: id ${marker.id} is already taken by another marker`)
      }
      return // Same instance added twice: idempotent, no duplicate vertex write
    }
    this._markerMap.set(marker.id, marker)
    this._layoutRevision++

    const gl = this._gl
    if (!gl || !this._vertexBuffer) {
      // GL not initialized yet -> defer to a full rebuild (_rebuildBuffer on next render)
      this._dirty = true
      this._requestRender()
      return
    }

    // Append-only, holes are never reused: slot order == insertion order, so later
    // markers get higher slots, draw later, and naturally sit on top. Dead slots
    // from removals are compacted by growth / compact() with relative order kept.
    const idx = this._markerArray.length
    this._markerArray.push(marker)
    this._storageIndexMap.set(marker, idx)

    if (idx < this._capacity) {
      // Enough capacity: write in place
      this._writeOneVertex(idx, marker)
    } else {
      // Growth needed (rare). _growBuffer compacts holes + rebuilds; nothing to clean here.
      this._growBuffer()
    }
    this._requestRender()
  }

  removeMarker(id: number): void {
    const marker = this._markerMap.get(id)
    if (!marker) return
    this._markerMap.delete(id)
    if (this._hoveredMarker === marker) {
      this._synthesizeMouseOut('remove')
    }

    const gl = this._gl
    if (!gl || !this._vertexBuffer) {
      this._dirty = true
      this._requestRender()
      return
    }

    const idx = this._storageIndexMap.get(marker)
    if (idx === undefined || idx < 0) return
    this._storageIndexMap.delete(marker)

    // Write a NaN tombstone to isolate the vertex; dead slots are never reused and
    // are compacted in order by growth or compact().
    this._writeDeadVertex(idx)

    this._requestRender()
  }

  updateMarker(id: number, changes: WebGLMarkerUpdate): void {
    const marker = this._markerMap.get(id)
    if (!marker) return

    if (changes.latlng !== undefined) {
      marker.latlng =
        changes.latlng instanceof L.LatLng
          ? changes.latlng
          : L.latLng(changes.latlng[0], changes.latlng[1])
    }
    if (changes.rotation !== undefined) marker.rotation = changes.rotation
    if (changes.color !== undefined) marker.color = changes.color
    if (changes.size !== undefined) marker.size = changes.size
    if (changes.visible !== undefined) marker.visible = changes.visible
    if (changes.opacity !== undefined) marker.opacity = changes.opacity
    if (changes.data !== undefined) marker.data = changes.data
    const gl = this._gl
    const idx = this._storageIndexMap.get(marker)
    if (!gl || !this._vertexBuffer || idx === undefined || idx < 0) {
      this._dirty = true
      this._requestRender()
      return
    }

    // Update a single vertex in place
    this._writeOneVertex(idx, marker)
    this._requestRender()
  }

  redraw(): void {
    // Do not re-render while the view is moving: content would misalign with the
    // CSS-translated canvas. moveend's _reset re-anchors and renders with the new viewport.
    if (!this._canvasLayer || !this._canvasLayer.isAligned()) return
    this._canvasLayer.redraw()
  }

  /**
   * Request one render (frame coalescing): multiple calls in the same frame
   * schedule a single rAF that renders once on the next frame. Called after data
   * changes (add/remove/updateMarker) so changes appear without N redundant renders.
   */
  private _requestRender(): void {
    if (this._renderScheduled) return
    this._renderScheduled = true
    requestAnimationFrame(() => {
      this._renderScheduled = false
      if (this._canvasLayer && !this._canvasLayer.isAligned()) return
      this.redraw()
    })
  }

  /**
   * Set the layer default icon size (CSS pixels) and trigger a redraw.
   * Only affects markers whose `marker.size` is null (following the layer);
   * markers with an explicit `marker.size` keep their absolute pixels.
   *
   * Validation: size must be a finite number greater than 0 (TypeError /
   * RangeError otherwise). Setting the current value again skips the redraw
   * (idempotent, avoiding duplicate renders from interaction events).
   */
  setIconSize(size: number): void {
    if (typeof size !== 'number') {
      throw new TypeError(`setIconSize: size must be a number, received ${typeof size}`)
    }
    if (!Number.isFinite(size) || size <= 0) {
      throw new RangeError(`setIconSize: size must be a finite number greater than 0, received ${size}`)
    }
    if (size === this._iconSize) return
    this._iconSize = size
    this.redraw()
  }

  setMarkers(markers: WebGLMarker[]): void {
    const seen = new Set<number>()
    for (const m of markers) {
      if (!(m instanceof WebGLMarker)) {
        throw new Error('setMarkers requires an array of WebGLMarker instances')
      }
      if (seen.has(m.id)) {
        throw new Error(`setMarkers: duplicate marker id ${m.id}`)
      }
      seen.add(m.id)
    }

    if (this._hoveredMarker) {
      const nextIds = new Set(markers.map((m) => m.id))
      if (!nextIds.has(this._hoveredMarker.id)) {
        this._synthesizeMouseOut('clear')
      }
    }

    this._markerMap.clear()
    this._markerArray = []
    this._capacity = 0
    for (const m of markers) {
      this._markerMap.set(m.id, m)
    }
    this._layoutRevision++
    this._dirty = true
    this._requestRender()
  }

  getMarker(id: number): WebGLMarker | undefined {
    return this._markerMap.get(id)
  }

  /** Current number of live markers */
  get count(): number {
    return this._markerMap.size
  }

  /**
   * Manually trigger a lazy compaction that removes vertex holes left by deleted
   * markers. Usually called after a batch add to optimize the buffer layout.
   */
  compact(): void {
    this._compact()
    this._layoutRevision++
    this._requestRender()
  }

  // ════════════════════════════════════════════════
  // Internal picking (the capability behind events; not public API)
  // ════════════════════════════════════════════════

  /**
   * On the first interaction, if no frame has been published yet: synchronously
   * render one frame to establish the pick frame, only when the view is aligned
   * (at rest). Skipped while moving; moveend's _reset catches up on its own.
   */
  private _ensurePickFrame(): void {
    if (this._published) return
    if (!this._map || !this._canvasLayer || !this._gl) return
    if (!this._canvasLayer.isAligned()) return
    this.redraw()
  }

  /**
   * Pick at a container point and return a tri-state result.
   * Reads only the atomically published snapshot: FBO pixels and their decode
   * table are packed from the same frame. If the frame does not match the current
   * view (any pane movement / zoom animation / resize) -> unavailable.
   */
  private _pick(containerPoint: L.Point): PickResult {
    const map = this._map
    const canvasLayer = this._canvasLayer
    const gl = this._gl
    const pub = this._published
    if (!map || !canvasLayer || !gl || !pub || !this._pickFBO) {
      return { status: 'unavailable' }
    }
    if (map.getZoom() !== pub.zoom || !canvasLayer.isAligned()) {
      return { status: 'unavailable' }
    }
    const canvas = canvasLayer.getCanvas()
    if (!canvas || canvas.width !== pub.w || canvas.height !== pub.h) {
      return { status: 'unavailable' }
    }

    // Once aligned, the canvas is anchored to the current viewport and
    // containerPoint maps 1:1 to texels.
    const texelX = Math.min(
      Math.max(Math.round(containerPoint.x * pub.dpr), 0),
      pub.w - 1
    )
    const texelY = Math.min(
      Math.max(Math.round(pub.h - 1 - containerPoint.y * pub.dpr), 0),
      pub.h - 1
    )

    gl.bindFramebuffer(gl.FRAMEBUFFER, this._pickFBO)
    const center = new Uint8Array(4)
    gl.readPixels(texelX, texelY, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, center)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)

    let encoded = colorToIndex(center[0], center[1], center[2])
    if (encoded === 0) {
      encoded = this._pick3x3(gl, texelX, texelY, pub.w, pub.h)
    }
    if (encoded === 0) return { status: 'miss' }

    const slot = encoded - 1
    const marker = pub.array[slot]
    if (!marker) return { status: 'miss' }
    return { status: 'hit', marker }
  }

  // ════════════════════════════════════════════════
  // Rendering
  // ════════════════════════════════════════════════

  private _onRender(ctx: RenderContext): void {
    if (!this._gl) return
    try {
      this._renderFrame(ctx)
    } catch (err) {
      this._reportError('render', 'Rendering threw an exception', err)
    }
  }

  private _renderFrame(ctx: RenderContext): void {
    const gl = this._gl
    if (!gl) return

    // ── 1. One-time GL resource initialization ──
    if (!this._displayProgram) {
      this._initGL()
      if (!this._displayProgram) return
    }

    // ── 2. Data changed -> rebuild the GPU buffer (GL not ready / bulk setMarkers) ──
    if (this._dirty) {
      this._rebuildBuffer()
      this._dirty = false
    }

    const count = this._markerArray.length
    // count includes dead markers (NaN vertices) - the VS pushes them off screen
    // so they take no part in rendering or picking.

    // ── 3. Common GL state ──
    gl.viewport(0, 0, ctx.dprSize.width, ctx.dprSize.height)
    gl.clearColor(0, 0, 0, 0)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

    // ── 4. Projection uniforms ──
    const scale = 256 * Math.pow(2, ctx.zoom)
    const bMin = ctx.bounds.min
    const bSize = {
      x: ctx.bounds.max.x - ctx.bounds.min.x,
      y: ctx.bounds.max.y - ctx.bounds.min.y,
    }
    const pxOrigin = ctx.map.getPixelOrigin()

    const setUniforms = (locs: ShaderLocs) => {
      gl.uniform1f(locs.uScale, scale)
      gl.uniform2f(locs.uOrigin, pxOrigin.x, pxOrigin.y)
      gl.uniform2f(locs.uBMin, bMin.x, bMin.y)
      gl.uniform2f(locs.uBSize, bSize.x, bSize.y)
      // gl_PointSize is in physical pixels while the viewport/coordinates are in
      // dpr pixels. u_pointSize only affects size:null markers (following the
      // layer), so multiply by dpr to keep them full size; explicit sizes are
      // converted inside the shader with a_size * u_dpr.
      if (locs.uPointSize) {
        gl.uniform1f(locs.uPointSize, this._iconSize * ctx.dpr)
      }
      if (locs.uDpr) {
        gl.uniform1f(locs.uDpr, ctx.dpr)
      }
      if (locs.uMaxPointSize) {
        gl.uniform1f(locs.uMaxPointSize, this._maxPointSize)
      }
    }

    // ── 5. Pass 1: display ──
    // Always clear first, even with no markers: otherwise the canvas keeps the
    // previous frame after setMarkers([]) or removing every marker.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.clear(gl.COLOR_BUFFER_BIT)
    if (this._texture && count > 0) {
      gl.useProgram(this._displayProgram)
      setUniforms(this._locs.display!)

      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, this._texture)
      if (this._locs.display!.uTex) {
        gl.uniform1i(this._locs.display!.uTex, 0)
      }

      gl.bindBuffer(gl.ARRAY_BUFFER, this._vertexBuffer)
      this._bindDisplayAttributes(gl, this._locs.display!)
      gl.drawArrays(gl.POINTS, 0, count)
    }

    const frame: RenderFrame = {
      zoom: ctx.zoom,
      w: ctx.dprSize.width,
      h: ctx.dprSize.height,
      scale,
      originX: pxOrigin.x,
      originY: pxOrigin.y,
      bMinX: bMin.x,
      bMinY: bMin.y,
      bSizeX: bSize.x,
      bSizeY: bSize.y,
      dpr: ctx.dpr,
    }

    // ── 6. Pass 2: picking (refreshed only when interaction events are subscribed) ──
    if (this._hasPointerListeners()) {
      this._runPickPassWithFrame(frame, count)
      // Publish the FBO and decode table from the same frame: picking always
      // reads one consistent whole.
      this._published = this._snapshotPickFrame(frame)
    } else {
      // With no subscribers the pick pass did not refresh, so the old snapshot is
      // detached from the current picture -> invalidate it. Otherwise
      // "subscribe -> off all -> pan -> resubscribe" would decode the pre-pan FBO
      // at new coordinates.
      this._published = null
    }

    this._renderedOnce = true
    this._maybeFireLoad()
  }

  private _initGL(): void {
    const gl = this._gl
    if (!gl) return

    // ── Display shader ──
    this._displayProgram = createProgram(gl, VS_SOURCE, FS_DISPLAY_SOURCE)
    if (!this._displayProgram) {
      this._reportError('shader', 'Display shader failed to compile or link')
      return
    }

    this._locs.display = {
      aLatlng: gl.getAttribLocation(this._displayProgram, 'a_latlng'),
      aRotation: gl.getAttribLocation(this._displayProgram, 'a_rotation'),
      aColor: gl.getAttribLocation(this._displayProgram, 'a_color'),
      aIdColor: gl.getAttribLocation(this._displayProgram, 'a_id_color'),
      aOpacity: gl.getAttribLocation(this._displayProgram, 'a_opacity'),
      aSize: gl.getAttribLocation(this._displayProgram, 'a_size'),
      uTex: gl.getUniformLocation(this._displayProgram, 'u_texture'),
      uScale: gl.getUniformLocation(this._displayProgram, 'u_scale'),
      uOrigin: gl.getUniformLocation(this._displayProgram, 'u_pixelOrigin'),
      uBMin: gl.getUniformLocation(this._displayProgram, 'u_boundsMin'),
      uBSize: gl.getUniformLocation(this._displayProgram, 'u_boundsSize'),
      uPointSize: gl.getUniformLocation(this._displayProgram, 'u_pointSize'),
      uDpr: gl.getUniformLocation(this._displayProgram, 'u_dpr'),
      uMaxPointSize: gl.getUniformLocation(this._displayProgram, 'u_maxPointSize'),
    }

    // ── Pick shader ──
    this._pickProgram = createProgram(gl, VS_SOURCE, FS_PICK_SOURCE)
    if (!this._pickProgram) {
      this._reportError('shader', 'Pick shader failed to compile or link')
      return
    }

    this._locs.pick = {
      aLatlng: gl.getAttribLocation(this._pickProgram, 'a_latlng'),
      aRotation: gl.getAttribLocation(this._pickProgram, 'a_rotation'),
      aIdColor: gl.getAttribLocation(this._pickProgram, 'a_id_color'),
      aOpacity: gl.getAttribLocation(this._pickProgram, 'a_opacity'),
      aSize: gl.getAttribLocation(this._pickProgram, 'a_size'),
      uTex: gl.getUniformLocation(this._pickProgram, 'u_texture'),
      uScale: gl.getUniformLocation(this._pickProgram, 'u_scale'),
      uOrigin: gl.getUniformLocation(this._pickProgram, 'u_pixelOrigin'),
      uBMin: gl.getUniformLocation(this._pickProgram, 'u_boundsMin'),
      uBSize: gl.getUniformLocation(this._pickProgram, 'u_boundsSize'),
      uPointSize: gl.getUniformLocation(this._pickProgram, 'u_pointSize'),
      uDpr: gl.getUniformLocation(this._pickProgram, 'u_dpr'),
      uMaxPointSize: gl.getUniformLocation(this._pickProgram, 'u_maxPointSize'),
    }

    // ── Vertex buffer ──
    this._vertexBuffer = gl.createBuffer()

    // ── Point size cap: drivers clamp gl_PointSize in an implementation-defined
    // way, so align with it proactively to avoid silent truncation ──
    try {
      const range = gl.getParameter(
        gl.ALIASED_POINT_SIZE_RANGE
      ) as Float32Array
      this._maxPointSize = range[1]
    } catch {
      this._maxPointSize = 1024
    }

    // ── Texture: use the built-in 1x1 white texture when no URL, otherwise load async ──
    if (this._textureUrl) {
      loadTexture(gl, this._textureUrl)
        .then((tex) => {
          if (gl !== this._gl) return // Mount session / GL context changed; drop the stale texture
          this._texture = tex
          this.redraw()
          this._maybeFireLoad()
        })
        .catch((err) => {
          if (gl !== this._gl) return
          this._reportError('texture', 'Failed to load texture', err)
        })
    } else {
      this._texture = createSolidTexture(gl)
      if (!this._texture) {
        this._reportError('texture', 'Failed to create the default texture')
      }
    }
  }

  private _maybeFireLoad(): void {
    if (this._loaded || !this._renderedOnce || !this._texture || !this._displayProgram) {
      return
    }
    this._loaded = true
    this.fire('load')
  }

  private _reportError(stage: ErrorStage, message: string, error?: unknown): void {
    if (this._reportedStages.has(stage)) return
    this._reportedStages.add(stage)
    console.error(`[WebGLMarkerLayer] ${message}`, error)
    this.fire('error', { stage, message, error })
  }

  // ════════════════════════════════════════════════
  // Pick engine
  // ════════════════════════════════════════════════

  private _runPickPassWithFrame(frame: RenderFrame, count: number): void {
    const gl = this._gl!
    this._ensurePickFBO(frame.w, frame.h)

    gl.viewport(0, 0, frame.w, frame.h)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._pickFBO)
    gl.clear(gl.COLOR_BUFFER_BIT)

    if (count > 0 && this._pickProgram && this._locs.pick && this._texture) {
      gl.useProgram(this._pickProgram)
      this._setPickUniforms(gl, frame)

      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, this._texture)
      if (this._locs.pick.uTex) {
        gl.uniform1i(this._locs.pick.uTex, 0)
      }

      gl.bindBuffer(gl.ARRAY_BUFFER, this._vertexBuffer)
      this._bindCommonAttributes(gl, this._locs.pick)
      gl.drawArrays(gl.POINTS, 0, count)
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  /** Reuse the previous decode table reference when the layout revision is unchanged; otherwise copy one to pair with the FBO */
  private _snapshotPickFrame(frame: RenderFrame): PublishedPickFrame {
    const reuse =
      this._published && this._published.layoutRevision === this._layoutRevision
    return {
      array: reuse ? this._published!.array : this._markerArray.slice(),
      zoom: frame.zoom,
      w: frame.w,
      h: frame.h,
      dpr: frame.dpr,
      layoutRevision: this._layoutRevision,
    }
  }

  private _setPickUniforms(gl: WebGLRenderingContext, frame: RenderFrame): void {
    const locs = this._locs.pick!
    gl.uniform1f(locs.uScale, frame.scale)
    gl.uniform2f(locs.uOrigin, frame.originX, frame.originY)
    gl.uniform2f(locs.uBMin, frame.bMinX, frame.bMinY)
    gl.uniform2f(locs.uBSize, frame.bSizeX, frame.bSizeY)
    if (locs.uPointSize) {
      gl.uniform1f(locs.uPointSize, this._iconSize * frame.dpr)
    }
    if (locs.uDpr) {
      gl.uniform1f(locs.uDpr, frame.dpr)
    }
    if (locs.uMaxPointSize) {
      gl.uniform1f(locs.uMaxPointSize, this._maxPointSize)
    }
  }

  private _ensurePickFBO(width: number, height: number): void {
    const gl = this._gl
    if (!gl) return
    if (this._pickFBO && this._fboSizeW === width && this._fboSizeH === height) {
      return
    }
    this._rebuildPickFBO(width, height)
    this._fboSizeW = width
    this._fboSizeH = height
  }

  private _rebuildPickFBO(width: number, height: number): void {
    const gl = this._gl
    if (!gl) return

    if (this._pickFBO) gl.deleteFramebuffer(this._pickFBO)
    if (this._pickTexture) gl.deleteTexture(this._pickTexture)

    this._pickTexture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this._pickTexture)
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA,
      width, height, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, null
    )
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

    this._pickFBO = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._pickFBO)
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D, this._pickTexture, 0
    )
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  /**
   * 3x3 neighborhood weighted vote.
   * Tie-breaking order: higher score -> closer distance (Chebyshev) -> higher z-order
   */
  private _pick3x3(
    gl: WebGLRenderingContext,
    cx: number,
    cy: number,
    vw: number,
    vh: number
  ): number {
    // Clamp the read range to [0, size-1] so readPixels never receives negative
    // coordinates (which would throw INVALID_VALUE).
    const x0 = Math.max(0, Math.min(cx - 1, vw - 1))
    const y0 = Math.max(0, Math.min(cy - 1, vh - 1))
    const x1 = Math.max(0, Math.min(cx + 1, vw - 1))
    const y1 = Math.max(0, Math.min(cy + 1, vh - 1))
    const width = x1 - x0 + 1
    const height = y1 - y0 + 1

    const pixels = new Uint8Array(width * height * 4)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._pickFBO)
    gl.readPixels(x0, y0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)

    const scores = new Map<number, number>()
    const minDist = new Map<number, number>()

    // Virtual 3x3 grid center offset: (cx-1, cy-1) maps to (col=0, row=0) in the grid.
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const i = (row * width + col) * 4
        const r = pixels[i]
        const g = pixels[i + 1]
        const b = pixels[i + 2]
        if (r === 0 && g === 0 && b === 0) continue

        const encoded = colorToIndex(r, g, b)
        if (encoded === 0) continue
        // Map back to the virtual 3x3 grid (gCol, gRow) for weight and distance.
        const gCol = (x0 + col) - (cx - 1)
        const gRow = (y0 + row) - (cy - 1)
        // The clamped grid can shrink at edges; gCol/gRow may fall outside
        // [0,2], so guard against out-of-range access.
        if (gCol < 0 || gCol > 2 || gRow < 0 || gRow > 2) continue
        const gi = gRow * 3 + gCol
        scores.set(encoded, (scores.get(encoded) || 0) + PICK_WEIGHTS_3X3[gi])

        const dist = Math.max(Math.abs(gCol - 1), Math.abs(gRow - 1))
        if (dist < (minDist.get(encoded) || Infinity)) minDist.set(encoded, dist)
      }
    }

    if (scores.size === 0) return 0

    const ranked = [...scores.entries()].sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1]
      if (minDist.get(a[0]) !== minDist.get(b[0]))
        return minDist.get(a[0])! - minDist.get(b[0])!
      // z-order: with append-only slots, a higher slot = added later = drawn on top
      return b[0] - a[0]
    })

    return ranked[0][0]
  }

  // ════════════════════════════════════════════════
  // Incremental buffer operations
  // ════════════════════════════════════════════════

  /** Build the 11 floats of a single vertex (layout must match STRIDE/OFF_*) */
  private buildVertexData(m: WebGLMarker, slot: number): Float32Array {
    const idCol = indexToColor(slot)
    const visible = m.visible
    // Semantics A: marker.size is absolute pixels (CSS); null -> 0 means
    // "follow the layer iconSize".
    const size = m.size == null ? 0 : Math.max(0, m.size)

    return new Float32Array([
      visible ? m.latlng.lat : NaN,
      visible ? m.latlng.lng : NaN,
      visible ? m.rotation : NaN,
      m.color[0], m.color[1], m.color[2],
      idCol[0], idCol[1], idCol[2],
      visible ? Math.min(1, Math.max(0, m.opacity)) : 0,
      size,
    ])
  }

  /** Write one vertex into the given slot */
  private _writeOneVertex(idx: number, m: WebGLMarker): void {
    const gl = this._gl!
    const off = idx * STRIDE_FLOATS
    const vert = this.buildVertexData(m, idx)

    gl.bindBuffer(gl.ARRAY_BUFFER, this._vertexBuffer)
    gl.bufferSubData(gl.ARRAY_BUFFER, off * 4, vert)
  }

  /** Write the NaN tombstone vertex (deletion marker) */
  private _writeDeadVertex(idx: number): void {
    const gl = this._gl!
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vertexBuffer)
    gl.bufferSubData(gl.ARRAY_BUFFER, idx * STRIDE_BYTES, DEAD_VERTEX)
  }

  /** Grow the buffer and rebuild all data. Growth is rare; it also compacts holes. */
  private _growBuffer(): void {
    this._capacity = Math.max(
      1,
      // Dead slots still occupy _markerArray: size capacity by array length, not
      // live count, so mass deletions don't trigger frequent O(N) rebuilds.
      Math.ceil(this._markerArray.length * this._capacityFactor)
    )
    this._rebuildBuffer()
  }

  /** Lazy compaction: remove holes and rebuild a contiguous buffer */
  private _compact(): void {
    this._rebuildBuffer()
  }

  /** Full buffer rebuild (init / dirty / compaction / growth):
   *  rebuild from _markerMap, which naturally excludes dead slots; Map keeps
   *  insertion order and CRUD rejects duplicate ids, so Map order == insertion
   *  order == slot order. This also catches pending markers added before GL was
   *  initialized (they exist only in _markerMap, not yet in _markerArray). */
  private _rebuildBuffer(): void {
    const gl = this._gl
    if (!gl) return

    this._markerArray = Array.from(this._markerMap.values())

    const count = this._markerArray.length
    if (this._capacity < count) {
      this._capacity = Math.ceil(count * this._capacityFactor)
    }

    // Rebuild the storage-slot index (kept outside markers so instances stay clean)
    for (let i = 0; i < count; i++) {
      this._storageIndexMap.set(this._markerArray[i], i)
    }

    if (count === 0) {
      // No markers left, but keep the buffer (the next add writes directly)
      return
    }

    // +1 avoids ANGLE's strict bounds check failing
    const bufSize = (this._capacity + 1) * STRIDE_FLOATS
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vertexBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, bufSize * 4, gl.DYNAMIC_DRAW)

    const verts = new Float32Array(count * STRIDE_FLOATS)
    for (let i = 0; i < count; i++) {
      verts.set(this.buildVertexData(this._markerArray[i], i), i * STRIDE_FLOATS)
    }

    gl.bufferSubData(gl.ARRAY_BUFFER, 0, verts)
  }

  /** Bind attributes shared by both passes */
  private _bindCommonAttributes(gl: WebGLRenderingContext, locs: ShaderLocs): void {
    const stride = STRIDE_BYTES

    gl.enableVertexAttribArray(locs.aLatlng)
    gl.vertexAttribPointer(locs.aLatlng, 2, gl.FLOAT, false, stride, OFF_LATLNG)

    gl.enableVertexAttribArray(locs.aRotation)
    gl.vertexAttribPointer(locs.aRotation, 1, gl.FLOAT, false, stride, OFF_ROTATION)

    gl.enableVertexAttribArray(locs.aIdColor)
    gl.vertexAttribPointer(locs.aIdColor, 3, gl.FLOAT, false, stride, OFF_ID_COLOR)

    gl.enableVertexAttribArray(locs.aOpacity)
    gl.vertexAttribPointer(locs.aOpacity, 1, gl.FLOAT, false, stride, OFF_OPACITY)

    gl.enableVertexAttribArray(locs.aSize)
    gl.vertexAttribPointer(locs.aSize, 1, gl.FLOAT, false, stride, OFF_SIZE)
  }

  /** Bind display-pass attributes (adds a_color) */
  private _bindDisplayAttributes(gl: WebGLRenderingContext, locs: DisplayShaderLocs): void {
    this._bindCommonAttributes(gl, locs)
    gl.enableVertexAttribArray(locs.aColor)
    gl.vertexAttribPointer(locs.aColor, 3, gl.FLOAT, false, STRIDE_BYTES, OFF_COLOR)
  }

  // ════════════════════════════════════════════════
  // Event pipeline
  // ════════════════════════════════════════════════

  private _installMapEvents(): void {
    const map = this._map
    if (!map) return

    this._onMouseMove = (e: L.LeafletMouseEvent) => this._handleMapMouseMove(e)
    this._onMouseOut = (e: L.LeafletMouseEvent) => this._handleMapMouseOut(e)
    this._onClick = (e: L.LeafletMouseEvent) => this._handleMapClick(e)
    this._onDblClick = (e: L.LeafletMouseEvent) => this._handleMapDblClick(e)
    this._onContextMenu = (e: L.LeafletMouseEvent) => this._handleMapContextMenu(e)

    map.on('mousemove', this._onMouseMove)
    map.on('mouseout', this._onMouseOut)
    map.on('click', this._onClick)
    map.on('dblclick', this._onDblClick)
    map.on('contextmenu', this._onContextMenu)
  }

  private _hasPointerListeners(): boolean {
    return (
      this.listens('click') ||
      this.listens('dblclick') ||
      this.listens('contextmenu') ||
      this.listens('mouseover') ||
      this.listens('mouseout')
    )
  }

  /** Whether the event target sits on a native DOM overlay (marker icon / popup /
   * tooltip / control); treat that as empty space. */
  private _isOverDomOverlay(e: L.LeafletMouseEvent): boolean {
    const t = (e.originalEvent as MouseEvent).target
    if (!(t instanceof Element)) return false
    return !!t.closest?.(
      '.leaflet-marker-icon, .leaflet-popup, .leaflet-tooltip, .leaflet-control'
    )
  }

  // ── Hover pipeline (rAF frame coalescing, last-event-wins) ──

  private _handleMapMouseMove(e: L.LeafletMouseEvent): void {
    if (!this._map) return
    if (!this.listens('mouseover') && !this.listens('mouseout')) return
    // Suspend while the view is moving (drag/inertia/panBy/zoom animation):
    // no picking, no events.
    if (this._canvasLayer && !this._canvasLayer.isAligned()) return

    this._pendingHoverEvent = e
    if (this._hoverFramePending) return
    this._hoverFramePending = true

    requestAnimationFrame(() => this._processHoverFrame())
  }

  private _processHoverFrame(): void {
    this._hoverFramePending = false
    const ev = this._pendingHoverEvent
    this._pendingHoverEvent = null
    if (!ev || !this._map) return
    if (this._canvasLayer && !this._canvasLayer.isAligned()) return
    this._handleHover(ev)
  }

  private _handleHover(e: L.LeafletMouseEvent): void {
    // Over a DOM overlay -> treat as empty space (leaving the hovered marker fires mouseout)
    this._ensurePickFrame()
    const result: PickResult = this._isOverDomOverlay(e)
      ? { status: 'miss' }
      : this._pick(e.containerPoint)

    // Cannot tell (view is moving) -> keep hover state; do not treat as empty.
    if (result.status === 'unavailable') return

    const marker = result.status === 'hit' ? result.marker : null
    if (marker === this._hoveredMarker) return

    if (this._hoveredMarker) {
      this._synthesizeMouseOut('move', e)
    }
    if (marker) {
      this._hoveredMarker = marker
      this._firePointerEvent('mouseover', marker, e)
    }
  }

  private _synthesizeMouseOut(reason: MouseOutReason, e?: L.LeafletMouseEvent): void {
    const marker = this._hoveredMarker
    if (!marker) return
    this._hoveredMarker = null

    this.fire('mouseout', {
      marker,
      reason,
      latlng: e ? e.latlng : marker.latlng,
      containerPoint: e?.containerPoint,
      layerPoint: e && this._map
        ? this._map.containerPointToLayerPoint(e.containerPoint)
        : undefined,
      originalEvent: e?.originalEvent,
    })
  }

  // ── Pointer left the map container: reset hover state ──

  private _handleMapMouseOut(e: L.LeafletMouseEvent): void {
    if (!this._hoveredMarker) return
    if (this.listens('mouseout')) {
      this._synthesizeMouseOut('move', e)
    } else {
      this._hoveredMarker = null
    }
  }

  // ── click / dblclick / contextmenu pipeline (fires only on a marker hit) ──

  private _handleMapClick(e: L.LeafletMouseEvent): void {
    if (!this.listens('click')) return
    const marker = this._pickForEvent(e)
    if (marker) this._firePointerEvent('click', marker, e)
  }

  private _handleMapDblClick(e: L.LeafletMouseEvent): void {
    if (!this.listens('dblclick')) return
    const marker = this._pickForEvent(e)
    if (marker) this._firePointerEvent('dblclick', marker, e)
  }

  private _handleMapContextMenu(e: L.LeafletMouseEvent): void {
    if (!this.listens('contextmenu')) return
    const marker = this._pickForEvent(e)
    if (marker) this._firePointerEvent('contextmenu', marker, e)
  }

  private _pickForEvent(e: L.LeafletMouseEvent): WebGLMarker | null {
    if (this._isOverDomOverlay(e)) return null
    this._ensurePickFrame()
    const result = this._pick(e.containerPoint)
    return result.status === 'hit' ? result.marker : null
  }

  private _firePointerEvent(
    type: 'click' | 'dblclick' | 'contextmenu' | 'mouseover',
    marker: WebGLMarker,
    e: L.LeafletMouseEvent
  ): void {
    this.fire(type, {
      marker,
      latlng: e.latlng,
      containerPoint: e.containerPoint,
      layerPoint: this._map
        ? this._map.containerPointToLayerPoint(e.containerPoint)
        : undefined,
      originalEvent: e.originalEvent,
    })
  }
}

// Reuse L.Evented: on / off / once / fire / listens all come from Leaflet - no
// hand-written event table. fire injects { type, target }, and removing a
// listener during dispatch is safe. The whitelist copy does not drag in
// constructor / _initHooks / callInitHooks / addEventParent leftovers.
mixinEvented(WebGLMarkerLayer.prototype)

/** Object-form bulk registration (shared by on / once / off; supported by L.Evented at runtime) */
type WebGLMarkerLayerEventHandlers = {
  [K in keyof WebGLMarkerLayerEventMap]?: (e: WebGLMarkerLayerEventMap[K]) => void
}

export interface WebGLMarkerLayer {
  on<K extends keyof WebGLMarkerLayerEventMap>(
    type: K,
    fn: (e: WebGLMarkerLayerEventMap[K]) => void,
    context?: unknown
  ): this
  on(type: string, fn: Function, context?: unknown): this
  on(types: WebGLMarkerLayerEventHandlers, context?: unknown): this

  once<K extends keyof WebGLMarkerLayerEventMap>(
    type: K,
    fn: (e: WebGLMarkerLayerEventMap[K]) => void,
    context?: unknown
  ): this
  once(type: string, fn: Function, context?: unknown): this
  once(types: WebGLMarkerLayerEventHandlers, context?: unknown): this

  off<K extends keyof WebGLMarkerLayerEventMap>(
    type?: K,
    fn?: (e: WebGLMarkerLayerEventMap[K]) => void,
    context?: unknown
  ): this
  off(type?: string, fn?: Function, context?: unknown): this
  off(types?: WebGLMarkerLayerEventHandlers, context?: unknown): this

  listens<K extends keyof WebGLMarkerLayerEventMap>(
    type: K,
    propagate?: boolean
  ): boolean

  fire<K extends keyof WebGLMarkerLayerEventMap>(
    type: K,
    data?: Omit<WebGLMarkerLayerEventMap[K], 'type' | 'target'>,
    propagate?: boolean
  ): this
}

export default WebGLMarkerLayer
