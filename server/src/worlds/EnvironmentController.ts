import type RgbColor from '@/shared/types/RgbColor';
import type World from '@/worlds/World';

const DEFAULT_CLOCK_INTERVAL_MS = 1000;
const DEFAULT_CYCLE_DURATION_MS = 24 * 60 * 1000;
const DEFAULT_CYCLE_OFFSET_HOURS = 7;
const DEFAULT_DAY_DURATION_RATIO = 0.75;
const DEFAULT_DAY_SKYBOX_INTENSITY = 1.02;
const DEFAULT_MAX_AMBIENT_LIGHT_INTENSITY = 0.95;
const DEFAULT_MAX_DIRECTIONAL_LIGHT_INTENSITY = 2.2;
const DEFAULT_MIN_AMBIENT_LIGHT_INTENSITY = 0.28;
const DEFAULT_MIN_DIRECTIONAL_LIGHT_INTENSITY = 0.18;
const DEFAULT_NIGHT_SKYBOX_INTENSITY = 0.04;
const DEFAULT_PROCEDURAL_SKY_URI = 'skyboxes/procedural?weather=cloudy';
const DEFAULT_SUN_BASE_HEIGHT = 100;
const DEFAULT_SUN_HEIGHT_RANGE = 150;
const DEFAULT_SUN_RADIUS = 300;
const PROCEDURAL_SKY_PREFIX = 'skyboxes/procedural';

export type EnvironmentWeatherPreset = 'clear' | 'cloudy' | 'overcast' | 'storm';

export type EnvironmentControllerOptions = {
  autoStart?: boolean;
  clockIntervalMs?: number;
  cycleDurationMs?: number;
  cycleOffsetHours?: number;
  dayDurationRatio?: number;
  daySkyboxIntensity?: number;
  ensureProceduralSky?: boolean;
  fogColor?: RgbColor;
  maxAmbientLightIntensity?: number;
  maxDirectionalLightIntensity?: number;
  minAmbientLightIntensity?: number;
  minDirectionalLightIntensity?: number;
  nightSkyboxIntensity?: number;
  onWeatherPresetChange?: (world: World, weatherPreset: EnvironmentWeatherPreset) => void;
  proceduralSkyUri?: string;
  startTimeMs?: number;
  sunBaseHeight?: number;
  sunHeightRange?: number;
  sunRadius?: number;
  weatherEnabled?: boolean;
  weatherSeed?: number;
};

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function lerpNumber(start: number, end: number, amount: number): number {
  return start + (end - start) * amount;
}

function lerpColor(start: RgbColor, end: RgbColor, amount: number): RgbColor {
  return {
    r: Math.round(lerpNumber(start.r, end.r, amount)),
    g: Math.round(lerpNumber(start.g, end.g, amount)),
    b: Math.round(lerpNumber(start.b, end.b, amount)),
  };
}

function normalizeTimeMs(timeMs: number, cycleDurationMs: number): number {
  return ((timeMs % cycleDurationMs) + cycleDurationMs) % cycleDurationMs;
}

function smoothstep(min: number, max: number, value: number): number {
  if (min === max) {
    return value >= max ? 1 : 0;
  }

  const t = clamp01((value - min) / (max - min));
  return t * t * (3 - 2 * t);
}

function parseWeatherPresetFromSkyboxUri(skyboxUri: string): EnvironmentWeatherPreset | null {
  if (!skyboxUri.startsWith(PROCEDURAL_SKY_PREFIX)) {
    return null;
  }

  const queryIndex = skyboxUri.indexOf('?');
  const baseUri = queryIndex >= 0 ? skyboxUri.slice(0, queryIndex) : skyboxUri;
  const params = new URLSearchParams(queryIndex >= 0 ? skyboxUri.slice(queryIndex + 1) : '');
  const suffix = baseUri.slice(PROCEDURAL_SKY_PREFIX.length).replace(/^\/+/, '');
  const weather = params.get('weather') ?? params.get('preset') ?? suffix;

  return weather === 'clear' || weather === 'cloudy' || weather === 'overcast' || weather === 'storm'
    ? weather
    : null;
}

