/*
 * PARTICLE FRAGMENT SHADER
 *
 * Each particle: a tiny solid-color square core + a soft circular glow halo.
 * Additive blending is set on the material (not here).
 */

// --- Input from vertex shader ---
varying float v_brightness;
varying float v_distToCenter;

// --- Uniforms ---
uniform vec3 u_color;               // state color (RGB)
uniform float u_particleBrightness; // base brightness from state
uniform float u_condense;           // 0 = galaxy (full glow), 1 = shape (minimal glow)

void main() {
    vec2 uv = gl_PointCoord * 2.0 - 1.0;
    float radialDist = length(uv);

    // --- Layer 1: Circular glow (covers full point sprite) ---
    // Glow fades out as particles condense into a shape to keep edges crisp
    float glow = pow(max(0.0, 1.0 - radialDist), 2.5);
    float glowStrength = mix(1.8, 0.3, u_condense);

    float depthFade = 1.0 - v_distToCenter * 0.04;
    float glowAlpha = glow * v_brightness * u_particleBrightness * depthFade * glowStrength;
    vec3 glowColor = u_color * glowAlpha;

    // --- Layer 2: Solid square core (tiny, high intensity) ---
    // Chebyshev distance for square shape, hard cutoff
    float squareDist = max(abs(uv.x), abs(uv.y));
    float core = 1.0 - step(0.06, squareDist);

    // Core is bright and solid — high flat intensity so it reads as a hard pixel
    float coreAlpha = core * v_brightness * depthFade;
    vec3 coreColor = u_color * coreAlpha;

    // Combine: core adds on top of glow
    gl_FragColor = vec4(coreColor + glowColor, coreAlpha + glowAlpha);
}
