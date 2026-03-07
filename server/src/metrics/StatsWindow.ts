export interface StatsWindowSnapshot {
  average: number;
  count: number;
  max: number;
  min: number;
  p50: number;
  p95: number;
  sampleCount: number;
}

const DEFAULT_STATS_WINDOW_CAPACITY = 256;

export default class StatsWindow {
  private _capacity: number;
  private _nextIndex: number = 0;
  private _sampleCount: number = 0;
  private _samples: number[] = [];
  private _total: number = 0;

  public constructor(capacity: number = DEFAULT_STATS_WINDOW_CAPACITY) {
    this._capacity = Math.max(1, Math.floor(capacity));
  }

  public clear(): void {
    this._nextIndex = 0;
    this._sampleCount = 0;
    this._samples.length = 0;
    this._total = 0;
  }

  public record(sample: number): void {
    if (!Number.isFinite(sample)) {
      return;
    }

    if (this._samples.length < this._capacity) {
      this._samples.push(sample);
      this._total += sample;
      this._sampleCount++;
      return;
    }

    this._total -= this._samples[this._nextIndex];
    this._samples[this._nextIndex] = sample;
    this._total += sample;
    this._nextIndex = (this._nextIndex + 1) % this._capacity;
    this._sampleCount++;
  }

  public snapshot(): StatsWindowSnapshot {
    if (this._samples.length === 0) {
      return {
        average: 0,
        count: 0,
        max: 0,
        min: 0,
        p50: 0,
        p95: 0,
        sampleCount: 0,
      };
    }

    const sortedSamples = Array.from(this._samples).sort((a, b) => a - b);

    return {
      average: this._total / this._samples.length,
      count: this._sampleCount,
      max: sortedSamples[sortedSamples.length - 1],
      min: sortedSamples[0],
      p50: this._quantile(sortedSamples, 0.5),
      p95: this._quantile(sortedSamples, 0.95),
      sampleCount: this._samples.length,
    };
  }

  private _quantile(sortedSamples: number[], quantile: number): number {
    if (sortedSamples.length === 1) {
      return sortedSamples[0];
    }

    const index = Math.max(0, Math.min(sortedSamples.length - 1, Math.ceil((sortedSamples.length - 1) * quantile)));
    return sortedSamples[index];
  }
}
