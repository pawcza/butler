varying float v_fade;

uniform vec3 u_color;
uniform float u_lineOpacity;

void main() {
    float alpha = v_fade * u_lineOpacity;
    if (alpha < 0.005) discard;
    gl_FragColor = vec4(u_color, alpha);
}
