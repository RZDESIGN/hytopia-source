import { describe, expect, test } from 'bun:test';
import {
  resolveDeterministicLocomotionStep,
  type DeterministicLocomotionInput,
  type DeterministicLocomotionState,
  type DeterministicLocomotionCapabilities,
  type DeterministicLocomotionConfig,
} from '@/shared/gameplay/DeterministicLocomotionCore';

// ── Helpers ──────────────────────────────────────────────────────────

const noInput: DeterministicLocomotionInput = {
  yaw: 0, joystickDirection: null,
  w: false, a: false, s: false, d: false,
  sp: false, sh: false, c: false,
};

const forwardInput: DeterministicLocomotionInput = {
  ...noInput, w: true,
};

const groundedState: DeterministicLocomotionState = {
  grounded: true,
  swimming: false,
  fastMovementByDefault: false,
  justSubmergedRemainingS: 0,
  swimUpwardCooldownRemainingS: 0,
  verticalVelocity: 0,
};

const airborneState: DeterministicLocomotionState = {
  ...groundedState,
  grounded: false,
};

const swimmingState: DeterministicLocomotionState = {
  ...groundedState,
  grounded: false,
  swimming: true,
};

const fullCapabilities: DeterministicLocomotionCapabilities = {
  canWalk: true,
  canRun: true,
  canGroundJump: true,
  canSwimUpward: true,
  applyDirectionalMovementRotations: true,
};

const noCapabilities: DeterministicLocomotionCapabilities = {
  canWalk: false,
  canRun: false,
  canGroundJump: false,
  canSwimUpward: false,
  applyDirectionalMovementRotations: false,
};

const defaultConfig: DeterministicLocomotionConfig = {
  deltaTimeS: 1 / 60,
  walkVelocity: 4,
  runVelocity: 8,
  swimFastVelocity: 5,
  swimSlowVelocity: 3,
  jumpVelocity: 10,
  swimUpwardVelocity: 2,
  swimUpwardCooldownS: 0.6,
  waterEntrySinkingFactor: 0.8,
  swimmingDragFactor: 0.05,
};

// ── Idle / no-input behavior ─────────────────────────────────────────

describe('idle behavior', () => {
  test('no input produces zero movement velocity', () => {
    const step = resolveDeterministicLocomotionStep(
      noInput, groundedState, fullCapabilities, defaultConfig,
    );

    expect(step.isActivelyMoving).toBe(false);
    expect(step.movementVelocityX).toBe(0);
    expect(step.movementVelocityZ).toBe(0);
    expect(step.verticalAction).toBe('none');
  });

  test('hasMovementIntent is false when no keys pressed', () => {
    const step = resolveDeterministicLocomotionStep(
      noInput, groundedState, fullCapabilities, defaultConfig,
    );

    expect(step.hasMovementIntent).toBe(false);
    expect(step.hasJoystickInput).toBe(false);
  });
});

// ── Walking / running ────────────────────────────────────────────────

describe('walking and running', () => {
  test('forward input produces walk speed when shift is not held', () => {
    const step = resolveDeterministicLocomotionStep(
      forwardInput, groundedState, fullCapabilities, defaultConfig,
    );

    expect(step.isActivelyMoving).toBe(true);
    expect(step.isFastMovement).toBe(false);
    expect(step.movementSpeed).toBe(4);
    const velocityMagnitude = Math.sqrt(
      step.movementVelocityX ** 2 + step.movementVelocityZ ** 2,
    );
    expect(velocityMagnitude).toBeCloseTo(4, 3);
  });

  test('shift held produces run speed', () => {
    const step = resolveDeterministicLocomotionStep(
      { ...forwardInput, sh: true },
      groundedState, fullCapabilities, defaultConfig,
    );

    expect(step.isFastMovement).toBe(true);
    expect(step.movementSpeed).toBe(8);
  });

  test('fastMovementByDefault makes non-shift movement fast', () => {
    const step = resolveDeterministicLocomotionStep(
      forwardInput,
      { ...groundedState, fastMovementByDefault: true },
      fullCapabilities, defaultConfig,
    );

    expect(step.isFastMovement).toBe(true);
    expect(step.movementSpeed).toBe(8);
  });

  test('canWalk=false prevents movement', () => {
    const step = resolveDeterministicLocomotionStep(
      forwardInput, groundedState, noCapabilities, defaultConfig,
    );

    expect(step.canMove).toBe(false);
    expect(step.movementSpeed).toBe(0);
    expect(step.movementVelocityX).toBe(0);
    expect(step.movementVelocityZ).toBe(0);
    expect(step.isActivelyMoving).toBe(false);
  });
});

