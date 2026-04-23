import {
  BackSide,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
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
export type ProceduralSkyPrecipitation = 'none' | 'rain' | 'snow';

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
    cloudCoverage: 0.28,
    cloudOpacity: 0.64,
    cloudScale: 0.38,
    cloudSpeed: 0.018,
    precipitation: 'none',
    precipitationIntensity: 0,
    storminess: 0,
    windDirection: new Vector2(1, 0.16),
  },
  cloudy: {
    cloudCoverage: 0.44,
    cloudOpacity: 0.70,
    cloudScale: 0.42,
    cloudSpeed: 0.022,
    precipitation: 'none',
    precipitationIntensity: 0,
    storminess: 0.06,
    windDirection: new Vector2(1, 0.2),
  },
  overcast: {
    cloudCoverage: 0.58,
    cloudOpacity: 0.76,
    cloudScale: 0.44,
    cloudSpeed: 0.02,
    precipitation: 'none',
    precipitationIntensity: 0,
    storminess: 0.24,
    windDirection: new Vector2(1, 0.24),
  },
  storm: {
    cloudCoverage: 0.82,
    cloudOpacity: 0.88,
    cloudScale: 0.46,
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
const precipitationRotationMatrix = new Matrix4();
const precipitationScale = new Vector3();
const precipitationFallDirection = new Vector3();
const precipitationPlaneNormal = new Vector3();
const precipitationPlaneRight = new Vector3();
const precipitationPlaneUp = new Vector3();
const precipitationToCamera = new Vector3();
const precipitationLightningColor = new Color(0xf6fbff);
const precipitationSnowColor = new Color(0xf8fbff);
const precipitationGridAnchor = new Vector2();
const precipitationFallbackAxisA = new Vector3(1, 0, 0);
const precipitationFallbackAxisB = new Vector3(0, 0, 1);
const surfaceImpactMatrix = new Matrix4();
const surfaceImpactPosition = new Vector3();
const surfaceImpactQuaternion = new Quaternion();
const surfaceImpactScale = new Vector3();
const rainSurfaceImpactColor = new Color(0xe6f4ff);
const snowSurfaceImpactColor = new Color(0xfafcff);
const STORM_LIGHTNING_BUCKET_S = 4;

type WeatherPrecipitationProfile = {
  activeCountBase: number;
  activeCountIntensity: number;
  activeCountMin: number;
  anchorStep: number;
  colorBlend: number;
  flashBlend: number;
  heightBase: number;
  heightIntensity: number;
  lengthScale: number;
  lengthScaleBase: number;
  lengthScaleIntensity: number;
  opacityBase: number;
  opacityIntensity: number;
  opacityLightning: number;
  radiusBase: number;
  radiusIntensity: number;
  speedMultiplier: number;
  verticalSpanBase: number;
  verticalSpanIntensity: number;
  widthScale: number;
  windDriftBase: number;
  windDriftIntensity: number;
  windTiltBase: number;
  windTiltIntensity: number;
};

type WeatherSurfaceImpactProfile = {
  color: Color;
  growth: number;
  lifeS: number;
  maxSpawnPerFrame: number;
  opacity: number;
  sampleRadius: number;
  scaleBase: number;
  scaleVariance: number;
  softness: number;
  spawnRateBase: number;
  spawnRateIntensity: number;
};

const WEATHER_PRECIPITATION_PROFILES: Record<Exclude<ProceduralSkyPrecipitation, 'none'>, WeatherPrecipitationProfile> = {
  rain: {
    activeCountBase: 0.44,
    activeCountIntensity: 0.56,
    activeCountMin: 52,
    anchorStep: 5,
    colorBlend: 0,
    flashBlend: 0.55,
    heightBase: 6,
    heightIntensity: 4.5,
    lengthScale: 1,
    lengthScaleBase: 0.92,
    lengthScaleIntensity: 0.36,
    opacityBase: 0.05,
    opacityIntensity: 0.15,
    opacityLightning: 0.05,
    radiusBase: 12,
    radiusIntensity: 7,
    speedMultiplier: 1,
    verticalSpanBase: 16,
    verticalSpanIntensity: 12,
    widthScale: 1,
    windDriftBase: 0.06,
    windDriftIntensity: 0.05,
    windTiltBase: 0.22,
    windTiltIntensity: 0.12,
  },
  snow: {
    activeCountBase: 0.62,
    activeCountIntensity: 0.38,
    activeCountMin: 88,
    anchorStep: 4,
    colorBlend: 0.78,
    flashBlend: 0.22,
    heightBase: 5,
    heightIntensity: 3.5,
    lengthScale: 0.16,
    lengthScaleBase: 0.9,
    lengthScaleIntensity: 0.2,
    opacityBase: 0.10,
    opacityIntensity: 0.18,
    opacityLightning: 0.03,
    radiusBase: 10,
    radiusIntensity: 6,
    speedMultiplier: 0.22,
    verticalSpanBase: 11,
    verticalSpanIntensity: 8,
    widthScale: 2.6,
    windDriftBase: 0.11,
    windDriftIntensity: 0.09,
    windTiltBase: 0.34,
    windTiltIntensity: 0.18,
  },
};

const WEATHER_SURFACE_IMPACT_PROFILES: Record<Exclude<ProceduralSkyPrecipitation, 'none'>, WeatherSurfaceImpactProfile> = {
  rain: {
    color: rainSurfaceImpactColor,
    growth: 1.6,
    lifeS: 0.34,
    maxSpawnPerFrame: 2,
    opacity: 0.12,
    sampleRadius: 9,
    scaleBase: 0.24,
    scaleVariance: 0.12,
    softness: 0,
    spawnRateBase: 2.5,
    spawnRateIntensity: 5.5,
  },
  snow: {
    color: snowSurfaceImpactColor,
    growth: 0.85,
    lifeS: 0.62,
    maxSpawnPerFrame: 2,
    opacity: 0.09,
    sampleRadius: 8,
    scaleBase: 0.18,
    scaleVariance: 0.10,
    softness: 1,
    spawnRateBase: 1.2,
    spawnRateIntensity: 2.8,
  },
};

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function wrapCentered(value: number, span: number): number {
  return ((((value % span) + span) % span) - span * 0.5);
}

function getWeatherPrecipitationProfile(precipitation: ProceduralSkyPrecipitation): WeatherPrecipitationProfile | null {
  if (precipitation === 'none') {
    return null;
  }

  return WEATHER_PRECIPITATION_PROFILES[precipitation];
}

function getWeatherSurfaceImpactProfile(precipitation: ProceduralSkyPrecipitation): WeatherSurfaceImpactProfile | null {
  if (precipitation === 'none') {
    return null;
  }

  return WEATHER_SURFACE_IMPACT_PROFILES[precipitation];
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
  return value === 'none' || value === 'rain' || value === 'snow';
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

        float clamp01Value(float value) {
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
          float amplitude = 0.50;
          value += noise(p) * amplitude;
          p = p * 2.02 + vec2(8.7, -3.1);
          amplitude *= 0.5;
          value += noise(p) * amplitude;
          p = p * 2.03 + vec2(-4.2, 7.5);
          amplitude *= 0.5;
          value += noise(p) * amplitude;
          p = p * 2.01 + vec2(5.3, -1.8);
          amplitude *= 0.5;
          value += noise(p) * amplitude;
          return value;
        }

        float cloudDensityAt(vec2 p) {
          vec2 blockP = floor(p * 32.0) / 32.0;
          vec2 shapeP = mix(blockP, p, 0.44);
          vec2 medBlockP = floor(p * 48.0) / 48.0;
          vec2 medP = mix(medBlockP, p, 0.52);
          float largeShape = fbm(shapeP * 0.92 + vec2(${UNIFORM_WORLD_SEED} * 0.37, ${UNIFORM_WORLD_SEED} * 0.21));
          float mediumShape = fbm(medP * 2.1 - vec2(${UNIFORM_WORLD_SEED} * 0.13, ${UNIFORM_WORLD_SEED} * 0.29));
          float detailShape = noise(p * 5.0 + vec2(4.0, -6.0));
          float microShape = noise(p * 9.5 + vec2(-9.0, 3.0));
          return largeShape * 0.40 + mediumShape * 0.28 + detailShape * 0.19 + microShape * 0.13;
        }

        void main() {
          vec3 direction = normalize(vWorldDirection);
          vec3 sunViewDirection = normalize(-${UNIFORM_SUN_DIRECTION});
          float dayAmount = smoothstep(-0.18, 0.06, sunViewDirection.y);
          float up = clamp01Value(direction.y * 0.5 + 0.5);

          vec3 zenithNight = vec3(0.025, 0.045, 0.14);
          vec3 horizonNight = vec3(0.055, 0.072, 0.15);
          vec3 zenithDayBase = mix(vec3(0.03, 0.24, 0.96), vec3(0.32, 0.36, 0.48), ${UNIFORM_STORMINESS});
          vec3 horizonDayBase = mix(vec3(0.05, 0.60, 0.76), vec3(0.42, 0.48, 0.56), ${UNIFORM_STORMINESS});
          vec3 zenithDay = zenithDayBase * (1.0 + ${UNIFORM_SKY_INTENSITY} * 0.02);
          vec3 horizonDay = mix(horizonDayBase, ${UNIFORM_FOG_COLOR}, 0.04) * (1.0 + ${UNIFORM_SKY_INTENSITY} * 0.01);
          vec3 nadirDay = mix(vec3(0.84, 0.87, 0.92), vec3(0.46, 0.48, 0.54), ${UNIFORM_STORMINESS});
          vec3 nadir = mix(vec3(0.012, 0.016, 0.032), nadirDay, dayAmount);

          vec3 zenith = mix(zenithNight, zenithDay, dayAmount);
          vec3 horizon = mix(horizonNight, horizonDay, dayAmount);

          vec3 sky = mix(horizon, zenith, smoothstep(0.18, 0.92, up));
          sky = mix(nadir, sky, smoothstep(-0.12, 0.04, direction.y));

          float sunsetWindow = 1.0 - smoothstep(0.08, 0.52, abs(sunViewDirection.y));
          float sunsetBand = exp(-abs(direction.y - max(sunViewDirection.y, -0.06)) * mix(3.8, 8.0, dayAmount));
          float facingSun = pow(clamp01Value(dot(direction, sunViewDirection)), 2.8);
          vec3 sunsetTint = mix(vec3(1.0, 0.32, 0.06), vec3(1.0, 0.60, 0.20), facingSun);
          sky += sunsetTint * sunsetBand * sunsetWindow * (0.38 + 0.48 * facingSun) * (1.0 - ${UNIFORM_STORMINESS} * 0.5);
          float horizonGlow = exp(-abs(direction.y + 0.02) * 5.0) * sunsetWindow;
          sky += vec3(0.85, 0.16, 0.03) * horizonGlow * (0.26 + 0.20 * facingSun) * (1.0 - ${UNIFORM_STORMINESS} * 0.6);

          if (dayAmount < 0.5 && direction.y > 0.0) {
            vec2 starUv = direction.xz / max(direction.y + 0.26, 0.12);
            float starGridSize = 54.0;
            vec2 starGridPos = starUv * starGridSize;
            vec2 starCell = floor(starGridPos);
            vec2 starFrac = fract(starGridPos) - 0.5;
            float starNoise = hash(starCell * 31.0 + vec2(13.7, 41.3));
            float starMask = step(0.984, starNoise);
            float starBrightness = smoothstep(0.5, 0.04, dayAmount) * smoothstep(0.01, 0.22, direction.y) * (1.0 - ${UNIFORM_STORMINESS});
            float starDist = max(abs(starFrac.x), abs(starFrac.y));
            float starCore = 1.0 - smoothstep(0.0, 0.06, starDist);
            float starGlow = (1.0 - smoothstep(0.0, 0.3, starDist)) * 0.32;
            float starVariation = 0.55 + 0.45 * hash(starCell * 53.0);
            vec3 starColor = mix(vec3(0.72, 0.84, 1.0), vec3(1.0, 0.96, 0.84), hash(starCell * 71.0));
            sky += starColor * (starCore + starGlow) * starMask * starBrightness * starVariation;
          }

          if (direction.y > -0.02) {
            vec2 windDir = normalize(${UNIFORM_WIND_DIRECTION});
            vec2 cloudUv = direction.xz / max(direction.y + 0.24, 0.08);
            cloudUv = cloudUv * ${UNIFORM_CLOUD_SCALE} + windDir * ${UNIFORM_TIME} * ${UNIFORM_CLOUD_SPEED};

            float cloudThreshold = mix(0.68, 0.20, ${UNIFORM_CLOUD_COVERAGE});
            float cloudBand = smoothstep(-0.03, 0.12, direction.y) * mix(1.0, 0.68, smoothstep(0.78, 1.0, direction.y));
            float density0 = cloudDensityAt(cloudUv);
            float density1 = cloudDensityAt(cloudUv * 1.05 + vec2(1.9, -2.6));
            float density2 = cloudDensityAt(cloudUv * 1.11 + vec2(-3.8, 4.7));
            float cloudMask0 = smoothstep(cloudThreshold, min(cloudThreshold + 0.10, 0.99), density0);
            float cloudMask1 = smoothstep(cloudThreshold + 0.02, min(cloudThreshold + 0.13, 0.99), density1);
            float cloudMask2 = smoothstep(cloudThreshold + 0.04, min(cloudThreshold + 0.16, 0.99), density2);

            float cloudAlpha0 = cloudMask0 * cloudBand * ${UNIFORM_CLOUD_OPACITY} * 0.78;
            float cloudAlpha1 = cloudMask1 * cloudBand * ${UNIFORM_CLOUD_OPACITY} * 0.36;
            float cloudAlpha2 = cloudMask2 * cloudBand * ${UNIFORM_CLOUD_OPACITY} * 0.20;
            float cloudAlpha = clamp01Value(cloudAlpha0 + (1.0 - cloudAlpha0) * cloudAlpha1 + (1.0 - max(cloudAlpha0, cloudAlpha1)) * cloudAlpha2);

            float cloudThickness = clamp01Value(cloudMask0 * 0.55 + cloudMask1 * 0.30 + cloudMask2 * 0.22);
            float depthOcclusion = clamp01Value(cloudMask1 * 0.58 + cloudMask2 * 0.38);

            float viewUndersideAmount = 1.0 - smoothstep(0.06, 0.50, direction.y);
            float undersideStrength = clamp01Value(depthOcclusion * 0.6 + viewUndersideAmount * cloudThickness * 0.45);

            float edgeDist = clamp01Value((density0 - cloudThreshold) * 7.0);
            float cloudEdge = edgeDist * (1.0 - smoothstep(0.0, 0.6, edgeDist));

            vec3 cloudDir = normalize(vec3(direction.x, max(direction.y, 0.0) + 0.22, direction.z));
            float cloudSunDot = clamp01Value(dot(cloudDir, sunViewDirection));
            float viewSunDot = clamp01Value(dot(direction, sunViewDirection));
            float forwardScatter = pow(viewSunDot, 5.0) * (1.0 - cloudThickness * 0.6) * 0.22;

            vec3 cloudBase = mix(vec3(0.32, 0.34, 0.42), vec3(1.0), dayAmount);
            vec3 cloudLit = cloudBase * (0.92 + 0.12 * cloudSunDot);
            vec3 shadowTint = mix(vec3(0.48, 0.52, 0.68), vec3(0.54, 0.58, 0.72), dayAmount);
            vec3 cloudShadow = cloudBase * shadowTint;

            float shadowBlend = clamp01Value(undersideStrength + (1.0 - cloudSunDot) * depthOcclusion * 0.3);
            vec3 cloudColor = mix(cloudLit, cloudShadow, shadowBlend);
            cloudColor *= 0.88 + cloudThickness * 0.18;
            cloudColor += vec3(1.0, 0.99, 0.96) * cloudEdge * (0.16 + dayAmount * 0.18) * (0.7 + 0.3 * cloudSunDot);
            cloudColor += vec3(1.0, 0.96, 0.88) * forwardScatter * dayAmount;
            cloudColor += sunsetTint * sunsetWindow * clamp01Value(cloudSunDot + 0.2) * cloudMask0 * 0.10;
            cloudColor = mix(cloudColor, cloudColor * 0.48, smoothstep(0.35, 0.92, ${UNIFORM_STORMINESS}));
            cloudColor += vec3(0.78, 0.84, 1.0) * ${UNIFORM_LIGHTNING} * (0.2 + cloudMask0 * 0.62);

            sky = mix(sky, cloudColor, cloudAlpha);
          }

          vec3 lightningColor = mix(vec3(0.68, 0.76, 1.0), vec3(0.92, 0.95, 1.0), dayAmount);
          sky += lightningColor * ${UNIFORM_LIGHTNING} * (0.38 + up * 0.5);

          float nightPreserve = (1.0 - dayAmount) * 0.62;
          float skyMul = max(max(${UNIFORM_SKY_INTENSITY}, 0.02), nightPreserve);
          gl_FragColor = vec4(max(sky * skyMul, vec3(0.0)), 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      side: BackSide,
      depthWrite: false,
      fog: false,
    });
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
          float core = 1.0 - smoothstep(0.02, 0.30, d);
          float glow = 1.0 - smoothstep(0.08, 0.85, d);
          glow = pow(glow, 1.9);
          float outerGlow = 1.0 - smoothstep(0.22, 1.0, d);
          outerGlow = pow(outerGlow, 3.6);
          float rim = 1.0 - smoothstep(0.18, 0.6, d);
          rim = pow(rim, 3.1);
          float halo = ${UNIFORM_HALO_AMOUNT};
          float alpha = (core * 1.0 + glow * 0.34 * halo + outerGlow * 0.14 * halo) * ${UNIFORM_DAY_AMOUNT};

          if (alpha <= 0.001) {
            discard;
          }

          float intensity = min(${UNIFORM_SUN_INTENSITY}, 5.0);
          vec3 baseSunColor = mix(${UNIFORM_SUN_COLOR}, vec3(1.0, 0.97, 0.90), 0.42);
          vec3 coreColor = mix(baseSunColor, vec3(1.0, 1.0, 0.96), 0.35);
          vec3 glowColor = mix(baseSunColor, vec3(1.0, 0.82, 0.38), 0.36);
          vec3 color = coreColor * (core * (2.4 + intensity * 0.32) + rim * 0.36)
            + glowColor * (glow * (0.6 + intensity * 0.08) * halo + outerGlow * 0.42 * halo);
          gl_FragColor = vec4(color, alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: true,
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

  constructor(maxParticles: number = 360) {
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
      this._speeds[i] = 13 + Math.random() * 9;
      this._lengths[i] = 0.42 + Math.random() * 0.52;
      this._widths[i] = 0.008 + Math.random() * 0.012;
    }

    const geometry = new PlaneGeometry(1, 1);
    const material = new MeshBasicMaterial({
      color: new Color(0xd8ecff),
      depthWrite: false,
      opacity: 0.22,
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
    _cameraQuaternion: Quaternion,
    timeS: number,
    windDirection: Vector2,
    color: Color,
    intensity: number,
    lightningIntensity: number,
    precipitation: ProceduralSkyPrecipitation,
  ): void {
    const profile = getWeatherPrecipitationProfile(precipitation);
    const material = this._mesh.material as MeshBasicMaterial;
    const visibleIntensity = clamp01(intensity);
    const flashIntensity = clamp01(lightningIntensity);

    if (!profile || visibleIntensity <= 0.001) {
      this._mesh.visible = false;
      this._mesh.count = 0;
      return;
    }

    this._mesh.visible = true;
    material.color.copy(color).lerp(precipitationSnowColor, profile.colorBlend);
    material.color.lerp(precipitationLightningColor, flashIntensity * profile.flashBlend);
    material.opacity = profile.opacityBase + visibleIntensity * profile.opacityIntensity + flashIntensity * profile.opacityLightning;

    const radius = profile.radiusBase + visibleIntensity * profile.radiusIntensity;
    const diameter = radius * 2;
    const verticalSpan = profile.verticalSpanBase + visibleIntensity * profile.verticalSpanIntensity;
    const activeCount = Math.max(
      profile.activeCountMin,
      Math.floor(this._maxParticles * (profile.activeCountBase + visibleIntensity * profile.activeCountIntensity)),
    );
    const normalizedWind = windDirection.clone();
    if (normalizedWind.lengthSq() < 0.0001) {
      normalizedWind.set(1, 0);
    } else {
      normalizedWind.normalize();
    }
    const windDrift = profile.windDriftBase + visibleIntensity * profile.windDriftIntensity;
    const anchorStep = profile.anchorStep;

    precipitationGridAnchor.set(
      Math.round(cameraPosition.x / anchorStep) * anchorStep,
      Math.round(cameraPosition.z / anchorStep) * anchorStep,
    );

    precipitationFallDirection.set(
      normalizedWind.x * (profile.windTiltBase + visibleIntensity * profile.windTiltIntensity),
      -1,
      normalizedWind.y * (profile.windTiltBase + visibleIntensity * profile.windTiltIntensity),
    ).normalize();
    precipitationPlaneUp.copy(precipitationFallDirection);

    for (let i = 0; i < activeCount; i++) {
      const fallSpeed = this._speeds[i] * profile.speedMultiplier;
      const fallPhase = timeS * fallSpeed + this._offsetsY[i] * verticalSpan;
      const x = wrapCentered((this._offsetsX[i] - 0.5) * diameter + fallPhase * normalizedWind.x * windDrift, diameter);
      const z = wrapCentered((this._offsetsZ[i] - 0.5) * diameter + fallPhase * normalizedWind.y * windDrift, diameter);
      const y = profile.heightBase + visibleIntensity * profile.heightIntensity - (fallPhase % verticalSpan);

      precipitationPosition.set(precipitationGridAnchor.x + x, cameraPosition.y + y, precipitationGridAnchor.y + z);
      precipitationToCamera.copy(cameraPosition).sub(precipitationPosition);
      precipitationPlaneNormal.copy(precipitationToCamera).addScaledVector(
        precipitationPlaneUp,
        -precipitationToCamera.dot(precipitationPlaneUp),
      );

      if (precipitationPlaneNormal.lengthSq() < 0.0001) {
        precipitationPlaneNormal.copy(
          Math.abs(precipitationPlaneUp.dot(precipitationFallbackAxisA)) > 0.92
            ? precipitationFallbackAxisB
            : precipitationFallbackAxisA,
        );
        precipitationPlaneNormal.addScaledVector(
          precipitationPlaneUp,
          -precipitationPlaneNormal.dot(precipitationPlaneUp),
        );
      }

      precipitationPlaneNormal.normalize();
      precipitationPlaneRight.crossVectors(precipitationPlaneUp, precipitationPlaneNormal).normalize();
      precipitationPlaneNormal.crossVectors(precipitationPlaneRight, precipitationPlaneUp).normalize();
      precipitationRotationMatrix.makeBasis(precipitationPlaneRight, precipitationPlaneUp, precipitationPlaneNormal);
      precipitationQuaternion.setFromRotationMatrix(precipitationRotationMatrix);

      precipitationScale.set(
        this._widths[i] * profile.widthScale,
        this._lengths[i] * profile.lengthScale * (profile.lengthScaleBase + visibleIntensity * profile.lengthScaleIntensity),
        1,
      );
      precipitationMatrix.compose(precipitationPosition, precipitationQuaternion, precipitationScale);
      this._mesh.setMatrixAt(i, precipitationMatrix);
    }

    this._mesh.count = activeCount;
    this._mesh.instanceMatrix.needsUpdate = true;
  }
}

export class WeatherSurfaceImpactSystem {
  private _activeCount = 0;
  private _agesS: Float32Array;
  private _baseScales: Float32Array;
  private _growths: Float32Array;
  private _instanceOpacityAttribute: InstancedBufferAttribute;
  private _instanceProgressAttribute: InstancedBufferAttribute;
  private _instanceSoftnessAttribute: InstancedBufferAttribute;
  private _instanceTintAttribute: InstancedBufferAttribute;
  private _lifetimesS: Float32Array;
  private _maxImpacts: number;
  private _mesh: InstancedMesh;
  private _opacities: Float32Array;
  private _positionsX: Float32Array;
  private _positionsY: Float32Array;
  private _positionsZ: Float32Array;
  private _progresses: Float32Array;
  private _softnesses: Float32Array;
  private _spawnAccumulator = 0;
  private _tints: Float32Array;

  constructor(maxImpacts: number = 18) {
    this._maxImpacts = maxImpacts;
    this._agesS = new Float32Array(maxImpacts);
    this._baseScales = new Float32Array(maxImpacts);
    this._growths = new Float32Array(maxImpacts);
    this._lifetimesS = new Float32Array(maxImpacts);
    this._opacities = new Float32Array(maxImpacts);
    this._positionsX = new Float32Array(maxImpacts);
    this._positionsY = new Float32Array(maxImpacts);
    this._positionsZ = new Float32Array(maxImpacts);
    this._progresses = new Float32Array(maxImpacts);
    this._softnesses = new Float32Array(maxImpacts);
    this._tints = new Float32Array(maxImpacts * 3);

    const geometry = new PlaneGeometry(1, 1);
    geometry.rotateX(-Math.PI * 0.5);
    this._instanceOpacityAttribute = new InstancedBufferAttribute(this._opacities, 1);
    this._instanceProgressAttribute = new InstancedBufferAttribute(this._progresses, 1);
    this._instanceSoftnessAttribute = new InstancedBufferAttribute(this._softnesses, 1);
    this._instanceTintAttribute = new InstancedBufferAttribute(this._tints, 3);
    this._instanceOpacityAttribute.setUsage(DynamicDrawUsage);
    this._instanceProgressAttribute.setUsage(DynamicDrawUsage);
    this._instanceSoftnessAttribute.setUsage(DynamicDrawUsage);
    this._instanceTintAttribute.setUsage(DynamicDrawUsage);
    geometry.setAttribute('instanceOpacity', this._instanceOpacityAttribute);
    geometry.setAttribute('instanceProgress', this._instanceProgressAttribute);
    geometry.setAttribute('instanceSoftness', this._instanceSoftnessAttribute);
    geometry.setAttribute('instanceTint', this._instanceTintAttribute);

    const material = new ShaderMaterial({
      vertexShader: `
        attribute float instanceOpacity;
        attribute float instanceProgress;
        attribute float instanceSoftness;
        attribute vec3 instanceTint;

        varying float vOpacity;
        varying float vProgress;
        varying float vSoftness;
        varying vec3 vTint;
        varying vec2 vUv;

        void main() {
          vOpacity = instanceOpacity;
          vProgress = instanceProgress;
          vSoftness = instanceSoftness;
          vTint = instanceTint;
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying float vOpacity;
        varying float vProgress;
        varying float vSoftness;
        varying vec3 vTint;
        varying vec2 vUv;

        void main() {
          vec2 centeredUv = vUv * 2.0 - 1.0;
          float dist = length(centeredUv);
          float ring = smoothstep(0.18, 0.0, abs(dist - 0.58));
          float disc = pow(max(1.0 - smoothstep(0.0, 0.95, dist), 0.0), 1.7);
          float shape = mix(ring, disc, vSoftness);
          float fade = 1.0 - smoothstep(0.0, 1.0, vProgress);
          float alpha = shape * fade * vOpacity;

          if (alpha <= 0.002) {
            discard;
          }

          gl_FragColor = vec4(vTint, alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: NormalBlending,
    });

    this._mesh = new InstancedMesh(geometry, material, maxImpacts);
    this._mesh.frustumCulled = false;
    this._mesh.renderOrder = -994;
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
    (this._mesh.material as ShaderMaterial).dispose();
  }

  public update(
    frameDeltaS: number,
    precipitation: ProceduralSkyPrecipitation,
    intensity: number,
    spawnImpact: (sampleRadius: number) => { x: number; y: number; z: number } | null,
  ): void {
    this._advance(frameDeltaS);

    const profile = getWeatherSurfaceImpactProfile(precipitation);
    const visibleIntensity = clamp01(intensity);

    if (!profile || visibleIntensity <= 0.02) {
      this._spawnAccumulator = 0;
      this._syncMesh();
      return;
    }

    this._spawnAccumulator = Math.min(
      this._spawnAccumulator + frameDeltaS * (profile.spawnRateBase + visibleIntensity * profile.spawnRateIntensity),
      this._maxImpacts,
    );

    let spawnedThisFrame = 0;
    while (this._spawnAccumulator >= 1 && spawnedThisFrame < profile.maxSpawnPerFrame) {
      this._spawnAccumulator -= 1;
      spawnedThisFrame++;

      const impact = spawnImpact(profile.sampleRadius);
      if (!impact) {
        continue;
      }

      this._spawn(impact.x, impact.y, impact.z, profile);
    }

    this._syncMesh();
  }

  private _advance(frameDeltaS: number): void {
    for (let i = 0; i < this._activeCount;) {
      this._agesS[i] += frameDeltaS;
      if (this._agesS[i] >= this._lifetimesS[i]) {
        this._copySlot(this._activeCount - 1, i);
        this._activeCount--;
        continue;
      }

      i++;
    }
  }

  private _copySlot(fromIndex: number, toIndex: number): void {
    if (fromIndex === toIndex) {
      return;
    }

    this._agesS[toIndex] = this._agesS[fromIndex];
    this._baseScales[toIndex] = this._baseScales[fromIndex];
    this._growths[toIndex] = this._growths[fromIndex];
    this._lifetimesS[toIndex] = this._lifetimesS[fromIndex];
    this._opacities[toIndex] = this._opacities[fromIndex];
    this._positionsX[toIndex] = this._positionsX[fromIndex];
    this._positionsY[toIndex] = this._positionsY[fromIndex];
    this._positionsZ[toIndex] = this._positionsZ[fromIndex];
    this._progresses[toIndex] = this._progresses[fromIndex];
    this._softnesses[toIndex] = this._softnesses[fromIndex];

    const fromTintOffset = fromIndex * 3;
    const toTintOffset = toIndex * 3;
    this._tints[toTintOffset] = this._tints[fromTintOffset];
    this._tints[toTintOffset + 1] = this._tints[fromTintOffset + 1];
    this._tints[toTintOffset + 2] = this._tints[fromTintOffset + 2];
  }

  private _findReplacementSlot(): number {
    let oldestIndex = 0;
    let oldestProgress = -1;

    for (let i = 0; i < this._activeCount; i++) {
      const progress = this._lifetimesS[i] <= 0 ? 1 : this._agesS[i] / this._lifetimesS[i];
      if (progress > oldestProgress) {
        oldestProgress = progress;
        oldestIndex = i;
      }
    }

    return oldestIndex;
  }

  private _spawn(x: number, y: number, z: number, profile: WeatherSurfaceImpactProfile): void {
    const slot = this._activeCount < this._maxImpacts
      ? this._activeCount++
      : this._findReplacementSlot();
    const tintOffset = slot * 3;

    this._agesS[slot] = 0;
    this._baseScales[slot] = profile.scaleBase + Math.random() * profile.scaleVariance;
    this._growths[slot] = profile.growth;
    this._lifetimesS[slot] = profile.lifeS * (0.92 + Math.random() * 0.18);
    this._opacities[slot] = profile.opacity * (0.88 + Math.random() * 0.22);
    this._positionsX[slot] = x;
    this._positionsY[slot] = y;
    this._positionsZ[slot] = z;
    this._progresses[slot] = 0;
    this._softnesses[slot] = profile.softness;
    this._tints[tintOffset] = profile.color.r;
    this._tints[tintOffset + 1] = profile.color.g;
    this._tints[tintOffset + 2] = profile.color.b;
  }

  private _syncMesh(): void {
    if (this._activeCount <= 0) {
      this._mesh.visible = false;
      this._mesh.count = 0;
      return;
    }

    for (let i = 0; i < this._activeCount; i++) {
      const progress = this._lifetimesS[i] <= 0 ? 1 : clamp01(this._agesS[i] / this._lifetimesS[i]);
      this._progresses[i] = progress;

      const currentScale = this._baseScales[i] * (1 + this._growths[i] * progress);
      surfaceImpactPosition.set(this._positionsX[i], this._positionsY[i], this._positionsZ[i]);
      surfaceImpactScale.set(currentScale, currentScale, currentScale);
      surfaceImpactMatrix.compose(surfaceImpactPosition, surfaceImpactQuaternion, surfaceImpactScale);
      this._mesh.setMatrixAt(i, surfaceImpactMatrix);
    }

    this._mesh.visible = true;
    this._mesh.count = this._activeCount;
    this._mesh.instanceMatrix.needsUpdate = true;
    this._instanceOpacityAttribute.needsUpdate = true;
    this._instanceProgressAttribute.needsUpdate = true;
    this._instanceSoftnessAttribute.needsUpdate = true;
    this._instanceTintAttribute.needsUpdate = true;
  }
}
