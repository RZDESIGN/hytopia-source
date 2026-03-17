import {
  type DepthTexture,
  HalfFloatType,
  LinearFilter,
  Matrix4,
  ShaderMaterial,
  UniformsUtils,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';

type BlurCamera = {
  far: number;
  near: number;
  isPerspectiveCamera?: boolean;
  projectionMatrixInverse: Matrix4;
};

const DEPTH_BLUR_RESOLUTION_SCALE = 0.42;

const vertexShader = `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const sharedDepthBlurFunctions = `
  #include <packing>

  bool isSkyDepth(float fragDepth) {
    return fragDepth >= 0.999999;
  }

  float getViewDistanceFromFragDepth(float fragDepth, float isPerspectiveCamera, float cameraNear, float cameraFar) {
    float viewZ = isPerspectiveCamera > 0.5
      ? perspectiveDepthToViewZ(fragDepth, cameraNear, cameraFar)
      : orthographicDepthToViewZ(fragDepth, cameraNear, cameraFar);
    return -viewZ;
  }

  float getViewDistance(sampler2D depthTexture, vec2 uv, float isPerspectiveCamera, float cameraNear, float cameraFar) {
    return getViewDistanceFromFragDepth(texture2D(depthTexture, uv).x, isPerspectiveCamera, cameraNear, cameraFar);
  }

  vec3 getViewPositionFromFragDepth(float fragDepth, vec2 uv, mat4 projectionMatrixInverse) {
    float clipZ = fragDepth * 2.0 - 1.0;
    vec4 clipPosition = vec4(uv * 2.0 - 1.0, clipZ, 1.0);
    vec4 viewPosition = projectionMatrixInverse * clipPosition;
    return viewPosition.xyz / max(abs(viewPosition.w), 0.0001);
  }

  float getBlurDistance(vec3 centerViewPosition, float centerViewDistance, vec3 focusAnchorView, float focusAnchorEnabled) {
    return focusAnchorEnabled > 0.5
      ? distance(centerViewPosition, focusAnchorView)
      : centerViewDistance;
  }

  float getBlurFactor(float centerDistance, float nearBlurStart, float focusNear, float focusFar, float farBlurEnd, float focusAnchorEnabled) {
    float nearBlurFactor = focusAnchorEnabled > 0.5 ? 0.0 : 1.0 - smoothstep(nearBlurStart, focusNear, centerDistance);
    float farBlurFactor = smoothstep(focusFar, farBlurEnd, centerDistance);
    nearBlurFactor = pow(max(nearBlurFactor, 0.0), 1.0);
    farBlurFactor = pow(max(farBlurFactor, 0.0), 0.68);
    return clamp(max(nearBlurFactor * 0.72, farBlurFactor * 1.12), 0.0, 1.0);
  }
`;

const BlurShader = {
  name: 'GameplayDistanceBlurHalfResShader',
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    sourceResolution: { value: new Vector2(1, 1) },
    projectionMatrixInverse: { value: new Matrix4() },
    cameraNear: { value: 0.1 },
    cameraFar: { value: 1000 },
    nearBlurStart: { value: 12 },
    focusNear: { value: 28 },
    focusFar: { value: 96 },
    farBlurEnd: { value: 140 },
    focusAnchorView: { value: new Vector3() },
    focusAnchorEnabled: { value: 0.0 },
    maxNearBlurRadiusPx: { value: 1.1 },
    maxFarBlurRadiusPx: { value: 5.25 },
    isPerspectiveCamera: { value: 1.0 },
  },
  vertexShader,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform vec2 sourceResolution;
    uniform mat4 projectionMatrixInverse;
    uniform float cameraNear;
    uniform float cameraFar;
    uniform float nearBlurStart;
    uniform float focusNear;
    uniform float focusFar;
    uniform float farBlurEnd;
    uniform vec3 focusAnchorView;
    uniform float focusAnchorEnabled;
    uniform float maxNearBlurRadiusPx;
    uniform float maxFarBlurRadiusPx;
    uniform float isPerspectiveCamera;

    varying vec2 vUv;

    ${sharedDepthBlurFunctions}

    vec4 sampleBlurTap(vec2 offset, float radiusPx, float centerViewDistance, float depthBleedRange, float tapWeight) {
      vec2 sampleUv = clamp(vUv + (offset * radiusPx) / sourceResolution, 0.0, 1.0);
      float sampleFragDepth = texture2D(tDepth, sampleUv).x;
      if (isSkyDepth(sampleFragDepth)) {
        return vec4(0.0);
      }
      float sampleDistance = getViewDistanceFromFragDepth(sampleFragDepth, isPerspectiveCamera, cameraNear, cameraFar);
      float depthWeight = 1.0 - clamp(abs(sampleDistance - centerViewDistance) / depthBleedRange, 0.0, 1.0);
      float weight = tapWeight * mix(0.18, 1.0, depthWeight);
      vec3 sampleColor = texture2D(tDiffuse, sampleUv).rgb;

      return vec4(sampleColor * weight, weight);
    }

    vec4 sampleSkyEdgeTap(vec2 offset, float radiusPx, float tapWeight) {
      vec2 sampleUv = clamp(vUv + (offset * radiusPx) / sourceResolution, 0.0, 1.0);
      float sampleFragDepth = texture2D(tDepth, sampleUv).x;
      if (isSkyDepth(sampleFragDepth)) {
        return vec4(0.0);
      }

      float sampleViewDistance = getViewDistanceFromFragDepth(sampleFragDepth, isPerspectiveCamera, cameraNear, cameraFar);
      vec3 sampleViewPosition = getViewPositionFromFragDepth(sampleFragDepth, sampleUv, projectionMatrixInverse);
      float sampleBlurDistance = getBlurDistance(sampleViewPosition, sampleViewDistance, focusAnchorView, focusAnchorEnabled);
      float sampleBlurFactor = getBlurFactor(sampleBlurDistance, nearBlurStart, focusNear, focusFar, farBlurEnd, focusAnchorEnabled);
      if (sampleBlurFactor <= 0.001) {
        return vec4(0.0);
      }

      vec3 sampleColor = texture2D(tDiffuse, sampleUv).rgb;
      float weight = tapWeight * sampleBlurFactor;
      return vec4(sampleColor * weight, weight);
    }

    void main() {
      vec4 centerColor = texture2D(tDiffuse, vUv);

      if (maxNearBlurRadiusPx <= 0.0 && maxFarBlurRadiusPx <= 0.0) {
        gl_FragColor = centerColor;
        return;
      }

      float centerFragDepth = texture2D(tDepth, vUv).x;
      if (isSkyDepth(centerFragDepth)) {
        float skyEdgeRadiusPx = max(1.5, maxFarBlurRadiusPx * 0.55);
        vec3 skyEdgeAccum = vec3(0.0);
        float skyEdgeWeight = 0.0;
        vec4 tap;

        tap = sampleSkyEdgeTap(vec2(1.0, 0.0), skyEdgeRadiusPx, 1.0);
        skyEdgeAccum += tap.rgb;
        skyEdgeWeight += tap.a;

        tap = sampleSkyEdgeTap(vec2(-1.0, 0.0), skyEdgeRadiusPx, 1.0);
        skyEdgeAccum += tap.rgb;
        skyEdgeWeight += tap.a;

        tap = sampleSkyEdgeTap(vec2(0.0, 1.0), skyEdgeRadiusPx, 1.0);
        skyEdgeAccum += tap.rgb;
        skyEdgeWeight += tap.a;

        tap = sampleSkyEdgeTap(vec2(0.0, -1.0), skyEdgeRadiusPx, 1.0);
        skyEdgeAccum += tap.rgb;
        skyEdgeWeight += tap.a;

        tap = sampleSkyEdgeTap(vec2(0.7071, 0.7071), skyEdgeRadiusPx, 0.85);
        skyEdgeAccum += tap.rgb;
        skyEdgeWeight += tap.a;

        tap = sampleSkyEdgeTap(vec2(-0.7071, 0.7071), skyEdgeRadiusPx, 0.85);
        skyEdgeAccum += tap.rgb;
        skyEdgeWeight += tap.a;

        tap = sampleSkyEdgeTap(vec2(0.7071, -0.7071), skyEdgeRadiusPx, 0.85);
        skyEdgeAccum += tap.rgb;
        skyEdgeWeight += tap.a;

        tap = sampleSkyEdgeTap(vec2(-0.7071, -0.7071), skyEdgeRadiusPx, 0.85);
        skyEdgeAccum += tap.rgb;
        skyEdgeWeight += tap.a;

        if (skyEdgeWeight <= 0.001) {
          gl_FragColor = centerColor;
          return;
        }

        vec3 skyEdgeColor = skyEdgeAccum / skyEdgeWeight;
        float skyEdgeBlend = clamp(skyEdgeWeight * 0.42, 0.0, 0.45);
        gl_FragColor = vec4(mix(centerColor.rgb, skyEdgeColor, skyEdgeBlend), centerColor.a);
        return;
      }

      float centerViewDistance = getViewDistanceFromFragDepth(centerFragDepth, isPerspectiveCamera, cameraNear, cameraFar);
      vec3 centerViewPosition = getViewPositionFromFragDepth(centerFragDepth, vUv, projectionMatrixInverse);
      float centerBlurDistance = getBlurDistance(centerViewPosition, centerViewDistance, focusAnchorView, focusAnchorEnabled);
      float nearBlurFactor = focusAnchorEnabled > 0.5 ? 0.0 : 1.0 - smoothstep(nearBlurStart, focusNear, centerBlurDistance);
      float farBlurFactor = smoothstep(focusFar, farBlurEnd, centerBlurDistance);
      nearBlurFactor = pow(max(nearBlurFactor, 0.0), 1.0);
      farBlurFactor = pow(max(farBlurFactor, 0.0), 0.68);
      float blurFactor = clamp(max(nearBlurFactor * 0.72, farBlurFactor * 1.12), 0.0, 1.0);

      if (blurFactor <= 0.001) {
        gl_FragColor = centerColor;
        return;
      }

      float radiusPx = nearBlurFactor * maxNearBlurRadiusPx + farBlurFactor * maxFarBlurRadiusPx;
      radiusPx *= mix(1.0, 1.24, blurFactor);
      float depthBleedRange = max(5.0, max(focusNear - nearBlurStart, farBlurEnd - focusFar) * 0.28);
      vec3 accum = centerColor.rgb;
      float totalWeight = 1.0;
      vec4 tap;

      tap = sampleBlurTap(vec2(1.0, 0.0), radiusPx, centerViewDistance, depthBleedRange, 1.0);
      accum += tap.rgb;
      totalWeight += tap.a;

      tap = sampleBlurTap(vec2(-1.0, 0.0), radiusPx, centerViewDistance, depthBleedRange, 1.0);
      accum += tap.rgb;
      totalWeight += tap.a;

      tap = sampleBlurTap(vec2(0.0, 1.0), radiusPx, centerViewDistance, depthBleedRange, 1.0);
      accum += tap.rgb;
      totalWeight += tap.a;

      tap = sampleBlurTap(vec2(0.0, -1.0), radiusPx, centerViewDistance, depthBleedRange, 1.0);
      accum += tap.rgb;
      totalWeight += tap.a;

      tap = sampleBlurTap(vec2(0.7071, 0.7071), radiusPx, centerViewDistance, depthBleedRange, 0.85);
      accum += tap.rgb;
      totalWeight += tap.a;

      tap = sampleBlurTap(vec2(-0.7071, 0.7071), radiusPx, centerViewDistance, depthBleedRange, 0.85);
      accum += tap.rgb;
      totalWeight += tap.a;

      tap = sampleBlurTap(vec2(0.7071, -0.7071), radiusPx, centerViewDistance, depthBleedRange, 0.85);
      accum += tap.rgb;
      totalWeight += tap.a;

      tap = sampleBlurTap(vec2(-0.7071, -0.7071), radiusPx, centerViewDistance, depthBleedRange, 0.85);
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
    projectionMatrixInverse: { value: new Matrix4() },
    cameraNear: { value: 0.1 },
    cameraFar: { value: 1000 },
    nearBlurStart: { value: 12 },
    focusNear: { value: 28 },
    focusFar: { value: 96 },
    farBlurEnd: { value: 140 },
    focusAnchorView: { value: new Vector3() },
    focusAnchorEnabled: { value: 0.0 },
    isPerspectiveCamera: { value: 1.0 },
  },
  vertexShader,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform sampler2D tBlur;
    uniform mat4 projectionMatrixInverse;
    uniform float cameraNear;
    uniform float cameraFar;
    uniform float nearBlurStart;
    uniform float focusNear;
    uniform float focusFar;
    uniform float farBlurEnd;
    uniform vec3 focusAnchorView;
    uniform float focusAnchorEnabled;
    uniform float isPerspectiveCamera;

    varying vec2 vUv;

    ${sharedDepthBlurFunctions}

    void main() {
      vec4 centerColor = texture2D(tDiffuse, vUv);
      float centerFragDepth = texture2D(tDepth, vUv).x;
      if (isSkyDepth(centerFragDepth)) {
        vec3 blurredColor = texture2D(tBlur, vUv).rgb;
        float edgeDelta = length(blurredColor - centerColor.rgb);
        float edgeBlend = smoothstep(0.015, 0.12, edgeDelta);
        gl_FragColor = vec4(mix(centerColor.rgb, blurredColor, edgeBlend), centerColor.a);
        return;
      }

      float centerViewDistance = getViewDistanceFromFragDepth(centerFragDepth, isPerspectiveCamera, cameraNear, cameraFar);
      vec3 centerViewPosition = getViewPositionFromFragDepth(centerFragDepth, vUv, projectionMatrixInverse);
      float centerDistance = getBlurDistance(centerViewPosition, centerViewDistance, focusAnchorView, focusAnchorEnabled);
      float blurFactor = getBlurFactor(centerDistance, nearBlurStart, focusNear, focusFar, farBlurEnd, focusAnchorEnabled);

      if (blurFactor <= 0.001) {
        gl_FragColor = centerColor;
        return;
      }

      vec3 blurredColor = texture2D(tBlur, vUv).rgb;
      gl_FragColor = vec4(mix(centerColor.rgb, blurredColor, min(1.0, blurFactor * 1.12)), centerColor.a);
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
    this._blurMaterial.uniforms.projectionMatrixInverse.value.copy(camera.projectionMatrixInverse);

    this._compositeMaterial.uniforms.cameraNear.value = camera.near;
    this._compositeMaterial.uniforms.cameraFar.value = camera.far;
    this._compositeMaterial.uniforms.isPerspectiveCamera.value = camera.isPerspectiveCamera ? 1.0 : 0.0;
    this._compositeMaterial.uniforms.projectionMatrixInverse.value.copy(camera.projectionMatrixInverse);
  }

  public setFocusAnchorView(viewPosition: Vector3 | null): void {
    if (viewPosition) {
      this._blurMaterial.uniforms.focusAnchorView.value.copy(viewPosition);
      this._blurMaterial.uniforms.focusAnchorEnabled.value = 1.0;
      this._compositeMaterial.uniforms.focusAnchorView.value.copy(viewPosition);
      this._compositeMaterial.uniforms.focusAnchorEnabled.value = 1.0;
      return;
    }

    this._blurMaterial.uniforms.focusAnchorEnabled.value = 0.0;
    this._compositeMaterial.uniforms.focusAnchorEnabled.value = 0.0;
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
