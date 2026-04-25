import EventRouter from '../events/EventRouter';
import Game from "../Game";
import MobileManager from "../mobile/MobileManager";
import type { TerrainMeshingMode } from '../workers/ChunkWorkerConstants';

export enum ClientSettingsEventType {
  Update = 'CLIENT_SETTINGS.UPDATE',
}

export namespace ClientSettingsEventPayload {
  export interface IUpdate {}
}

export const enum DistantBlockViewMode {
  Sharp = 0, // Sharp but more moiré patterns
  Smooth = 1, // Smooth but blurrier
};

type QualityPerfTradeoff = {
  antialias: boolean,
  blobShadows?: {
    enabled: boolean;
  },
  terrainMeshing: {
    mode: TerrainMeshingMode;
  },
  shadows?: {
    enabled: boolean;
    type: 'pcf' | 'vsm';
    directionalDistance: number;
    directionalMapSize: number;
    spotlightMapSize: number;
    maxSpotlightShadows: number;
  },
  resolution: {
    multiplier: number,
  },
  viewDistance: {
    enabled: boolean;
    distance: number;
    fog: {
      enabled: boolean;
      far: number;
      near: number;
    },
  },
  environmentalAnimations?: {
    enabled: boolean;
  },
  fpsCap?: number,
  localReflections?: {
    enabled: boolean;
    maxSkyExposure: number;
    positionDelta: number;
    textureSize: number;
    updateIntervalS: number;
  },
  postProcessing?: {
    atmosphere?: {
      cloudShadowStrength: number;
      enabled: boolean;
      heightFogDensity: number;
      heightFogHeightFalloff: number;
      sunInscatterStrength: number;
    };
    outline?: boolean;
    bloom?: boolean;
    gtao?: {
      enabled: boolean;
      maxDistance: number;
      strength: number;
      worldRadius: number;
    };
    lut?: {
      enabled: boolean;
      intensity: number;
    };
    smaa?: boolean;
    taa?: {
      enabled: boolean;
      historyWeight: number;
      sharpenStrength: number;
    };
  },
};

export type ClientSettings = {
  controls: {
    gamepadSensitivityForRotation: number,
    invertVerticalLook: boolean,
    mouseSensitivityForRotation: number,
    pinchSensitivityForZoom: number,
    touchSensitivityForRotation: number,
    wheelSensitivityForZoom: number,
  },
  distantBlockViewMode: DistantBlockViewMode,
  qualityPerfTradeoff: QualityPerfTradeoff,
};

