import { describe, expect, it } from 'vitest'
import { mixinEvented } from '../src/utils/evented'

class Target {}
mixinEvented(Target.prototype)

describe('mixinEvented', () => {
  it('copies the Evented API onto the target prototype', () => {
    for (const name of ['on', 'off', 'once', 'fire', 'listens']) {
      expect(name in Target.prototype).toBe(true)
    }
  })

  it('provides working on/off/fire semantics', () => {
    const target = new Target() as any
    const seen: any[] = []
    const handler = (e: any) => seen.push(e)

    target.on('ping', handler)
    target.fire('ping', { n: 1 })

    expect(seen).toHaveLength(1)
    expect(seen[0].type).toBe('ping')
    expect(seen[0].target).toBe(target)
    expect(seen[0].n).toBe(1)

    target.off('ping', handler)
    target.fire('ping')

    expect(seen).toHaveLength(1)
  })

  it('fires once handlers a single time', () => {
    const target = new Target() as any
    let calls = 0

    target.once('go', () => {
      calls++
    })
    target.fire('go')
    target.fire('go')

    expect(calls).toBe(1)
  })

  it('reports registered handlers through listens', () => {
    const target = new Target() as any

    expect(target.listens('x')).toBe(false)
    target.on('x', () => {})
    expect(target.listens('x')).toBe(true)
  })
})
