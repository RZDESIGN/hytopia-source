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

type ContactShadowCamera = {
  far: number;
  near: number;
  projectionMatrixInverse: Matrix4;
  isPerspectiveCamera?: boolean;
};

const CONTACT_SHADOW_RESOLUTION_SCALE = 0.25;

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
    return viewPosition.xyz / max(viewPosition.w, 0.0001);
  }

  vec3 getViewNormal(sampler2D depthTexture, vec2 uv, vec2 texelSize, mat4 projectionMatrixInverse, float isPerspectiveCamera, float cameraNear, float cameraFar) {
    vec3 center = getViewPosition(depthTexture, uv, projectionMatrixInverse, isPerspectiveCamera, cameraNear, cameraFar);
    vec3 right = getViewPosition(depthTexture, uv + vec2(texelSize.x, 0.0), projectionMatrixInverse, isPerspectiveCamera, cameraNear, cameraFar);
    vec3 up = getViewPosition(depthTexture, uv + vec2(0.0, texelSize.y), projectionMatrixInverse, isPerspectiveCamera, cameraNear, cameraFar);
    vec3 normal = normalize(cross(up - center, right - center));
    return faceforward(normal, vec3(0.0, 0.0, 1.0), normal);
  }

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
`;

const ContactShadowShader = {
  name: 'NearContactShadowsQuarterResShader',
  uniforms: {
    tDepth: { value: null },
    sourceResolution: { value: new Vector2(1, 1) },
    cameraNear: { value: 0.1 },
    cameraFar: { value: 1000 },
    projectionMatrixInverse: { value: new Matrix4() },
    isPerspectiveCamera: { value: 1.0 },
    intensity: { value: 0.52 },
    maxDistance: { value: 22.0 },
    worldRadius: { value: 1.6 },
    sampleRadiusNearPx: { value: 16.0 },
    sampleRadiusFarPx: { value: 7.5 },
    normalBias: { value: 0.04 },
    depthBias: { value: 0.03 },
  },
  vertexShader,
  fragmentShader: `
    uniform sampler2D tDepth;
    uniform vec2 sourceResolution;
    uniform float cameraNear;
    uniform float cameraFar;
    uniform mat4 projectionMatrixInverse;
    uniform float isPerspectiveCamera;
    uniform float intensity;
    uniform float maxDistance;
    uniform float worldRadius;
    uniform float sampleRadiusNearPx;
    uniform float sampleRadiusFarPx;
    uniform float normalBias;
    uniform float depthBias;

    varying vec2 vUv;

    ${sharedDepthFunctions}

    void main() {
      float centerDistance = getViewDistance(tDepth, vUv, isPerspectiveCamera, cameraNear, cameraFar);
      if (centerDistance <= 0.0 || centerDistance >= maxDistance) {
        gl_FragColor = vec4(1.0);
        return;
      }

      vec2 texelSize = 1.0 / sourceResolution;
      vec3 centerPos = getViewPosition(tDepth, vUv, projectionMatrixInverse, isPerspectiveCamera, cameraNear, cameraFar);
      vec3 centerNormal = getViewNormal(tDepth, vUv, texelSize, projectionMatrixInverse, isPerspectiveCamera, cameraNear, cameraFar);
      float distanceAlpha = 1.0 - smoothstep(maxDistance * 0.55, maxDistance, centerDistance);

      float radiusPx = mix(sampleRadiusNearPx, sampleRadiusFarPx, smoothstep(2.0, maxDistance, centerDistance));
      float seed = hash12(gl_FragCoord.xy);
      float rotation = seed * 6.28318530718;

      float occlusion = 0.0;
      float weightSum = 0.0;

      for (int ring = 0; ring < 2; ring++) {
        float ringFactor = float(ring + 1) * 0.5;

        for (int dirIndex = 0; dirIndex < 4; dirIndex++) {
          float angle = rotation + float(dirIndex) * 1.57079632679;
          vec2 dir = vec2(cos(angle), sin(angle));
          vec2 sampleUv = clamp(vUv + dir * radiusPx * ringFactor / sourceResolution, 0.0, 1.0);
          vec3 samplePos = getViewPosition(tDepth, sampleUv, projectionMatrixInverse, isPerspectiveCamera, cameraNear, cameraFar);
          vec3 delta = samplePos - centerPos;
          float deltaLength = length(delta);

          if (deltaLength <= 0.0001 || deltaLength >= worldRadius) {
            continue;
          }

          float horizon = max(0.0, dot(centerNormal, normalize(delta)) - normalBias);
          float frontness = smoothstep(-depthBias, depthBias * 2.0, samplePos.z - centerPos.z);
          float distanceWeight = 1.0 - smoothstep(0.0, worldRadius, deltaLength);
          float weight = distanceWeight;

          occlusion += horizon * frontness * weight;
          weightSum += weight;
        }
      }

      float ao = 1.0;
      if (weightSum > 0.0) {
        ao = 1.0 - min(1.0, (occlusion / weightSum) * intensity) * distanceAlpha;
      }

      gl_FragColor = vec4(vec3(ao), 1.0);
    }
  `,
};

const CompositeShader = {
  name: 'NearContactShadowsCompositeShader',
  uniforms: {
    tDiffuse: { value: null },
    tAo: { value: null },
    strength: { value: 1.0 },
  },
  vertexShader,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform sampler2D tAo;
    uniform float strength;

    varying vec2 vUv;

    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      float ao = texture2D(tAo, vUv).r;
      float shadedAo = mix(1.0, ao, strength);
      gl_FragColor = vec4(base.rgb * shadedAo, base.a);
    }
  `,
};

