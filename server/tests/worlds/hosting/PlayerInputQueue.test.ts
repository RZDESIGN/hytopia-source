import { expect, test } from 'bun:test';
import Player from '@/players/Player';
import { DEFAULT_ROLLBACK_PREDICTED_INPUTS, createRollbackPredictedInputSet } from '@/shared/gameplay/InputContract';

const createPlayerHarness = () => {
  const cameraPitchCalls: number[] = [];
  const cameraYawCalls: number[] = [];

  const player = Object.create(Player.prototype) as any;
  player._input = {};
  player._predictedBlockEditBatches = [];
  player._queuedPredictedBlockEditBatches = [];
  player._queuedPredictedBlockEditCount = 0;
  player._rollbackPredictedInputs = [ ...DEFAULT_ROLLBACK_PREDICTED_INPUTS ];
  player._rollbackPredictedInputSet = createRollbackPredictedInputSet(DEFAULT_ROLLBACK_PREDICTED_INPUTS);
  player._rollbackPredictedInputSnapshot = {};
  player._previousRollbackPredictedInputSnapshot = {};
  player._currentRollbackPredictedInputSequenceNumber = undefined;
  player._queuedSequencedMovementInputs = [
    {
      sequenceNumber: 101,
      input: {
        w: true,
        a: false,
        s: false,
        d: false,
        sp: false,
        sh: false,
        c: false,
        cp: 0.25,
        cy: 1.5,
        jd: null,
      },
    },
    {
      sequenceNumber: 102,
      input: {
        w: false,
        a: true,
        s: false,
        d: false,
        sp: true,
        sh: false,
        c: false,
        cp: 0.5,
        cy: 2.25,
        jd: 0.75,
      },
    },
  ];
  player._lastAppliedInputSequenceNumber = 77;
  player._lastUnreliableInputSequenceNumber = -1;
  player.camera = {
    setOrientationPitch(value: number) {
      cameraPitchCalls.push(value);
    },
    setOrientationYaw(value: number) {
      cameraYawCalls.push(value);
    },
  };

  return { cameraPitchCalls, cameraYawCalls, player };
};

test('applyQueuedInputForSimulation drains up to 3 commands and acknowledges the last one', () => {
  const { cameraPitchCalls, cameraYawCalls, player } = createPlayerHarness();

  // With 2 queued commands and MAX_INPUT_DRAIN_PER_TICK=3, both are
  // consumed in one call.  Only the last command's input state is applied.
  player.applyQueuedInputForSimulation();

  expect(player._lastAppliedInputSequenceNumber).toBe(102);
  expect(player._queuedSequencedMovementInputs).toHaveLength(0);
  expect(player._currentRollbackPredictedInputSequenceNumber).toBe(102);
  expect(player._previousRollbackPredictedInputSnapshot).toEqual({});
  expect(player._rollbackPredictedInputSnapshot).toEqual({
    w: false,
    a: true,
    s: false,
    d: false,
    sp: true,
    sh: false,
    c: false,
    jd: 0.75,
  });
  expect(player._input).toEqual(expect.objectContaining({
    a: true,
    cp: 0.5,
    cy: 2.25,
    jd: 0.75,
    sp: true,
  }));
  expect(player._input.c).toBeUndefined();
  expect(player._input.d).toBeUndefined();
  expect(player._input.s).toBeUndefined();
  expect(player._input.sh).toBeUndefined();
  expect(player._input.w).toBeUndefined();
  expect(cameraPitchCalls).toEqual([ 0.5 ]);
  expect(cameraYawCalls).toEqual([ 2.25 ]);
});
