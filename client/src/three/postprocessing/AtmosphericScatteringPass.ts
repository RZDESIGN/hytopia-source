import {
  Color,
  DepthTexture,
  Matrix4,
  ShaderMaterial,
  UniformsUtils,
  Vector2,
  Vector3,
  type WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';

type AtmosphericCamera = {
  far: number;
  near: number;
  projectionMatrixInverse: Matrix4;
  matrixWorld: Matrix4;
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

  vec3 getWorldNormal(sampler2D depthTexture, vec2 uv, vec2 texelSize, mat4 projectionMatrixInverse, mat4 inverseViewMatrix, float isPerspectiveCamera, float cameraNear, float cameraFar) {
    vec3 center = getViewPosition(depthTexture, uv, projectionMatrixInverse, isPerspectiveCamera, cameraNear, cameraFar);
    vec3 right = getViewPosition(depthTexture, uv + vec2(texelSize.x, 0.0), projectionMatrixInverse, isPerspectiveCamera, cameraNear, cameraFar);
    vec3 up = getViewPosition(depthTexture, uv + vec2(0.0, texelSize.y), projectionMatrixInverse, isPerspectiveCamera, cameraNear, cameraFar);
    vec3 centerWorld = (inverseViewMatrix * vec4(center, 1.0)).xyz;
    vec3 rightWorld = (inverseViewMatrix * vec4(right, 1.0)).xyz;
    vec3 upWorld = (inverseViewMatrix * vec4(up, 1.0)).xyz;
    vec3 normal = normalize(cross(upWorld - centerWorld, rightWorld - centerWorld));
    return faceforward(normal, vec3(0.0, 1.0, 0.0), normal);
  }

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);

    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));

    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  float fbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 4; i++) {
      value += noise(p) * amplitude;
      p = p * 2.02 + vec2(7.13, -3.71);
      amplitude *= 0.5;
    }
    return value;
  }
