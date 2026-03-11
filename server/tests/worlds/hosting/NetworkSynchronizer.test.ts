import { expect, test } from 'bun:test';
import NetworkSynchronizer from '@/networking/NetworkSynchronizer';
import DefaultPlayerEntityController from '@/worlds/entities/controllers/DefaultPlayerEntityController';

const createHarness = () => {
  const controller = new DefaultPlayerEntityController();
  (controller as any)._groundContactCount = 1;
  (controller as any)._liquidContactCount = 1;
  (controller as any).runByDefault = true;
  (controller as any).movementRelativeToCamera = false;
  (controller as any).movementReferenceYawRad = 1.25;

  const player = {
    id: 'player-1',
    lastAppliedInputSequenceNumber: 77,
    world: undefined as any,
  };

  const playerEntity = {
    controller,
    id: 501,
    isSpawned: true,
    player,
    position: { x: 1, y: 2, z: 3 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
  };

  const world = {
    entityManager: {
      playerEntities: [ playerEntity ],
    },
    final() {},
  };

  player.world = world;

  const synchronizer = new NetworkSynchronizer(world as any);
  const perPlayerEntitySyncs = () => {
    const perPlayer = (synchronizer as any)._queuedEntitySyncs.perPlayer.get(player);
    return perPlayer?.get(playerEntity.id);
  };

  return { perPlayerEntitySyncs, playerEntity, synchronizer };
};

test('owner transform sync keeps prediction metadata paired with authoritative transform', () => {
  const { perPlayerEntitySyncs, playerEntity, synchronizer } = createHarness();

  (synchronizer as any)._queueOwnerPlayerEntityPredictionSync(playerEntity, true);

  expect(perPlayerEntitySyncs()).toEqual(expect.objectContaining({
    aq: 77,
    fd: true,
    i: 501,
    mv: [ 0, 0, 0 ],
    p: [ 1, 2, 3 ],
    pf: 3,
    py: 1.25,
    r: [ 0, 0, 0, 1 ],
  }));
});

test('input acknowledgement sync also refreshes owner prediction metadata', () => {
  const { perPlayerEntitySyncs, synchronizer } = createHarness();

  (synchronizer as any)._queuePlayerInputAcknowledgements();

  expect(perPlayerEntitySyncs()).toEqual(expect.objectContaining({
    aq: 77,
    fd: true,
    i: 501,
    mv: [ 0, 0, 0 ],
    p: [ 1, 2, 3 ],
    pf: 3,
    py: 1.25,
    r: [ 0, 0, 0, 1 ],
  }));
});

test('owner prediction transform updates remain eligible for unreliable delivery', () => {
  const { perPlayerEntitySyncs, playerEntity, synchronizer } = createHarness();

  (synchronizer as any)._queueOwnerPlayerEntityPredictionSync(playerEntity, true);

  expect((synchronizer as any)._isReliableEntitySync(perPlayerEntitySyncs())).toBe(false);
});