// Preset levels to balance visual quality and performance, switching dynamically
// based on FPS.
// TODO: Consider allowing users to opt out of the automatic switching feature.
export const QUALITY_PRESETS: Record<string, QualityPerfTradeoff> = {
  ULTRA: {
    antialias: true,
    blobShadows: {
      enabled: false,
    },
    terrainMeshing: {
      mode: 'fast',
    },
    shadows: {
      enabled: true,
      type: 'pcf',
      directionalDistance: 40,
      directionalMapSize: 768,
      spotlightMapSize: 512,
      maxSpotlightShadows: 1,
    },
    resolution: { multiplier: 1.3 },
    viewDistance: {
      enabled: true,
      distance: 450,
      fog: { enabled: true, far: 400, near: 340 },
    },
    postProcessing: {
      atmosphere: {
        enabled: false,
        cloudShadowStrength: 0.0,
        heightFogDensity: 0.0,
        heightFogHeightFalloff: 0.052,
        sunInscatterStrength: 0.0,
      },
      outline: true,
      bloom: true,
      gtao: {
        enabled: false,
        maxDistance: 72,
        strength: 0.38,
        worldRadius: 5.1,
      },
      lut: {
        enabled: false,
        intensity: 0.0,
      },
      smaa: true,
      taa: {
        enabled: false,
        historyWeight: 0.0,
        sharpenStrength: 0.0,
      },
    },
    localReflections: {
      enabled: false,
      maxSkyExposure: 0.0,
      positionDelta: 2.2,
      textureSize: 192,
      updateIntervalS: 1.6,
    },
  },
  HIGH: {
    antialias: true,
    blobShadows: {
      enabled: false,
    },
    terrainMeshing: {
      mode: 'fast',
    },
    shadows: {
      enabled: true,
      type: 'pcf',
      directionalDistance: 40,
      directionalMapSize: 768,
      spotlightMapSize: 512,
      maxSpotlightShadows: 1,
    },
    resolution: { multiplier: 1.05 },
    viewDistance: {
      enabled: true,
      distance: 250,
      fog: { enabled: true, far: 230, near: 185 },
    },
    postProcessing: {
      atmosphere: {
        enabled: false,
        cloudShadowStrength: 0.0,
        heightFogDensity: 0.0,
        heightFogHeightFalloff: 0.062,
        sunInscatterStrength: 0.0,
      },
      outline: true,
      bloom: true,
      gtao: {
        enabled: false,
        maxDistance: 52,
        strength: 0.32,
        worldRadius: 4.1,
      },
      lut: {
        enabled: false,
        intensity: 0.0,
      },
      smaa: true,
      taa: {
        enabled: false,
        historyWeight: 0.0,
        sharpenStrength: 0.0,
      },
    },
    localReflections: {
      enabled: false,
      maxSkyExposure: 0.0,
      positionDelta: 2.8,
      textureSize: 128,
      updateIntervalS: 2.4,
    },
  },
  // Medium and below favor faster terrain meshing to keep large worlds responsive.
  MEDIUM: {
    antialias: true,
    blobShadows: {
      enabled: false,
    },
    terrainMeshing: {
      mode: 'fast',
    },
    shadows: {
      enabled: true,
      type: 'pcf',
      directionalDistance: 40,
      directionalMapSize: 768,
      spotlightMapSize: 384,
      maxSpotlightShadows: 1,
    },
    resolution: { multiplier: 0.85 },
    viewDistance: {
      enabled: true,
      distance: 160,
      fog: { enabled: true, far: 145, near: 112 },
    },
    environmentalAnimations: {
      enabled: false,
    },
    postProcessing: {
      atmosphere: {
        enabled: false,
        cloudShadowStrength: 0.0,
        heightFogDensity: 0.0,
        heightFogHeightFalloff: 0.08,
        sunInscatterStrength: 0.0,
      },
      outline: true,
      bloom: true,
      gtao: {
        enabled: false,
        maxDistance: 38,
        strength: 0.22,
        worldRadius: 3.2,
      },
      lut: {
        enabled: false,
        intensity: 0.0,
      },
      smaa: false,
      taa: {
        enabled: false,
        historyWeight: 0.0,
        sharpenStrength: 0.0,
      },
    },
    localReflections: {
      enabled: false,
      maxSkyExposure: 0.0,
      positionDelta: 4.0,
      textureSize: 96,
      updateIntervalS: 3.0,
    },
  },
  LOW: {
    // In performance-prioritized settings, setting antialias to false is preferable as it reduces
    // GPU load. However, there is currently a crash issue on mobile platforms that appears to be
    // triggered during WebGL renderer recreation. Since the current implementation recreates
    // the renderer when the antialias setting is toggled, we avoid this by keeping antialias
    // always true. Once the root cause of the crash is resolved, we can revisit the option
    // of setting antialias to false.
    antialias: true,
    blobShadows: {
      enabled: true,
    },
    terrainMeshing: {
      mode: 'fast',
    },
    shadows: {
      enabled: false,
      type: 'pcf',
      directionalDistance: 32,
      directionalMapSize: 512,
      spotlightMapSize: 256,
      maxSpotlightShadows: 0,
    },
    resolution: { multiplier: 0.7 },
    viewDistance: {
      enabled: true,
      distance: 100,
      fog: { enabled: true, far: 90, near: 68 },
    },
    environmentalAnimations: {
      enabled: false,
    },
    postProcessing: {
      atmosphere: {
        enabled: false,
        cloudShadowStrength: 0.0,
        heightFogDensity: 0.0,
        heightFogHeightFalloff: 0.08,
        sunInscatterStrength: 0.0,
      },
      outline: true,
      gtao: {
        enabled: false,
        maxDistance: 32,
        strength: 0.2,
        worldRadius: 2.8,
      },
      lut: {
        enabled: false,
        intensity: 0.0,
      },
      taa: {
        enabled: false,
        historyWeight: 0.0,
        sharpenStrength: 0.0,
      },
    },
    localReflections: {
      enabled: false,
      maxSkyExposure: 0.0,
      positionDelta: 4.0,
      textureSize: 96,
      updateIntervalS: 3.0,
    },
  },
  POWER_SAVING: {
    antialias: true,
    blobShadows: {
      enabled: true,
    },
    terrainMeshing: {
      mode: 'fast',
    },
    shadows: {
      enabled: false,
      type: 'pcf',
      directionalDistance: 32,
      directionalMapSize: 512,
      spotlightMapSize: 256,
      maxSpotlightShadows: 0,
    },
    resolution: { multiplier: 0.5 },
    viewDistance: {
      enabled: true,
      distance: 56,
      fog: { enabled: true, far: 54, near: 32 },
    },
    environmentalAnimations: {
      enabled: false,
    },
    postProcessing: {
      atmosphere: {
        enabled: false,
        cloudShadowStrength: 0.0,
        heightFogDensity: 0.0,
        heightFogHeightFalloff: 0.08,
        sunInscatterStrength: 0.0,
      },
      outline: true,
      gtao: {
        enabled: false,
        maxDistance: 24,
        strength: 0.18,
        worldRadius: 2.4,
      },
      lut: {
        enabled: false,
        intensity: 0.0,
      },
      taa: {
        enabled: false,
        historyWeight: 0.0,
        sharpenStrength: 0.0,
      },
    },
    localReflections: {
      enabled: false,
      maxSkyExposure: 0.0,
      positionDelta: 4.0,
      textureSize: 96,
      updateIntervalS: 3.0,
    },
    fpsCap: 30,
  },
};

