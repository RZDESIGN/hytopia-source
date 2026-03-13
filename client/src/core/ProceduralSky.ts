import {
  BackSide,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  NormalBlending,
  PlaneGeometry,
  Quaternion,
  ShaderLib,
  ShaderMaterial,
  Vector2,
  Vector3,
} from 'three';

export const PROCEDURAL_SKYBOX_URI_PREFIX = 'skyboxes/procedural';

export type ProceduralSkyPreset = 'clear' | 'cloudy' | 'overcast' | 'storm';
export type ProceduralSkyPrecipitation = 'none' | 'rain';

export type ProceduralSkySettings = {
  cloudCoverage: number;
  cloudOpacity: number;
  cloudScale: number;
  cloudSpeed: number;
  precipitation: ProceduralSkyPrecipitation;
  precipitationIntensity: number;
  preset: ProceduralSkyPreset;
  storminess: number;
  windDirection: Vector2;
};

const UNIFORM_AMBIENT_COLOR = 'ambientColor';
const UNIFORM_CLOUD_COVERAGE = 'cloudCoverage';
const UNIFORM_CLOUD_OPACITY = 'cloudOpacity';
const UNIFORM_CLOUD_SCALE = 'cloudScale';
const UNIFORM_CLOUD_SPEED = 'cloudSpeed';
const UNIFORM_FOG_COLOR = 'fogColor';
const UNIFORM_LIGHTNING = 'lightning';
const UNIFORM_SKY_INTENSITY = 'skyIntensity';
const UNIFORM_STORMINESS = 'storminess';
const UNIFORM_SUN_COLOR = 'sunColor';
const UNIFORM_SUN_DIRECTION = 'sunDirection';
const UNIFORM_TIME = 'time';
const UNIFORM_WIND_DIRECTION = 'windDirection';
const UNIFORM_WORLD_SEED = 'worldSeed';

const UNIFORM_DAY_AMOUNT = 'dayAmount';
const UNIFORM_HALO_AMOUNT = 'haloAmount';
const UNIFORM_SUN_INTENSITY = 'sunIntensity';

const PROCEDURAL_SKY_PRESET_DEFAULTS: Record<ProceduralSkyPreset, Omit<ProceduralSkySettings, 'preset'>> = {
  clear: {
    cloudCoverage: 0.2,
    cloudOpacity: 0.26,
    cloudScale: 0.19,
    cloudSpeed: 0.018,
    precipitation: 'none',
    precipitationIntensity: 0,
    storminess: 0,
    windDirection: new Vector2(1, 0.16),
  },
  cloudy: {
    cloudCoverage: 0.48,
    cloudOpacity: 0.38,
    cloudScale: 0.21,
    cloudSpeed: 0.022,
    precipitation: 'none',
    precipitationIntensity: 0,
    storminess: 0.18,
    windDirection: new Vector2(1, 0.2),
  },
  overcast: {
    cloudCoverage: 0.76,
    cloudOpacity: 0.54,
    cloudScale: 0.225,
    cloudSpeed: 0.02,
    precipitation: 'none',
    precipitationIntensity: 0,
    storminess: 0.5,
    windDirection: new Vector2(1, 0.24),
  },
  storm: {
    cloudCoverage: 0.92,
    cloudOpacity: 0.68,
    cloudScale: 0.24,
    cloudSpeed: 0.028,
    precipitation: 'rain',
    precipitationIntensity: 1,
    storminess: 0.88,
    windDirection: new Vector2(1, 0.3),
  },
};

const precipitationMatrix = new Matrix4();
const precipitationPosition = new Vector3();
const precipitationQuaternion = new Quaternion();
const precipitationScale = new Vector3();
const precipitationLightningColor = new Color(0xf6fbff);
const precipitationGridAnchor = new Vector2();
const STORM_LIGHTNING_BUCKET_S = 4;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function wrapCentered(value: number, span: number): number {
  return ((((value % span) + span) % span) - span * 0.5);
}

function parseNumberParam(params: URLSearchParams, key: string): number | null {
  const rawValue = params.get(key);

  if (rawValue == null || rawValue.trim() === '') {
    return null;
  }

  const value = Number(rawValue);
  return Number.isFinite(value) ? value : null;
}

