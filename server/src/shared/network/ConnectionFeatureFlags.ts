export enum ConnectionFeatureFlag {
  SceneInteract = 1 << 0,
}

export type NegotiatedConnectionFeatures = {
  supportsSceneInteract: boolean;
};

export const CONNECTION_FEATURE_FLAGS =
  ConnectionFeatureFlag.SceneInteract;

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
  };
};
