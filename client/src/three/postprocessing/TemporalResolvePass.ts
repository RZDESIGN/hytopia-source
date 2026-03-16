import {
  DepthTexture,
  HalfFloatType,
  LinearFilter,
  Matrix4,
  ShaderMaterial,
  UniformsUtils,
  Vector2,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';

type TemporalResolveCamera = {
  far: number;
  near: number;
  projectionMatrix: Matrix4;
  projectionMatrixInverse: Matrix4;
  matrixWorld: Matrix4;
  matrixWorldInverse: Matrix4;
  isPerspectiveCamera?: boolean;
};

const vertexShader = `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const sharedDepthFunctions = `
  #include <packing>

  float getViewDistance(sampler2D depthTexture, vec2 uv, float isPerspectiveCamera, float cameraNear, float cameraFar) {
    float fragDepth = texture2D(depthTexture, uv).x;
    float viewZ = isPerspectiveCamera > 0.5
      ? perspectiveDepthToViewZ(fragDepth, cameraNear, cameraFar)
      : orthographicDepthToViewZ(fragDepth, cameraNear, cameraFar);
    return -viewZ;
  }

  vec3 getViewPosition(sampler2D depthTexture, vec2 uv, mat4 projectionMatrixInverse, float isPerspectiveCamera, float cameraNear, float cameraFar) {
    float fragDepth = texture2D(depthTexture, uv).x;
    float clipZ = fragDepth * 2.0 - 1.0;
    vec4 clipPosition = vec4(uv * 2.0 - 1.0, clipZ, 1.0);
    vec4 viewPosition = projectionMatrixInverse * clipPosition;
    return viewPosition.xyz / max(abs(viewPosition.w), 0.0001);
  }
`;

const TemporalResolveShader = {
  name: 'TemporalResolveShader',
  uniforms: {
    tDepth: { value: null },
    tDiffuse: { value: null },
    tHistory: { value: null },
    cameraFar: { value: 1000 },
    cameraNear: { value: 0.1 },
    currentInverseViewMatrix: { value: new Matrix4() },
    currentProjectionMatrixInverse: { value: new Matrix4() },
    historyWeight: { value: 0.88 },
    isPerspectiveCamera: { value: 1.0 },
    previousViewMatrix: { value: new Matrix4() },
    previousViewProjectionMatrix: { value: new Matrix4() },
    resolution: { value: new Vector2(1, 1) },
    sharpenStrength: { value: 0.1 },
    useHistory: { value: 0.0 },
  },
  vertexShader,
  fragmentShader: `
    uniform sampler2D tDepth;
    uniform sampler2D tDiffuse;
    uniform sampler2D tHistory;
    uniform float cameraFar;
    uniform float cameraNear;
    uniform mat4 currentInverseViewMatrix;
    uniform mat4 currentProjectionMatrixInverse;
    uniform float historyWeight;
    uniform float isPerspectiveCamera;
    uniform mat4 previousViewMatrix;
    uniform mat4 previousViewProjectionMatrix;
    uniform vec2 resolution;
    uniform float sharpenStrength;
    uniform float useHistory;

    varying vec2 vUv;

    ${sharedDepthFunctions}

    vec3 sampleNeighborhoodMin(sampler2D colorTexture, vec2 uv, vec2 texelSize) {
      vec3 center = texture2D(colorTexture, uv).rgb;
      vec3 left = texture2D(colorTexture, uv + vec2(-texelSize.x, 0.0)).rgb;
      vec3 right = texture2D(colorTexture, uv + vec2(texelSize.x, 0.0)).rgb;
      vec3 up = texture2D(colorTexture, uv + vec2(0.0, texelSize.y)).rgb;
      vec3 down = texture2D(colorTexture, uv + vec2(0.0, -texelSize.y)).rgb;
      return min(center, min(min(left, right), min(up, down)));
    }

    vec3 sampleNeighborhoodMax(sampler2D colorTexture, vec2 uv, vec2 texelSize) {
      vec3 center = texture2D(colorTexture, uv).rgb;
      vec3 left = texture2D(colorTexture, uv + vec2(-texelSize.x, 0.0)).rgb;
      vec3 right = texture2D(colorTexture, uv + vec2(texelSize.x, 0.0)).rgb;
      vec3 up = texture2D(colorTexture, uv + vec2(0.0, texelSize.y)).rgb;
      vec3 down = texture2D(colorTexture, uv + vec2(0.0, -texelSize.y)).rgb;
      return max(center, max(max(left, right), max(up, down)));
    }

    vec3 applyMildSharpen(vec2 texelSize, vec3 centerColor) {
      vec3 left = texture2D(tDiffuse, vUv + vec2(-texelSize.x, 0.0)).rgb;
      vec3 right = texture2D(tDiffuse, vUv + vec2(texelSize.x, 0.0)).rgb;
      vec3 up = texture2D(tDiffuse, vUv + vec2(0.0, texelSize.y)).rgb;
      vec3 down = texture2D(tDiffuse, vUv + vec2(0.0, -texelSize.y)).rgb;
      vec3 laplacian = centerColor * 4.0 - (left + right + up + down);
      return max(centerColor + laplacian * sharpenStrength, vec3(0.0));
    }

    void main() {
      vec4 currentSample = texture2D(tDiffuse, vUv);
      float currentDistance = getViewDistance(tDepth, vUv, isPerspectiveCamera, cameraNear, cameraFar);
      vec2 texelSize = 1.0 / resolution;
      vec3 currentColor = applyMildSharpen(texelSize, currentSample.rgb);

      if (useHistory < 0.5 || currentDistance <= 0.0 || currentDistance >= cameraFar) {
        gl_FragColor = vec4(currentColor, currentSample.a);
        return;
      }

      vec3 viewPosition = getViewPosition(tDepth, vUv, currentProjectionMatrixInverse, isPerspectiveCamera, cameraNear, cameraFar);
      vec4 worldPosition = currentInverseViewMatrix * vec4(viewPosition, 1.0);
      vec4 previousClip = previousViewProjectionMatrix * worldPosition;
      float previousInvW = 1.0 / max(abs(previousClip.w), 0.0001);
      vec2 previousUv = previousClip.xy * previousInvW * 0.5 + 0.5;

      if (previousUv.x <= 0.0 || previousUv.x >= 1.0 || previousUv.y <= 0.0 || previousUv.y >= 1.0) {
        gl_FragColor = vec4(currentColor, currentSample.a);
        return;
      }

      vec4 historySample = texture2D(tHistory, previousUv);
      vec3 neighborhoodMin = sampleNeighborhoodMin(tDiffuse, vUv, texelSize) - vec3(0.03);
      vec3 neighborhoodMax = sampleNeighborhoodMax(tDiffuse, vUv, texelSize) + vec3(0.03);
      vec3 clampedHistory = clamp(historySample.rgb, neighborhoodMin, neighborhoodMax);

      float motion = length(previousUv - vUv);
      float motionConfidence = 1.0 - smoothstep(0.0015, 0.03, motion);
      float blendWeight = historyWeight * motionConfidence;

      vec3 resolved = mix(currentColor, clampedHistory, clamp(blendWeight, 0.0, 0.94));
      gl_FragColor = vec4(resolved, currentSample.a);
    }
  `,
};

const CopyHistoryShader = {
  name: 'TemporalResolveCopyHistoryShader',
  uniforms: {
    tDiffuse: { value: null },
  },
  vertexShader,
  fragmentShader: `
    uniform sampler2D tDiffuse;

    varying vec2 vUv;

    void main() {
      gl_FragColor = texture2D(tDiffuse, vUv);
    }
  `,
};

export class TemporalResolvePass extends Pass {
  private _copyMaterial: ShaderMaterial;
  private _copyQuad: FullScreenQuad;
  private _currentViewProjectionMatrix = new Matrix4();
  private _historyReadTarget: WebGLRenderTarget;
  private _historyValid = false;
  private _historyWriteTarget: WebGLRenderTarget;
  private _isPerspectiveCamera = true;
  private _previousViewMatrix = new Matrix4();
  private _previousViewProjectionMatrix = new Matrix4();
  private _resolveMaterial: ShaderMaterial;
  private _resolveQuad: FullScreenQuad;

  public constructor() {
    super();

    this._resolveMaterial = new ShaderMaterial({
      name: TemporalResolveShader.name,
      uniforms: UniformsUtils.clone(TemporalResolveShader.uniforms),
      vertexShader: TemporalResolveShader.vertexShader,
      fragmentShader: TemporalResolveShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this._copyMaterial = new ShaderMaterial({
      name: CopyHistoryShader.name,
      uniforms: UniformsUtils.clone(CopyHistoryShader.uniforms),
      vertexShader: CopyHistoryShader.vertexShader,
      fragmentShader: CopyHistoryShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });

    this._resolveQuad = new FullScreenQuad(this._resolveMaterial);
    this._copyQuad = new FullScreenQuad(this._copyMaterial);
    this._historyReadTarget = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType,
      magFilter: LinearFilter,
      minFilter: LinearFilter,
    });
    this._historyWriteTarget = this._historyReadTarget.clone();
  }

  public markHistoryInvalid(): void {
    this._historyValid = false;
  }

  public setCamera(camera: TemporalResolveCamera): void {
    this._isPerspectiveCamera = camera.isPerspectiveCamera ?? false;
    this._resolveMaterial.uniforms.cameraNear.value = camera.near;
    this._resolveMaterial.uniforms.cameraFar.value = camera.far;
    this._resolveMaterial.uniforms.isPerspectiveCamera.value = this._isPerspectiveCamera ? 1.0 : 0.0;
    this._resolveMaterial.uniforms.currentInverseViewMatrix.value.copy(camera.matrixWorld);
    this._resolveMaterial.uniforms.currentProjectionMatrixInverse.value.copy(camera.projectionMatrixInverse);
    this._currentViewProjectionMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  }

  public setHistoryWeight(historyWeight: number): void {
    this._resolveMaterial.uniforms.historyWeight.value = historyWeight;
  }

  public setSharpenStrength(sharpenStrength: number): void {
    this._resolveMaterial.uniforms.sharpenStrength.value = sharpenStrength;
  }

  public override setSize(width: number, height: number): void {
    this._historyReadTarget.setSize(width, height);
    this._historyWriteTarget.setSize(width, height);
    this._resolveMaterial.uniforms.resolution.value.set(width, height);
    this.markHistoryInvalid();
  }

  public override render(
    renderer: WebGLRenderer,
    writeBuffer: WebGLRenderTarget,
    readBuffer: WebGLRenderTarget,
  ): void {
    const depthTexture = readBuffer.depthTexture as DepthTexture | null;
    if (!depthTexture) {
      this._copyMaterial.uniforms.tDiffuse.value = readBuffer.texture;
      renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
      if (this.clear) {
        renderer.clear(renderer.autoClearColor, false, renderer.autoClearStencil);
      }
      this._copyQuad.render(renderer);
      this.markHistoryInvalid();
      return;
    }

    this._resolveMaterial.uniforms.tDiffuse.value = readBuffer.texture;
    this._resolveMaterial.uniforms.tDepth.value = depthTexture;
    this._resolveMaterial.uniforms.tHistory.value = this._historyReadTarget.texture;
    this._resolveMaterial.uniforms.previousViewMatrix.value.copy(this._previousViewMatrix);
    this._resolveMaterial.uniforms.previousViewProjectionMatrix.value.copy(this._previousViewProjectionMatrix);
    this._resolveMaterial.uniforms.useHistory.value = this._historyValid ? 1.0 : 0.0;

    const target = this.renderToScreen ? null : writeBuffer;
    renderer.setRenderTarget(target);
    if (this.clear) {
      renderer.clear(renderer.autoClearColor, false, renderer.autoClearStencil);
    }
    this._resolveQuad.render(renderer);

    if (target !== null) {
      this._copyMaterial.uniforms.tDiffuse.value = target.texture;
      renderer.setRenderTarget(this._historyWriteTarget);
      renderer.clear();
      this._copyQuad.render(renderer);

      const previousReadTarget = this._historyReadTarget;
      this._historyReadTarget = this._historyWriteTarget;
      this._historyWriteTarget = previousReadTarget;
      this._historyValid = true;
    } else {
      this._historyValid = false;
    }

    this._previousViewProjectionMatrix.copy(this._currentViewProjectionMatrix);
    this._previousViewMatrix.copy((this._resolveMaterial.uniforms.currentInverseViewMatrix.value as Matrix4)).invert();
  }

  public override dispose(): void {
    this._historyReadTarget.dispose();
    this._historyWriteTarget.dispose();
    this._resolveMaterial.dispose();
    this._copyMaterial.dispose();
    this._resolveQuad.dispose();
    this._copyQuad.dispose();
  }
}
