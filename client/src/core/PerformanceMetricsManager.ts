import { Timer } from 'three';

declare global {
  interface Performance {
    memory?: {
      jsHeapSizeLimit: number;
      totalJSHeapSize: number;
      usedJSHeapSize: number;
    };
  }
}

const FPS_UPDATE_INTERVAL_IN_SEC = 1.0;

// Measures the refresh rate used by requestAnimationFrame(). Since there's no way to directly
// get the refresh rate in JavaScript, we estimate it by running requestAnimationFrame() for
// SAMPLE_COUNT frames.
//
// To account for outliers—frames where delta time may significantly deviate due to various
// reasons we ignore the top and bottom OUTLIER_RATIO portions of the samples. A smarter
// approach could involve checking variance.
//
// Finally, we take the measured average and round it to the nearest commonly used refresh rate
// to determine the assumed refresh rate.
const SAMPLE_COUNT = 30;
const OUTLIER_RATIO: number = 0.1;
// TODO: What if a refresh rate is used that isn't included in this list?
const COMMON_REFRESH_RATES: number[] = [30, 60, 72, 90, 120, 144, 165, 240, 300, 360];
const DEFAULT_REFRESH_RATE = 60;

// Collects frame deltas for a specified number of frames,
// computes the average FPS with optional outlier trimming,
// and then snaps that FPS value to the nearest common refresh rate.
// Measurement is performed only when the tab is active because refresh intervals can be much
// longer when the tab is inactive compared to when it's active.
// TODO: Measures until SAMPLE_COUNT is reached, but pauses if the tab is inactive.
// As a result, if the tab remains inactive, this function will never complete.
// Should we consider adding a timeout?
const estimateRefreshRate = (): Promise<number> => {
  return new Promise(resolve => {
    let lastTimestamp: number | null = null;
    const deltas: number[] = [];

    const step = () => {
      if (document.visibilityState === 'visible') {
        const timestamp = performance.now();

        if (lastTimestamp !== null) {
          deltas.push(timestamp - lastTimestamp);
          if (deltas.length >= SAMPLE_COUNT) {
            finalize();
            return;
          }
        }

        lastTimestamp = timestamp;
      } else {
        lastTimestamp = null;
      }

      requestAnimationFrame(step);
    };

    const handleVisibilityChange = () => {
      // If any frame occurs while the tab is inactive, its refresh rate can't be trusted. By
      // setting lastTimestamp to null, we ensure that such frames are ignored.
      lastTimestamp = null;
    };

    const finalize = () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);

      const trimCount = Math.floor(deltas.length * OUTLIER_RATIO);
      const filtered = deltas.sort((a, b) => a - b).slice(trimCount, deltas.length - trimCount);
      const avgDelta = filtered.reduce((acc, cur) => acc + cur, 0) / filtered.length;
      const measuredFps = 1000 / avgDelta;

      let nearestRate = COMMON_REFRESH_RATES[0];
      let minDiff = Math.abs(measuredFps - nearestRate);

      for (let i = 1; i < COMMON_REFRESH_RATES.length; i++) {
        const rate = COMMON_REFRESH_RATES[i];
        const diff = Math.abs(measuredFps - rate);
        if (diff < minDiff) {
          nearestRate = rate;
          minDiff = diff;
        }
      }

      resolve(nearestRate);
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    requestAnimationFrame(step);
  });
};

export default class PerformanceMetricsManager {
  private _timer: Timer;
  private _frameCount: number = 0;
  private _frameCountSinceLastFPSUpdate: number = 0;
  private _elapsedTime: number = 0;
  private _elapsedTimeSinceLastUpdate: number = 0;
  private _fps: number = 0;
  private _deltaTime: number = 0;
  private _usedMemory: number = 0;
  private _totalMemory: number = 0;
  private static _refreshRate: number | null = null;

  // Intended to run only once when no heavy processing is occurring.
  // Potential concerns:
  // * What if heavy background processing happens to run during measurement, causing inaccurate refresh rate detection?
  // * What if the refresh rate changes during app runtime, for example due to a battery mode switch?
  public static async measureRefreshRate(): Promise<number> {
    // Right after the client (web page) launches, the refresh rate may be unstable. To account
    // for this, we wait briefly before starting the measurement.
    await new Promise(resolve => { setTimeout(resolve, 500); });

    const refreshRate = await estimateRefreshRate();

    PerformanceMetricsManager._refreshRate = refreshRate;
    return PerformanceMetricsManager._refreshRate;
  }

  constructor() {
    this._timer = new Timer();

    if (typeof document !== 'undefined') {
      this._timer.connect(document);
    }
  }

  // Delta time measurement is separated from other update processes. This makes
  // it possible to control the refresh rate.
  public measureDeltaTime(): number {
    this._timer.update();
    const deltaTime = this._timer.getDelta();
    this._elapsedTimeSinceLastUpdate += deltaTime;
    return deltaTime;
  }

  public update(): void {
    this._deltaTime = this._elapsedTimeSinceLastUpdate;;
    this._elapsedTimeSinceLastUpdate = 0;

    this._elapsedTime += this._deltaTime;
    this._frameCount++;
    this._frameCountSinceLastFPSUpdate++;

    const memory = performance.memory;
    if (memory) {
      this._usedMemory = memory.usedJSHeapSize;
      this._totalMemory = memory.totalJSHeapSize;
    }

    if (this._elapsedTime >= FPS_UPDATE_INTERVAL_IN_SEC) {
      this._fps = Math.round(this._frameCountSinceLastFPSUpdate / this._elapsedTime);
      this._frameCountSinceLastFPSUpdate = 0;
      this._elapsedTime = 0;
    }
  }

  public get refreshRate(): number {
    return PerformanceMetricsManager._refreshRate ?? DEFAULT_REFRESH_RATE;
  }

  public get fps(): number {
    return this._fps;
  }

  // Note that this represents the time between update() executions.
  public get deltaTime(): number {
    return this._deltaTime;
  }

  public get elapsedTimeSinceLastUpdate(): number {
    return this._elapsedTimeSinceLastUpdate;
  }

  public get frameCount(): number {
    return this._frameCount;
  }

  public get usedMemory(): number {
    return this._usedMemory;
  }

  public get totalMemory(): number {
    return this._totalMemory;
  }
} 
