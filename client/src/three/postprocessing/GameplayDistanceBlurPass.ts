import {
  type DepthTexture,
  HalfFloatType,
  LinearFilter,
  ShaderMaterial,
  UniformsUtils,
  Vector2,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';

type BlurCamera = {
  far: number;
  near: number;
  isPerspectiveCamera?: boolean;
};

const DEPTH_BLUR_RESOLUTION_SCALE = 0.5;

const vertexShader = `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const sharedDepthBlurFunctions = `
  #include <packing>

  float getViewDistance(sampler2D depthTexture, vec2 uv, float isPerspectiveCamera, float cameraNear, float cameraFar) {
    float fragDepth = texture2D(depthTexture, uv).x;
    float viewZ = isPerspectiveCamera > 0.5
      ? perspectiveDepthToViewZ(fragDepth, cameraNear, cameraFar)
      : orthographicDepthToViewZ(fragDepth, cameraNear, cameraFar);
    return -viewZ;
  }

  float getBlurFactor(float centerDistance, float nearBlurStart, float focusNear, float focusFar, float farBlurEnd) {
    float nearBlurFactor = 1.0 - smoothstep(nearBlurStart, focusNear, centerDistance);
    float farBlurFactor = smoothstep(focusFar, farBlurEnd, centerDistance);
    nearBlurFactor = pow(max(nearBlurFactor, 0.0), 1.15);
    farBlurFactor = pow(max(farBlurFactor, 0.0), 0.82);
    return max(nearBlurFactor * 0.62, farBlurFactor);
  }
`;

const BlurShader = {
  name: 'GameplayDistanceBlurHalfResShader',
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    sourceResolution: { value: new Vector2(1, 1) },
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
  vertexShader,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform vec2 sourceResolution;
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

    ${sharedDepthBlurFunctions}

    vec4 sampleBlurTap(vec2 offset, float radiusPx, float centerDistance, float depthBleedRange, float tapWeight) {
      vec2 sampleUv = clamp(vUv + (offset * radiusPx) / sourceResolution, 0.0, 1.0);
      float sampleDistance = getViewDistance(tDepth, sampleUv, isPerspectiveCamera, cameraNear, cameraFar);
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

      float centerDistance = getViewDistance(tDepth, vUv, isPerspectiveCamera, cameraNear, cameraFar);
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

      gl_FragColor = vec4(accum / totalWeight, centerColor.a);
    }
  `,
};

