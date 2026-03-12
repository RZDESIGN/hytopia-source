import type { LocalPredictionState } from './PredictionTypes';
import {
  LOCAL_PREDICTION_COLLIDER_RADIUS,
  LOCAL_PREDICTION_COLLISION_EPSILON,
  LOCAL_PREDICTION_ENTITY_HEIGHT,
  LOCAL_PREDICTION_FOOTPRINT_SAMPLES,
  LOCAL_PREDICTION_GROUND_HOLD_DISTANCE,
  LOCAL_PREDICTION_GROUND_RELEASE_DISTANCE,
  LOCAL_PREDICTION_GROUND_SNAP_DISTANCE,
  LOCAL_PREDICTION_GROUNDED_GRACE_S,
  LOCAL_PREDICTION_GROUNDED_UPWARD_RELEASE_VELOCITY,
  LOCAL_PREDICTION_MAX_FOOT_OFFSET,
  LOCAL_PREDICTION_MIN_FOOT_OFFSET,
} from './PredictionConstants';

/**
 * Callback used to look up whether a block at the given integer
 * coordinates is solid (i.e. collides with the player).
 */
export type SolidBlockQuery = (x: number, y: number, z: number) => boolean;

/**
 * Callback used to set the predicted grounded state, also managing
 * the ground-grace timer and debug counters.
 */
export type SetPredictedGroundedFn = (grounded: boolean) => void;

/**
 * Tests whether the axis-aligned prediction collider intersects any
 * solid block at the given world position.
 */
