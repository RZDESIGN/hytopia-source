import type RgbColor from '@/shared/types/RgbColor';
import type World from '@/worlds/World';

const DEFAULT_CLOCK_INTERVAL_MS = 1000;
const DEFAULT_CYCLE_DURATION_MS = 24 * 60 * 1000;
const DEFAULT_CYCLE_OFFSET_HOURS = 7;
const DEFAULT_DAY_DURATION_RATIO = 0.75;
const DEFAULT_DAY_SKYBOX_INTENSITY = 0.84;
const DEFAULT_MAX_AMBIENT_LIGHT_INTENSITY = 0.62;
const DEFAULT_MAX_DIRECTIONAL_LIGHT_INTENSITY = 2.7;
const DEFAULT_MIN_AMBIENT_LIGHT_INTENSITY = 0.16;
const DEFAULT_MIN_DIRECTIONAL_LIGHT_INTENSITY = 0.2;
const DEFAULT_NIGHT_SKYBOX_INTENSITY = 0.04;
const DEFAULT_PROCEDURAL_SKY_URI = 'skyboxes/procedural?weather=clear';
const DEFAULT_SUN_BASE_HEIGHT = 100;
const DEFAULT_SUN_HEIGHT_RANGE = 150;
const DEFAULT_SUN_RADIUS = 300;
const PROCEDURAL_SKY_PREFIX = 'skyboxes/procedural';

/** @public */
export type EnvironmentWeatherPreset = 'clear' | 'cloudy' | 'overcast' | 'storm';

/** @public */
export type EnvironmentPreset = 'daytime' | 'nighttime' | 'sunset' | 'raining' | 'snowing' | 'storming';

/** @public */
export type EnvironmentControllerMode = 'preset' | 'cycle';
type EnvironmentPrecipitation = 'none' | 'rain' | 'snow';

type EnvironmentPresetDefinition = {
  clockHour: number;
  precipitation: EnvironmentPrecipitation;
  precipitationIntensity?: number;
  storminess?: number;
  weatherPreset: EnvironmentWeatherPreset;
  windDirection?: { x: number; y: number };
};

type LegacyEnvironmentSkyboxAlias = {
  preset: EnvironmentPreset;
  proceduralSkyUri: string;
};

const ENVIRONMENT_PRESET_DEFINITIONS: Record<EnvironmentPreset, EnvironmentPresetDefinition> = {
  daytime: {
    clockHour: 12,
    precipitation: 'none',
    weatherPreset: 'clear',
  },
  nighttime: {
    clockHour: 0,
    precipitation: 'none',
    weatherPreset: 'clear',
  },
  sunset: {
    clockHour: 20.75,
    precipitation: 'none',
    weatherPreset: 'clear',
  },
  raining: {
    clockHour: 14,
    precipitation: 'rain',
    precipitationIntensity: 0.8,
    storminess: 0.32,
    weatherPreset: 'overcast',
    windDirection: { x: 1, y: 0.18 },
  },
  snowing: {
    clockHour: 13,
    precipitation: 'snow',
    precipitationIntensity: 0.78,
    storminess: 0.18,
    weatherPreset: 'overcast',
    windDirection: { x: 1, y: 0.1 },
  },
  storming: {
    clockHour: 15,
    precipitation: 'rain',
    precipitationIntensity: 1,
    storminess: 0.88,
    weatherPreset: 'storm',
    windDirection: { x: 1, y: 0.3 },
  },
};

const LEGACY_ENVIRONMENT_SKYBOX_ALIASES: Record<string, LegacyEnvironmentSkyboxAlias> = {
  'skyboxes/night': {
    preset: 'nighttime',
    proceduralSkyUri: 'skyboxes/procedural?weather=clear',
  },
  'skyboxes/partly-cloudy': {
    preset: 'daytime',
    proceduralSkyUri: 'skyboxes/procedural?weather=cloudy',
  },
  'skyboxes/sunset': {
    preset: 'sunset',
    proceduralSkyUri: 'skyboxes/procedural?weather=clear',
  },
};

/** @public */
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
  mode?: EnvironmentControllerMode;
  nightSkyboxIntensity?: number;
  onWeatherPresetChange?: (world: World, weatherPreset: EnvironmentWeatherPreset) => void;
  preset?: EnvironmentPreset;
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

function normalizeDirection(x: number, y: number, z: number): { x: number, y: number, z: number } {
  const length = Math.hypot(x, y, z) || 1;
  return { x: x / length, y: y / length, z: z / length };
}

function wrapHour24(hour: number): number {
  return ((hour % 24) + 24) % 24;
}

