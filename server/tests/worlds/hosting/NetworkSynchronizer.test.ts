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

  const player: any = {
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

test('chunk add interest lookup uses indexed player centers', () => {
  const synchronizer = new NetworkSynchronizer({
    chunkLattice: {
      getChunk() {
        return undefined;
      },
    },
    entityManager: {
      getPlayerEntitiesByPlayer() {
        return [];
      },
    },
    final() {},
  } as any);
  const playerNear = { id: 'near' };
  const playerFar = { id: 'far' };
  const originalGetConnectedPlayersByWorldSet = PlayerManager.instance.getConnectedPlayersByWorldSet;

  try {
    (PlayerManager.instance as any).getConnectedPlayersByWorldSet = () => {
      throw new Error('should not scan all players');
    };

    const nearState = (synchronizer as any)._getOrCreatePlayerChunkInterestState(playerNear);
    (synchronizer as any)._setPlayerChunkInterestCenterKey(playerNear, '0,0,0', nearState);

    const farState = (synchronizer as any)._getOrCreatePlayerChunkInterestState(playerFar);
    (synchronizer as any)._setPlayerChunkInterestCenterKey(playerFar, '160,0,0', farState);

    const interestedPlayers = (synchronizer as any)._getPlayersInterestedInChunk({
      originCoordinate: { x: 0, y: 0, z: 0 },
    });

    expect(interestedPlayers).toEqual([ playerNear ]);
  } finally {
    (PlayerManager.instance as any).getConnectedPlayersByWorldSet = originalGetConnectedPlayersByWorldSet;
  }
});

test('chunk interest center follows camera focus before physical camera attachment', () => {
  const kartEntity = {
    id: 9,
    isSpawned: true,
    position: { x: 32, y: 0, z: 0 },
  };
  const focusEntity = {
    id: 10,
    isSpawned: true,
    parent: kartEntity,
    position: { x: 1000, y: 0, z: 1000 },
  };
  const cameraBoomEntity = {
    id: 11,
    isSpawned: true,
    parent: kartEntity,
    position: { x: -1000, y: 0, z: -1000 },
  };
  const player = {
    camera: {
      attachedToEntity: cameraBoomEntity,
      attachedToPosition: undefined,
      targetEntity: focusEntity,
      targetPosition: undefined,
    },
  };
  const synchronizer = new NetworkSynchronizer({
    entityManager: {
      getPlayerEntitiesByPlayer() {
        return [];
      },
    },
    final() {},
  } as any);

  expect((synchronizer as any)._getChunkInterestCenter(player)).toBe(kartEntity.position);

  player.camera.targetEntity = undefined;
  player.camera.targetPosition = { x: 48, y: 0, z: 0 };
  expect((synchronizer as any)._getChunkInterestCenter(player)).toBe(player.camera.targetPosition);

  player.camera.targetPosition = undefined;
  expect((synchronizer as any)._getChunkInterestCenter(player)).toBe(kartEntity.position);
});

test('chunk interest refresh incrementally adds and removes only edge chunks for adjacent movement', () => {
  const queuedLoads: string[] = [];
  const queuedRemovals: string[] = [];
  const chunkMap = new Map<string, { originCoordinate: { x: number; y: number; z: number } }>();
  const makeChunk = (x: number, y: number, z: number) => {
    const chunk = { originCoordinate: { x, y, z } };
    chunkMap.set(`${x},${y},${z}`, chunk);
    return chunk;
  };
  makeChunk(0, 0, 0);
  makeChunk(16, 0, 0);
  makeChunk(112, 0, 0);

  const player = {
    camera: {
      attachedToEntity: undefined,
      attachedToPosition: { x: 0, y: 0, z: 0 },
      targetEntity: undefined,
      targetPosition: undefined,
    },
  };
  const synchronizer = new NetworkSynchronizer({
    chunkLattice: {
      getChunk(originCoordinate: { x: number; y: number; z: number }) {
        return chunkMap.get(`${originCoordinate.x},${originCoordinate.y},${originCoordinate.z}`);
      },
    },
    entityManager: {
      getPlayerEntitiesByPlayer() {
        return [];
      },
    },
    final() {},
  } as any);

  (synchronizer as any)._queueChunkStateForPlayer = (chunk: { originCoordinate: { x: number; y: number; z: number } }) => {
    queuedLoads.push(`${chunk.originCoordinate.x},${chunk.originCoordinate.y},${chunk.originCoordinate.z}`);
  };
  (synchronizer as any)._queueChunkRemovalForPlayer = (chunk: { originCoordinate: { x: number; y: number; z: number } }) => {
    queuedRemovals.push(`${chunk.originCoordinate.x},${chunk.originCoordinate.y},${chunk.originCoordinate.z}`);
  };

  const state = (synchronizer as any)._getOrCreatePlayerChunkInterestState(player);
  (synchronizer as any)._refreshPlayerChunkInterest(player);

  expect(queuedLoads).toEqual([ '0,0,0', '16,0,0' ]);
  expect(queuedRemovals).toEqual([]);
  expect(Array.from((synchronizer as any)._getOrCreateLoadedChunkKeys(player)).sort()).toEqual([ '0,0,0', '16,0,0' ]);

  queuedLoads.length = 0;
  player.camera.attachedToPosition = { x: 16, y: 0, z: 0 };
  state.needsRefresh = false;

  (synchronizer as any)._refreshPlayerChunkInterest(player);

  expect(queuedLoads).toEqual([ '112,0,0' ]);
  expect(queuedRemovals).toEqual([]);
  expect(Array.from((synchronizer as any)._getOrCreateLoadedChunkKeys(player)).sort()).toEqual([ '0,0,0', '112,0,0', '16,0,0' ]);
});

test('chunk interest refresh falls back to full recompute for teleports', () => {
  const player = {
    camera: {
      attachedToEntity: undefined,
      attachedToPosition: { x: 160, y: 0, z: 0 },
      targetEntity: undefined,
      targetPosition: undefined,
    },
  };
  const synchronizer = new NetworkSynchronizer({
    entityManager: {
      getPlayerEntitiesByPlayer() {
        return [];
      },
    },
    final() {},
  } as any);
  const state = (synchronizer as any)._getOrCreatePlayerChunkInterestState(player);
  state.centerChunkKey = '0,0,0';
  state.needsRefresh = false;
  const loadedChunkKeys = (synchronizer as any)._getOrCreateLoadedChunkKeys(player);
  loadedChunkKeys.add('0,0,0');

  let fullRefreshCalls = 0;
  (synchronizer as any)._refreshPlayerChunkInterestFull = () => {
    fullRefreshCalls++;
  };
  (synchronizer as any)._refreshPlayerChunkInterestIncremental = () => {
    throw new Error('should not use incremental refresh for teleports');
  };

  (synchronizer as any)._refreshPlayerChunkInterest(player);

  expect(fullRefreshCalls).toBe(1);
});

test('spatial interest refresh uses full recompute while player stays in the same chunk', () => {
  const player = {
    camera: {
      attachedToEntity: undefined,
      attachedToPosition: { x: 1, y: 0, z: 1 },
      targetEntity: undefined,
      targetPosition: undefined,
    },
  };
  const synchronizer = new NetworkSynchronizer({
    entityManager: {
      getPlayerEntitiesByPlayer() {
        return [];
      },
    },
    final() {},
  } as any);

  let entityFullCalls = 0;
  let particleFullCalls = 0;
  let sceneUIFullCalls = 0;
  (synchronizer as any)._refreshPlayerEntityInterestFull = () => { entityFullCalls++; };
  (synchronizer as any)._refreshPlayerParticleEmitterInterestFull = () => { particleFullCalls++; };
  (synchronizer as any)._refreshPlayerSceneUIInterestFull = () => { sceneUIFullCalls++; };
  (synchronizer as any)._refreshPlayerEntityInterestIncremental = () => { throw new Error('should not use incremental entity refresh'); };
  (synchronizer as any)._refreshPlayerParticleEmitterInterestIncremental = () => { throw new Error('should not use incremental particle refresh'); };
  (synchronizer as any)._refreshPlayerSceneUIInterestIncremental = () => { throw new Error('should not use incremental scene UI refresh'); };

  (synchronizer as any)._refreshPlayerSpatialInterest(player);
  (synchronizer as any)._refreshPlayerSpatialInterest(player);

  expect(entityFullCalls).toBe(2);
  expect(particleFullCalls).toBe(2);
  expect(sceneUIFullCalls).toBe(2);
});

test('spatial interest refresh uses incremental diffs for adjacent chunk movement', () => {
  const player = {
    camera: {
      attachedToEntity: undefined,
      attachedToPosition: { x: 0, y: 0, z: 0 },
      targetEntity: undefined,
      targetPosition: undefined,
    },
  };
  const synchronizer = new NetworkSynchronizer({
    entityManager: {
      getPlayerEntitiesByPlayer() {
        return [];
      },
    },
    final() {},
  } as any);

  let entityIncrementalCalls = 0;
  let particleIncrementalCalls = 0;
  let sceneUIIncrementalCalls = 0;
  (synchronizer as any)._refreshPlayerEntityInterestFull = () => {};
  (synchronizer as any)._refreshPlayerParticleEmitterInterestFull = () => {};
  (synchronizer as any)._refreshPlayerSceneUIInterestFull = () => {};
  (synchronizer as any)._refreshPlayerEntityInterestIncremental = () => { entityIncrementalCalls++; };
  (synchronizer as any)._refreshPlayerParticleEmitterInterestIncremental = () => { particleIncrementalCalls++; };
  (synchronizer as any)._refreshPlayerSceneUIInterestIncremental = () => { sceneUIIncrementalCalls++; };

  (synchronizer as any)._refreshPlayerSpatialInterest(player);
  player.camera.attachedToPosition = { x: 16, y: 0, z: 0 };
  (synchronizer as any)._refreshPlayerSpatialInterest(player);

  expect(entityIncrementalCalls).toBe(1);
  expect(particleIncrementalCalls).toBe(1);
  expect(sceneUIIncrementalCalls).toBe(1);
});

test('spatial interest refresh falls back to full recompute for teleports', () => {
  const player = {
    camera: {
      attachedToEntity: undefined,
      attachedToPosition: { x: 0, y: 0, z: 0 },
      targetEntity: undefined,
      targetPosition: undefined,
    },
  };
  const synchronizer = new NetworkSynchronizer({
    entityManager: {
      getPlayerEntitiesByPlayer() {
        return [];
      },
    },
    final() {},
  } as any);

  let entityFullCalls = 0;
  let particleFullCalls = 0;
  let sceneUIFullCalls = 0;
  (synchronizer as any)._refreshPlayerEntityInterestFull = () => { entityFullCalls++; };
  (synchronizer as any)._refreshPlayerParticleEmitterInterestFull = () => { particleFullCalls++; };
  (synchronizer as any)._refreshPlayerSceneUIInterestFull = () => { sceneUIFullCalls++; };
  (synchronizer as any)._refreshPlayerEntityInterestIncremental = () => { throw new Error('should not use incremental entity refresh'); };
  (synchronizer as any)._refreshPlayerParticleEmitterInterestIncremental = () => { throw new Error('should not use incremental particle refresh'); };
  (synchronizer as any)._refreshPlayerSceneUIInterestIncremental = () => { throw new Error('should not use incremental scene UI refresh'); };

  (synchronizer as any)._refreshPlayerSpatialInterest(player);
  player.camera.attachedToPosition = { x: 160, y: 0, z: 0 };
  (synchronizer as any)._refreshPlayerSpatialInterest(player);

  expect(entityFullCalls).toBe(2);
  expect(particleFullCalls).toBe(2);
  expect(sceneUIFullCalls).toBe(2);
});

test('entity spatial interest only refreshes attached indexes when the entity changes chunks', () => {
  const synchronizer = new NetworkSynchronizer({
    entityManager: {
      getAllEntities() {
        return [];
      },
      getPlayerEntitiesByPlayer() {
        return [];
      },
    },
    particleEmitterManager: {
      getAllParticleEmitters() {
        return [];
      },
    },
    sceneUIManager: {
      getAllSceneUIs() {
        return [];
      },
    },
    final() {},
  } as any);
  const entity = {
    id: 77,
    position: { x: 1, y: 2, z: 3 },
  };

  let attachedRefreshCalls = 0;
  (synchronizer as any)._refreshAttachedSpatialInterestForEntity = () => {
    attachedRefreshCalls++;
  };

  (synchronizer as any)._updateEntitySpatialInterest(entity);
  entity.position = { x: 15, y: 2, z: 3 };
  (synchronizer as any)._updateEntitySpatialInterest(entity);
  entity.position = { x: 16, y: 2, z: 3 };
  (synchronizer as any)._updateEntitySpatialInterest(entity);

  expect(attachedRefreshCalls).toBe(2);
});

test('static environment entities stay loaded outside chunk interest', () => {
  const staticEnvironmentEntity = {
    blockTextureUri: undefined,
    id: 9001,
    isEnvironmental: true,
    modelAnimations: [],
    modelNodeOverrides: [],
    modelTextureUri: undefined,
    modelUri: 'models/environment/trackside-palm.gltf',
    opacity: 1,
    parent: undefined,
    parentNodeName: undefined,
    position: { x: 112, y: 0, z: 0 },
    serialize() {
      return {
        e: true,
        i: this.id,
        m: this.modelUri,
        o: this.opacity,
        p: [ this.position.x, this.position.y, this.position.z ],
        r: [ 0, 0, 0, 1 ],
      };
    },
  };
  const entities = new Map([
    [ staticEnvironmentEntity.id, staticEnvironmentEntity ],
  ]);
  const player = {};
  const synchronizer = new NetworkSynchronizer({
    entityManager: {
      getAllEntities() {
        return Array.from(entities.values());
      },
      getEntity(id: number) {
        return entities.get(id);
      },
      getPlayerEntitiesByPlayer() {
        return [];
      },
    },
    particleEmitterManager: {
      getAllParticleEmitters() {
        return [];
      },
    },
    sceneUIManager: {
      getAllSceneUIs() {
        return [];
      },
    },
    final() {},
  } as any);

  (synchronizer as any)._ensureSpatialInterestIndexesInitialized();
  (synchronizer as any)._refreshPlayerEntityInterestFull(player, { x: 0, y: 0, z: 0 });

  const loadedEntityIds = (synchronizer as any)._getOrCreateLoadedEntityIds(player);
  const perPlayerEntitySyncs = (synchronizer as any)._queuedEntitySyncs.perPlayer.get(player);
  expect(loadedEntityIds.has(staticEnvironmentEntity.id)).toBe(true);
  expect(perPlayerEntitySyncs?.get(staticEnvironmentEntity.id)).toEqual(expect.objectContaining({
    e: true,
    i: staticEnvironmentEntity.id,
    m: staticEnvironmentEntity.modelUri,
  }));

  const removals: number[] = [];
  (synchronizer as any)._queueEntityRemovalForPlayer = (entity: { id: number }) => {
    removals.push(entity.id);
  };
  (synchronizer as any)._refreshPlayerEntityInterestIncremental(player, { x: 16, y: 0, z: 0 }, [], [ '112,0,0' ]);

  expect(loadedEntityIds.has(staticEnvironmentEntity.id)).toBe(true);
  expect(removals).not.toContain(staticEnvironmentEntity.id);
});

test('attached entity and particle spatial interest follows world ancestor instead of local offset', () => {
  const parentEntity = {
    id: 77,
    isSpawned: true,
    position: { x: 0, y: 2, z: 0 },
  };
  const middleEntity = {
    id: 78,
    isSpawned: true,
    parent: parentEntity,
    position: { x: 1000, y: 0, z: 1000 },
  };
  const childEntity = {
    id: 79,
    isSpawned: true,
    parent: middleEntity,
    position: { x: 1000, y: 0, z: 1000 },
  };
  const particleEmitter = {
    attachedToEntity: childEntity,
    id: 901,
    position: { x: -1000, y: 0, z: -1000 },
  };
  const entities = new Map([
    [ parentEntity.id, parentEntity ],
    [ middleEntity.id, middleEntity ],
    [ childEntity.id, childEntity ],
  ]);
  const particleEmitters = new Map([
    [ particleEmitter.id, particleEmitter ],
  ]);
  const synchronizer = new NetworkSynchronizer({
    entityManager: {
      getAllEntities() {
        return Array.from(entities.values());
      },
      getEntity(id: number) {
        return entities.get(id);
      },
      getPlayerEntitiesByPlayer() {
        return [];
      },
    },
    particleEmitterManager: {
      getAllParticleEmitters() {
        return Array.from(particleEmitters.values());
      },
      getParticleEmitterById(id: number) {
        return particleEmitters.get(id);
      },
    },
    sceneUIManager: {
      getAllSceneUIs() {
        return [];
      },
    },
    final() {},
  } as any);

  (synchronizer as any)._ensureSpatialInterestIndexesInitialized();

  const index = (synchronizer as any)._entitySpatialInterestIndex;
  const particleIndex = (synchronizer as any)._particleEmitterSpatialInterestIndex;
  expect(index.collectIdsInRange({ x: 0, y: 0, z: 0 }).has(middleEntity.id)).toBe(true);
  expect(index.collectIdsInRange({ x: 0, y: 0, z: 0 }).has(childEntity.id)).toBe(true);
  expect(particleIndex.collectIdsInRange({ x: 0, y: 0, z: 0 }).has(particleEmitter.id)).toBe(true);

  parentEntity.position = { x: 160, y: 2, z: 0 };
  (synchronizer as any)._updateEntitySpatialInterest(parentEntity);

  expect(index.collectIdsInRange({ x: 0, y: 0, z: 0 }).has(middleEntity.id)).toBe(false);
  expect(index.collectIdsInRange({ x: 0, y: 0, z: 0 }).has(childEntity.id)).toBe(false);
  expect(particleIndex.collectIdsInRange({ x: 0, y: 0, z: 0 }).has(particleEmitter.id)).toBe(false);
  expect(index.collectIdsInRange({ x: 160, y: 0, z: 0 }).has(middleEntity.id)).toBe(true);
  expect(index.collectIdsInRange({ x: 160, y: 0, z: 0 }).has(childEntity.id)).toBe(true);
  expect(particleIndex.collectIdsInRange({ x: 160, y: 0, z: 0 }).has(particleEmitter.id)).toBe(true);
});
