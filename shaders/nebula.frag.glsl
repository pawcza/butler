/*
 * NEBULA FOG FRAGMENT SHADER
 *
 * Creates a slowly drifting cloud of colored fog using layered 3D noise.
 * Tinted by the current state color. Radial falloff keeps edges clean.
 *
 * The noise function is simplex noise (Ashima Arts / Ian McEwan).
 * It's included inline because GLSL doesn't have #include.
 */

// --- Input from vertex shader ---
varying vec2 v_uv;

// --- Uniforms ---
uniform float u_time;
uniform vec3 u_color;       // current state color — tints the fog
uniform float u_intensity;  // overall fog density (0.0 - 0.15)

// =========================================================================
// SIMPLEX NOISE (3D) — Ashima Arts / Ian McEwan
// Public domain. Included inline for GLSL compatibility.
// =========================================================================

vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 10.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
    const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

    // --- First corner ---
    vec3 i = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);

    // --- Other corners ---
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);

    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;

    // --- Permutations ---
    i = mod289(i);
    vec4 p = permute(permute(permute(
        i.z + vec4(0.0, i1.z, i2.z, 1.0))
      + i.y + vec4(0.0, i1.y, i2.y, 1.0))
      + i.x + vec4(0.0, i1.x, i2.x, 1.0));

    // --- Gradients: 7x7 points over a square mapped onto an octahedron ---
    float n_ = 0.142857142857;  // 1.0 / 7.0
    vec3 ns = n_ * D.wyz - D.xzx;

    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);

    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);

    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);

    vec4 s0 = floor(b0) * 2.0 + 1.0;
    vec4 s1 = floor(b1) * 2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));

    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);

    // --- Normalise gradients ---
    vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
    p0 *= norm.x;
    p1 *= norm.y;
    p2 *= norm.z;
    p3 *= norm.w;

    // --- Mix final noise value ---
    vec4 m = max(0.5 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
    m = m * m;
    return 105.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

// =========================================================================
// MAIN
// =========================================================================

void main() {
    // --- Step 1: Sample position in 3D noise space ---
    // Static fog — no time drift. The noise pattern is baked at load time.
    // Using a fixed Z slice keeps the fog still so it feels like a backdrop.
    vec3 noiseCoord = vec3(
        v_uv * 2.0 - 1.0,      // center the UV so (0,0) is screen center
        0.5                     // fixed Z slice — static fog, no scrolling
    );

    // --- Step 2: Layer noise at multiple scales (octaves) ---
    // Each octave adds finer detail at lower amplitude.
    // 3 octaves gives us: large billowing clouds + medium shapes + fine wisps
    float noise = 0.0;
    noise += snoise(noiseCoord * 1.0) * 0.5;    // large clouds
    noise += snoise(noiseCoord * 2.5) * 0.3;    // medium detail
    noise += snoise(noiseCoord * 6.0) * 0.2;    // fine wisps

    // Normalize from [-1, 1] range to [0, 1]
    noise = noise * 0.5 + 0.5;

    // --- Step 3: Radial falloff ---
    // Very wide falloff — edges fade far beyond the visible screen so
    // the boundary is never visible. The fog just… is there.
    vec2 centered = v_uv * 2.0 - 1.0;
    float radialDist = length(centered);
    float falloff = 1.0 - smoothstep(0.3, 2.5, radialDist);

    // --- Step 4: Final color ---
    // Tint the noise with the state color, apply radial falloff and intensity
    float alpha = noise * falloff * u_intensity;
    gl_FragColor = vec4(u_color * noise, alpha);
}