// POWER_SAVING remains excluded from automatic control. ULTRA is allowed on desktop so
// sustained high FPS can promote beyond HIGH when the device can afford it.
const AUTOMATIC_QUALITY_LEVELS: (keyof typeof QUALITY_PRESETS)[] = ['ULTRA', 'HIGH', 'MEDIUM', 'LOW'];

// The default quality level is currently hardcoding to HIGH or MEDIUM, but
// it might also be a good idea to save the adjusted quality level to LocalStorage or
// elsewhere, and load it when the client starts. This would allow the game to resume at an
// appropriate quality level.
const DEFAULT_QUALITY_LEVEL: keyof typeof QUALITY_PRESETS = 'MEDIUM';

// TODO: Introduce a Client settings UI or something similar to allow users to intuitively update the settings.
const DEFAULT_CLIENT_SETTINGS: ClientSettings = {
  controls: {
    gamepadSensitivityForRotation: 4.5,
    invertVerticalLook: false,
    mouseSensitivityForRotation: 0.0025,
    pinchSensitivityForZoom: 0.05,
    touchSensitivityForRotation: 0.008,
    wheelSensitivityForZoom: 0.1,
  },
  distantBlockViewMode: DistantBlockViewMode.Sharp,
  qualityPerfTradeoff: { ...QUALITY_PRESETS[DEFAULT_QUALITY_LEVEL] },
};

// If the FPS remains at the ideal FPS for a certain period, increase the quality level by one.
// However, even when there are no performance issues, FPS can often drop slightly below the ideal
// FPS, so we allow a small margin below the ideal FPS as specified.
const HIGH_FPS_THRESHOLD_OFFSET = 1.0;

