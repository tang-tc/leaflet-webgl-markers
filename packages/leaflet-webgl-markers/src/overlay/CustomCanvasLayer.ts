/**
 * CustomCanvasLayer — a custom Leaflet canvas overlay
 *
 * Mounts a <canvas> on the overlayPane and keeps it fully in sync with map
 * drag/zoom. Suitable for rendering large data with WebGL (points, lines,
 * polygons, heatmaps, ...).
 *
 * ## Sync model
 *
 * ### Panning
 * The canvas is a child of the overlayPane, which is itself a child of the
 * mapPane. While dragging, Draggable moves the mapPane via CSS transform and the
 * canvas follows automatically - zero JS redraws for the whole gesture.
 *
 * When the drag ends (moveend), _reset() runs:
 *   1. clear the leftover zoom-animation CSS transform
 *   2. compensate the mapPane offset via containerPointToLayerPoint and re-anchor
 *   3. check and adjust the pixel buffer size
 *   4. invoke the user render callback
 *
 * ### Zoom animation
 * On zoom start the Map adds a CSS transition class to the mapPane for a 250ms
 * smooth transition, and fires zoomanim -> _animateZoom() applies a CSS transform
 * to the canvas so it visually follows. During the animation _reset() is blocked
 * by the _animatingZoom lock and nothing redraws.
 *
 * After the transition (transitionend / 250ms timeout) _animatingZoom becomes
 * false, moveend fires, and _reset() restores normal positioning + redraws.
 *
 * ## Lifecycle
 *
 * onAdd(map)
 *   └─ _reset()  <- first render
 *
 * drag end -> moveend -> _reset()
 * zoom animation -> zoomanim -> _animateZoom()  <- CSS transform only, no redraw
 * zoom end -> moveend -> _reset()
 * window resize -> viewreset -> _reset()
 *
 * onRemove()
 *   └─ remove DOM, clear references
 *
 * ## Usage
 *
 * const layer = new CustomCanvasLayer()
 * layer.setRenderCallback((ctx) => {
 *   const gl = ctx.canvas.getContext('webgl')
 *   gl.viewport(0, 0, ctx.dprSize.width, ctx.dprSize.height)
 *   // ... WebGL rendering ...
 * })
 * layer.addTo(map)
 */

import L from 'leaflet'

/** Leaflet internals (file-local only; never leaked into consumer types) */
type MapInternals = L.Map & {
  _animatingZoom?: boolean
  _getNewPixelOrigin(center: L.LatLng, zoom: number): L.Point
}

/** Passed to the render callback on every render */
export interface RenderContext {
  /** Canvas DOM element; call getContext('webgl') to obtain the GL context */
  canvas: HTMLCanvasElement

  /** Leaflet map instance */
  map: L.Map

  /** Canvas CSS pixel size (logical pixels, DPR excluded) */
  size: { width: number; height: number }

  /** Canvas pixel buffer size (= size x dpr; set the WebGL viewport to this) */
  dprSize: { width: number; height: number }

  /** Current screen devicePixelRatio */
  dpr: number

  /** Visible area in layerPoint coordinates */
  bounds: { min: L.Point; max: L.Point }

  /** Current zoom level */
  zoom: number

  /** Map center in lat/lng */
  center: L.LatLng

  /** Geographic coordinates -> layerPoint (CSS pixels) */
  latLngToLayerPoint: (latlng: L.LatLng) => L.Point

  /** layerPoint (CSS pixels) -> geographic coordinates */
  layerPointToLatLng: (point: L.Point) => L.LatLng
}

export interface CustomCanvasLayerOptions {
  /** Pane the canvas lives in; defaults to overlayPane */
  pane?: string

  /** Extra CSS class attached to the canvas */
  className?: string

  /** Whether to scale the pixel buffer by devicePixelRatio */
  dprScale?: boolean
}

export class CustomCanvasLayer extends L.Layer {
  declare options: CustomCanvasLayerOptions

  private _onRender: ((ctx: RenderContext) => void) | null = null
  private _container: HTMLCanvasElement | null = null
  private _size: { x: number; y: number; dpr: number } | null = null
  private _zoom: number | undefined = undefined
  private _center: L.LatLng | undefined = undefined
  private _topLeft: L.Point | null = null
  private _zoomTransformApplied = false

  constructor(opts?: CustomCanvasLayerOptions) {
    super()
    // Create instance-level options first (L.setOptions must not pollute
    // L.Layer.prototype.options).
    this.options = Object.create(this.options || {})
    L.setOptions(this, {
      pane: 'overlayPane',
      className: '',
      dprScale: true,
      ...opts,
    })
  }

  // ────────────── Leaflet lifecycle ──────────────

  onAdd(map: L.Map): this {
    this._map = map

    const className =
      'leaflet-zoom-animated' +
      (this.options.className ? ' ' + this.options.className : '')
    this._container = L.DomUtil.create('canvas', className) as HTMLCanvasElement
    this._container.style.pointerEvents = 'none'

    this.getPane()!.appendChild(this._container)

    this._updateState()
    this._reset()

    return this
  }

  onRemove(_map: L.Map): this {
    if (this._container) {
      L.DomUtil.remove(this._container)
    }
    this._container = null

    return this
  }