function hashScalar(value: number): number {
  const result = Math.sin(value * 12.9898 + 78.233) * 43758.5453123;
  return result - Math.floor(result);
}

function pulse01(phaseS: number, attackS: number, decayS: number): number {
  if (phaseS <= 0) {
    return 0;
  }

  if (phaseS <= attackS) {
    return attackS <= 0 ? 1 : clamp01(phaseS / attackS);
  }

  return decayS <= 0 ? 0 : 1 - clamp01((phaseS - attackS) / decayS);
}

export function getStormLightningIntensity(timeS: number, worldSeed: number, storminess: number): number {
  if (storminess < 0.62) {
    return 0;
  }

  const bucketIndex = Math.floor(timeS / STORM_LIGHTNING_BUCKET_S);
  const bucketSeed = worldSeed * 17.131 + bucketIndex * 23.417;
  const strikeChance = clamp01((storminess - 0.58) * 1.15);
  if (hashScalar(bucketSeed + 0.19) > strikeChance) {
    return 0;
  }

  const bucketPhase = timeS - bucketIndex * STORM_LIGHTNING_BUCKET_S;
  const primaryStart = 0.08 + hashScalar(bucketSeed + 1.13) * 0.2;
  const primaryAttack = 0.018 + hashScalar(bucketSeed + 2.71) * 0.014;
  const primaryDecay = 0.11 + hashScalar(bucketSeed + 4.07) * 0.08;
  const primaryAmplitude = 0.72 + hashScalar(bucketSeed + 5.61) * 0.28;
  let intensity = pulse01(bucketPhase - primaryStart, primaryAttack, primaryDecay) * primaryAmplitude;

  const secondaryChance = 0.35 + storminess * 0.35;
  if (hashScalar(bucketSeed + 6.89) < secondaryChance) {
    const secondaryStart = primaryStart + 0.09 + hashScalar(bucketSeed + 8.47) * 0.17;
    const secondaryAttack = 0.012 + hashScalar(bucketSeed + 9.91) * 0.012;
    const secondaryDecay = 0.05 + hashScalar(bucketSeed + 11.27) * 0.08;
    const secondaryAmplitude = 0.22 + hashScalar(bucketSeed + 12.53) * 0.45;
    intensity += pulse01(bucketPhase - secondaryStart, secondaryAttack, secondaryDecay) * secondaryAmplitude;
  }

  return clamp01(intensity);
}

function isProceduralSkyPreset(value: string | null): value is ProceduralSkyPreset {
  return value === 'clear' || value === 'cloudy' || value === 'overcast' || value === 'storm';
}

function isProceduralSkyPrecipitation(value: string | null): value is ProceduralSkyPrecipitation {
  return value === 'none' || value === 'rain';
}

export function parseProceduralSkySettings(skyboxUri: string): ProceduralSkySettings | null {
  if (!skyboxUri.startsWith(PROCEDURAL_SKYBOX_URI_PREFIX)) {
    return null;
  }

  const queryIndex = skyboxUri.indexOf('?');
  const baseUri = queryIndex >= 0 ? skyboxUri.slice(0, queryIndex) : skyboxUri;
  const params = new URLSearchParams(queryIndex >= 0 ? skyboxUri.slice(queryIndex + 1) : '');
  const suffix = baseUri.slice(PROCEDURAL_SKYBOX_URI_PREFIX.length).replace(/^\/+/, '');
  const preset = isProceduralSkyPreset(params.get('weather'))
    ? (params.get('weather') as ProceduralSkyPreset)
    : isProceduralSkyPreset(params.get('preset'))
      ? (params.get('preset') as ProceduralSkyPreset)
      : isProceduralSkyPreset(suffix)
        ? suffix
        : 'clear';

  const defaults = PROCEDURAL_SKY_PRESET_DEFAULTS[preset];
  const windDirection = defaults.windDirection.clone();
  const windX = parseNumberParam(params, 'windX');
  const windY = parseNumberParam(params, 'windY');
  if (windX !== null || windY !== null) {
    windDirection.set(windX ?? windDirection.x, windY ?? windDirection.y);
    if (windDirection.lengthSq() < 0.0001) {
      windDirection.copy(defaults.windDirection);
    }
  }

  return {
    preset,
    cloudCoverage: clamp01(parseNumberParam(params, 'clouds') ?? defaults.cloudCoverage),
    cloudOpacity: clamp01(parseNumberParam(params, 'opacity') ?? defaults.cloudOpacity),
    cloudScale: Math.max(0.08, parseNumberParam(params, 'scale') ?? defaults.cloudScale),
    cloudSpeed: Math.max(0, parseNumberParam(params, 'speed') ?? defaults.cloudSpeed),
    precipitation: isProceduralSkyPrecipitation(params.get('precip')) ? params.get('precip') as ProceduralSkyPrecipitation : defaults.precipitation,
    precipitationIntensity: clamp01(parseNumberParam(params, 'precipIntensity') ?? defaults.precipitationIntensity),
    storminess: clamp01(parseNumberParam(params, 'storm') ?? defaults.storminess),
    windDirection,
  };
}

