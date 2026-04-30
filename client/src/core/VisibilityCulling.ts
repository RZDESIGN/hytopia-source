// Engine-level emergency switches. Keep these false for normal builds; the
// culling paths should remain conservative enough for target/orbit cameras.
const TEMPORARILY_DISABLE_DISTANCE_VISIBILITY_CULLING = false;
const TEMPORARILY_DISABLE_ANGLE_VISIBILITY_CULLING = false;

type Vector2Like = { x: number; y: number };

export const isDistanceVisibilityCullingEnabled = (configured: boolean = true): boolean => {
  return configured && !TEMPORARILY_DISABLE_DISTANCE_VISIBILITY_CULLING;
};

export const isAngleVisibilityCullingEnabled = (): boolean => {
  return !TEMPORARILY_DISABLE_ANGLE_VISIBILITY_CULLING;
};

export const distanceToVisibilitySegmentSquared = (
  point: Vector2Like,
  cameraPosition: Vector2Like,
  focusPosition?: Vector2Like,
): number => {
  if (!focusPosition) {
    const dx = point.x - cameraPosition.x;
    const dz = point.y - cameraPosition.y;
    return dx * dx + dz * dz;
  }

  const segmentX = focusPosition.x - cameraPosition.x;
  const segmentZ = focusPosition.y - cameraPosition.y;
  const segmentLengthSquared = segmentX * segmentX + segmentZ * segmentZ;

  if (segmentLengthSquared <= 0.000001) {
    const dx = point.x - cameraPosition.x;
    const dz = point.y - cameraPosition.y;
    return dx * dx + dz * dz;
  }

  const pointX = point.x - cameraPosition.x;
  const pointZ = point.y - cameraPosition.y;
  const segmentT = Math.max(0, Math.min(1, (pointX * segmentX + pointZ * segmentZ) / segmentLengthSquared));
  const closestX = cameraPosition.x + segmentX * segmentT;
  const closestZ = cameraPosition.y + segmentZ * segmentT;
  const dx = point.x - closestX;
  const dz = point.y - closestZ;
  return dx * dx + dz * dz;
};
