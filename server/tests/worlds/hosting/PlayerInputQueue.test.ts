import { expect, test } from 'bun:test';
import Player from '@/players/Player';

const createPlayerHarness = () => {
  const cameraPitchCalls: number[] = [];
  const cameraYawCalls: number[] = [];

  const player = Object.create(Player.prototype) as any;
  player._input = {};
  player._predictedBlockEditBatches = [];
  player._queuedPredictedBlockEditBatches = [];
  player._queuedPredictedBlockEditCount = 0;
  player._queuedSequencedMovementInputs = [
    {
      sequenceNumber: 101,
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
    {
      sequenceNumber: 102,
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

test('applyQueuedInputForSimulation only acknowledges the command that was actually simulated', () => {
  const { cameraPitchCalls, cameraYawCalls, player } = createPlayerHarness();

  player.applyQueuedInputForSimulation();

  expect(player._lastAppliedInputSequenceNumber).toBe(101);
  expect(player._queuedSequencedMovementInputs).toHaveLength(1);
  expect(player._queuedSequencedMovementInputs[0].sequenceNumber).toBe(102);
  expect(player._input).toEqual(expect.objectContaining({
    a: false,
    c: false,
    cp: 0.25,
    cy: 1.5,
    d: false,
    s: false,
    sh: false,
    sp: false,
    w: true,
  }));
  expect(player._input.jd).toBeUndefined();
  expect(cameraPitchCalls).toEqual([ 0.25 ]);
  expect(cameraYawCalls).toEqual([ 1.5 ]);

  player.applyQueuedInputForSimulation();

  expect(player._lastAppliedInputSequenceNumber).toBe(102);
  expect(player._queuedSequencedMovementInputs).toHaveLength(0);
  expect(player._input).toEqual(expect.objectContaining({
    a: true,
    c: false,
    cp: 0.5,
    cy: 2.25,
    d: false,
    jd: 0.75,
    s: false,
    sh: false,
    sp: true,
    w: false,
  }));
  expect(cameraPitchCalls).toEqual([ 0.25, 0.5 ]);
  expect(cameraYawCalls).toEqual([ 1.5, 2.25 ]);
});
