export type DeterministicMovementInput = {
  yaw: number;
  joystickDirection: number | null;
  w: boolean;
  a: boolean;
  s: boolean;
  d: boolean;
};

export type DeterministicMovementDirection = {
  x: number;
  z: number;
  lengthSq: number;
};

export const resolveDeterministicMovementDirection = (
  input: DeterministicMovementInput,
): DeterministicMovementDirection => {
  let x = 0;
  let z = 0;

  if (typeof input.joystickDirection === 'number') {
    const movementAngle = input.yaw + input.joystickDirection;
    x = -Math.sin(movementAngle);
    z = -Math.cos(movementAngle);
  } else {
    const sinYaw = Math.sin(input.yaw);
    const cosYaw = Math.cos(input.yaw);

    if (input.w) { x -= sinYaw; z -= cosYaw; }
    if (input.s) { x += sinYaw; z += cosYaw; }
    if (input.a) { x -= cosYaw; z += sinYaw; }
    if (input.d) { x += cosYaw; z -= sinYaw; }
  }

  const lengthSq = (x * x) + (z * z);
  if (lengthSq > 1) {
    const inverseLength = 1 / Math.sqrt(lengthSq);
    x *= inverseLength;
    z *= inverseLength;
    return { x, z, lengthSq: 1 };
  }

  return { x, z, lengthSq };
};
