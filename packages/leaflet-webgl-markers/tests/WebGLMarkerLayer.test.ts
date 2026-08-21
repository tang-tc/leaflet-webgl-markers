import { describe, expect, it } from 'vitest'
import { WebGLMarker, WebGLMarkerLayer } from '../src/index'

describe('WebGLMarkerLayer constructor validation', () => {
  it('accepts defaults without a GL context', () => {
    const layer = new WebGLMarkerLayer()
    expect(layer.count).toBe(0)
  })

  it.each([0, -1, NaN, Infinity, '38'])('rejects invalid iconSize %s', (value) => {
    expect(() => new WebGLMarkerLayer({ iconSize: value as never })).toThrow(RangeError)
  })

  it.each([0.9, 0, -1, NaN, Infinity, '1.2'])('rejects invalid capacityFactor %s', (value) => {
    expect(() => new WebGLMarkerLayer({ capacityFactor: value as never })).toThrow(RangeError)
  })

  it('rejects a non-string textureUrl', () => {
    expect(() => new WebGLMarkerLayer({ textureUrl: 123 as never })).toThrow(TypeError)
  })

  it('accepts valid options', () => {
    const layer = new WebGLMarkerLayer({ iconSize: 8, capacityFactor: 2, textureUrl: 'a.png' })
    expect(layer.count).toBe(0)
  })
})

describe('WebGLMarkerLayer CRUD validation (no GL required)', () => {
  it('rejects a non-marker in addMarker', () => {
    const layer = new WebGLMarkerLayer()
    expect(() => layer.addMarker({} as never)).toThrow(/WebGLMarker/)
  })

  it('treats adding the same instance twice as idempotent', () => {
    const layer = new WebGLMarkerLayer()
    const m = new WebGLMarker([0, 0])

    layer.addMarker(m)
    layer.addMarker(m)

    expect(layer.count).toBe(1)
  })

  it('rejects duplicate markers in setMarkers', () => {
    const layer = new WebGLMarkerLayer()
    const m = new WebGLMarker([0, 0])

    expect(() => layer.setMarkers([m, m])).toThrow(/duplicate/)
  })

  it('validates setIconSize input', () => {
    const layer = new WebGLMarkerLayer()

    expect(() => layer.setIconSize('8' as never)).toThrow(TypeError)
    expect(() => layer.setIconSize(0)).toThrow(RangeError)
    expect(() => layer.setIconSize(-1)).toThrow(RangeError)
    expect(() => layer.setIconSize(NaN)).toThrow(RangeError)
    expect(() => layer.setIconSize(8)).not.toThrow()
  })
})
