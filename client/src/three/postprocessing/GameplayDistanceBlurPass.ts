import type { DepthTexture, WebGLRenderTarget, WebGLRenderer } from 'three';
import { Vector2 } from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

type BlurCamera = {
  far: number;
  near: number;
  isPerspectiveCamera?: boolean;
};

const GameplayDistanceBlurShader = {
  name: 'GameplayDistanceBlurShader',
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    resolution: { value: new Vector2(1, 1) },
    cameraNear: { value: 0.1 },
    cameraFar: { value: 1000 },
    nearBlurStart: { value: 12 },
    focusNear: { value: 28 },
    focusFar: { value: 96 },
    farBlurEnd: { value: 140 },
    maxNearBlurRadiusPx: { value: 1.1 },
    maxFarBlurRadiusPx: { value: 5.25 },
    isPerspectiveCamera: { value: 1.0 },
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
    uniform sampler2D tDepth;
    uniform vec2 resolution;
    uniform float cameraNear;
    uniform float cameraFar;
    uniform float nearBlurStart;
    uniform float focusNear;
    uniform float focusFar;
    uniform float farBlurEnd;
    uniform float maxNearBlurRadiusPx;
    uniform float maxFarBlurRadiusPx;
    uniform float isPerspectiveCamera;

    varying vec2 vUv;

    #include <packing>

    float getViewDistance(vec2 uv) {
      float fragDepth = texture2D(tDepth, uv).x;
      float viewZ = isPerspectiveCamera > 0.5
        ? perspectiveDepthToViewZ(fragDepth, cameraNear, cameraFar)
        : orthographicDepthToViewZ(fragDepth, cameraNear, cameraFar);
      return -viewZ;
    }

    vec4 sampleBlurTap(vec2 offset, float radiusPx, float centerDistance, float depthBleedRange, float tapWeight) {
      vec2 sampleUv = clamp(vUv + (offset * radiusPx) / resolution, 0.0, 1.0);
      float sampleDistance = getViewDistance(sampleUv);
      float depthWeight = 1.0 - clamp(abs(sampleDistance - centerDistance) / depthBleedRange, 0.0, 1.0);
      float weight = tapWeight * mix(0.18, 1.0, depthWeight);
      vec3 sampleColor = texture2D(tDiffuse, sampleUv).rgb;

      return vec4(sampleColor * weight, weight);
    }

    void main() {
      vec4 centerColor = texture2D(tDiffuse, vUv);

      if (maxNearBlurRadiusPx <= 0.0 && maxFarBlurRadiusPx <= 0.0) {
        gl_FragColor = centerColor;
        return;
      }

      float centerDistance = getViewDistance(vUv);
      float nearBlurFactor = 1.0 - smoothstep(nearBlurStart, focusNear, centerDistance);
      float farBlurFactor = smoothstep(focusFar, farBlurEnd, centerDistance);
      nearBlurFactor = pow(max(nearBlurFactor, 0.0), 1.15);
      farBlurFactor = pow(max(farBlurFactor, 0.0), 0.82);
      float blurFactor = max(nearBlurFactor * 0.62, farBlurFactor);

      if (blurFactor <= 0.001) {
        gl_FragColor = centerColor;
        return;
      }

      float radiusPx = nearBlurFactor * maxNearBlurRadiusPx + farBlurFactor * maxFarBlurRadiusPx;
      float depthBleedRange = max(7.0, max(focusNear - nearBlurStart, farBlurEnd - focusFar) * 0.36);
      vec3 accum = centerColor.rgb;
      float totalWeight = 1.0;
      vec4 tap;

      tap = sampleBlurTap(vec2(1.0, 0.0), radiusPx, centerDistance, depthBleedRange, 1.0);
      accum += tap.rgb;
      totalWeight += tap.a;

      tap = sampleBlurTap(vec2(-1.0, 0.0), radiusPx, centerDistance, depthBleedRange, 1.0);
      accum += tap.rgb;
      totalWeight += tap.a;

      tap = sampleBlurTap(vec2(0.0, 1.0), radiusPx, centerDistance, depthBleedRange, 1.0);
      accum += tap.rgb;
      totalWeight += tap.a;

      tap = sampleBlurTap(vec2(0.0, -1.0), radiusPx, centerDistance, depthBleedRange, 1.0);
      accum += tap.rgb;
      totalWeight += tap.a;

      tap = sampleBlurTap(vec2(0.7071, 0.7071), radiusPx, centerDistance, depthBleedRange, 0.85);
      accum += tap.rgb;
      totalWeight += tap.a;

      tap = sampleBlurTap(vec2(-0.7071, 0.7071), radiusPx, centerDistance, depthBleedRange, 0.85);
      accum += tap.rgb;
      totalWeight += tap.a;

      tap = sampleBlurTap(vec2(0.7071, -0.7071), radiusPx, centerDistance, depthBleedRange, 0.85);
      accum += tap.rgb;
      totalWeight += tap.a;

      tap = sampleBlurTap(vec2(-0.7071, -0.7071), radiusPx, centerDistance, depthBleedRange, 0.85);
      accum += tap.rgb;
      totalWeight += tap.a;

      vec3 blurredColor = accum / totalWeight;
      gl_FragColor = vec4(mix(centerColor.rgb, blurredColor, blurFactor), centerColor.a);
    }
  `,
};

export class GameplayDistanceBlurPass extends ShaderPass {
  public constructor() {
    super(GameplayDistanceBlurShader);
  }

  public override setSize(width: number, height: number): void {
    this.uniforms.resolution.value.set(width, height);
  }

  public setCamera(camera: BlurCamera): void {
    this.uniforms.cameraNear.value = camera.near;
    this.uniforms.cameraFar.value = camera.far;
    this.uniforms.isPerspectiveCamera.value = camera.isPerspectiveCamera ? 1.0 : 0.0;
  }

  public setFocusBand(nearBlurStart: number, focusNear: number, focusFar: number, farBlurEnd: number): void {
    this.uniforms.nearBlurStart.value = nearBlurStart;
    this.uniforms.focusNear.value = focusNear;
    this.uniforms.focusFar.value = focusFar;
    this.uniforms.farBlurEnd.value = farBlurEnd;
  }

  public setMaxBlurRadiiPx(maxNearBlurRadiusPx: number, maxFarBlurRadiusPx: number): void {
    this.uniforms.maxNearBlurRadiusPx.value = maxNearBlurRadiusPx;
    this.uniforms.maxFarBlurRadiusPx.value = maxFarBlurRadiusPx;
  }

  public override render(
    renderer: WebGLRenderer,
    writeBuffer: WebGLRenderTarget,
    readBuffer: WebGLRenderTarget,
    deltaTime?: number,
    maskActive?: boolean,
  ): void {
    this.uniforms.tDepth.value = readBuffer.depthTexture as DepthTexture | null;
    super.render(renderer, writeBuffer, readBuffer, deltaTime ?? 0, maskActive ?? false);
  }
}