// When performance drops to the point where responsiveness starts to noticeably degrade, we want
// to lower the quality level. On standard 60Hz displays, a 30 FPS fallback still makes sense.
// On high-refresh displays though, waiting until 30 FPS is far too late and leaves the game
// feeling sluggish for a long time. Use a more aggressive relative threshold there.
const LOW_FPS_THRESHOLD = 30;
const LOW_FPS_THRESHOLD_RATIO = 0.50;
const HIGH_REFRESH_RATE_THRESHOLD = 100;
const HIGH_REFRESH_LOW_FPS_THRESHOLD_RATIO = 0.75;
const HIGH_REFRESH_QUALITY_DOWN_TIME_THRESHOLD = 1.0;

// If the FPS stays above or below the threshold for the specified duration, we attempt to adjust
// quality. Since increasing quality might degrade performance and force us to revert it
// later, we apply upgrades more cautiously than downgrades.
const QUALITY_UP_TIME_THRESHOLD = 3;
const QUALITY_DOWN_TIME_THRESHOLD = 3;

// Client and game initialization involve many heavy processes, often causing FPS to drop.
// Using FPS values during this time may lead to unnecessarily lowering quality. To avoid this,
// quality changes are disabled for a set time after receiving the World Packet.
const QUALITY_ADJUSTMENT_WARMUP_TIME = 5;

// Good FPS may trigger a quality increase, which could then lower FPS and cause a downgrade,
// potentially leading to repeated up/down quality switches. This can cause visible flickering
// or performance overhead from quality changes, hurting the user experience. To avoid this,
// we set a maximum number of quality adjustment attempts.
const MAX_QUALITY_BOUNCE_COUNT = 5;

// A max quality level to prevent quality bouncing. Mobile stays capped at MEDIUM for
// stability, while desktop can now climb to ULTRA through automatic adjustment.
const MAX_QUALITY_LEVEL: keyof typeof QUALITY_PRESETS = MobileManager.isMobile ? 'MEDIUM' : 'ULTRA';

type PerformanceStats = {
  duration: number;
  durationThreshold: number;
  thresholdExceeded: boolean;
};

const INCREASE_QUALITY = -1;
const DECREASE_QUALITY = 1;
type QualityChange = typeof INCREASE_QUALITY | typeof DECREASE_QUALITY;

export default class SettingsManager {
  private _game: Game;
  private _autoAdjustment: boolean = true;
  private _clientSettings: ClientSettings;
  private _currentPresetLevel: keyof typeof QUALITY_PRESETS = DEFAULT_QUALITY_LEVEL;
  private _elapsedTimeSinceWorldPacketReceived: number = 0;
  private _highFpsStats: PerformanceStats = {
    duration: 0,
    durationThreshold: QUALITY_UP_TIME_THRESHOLD,
    thresholdExceeded: false,
  };
  private _inWarmUp: boolean = true;
  private _lowFpsStats: PerformanceStats = {
    duration: 0,
    durationThreshold: QUALITY_DOWN_TIME_THRESHOLD,
    thresholdExceeded: false,
  };
  // Used to control the max number of quality adjustment attempts. While it's not necessary
  // to track every single change, it's implemented that way for simplicity. Currently, there's
  // no limit on the number of records, but since quality changes shouldn't occur too frequently,
  // memory usage likely won't be an issue in practice. If it becomes a problem, we'll address
  // it then.
  private _levelChangeHistory: QualityChange[] = [];

  constructor(game: Game) {
    this._game = game;
    this._clientSettings = {
      ...DEFAULT_CLIENT_SETTINGS,
      qualityPerfTradeoff: this._applyMobileOverrides({ ...DEFAULT_CLIENT_SETTINGS.qualityPerfTradeoff }),
    };
  }

  public get clientSettings(): ClientSettings { return this._clientSettings; }
  public get qualityPerfTradeoff(): QualityPerfTradeoff { return this._clientSettings.qualityPerfTradeoff; }
  public get qualityPresetLevel(): keyof typeof QUALITY_PRESETS { return this._currentPresetLevel; }
  public get terrainMeshingMode(): TerrainMeshingMode { return this._clientSettings.qualityPerfTradeoff.terrainMeshing.mode; }

