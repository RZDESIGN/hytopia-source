import {
  Color,
  ShaderMaterial,
  UniformsUtils,
  Vector2,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';

const HaloShader = {
  name: 'AnalyticSunHaloShader',
  uniforms: {
    tDiffuse: { value: null },
    resolution: { value: new Vector2(1, 1) },
    sunColor: { value: new Color(1.0, 0.97, 0.92) },
    sunScreenUv: { value: new Vector2(0.5, 0.5) },
    intensity: { value: 0.0 },
  },
  vertexShader: `
    varying vec2 vUv;

    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform vec2 resolution;
    uniform vec3 sunColor;
    uniform vec2 sunScreenUv;
    uniform float intensity;

    varying vec2 vUv;

    float radialGlow(vec2 uv, vec2 center, vec2 aspect, float scale, float exponent) {
      float d = length((uv - center) * aspect) * scale;
      return exp(-pow(d, exponent));
    }

    float softGhost(vec2 uv, vec2 ghostCenter, vec2 aspect, float scale) {
      vec2 delta = (uv - ghostCenter) * aspect;
      float r = length(delta);
      return exp(-r * scale) * (1.0 - smoothstep(0.0, 0.26, r));
    }

    void main() {
      vec4 base = texture2D(tDiffuse, vUv);

      if (intensity <= 0.0001) {
        gl_FragColor = base;
        return;
      }

      vec2 aspect = vec2(resolution.x / max(resolution.y, 1.0), 1.0);
      vec2 screenCenter = vec2(0.5, 0.5);
      vec2 axis = screenCenter - sunScreenUv;
      float axisLength = max(length(axis), 0.0001);
      vec2 axisDir = axis / axisLength;
      vec2 axisPerp = vec2(-axisDir.y, axisDir.x);

      float offscreenDistance = length((sunScreenUv - screenCenter) * aspect);
      float visibility = smoothstep(1.8, 0.08, offscreenDistance);

      float core = radialGlow(vUv, sunScreenUv, aspect, 10.0, 1.45);
      float veil = radialGlow(vUv, sunScreenUv, aspect, 3.35, 1.05);

      float ghostA = softGhost(vUv, sunScreenUv + axis * 0.28, aspect, 11.5);
      float ghostB = softGhost(vUv, sunScreenUv + axis * 0.58, aspect, 18.0);
      float ghostC = softGhost(vUv, sunScreenUv + axis * 0.9, aspect, 9.0);

      vec2 streakOrigin = sunScreenUv + axis * 0.1;
      vec2 streakDelta = (vUv - streakOrigin) * aspect;
      float streakAcross = exp(-abs(dot(streakDelta, axisPerp)) * 58.0);
      float streakAlong = exp(-abs(dot(streakDelta, axisDir)) * 7.0);
      float streak = streakAcross * streakAlong;

      float halo = core * 0.7 + veil * 0.32 + ghostA * 0.18 + ghostB * 0.14 + ghostC * 0.09 + streak * 0.18;
      halo *= intensity * visibility;

      vec3 color = base.rgb + sunColor * halo;
      gl_FragColor = vec4(color, base.a);
    }
  `,
};

export class AnalyticSunHaloPass extends Pass {
  private _material: ShaderMaterial;
  private _fsQuad: FullScreenQuad;

  public constructor() {
    super();

    this._material = new ShaderMaterial({
      name: HaloShader.name,
      uniforms: UniformsUtils.clone(HaloShader.uniforms),
      vertexShader: HaloShader.vertexShader,
      fragmentShader: HaloShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this._fsQuad = new FullScreenQuad(this._material);
  }

  public override setSize(width: number, height: number): void {
    this._material.uniforms.resolution.value.set(width, height);
  }

  public setSun(screenUv: Vector2, color: Color, intensity: number): void {
    this._material.uniforms.sunScreenUv.value.copy(screenUv);
    this._material.uniforms.sunColor.value.copy(color);
    this._material.uniforms.intensity.value = intensity;
    this.enabled = intensity > 0.0001;
  }

  public override render(
    renderer: WebGLRenderer,
    writeBuffer: WebGLRenderTarget,
    readBuffer: WebGLRenderTarget,
  ): void {
    this._material.uniforms.tDiffuse.value = readBuffer.texture;
    const target = this.renderToScreen ? null : writeBuffer;
    renderer.setRenderTarget(target);
    if (this.clear) {
      renderer.clear(renderer.autoClearColor, renderer.autoClearDepth, renderer.autoClearStencil);
    }
    this._fsQuad.render(renderer);
  }

  public override dispose(): void {
    this._material.dispose();
    this._fsQuad.dispose();
  }
}
