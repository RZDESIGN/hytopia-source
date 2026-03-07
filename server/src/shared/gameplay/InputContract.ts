import type { InputSchema } from '@hytopia.com/server-protocol';

export const SUPPORTED_INPUTS = [
  'w', 'a', 's', 'd',
  'sp', 'sh', 'tb',
  'ml', 'mr',
  'q', 'e', 'r', 'f', 'z', 'x', 'c', 'v',
  'u', 'i', 'o', 'j', 'k', 'l', 'n', 'm',
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '0',
  'cp', 'cy',
  'iro', 'ird',
  'jd',
] as const satisfies readonly (keyof InputSchema)[];

export const DISCRETE_MOVEMENT_INPUTS = [
  'w',
  'a',
  's',
  'd',
  'sp',
  'sh',
  'c',
] as const satisfies readonly (keyof InputSchema)[];

export const SEQUENCED_MOVEMENT_INPUTS = [
  ...DISCRETE_MOVEMENT_INPUTS,
  'jd',
] as const satisfies readonly (keyof InputSchema)[];

export const UNSEQUENCED_UNRELIABLE_INPUTS = [
  'cp',
  'cy',
] as const satisfies readonly (keyof InputSchema)[];

export const DISCRETE_MOVEMENT_INPUT_SET: ReadonlySet<keyof InputSchema> =
  new Set<keyof InputSchema>(DISCRETE_MOVEMENT_INPUTS);

export const SEQUENCED_MOVEMENT_INPUT_SET: ReadonlySet<keyof InputSchema> =
  new Set<keyof InputSchema>(SEQUENCED_MOVEMENT_INPUTS);

export const UNSEQUENCED_UNRELIABLE_INPUT_SET: ReadonlySet<keyof InputSchema> =
  new Set<keyof InputSchema>(UNSEQUENCED_UNRELIABLE_INPUTS);
