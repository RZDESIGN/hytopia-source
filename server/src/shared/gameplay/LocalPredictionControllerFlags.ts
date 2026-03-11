export const LOCAL_PREDICTION_CONTROLLER_FLAG_CAN_WALK = 1 << 0;
export const LOCAL_PREDICTION_CONTROLLER_FLAG_CAN_RUN = 1 << 1;
export const LOCAL_PREDICTION_CONTROLLER_FLAG_CAN_JUMP = 1 << 2;
export const LOCAL_PREDICTION_CONTROLLER_FLAG_APPLY_DIRECTIONAL_MOVEMENT_ROTATIONS = 1 << 3;
export const LOCAL_PREDICTION_CONTROLLER_FLAG_FACES_CAMERA_WHEN_IDLE = 1 << 4;

export type LocalPredictionControllerFlags = {
  canWalk: boolean;
  canRun: boolean;
  canJump: boolean;
  applyDirectionalMovementRotations: boolean;
  facesCameraWhenIdle: boolean;
};

export const DEFAULT_LOCAL_PREDICTION_CONTROLLER_FLAGS: Readonly<LocalPredictionControllerFlags> = {
  canWalk: true,
  canRun: true,
  canJump: true,
  applyDirectionalMovementRotations: true,
  facesCameraWhenIdle: false,
};

export const encodeLocalPredictionControllerFlags = (
  flags: LocalPredictionControllerFlags,
): number => {
  let encodedFlags = 0;

  if (flags.canWalk) {
    encodedFlags |= LOCAL_PREDICTION_CONTROLLER_FLAG_CAN_WALK;
  }
  if (flags.canRun) {
    encodedFlags |= LOCAL_PREDICTION_CONTROLLER_FLAG_CAN_RUN;
  }
  if (flags.canJump) {
    encodedFlags |= LOCAL_PREDICTION_CONTROLLER_FLAG_CAN_JUMP;
  }
  if (flags.applyDirectionalMovementRotations) {
    encodedFlags |= LOCAL_PREDICTION_CONTROLLER_FLAG_APPLY_DIRECTIONAL_MOVEMENT_ROTATIONS;
  }
  if (flags.facesCameraWhenIdle) {
    encodedFlags |= LOCAL_PREDICTION_CONTROLLER_FLAG_FACES_CAMERA_WHEN_IDLE;
  }

  return encodedFlags;
};

export const decodeLocalPredictionControllerFlags = (
  flags: number | undefined,
): LocalPredictionControllerFlags => {
  const resolvedFlags = Number.isFinite(flags)
    ? Number(flags)
    : encodeLocalPredictionControllerFlags(DEFAULT_LOCAL_PREDICTION_CONTROLLER_FLAGS);

  return {
    canWalk: (resolvedFlags & LOCAL_PREDICTION_CONTROLLER_FLAG_CAN_WALK) !== 0,
    canRun: (resolvedFlags & LOCAL_PREDICTION_CONTROLLER_FLAG_CAN_RUN) !== 0,
    canJump: (resolvedFlags & LOCAL_PREDICTION_CONTROLLER_FLAG_CAN_JUMP) !== 0,
    applyDirectionalMovementRotations:
      (resolvedFlags & LOCAL_PREDICTION_CONTROLLER_FLAG_APPLY_DIRECTIONAL_MOVEMENT_ROTATIONS) !== 0,
    facesCameraWhenIdle:
      (resolvedFlags & LOCAL_PREDICTION_CONTROLLER_FLAG_FACES_CAMERA_WHEN_IDLE) !== 0,
  };
};
