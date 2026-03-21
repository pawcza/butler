/*
 * NEBULA VERTEX SHADER
 *
 * Fullscreen quad passthrough. The fragment shader does all the work.
 * Three.js PlaneGeometry(-1 to 1) fills the screen when we skip
 * the model/projection transforms and pass position directly as clip coords.
 */

// --- Output to fragment shader ---
varying vec2 v_uv;

void main() {
    v_uv = uv;
    // Pass through position as clip-space coordinates (no transforms needed)
    gl_Position = vec4(position.xy, 0.0, 1.0);
}
