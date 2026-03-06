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
  }
}