function buildProceduralSkyUriWithWeather(baseSkyboxUri: string, weatherPreset: EnvironmentWeatherPreset): string {
  const queryIndex = baseSkyboxUri.indexOf('?');
  const baseUri = queryIndex >= 0 ? baseSkyboxUri.slice(0, queryIndex) : baseSkyboxUri;
  const params = new URLSearchParams(queryIndex >= 0 ? baseSkyboxUri.slice(queryIndex + 1) : '');

  params.set('weather', weatherPreset);

  const query = params.toString();
  return query ? `${baseUri}?${query}` : `${PROCEDURAL_SKY_PREFIX}?weather=${weatherPreset}`;
}

/**
 * Drives a world's day/night lighting and procedural weather state.
 *
 * Use for: quickly enabling a Minecraft-style moving sun, dynamic ambient/fog,
 * and procedural sky weather on any world.
 * Do NOT use for: biome-specific precipitation audio or gameplay reactions;
 * keep those in your game code via `onWeatherPresetChange`.
 *
 * **Category:** Core
 * @public
 */
export default class EnvironmentController {
  private _clockIntervalMs: number;
  private _cycleDurationMs: number;
  private _cycleOffsetHours: number;
  private _dayDurationRatio: number;
  private _daySkyboxIntensity: number;
  private _ensureProceduralSky: boolean;
  private _fogColor: RgbColor | undefined;
  private _interval: ReturnType<typeof setInterval> | null = null;
  private _maxAmbientLightIntensity: number;
  private _maxDirectionalLightIntensity: number;
  private _minAmbientLightIntensity: number;
  private _minDirectionalLightIntensity: number;
  private _nightSkyboxIntensity: number;
  private _onWeatherPresetChange: ((world: World, weatherPreset: EnvironmentWeatherPreset) => void) | undefined;
  private _proceduralSkyUri: string;
  private _sunBaseHeight: number;
  private _sunHeightRange: number;
  private _sunRadius: number;
  private _timeMs: number;
  private _weatherEnabled: boolean;
  private _weatherPreset: EnvironmentWeatherPreset;
  private _weatherPresetApplied: boolean = false;
  private _weatherSeed: number;

  private readonly _world: World;

  public constructor(world: World, options: EnvironmentControllerOptions = {}) {
    this._world = world;
    this._clockIntervalMs = options.clockIntervalMs ?? DEFAULT_CLOCK_INTERVAL_MS;
    this._cycleDurationMs = options.cycleDurationMs ?? DEFAULT_CYCLE_DURATION_MS;
    this._cycleOffsetHours = options.cycleOffsetHours ?? DEFAULT_CYCLE_OFFSET_HOURS;
    this._dayDurationRatio = clamp01(options.dayDurationRatio ?? DEFAULT_DAY_DURATION_RATIO);
    this._daySkyboxIntensity = options.daySkyboxIntensity ?? DEFAULT_DAY_SKYBOX_INTENSITY;
    this._ensureProceduralSky = options.ensureProceduralSky ?? true;
    this._fogColor = options.fogColor;
    this._maxAmbientLightIntensity = options.maxAmbientLightIntensity ?? DEFAULT_MAX_AMBIENT_LIGHT_INTENSITY;
    this._maxDirectionalLightIntensity = options.maxDirectionalLightIntensity ?? DEFAULT_MAX_DIRECTIONAL_LIGHT_INTENSITY;
    this._minAmbientLightIntensity = options.minAmbientLightIntensity ?? DEFAULT_MIN_AMBIENT_LIGHT_INTENSITY;
    this._minDirectionalLightIntensity = options.minDirectionalLightIntensity ?? DEFAULT_MIN_DIRECTIONAL_LIGHT_INTENSITY;
    this._nightSkyboxIntensity = options.nightSkyboxIntensity ?? DEFAULT_NIGHT_SKYBOX_INTENSITY;
    this._onWeatherPresetChange = options.onWeatherPresetChange;
    this._proceduralSkyUri = options.proceduralSkyUri ?? world.skyboxUri ?? DEFAULT_PROCEDURAL_SKY_URI;
    this._sunBaseHeight = options.sunBaseHeight ?? DEFAULT_SUN_BASE_HEIGHT;
    this._sunHeightRange = options.sunHeightRange ?? DEFAULT_SUN_HEIGHT_RANGE;
    this._sunRadius = options.sunRadius ?? DEFAULT_SUN_RADIUS;
    this._weatherEnabled = options.weatherEnabled ?? true;
    this._weatherSeed = options.weatherSeed ?? world.id;
    this._timeMs = normalizeTimeMs(
      options.startTimeMs ?? (this._cycleDurationMs * (((12 - this._cycleOffsetHours) + 24) % 24) / 24),
      this._cycleDurationMs,
    );

    this._weatherPreset = this._weatherEnabled
      ? this._calculateWeatherPreset()
      : parseWeatherPresetFromSkyboxUri(this._proceduralSkyUri) ?? 'cloudy';

    if (options.autoStart !== false) {
      this.start();
    }
  }

