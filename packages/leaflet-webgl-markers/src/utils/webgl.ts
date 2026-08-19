/**
 * WebGL helpers
 */

/**
 * Compile a single WebGL shader.
 * @returns the compiled shader, or null on failure
 */
export function compileShader(
  gl: WebGLRenderingContext,
  type: number,
  source: string
): WebGLShader | null {
  const shader = gl.createShader(type)
  if (!shader) return null

  gl.shaderSource(shader, source)
  gl.compileShader(shader)

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error('Shader compile error:', gl.getShaderInfoLog(shader))
    gl.deleteShader(shader)
    return null
  }
  return shader
}

/**
 * Compile and link a shader program.
 * @returns the linked program, or null on failure
 */
export function createProgram(
  gl: WebGLRenderingContext,
  vsSource: string,
  fsSource: string
): WebGLProgram | null {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource)
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource)
  if (!vs || !fs) return null

  const prog = gl.createProgram()
  if (!prog) return null

  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)

  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error('Program link error:', gl.getProgramInfoLog(prog))
    return null
  }
  return prog
}

/**
 * Load a texture asynchronously.
 * Defaults to crossOrigin='anonymous' so cross-origin textures don't taint the
 * WebGL context (otherwise getImageData / mixing textures throws SECURITY_ERR).
 * @param crossOrigin custom crossorigin value; pass null to leave it unset
 * @returns a Promise resolving to the WebGLTexture
 */
export function loadTexture(
  gl: WebGLRenderingContext,
  url: string,
  crossOrigin: string | null = 'anonymous'
): Promise<WebGLTexture> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    if (crossOrigin !== null) img.crossOrigin = crossOrigin
    img.onload = () => {
      const tex = gl.createTexture()
      if (!tex) return reject(new Error('Failed to create texture'))
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      resolve(tex)
    }
    img.onerror = () => reject(new Error('Failed to load texture: ' + url))
    img.src = url
  })
}

/**
 * Create a 1x1 solid-color texture (no network request). Used as the default
 * texture when textureUrl is omitted: the fragment shader samples a constant
 * alpha=1, markers render as solid-color squares, and picking behaves exactly
 * like it does for icon textures.
 */
export function createSolidTexture(
  gl: WebGLRenderingContext,
  rgba: [number, number, number, number] = [255, 255, 255, 255]
): WebGLTexture | null {
  const tex = gl.createTexture()
  if (!tex) return null
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    1,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    new Uint8Array(rgba)
  )
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return tex
}
