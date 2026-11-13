/*
 * LINE VERTEX SHADER
 *
 * Each vertex carries its own particle's attributes (as the points do) plus the partner
 * particle's (suffix B). Both ends are placed by the shared position function, so lines follow the
 * morph, wobble and audio pulse on the GPU. Opacity fades with the current distance between the
 * ends, so stretched links dissolve.
 *
 * u_kind 0 = links between neighbours in the loose layout, 1 = links between neighbours in the
 * current shape (they read as its wireframe).
 */

attribute vec3 a_homePosition;
attribute vec3 a_shapePositionFrom;
attribute vec3 a_shapePositionTo;
attribute float a_phase;
attribute float a_assignedToShape;

attribute vec3 a_homePositionB;
attribute vec3 a_shapePositionFromB;
attribute vec3 a_shapePositionToB;
attribute float a_phaseB;
attribute float a_assignedToShapeB;

uniform float u_kind;
uniform float u_maxLen;

varying float v_fade;

void main() {
    vec3 pa = plexusPosition(a_homePosition, a_shapePositionFrom, a_shapePositionTo, a_phase, a_assignedToShape);
    vec3 pb = plexusPosition(a_homePositionB, a_shapePositionFromB, a_shapePositionToB, a_phaseB, a_assignedToShapeB);

    vec4 mv = modelViewMatrix * vec4(pa, 1.0);
    gl_Position = projectionMatrix * mv;

    float weight;
    float reach = u_maxLen;
    if (u_kind > 0.5) {
        // Shape links appear as the particles arrive, and tolerate some scatter while half condensed
        weight = u_condense * smoothstep(0.5, 1.0, u_shapeMorph);
        reach *= 1.0 + (1.0 - u_condense) * 3.0;
    } else {
        // Loose links give way to the shape links for the particles that join the shape
        weight = 1.0 - u_condense * max(a_assignedToShape, a_assignedToShapeB);
    }

    float dist = distance(pa, pb);
    float stretch = 1.0 - smoothstep(reach * 0.45, reach, dist);
    v_fade = weight * stretch * depthFade(-mv.z);
}