export function intersectsLocalPredictionWorldAt(
  x: number,
  y: number,
  z: number,
  state: LocalPredictionState,
  isSolidBlockAt: SolidBlockQuery,
): boolean {
  const footOffset = getPredictedGroundFootOffset(state);
  const topOffset = getPredictedTopOffset(state);
  const minBlockX = Math.floor(x - LOCAL_PREDICTION_COLLIDER_RADIUS + LOCAL_PREDICTION_COLLISION_EPSILON);
  const maxBlockX = Math.floor(x + LOCAL_PREDICTION_COLLIDER_RADIUS - LOCAL_PREDICTION_COLLISION_EPSILON);
  const minBlockY = Math.floor(y - footOffset + LOCAL_PREDICTION_COLLISION_EPSILON);
  const maxBlockY = Math.floor(y + topOffset - LOCAL_PREDICTION_COLLISION_EPSILON);
  const minBlockZ = Math.floor(z - LOCAL_PREDICTION_COLLIDER_RADIUS + LOCAL_PREDICTION_COLLISION_EPSILON);
  const maxBlockZ = Math.floor(z + LOCAL_PREDICTION_COLLIDER_RADIUS - LOCAL_PREDICTION_COLLISION_EPSILON);

  for (let blockY = minBlockY; blockY <= maxBlockY; blockY++) {
    for (let blockZ = minBlockZ; blockZ <= maxBlockZ; blockZ++) {
      for (let blockX = minBlockX; blockX <= maxBlockX; blockX++) {
        if (isSolidBlockAt(blockX, blockY, blockZ)) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Finds the highest ground surface Y coordinate under the player by
 * probing a multi-sample footprint pattern.
 */
export function getPredictedGroundY(
  x: number,
  y: number,
  z: number,
  footOffset: number,
  maxProbeDistance: number,
  isSolidBlockAt: SolidBlockQuery,
): number | undefined {
  const footY = y - footOffset;
  const maxCandidateBlockY = Math.floor(footY + maxProbeDistance - LOCAL_PREDICTION_COLLISION_EPSILON);
  const minCandidateBlockY = Math.floor(footY - maxProbeDistance - 1);
  let highestGroundY: number | undefined;

  for (const [sampleOffsetX, sampleOffsetZ] of LOCAL_PREDICTION_FOOTPRINT_SAMPLES) {
    const sampleX = Math.floor(x + sampleOffsetX);
    const sampleZ = Math.floor(z + sampleOffsetZ);

    for (let blockY = maxCandidateBlockY; blockY >= minCandidateBlockY; blockY--) {
      const blockIsSolid = isSolidBlockAt(sampleX, blockY, sampleZ);

      if (!blockIsSolid) {
        continue;
      }

      const candidateGroundY = blockY + 1;
      if (candidateGroundY <= footY + maxProbeDistance) {
        highestGroundY = Math.max(highestGroundY ?? -Infinity, candidateGroundY);
        break;
      }
    }
  }

  return highestGroundY;
}

/**
 * Applies horizontal movement deltas with per-axis collision testing.
 */
export function applyPredictedHorizontalMovement(
  deltaX: number,
  deltaZ: number,
  state: LocalPredictionState,
  isSolidBlockAt: SolidBlockQuery,
): void {
  const predictedPosition = state.predictedPosition;

  if (deltaX !== 0) {
    const nextX = predictedPosition.x + deltaX;
    if (!intersectsLocalPredictionWorldAt(nextX, predictedPosition.y, predictedPosition.z, state, isSolidBlockAt)) {
      predictedPosition.x = nextX;
    }
  }

  if (deltaZ !== 0) {
    const nextZ = predictedPosition.z + deltaZ;
    if (!intersectsLocalPredictionWorldAt(predictedPosition.x, predictedPosition.y, nextZ, state, isSolidBlockAt)) {
      predictedPosition.z = nextZ;
    }
  }
}

/**
 * Resolves predicted ground contact — snap to ground, hold grounded
 * state, or release into air. Should only be called when not swimming.
 */
export function resolvePredictedGroundContact(
  predictedVerticalVelocity: number,
  motionBasisVelocityY: number,
  state: LocalPredictionState,
  isSolidBlockAt: SolidBlockQuery,
  setPredictedGrounded: SetPredictedGroundedFn,
): void {
  const controllerState = state.controllerState;
  const predictedPosition = state.predictedPosition;
  const footOffset = getPredictedGroundFootOffset(state);
  const groundProbeDistance = controllerState.predictedGrounded
    ? LOCAL_PREDICTION_GROUND_HOLD_DISTANCE
    : LOCAL_PREDICTION_GROUND_SNAP_DISTANCE;
  const groundY = getPredictedGroundY(
    predictedPosition.x,
    predictedPosition.y,
    predictedPosition.z,
    footOffset,
    groundProbeDistance,
    isSolidBlockAt,
  );

  if (groundY === undefined) {
    if (
      controllerState.predictedGrounded &&
      Math.abs(motionBasisVelocityY) <= LOCAL_PREDICTION_COLLISION_EPSILON
    ) {
      if (controllerState.predictedGroundGraceRemainingS > 0) {
        return;
      }

      setPredictedGrounded(false);
    }

    return;
  }

  const footY = predictedPosition.y - footOffset;
  const distanceToGround = footY - groundY;
  const movingDownOrStable = predictedVerticalVelocity <= (motionBasisVelocityY + LOCAL_PREDICTION_COLLISION_EPSILON);
  const canHoldGroundedState =
    controllerState.predictedGrounded &&
    Math.abs(motionBasisVelocityY) <= LOCAL_PREDICTION_COLLISION_EPSILON &&
    predictedVerticalVelocity <= LOCAL_PREDICTION_GROUNDED_UPWARD_RELEASE_VELOCITY;

  if (
    distanceToGround < 0 ||
    (movingDownOrStable && distanceToGround <= LOCAL_PREDICTION_GROUND_SNAP_DISTANCE)
  ) {
    predictedPosition.y = groundY + footOffset;
    controllerState.predictedGroundGraceRemainingS = LOCAL_PREDICTION_GROUNDED_GRACE_S;
    setPredictedGrounded(true);
    return;
  }

  if (
    canHoldGroundedState &&
    distanceToGround <= LOCAL_PREDICTION_GROUND_HOLD_DISTANCE
  ) {
    predictedPosition.y = groundY + footOffset;
    controllerState.predictedGroundGraceRemainingS = LOCAL_PREDICTION_GROUNDED_GRACE_S;
    setPredictedGrounded(true);
    return;
  }

  if (
    distanceToGround > LOCAL_PREDICTION_GROUND_RELEASE_DISTANCE &&
    Math.abs(motionBasisVelocityY) <= LOCAL_PREDICTION_COLLISION_EPSILON
  ) {
    if (controllerState.predictedGroundGraceRemainingS > 0) {
      return;
    }

    setPredictedGrounded(false);
  }
}

/**
 * Updates the authoritative ground foot offset by sampling the block
 * world near the authoritative position. This adapts the predicted
 * collider to the server's actual contact position.
 */
export function updateAuthoritativeGroundFootOffset(
  position: { x: number; y: number; z: number },
  state: LocalPredictionState,
  isSolidBlockAt: SolidBlockQuery,
): void {
  const controllerState = state.controllerState;

  if (!controllerState.authoritativeGrounded || controllerState.authoritativeSwimming) {
    return;
  }

  const groundY = getPredictedGroundY(
    position.x,
    position.y,
    position.z,
    controllerState.authoritativeGroundFootOffset,
    LOCAL_PREDICTION_GROUND_HOLD_DISTANCE,
    isSolidBlockAt,
  );

  if (groundY === undefined) {
    return;
  }

  const sampledFootOffset = Math.min(
    LOCAL_PREDICTION_MAX_FOOT_OFFSET,
    Math.max(LOCAL_PREDICTION_MIN_FOOT_OFFSET, position.y - groundY),
  );

  controllerState.authoritativeGroundFootOffset +=
    (sampledFootOffset - controllerState.authoritativeGroundFootOffset) * 0.35;
}

/**
 * Returns the predicted foot offset from the entity origin.
 */
export function getPredictedGroundFootOffset(state: LocalPredictionState): number {
  return state.controllerState.predictedGroundFootOffset;
}

/**
 * Returns the predicted top offset from the entity origin, ensuring at
 * least a minimal collision epsilon.
 */
export function getPredictedTopOffset(state: LocalPredictionState): number {
  return Math.max(
    LOCAL_PREDICTION_COLLISION_EPSILON,
    LOCAL_PREDICTION_ENTITY_HEIGHT - getPredictedGroundFootOffset(state),
  );
}