export class ProceduralSkyMaterial extends ShaderMaterial {
  constructor(settings: ProceduralSkySettings) {
    super({
      uniforms: {
        [UNIFORM_AMBIENT_COLOR]: { value: new Color(0.8, 0.9, 1.0) },
        [UNIFORM_CLOUD_COVERAGE]: { value: settings.cloudCoverage },
        [UNIFORM_CLOUD_OPACITY]: { value: settings.cloudOpacity },
        [UNIFORM_CLOUD_SCALE]: { value: settings.cloudScale },
        [UNIFORM_CLOUD_SPEED]: { value: settings.cloudSpeed },
        [UNIFORM_FOG_COLOR]: { value: new Color(0.8, 0.88, 1.0) },
        [UNIFORM_LIGHTNING]: { value: 0 },
        [UNIFORM_SKY_INTENSITY]: { value: 1 },
        [UNIFORM_STORMINESS]: { value: settings.storminess },
        [UNIFORM_SUN_COLOR]: { value: new Color(1, 1, 1) },
        [UNIFORM_SUN_DIRECTION]: { value: new Vector3(0.3, -1, 0.2).normalize() },
        [UNIFORM_TIME]: { value: 0 },
        [UNIFORM_WIND_DIRECTION]: { value: settings.windDirection.clone() },
        [UNIFORM_WORLD_SEED]: { value: 1 },
      },
      vertexShader: ShaderLib.cube.vertexShader,
      fragmentShader: `
        uniform vec3 ${UNIFORM_AMBIENT_COLOR};
        uniform float ${UNIFORM_CLOUD_COVERAGE};
        uniform float ${UNIFORM_CLOUD_OPACITY};
        uniform float ${UNIFORM_CLOUD_SCALE};
        uniform float ${UNIFORM_CLOUD_SPEED};
        uniform vec3 ${UNIFORM_FOG_COLOR};
        uniform float ${UNIFORM_LIGHTNING};
        uniform float ${UNIFORM_SKY_INTENSITY};
        uniform float ${UNIFORM_STORMINESS};
        uniform vec3 ${UNIFORM_SUN_COLOR};
        uniform vec3 ${UNIFORM_SUN_DIRECTION};
        uniform float ${UNIFORM_TIME};
        uniform vec2 ${UNIFORM_WIND_DIRECTION};
        uniform float ${UNIFORM_WORLD_SEED};

        varying vec3 vWorldDirection;

        float saturate(float value) {
          return clamp(value, 0.0, 1.0);
        }

        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7)) + ${UNIFORM_WORLD_SEED} * 17.13) * 43758.5453123);
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
          float amplitude = 0.55;
          value += noise(p) * amplitude;
          p = p * 2.02 + vec2(8.7, -3.1);
          amplitude *= 0.5;
          value += noise(p) * amplitude;
          p = p * 2.03 + vec2(-4.2, 7.5);
          amplitude *= 0.5;
          value += noise(p) * amplitude;
          return value;
        }

        float cloudDensityAt(vec2 p) {
          vec2 macroUv = floor(p * 10.0) / 10.0;
          vec2 voxelUv = floor(p * 18.0) / 18.0;
          float largeShape = fbm(macroUv * 0.84 + vec2(${UNIFORM_WORLD_SEED} * 0.37, ${UNIFORM_WORLD_SEED} * 0.21));
          float mediumShape = fbm(voxelUv * 1.76 - vec2(${UNIFORM_WORLD_SEED} * 0.13, ${UNIFORM_WORLD_SEED} * 0.29));
          float detailShape = noise(voxelUv * 3.9 + vec2(4.0, -6.0));
          float microShape = noise(voxelUv * 7.2 + vec2(-9.0, 3.0));
          return largeShape * 0.5 + mediumShape * 0.28 + detailShape * 0.14 + microShape * 0.08;
        }

        void main() {
          vec3 direction = normalize(vWorldDirection);
          vec3 sunViewDirection = normalize(-${UNIFORM_SUN_DIRECTION});
          float dayAmount = smoothstep(-0.18, 0.06, sunViewDirection.y);
          float up = saturate(direction.y * 0.5 + 0.5);

          vec3 zenithNight = vec3(0.018, 0.032, 0.085);
          vec3 horizonNight = vec3(0.05, 0.068, 0.125);
          vec3 zenithDayBase = mix(vec3(0.22, 0.56, 1.0), vec3(0.13, 0.34, 0.8), ${UNIFORM_STORMINESS});
          vec3 horizonDayBase = mix(vec3(0.74, 0.89, 1.0), vec3(0.44, 0.6, 0.8), ${UNIFORM_STORMINESS});
          vec3 zenithDay = zenithDayBase * (0.94 + ${UNIFORM_SKY_INTENSITY} * 0.1) + ${UNIFORM_AMBIENT_COLOR} * 0.1 + ${UNIFORM_SUN_COLOR} * 0.022;
          vec3 horizonDay = mix(horizonDayBase, ${UNIFORM_FOG_COLOR}, 0.32) * (0.94 + ${UNIFORM_SKY_INTENSITY} * 0.055) + ${UNIFORM_SUN_COLOR} * 0.02;
          vec3 nadir = mix(vec3(0.01, 0.014, 0.028), ${UNIFORM_FOG_COLOR} * 0.24, dayAmount);

          vec3 zenith = mix(zenithNight, zenithDay, dayAmount);
          vec3 horizon = mix(horizonNight, horizonDay, dayAmount);

          vec3 sky = mix(horizon, zenith, smoothstep(0.04, 0.98, up));
          sky = mix(nadir, sky, smoothstep(-0.12, 0.04, direction.y));

          float sunsetWindow = 1.0 - smoothstep(0.04, 0.33, abs(sunViewDirection.y));
          float sunsetBand = exp(-abs(direction.y - max(sunViewDirection.y, -0.04)) * mix(9.0, 16.0, dayAmount));
          float facingSun = pow(saturate(dot(direction, sunViewDirection)), 4.2);
          vec3 sunsetTint = mix(vec3(1.0, 0.5, 0.3), ${UNIFORM_SUN_COLOR}, 0.38);
          sky += sunsetTint * sunsetBand * sunsetWindow * (0.1 + 0.18 * facingSun) * (1.0 - ${UNIFORM_STORMINESS} * 0.35);

          if (dayAmount < 0.5 && direction.y > 0.0) {
            vec2 starUv = direction.xz / max(direction.y + 0.26, 0.12);
            vec2 starCell = floor(starUv * 30.0) / 30.0;
            float starNoise = hash(starCell * 31.0 + vec2(13.7, 41.3));
            float starMask = step(0.9925, starNoise);
            float starBrightness = smoothstep(0.5, 0.08, dayAmount) * smoothstep(0.02, 0.28, direction.y) * (1.0 - ${UNIFORM_STORMINESS});
            sky += vec3(0.72, 0.84, 1.0) * starMask * starBrightness * (0.7 + 0.3 * hash(starCell * 53.0));
          }

          if (direction.y > -0.02) {
            vec2 windDirection = normalize(${UNIFORM_WIND_DIRECTION});
            vec2 cloudUv = direction.xz / max(direction.y + 0.24, 0.08);
            cloudUv = cloudUv * ${UNIFORM_CLOUD_SCALE} + windDirection * ${UNIFORM_TIME} * ${UNIFORM_CLOUD_SPEED};

            float cloudThreshold = mix(0.82, 0.36, ${UNIFORM_CLOUD_COVERAGE});
            float cloudBand = smoothstep(-0.02, 0.17, direction.y) * (1.0 - smoothstep(0.75, 0.98, direction.y));
            float density0 = cloudDensityAt(cloudUv);
            float density1 = cloudDensityAt(cloudUv * 1.05 + vec2(1.9, -2.6));
            float density2 = cloudDensityAt(cloudUv * 1.11 + vec2(-3.8, 4.7));
            float cloudMask0 = smoothstep(cloudThreshold, min(cloudThreshold + 0.095, 0.99), density0);
            float cloudMask1 = smoothstep(cloudThreshold + 0.026, min(cloudThreshold + 0.125, 0.99), density1);
            float cloudMask2 = smoothstep(cloudThreshold + 0.052, min(cloudThreshold + 0.15, 0.99), density2);
            float cloudAlpha0 = cloudMask0 * cloudBand * ${UNIFORM_CLOUD_OPACITY} * 0.62;
            float cloudAlpha1 = cloudMask1 * cloudBand * ${UNIFORM_CLOUD_OPACITY} * 0.28;
            float cloudAlpha2 = cloudMask2 * cloudBand * ${UNIFORM_CLOUD_OPACITY} * 0.15;
            float cloudAlpha = saturate(cloudAlpha0 + (1.0 - cloudAlpha0) * cloudAlpha1 + (1.0 - max(cloudAlpha0, cloudAlpha1)) * cloudAlpha2);
            float cloudVolume = saturate(cloudMask0 * 0.68 + cloudMask1 * 0.28 + cloudMask2 * 0.2);
            float undersideShadow = saturate(cloudMask0 * 0.7 - cloudMask1 * 0.4 + cloudMask2 * 0.18);
            float cloudEdgeHighlight = saturate((density0 - cloudThreshold) * 7.5) * (1.0 - cloudMask1 * 0.48);

            vec3 cloudDirection = normalize(vec3(direction.x, max(direction.y, 0.0) + 0.22, direction.z));
            float cloudLight = 0.38 + 0.62 * saturate(dot(cloudDirection, sunViewDirection));
            vec3 cloudBase = mix(vec3(0.28, 0.31, 0.38), vec3(0.96, 0.98, 1.0), dayAmount);
            vec3 cloudColor = mix(cloudBase * 0.52, cloudBase, cloudLight);
            cloudColor *= 0.82 + cloudVolume * 0.24;
            cloudColor *= 1.0 - undersideShadow * 0.22;
            cloudColor += vec3(1.0, 0.99, 0.98) * cloudEdgeHighlight * (0.08 + dayAmount * 0.08) * cloudLight;
            cloudColor = mix(cloudColor, cloudColor * 0.62, ${UNIFORM_STORMINESS});
            cloudColor += vec3(0.78, 0.84, 1.0) * ${UNIFORM_LIGHTNING} * (0.2 + cloudMask0 * 0.62);

            sky = mix(sky, cloudColor, cloudAlpha);
          }

          vec3 lightningColor = mix(vec3(0.68, 0.76, 1.0), vec3(0.92, 0.95, 1.0), dayAmount);
          sky += lightningColor * ${UNIFORM_LIGHTNING} * (0.38 + up * 0.5);

          gl_FragColor = vec4(max(sky * max(${UNIFORM_SKY_INTENSITY}, 0.02), vec3(0.0)), 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      side: BackSide,
      depthWrite: false,
      fog: false,
    });
  }

  public get ambientColor(): Color {
    return this.uniforms[UNIFORM_AMBIENT_COLOR].value;
  }

  public get fogColor(): Color {
    return this.uniforms[UNIFORM_FOG_COLOR].value;
  }

  public get sunColor(): Color {
    return this.uniforms[UNIFORM_SUN_COLOR].value;
  }

  public get sunDirection(): Vector3 {
    return this.uniforms[UNIFORM_SUN_DIRECTION].value;
  }

  public set cloudCoverage(value: number) {
    this.uniforms[UNIFORM_CLOUD_COVERAGE].value = clamp01(value);
  }

  public set cloudOpacity(value: number) {
    this.uniforms[UNIFORM_CLOUD_OPACITY].value = clamp01(value);
  }

  public set cloudScale(value: number) {
    this.uniforms[UNIFORM_CLOUD_SCALE].value = Math.max(0.08, value);
  }

  public set cloudSpeed(value: number) {
    this.uniforms[UNIFORM_CLOUD_SPEED].value = Math.max(0, value);
  }

  public set skyIntensity(value: number) {
    this.uniforms[UNIFORM_SKY_INTENSITY].value = value;
  }

  public set lightning(value: number) {
    this.uniforms[UNIFORM_LIGHTNING].value = clamp01(value);
  }

  public set storminess(value: number) {
    this.uniforms[UNIFORM_STORMINESS].value = clamp01(value);
  }

  public set time(value: number) {
    this.uniforms[UNIFORM_TIME].value = value;
  }

  public get windDirection(): Vector2 {
    return this.uniforms[UNIFORM_WIND_DIRECTION].value;
  }

  public set worldSeed(value: number) {
    this.uniforms[UNIFORM_WORLD_SEED].value = value;
  }
}

export class SquareSunMaterial extends ShaderMaterial {
  constructor() {
    super({
      uniforms: {
        [UNIFORM_DAY_AMOUNT]: { value: 1 },
        [UNIFORM_HALO_AMOUNT]: { value: 1 },
        [UNIFORM_SUN_COLOR]: { value: new Color(1, 1, 1) },
        [UNIFORM_SUN_INTENSITY]: { value: 1 },
      },
      vertexShader: `
        varying vec2 vUv;

        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float ${UNIFORM_DAY_AMOUNT};
        uniform float ${UNIFORM_HALO_AMOUNT};
        uniform vec3 ${UNIFORM_SUN_COLOR};
        uniform float ${UNIFORM_SUN_INTENSITY};

        varying vec2 vUv;

        float squareDistance(vec2 uv) {
          vec2 p = abs(uv * 2.0 - 1.0);
          return max(p.x, p.y);
        }

        void main() {
          float d = squareDistance(vUv);
          float core = 1.0 - smoothstep(0.11, 0.34, d);
          float glow = 1.0 - smoothstep(0.2, 0.8, d);
          glow = pow(glow, 2.6);
          float outerGlow = 1.0 - smoothstep(0.34, 1.0, d);
          outerGlow = pow(outerGlow, 4.8);
          float rim = 1.0 - smoothstep(0.28, 0.54, d);
          rim = pow(rim, 4.4);
          float halo = ${UNIFORM_HALO_AMOUNT};
          float alpha = (core * 0.98 + glow * 0.22 * halo + outerGlow * 0.08 * halo) * ${UNIFORM_DAY_AMOUNT};

          if (alpha <= 0.001) {
            discard;
          }

          float intensity = min(${UNIFORM_SUN_INTENSITY}, 2.6);
          vec3 glowColor = mix(${UNIFORM_SUN_COLOR}, vec3(1.0, 0.88, 0.68), 0.24);
          vec3 color = ${UNIFORM_SUN_COLOR} * (core * (0.92 + intensity * 0.05) + rim * 0.12)
            + glowColor * (glow * (0.18 + intensity * 0.018) * halo + outerGlow * 0.12 * halo);
          gl_FragColor = vec4(color, alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: NormalBlending,
    });
  }

  public set dayAmount(value: number) {
    this.uniforms[UNIFORM_DAY_AMOUNT].value = clamp01(value);
  }

  public get sunColor(): Color {
    return this.uniforms[UNIFORM_SUN_COLOR].value;
  }

  public set haloAmount(value: number) {
    this.uniforms[UNIFORM_HALO_AMOUNT].value = clamp01(value);
  }

  public set sunIntensity(value: number) {
    this.uniforms[UNIFORM_SUN_INTENSITY].value = Math.max(0, value);
  }
}

export class WeatherPrecipitationSystem {
  private _mesh: InstancedMesh;
  private _maxParticles: number;
  private _offsetsX: Float32Array;
  private _offsetsZ: Float32Array;
  private _offsetsY: Float32Array;
  private _speeds: Float32Array;
  private _lengths: Float32Array;
  private _widths: Float32Array;

  constructor(maxParticles: number = 220) {
    this._maxParticles = maxParticles;
    this._offsetsX = new Float32Array(maxParticles);
    this._offsetsZ = new Float32Array(maxParticles);
    this._offsetsY = new Float32Array(maxParticles);
    this._speeds = new Float32Array(maxParticles);
    this._lengths = new Float32Array(maxParticles);
    this._widths = new Float32Array(maxParticles);

    for (let i = 0; i < maxParticles; i++) {
      this._offsetsX[i] = Math.random();
      this._offsetsZ[i] = Math.random();
      this._offsetsY[i] = Math.random();
      this._speeds[i] = 12 + Math.random() * 8;
      this._lengths[i] = 0.8 + Math.random() * 1.05;
      this._widths[i] = 0.016 + Math.random() * 0.02;
    }

    const geometry = new PlaneGeometry(1, 1);
    const material = new MeshBasicMaterial({
      color: new Color(0xd8ecff),
      depthWrite: false,
      opacity: 0.28,
      side: DoubleSide,
      transparent: true,
    });

    this._mesh = new InstancedMesh(geometry, material, maxParticles);
    this._mesh.frustumCulled = false;
    this._mesh.renderOrder = -995;
    this._mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this._mesh.matrixAutoUpdate = false;
    this._mesh.matrixWorldAutoUpdate = false;
    this._mesh.count = 0;
    this._mesh.visible = false;
    this._mesh.updateMatrix();
  }

  public get mesh(): InstancedMesh {
    return this._mesh;
  }

  public dispose(): void {
    this._mesh.geometry.dispose();
    (this._mesh.material as MeshBasicMaterial).dispose();
  }

  public update(
    cameraPosition: Vector3,
    cameraQuaternion: Quaternion,
    timeS: number,
    windDirection: Vector2,
    color: Color,
    intensity: number,
    lightningIntensity: number,
  ): void {
    const material = this._mesh.material as MeshBasicMaterial;
    const visibleIntensity = clamp01(intensity);
    const flashIntensity = clamp01(lightningIntensity);

    if (visibleIntensity <= 0.001) {
      this._mesh.visible = false;
      this._mesh.count = 0;
      return;
    }

    this._mesh.visible = true;
    material.color.copy(color);
    material.color.lerp(precipitationLightningColor, flashIntensity * 0.55);
    material.opacity = 0.08 + visibleIntensity * 0.2 + flashIntensity * 0.06;

    const radius = 14 + visibleIntensity * 8;
    const diameter = radius * 2;
    const verticalSpan = 14 + visibleIntensity * 10;
    const activeCount = Math.max(16, Math.floor(this._maxParticles * (0.28 + visibleIntensity * 0.72)));
    const normalizedWind = windDirection.clone();
    if (normalizedWind.lengthSq() < 0.0001) {
      normalizedWind.set(1, 0);
    } else {
      normalizedWind.normalize();
    }
    const windDrift = 2.2 + visibleIntensity * 3.2;
    const anchorStep = 5;

    precipitationGridAnchor.set(
      Math.round(cameraPosition.x / anchorStep) * anchorStep,
      Math.round(cameraPosition.z / anchorStep) * anchorStep,
    );

    precipitationQuaternion.copy(cameraQuaternion);

    for (let i = 0; i < activeCount; i++) {
      const x = wrapCentered((this._offsetsX[i] - 0.5) * diameter + normalizedWind.x * timeS * windDrift, diameter);
      const z = wrapCentered((this._offsetsZ[i] - 0.5) * diameter + normalizedWind.y * timeS * windDrift, diameter);
      const y = 5.5 + visibleIntensity * 4.5 - ((timeS * this._speeds[i] + this._offsetsY[i] * verticalSpan) % verticalSpan);

      precipitationPosition.set(precipitationGridAnchor.x + x, cameraPosition.y + y, precipitationGridAnchor.y + z);
      precipitationScale.set(this._widths[i], this._lengths[i] * (0.9 + visibleIntensity * 0.5), 1);
      precipitationMatrix.compose(precipitationPosition, precipitationQuaternion, precipitationScale);
      this._mesh.setMatrixAt(i, precipitationMatrix);
    }

    this._mesh.count = activeCount;
    this._mesh.instanceMatrix.needsUpdate = true;
  }
}
