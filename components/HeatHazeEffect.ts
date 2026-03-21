import { Effect } from 'postprocessing'
import { Uniform } from 'three'

const fragmentShader = /* glsl */ `
  uniform float u_time;
  uniform float u_intensity;
  uniform float u_falloff;

  void mainUv(inout vec2 uv) {
    // Distance from screen center (UV 0.5, 0.5)
    vec2 centered = uv - 0.5;
    float dist = length(centered);

    // Exponential radial falloff — strong at center, zero at edges
    float falloff = exp(-dist * u_falloff);

    // Two overlapping sine waves at different frequencies and directions
    // for organic, non-repeating shimmer
    float wave1 = sin(dist * 30.0 - u_time * 3.0) * 0.5;
    float wave2 = sin(dist * 20.0 + u_time * 2.3 + 1.5) * 0.5;

    // Displacement perpendicular to the radius (tangential) + radial
    vec2 radialDir = dist > 0.001 ? centered / dist : vec2(0.0);
    vec2 tangentDir = vec2(-radialDir.y, radialDir.x);

    vec2 displacement = radialDir * wave1 + tangentDir * wave2;
    uv += displacement * falloff * u_intensity;
  }
`

export class HeatHazeEffect extends Effect {
  constructor({
    intensity = 0.005,
    falloff = 4.0,
  } = {}) {
    super('HeatHazeEffect', fragmentShader, {
      uniforms: new Map<string, Uniform>([
        ['u_time', new Uniform(0)],
        ['u_intensity', new Uniform(intensity)],
        ['u_falloff', new Uniform(falloff)],
      ]),
    })
  }

  get time(): number {
    return this.uniforms.get('u_time')!.value as number
  }

  set time(value: number) {
    this.uniforms.get('u_time')!.value = value
  }

  get intensity(): number {
    return this.uniforms.get('u_intensity')!.value as number
  }

  set intensity(value: number) {
    this.uniforms.get('u_intensity')!.value = value
  }

  get falloff(): number {
    return this.uniforms.get('u_falloff')!.value as number
  }

  set falloff(value: number) {
    this.uniforms.get('u_falloff')!.value = value
  }
}
