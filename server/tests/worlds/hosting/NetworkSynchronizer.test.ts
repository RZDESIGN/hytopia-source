import { expect, test } from 'bun:test';
import protocol from '@hytopia.com/server-protocol';
import NetworkSynchronizer from '@/networking/NetworkSynchronizer';
import PlayerManager from '@/players/PlayerManager';
import BaseEntityController from '@/worlds/entities/controllers/BaseEntityController';
import DefaultPlayerEntityController from '@/worlds/entities/controllers/DefaultPlayerEntityController';

const createHarness = () => {
  const controller = new DefaultPlayerEntityController();
  (controller as any)._groundContactCount = 1;
  (controller as any)._liquidContactCount = 1;
  (controller as any).runByDefault = true;
  (controller as any).movementRelativeToCamera = false;
  (controller as any).movementReferenceYawRad = 1.25;
  controller.applyDirectionalMovementRotations = false;
  controller.facesCameraWhenIdle = true;

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

class CustomPredictionController extends BaseEntityController {
  public override localPredictionMode = 'custom' as const;
  public override localPredictionCustomState = [ 3, 9 ] as const;
  public override rollbackPredictedInputs = [ 'w', 'q' ] as const;
}

test('owner transform sync keeps prediction metadata paired with authoritative transform', () => {
  const { perPlayerEntitySyncs, playerEntity, synchronizer } = createHarness();

  (synchronizer as any)._queueOwnerPlayerEntityPredictionSync(playerEntity, true);

  expect(perPlayerEntitySyncs()).toEqual(expect.objectContaining({
    aq: 77,
    fd: true,
    i: 501,
    mv: [ 0, 0, 0 ],
    pc: 23,
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
    pc: 23,
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

test('custom player controllers still sync owner prediction mode and rollback metadata', () => {
  const { perPlayerEntitySyncs, playerEntity, synchronizer } = createHarness();

  playerEntity.controller = new CustomPredictionController();
  playerEntity.player.rollbackPredictedInputMaskLow = 1;
  playerEntity.player.rollbackPredictedInputMaskHigh = 0;

  (synchronizer as any)._queueOwnerPlayerEntityPredictionSync(playerEntity, true);

  expect(perPlayerEntitySyncs()).toEqual(expect.objectContaining({
    aq: 77,
    i: 501,
    p: [ 1, 2, 3 ],
    pm: 2,
    ps: [ 3, 9 ],
    r: [ 0, 0, 0, 1 ],
    rl: 1,
  }));
  expect(perPlayerEntitySyncs()?.pc).toBeUndefined();
  expect(perPlayerEntitySyncs()?.pf).toBeUndefined();
});

test('owner prediction updates are isolated into a dedicated unreliable packet batch', () => {
  const { playerEntity, synchronizer } = createHarness();
  const player = playerEntity.player;
  const originalGetConnectedPlayersByWorldSet = PlayerManager.instance.getConnectedPlayersByWorldSet;

  try {
    (PlayerManager.instance as any).getConnectedPlayersByWorldSet = () => [ player ];

    (synchronizer as any)._queueOwnerPlayerEntityPredictionSync(playerEntity, true);
    const otherEntitySync = (synchronizer as any)._createOrGetQueuedEntitySyncById(999, player);
    otherEntitySync.p = [ 9, 9, 9 ];

    const packetPlan = {
      perPlayerPriorityUnreliablePackets: new Map(),
      perPlayerUnreliablePackets: new Map(),
      postPlayerUIAfterChatReliableSlots: [],
      postPlayerUIBeforeWorldAndPlayersReliableSlots: [],
      prePlayerUIReliableSlots: [],
      prePlayerUISpecialReliableSlots: [],
      sharedUnreliablePackets: [],
    };

    (synchronizer as any)._buildEntityPacketSlot(123, packetPlan);

    const priorityPackets = packetPlan.perPlayerPriorityUnreliablePackets.get(player);
    const regularPackets = packetPlan.perPlayerUnreliablePackets.get(player);

    expect(priorityPackets).toHaveLength(1);
    expect(regularPackets).toHaveLength(1);
    expect(priorityPackets?.[0][0]).toBe(protocol.PacketId.ENTITIES);
    expect(priorityPackets?.[0][1]).toEqual([
      expect.objectContaining({
        aq: 77,
        i: 501,
        p: [ 1, 2, 3 ],
        pf: 3,
      }),
    ]);
    expect(regularPackets?.[0][0]).toBe(protocol.PacketId.ENTITIES);
    expect(regularPackets?.[0][1]).toEqual([
      expect.objectContaining({
        i: 999,
        p: [ 9, 9, 9 ],
      }),
    ]);
  } finally {
    (PlayerManager.instance as any).getConnectedPlayersByWorldSet = originalGetConnectedPlayersByWorldSet;
  }
});

test('chunk syncs are split into smaller reliable packet batches', () => {
  const { playerEntity, synchronizer } = createHarness();
  const player = playerEntity.player;
  const serializedBlocks = new Array<number>(4096).fill(1);

  for (let i = 0; i < 10; i++) {
    (synchronizer as any)._queueChunkStateForPlayer({
      originCoordinate: { x: i * 16, y: 0, z: 0 },
      serialize: () => ({
        b: serializedBlocks,
        c: [ i * 16, 0, 0 ],
        r: [],
      }),
    }, player);
  }

  const slot = (synchronizer as any)._buildBatchedSyncPacketSlot(
    (synchronizer as any)._queuedChunkSyncs,
    protocol.outboundPackets.chunksPacketDefinition,
    123,
    4,
  );

  const packets = slot?.perPlayerPackets?.get(player);

  expect(packets).toHaveLength(3);
  expect(packets?.map(packet => packet[0])).toEqual([
    protocol.PacketId.CHUNKS,
    protocol.PacketId.CHUNKS,
    protocol.PacketId.CHUNKS,
  ]);
  expect(packets?.map(packet => (packet[1] as any[]).length)).toEqual([ 4, 4, 2 ]);
});
