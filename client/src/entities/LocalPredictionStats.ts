const LOCAL_PREDICTION_TRACE_INTERVAL_MS = 100;
const LOCAL_PREDICTION_TRACE_MAX_ENTRIES = 300;

declare global {
  interface Window {
    __localPredictionTrace?: {
      clear: () => void;
      dump: () => string;
      entries: () => string[];
      latest: () => string;
    };
  }
}

export default class LocalPredictionStats {
  public static entityId: number = -1;
  public static supportsInputAcknowledgements: boolean = false;
  public static bufferedCommandCount: number = 0;
  public static lastAcknowledgedInputSequenceNumber: number = -1;
  public static lastReplayCommandCount: number = 0;
  public static lastReplaySubstepCount: number = 0;
  public static peakReplayCommandCount: number = 0;
  public static peakReplaySubstepCount: number = 0;
  public static horizontalError: number = 0;
  public static verticalError: number = 0;
  public static rotationErrorDeg: number = 0;
  public static lastReconcileMode: string = 'none';
  public static softReconcileCount: number = 0;
  public static snapReconcileCount: number = 0;
  public static forcedActiveReconcileCount: number = 0;
  public static deferredActiveReconcileCount: number = 0;
  public static motionBasisHorizontalSpeed: number = 0;
  public static motionBasisVertical: number = 0;
  public static authoritativeGrounded: boolean = false;
  public static predictedGrounded: boolean = false;
  public static groundedMismatch: boolean = false;
  public static authoritativeGroundedTransitionCount: number = 0;
  public static predictedGroundedTransitionCount: number = 0;
  public static authoritativeGroundFootOffset: number = 0;
  public static predictedGroundFootOffset: number = 0;
  public static traceEntryCount: number = 0;
  public static latestTraceLine: string = '-';
  private static _traceEntries: string[] = [];
  private static _lastTraceAtMs: number = 0;

  public static reset(): void {
    LocalPredictionStats.entityId = -1;
    LocalPredictionStats.supportsInputAcknowledgements = false;
    LocalPredictionStats.bufferedCommandCount = 0;
    LocalPredictionStats.lastAcknowledgedInputSequenceNumber = -1;
    LocalPredictionStats.lastReplayCommandCount = 0;
    LocalPredictionStats.lastReplaySubstepCount = 0;
    LocalPredictionStats.peakReplayCommandCount = 0;
    LocalPredictionStats.peakReplaySubstepCount = 0;
    LocalPredictionStats.horizontalError = 0;
    LocalPredictionStats.verticalError = 0;
    LocalPredictionStats.rotationErrorDeg = 0;
    LocalPredictionStats.lastReconcileMode = 'none';
    LocalPredictionStats.softReconcileCount = 0;
    LocalPredictionStats.snapReconcileCount = 0;
    LocalPredictionStats.forcedActiveReconcileCount = 0;
    LocalPredictionStats.deferredActiveReconcileCount = 0;
    LocalPredictionStats.motionBasisHorizontalSpeed = 0;
    LocalPredictionStats.motionBasisVertical = 0;
    LocalPredictionStats.authoritativeGrounded = false;
    LocalPredictionStats.predictedGrounded = false;
    LocalPredictionStats.groundedMismatch = false;
    LocalPredictionStats.authoritativeGroundedTransitionCount = 0;
    LocalPredictionStats.predictedGroundedTransitionCount = 0;
    LocalPredictionStats.authoritativeGroundFootOffset = 0;
    LocalPredictionStats.predictedGroundFootOffset = 0;
    LocalPredictionStats.clearTrace();
    LocalPredictionStats._installTraceHelpers();
  }

  public static maybeRecordTrace(): void {
    LocalPredictionStats._installTraceHelpers();

    if (LocalPredictionStats.entityId < 0) {
      return;
    }

    const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if ((nowMs - LocalPredictionStats._lastTraceAtMs) < LOCAL_PREDICTION_TRACE_INTERVAL_MS) {
      return;
    }

    LocalPredictionStats._lastTraceAtMs = nowMs;

    const line =
      `t=${(nowMs / 1000).toFixed(2)} ` +
      `entity=${LocalPredictionStats.entityId} ` +
      `buf=${LocalPredictionStats.bufferedCommandCount} ` +
      `replay=${LocalPredictionStats.lastReplayCommandCount}/${LocalPredictionStats.lastReplaySubstepCount} ` +
      `err=${LocalPredictionStats.horizontalError.toFixed(3)},${LocalPredictionStats.verticalError.toFixed(3)},${LocalPredictionStats.rotationErrorDeg.toFixed(2)} ` +
      `rec=${LocalPredictionStats.lastReconcileMode} ` +
      `soft=${LocalPredictionStats.softReconcileCount} ` +
      `snap=${LocalPredictionStats.snapReconcileCount} ` +
      `force=${LocalPredictionStats.forcedActiveReconcileCount} ` +
      `defer=${LocalPredictionStats.deferredActiveReconcileCount} ` +
      `basis=${LocalPredictionStats.motionBasisHorizontalSpeed.toFixed(3)},${LocalPredictionStats.motionBasisVertical.toFixed(3)} ` +
      `ground=${LocalPredictionStats.authoritativeGrounded ? 1 : 0}/${LocalPredictionStats.predictedGrounded ? 1 : 0}/${LocalPredictionStats.groundedMismatch ? 1 : 0} ` +
      `gtrans=${LocalPredictionStats.authoritativeGroundedTransitionCount}/${LocalPredictionStats.predictedGroundedTransitionCount} ` +
      `foot=${LocalPredictionStats.authoritativeGroundFootOffset.toFixed(3)}/${LocalPredictionStats.predictedGroundFootOffset.toFixed(3)}`;

    LocalPredictionStats._traceEntries.push(line);
    if (LocalPredictionStats._traceEntries.length > LOCAL_PREDICTION_TRACE_MAX_ENTRIES) {
      LocalPredictionStats._traceEntries.shift();
    }

    LocalPredictionStats.traceEntryCount = LocalPredictionStats._traceEntries.length;
    LocalPredictionStats.latestTraceLine = line;
  }

  public static clearTrace(): void {
    LocalPredictionStats._traceEntries = [];
    LocalPredictionStats._lastTraceAtMs = 0;
    LocalPredictionStats.traceEntryCount = 0;
    LocalPredictionStats.latestTraceLine = '-';
  }

  private static _installTraceHelpers(): void {
    if (typeof window === 'undefined' || window.__localPredictionTrace) {
      return;
    }

    window.__localPredictionTrace = {
      clear: () => LocalPredictionStats.clearTrace(),
      dump: () => LocalPredictionStats._traceEntries.join('\n'),
      entries: () => [...LocalPredictionStats._traceEntries],
      latest: () => LocalPredictionStats.latestTraceLine,
    };
  }
}