  public get hour(): number {
    const cycleProgress = this._timeMs / this._cycleDurationMs;
    return Math.floor((cycleProgress * 24) + this._cycleOffsetHours) % 24;
  }

  public get minute(): number {
    const cycleProgress = this._timeMs / this._cycleDurationMs;
    const totalMinutes = (cycleProgress * 24 * 60) + (this._cycleOffsetHours * 60);
    return Math.floor(totalMinutes) % 60;
  }

  public get timeMs(): number {
    return this._timeMs;
  }

  public get weatherPreset(): EnvironmentWeatherPreset {
    return this._weatherPreset;
  }

  public setTimeMs(timeMs: number): void {
    this._timeMs = normalizeTimeMs(timeMs, this._cycleDurationMs);
  }

  public start(): void {
    if (this._interval) {
      return;
    }

    this.update();
    this._interval = setInterval(() => {
      this._timeMs = normalizeTimeMs(this._timeMs + this._clockIntervalMs, this._cycleDurationMs);
      this.update();
    }, this._clockIntervalMs);
  }

  public stop(): void {
    if (!this._interval) {
      return;
    }

    clearInterval(this._interval);
    this._interval = null;
  }

  public dispose(): void {
    this.stop();
  }

  public update(): void {
    this._applyTimeOfDay();
    this._applyWeather();
  }

