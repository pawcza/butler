/*
 * STAR FIELD FRAGMENT SHADER
 *
 * Simple white dot with soft edges. Stars are always white
 * regardless of avatar state color — they're the backdrop.
 */

// --- Input from vertex shader ---
varying float v_alpha;

void main() {
    // --- Step 1: Radial falloff ---
    // Same technique as particle shader but softer falloff (exponent 2.0 vs 3.0)
    vec2 center = gl_PointCoord * 2.0 - 1.0;
    float dist = length(center);

    // Discard outside circle
    if (dist > 1.0) discard;

    // Gentle glow — stars are softer than the main particles
    float glow = pow(1.0 - dist, 2.0);

    // --- Step 2: Output pure white with alpha ---
    gl_FragColor = vec4(1.0, 1.0, 1.0, glow * v_alpha);
}