  getEvents(): Record<string, (...args: any[]) => void> {
    const events: Record<string, (...args: any[]) => void> = {
      viewreset: this._reset as () => void,
      moveend: this._reset as () => void,
    }
    // Matches the original code: _zoomAnimated is set to map._zoomAnimated in
    // _layerAdd (before getEvents() runs), and is true in modern browsers.
    if ((this as any)._zoomAnimated) {
      events.zoomanim = this._animateZoom as () => void
    }
    return events
  }

  // ────────────── Public API ──────────────

  /** @returns the canvas DOM element */
  getCanvas(): HTMLCanvasElement | null {
    return this._container
  }

  /** @returns the map instance */
  getMap(): L.Map | null {
    return this._map
  }

  /** Set the render callback */
  setRenderCallback(fn: (ctx: RenderContext) => void): this {
    this._onRender = fn
    return this
  }

  /** Manually run a full reposition + render pass */
  redraw(): void {
    this._reset()
  }

  /** Current canvas logical size */
  getCanvasSize(): { width: number; height: number; dpr: number } | null {
    return this._size
      ? { width: this._size.x, height: this._size.y, dpr: this._size.dpr }
      : null
  }

  /**
   * Whether the canvas is aligned 1:1 with the current viewport (a prerequisite
   * for pixel-level operations such as picking):
   * - no zoom-animation CSS transform;
   * - the canvas anchor (_topLeft) equals the negation of the current mapPane
   *   offset. While the mapPane keeps moving (drag / inertia / panBy / flyTo /
   *   pinch zoom) this method returns false.
   */
  isAligned(): boolean {
    if (!this._map || !this._container || !this._topLeft) return false
    if (this._zoomTransformApplied) return false
    const topLeft = this._map.containerPointToLayerPoint(L.point(0, 0))
    return this._topLeft.equals(topLeft)
  }

  // ────────────── Internals ──────────────

  private _reset(): void {
    if (!this._map || !this._container) return

    const size = this._map.getSize()
    if (size.x === 0 || size.y === 0) return

    if ((this._map as MapInternals)._animatingZoom) return

    this._updateState()

    this._clearTransform()

    this._topLeft = this._map.containerPointToLayerPoint(L.point(0, 0))
    L.DomUtil.setPosition(this._container, this._topLeft)

    this._resizeCanvas()
    this._render()
  }

  private _updateState(): void {
    if (!this._map) return
    this._zoom = this._map.getZoom()
    this._center = this._map.getCenter()
  }

  private _resizeCanvas(): void {
    if (!this._container || !this._map) return

    const size = this._map.getSize()
    const dpr = this.options.dprScale ? window.devicePixelRatio || 1 : 1
    const width = Math.round(size.x)
    const height = Math.round(size.y)
    const pixelW = Math.round(width * dpr)
    const pixelH = Math.round(height * dpr)

    if (
      this._container.width !== pixelW ||
      this._container.height !== pixelH
    ) {
      this._container.width = pixelW
      this._container.height = pixelH
      this._container.style.width = width + 'px'
      this._container.style.height = height + 'px'
    }

    this._size = { x: width, y: height, dpr }
  }

  private _clearTransform(): void {
    if (!this._container) return
    this._container.style[L.DomUtil.TRANSFORM as any] = ''
    this._zoomTransformApplied = false
  }

  /**
   * Zoom-animation frame handler — applies a CSS transform so the canvas follows
   * the zoom visually. Uses exactly the same math as Leaflet's built-in
   * Renderer._updateTransform.
   */
  private _animateZoom(e: L.ZoomAnimEvent): void {
    if (this._zoom === undefined || !this._container || !this._map) return

    const scale = this._map.getZoomScale(e.zoom, this._zoom)
    const viewHalf = this._map.getSize().divideBy(2)

    const map = this._map as MapInternals
    const currentCenterPoint = map.project(this._center!, e.zoom)

    const topLeftOffset = viewHalf
      .multiplyBy(-scale)
      .add(currentCenterPoint)
      .subtract(map._getNewPixelOrigin(e.center, e.zoom))

    this._zoomTransformApplied = true
    L.DomUtil.setTransform(this._container, topLeftOffset, scale)
  }

  private _render(): void {
    if (!this._onRender || !this._map || !this._container || !this._size) return

    const size = this._map.getSize()
    if (size.x === 0 || size.y === 0) return

    const bounds = {
      min: this._map.containerPointToLayerPoint(L.point(0, 0)),
      max: this._map.containerPointToLayerPoint(size),
    }

    const ctx: RenderContext = {
      canvas: this._container,
      map: this._map,
      size: { width: this._size.x, height: this._size.y },
      dprSize: {
        width: this._container.width,
        height: this._container.height,
      },
      dpr: this._size.dpr,
      bounds,
      zoom: this._map.getZoom(),
      center: this._map.getCenter(),
      latLngToLayerPoint: this._map.latLngToLayerPoint.bind(this._map),
      layerPointToLatLng: this._map.layerPointToLatLng.bind(this._map),
    }

    this._onRender(ctx)
  }
}

export default CustomCanvasLayer
