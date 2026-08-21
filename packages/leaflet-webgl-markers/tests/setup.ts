// jsdom does not always provide requestAnimationFrame; the layer schedules
// renders through it even before a WebGL context exists.
if (typeof globalThis.requestAnimationFrame === 'undefined') {
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number =>
    setTimeout(() => callback(Date.now()), 0) as unknown as number
}
