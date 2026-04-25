// Centralized engine-level kill switches for visibility culling. Keep these
// false by default so project quality settings control the intended behavior.
const TEMPORARILY_DISABLE_DISTANCE_VISIBILITY_CULLING = false;
const TEMPORARILY_DISABLE_ANGLE_VISIBILITY_CULLING = false;

export const isDistanceVisibilityCullingEnabled = (configured: boolean = true): boolean => {
  return configured && !TEMPORARILY_DISABLE_DISTANCE_VISIBILITY_CULLING;
};

export const isAngleVisibilityCullingEnabled = (): boolean => {
  return !TEMPORARILY_DISABLE_ANGLE_VISIBILITY_CULLING;
};
