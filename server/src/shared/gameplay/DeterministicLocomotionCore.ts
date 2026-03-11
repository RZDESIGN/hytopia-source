import {
  resolveDeterministicMovementDirection,
  resolveDeterministicMovementYaw,
  type DeterministicMovementDirection,
  type DeterministicMovementInput,
} from './DeterministicMovementCore';

export type DeterministicLocomotionInput = DeterministicMovementInput & {
  sp: boolean;
  sh: boolean;
  c: boolean;
};

export type DeterministicLocomotionState = {
  grounded: boolean;
  swimming: boolean;
  fastMovementByDefault: boolean;
  movementReferenceYaw?: number;
  justSubmergedRemainingS: number;
  swimUpwardCooldownRemainingS: number;
  verticalVelocity: number;
};

export type DeterministicLocomotionCapabilities = {
  canWalk: boolean;
  canRun: boolean;
  canGroundJump: boolean;
  canSwimUpward: boolean;
  applyDirectionalMovementRotations: boolean;
};

export type DeterministicLocomotionConfig = {
  deltaTimeS: number;
  walkVelocity: number;
  runVelocity: number;
  swimFastVelocity: number;
  swimSlowVelocity: number;
  jumpVelocity: number;
  swimUpwardVelocity: number;
  swimUpwardCooldownS: number;
  waterEntrySinkingFactor: number;
  swimmingDragFactor: number;
};

export type DeterministicLocomotionVerticalAction =
  | 'none'
  | 'dive'
  | 'sink'
  | 'swim_drag'
  | 'ground_jump'
  | 'swim_up';

export type DeterministicLocomotionStep = {
  effectiveYaw: number;
  hasJoystickInput: boolean;
  hasMovementIntent: boolean;
  hasConflictingInputs: boolean;
  canMove: boolean;
  isFastMovement: boolean;
  isActivelyMoving: boolean;
  movementDirection: DeterministicMovementDirection;
  movementSpeed: number;
  movementVelocityX: number;
  movementVelocityZ: number;
  verticalAction: DeterministicLocomotionVerticalAction;
  verticalVelocity: number;
  justSubmergedRemainingS: number;
  swimUpwardCooldownRemainingS: number;
  shouldResetGroundedVerticalVelocity: boolean;
  facingYaw?: number;
};

export const resolveDeterministicLocomotionStep = (
  input: DeterministicLocomotionInput,
  state: DeterministicLocomotionState,
  capabilities: DeterministicLocomotionCapabilities,
  config: DeterministicLocomotionConfig,
): DeterministicLocomotionStep => {
  const hasJoystickInput = typeof input.joystickDirection === 'number';
  const hasMovementIntent = hasJoystickInput || !!(input.w || input.a || input.s || input.d);
  const hasConflictingInputs =
    !hasJoystickInput &&
    ((input.a && input.d && !input.w && !input.s) ||
      (input.w && input.s && !input.a && !input.d));
  const isFastMovement = input.sh || state.fastMovementByDefault;
  const canMove = isFastMovement ? capabilities.canRun : capabilities.canWalk;
  const effectiveYaw = Number.isFinite(state.movementReferenceYaw)
    ? Number(state.movementReferenceYaw)
    : input.yaw;
  const movementDirection = canMove
    ? resolveDeterministicMovementDirection({
      yaw: effectiveYaw,
      joystickDirection: hasJoystickInput ? input.joystickDirection : null,
      w: input.w,
      a: input.a,
      s: input.s,
      d: input.d,
    })
    : { x: 0, z: 0, lengthSq: 0 };
  const isActivelyMoving = movementDirection.lengthSq > 0;
  const movementSpeed = !canMove
    ? 0
    : state.swimming
      ? (isFastMovement ? config.swimFastVelocity : config.swimSlowVelocity)
      : (isFastMovement ? config.runVelocity : config.walkVelocity);
  const movementVelocityX = isActivelyMoving ? movementDirection.x * movementSpeed : 0;
  const movementVelocityZ = isActivelyMoving ? movementDirection.z * movementSpeed : 0;

  let justSubmergedRemainingS = Math.max(0, state.justSubmergedRemainingS - config.deltaTimeS);
  let swimUpwardCooldownRemainingS = Math.max(0, state.swimUpwardCooldownRemainingS - config.deltaTimeS);
  let verticalAction: DeterministicLocomotionVerticalAction = 'none';
  let verticalVelocity = 0;

  if (state.swimming) {
    if (input.c) {
      verticalAction = 'dive';
      verticalVelocity = -config.swimUpwardVelocity;
    } else if (justSubmergedRemainingS > 0) {
      verticalAction = 'sink';
      verticalVelocity = -config.swimUpwardVelocity * config.waterEntrySinkingFactor;
    } else if (!input.sp) {
      verticalAction = 'swim_drag';
      verticalVelocity = -state.verticalVelocity * config.swimmingDragFactor;
    }
  }

  if (input.sp) {
    if (state.grounded && !state.swimming && capabilities.canGroundJump) {
      verticalAction = 'ground_jump';
      verticalVelocity = config.jumpVelocity;
    } else if (state.swimming && capabilities.canSwimUpward && swimUpwardCooldownRemainingS <= 0) {
      verticalAction = 'swim_up';
      verticalVelocity = config.swimUpwardVelocity;
      swimUpwardCooldownRemainingS = config.swimUpwardCooldownS;
    }
  }

  const facingYaw =
    capabilities.applyDirectionalMovementRotations && isActivelyMoving
      ? resolveDeterministicMovementYaw(movementDirection.x, movementDirection.z)
      : undefined;

  return {
    effectiveYaw,
    hasJoystickInput,
    hasMovementIntent,
    hasConflictingInputs,
    canMove,
    isFastMovement,
    isActivelyMoving,
    movementDirection,
    movementSpeed,
    movementVelocityX,
    movementVelocityZ,
    verticalAction,
    verticalVelocity,
    justSubmergedRemainingS,
    swimUpwardCooldownRemainingS,
    shouldResetGroundedVerticalVelocity: state.grounded && !state.swimming && !input.sp,
    facingYaw,
  };
};