  public setDistantBlockViewMode(mode: DistantBlockViewMode): void {
    this._clientSettings.distantBlockViewMode = mode;
    this._emitUpdateEvent();
  }

  public setInvertVerticalLook(invert: boolean): void {
    this._clientSettings.controls = {
      ...this._clientSettings.controls,
      invertVerticalLook: invert,
    };
  }

  private _emitUpdateEvent(): void {
    EventRouter.instance.emit(ClientSettingsEventType.Update, {});
  }

  private _applyMobileOverrides(tradeoff: QualityPerfTradeoff): QualityPerfTradeoff {
    if (!MobileManager.isMobile) return tradeoff;

    const result = { ...tradeoff };

    // Cap shadow map sizes to save fill rate on mobile GPUs while keeping
    // real-time shadows active (PCF at 512 still looks good on small screens).
    if (result.shadows?.enabled) {
      result.shadows = {
        ...result.shadows,
        directionalMapSize: Math.min(result.shadows.directionalMapSize, 512),
        spotlightMapSize: Math.min(result.shadows.spotlightMapSize, 256),
        maxSpotlightShadows: Math.min(result.shadows.maxSpotlightShadows, 1),
      };
    }

    // Blob shadows as cheap fallback when real shadow maps are off.
    if (!result.shadows?.enabled) {
      result.blobShadows = { enabled: true };
    }

    // Bloom is a full-screen post-processing pass that is expensive on mobile
    // tile-based GPUs due to extra render target resolve/load cycles.
    if (result.postProcessing?.bloom) {
      result.postProcessing = { ...result.postProcessing, bloom: false };
    }

    // Pull in view distance on mobile to reduce draw calls and chunk geometry.
    if (result.viewDistance.enabled && result.viewDistance.distance > 130) {
      const ratio = 130 / result.viewDistance.distance;
      result.viewDistance = {
        ...result.viewDistance,
        distance: 130,
        fog: {
          ...result.viewDistance.fog,
          near: Math.round(result.viewDistance.fog.near * ratio),
          far: Math.round(result.viewDistance.fog.far * ratio),
        },
      };
    }

    return result;
  }

  private _changeQualityIfNeeded(condition: boolean, deltaTime: number, stats: PerformanceStats, change: QualityChange): void {
    let resetDuration = true;

    // It seems that on some platforms, requestAnimationFrame() may still fire at a slower rate
    // even when the tab is inactive. If we base quality switching on FPS during that time, it
    // could lead to unnecessarily lowering quality. To prevent this, we explicitly check whether
    // the tab is active and only allow switching when it is.
    if (condition && document.visibilityState === 'visible') {
      // The duration is measured from when FPS first exceeds or drops below the threshold.
      // Otherwise, a single-frame FPS drop such as when switching back to an inactive tab could
      // immediately trigger a quality change. This can happen because requestAnimationFrame()
      // typically doesn't fire while the tab is inactive.
      if (stats.thresholdExceeded) {
        stats.duration += deltaTime;
        // Currently, quality changes are based solely on how long the FPS stays above or below the threshold.
        // However, this could be improved. For example, using the average FPS or considering its
        // variance might allow for more stable quality control, even during sudden FPS fluctuations.
        if (stats.duration >= stats.durationThreshold) {
          this._updateQualitySettings(change);
          stats.thresholdExceeded = false;
        } {
          resetDuration = false;
        }
      } else {
        stats.thresholdExceeded = true;
      }
    } else {
      stats.thresholdExceeded = false;
    }

    if (resetDuration) {
      stats.duration = 0;
    }
  }

