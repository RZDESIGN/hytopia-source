export type SimulatedPacketDirection = 'incoming' | 'outgoing';

type SimulatedPacketConfig = {
  lagMs: number;
  jitterMs: number;
  unreliableLossPct: number;
};

const SIM_NET_LAG_MS_QUERY_PARAM = 'simNetLagMs';
const SIM_NET_JITTER_MS_QUERY_PARAM = 'simNetJitterMs';
const SIM_NET_LOSS_PCT_QUERY_PARAM = 'simNetLossPct';

const clamp = (value: number, min: number, max: number): number => {
  return Math.min(max, Math.max(min, value));
};

const parseNumericSearchParam = (searchParams: URLSearchParams, key: string): number => {
  const rawValue = searchParams.get(key);
  if (rawValue === null) {
    return 0;
  }

  const parsedValue = Number(rawValue);
  if (!Number.isFinite(parsedValue)) {
    return 0;
  }

  return Math.max(0, parsedValue);
};

export default class NetworkConditionSimulator {
  private _config: SimulatedPacketConfig;
  private _nextReliableDeliveryAtMs: Record<SimulatedPacketDirection, number> = {
    incoming: 0,
    outgoing: 0,
  };

  public constructor(searchParams: URLSearchParams) {
    this._config = {
      lagMs: parseNumericSearchParam(searchParams, SIM_NET_LAG_MS_QUERY_PARAM),
      jitterMs: parseNumericSearchParam(searchParams, SIM_NET_JITTER_MS_QUERY_PARAM),
      unreliableLossPct: clamp(
        parseNumericSearchParam(searchParams, SIM_NET_LOSS_PCT_QUERY_PARAM),
        0,
        100,
      ),
    };
  }

  public get enabled(): boolean {
    return this._config.lagMs > 0 ||
      this._config.jitterMs > 0 ||
      this._config.unreliableLossPct > 0;
  }

  public describe(): string {
    return `lag=${this._config.lagMs}ms jitter=${this._config.jitterMs}ms unreliableLoss=${this._config.unreliableLossPct}%`;
  }

  public schedule(
    direction: SimulatedPacketDirection,
    reliable: boolean,
    callback: () => void,
  ): void {
    if (!this.enabled) {
      callback();
      return;
    }

    if (!reliable && this._shouldDropUnreliablePacket()) {
      return;
    }

    const deliveryDelayMs = this._sampleDeliveryDelayMs();
    if (!reliable) {
      window.setTimeout(callback, deliveryDelayMs);
      return;
    }

    const nowMs = performance.now();
    const scheduledDeliveryAtMs = Math.max(
      nowMs + deliveryDelayMs,
      this._nextReliableDeliveryAtMs[direction],
    );
    this._nextReliableDeliveryAtMs[direction] = scheduledDeliveryAtMs;

    window.setTimeout(callback, Math.max(0, scheduledDeliveryAtMs - nowMs));
  }

  private _shouldDropUnreliablePacket(): boolean {
    return Math.random() * 100 < this._config.unreliableLossPct;
  }

  private _sampleDeliveryDelayMs(): number {
    const jitterOffsetMs = this._config.jitterMs > 0
      ? ((Math.random() * 2) - 1) * this._config.jitterMs
      : 0;

    return Math.max(0, this._config.lagMs + jitterOffsetMs);
  }
}