function normalizeSkyboxUriForAliasLookup(skyboxUri: string): string {
  const queryIndex = skyboxUri.indexOf('?');
  const baseUri = (queryIndex >= 0 ? skyboxUri.slice(0, queryIndex) : skyboxUri).replace(/^\/+/, '');

  if (baseUri.startsWith('skyboxes/')) {
    return baseUri;
  }

  return `skyboxes/${baseUri}`;
}

function getLegacyEnvironmentSkyboxAlias(skyboxUri: string): LegacyEnvironmentSkyboxAlias | null {
  return LEGACY_ENVIRONMENT_SKYBOX_ALIASES[normalizeSkyboxUriForAliasLookup(skyboxUri)] ?? null;
}

function canUseWeatherOverrideForPreset(preset: EnvironmentPreset): boolean {
  return preset === 'daytime' || preset === 'nighttime' || preset === 'sunset';
}

function shouldDefaultToProceduralSky(worldSkyboxUri: string, proceduralSkyUri: string | undefined): boolean {
  return proceduralSkyUri !== undefined
    || worldSkyboxUri.startsWith(PROCEDURAL_SKY_PREFIX)
    || getLegacyEnvironmentSkyboxAlias(worldSkyboxUri) !== null;
}

function getTimeMsForClockHour(clockHour: number, cycleDurationMs: number, cycleOffsetHours: number): number {
  return normalizeTimeMs((wrapHour24(clockHour - cycleOffsetHours) / 24) * cycleDurationMs, cycleDurationMs);
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

function parseEnvironmentPresetFromSkyboxUri(skyboxUri: string): EnvironmentPreset | null {
  if (!skyboxUri.startsWith(PROCEDURAL_SKY_PREFIX)) {
    return null;
  }

  const queryIndex = skyboxUri.indexOf('?');
  const params = new URLSearchParams(queryIndex >= 0 ? skyboxUri.slice(queryIndex + 1) : '');
  const weatherPreset = parseWeatherPresetFromSkyboxUri(skyboxUri);
  const precipitation = params.get('precip');

  if (precipitation === 'snow') {
    return 'snowing';
  }

  if (weatherPreset === 'storm') {
    return 'storming';
  }

  if (precipitation === 'rain') {
    return 'raining';
  }

  return null;
}

function buildProceduralSkyUriWithWeather(baseSkyboxUri: string, weatherPreset: EnvironmentWeatherPreset): string {
  const queryIndex = baseSkyboxUri.indexOf('?');
  const baseUri = queryIndex >= 0 ? baseSkyboxUri.slice(0, queryIndex) : baseSkyboxUri;
  const params = new URLSearchParams(queryIndex >= 0 ? baseSkyboxUri.slice(queryIndex + 1) : '');

  params.set('weather', weatherPreset);

  const query = params.toString();
  return query ? `${baseUri}?${query}` : `${PROCEDURAL_SKY_PREFIX}?weather=${weatherPreset}`;
}

function buildProceduralSkyUriWithPreset(
  baseSkyboxUri: string,
  preset: EnvironmentPreset,
  weatherPresetOverride?: EnvironmentWeatherPreset | null,
): string {
  const queryIndex = baseSkyboxUri.indexOf('?');
  const baseUri = queryIndex >= 0 ? baseSkyboxUri.slice(0, queryIndex) : baseSkyboxUri;
  const params = new URLSearchParams(queryIndex >= 0 ? baseSkyboxUri.slice(queryIndex + 1) : '');
  const definition = ENVIRONMENT_PRESET_DEFINITIONS[preset];

  params.delete('preset');
  params.set('weather', weatherPresetOverride ?? definition.weatherPreset);

  if (definition.precipitation === 'none') {
    params.delete('precip');
    params.delete('precipIntensity');
    params.delete('storm');
    params.delete('windX');
    params.delete('windY');
  } else {
    params.set('precip', definition.precipitation);
    params.set('precipIntensity', String(definition.precipitationIntensity ?? 1));
    params.set('storm', String(definition.storminess ?? 0));

    if (definition.windDirection) {
      params.set('windX', String(definition.windDirection.x));
      params.set('windY', String(definition.windDirection.y));
    } else {
      params.delete('windX');
      params.delete('windY');
    }
  }

  const query = params.toString();
  return query ? `${baseUri}?${query}` : `${PROCEDURAL_SKY_PREFIX}?weather=${definition.weatherPreset}`;
}

/**
 * Drives a world's environment lighting and procedural sky state.
 *
 * Use for: quickly applying fixed day/night/weather presets to any procedural sky world,
 * or opting into the legacy moving day/night cycle with `mode: 'cycle'`.
 * Do NOT use for: biome-specific precipitation audio or gameplay reactions;
 * keep those in your game code.
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
  private _mode: EnvironmentControllerMode;
  private _nightSkyboxIntensity: number;
  private _onWeatherPresetChange: ((world: World, weatherPreset: EnvironmentWeatherPreset) => void) | undefined;
  private _preset: EnvironmentPreset;
  private _presetWeatherOverride: EnvironmentWeatherPreset | null = null;
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
    const legacySkyboxAlias = options.proceduralSkyUri === undefined
      ? getLegacyEnvironmentSkyboxAlias(world.skyboxUri)
      : null;
    const sourceProceduralSkyUri = options.proceduralSkyUri
      ?? (world.skyboxUri.startsWith(PROCEDURAL_SKY_PREFIX)
        ? world.skyboxUri
        : legacySkyboxAlias?.proceduralSkyUri
          ?? DEFAULT_PROCEDURAL_SKY_URI);
    const parsedPresetFromProceduralSky = parseEnvironmentPresetFromSkyboxUri(sourceProceduralSkyUri);
    const parsedWeatherPresetFromProceduralSky = parseWeatherPresetFromSkyboxUri(sourceProceduralSkyUri);
    this._clockIntervalMs = options.clockIntervalMs ?? DEFAULT_CLOCK_INTERVAL_MS;
    this._cycleDurationMs = options.cycleDurationMs ?? DEFAULT_CYCLE_DURATION_MS;
    this._cycleOffsetHours = options.cycleOffsetHours ?? DEFAULT_CYCLE_OFFSET_HOURS;
    this._dayDurationRatio = clamp01(options.dayDurationRatio ?? DEFAULT_DAY_DURATION_RATIO);
    this._daySkyboxIntensity = options.daySkyboxIntensity ?? DEFAULT_DAY_SKYBOX_INTENSITY;
    this._ensureProceduralSky = options.ensureProceduralSky
      ?? shouldDefaultToProceduralSky(world.skyboxUri, options.proceduralSkyUri);
    this._fogColor = options.fogColor;
    this._maxAmbientLightIntensity = options.maxAmbientLightIntensity ?? DEFAULT_MAX_AMBIENT_LIGHT_INTENSITY;
    this._maxDirectionalLightIntensity = options.maxDirectionalLightIntensity ?? DEFAULT_MAX_DIRECTIONAL_LIGHT_INTENSITY;
    this._minAmbientLightIntensity = options.minAmbientLightIntensity ?? DEFAULT_MIN_AMBIENT_LIGHT_INTENSITY;
    this._minDirectionalLightIntensity = options.minDirectionalLightIntensity ?? DEFAULT_MIN_DIRECTIONAL_LIGHT_INTENSITY;
    this._mode = options.mode ?? 'preset';
    this._nightSkyboxIntensity = options.nightSkyboxIntensity ?? DEFAULT_NIGHT_SKYBOX_INTENSITY;
    this._onWeatherPresetChange = options.onWeatherPresetChange;
    this._proceduralSkyUri = sourceProceduralSkyUri;
    this._preset = options.preset
      ?? legacySkyboxAlias?.preset
      ?? parsedPresetFromProceduralSky
      ?? 'daytime';
    const shouldPreserveSourceWeatherInPresetMode = canUseWeatherOverrideForPreset(this._preset)
      && parsedPresetFromProceduralSky === null
      && parsedWeatherPresetFromProceduralSky !== null
      && parsedWeatherPresetFromProceduralSky !== ENVIRONMENT_PRESET_DEFINITIONS[this._preset].weatherPreset;
    this._presetWeatherOverride = shouldPreserveSourceWeatherInPresetMode
      ? parsedWeatherPresetFromProceduralSky
      : null;
    this._sunBaseHeight = options.sunBaseHeight ?? DEFAULT_SUN_BASE_HEIGHT;
    this._sunHeightRange = options.sunHeightRange ?? DEFAULT_SUN_HEIGHT_RANGE;
    this._sunRadius = options.sunRadius ?? DEFAULT_SUN_RADIUS;
    this._weatherEnabled = options.weatherEnabled ?? true;
    this._weatherSeed = options.weatherSeed ?? world.id;
    this._timeMs = normalizeTimeMs(
      options.startTimeMs ?? (
        this._mode === 'cycle'
          ? (this._cycleDurationMs * (((12 - this._cycleOffsetHours) + 24) % 24) / 24)
          : getTimeMsForClockHour(
            ENVIRONMENT_PRESET_DEFINITIONS[this._preset].clockHour,
            this._cycleDurationMs,
            this._cycleOffsetHours,
          )
      ),
      this._cycleDurationMs,
    );

    this._weatherPreset = this._mode === 'cycle'
      ? (
        this._weatherEnabled
          ? this._calculateWeatherPreset()
          : parseWeatherPresetFromSkyboxUri(this._proceduralSkyUri) ?? 'cloudy'
      )
      : this._presetWeatherOverride ?? ENVIRONMENT_PRESET_DEFINITIONS[this._preset].weatherPreset;

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

  /**
   * The currently selected fixed environment preset.
   *
   * **Category:** Core
   */
  public get preset(): EnvironmentPreset {
    return this._preset;
  }

  /**
   * The current procedural sky weather preset.
   *
   * **Category:** Core
   */
  public get weatherPreset(): EnvironmentWeatherPreset {
    return this._weatherPreset;
  }

  public setTimeMs(timeMs: number): void {
    this._timeMs = normalizeTimeMs(timeMs, this._cycleDurationMs);
    this.update();
  }

  /**
   * Applies a fixed environment preset and disables the moving day/night cycle.
   *
   * **Category:** Core
   */
  public setPreset(
    preset: EnvironmentPreset,
    weatherPresetOverride: EnvironmentWeatherPreset | null = null,
    proceduralSkyUri?: string,
  ): void {
    this.stop();
    this._mode = 'preset';
    this._preset = preset;
    this._presetWeatherOverride = canUseWeatherOverrideForPreset(preset)
      ? weatherPresetOverride
      : null;
    if (proceduralSkyUri) {
      this._proceduralSkyUri = proceduralSkyUri;
    }
    this._timeMs = getTimeMsForClockHour(
      ENVIRONMENT_PRESET_DEFINITIONS[preset].clockHour,
      this._cycleDurationMs,
      this._cycleOffsetHours,
    );
    this.update();
  }

  public start(): void {
    if (this._mode !== 'cycle') {
      this.update();
      return;
    }

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
    const clockHour = wrapHour24(timeProgress * 24 + this._cycleOffsetHours);
    const daylightHours = 24 * dayDurationRatio;
    const nightHours = 24 - daylightHours;
    const sunriseHour = 12 - daylightHours * 0.5;
    const sunsetHour = 12 + daylightHours * 0.5;
    const dayDirectionalColor = { r: 255, g: 244, b: 226 };
    const dayAmbientColor = { r: 196, g: 220, b: 255 };
    const moonDirectionalColor = { r: 118, g: 146, b: 210 };
    const nightAmbientColor = { r: 74, g: 96, b: 152 };
    const sunsetDirectionalColor = { r: 255, g: 154, b: 92 };
    const sunsetAmbientColor = { r: 186, g: 122, b: 118 };

    let sunAngle: number;
    if (clockHour >= sunriseHour && clockHour < sunsetHour) {
      const daylightProgress = (clockHour - sunriseHour) / daylightHours;
      sunAngle = daylightProgress * Math.PI;
    } else {
      const wrappedNightHour = clockHour < sunriseHour ? clockHour + 24 : clockHour;
      const nightProgress = (wrappedNightHour - sunsetHour) / Math.max(nightHours, 0.01);
      sunAngle = Math.PI + nightProgress * Math.PI;
    }

    const sunHeight = this._sunBaseHeight + Math.sin(sunAngle) * this._sunHeightRange;
    const sunX = Math.cos(sunAngle) * this._sunRadius;
    const sunZ = Math.sin(sunAngle) * this._sunRadius;
    const sunAltitude = Math.sin(sunAngle);
    const skySunDirection = normalizeDirection(-sunX, -sunHeight, -sunZ);
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
    this._world.setSkySunDirection(skySunDirection);
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
    const nextWeatherPreset = this._mode === 'cycle'
      ? (
        this._weatherEnabled
          ? this._calculateWeatherPreset()
          : this._weatherPreset
      )
      : this._presetWeatherOverride ?? ENVIRONMENT_PRESET_DEFINITIONS[this._preset].weatherPreset;
    const weatherChanged = !this._weatherPresetApplied || this._weatherPreset !== nextWeatherPreset;

    this._weatherPreset = nextWeatherPreset;

    if (this._ensureProceduralSky || this._world.skyboxUri.startsWith(PROCEDURAL_SKY_PREFIX)) {
      const baseSkyboxUri = this._world.skyboxUri.startsWith(PROCEDURAL_SKY_PREFIX)
        ? this._world.skyboxUri
        : this._proceduralSkyUri;
      const nextSkyboxUri = this._mode === 'cycle'
        ? buildProceduralSkyUriWithWeather(baseSkyboxUri, this._weatherPreset)
        : buildProceduralSkyUriWithPreset(baseSkyboxUri, this._preset, this._presetWeatherOverride);

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
