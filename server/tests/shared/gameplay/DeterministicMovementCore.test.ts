import { describe, expect, test } from 'bun:test';
import {
  resolveDeterministicMovementDirection,
  resolveDeterministicMovementYaw,
} from '@/shared/gameplay/DeterministicMovementCore';

// ── resolveDeterministicMovementDirection ─────────────────────────────

describe('resolveDeterministicMovementDirection', () => {
  test('returns zero when no inputs are pressed', () => {
    const result = resolveDeterministicMovementDirection({
      yaw: 0,
      joystickDirection: null,
      w: false, a: false, s: false, d: false,
    });

    expect(result.x).toBe(0);
    expect(result.z).toBe(0);
    expect(result.lengthSq).toBe(0);
  });

  test('forward (W) at yaw=0 produces negative Z', () => {
    const result = resolveDeterministicMovementDirection({
      yaw: 0,
      joystickDirection: null,
      w: true, a: false, s: false, d: false,
    });

    expect(result.x).toBeCloseTo(0, 10);
    expect(result.z).toBeCloseTo(-1, 5);
    expect(result.lengthSq).toBeCloseTo(1, 5);
  });

  test('backward (S) at yaw=0 produces positive Z', () => {
    const result = resolveDeterministicMovementDirection({
      yaw: 0,
      joystickDirection: null,
      w: false, a: false, s: true, d: false,
    });

    expect(result.x).toBeCloseTo(0, 10);
    expect(result.z).toBeCloseTo(1, 5);
  });

  test('left (A) at yaw=0 produces negative X', () => {
    const result = resolveDeterministicMovementDirection({
      yaw: 0,
      joystickDirection: null,
      w: false, a: true, s: false, d: false,
    });

    expect(result.x).toBeCloseTo(-1, 5);
    expect(result.z).toBeCloseTo(0, 10);
  });

  test('right (D) at yaw=0 produces positive X', () => {
    const result = resolveDeterministicMovementDirection({
      yaw: 0,
      joystickDirection: null,
      w: false, a: false, s: false, d: true,
    });

    expect(result.x).toBeCloseTo(1, 5);
    expect(result.z).toBeCloseTo(0, 10);
  });

  test('diagonal (W+D) is normalized to length 1', () => {
    const result = resolveDeterministicMovementDirection({
      yaw: 0,
      joystickDirection: null,
      w: true, a: false, s: false, d: true,
    });

    expect(result.lengthSq).toBeCloseTo(1, 5);
    const length = Math.sqrt(result.x * result.x + result.z * result.z);
    expect(length).toBeCloseTo(1, 5);
  });

  test('opposing inputs (W+S only) cancel out', () => {
    // W adds -sinYaw,-cosYaw and S adds +sinYaw,+cosYaw → net zero
    const result = resolveDeterministicMovementDirection({
      yaw: 0,
      joystickDirection: null,
      w: true, a: false, s: true, d: false,
    });

    expect(result.x).toBeCloseTo(0, 10);
    expect(result.z).toBeCloseTo(0, 10);
    expect(result.lengthSq).toBeCloseTo(0, 10);
  });

  test('yaw rotates the movement direction', () => {
    // At yaw=PI/2, W (forward) should point in +X direction
    const result = resolveDeterministicMovementDirection({
      yaw: Math.PI / 2,
      joystickDirection: null,
      w: true, a: false, s: false, d: false,
    });

    expect(result.x).toBeCloseTo(-1, 5);
    expect(result.z).toBeCloseTo(0, 4);
  });

  test('joystick direction overrides WASD', () => {
    const joystickAngle = 0; // Forward relative to yaw
    const result = resolveDeterministicMovementDirection({
      yaw: 0,
      joystickDirection: joystickAngle,
      w: true, a: true, s: true, d: true, // WASD ignored
    });

    // joystick at direction 0 + yaw 0 → movementAngle = 0
    // x = -sin(0) = 0, z = -cos(0) = -1
    expect(result.x).toBeCloseTo(0, 10);
    expect(result.z).toBeCloseTo(-1, 5);
  });

  test('joystick produces unit-length vector', () => {
    const result = resolveDeterministicMovementDirection({
      yaw: 1.5,
      joystickDirection: 0.8,
      w: false, a: false, s: false, d: false,
    });

    const length = Math.sqrt(result.x * result.x + result.z * result.z);
    expect(length).toBeCloseTo(1, 5);
  });
});

// ── resolveDeterministicMovementYaw ──────────────────────────────────

describe('resolveDeterministicMovementYaw', () => {
  test('forward direction (0, -1) returns yaw=0', () => {
    const yaw = resolveDeterministicMovementYaw(0, -1);
    expect(yaw).toBeCloseTo(0, 5);
  });

  test('right direction (1, 0) returns yaw=PI/2 (negated)', () => {
    const yaw = resolveDeterministicMovementYaw(-1, 0);
    // atan2(1, 0) = PI/2
    expect(yaw).toBeCloseTo(Math.PI / 2, 5);
  });

  test('roundtrip: direction → yaw → direction preserves direction', () => {
    const originalX = 0.6;
    const originalZ = -0.8;
    const yaw = resolveDeterministicMovementYaw(originalX, originalZ);
    // Reconstruct direction from yaw
    const reconstructedX = -Math.sin(yaw);
    const reconstructedZ = -Math.cos(yaw);

    expect(reconstructedX).toBeCloseTo(originalX, 5);
    expect(reconstructedZ).toBeCloseTo(originalZ, 5);
  });
});
