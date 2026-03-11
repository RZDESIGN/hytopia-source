import { expect, test } from 'bun:test';
import protocol from '@hytopia.com/server-protocol';
import EventRouter from '@/events/EventRouter';
import Player, { PlayerEvent } from '@/players/Player';

const createPlayerHarness = () => {
  const player = new Player({} as any, undefined);
  const world = new EventRouter() as any;
  (player as any)._world = world;

  const rollbacks: string[] = [];
  player.on(PlayerEvent.ROLLBACK_BLOCK_EDIT_PREDICTION, ({ predictionId }) => {
    rollbacks.push(predictionId);
  });

  return { player, rollbacks };
};

const createPredictedBlockEditsPacket = (
  predictionId: string,
  editCount: number,
): protocol.PredictedBlockEditsSendPacket => {
  return [
    protocol.PacketId.PREDICTED_BLOCK_EDITS_SEND,
    {
      p: predictionId,
      e: Array.from({ length: editCount }, (_, index) => ({
        c: [ index, 0, 0 ],
        i: index + 1,
      })),
    },
  ];
};

test('rejects oversized predicted block edit batches and rolls them back immediately', () => {
  const { player, rollbacks } = createPlayerHarness();

  (player as any)._onPredictedBlockEditsSendPacket(
    createPredictedBlockEditsPacket('oversized', 65),
  );

  expect(rollbacks).toEqual([ 'oversized' ]);
  expect((player as any)._queuedPredictedBlockEditBatches).toHaveLength(0);
  expect((player as any)._queuedPredictedBlockEditCount).toBe(0);
});

test('drops the oldest queued predicted block edit batches once the queue cap is reached', () => {
  const { player, rollbacks } = createPlayerHarness();

  for (let index = 0; index < 65; index++) {
    (player as any)._onPredictedBlockEditsSendPacket(
      createPredictedBlockEditsPacket(`prediction-${index}`, 1),
    );
  }

  expect(rollbacks).toEqual([ 'prediction-0' ]);
  expect((player as any)._queuedPredictedBlockEditBatches).toHaveLength(64);
  expect((player as any)._queuedPredictedBlockEditBatches[0].predictionId).toBe('prediction-1');
});

test('bounds total queued predicted block edits to avoid large per-tick spikes', () => {
  const { player, rollbacks } = createPlayerHarness();

  for (let index = 0; index < 5; index++) {
    (player as any)._onPredictedBlockEditsSendPacket(
      createPredictedBlockEditsPacket(`batch-${index}`, 64),
    );
  }

  expect(rollbacks).toEqual([ 'batch-0' ]);
  expect((player as any)._queuedPredictedBlockEditBatches).toHaveLength(4);
  expect((player as any)._queuedPredictedBlockEditCount).toBe(256);
  expect((player as any)._queuedPredictedBlockEditBatches[0].predictionId).toBe('batch-1');
});

test('rolls back queued predicted block edits when simulation input is discarded', () => {
  const { player, rollbacks } = createPlayerHarness();

  (player as any)._onPredictedBlockEditsSendPacket(
    createPredictedBlockEditsPacket('queued-prediction', 1),
  );

  player.discardInputForSimulation();

  expect(rollbacks).toEqual([ 'queued-prediction' ]);
  expect((player as any)._queuedPredictedBlockEditBatches).toHaveLength(0);
  expect((player as any)._queuedPredictedBlockEditCount).toBe(0);
  expect(player.predictedBlockEditBatches).toHaveLength(0);
});
