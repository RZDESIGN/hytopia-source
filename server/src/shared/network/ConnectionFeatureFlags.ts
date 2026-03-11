/**
 * Bit flags negotiated between the server and a client connection.
 *
 * @public
 */
export enum ConnectionFeatureFlag {
  SceneInteract = 1 << 0,
  DefaultBlockEditPrediction = 1 << 1,
}

export type NegotiatedConnectionFeatures = {
  supportsSceneInteract: boolean;
  supportsDefaultBlockEditPrediction: boolean;
};

/**
 * Default maximum raycast distance used by block edit prediction helpers.
 *
 * @public
 */
export const DEFAULT_BLOCK_EDIT_PREDICTION_MAX_DISTANCE = 5;

/**
 * Default block ID used by block edit prediction helpers when placing a block.
 *
 * @public
 */
export const DEFAULT_BLOCK_EDIT_PREDICTION_PLACE_BLOCK_ID = 3;

/**
 * Owner-only client prediction settings for stock block break/place helpers.
 *
 * @public
 */
export type DefaultBlockEditPredictionConfig = {
  maxDistance: number;
  placeBlockTypeId: number;
  placeBlockRotationIndex?: number;
};

/**
 * Creates the default client block edit prediction config used by stock helpers.
 *
 * @public
 */
export const createDefaultBlockEditPredictionConfig = (): DefaultBlockEditPredictionConfig => ({
  maxDistance: DEFAULT_BLOCK_EDIT_PREDICTION_MAX_DISTANCE,
  placeBlockTypeId: DEFAULT_BLOCK_EDIT_PREDICTION_PLACE_BLOCK_ID,
});

let connectionFeatureFlags =
  ConnectionFeatureFlag.SceneInteract;

/**
 * Enables a connection feature bit in the server-wide negotiation mask.
 *
 * @public
 */
export const enableConnectionFeature = (
  featureFlag: ConnectionFeatureFlag,
): void => {
  connectionFeatureFlags |= featureFlag;
};

/**
 * Disables a connection feature bit in the server-wide negotiation mask.
 *
 * @public
 */
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