  public update(): void {
    const { deltaTime, fps } = this._game.performanceMetricsManager;

    if (this._inWarmUp) {
      if (this._game.networkManager.worldPacketReceived) {
        this._elapsedTimeSinceWorldPacketReceived += deltaTime;
        if (this._elapsedTimeSinceWorldPacketReceived >= QUALITY_ADJUSTMENT_WARMUP_TIME) {
          this._inWarmUp = false;
        }
      }
      if (this._inWarmUp) {
        return;
      }
    }

    if (!this._autoAdjustment) {
      return;
    }

    const targetFps = this._game.performanceMetricsManager.refreshRate;

    if (!targetFps) return;

    this._lowFpsStats.durationThreshold =
      targetFps >= HIGH_REFRESH_RATE_THRESHOLD
        ? HIGH_REFRESH_QUALITY_DOWN_TIME_THRESHOLD
        : QUALITY_DOWN_TIME_THRESHOLD;

    this._changeQualityIfNeeded(fps >= targetFps - HIGH_FPS_THRESHOLD_OFFSET, deltaTime, this._highFpsStats, INCREASE_QUALITY);
    this._changeQualityIfNeeded(fps < this._getLowFpsThreshold(targetFps), deltaTime, this._lowFpsStats, DECREASE_QUALITY);
  }

  public setQualityPreset(preset: keyof typeof QUALITY_PRESETS | undefined): void {
    if (preset === undefined) {
      this._autoAdjustment = true;
      return;
    }

    if (!QUALITY_PRESETS[preset]) {
      return console.warn(`SettingsManager: Invalid quality preset received by client: ${preset}`);
    }

    this._autoAdjustment = false;
    this._clientSettings.qualityPerfTradeoff = this._applyMobileOverrides({ ...QUALITY_PRESETS[preset] });
    this._currentPresetLevel = preset;

    // Reset stats for auto adjust ment in case auto adjust ment will be enabled again
    this._highFpsStats.duration = 0;
    this._highFpsStats.thresholdExceeded = false;
    this._lowFpsStats.duration = 0;
    this._lowFpsStats.thresholdExceeded = false;
    this._levelChangeHistory.length = 0;

    this._emitUpdateEvent();

    console.log('SettingsManager: Quality preset explicitly set to:', preset);
  }

  private _reachedMaxBounceCount(): boolean {
    if (this._levelChangeHistory.length < MAX_QUALITY_BOUNCE_COUNT * 2) {
      return false;
    }

    const lastIndex = this._levelChangeHistory.length - 1;
    for (let i = 0; i < MAX_QUALITY_BOUNCE_COUNT; i++) {
      if (this._levelChangeHistory[lastIndex - i * 2] !== DECREASE_QUALITY) {
        return false;
      }
      if (this._levelChangeHistory[lastIndex - i * 2 - 1] !== INCREASE_QUALITY) {
        return false;
      }
    }

    return true;
  }

  private _reachedMaxQuality(): boolean {
    return this._currentPresetLevel === MAX_QUALITY_LEVEL;
  }

  private _updateQualitySettings(change: QualityChange): void {
    const currentIndex = AUTOMATIC_QUALITY_LEVELS.indexOf(this._currentPresetLevel);
    const nextLevel = AUTOMATIC_QUALITY_LEVELS[currentIndex + change];

    if (nextLevel === undefined) {
      return;
    }

    if (change === INCREASE_QUALITY && this._reachedMaxBounceCount()) {
      return;
    }

    if (change === INCREASE_QUALITY && this._reachedMaxQuality()) {
      return;
    }

    const preset = QUALITY_PRESETS[nextLevel];

    this._clientSettings.qualityPerfTradeoff = this._applyMobileOverrides({ ...preset });
    this._currentPresetLevel = nextLevel;

    this._emitUpdateEvent();
    this._levelChangeHistory.push(change);
  }

  private _getLowFpsThreshold(targetFps: number): number {
    if (targetFps >= HIGH_REFRESH_RATE_THRESHOLD) {
      return Math.max(LOW_FPS_THRESHOLD, targetFps * HIGH_REFRESH_LOW_FPS_THRESHOLD_RATIO);
    }

    return Math.min(LOW_FPS_THRESHOLD, targetFps * LOW_FPS_THRESHOLD_RATIO);
  }
}
