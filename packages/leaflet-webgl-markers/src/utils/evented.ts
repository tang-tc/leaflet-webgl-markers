/**
 * Mix the L.Evented event machinery into any class prototype (whitelist copy;
 * the Evented constructor is never invoked). Object.assign is deliberately
 * avoided: it would also copy constructor / _initHooks / callInitHooks and other
 * Class prototype leftovers onto the target.
 */
import L from 'leaflet'

const EVENTED_METHODS = [
  'on',
  'off',
  '_on',
  '_off',
  'fire',
  'listens',
  '_listens',
  'once',
  '_propagateEvent',
] as const

export function mixinEvented(proto: object): void {
  const target = proto as Record<string, unknown>
  const source = L.Evented.prototype as unknown as Record<string, unknown>
  for (const name of EVENTED_METHODS) {
    target[name] = source[name]
  }
}
