/**
 * WebGLMarkerLayer shader sources.
 * The layer only renders and picks; hover/selected visuals are the user's job
 * to implement in their event handlers.
 */

export const VS_SOURCE = /* glsl */ `
attribute vec2 a_latlng;
attribute float a_rotation;
attribute vec3 a_color;
attribute vec3 a_id_color;
attribute float a_opacity;
attribute float a_size;

uniform float u_scale;
uniform vec2 u_pixelOrigin;
uniform vec2 u_boundsMin;
uniform vec2 u_boundsSize;
uniform float u_pointSize;
uniform float u_dpr;
uniform float u_maxPointSize;

varying float v_rotation;
varying vec3 v_color;
varying vec3 v_id_color;
varying float v_opacity;

const float PI = 3.141592653589793;
const float R = 6378137.0;
const float ORIGIN_SHIFT = PI * R;
const float DEG_TO_RAD = PI / 180.0;
const float MAX_LAT = 85.0511287798;

void main() {
  float lat = clamp(a_latlng.x, -MAX_LAT, MAX_LAT);
  float lng = a_latlng.y;
  float mx = lng * DEG_TO_RAD * R;
  float my = log(tan(PI * 0.25 + lat * 0.5 * DEG_TO_RAD)) * R;

  float resolution = ORIGIN_SHIFT * 2.0 / u_scale;
  float px = (mx + ORIGIN_SHIFT) / resolution;
  float py = (ORIGIN_SHIFT - my) / resolution;

  float lpx = px - u_pixelOrigin.x;
  float lpy = py - u_pixelOrigin.y;

  gl_Position = vec4(
    ((lpx - u_boundsMin.x) / u_boundsSize.x) * 2.0 - 1.0,
    1.0 - ((lpy - u_boundsMin.y) / u_boundsSize.y) * 2.0,
    0.0,
    1.0
  );

  // When visible=false, lat/lng are written as NaN; push the point off screen and
  // zero its size explicitly so hidden markers take part in neither pass (without
  // relying on undefined NaN clipping).
  // Size semantics (A): a_size > 0 = absolute pixels (times dpr -> physical px);
  // a_size <= 0 (marker.size is null) = follow the layer iconSize
  // (u_pointSize already includes dpr).
  if (lat != lat || lng != lng) {
    gl_Position = vec4(0.0, -2.0, 0.0, 1.0);
    gl_PointSize = 0.0;
  } else {
    gl_PointSize = min(a_size > 0.0 ? a_size * u_dpr : u_pointSize, u_maxPointSize);
  }
  v_rotation = a_rotation;
  v_color = a_color;
  v_id_color = a_id_color;
  v_opacity = a_opacity;
}
`

export const FS_DISPLAY_SOURCE = /* glsl */ `
precision mediump float;
varying float v_rotation;
varying vec3 v_color;
varying float v_opacity;
uniform sampler2D u_texture;

void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float c = cos(v_rotation);
  // Positive rotation is clockwise on screen (compass heading from north),
  // which is the negative direction of the standard CCW rotation matrix in
  // gl_PointCoord space.
  float s = -sin(v_rotation);
  uv = vec2(uv.x * c - uv.y * s, uv.x * s + uv.y * c);
  uv += 0.5;

  vec4 tex = texture2D(u_texture, uv);
  vec4 color = vec4(v_color * tex.rgb, tex.a * v_opacity);

  if (color.a < 0.05) discard;
  gl_FragColor = color;
}
`

export const FS_PICK_SOURCE = /* glsl */ `
precision mediump float;
varying float v_rotation;
varying vec3 v_id_color;
varying float v_opacity;
uniform sampler2D u_texture;

void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float c = cos(v_rotation);
  // Keep pick rotation identical to display rotation so hit areas line up.
  float s = -sin(v_rotation);
  uv = vec2(uv.x * c - uv.y * s, uv.x * s + uv.y * c);
  uv += 0.5;

  // Identical to the display pass: hit by "texture alpha x opacity", so
  // transparent texture areas are not pickable (no ghost clicks) and there is no
  // inscribed-circle approximation anymore.
  float alpha = texture2D(u_texture, uv).a * v_opacity;
  if (alpha < 0.05) discard;
  gl_FragColor = vec4(v_id_color, 1.0);
}
`
