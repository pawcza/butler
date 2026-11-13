/*
 * SHARED POSITION CHUNK
 *
 * Prepended to both the point and the line vertex shaders, so a line end lands exactly on the
 * point it belongs to. Every particle has a "home" position (the loose constellation) and a
 * shape slot (where it goes when condensing). u_condense blends the two, u_shapeMorph blends the
 * previous shape slot into the current one.
 */

uniform float u_time;           // elapsed seconds
uniform float u_condense;       // 0 = loose constellation, 1 = fully condensed into the shape
uniform float u_shapeMorph;     // 0 = at the previous shape, 1 = at the current shape
uniform float u_wobbleAmount;   // amplitude of the organic sine wobble
uniform float u_energy;         // TTS playback energy, drives an outward pulse

const float PI = 3.14159265;
const float FLOATER_PULL = 0.3;  // how strongly unassigned particles are pulled to the centre
const float ENERGY_PULSE = 0.4;  // how far audio energy pushes particles outward

vec3 plexusPosition(vec3 home, vec3 shapeFrom, vec3 shapeTo, float phase, float assigned) {
    // Gentle vertical bob, fading out as the shape forms
    vec3 galaxyPos = home;
    galaxyPos.y += sin(u_time * 0.5 + phase * PI * 6.0) * 0.15 * (1.0 - u_condense);

    vec3 shapePos = mix(shapeFrom, shapeTo, u_shapeMorph);

    vec3 p;
    if (assigned > 0.5) {
        p = mix(galaxyPos, shapePos, u_condense);
    } else {
        // Floaters drift slightly toward the centre, nearby ones more
        float pull = u_condense * FLOATER_PULL / (1.0 + length(galaxyPos));
        p = galaxyPos - pull * galaxyPos;
    }

    // Lissajous wobble
    float wobbleTime = u_time * 2.0 + phase * PI * 4.0;
    p.x += sin(wobbleTime * 1.3) * u_wobbleAmount;
    p.y += sin(wobbleTime * 1.7 + 1.0) * u_wobbleAmount;

    // Audio pulse: only floaters move, so the shape stays crisp while the cloud breathes
    float d = length(p);
    if (d > 0.001) {
        float falloff = 1.0 / (1.0 + d * 0.4);
        float reactivity = mix(1.0, 1.0 - assigned, u_condense);
        p += (p / d) * u_energy * ENERGY_PULSE * falloff * reactivity;
    }
    return p;
}

// Fade with distance from the camera: far parts recede, parts right in front stay out of the way
float depthFade(float viewDepth) {
    return (1.0 - 0.7 * smoothstep(4.5, 10.5, viewDepth)) * smoothstep(0.6, 2.2, viewDepth);
}
