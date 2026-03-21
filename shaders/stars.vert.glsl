/*
 * STAR FIELD VERTEX SHADER
 *
 * Renders a static field of distant stars as a backdrop.
 * Most stars are tiny dim dots. ~50 "bright" stars twinkle
 * via a slow sine wave on their alpha.
 */

// --- Per-star attributes ---
attribute float a_brightness;  // 0.0-0.3 for dim stars, 0.8-1.0 for bright ones
attribute float a_phase;       // random offset for twinkle timing

// --- Uniforms ---
uniform float u_time;
uniform float u_pointSize;

// --- Output to fragment shader ---
varying float v_alpha;

void main() {
    // --- Step 1: Transform position to clip space ---
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    // --- Step 2: Twinkle effect for bright stars ---
    // Only bright stars (brightness > 0.5) get the twinkle.
    // Dim stars stay at constant alpha — they're just backdrop filler.
    float twinkle = 1.0;
    if (a_brightness > 0.5) {
        twinkle = 0.6 + 0.4 * sin(u_time * 1.5 + a_phase * 6.28);
    }

    // --- Step 3: Size — bright stars are larger ---
    gl_PointSize = u_pointSize * (0.5 + a_brightness * 1.5);

    // --- Step 4: Pass alpha to fragment shader ---
    v_alpha = a_brightness * twinkle;
}
