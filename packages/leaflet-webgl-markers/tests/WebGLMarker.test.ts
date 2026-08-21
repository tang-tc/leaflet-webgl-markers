import L from 'leaflet'
import { describe, expect, it } from 'vitest'
import { WebGLMarker } from '../src/index'

describe('WebGLMarker', () => {
  it('applies defaults for omitted options', () => {
    const m = new WebGLMarker({ latlng: [39.9, 116.4] })

    expect(m.latlng).toBeInstanceOf(L.LatLng)
    expect(m.latlng.lat).toBe(39.9)
    expect(m.latlng.lng).toBe(116.4)
    expect(m.rotation).toBe(0)
    expect(m.color).toEqual([1, 1, 1])
    expect(m.size).toBeNull()
    expect(m.visible).toBe(true)
    expect(m.opacity).toBe(1)
    expect(m.data).toBeNull()
  })

  it('accepts the [lat, lng] shorthand', () => {
    const m = new WebGLMarker([51.5, -0.1])

    expect(m.latlng.lat).toBe(51.5)
    expect(m.latlng.lng).toBe(-0.1)
  })

  it('keeps an L.LatLng instance as-is', () => {
    const latlng = L.latLng(1, 2)
    const m = new WebGLMarker({ latlng })

    expect(m.latlng).toBe(latlng)
  })

  it('assigns unique, increasing ids', () => {
    const seen = new Set<number>()
    let last = 0

    for (let i = 0; i < 1000; i++) {
      const id = new WebGLMarker({ latlng: [0, 0] }).id
      expect(id).toBeGreaterThan(last)
      last = id
      seen.add(id)
    }

    expect(seen.size).toBe(1000)
  })

  it('preserves explicit falsy data values', () => {
    expect(new WebGLMarker({ latlng: [0, 0], data: 0 }).data).toBe(0)
    expect(new WebGLMarker({ latlng: [0, 0], data: '' }).data).toBe('')
    expect(new WebGLMarker({ latlng: [0, 0], data: false }).data).toBe(false)
  })
})
