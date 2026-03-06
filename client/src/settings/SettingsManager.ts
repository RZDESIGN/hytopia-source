import EventRouter from '../events/EventRouter';
import Game from "../Game";
import MobileManager from "../mobile/MobileManager";

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
  postProcessing?: {
    outline?: boolean;
    bloom?: boolean;
    smaa?: boolean;
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
      enabled: true,
    },
    resolution: { multiplier: 2.0 },
    viewDistance: {
      enabled: true,
      distance: 600,
      fog: { enabled: true, far: 550, near: 500 },
    },
    postProcessing: {
      outline: true,
      bloom: true,
      smaa: true,
    },
  },
  HIGH: {
    antialias: true,
    blobShadows: {
      enabled: true,
    },
    resolution: { multiplier: 1.5 },
    viewDistance: {
      enabled: true,
      distance: 300,
      fog: { enabled: true, far: 300, near: 250 },
    },
    postProcessing: {
      outline: true,
      bloom: true,
      smaa: true,
    },
  },
  MEDIUM: {
    antialias: true,
    blobShadows: {
      enabled: true,
    },
    resolution: { multiplier: 1.0 },
    viewDistance: {
      enabled: true,
      distance: 150,
      fog: { enabled: true, far: 150, near: 125 },
    },
    environmentalAnimations: {
      enabled: false,
    },
    postProcessing: {
      outline: true,
      bloom: true,
      smaa: true,
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
    resolution: { multiplier: 0.85 },
    viewDistance: {
      enabled: true,
      distance: 75,
      fog: { enabled: true, far: 75, near: 65 },
    },
    environmentalAnimations: {
      enabled: false,
    },
    postProcessing: {
      outline: true,
    },
  },
  POWER_SAVING: {
    antialias: true,
    blobShadows: {
      enabled: true,
    },
    resolution: { multiplier: 0.5 },
    viewDistance: {
      enabled: true,
      distance: 50,
      fog: { enabled: true, far: 50, near: 30 },
    },
    environmentalAnimations: {
      enabled: false,
    },
    postProcessing: {
      outline: true,
    },
    fpsCap: 30,
  },
};

// ULTRA and POWER_SAVING are considered overly extreme settings, so they are excluded from
// automatic control. In the future, they will only be available when explicitly selected
// by the user through manual configuration.
const AUTOMATIC_QUALITY_LEVELS: (keyof typeof QUALITY_PRESETS)[] = ['HIGH', 'MEDIUM', 'LOW'];

// The default quality level is currently hardcoding to HIGH or MEDIUM, but
// it might also be a good idea to save the adjusted quality level to LocalStorage or
// elsewhere, and load it when the client starts. This would allow the game to resume at an
// appropriate quality level.
const DEFAULT_QUALITY_LEVEL: keyof typeof QUALITY_PRESETS = MobileManager.isMobile ? 'MEDIUM' : 'HIGH';

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

// When performance drops to the point where smooth operation is no longer possible, we want
// to lower the quality level. While there's no strong evidence, using a fixed threshold around
// 30 FPS seems reasonable. However, since some platforms have a refresh rate of around 30 FPS,
// we also provide a relative threshold based on the refresh rate and use the smaller of the
// two as the final threshold.
const LOW_FPS_THRESHOLD = 30;
const LOW_FPS_THRESHOLD_RATIO = 0.50;

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

// A max quality level to prevent quality bouncing. This is mainly used to prevent quality
// bounces on mobile that may be contributing to crashes. We in the mobile case for now set
// the max quality level to MEDIUM, but we may want to revisit this later.
const MAX_QUALITY_LEVEL: keyof typeof QUALITY_PRESETS = MobileManager.isMobile ? 'MEDIUM' : 'HIGH';

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
    this._clientSettings = { ...DEFAULT_CLIENT_SETTINGS };
  }

  public get clientSettings(): ClientSettings { return this._clientSettings; }
  public get qualityPerfTradeoff(): QualityPerfTradeoff { return this._clientSettings.qualityPerfTradeoff; }
  public get qualityPresetLevel(): keyof typeof QUALITY_PRESETS { return this._currentPresetLevel; }

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

    this._changeQualityIfNeeded(fps >= targetFps - HIGH_FPS_THRESHOLD_OFFSET, deltaTime, this._highFpsStats, INCREASE_QUALITY);
    this._changeQualityIfNeeded(fps < Math.min(LOW_FPS_THRESHOLD, targetFps * LOW_FPS_THRESHOLD_RATIO), deltaTime, this._lowFpsStats, DECREASE_QUALITY);
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
    this._clientSettings.qualityPerfTradeoff = { ...QUALITY_PRESETS[preset] };
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

    this._clientSettings.qualityPerfTradeoff = { ...preset };
    this._currentPresetLevel = nextLevel;

    this._emitUpdateEvent();
    this._levelChangeHistory.push(change);
  }
}
