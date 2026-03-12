import type { LocalPredictionState, LocalPredictionDebugState } from './PredictionTypes';
import {
  LOCAL_PREDICTION_HORIZONTAL_SNAP_DISTANCE_SQ,
  LOCAL_PREDICTION_IDLE_HORIZONTAL_CORRECTION_RATE,
  LOCAL_PREDICTION_IDLE_HORIZONTAL_ERROR_DEAD_ZONE_SQ,
  LOCAL_PREDICTION_IDLE_ROTATION_CORRECTION_RATE,
  LOCAL_PREDICTION_IDLE_ROTATION_ERROR_DEAD_ZONE,
  LOCAL_PREDICTION_IDLE_VERTICAL_CORRECTION_RATE,
  LOCAL_PREDICTION_IDLE_VERTICAL_ERROR_DEAD_ZONE,
  LOCAL_PREDICTION_MOVING_HORIZONTAL_CORRECTION_RATE,
  LOCAL_PREDICTION_MOVING_HORIZONTAL_ERROR_DEAD_ZONE_SQ,
  LOCAL_PREDICTION_MOVING_ROTATION_CORRECTION_RATE,
  LOCAL_PREDICTION_MOVING_ROTATION_ERROR_DEAD_ZONE,
  LOCAL_PREDICTION_MOVING_VERTICAL_CORRECTION_RATE,
  LOCAL_PREDICTION_MOVING_VERTICAL_ERROR_DEAD_ZONE,
  LOCAL_PREDICTION_ROTATION_SNAP_ANGLE,
  LOCAL_PREDICTION_VERTICAL_SNAP_DISTANCE,
} from './PredictionConstants';

export type ReconcileMode = 'none' | 'soft' | 'snap';

/**
 * Reconciles the predicted position and rotation toward the
 * authoritative state using dead-zone thresholds, soft lerp
 * correction, and snap-on-large-error fallback.
 *
 * Returns the reconciliation mode that was applied.
 */
export function reconcileLocalPrediction(
  state: LocalPredictionState,
  debugState: LocalPredictionDebugState,
  isActivelyMoving: boolean,
  deltaTimeS: number,
): ReconcileMode {
  let reconcileMode: ReconcileMode = 'none';
  const markSoftReconcile = () => {
    if (reconcileMode === 'none') {
      reconcileMode = 'soft';
    }
  };
  let sawSoftReconcile = false;
  let sawSnapReconcile = false;

  if (state.hasAuthoritativePosition) {
    const predictedPosition = state.predictedPosition;
    const authoritativePosition = state.authoritativePosition;
    const dx = authoritativePosition.x - predictedPosition.x;
    const dz = authoritativePosition.z - predictedPosition.z;
    const horizontalErrorSq = (dx * dx) + (dz * dz);

    if (horizontalErrorSq > LOCAL_PREDICTION_HORIZONTAL_SNAP_DISTANCE_SQ) {
      predictedPosition.x = authoritativePosition.x;
      predictedPosition.z = authoritativePosition.z;
      reconcileMode = 'snap';
      sawSnapReconcile = true;
    } else {
      const horizontalDeadZoneSq = isActivelyMoving
        ? LOCAL_PREDICTION_MOVING_HORIZONTAL_ERROR_DEAD_ZONE_SQ
        : LOCAL_PREDICTION_IDLE_HORIZONTAL_ERROR_DEAD_ZONE_SQ;

      if (horizontalErrorSq > horizontalDeadZoneSq) {
        const correctionT = Math.min(
          1,
          deltaTimeS * (isActivelyMoving ? LOCAL_PREDICTION_MOVING_HORIZONTAL_CORRECTION_RATE : LOCAL_PREDICTION_IDLE_HORIZONTAL_CORRECTION_RATE),
        );
        predictedPosition.x += dx * correctionT;
        predictedPosition.z += dz * correctionT;
        markSoftReconcile();
        sawSoftReconcile = true;
      }
    }

    const verticalError = authoritativePosition.y - predictedPosition.y;
    const absVerticalError = Math.abs(verticalError);
    if (absVerticalError > LOCAL_PREDICTION_VERTICAL_SNAP_DISTANCE) {
      predictedPosition.y = authoritativePosition.y;
      reconcileMode = 'snap';
      sawSnapReconcile = true;
    } else {
      const verticalDeadZone = isActivelyMoving
        ? LOCAL_PREDICTION_MOVING_VERTICAL_ERROR_DEAD_ZONE
        : LOCAL_PREDICTION_IDLE_VERTICAL_ERROR_DEAD_ZONE;

      if (absVerticalError > verticalDeadZone) {
        const correctionT = Math.min(
          1,
          deltaTimeS * (isActivelyMoving ? LOCAL_PREDICTION_MOVING_VERTICAL_CORRECTION_RATE : LOCAL_PREDICTION_IDLE_VERTICAL_CORRECTION_RATE),
        );
        predictedPosition.y += verticalError * correctionT;
        markSoftReconcile();
        sawSoftReconcile = true;
      }
    }
  }

  if (state.hasAuthoritativeRotation) {
    const rotationError = state.predictedRotation.angleTo(state.authoritativeRotation);
    if (rotationError > LOCAL_PREDICTION_ROTATION_SNAP_ANGLE) {
      state.predictedRotation.copy(state.authoritativeRotation);
      reconcileMode = 'snap';
      sawSnapReconcile = true;
    } else {
      const deadZone = isActivelyMoving
        ? LOCAL_PREDICTION_MOVING_ROTATION_ERROR_DEAD_ZONE
        : LOCAL_PREDICTION_IDLE_ROTATION_ERROR_DEAD_ZONE;

      if (rotationError > deadZone) {
        const correctionT = Math.min(
          1,
          deltaTimeS * (isActivelyMoving ? LOCAL_PREDICTION_MOVING_ROTATION_CORRECTION_RATE : LOCAL_PREDICTION_IDLE_ROTATION_CORRECTION_RATE),
        );
        state.predictedRotation.slerp(state.authoritativeRotation, correctionT);
        markSoftReconcile();
        sawSoftReconcile = true;
      }
    }
  }

  if (sawSoftReconcile && !sawSnapReconcile) {
    debugState.softReconcileCount++;
  }

  if (sawSnapReconcile) {
    debugState.snapReconcileCount++;
  }

  return reconcileMode;
}

/**
 * Tests whether the difference between predicted and authoritative
 * transforms exceeds the snap thresholds, requiring a forced active
 * reconciliation even if inputs are pending.
 */
export function shouldForceActiveInputReconcile(state: LocalPredictionState): boolean {
  if (state.hasAuthoritativePosition) {
    const predictedPosition = state.predictedPosition;
    const authoritativePosition = state.authoritativePosition;
    const dx = authoritativePosition.x - predictedPosition.x;
    const dz = authoritativePosition.z - predictedPosition.z;
    const horizontalErrorSq = (dx * dx) + (dz * dz);

    if (horizontalErrorSq > LOCAL_PREDICTION_HORIZONTAL_SNAP_DISTANCE_SQ) {
      return true;
    }

    if (
      Math.abs(authoritativePosition.y - predictedPosition.y)
      > LOCAL_PREDICTION_VERTICAL_SNAP_DISTANCE
    ) {
      return true;
    }
  }

  if (state.hasAuthoritativeRotation) {
    const rotationError = state.predictedRotation.angleTo(
      state.authoritativeRotation,
    );

    if (rotationError > LOCAL_PREDICTION_ROTATION_SNAP_ANGLE) {
      return true;
    }
  }

  return false;
}
