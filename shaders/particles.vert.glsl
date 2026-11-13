/*
 * POINT VERTEX SHADER
 * Position comes from the shared chunk (shaders/position.glsl), prepended in ButlerScene.vue.
 */

attribute vec3 a_homePosition;
attribute vec3 a_shapePositionFrom;
attribute vec3 a_shapePositionTo;
attribute float a_phase;
attribute float a_assignedToShape;

uniform float u_pointSize;

varying float v_fade;

const float SIZE_ATTENUATION = 300.0;

void main() {
    vec3 p = plexusPosition(a_homePosition, a_shapePositionFrom, a_shapePositionTo, a_phase, a_assignedToShape);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;

    // Slight size variety; shape points a touch smaller as they condense so the lines lead
    float size = u_pointSize * (0.75 + 0.5 * a_phase) * (1.0 - 0.2 * a_assignedToShape * u_condense);
    gl_PointSize = size * (SIZE_ATTENUATION / -mv.z);

    float twinkle = 0.93 + 0.07 * sin(u_time * 2.0 + a_phase * 20.0);
    v_fade = depthFade(-mv.z) * twinkle * mix(0.7, 1.0, a_assignedToShape * u_condense);
}