// ── Jumping ──────────────────────────────────────────────────────────

describe('jumping', () => {
  test('space while grounded triggers ground_jump', () => {
    const step = resolveDeterministicLocomotionStep(
      { ...noInput, sp: true },
      groundedState, fullCapabilities, defaultConfig,
    );

    expect(step.verticalAction).toBe('ground_jump');
    expect(step.verticalVelocity).toBe(10);
  });

  test('space while airborne does nothing', () => {
    const step = resolveDeterministicLocomotionStep(
      { ...noInput, sp: true },
      airborneState, fullCapabilities, defaultConfig,
    );

    expect(step.verticalAction).toBe('none');
  });

  test('space while grounded but canGroundJump=false does nothing', () => {
    const step = resolveDeterministicLocomotionStep(
      { ...noInput, sp: true },
      groundedState,
      { ...fullCapabilities, canGroundJump: false },
      defaultConfig,
    );

    expect(step.verticalAction).toBe('none');
  });
});

// ── Swimming ─────────────────────────────────────────────────────────

describe('swimming', () => {
  test('forward while swimming uses swim slow speed', () => {
    const step = resolveDeterministicLocomotionStep(
      forwardInput, swimmingState, fullCapabilities, defaultConfig,
    );

    expect(step.movementSpeed).toBe(3);
  });

  test('shift+forward while swimming uses swim fast speed', () => {
    const step = resolveDeterministicLocomotionStep(
      { ...forwardInput, sh: true },
      swimmingState, fullCapabilities, defaultConfig,
    );

    expect(step.movementSpeed).toBe(5);
  });

  test('space while swimming triggers swim_up', () => {
    const step = resolveDeterministicLocomotionStep(
      { ...noInput, sp: true },
      swimmingState, fullCapabilities, defaultConfig,
    );

    expect(step.verticalAction).toBe('swim_up');
    expect(step.verticalVelocity).toBe(2);
  });

  test('swim_up sets cooldown', () => {
    const step = resolveDeterministicLocomotionStep(
      { ...noInput, sp: true },
      swimmingState, fullCapabilities, defaultConfig,
    );

    expect(step.swimUpwardCooldownRemainingS).toBeCloseTo(0.6, 3);
  });

  test('swim_up is blocked during cooldown', () => {
    const step = resolveDeterministicLocomotionStep(
      { ...noInput, sp: true },
      { ...swimmingState, swimUpwardCooldownRemainingS: 0.5 },
      fullCapabilities, defaultConfig,
    );

    // Cooldown decremented by deltaTimeS (1/60), still > 0, so canSwimUpward is false
    expect(step.verticalAction).not.toBe('swim_up');
  });

  test('C key triggers dive', () => {
    const step = resolveDeterministicLocomotionStep(
      { ...noInput, c: true },
      swimmingState, fullCapabilities, defaultConfig,
    );

    expect(step.verticalAction).toBe('dive');
    expect(step.verticalVelocity).toBe(-2);
  });

  test('no input while swimming applies drag', () => {
    const step = resolveDeterministicLocomotionStep(
      noInput,
      { ...swimmingState, verticalVelocity: 5 },
      fullCapabilities, defaultConfig,
    );

    expect(step.verticalAction).toBe('swim_drag');
    // drag = -verticalVelocity * swimmingDragFactor = -5 * 0.05 = -0.25
    expect(step.verticalVelocity).toBeCloseTo(-0.25, 5);
  });

  test('just submerged applies sinking', () => {
    const step = resolveDeterministicLocomotionStep(
      noInput,
      { ...swimmingState, justSubmergedRemainingS: 0.5 },
      fullCapabilities, defaultConfig,
    );

    expect(step.verticalAction).toBe('sink');
    // -swimUpwardVelocity * waterEntrySinkingFactor = -2 * 0.8 = -1.6
    expect(step.verticalVelocity).toBeCloseTo(-1.6, 5);
  });
});

// ── Grounded vertical velocity reset ─────────────────────────────────