  private _applyTimeOfDay(): void {
    const timeProgress = this._timeMs / this._cycleDurationMs;
    const dayDurationRatio = Math.max(0.01, Math.min(0.99, this._dayDurationRatio));
    const dayDirectionalColor = { r: 255, g: 244, b: 226 };
    const dayAmbientColor = { r: 196, g: 220, b: 255 };
    const moonDirectionalColor = { r: 118, g: 146, b: 210 };
    const nightAmbientColor = { r: 74, g: 96, b: 152 };
    const sunsetDirectionalColor = { r: 255, g: 154, b: 92 };
    const sunsetAmbientColor = { r: 186, g: 122, b: 118 };

    let sunAngle: number;
    if (timeProgress < dayDurationRatio) {
      sunAngle = (timeProgress / dayDurationRatio) * Math.PI;
    } else {
      sunAngle = Math.PI + ((timeProgress - dayDurationRatio) / (1 - dayDurationRatio)) * Math.PI;
    }

    const sunHeight = this._sunBaseHeight + Math.sin(sunAngle) * this._sunHeightRange;
    const sunX = Math.cos(sunAngle) * this._sunRadius;
    const sunZ = Math.sin(sunAngle) * this._sunRadius;
    const sunAltitude = Math.sin(sunAngle);
    const daylightAmount = smoothstep(-0.16, 0.14, sunAltitude);
    const moonlightAmount = smoothstep(-0.06, 0.38, -sunAltitude);
    const twilightAmount = 1 - smoothstep(0.08, 0.46, Math.abs(sunAltitude));
    const skyboxEaseT = daylightAmount * daylightAmount;
    const skyboxIntensity = lerpNumber(this._nightSkyboxIntensity, this._daySkyboxIntensity, skyboxEaseT);
    const directionalColor = lerpColor(
      lerpColor(moonDirectionalColor, dayDirectionalColor, daylightAmount),
      sunsetDirectionalColor,
      twilightAmount * 0.78,
    );
    const ambientColor = lerpColor(
      lerpColor(nightAmbientColor, dayAmbientColor, daylightAmount),
      sunsetAmbientColor,
      twilightAmount * 0.42,
    );
    const directionalIntensity = Math.max(
      this._minDirectionalLightIntensity,
      daylightAmount * this._maxDirectionalLightIntensity + moonlightAmount * 0.12,
    );
    const ambientIntensity = Math.max(
      this._minAmbientLightIntensity,
      daylightAmount * this._maxAmbientLightIntensity
        + moonlightAmount * Math.max(0.12, this._minAmbientLightIntensity * 0.72),
    );
    const directionalLightPosition = daylightAmount >= moonlightAmount
      ? { x: sunX, y: sunHeight, z: sunZ }
      : { x: -sunX, y: Math.max(20, -sunHeight + 24), z: -sunZ };

    this._world.setDirectionalLightPosition(directionalLightPosition);
    this._world.setDirectionalLightColor(directionalColor);
    this._world.setDirectionalLightIntensity(directionalIntensity);
    this._world.setAmbientLightColor(ambientColor);
    this._world.setAmbientLightIntensity(ambientIntensity);
    this._world.setSkyboxIntensity(skyboxIntensity);

    if (this._fogColor) {
      const fogIntensityMultiplier = Math.max(
        0.26,
        daylightAmount * 0.88 + moonlightAmount * 0.2 + twilightAmount * 0.22,
      );
      this._world.setFogColor({
        r: Math.floor(this._fogColor.r * fogIntensityMultiplier),
        g: Math.floor(this._fogColor.g * fogIntensityMultiplier),
        b: Math.floor(this._fogColor.b * fogIntensityMultiplier),
      });
    }
  }

  private _applyWeather(): void {
    const nextWeatherPreset = this._weatherEnabled
      ? this._calculateWeatherPreset()
      : this._weatherPreset;
    const weatherChanged = !this._weatherPresetApplied || this._weatherPreset !== nextWeatherPreset;

    this._weatherPreset = nextWeatherPreset;

    if (this._ensureProceduralSky || this._world.skyboxUri.startsWith(PROCEDURAL_SKY_PREFIX)) {
      const baseSkyboxUri = this._world.skyboxUri.startsWith(PROCEDURAL_SKY_PREFIX)
        ? this._world.skyboxUri
        : this._proceduralSkyUri;
      const nextSkyboxUri = buildProceduralSkyUriWithWeather(baseSkyboxUri, this._weatherPreset);

      if (this._world.skyboxUri !== nextSkyboxUri) {
        this._world.setSkyboxUri(nextSkyboxUri);
      }
    }

    if (weatherChanged) {
      this._onWeatherPresetChange?.(this._world, this._weatherPreset);
    }

    this._weatherPresetApplied = true;
  }

  private _calculateWeatherPreset(): EnvironmentWeatherPreset {
    const weatherPhase = (this._timeMs / this._cycleDurationMs) * Math.PI * 2;
    const weatherNoise = 0.5
      + Math.sin(weatherPhase * 0.85 + this._weatherSeed * 0.073) * 0.28
      + Math.sin(weatherPhase * 2.35 + this._weatherSeed * 0.041) * 0.18
      + Math.cos(weatherPhase * 4.1 + this._weatherSeed * 0.019) * 0.08;
    const normalizedWeather = clamp01(weatherNoise);

    if (normalizedWeather >= 0.8) {
      return 'storm';
    }

    if (normalizedWeather >= 0.62) {
      return 'overcast';
    }

    if (normalizedWeather >= 0.34) {
      return 'cloudy';
    }

    return 'clear';
  }
}
