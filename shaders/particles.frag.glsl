/*
 * POINT FRAGMENT SHADER
 * A small crisp disc with a hairline antialiased edge. No glow.
 */

varying float v_fade;

uniform vec3 u_color;
uniform float u_particleBrightness;

void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float disc = 1.0 - smoothstep(0.7, 1.0, d);
    float alpha = disc * v_fade * u_particleBrightness;
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(u_color, alpha);
}