const CompositeShader = {
  name: 'GameplayDistanceBlurCompositeShader',
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    tBlur: { value: null },
    cameraNear: { value: 0.1 },
    cameraFar: { value: 1000 },
    nearBlurStart: { value: 12 },
    focusNear: { value: 28 },
    focusFar: { value: 96 },
    farBlurEnd: { value: 140 },
    isPerspectiveCamera: { value: 1.0 },
  },
  vertexShader,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform sampler2D tBlur;
    uniform float cameraNear;
    uniform float cameraFar;
    uniform float nearBlurStart;
    uniform float focusNear;
    uniform float focusFar;
    uniform float farBlurEnd;
    uniform float isPerspectiveCamera;

    varying vec2 vUv;

    ${sharedDepthBlurFunctions}

    void main() {
      vec4 centerColor = texture2D(tDiffuse, vUv);
      float centerDistance = getViewDistance(tDepth, vUv, isPerspectiveCamera, cameraNear, cameraFar);
      float blurFactor = getBlurFactor(centerDistance, nearBlurStart, focusNear, focusFar, farBlurEnd);

      if (blurFactor <= 0.001) {
        gl_FragColor = centerColor;
        return;
      }

      vec3 blurredColor = texture2D(tBlur, vUv).rgb;
      gl_FragColor = vec4(mix(centerColor.rgb, blurredColor, blurFactor), centerColor.a);
    }
  `,
};

export class GameplayDistanceBlurPass extends Pass {
  private _blurMaterial: ShaderMaterial;
  private _compositeMaterial: ShaderMaterial;
  private _blurFsQuad: FullScreenQuad;
  private _compositeFsQuad: FullScreenQuad;
  private _halfResTarget: WebGLRenderTarget;

  public constructor() {
    super();

    this._blurMaterial = new ShaderMaterial({
      name: BlurShader.name,
      uniforms: UniformsUtils.clone(BlurShader.uniforms),
      vertexShader: BlurShader.vertexShader,
      fragmentShader: BlurShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this._compositeMaterial = new ShaderMaterial({
      name: CompositeShader.name,
      uniforms: UniformsUtils.clone(CompositeShader.uniforms),
      vertexShader: CompositeShader.vertexShader,
      fragmentShader: CompositeShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });

    this._blurFsQuad = new FullScreenQuad(this._blurMaterial);
    this._compositeFsQuad = new FullScreenQuad(this._compositeMaterial);
    this._halfResTarget = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType,
      magFilter: LinearFilter,
      minFilter: LinearFilter,
    });
    this._halfResTarget.texture.generateMipmaps = false;
  }

  public override setSize(width: number, height: number): void {
    const halfWidth = Math.max(1, Math.round(width * DEPTH_BLUR_RESOLUTION_SCALE));
    const halfHeight = Math.max(1, Math.round(height * DEPTH_BLUR_RESOLUTION_SCALE));
    this._halfResTarget.setSize(halfWidth, halfHeight);
    this._blurMaterial.uniforms.sourceResolution.value.set(width, height);
  }

  public setCamera(camera: BlurCamera): void {
    this._blurMaterial.uniforms.cameraNear.value = camera.near;
    this._blurMaterial.uniforms.cameraFar.value = camera.far;
    this._blurMaterial.uniforms.isPerspectiveCamera.value = camera.isPerspectiveCamera ? 1.0 : 0.0;

    this._compositeMaterial.uniforms.cameraNear.value = camera.near;
    this._compositeMaterial.uniforms.cameraFar.value = camera.far;
    this._compositeMaterial.uniforms.isPerspectiveCamera.value = camera.isPerspectiveCamera ? 1.0 : 0.0;
  }

  public setFocusBand(nearBlurStart: number, focusNear: number, focusFar: number, farBlurEnd: number): void {
    this._blurMaterial.uniforms.nearBlurStart.value = nearBlurStart;
    this._blurMaterial.uniforms.focusNear.value = focusNear;
    this._blurMaterial.uniforms.focusFar.value = focusFar;
    this._blurMaterial.uniforms.farBlurEnd.value = farBlurEnd;

    this._compositeMaterial.uniforms.nearBlurStart.value = nearBlurStart;
    this._compositeMaterial.uniforms.focusNear.value = focusNear;
    this._compositeMaterial.uniforms.focusFar.value = focusFar;
    this._compositeMaterial.uniforms.farBlurEnd.value = farBlurEnd;
  }

  public setMaxBlurRadiiPx(maxNearBlurRadiusPx: number, maxFarBlurRadiusPx: number): void {
    this._blurMaterial.uniforms.maxNearBlurRadiusPx.value = maxNearBlurRadiusPx;
    this._blurMaterial.uniforms.maxFarBlurRadiusPx.value = maxFarBlurRadiusPx;
  }

  public override render(
    renderer: WebGLRenderer,
    writeBuffer: WebGLRenderTarget,
    readBuffer: WebGLRenderTarget,
  ): void {
    const depthTexture = readBuffer.depthTexture as DepthTexture | null;
    if (!depthTexture) {
      return;
    }

    this._blurMaterial.uniforms.tDiffuse.value = readBuffer.texture;
    this._blurMaterial.uniforms.tDepth.value = depthTexture;
    renderer.setRenderTarget(this._halfResTarget);
    renderer.clear();
    this._blurFsQuad.render(renderer);

    this._compositeMaterial.uniforms.tDiffuse.value = readBuffer.texture;
    this._compositeMaterial.uniforms.tDepth.value = depthTexture;
    this._compositeMaterial.uniforms.tBlur.value = this._halfResTarget.texture;

    const compositeTarget = this.renderToScreen ? null : writeBuffer;
    if (compositeTarget !== null && compositeTarget.depthTexture) {
      const gl = renderer.getContext();
      renderer.setRenderTarget(compositeTarget);
      const savedDepthAttachment = gl.getFramebufferAttachmentParameter(
        gl.FRAMEBUFFER,
        gl.DEPTH_ATTACHMENT,
        gl.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME,
      );
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, null, 0);

      if (this.clear) {
        renderer.clear(renderer.autoClearColor, false, renderer.autoClearStencil);
      }
      this._compositeFsQuad.render(renderer);

      renderer.setRenderTarget(compositeTarget);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, savedDepthAttachment, 0);
      return;
    }

    renderer.setRenderTarget(compositeTarget);
    if (this.clear) {
      renderer.clear(renderer.autoClearColor, false, renderer.autoClearStencil);
    }
    this._compositeFsQuad.render(renderer);
  }

  public override dispose(): void {
    this._halfResTarget.dispose();
    this._blurMaterial.dispose();
    this._compositeMaterial.dispose();
    this._blurFsQuad.dispose();
    this._compositeFsQuad.dispose();
  }
}