describe('shouldResetGroundedVerticalVelocity', () => {
  test('resets when grounded, not swimming, space not pressed', () => {
    const step = resolveDeterministicLocomotionStep(
      noInput, groundedState, fullCapabilities, defaultConfig,
    );

    expect(step.shouldResetGroundedVerticalVelocity).toBe(true);
  });

  test('does not reset when jumping (space pressed)', () => {
    const step = resolveDeterministicLocomotionStep(
      { ...noInput, sp: true },
      groundedState, fullCapabilities, defaultConfig,
    );

    expect(step.shouldResetGroundedVerticalVelocity).toBe(false);
  });

  test('does not reset when airborne', () => {
    const step = resolveDeterministicLocomotionStep(
      noInput, airborneState, fullCapabilities, defaultConfig,
    );

    expect(step.shouldResetGroundedVerticalVelocity).toBe(false);
  });
});

// ── Movement direction rotation ──────────────────────────────────────

describe('facing yaw', () => {
  test('produces facingYaw when actively moving with directional rotations', () => {
    const step = resolveDeterministicLocomotionStep(
      forwardInput, groundedState, fullCapabilities, defaultConfig,
    );

    expect(step.facingYaw).toBeDefined();
    expect(typeof step.facingYaw).toBe('number');
  });

  test('no facingYaw when idle', () => {
    const step = resolveDeterministicLocomotionStep(
      noInput, groundedState, fullCapabilities, defaultConfig,
    );

    expect(step.facingYaw).toBeUndefined();
  });

  test('no facingYaw when applyDirectionalMovementRotations=false', () => {
    const step = resolveDeterministicLocomotionStep(
      forwardInput, groundedState,
      { ...fullCapabilities, applyDirectionalMovementRotations: false },
      defaultConfig,
    );

    expect(step.facingYaw).toBeUndefined();
  });
});

// ── Conflicting inputs ───────────────────────────────────────────────

describe('conflicting inputs', () => {
  test('W+S without A/D is flagged as conflicting', () => {
    const step = resolveDeterministicLocomotionStep(
      { ...noInput, w: true, s: true },
      groundedState, fullCapabilities, defaultConfig,
    );

    expect(step.hasConflictingInputs).toBe(true);
  });

  test('A+D without W/S is flagged as conflicting', () => {
    const step = resolveDeterministicLocomotionStep(
      { ...noInput, a: true, d: true },
      groundedState, fullCapabilities, defaultConfig,
    );

    expect(step.hasConflictingInputs).toBe(true);
  });

  test('W+A is not conflicting (diagonal)', () => {
    const step = resolveDeterministicLocomotionStep(
      { ...noInput, w: true, a: true },
      groundedState, fullCapabilities, defaultConfig,
    );

    expect(step.hasConflictingInputs).toBe(false);
  });

  test('joystick input is never conflicting', () => {
    const step = resolveDeterministicLocomotionStep(
      { ...noInput, joystickDirection: 0, w: true, s: true },
      groundedState, fullCapabilities, defaultConfig,
    );

    expect(step.hasConflictingInputs).toBe(false);
  });
});

// ── Movement reference yaw ───────────────────────────────────────────

describe('movementReferenceYaw', () => {
  test('overrides input yaw when set', () => {
    const refYaw = Math.PI / 4;
    const step = resolveDeterministicLocomotionStep(
      { ...forwardInput, yaw: 0 },
      { ...groundedState, movementReferenceYaw: refYaw },
      fullCapabilities, defaultConfig,
    );

    expect(step.effectiveYaw).toBeCloseTo(refYaw, 5);
  });

  test('uses input yaw when movementReferenceYaw is undefined', () => {
    const inputYaw = 1.5;
    const step = resolveDeterministicLocomotionStep(
      { ...forwardInput, yaw: inputYaw },
      groundedState,
      fullCapabilities, defaultConfig,
    );

    expect(step.effectiveYaw).toBeCloseTo(inputYaw, 5);
  });
});

// ── Determinism ──────────────────────────────────────────────────────

describe('determinism', () => {
  test('identical inputs produce identical outputs', () => {
    const input = { ...forwardInput, sp: true, sh: true };
    const state = { ...groundedState };
    const caps = { ...fullCapabilities };

    const step1 = resolveDeterministicLocomotionStep(input, state, caps, defaultConfig);
    const step2 = resolveDeterministicLocomotionStep(input, state, caps, defaultConfig);

    expect(step1.movementVelocityX).toBe(step2.movementVelocityX);
    expect(step1.movementVelocityZ).toBe(step2.movementVelocityZ);
    expect(step1.verticalAction).toBe(step2.verticalAction);
    expect(step1.verticalVelocity).toBe(step2.verticalVelocity);
    expect(step1.shouldResetGroundedVerticalVelocity).toBe(step2.shouldResetGroundedVerticalVelocity);
    expect(step1.facingYaw).toBe(step2.facingYaw);
  });
});
