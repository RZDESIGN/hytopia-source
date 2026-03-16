// Temporary engine-level override while visibility culling issues are being
// investigated across real game projects. Keep these switches centralized so
// re-enabling the behavior later is a one-file change.
const TEMPORARILY_DISABLE_DISTANCE_VISIBILITY_CULLING = true;
const TEMPORARILY_DISABLE_ANGLE_VISIBILITY_CULLING = true;

export const isDistanceVisibilityCullingEnabled = (configured: boolean = true): boolean => {
  return configured && !TEMPORARILY_DISABLE_DISTANCE_VISIBILITY_CULLING;
};

export const isAngleVisibilityCullingEnabled = (): boolean => {
  return !TEMPORARILY_DISABLE_ANGLE_VISIBILITY_CULLING;
};
