/*
 * PARTICLE VERTEX SHADER
 *
 * Computes the position of each particle in the galaxy/shape system.
 * Each particle has a "home" position (where it floats in the galaxy)
 * and a "shape" position (where it goes when condensing into a shape).
 *
 * The u_condense uniform (0 = galaxy, 1 = shape) controls the blend.
 * The u_shapeMorph uniform handles smooth transitions between two shapes.
 *
 * Three.js automatically provides: projectionMatrix, modelViewMatrix.
 */

// --- Per-particle attributes (set once at init, never updated per frame) ---
attribute vec3 a_homePosition;        // where this particle orbits in the galaxy
attribute vec3 a_shapePositionFrom;   // previous shape slot (for morph transitions)
attribute vec3 a_shapePositionTo;     // current shape slot (target)
attribute float a_phase;              // random 0-1 offset for organic movement
attribute float a_assignedToShape;    // 1.0 = joins the shape, 0.0 = stays as floater

// --- Uniforms (updated from CPU each frame) ---
uniform float u_time;           // elapsed seconds
uniform float u_condense;       // 0 = galaxy, 1 = fully condensed into shape
uniform float u_shapeMorph;     // 0 = at "from" shape, 1 = at "to" shape
uniform float u_wobbleAmount;   // amplitude of organic sine wobble
uniform float u_energy;         // TTS playback energy — drives outward pulse
uniform float u_pointSize;      // base particle size
uniform vec3 u_color;           // state color (for brightness variation)

// --- Output to fragment shader ---
varying float v_brightness;     // how bright this particle should be
varying float v_distToCenter;   // distance from center (for fade effects)

// --- Constants ---
const float PI = 3.14159265;
const float GALAXY_RADIUS = 5.5;      // how far out the galaxy extends
const float FLOATER_PULL = 0.3;        // how strongly unassigned particles are pulled
const float ENERGY_PULSE = 0.4;        // how much audio energy pushes particles outward
const float SIZE_ATTENUATION = 300.0;  // perspective size scaling factor

void main() {
    // --- Step 1: Compute galaxy position ---
    // No coherent orbit — particles stay at their home positions.
    // All organic movement comes from the wobble in Step 4.
    // A gentle vertical bob gives the galaxy depth and life.
    vec3 galaxyPos = a_homePosition;
    float bobStrength = 1.0 - u_condense; // bob fades out when forming shapes
    galaxyPos.y += sin(u_time * 0.5 + a_phase * PI * 6.0) * 0.15 * bobStrength;

    // --- Step 2: Compute shape position (morph between from/to) ---
    // When transitioning between shapes, this smoothly blends old → new.
    // No rotation here — the shape holds its form so you can see it clearly.
    vec3 shapePos = mix(a_shapePositionFrom, a_shapePositionTo, u_shapeMorph);

    // --- Step 3: Blend between galaxy and shape ---
    vec3 finalPosition;
    if (a_assignedToShape > 0.5) {
        // This particle IS part of the shape
        finalPosition = mix(galaxyPos, shapePos, u_condense);
    } else {
        // This particle is a floater — gentle pull toward center
        // Pull strength falls off with distance (nearby floaters get pulled more)
        float dist = length(galaxyPos);
        float pullStrength = u_condense * FLOATER_PULL / (1.0 + dist);
        finalPosition = galaxyPos + pullStrength * (vec3(0.0) - galaxyPos);
    }

    // --- Step 4: Add organic wobble ---
    // Two sine waves on XY axes with different frequencies — Lissajous path.
    float wobbleTime = u_time * 2.0 + a_phase * PI * 4.0;
    finalPosition.x += sin(wobbleTime * 1.3) * u_wobbleAmount;
    finalPosition.y += sin(wobbleTime * 1.7 + 1.0) * u_wobbleAmount;

    // --- Step 5: Audio energy pulse ---
    // Particles push outward from center when TTS audio is playing.
    // Shape particles stay locked in place — only floaters react.
    // This keeps the shape crisp while the surrounding cloud breathes.
    float distFromCenter = length(finalPosition);
    if (distFromCenter > 0.001) {
        vec3 outward = finalPosition / distFromCenter;
        float distanceFalloff = 1.0 / (1.0 + distFromCenter * 0.4);
        // When condensed: only floaters (non-shape particles) pulse
        float reactivity = mix(1.0, 1.0 - a_assignedToShape, u_condense);
        finalPosition += outward * u_energy * ENERGY_PULSE * distanceFalloff * reactivity;
    }

    // --- Step 6: Project to screen ---
    vec4 mvPosition = modelViewMatrix * vec4(finalPosition, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    // Size gets smaller with distance (perspective)
    gl_PointSize = u_pointSize * (SIZE_ATTENUATION / -mvPosition.z);

    // --- Step 7: Pass data to fragment shader ---
    v_distToCenter = length(finalPosition);
    // Brightness: particles in the shape are brighter than floaters
    float shapeBrightness = mix(0.4, 1.0, a_assignedToShape * u_condense);
    // Add a subtle flicker based on phase and time
    float flicker = 0.9 + 0.1 * sin(u_time * 3.0 + a_phase * 20.0);
    v_brightness = shapeBrightness * flicker;
}
