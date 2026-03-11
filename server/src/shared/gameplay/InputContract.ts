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

export const ROLLBACK_PREDICTABLE_INPUTS = [
  ...SUPPORTED_INPUTS.filter(
    (input) => input !== 'cp' && input !== 'cy' && input !== 'iro' && input !== 'ird',
  ),
] as const satisfies readonly (keyof InputSchema)[];

export type RollbackPredictableInput = typeof ROLLBACK_PREDICTABLE_INPUTS[number];

export const DEFAULT_ROLLBACK_PREDICTED_INPUTS = [
  ...SEQUENCED_MOVEMENT_INPUTS,
] as const satisfies readonly RollbackPredictableInput[];

export const DISCRETE_MOVEMENT_INPUT_SET: ReadonlySet<keyof InputSchema> =
  new Set<keyof InputSchema>(DISCRETE_MOVEMENT_INPUTS);

export const SEQUENCED_MOVEMENT_INPUT_SET: ReadonlySet<keyof InputSchema> =
  new Set<keyof InputSchema>(SEQUENCED_MOVEMENT_INPUTS);

export const UNSEQUENCED_UNRELIABLE_INPUT_SET: ReadonlySet<keyof InputSchema> =
  new Set<keyof InputSchema>(UNSEQUENCED_UNRELIABLE_INPUTS);

export const ROLLBACK_PREDICTABLE_INPUT_SET: ReadonlySet<RollbackPredictableInput> =
  new Set<RollbackPredictableInput>(ROLLBACK_PREDICTABLE_INPUTS);

export const DEFAULT_ROLLBACK_PREDICTED_INPUT_SET: ReadonlySet<RollbackPredictableInput> =
  new Set<RollbackPredictableInput>(DEFAULT_ROLLBACK_PREDICTED_INPUTS);

export const isRollbackPredictableInput = (
  input: keyof InputSchema,
): input is RollbackPredictableInput => {
  return ROLLBACK_PREDICTABLE_INPUT_SET.has(input as RollbackPredictableInput);
};

export const normalizeRollbackPredictedInputs = (
  inputs: readonly (keyof InputSchema)[] | undefined,
): RollbackPredictableInput[] => {
  const sourceInputs = inputs && inputs.length > 0
    ? inputs
    : DEFAULT_ROLLBACK_PREDICTED_INPUTS;
  const normalizedInputs: RollbackPredictableInput[] = [];
  const seenInputs = new Set<RollbackPredictableInput>();

  for (const input of sourceInputs) {
    if (!isRollbackPredictableInput(input)) {
      continue;
    }

    if (seenInputs.has(input)) {
      continue;
    }

    seenInputs.add(input);
    normalizedInputs.push(input);
  }

  return normalizedInputs;
};

export const createRollbackPredictedInputSet = (
  inputs: readonly (keyof InputSchema)[] | undefined,
): ReadonlySet<RollbackPredictableInput> => {
  return new Set<RollbackPredictableInput>(normalizeRollbackPredictedInputs(inputs));
};

export const encodeRollbackPredictedInputMask = (
  inputs: readonly (keyof InputSchema)[] | ReadonlySet<keyof InputSchema> | undefined,
): readonly [number, number] => {
  let inputSet: ReadonlySet<keyof InputSchema>;

  if (inputs && 'has' in inputs) {
    inputSet = inputs;
  } else if (inputs) {
    inputSet = createRollbackPredictedInputSet(inputs);
  } else {
    inputSet = DEFAULT_ROLLBACK_PREDICTED_INPUT_SET;
  }

  let lowMask = 0;
  let highMask = 0;

  for (let i = 0; i < ROLLBACK_PREDICTABLE_INPUTS.length; i++) {
    const input = ROLLBACK_PREDICTABLE_INPUTS[i];
    if (!inputSet.has(input)) {
      continue;
    }

    if (i < 32) {
      lowMask |= (1 << i);
    } else {
      highMask |= (1 << (i - 32));
    }
  }

  return [lowMask >>> 0, highMask >>> 0] as const;
};

export const decodeRollbackPredictedInputMask = (
  lowMask: number | undefined,
  highMask: number | undefined,
): RollbackPredictableInput[] => {
  const resolvedLowMask = lowMask ?? 0;
  const resolvedHighMask = highMask ?? 0;

  if (!resolvedLowMask && !resolvedHighMask) {
    return [ ...DEFAULT_ROLLBACK_PREDICTED_INPUTS ];
  }

  const inputs: RollbackPredictableInput[] = [];

  for (let i = 0; i < ROLLBACK_PREDICTABLE_INPUTS.length; i++) {
    const mask = i < 32 ? resolvedLowMask : resolvedHighMask;
    const bitIndex = i < 32 ? i : (i - 32);
    if ((mask & (1 << bitIndex)) === 0) {
      continue;
    }

    inputs.push(ROLLBACK_PREDICTABLE_INPUTS[i]);
  }

  return inputs.length > 0
    ? inputs
    : [ ...DEFAULT_ROLLBACK_PREDICTED_INPUTS ];
};