`;

const AtmosphericShader = {
  name: 'AtmosphericScatteringShader',
  uniforms: {
    tDepth: { value: null },
    tDiffuse: { value: null },
    cameraFar: { value: 1000 },
    cameraNear: { value: 0.1 },
    cameraPositionWorld: { value: new Vector3() },
    cloudCoverage: { value: 0.28 },
    cloudOpacity: { value: 0.64 },
    cloudScale: { value: 0.38 },
    cloudShadowStrength: { value: 0.12 },
    cloudSpeed: { value: 0.018 },
    fogColor: { value: new Color(0.8, 0.9, 1.0) },
    heightFogDensity: { value: 0.018 },
    heightFogHeightFalloff: { value: 0.065 },
    inverseViewMatrix: { value: new Matrix4() },
    isPerspectiveCamera: { value: 1.0 },
    projectionMatrixInverse: { value: new Matrix4() },
    resolution: { value: new Vector2(1, 1) },
    storminess: { value: 0.0 },
    sunColor: { value: new Color(1, 1, 1) },
    sunDirection: { value: new Vector3(0.3, -1, 0.2).normalize() },
    sunInscatterStrength: { value: 0.24 },
    sunIntensity: { value: 1.0 },
    time: { value: 0.0 },
    windDirection: { value: new Vector2(1, 0.16) },
    worldSeed: { value: 1.0 },
  },
  vertexShader,
  fragmentShader: `
    uniform sampler2D tDepth;
    uniform sampler2D tDiffuse;
    uniform float cameraFar;
    uniform float cameraNear;
    uniform vec3 cameraPositionWorld;
    uniform float cloudCoverage;
    uniform float cloudOpacity;
    uniform float cloudScale;
    uniform float cloudShadowStrength;
    uniform float cloudSpeed;
    uniform vec3 fogColor;
    uniform float heightFogDensity;
    uniform float heightFogHeightFalloff;
    uniform mat4 inverseViewMatrix;
    uniform float isPerspectiveCamera;
    uniform mat4 projectionMatrixInverse;
    uniform vec2 resolution;
    uniform float storminess;
    uniform vec3 sunColor;
    uniform vec3 sunDirection;
    uniform float sunInscatterStrength;
    uniform float sunIntensity;
    uniform float time;
    uniform vec2 windDirection;
    uniform float worldSeed;

    varying vec2 vUv;

    ${sharedDepthFunctions}

    float cloudShadowAt(vec3 worldPosition, vec3 surfaceNormal) {
      vec3 sunViewDirection = normalize(-sunDirection);
      if (sunViewDirection.y <= 0.02) {
        return 0.0;
      }

      vec2 windDir = normalize(windDirection);
      vec2 projected = worldPosition.xz - sunViewDirection.xz * (max(worldPosition.y, 0.0) / sunViewDirection.y);
      vec2 cloudUv = projected * cloudScale * 0.018 + windDir * time * cloudSpeed * 24.0;
      cloudUv += vec2(worldSeed * 0.13, worldSeed * 0.21);

      float density = fbm(cloudUv * 0.9) * 0.55
        + fbm(cloudUv * 1.7 + vec2(1.7, -2.4)) * 0.28
        + noise(cloudUv * 5.2 + vec2(-4.2, 3.1)) * 0.17;
      float threshold = mix(0.68, 0.20, cloudCoverage);
      float cloudMask = smoothstep(threshold, min(threshold + 0.16, 0.98), density) * cloudOpacity;
      float normalFactor = smoothstep(0.18, 0.65, surfaceNormal.y);
      return cloudMask * normalFactor * (1.0 - storminess * 0.2);
    }

    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      float viewDistance = getViewDistance(tDepth, vUv, isPerspectiveCamera, cameraNear, cameraFar);
      if (viewDistance <= 0.0 || viewDistance >= cameraFar) {
        gl_FragColor = base;
        return;
      }

      vec2 texelSize = 1.0 / resolution;
      vec3 viewPosition = getViewPosition(tDepth, vUv, projectionMatrixInverse, isPerspectiveCamera, cameraNear, cameraFar);
      vec3 worldPosition = (inverseViewMatrix * vec4(viewPosition, 1.0)).xyz;
      vec3 surfaceNormal = getWorldNormal(tDepth, vUv, texelSize, projectionMatrixInverse, inverseViewMatrix, isPerspectiveCamera, cameraNear, cameraFar);
      vec3 viewDirWorld = normalize(worldPosition - cameraPositionWorld);
      vec3 sunViewDirection = normalize(-sunDirection);

      float lowAltitude = smoothstep(18.0, -10.0, worldPosition.y - cameraPositionWorld.y);
      float heightDensity = exp(-max(worldPosition.y - cameraPositionWorld.y + 6.0, 0.0) * heightFogHeightFalloff);
      float fogAmount = 1.0 - exp(-viewDistance * heightFogDensity * mix(0.75, 1.85, lowAltitude) * heightDensity);
      fogAmount = clamp(fogAmount, 0.0, 0.82);

      float forwardScatter = pow(max(dot(viewDirWorld, sunViewDirection), 0.0), 8.0);
      float sunScatter = forwardScatter * fogAmount * sunInscatterStrength * (0.18 + sunIntensity * 0.1);

      float cloudShadow = cloudShadowAt(worldPosition, surfaceNormal);
      vec3 shaded = base.rgb * (1.0 - cloudShadow * cloudShadowStrength);
      vec3 fogged = mix(shaded, fogColor, fogAmount);
      fogged += sunColor * sunScatter;

      gl_FragColor = vec4(fogged, base.a);
    }
  `,
};

export class AtmosphericScatteringPass extends Pass {
  private _material: ShaderMaterial;
  private _quad: FullScreenQuad;

  public constructor() {
    super();

    this._material = new ShaderMaterial({
      name: AtmosphericShader.name,
      uniforms: UniformsUtils.clone(AtmosphericShader.uniforms),
      vertexShader: AtmosphericShader.vertexShader,
      fragmentShader: AtmosphericShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this._quad = new FullScreenQuad(this._material);
  }

  public setAtmosphere(options: {
    cloudCoverage: number;
    cloudOpacity: number;
    cloudScale: number;
    cloudShadowStrength: number;
    cloudSpeed: number;
    fogColor: Color;
    heightFogDensity: number;
    heightFogHeightFalloff: number;
    sunColor: Color;
    sunDirection: Vector3;
    sunInscatterStrength: number;
    sunIntensity: number;
    time: number;
    windDirection: Vector2;
    worldSeed: number;
  }): void {
    this._material.uniforms.cloudCoverage.value = options.cloudCoverage;
    this._material.uniforms.cloudOpacity.value = options.cloudOpacity;
    this._material.uniforms.cloudScale.value = options.cloudScale;
    this._material.uniforms.cloudShadowStrength.value = options.cloudShadowStrength;
    this._material.uniforms.cloudSpeed.value = options.cloudSpeed;
    this._material.uniforms.fogColor.value.copy(options.fogColor);
    this._material.uniforms.heightFogDensity.value = options.heightFogDensity;
    this._material.uniforms.heightFogHeightFalloff.value = options.heightFogHeightFalloff;
    this._material.uniforms.sunColor.value.copy(options.sunColor);
    this._material.uniforms.sunDirection.value.copy(options.sunDirection);
    this._material.uniforms.sunInscatterStrength.value = options.sunInscatterStrength;
    this._material.uniforms.sunIntensity.value = options.sunIntensity;
    this._material.uniforms.time.value = options.time;
    this._material.uniforms.windDirection.value.copy(options.windDirection);
    this._material.uniforms.worldSeed.value = options.worldSeed;
  }

  public setCamera(camera: AtmosphericCamera): void {
    this._material.uniforms.cameraNear.value = camera.near;
    this._material.uniforms.cameraFar.value = camera.far;
    this._material.uniforms.isPerspectiveCamera.value = camera.isPerspectiveCamera ? 1.0 : 0.0;
    this._material.uniforms.projectionMatrixInverse.value.copy(camera.projectionMatrixInverse);
    this._material.uniforms.inverseViewMatrix.value.copy(camera.matrixWorld);
    this._material.uniforms.cameraPositionWorld.value.setFromMatrixPosition(camera.matrixWorld);
  }

  public override setSize(width: number, height: number): void {
    this._material.uniforms.resolution.value.set(width, height);
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

    this._material.uniforms.tDiffuse.value = readBuffer.texture;
    this._material.uniforms.tDepth.value = depthTexture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) {
      renderer.clear(renderer.autoClearColor, false, renderer.autoClearStencil);
    }
    this._quad.render(renderer);
  }

  public override dispose(): void {
    this._material.dispose();
    this._quad.dispose();
  }
}