export class NearContactShadowsPass extends Pass {
  private _contactMaterial: ShaderMaterial;
  private _compositeMaterial: ShaderMaterial;
  private _contactQuad: FullScreenQuad;
  private _compositeQuad: FullScreenQuad;
  private _quarterResTarget: WebGLRenderTarget;

  public constructor() {
    super();

    this._contactMaterial = new ShaderMaterial({
      name: ContactShadowShader.name,
      uniforms: UniformsUtils.clone(ContactShadowShader.uniforms),
      vertexShader: ContactShadowShader.vertexShader,
      fragmentShader: ContactShadowShader.fragmentShader,
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

    this._contactQuad = new FullScreenQuad(this._contactMaterial);
    this._compositeQuad = new FullScreenQuad(this._compositeMaterial);
    this._quarterResTarget = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType,
      magFilter: LinearFilter,
      minFilter: LinearFilter,
    });
    this._quarterResTarget.texture.generateMipmaps = false;
  }

  public override setSize(width: number, height: number): void {
    const quarterWidth = Math.max(1, Math.round(width * CONTACT_SHADOW_RESOLUTION_SCALE));
    const quarterHeight = Math.max(1, Math.round(height * CONTACT_SHADOW_RESOLUTION_SCALE));
    this._quarterResTarget.setSize(quarterWidth, quarterHeight);
    this._contactMaterial.uniforms.sourceResolution.value.set(width, height);
  }

  public setCamera(camera: ContactShadowCamera): void {
    this._contactMaterial.uniforms.cameraNear.value = camera.near;
    this._contactMaterial.uniforms.cameraFar.value = camera.far;
    this._contactMaterial.uniforms.isPerspectiveCamera.value = camera.isPerspectiveCamera ? 1.0 : 0.0;
    this._contactMaterial.uniforms.projectionMatrixInverse.value.copy(camera.projectionMatrixInverse);
  }

  public setStrength(strength: number): void {
    this._contactMaterial.uniforms.intensity.value = strength;
    this._compositeMaterial.uniforms.strength.value = 1.0;
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

    this._contactMaterial.uniforms.tDepth.value = depthTexture;
    renderer.setRenderTarget(this._quarterResTarget);
    renderer.clear();
    this._contactQuad.render(renderer);

    this._compositeMaterial.uniforms.tDiffuse.value = readBuffer.texture;
    this._compositeMaterial.uniforms.tAo.value = this._quarterResTarget.texture;

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
      this._compositeQuad.render(renderer);

      renderer.setRenderTarget(compositeTarget);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, savedDepthAttachment, 0);
      return;
    }

    renderer.setRenderTarget(compositeTarget);
    if (this.clear) {
      renderer.clear(renderer.autoClearColor, false, renderer.autoClearStencil);
    }
    this._compositeQuad.render(renderer);
  }

  public override dispose(): void {
    this._quarterResTarget.dispose();
    this._contactMaterial.dispose();
    this._compositeMaterial.dispose();
    this._contactQuad.dispose();
    this._compositeQuad.dispose();
  }
}
