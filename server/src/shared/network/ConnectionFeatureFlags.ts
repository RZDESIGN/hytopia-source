export enum ConnectionFeatureFlag {
  SceneInteract = 1 << 0,
  DefaultBlockEditPrediction = 1 << 1,
}

export type NegotiatedConnectionFeatures = {
  supportsSceneInteract: boolean;
  supportsDefaultBlockEditPrediction: boolean;
};

export const DEFAULT_BLOCK_EDIT_PREDICTION_MAX_DISTANCE = 5;
export const DEFAULT_BLOCK_EDIT_PREDICTION_PLACE_BLOCK_ID = 3;

let connectionFeatureFlags =
  ConnectionFeatureFlag.SceneInteract;

export const enableConnectionFeature = (
  featureFlag: ConnectionFeatureFlag,
): void => {
  connectionFeatureFlags |= featureFlag;
};

export const disableConnectionFeature = (
  featureFlag: ConnectionFeatureFlag,
): void => {
  connectionFeatureFlags &= ~featureFlag;
};

export const getConnectionFeatureFlags = (): number => connectionFeatureFlags;

export const hasConnectionFeature = (
  flags: number | undefined,
  featureFlag: ConnectionFeatureFlag,
): boolean => {
  return ((flags ?? 0) & featureFlag) === featureFlag;
};

export const connectionFeatureFlagsToFeatures = (
  flags: number | undefined,
): NegotiatedConnectionFeatures => {
  return {
    supportsSceneInteract: hasConnectionFeature(flags, ConnectionFeatureFlag.SceneInteract),
    supportsDefaultBlockEditPrediction: hasConnectionFeature(
      flags,
      ConnectionFeatureFlag.DefaultBlockEditPrediction,
    ),
  };
};
