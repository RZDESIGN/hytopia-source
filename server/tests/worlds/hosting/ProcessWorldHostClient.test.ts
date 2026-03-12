import { afterEach, expect, test } from 'bun:test';
import { once } from 'node:events';
import { gunzipSync } from 'node:zlib';
import protocol from '@hytopia.com/server-protocol';
import GatewayPlayerSession from '@/networking/GatewayPlayerSession';
import GatewayPlayerSessionManager from '@/networking/GatewayPlayerSessionManager';
import PlayerManager from '@/players/PlayerManager';
import { PlayerCameraMode } from '@/players/PlayerCamera';
import ProcessWorldHostClient from '@/worlds/hosting/ProcessWorldHostClient';
import BaseEntityController from '@/worlds/entities/controllers/BaseEntityController';
import DefaultPlayerEntityController from '@/worlds/entities/controllers/DefaultPlayerEntityController';
import { unpack } from 'msgpackr';

import type { EntitySchema, OutlineSchema, WorldSchema } from '@hytopia.com/server-protocol';

const ORIGINAL_SPAWN_CHILD = (ProcessWorldHostClient.prototype as any)._spawnChild;
const ORIGINAL_RESPAWN_DELAY_MS = (ProcessWorldHostClient as any)._RESPAWN_DELAY_MS;
const ORIGINAL_GET_CONNECTED_PLAYERS_BY_WORLD_SET = PlayerManager.instance.getConnectedPlayersByWorldSet;
const ORIGINAL_GET_SESSION_BY_PLAYER = GatewayPlayerSessionManager.instance.getSessionByPlayer;
const ORIGINAL_GET_SESSION_BY_PLAYER_ID = GatewayPlayerSessionManager.instance.getSessionByPlayerId;
const cleanupCallbacks: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanupCallbacks.length > 0) {
    const cleanup = cleanupCallbacks.pop();
    await cleanup?.();
  }

  (ProcessWorldHostClient.prototype as any)._spawnChild = ORIGINAL_SPAWN_CHILD;
  (ProcessWorldHostClient as any)._RESPAWN_DELAY_MS = ORIGINAL_RESPAWN_DELAY_MS;
  PlayerManager.instance.getConnectedPlayersByWorldSet = ORIGINAL_GET_CONNECTED_PLAYERS_BY_WORLD_SET;
  GatewayPlayerSessionManager.instance.getSessionByPlayer = ORIGINAL_GET_SESSION_BY_PLAYER;
  GatewayPlayerSessionManager.instance.getSessionByPlayerId = ORIGINAL_GET_SESSION_BY_PLAYER_ID;
});

const decodeWirePackets = (wireBytes: Uint8Array) => {
  let buffer = Buffer.from(wireBytes);
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    buffer = gunzipSync(buffer);
  }

  return unpack(buffer) as unknown[];
};

const waitFor = async (predicate: () => boolean, timeoutMs: number = 2_000) => {
  const startedAt = Date.now();

  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error('Timed out waiting for condition.');
    }

    await Bun.sleep(25);
  }
};

const createOutlineSchema = (): OutlineSchema => ({
  c: [ 1, 0.5, 0 ],
  ci: 1.5,
  o: 0.75,
  oc: true,
  th: 0.1,
});

const createInlineClientStub = (world: any) => ({
  assignPlayerToWorld() {
    return { id: world.id, mode: 'process', name: world.name, processId: 'shadow-test' };
  },
  detachPlayerFromWorld() {},
  getDefaultWorldDescriptor() {
    return undefined;
  },
  getHostedWorldDescriptor() {
    return undefined;
  },
  getLocalWorldById(worldId: number) {
    return worldId === world.id ? world : undefined;
  },
  handlePlayerPacket() {},
  mode: 'inline' as const,
  ownsDerivedState() {
    return false;
  },
  registerWorld() {
    return { id: world.id, mode: 'inline', name: world.name, processId: 'inline-test' };
  },
  removeAudioState() {
    return false;
  },
  requestNotificationPermission() {},
  sendCameraToPlayer() {},
  sendChatMessagesToPlayer() {},
  sendEntitiesToPlayer() {},
  sendPacketsToPlayer() {},
  sendPlayersToPlayer() {},
  sendUIDataToPlayer() {},
  sendUIToPlayer() {},
  sendWorldToPlayer() {},
  setDefaultWorld() {
    return { id: world.id, mode: 'inline', name: world.name, processId: 'inline-test' };
  },
  updateAudioState() {
    return false;
  },
  updateBlockState() {
    return false;
  },
  updateBlockTypeState() {
    return false;
  },
  updateChunkState() {
    return false;
  },
  updateEntityState() {
    return false;
  },
  updateParticleEmitterState() {
    return false;
  },
  updateSceneUIState() {
    return false;
  },
  updateWorldState() {
    return false;
  },
});

const createWorldHarness = () => {
  const controller = new DefaultPlayerEntityController();
  (controller as any)._groundContactCount = 1;
  (controller as any)._liquidContactCount = 1;
  (controller as any).runByDefault = true;
  (controller as any).movementRelativeToCamera = false;
  (controller as any).movementReferenceYawRad = 1.25;
  controller.applyDirectionalMovementRotations = false;
  controller.facesCameraWhenIdle = true;

  const playerEntity = {
    controller,
    id: 501,
    isSpawned: true,
    modelUri: 'models/player.glb',
    player: undefined as any,
    position: { x: 1, y: 2, z: 3 },
    rotation: { w: 1, x: 0, y: 0, z: 0 },
    serialize(): EntitySchema {
      return {
        i: 501,
        m: 'models/player.glb',
        n: 'Player Entity',
        p: [ 1, 2, 3 ],
        r: [ 0, 0, 0, 1 ],
      };
    },
  };

  const player = {
    camera: {
      attachedToEntity: playerEntity,
      mode: PlayerCameraMode.FIRST_PERSON,
      viewModelUri: 'models/view.glb',
    },
    connection: { id: 'connection-1' },
    id: 'player-1',
    lastAppliedInputSequenceNumber: 77,
    profilePictureUrl: 'https://example.com/player.png',
    username: 'Player One',
    world: undefined as any,
  };
  playerEntity.player = player;

  const worldSchema: WorldSchema = { i: 2001, n: 'Recovery Test World', s: 'skyboxes/test', t: 0.05 };
  const world = {
    ambientLightColor: { b: 1, g: 1, r: 1 },
    ambientLightIntensity: 0.5,
    audioManager: {
      getAllAudios() {
        return [];
      },
    },
    blockTypeRegistry: {
      getAllBlockTypes() {
        return [];
      },
    },
    chunkLattice: {
      getAllChunks() {
        return [];
      },
    },
    directionalLightColor: { b: 1, g: 1, r: 1 },
    directionalLightIntensity: 1,
    directionalLightPosition: { x: 0, y: 1, z: 0 },
    entityManager: {
      getAllEntities() {
        return [ playerEntity ];
      },
      getPlayerEntitiesByPlayer(requestedPlayer: unknown) {
        return requestedPlayer === player ? [ playerEntity ] : [];
      },
    },
    fogColor: { b: 0.1, g: 0.1, r: 0.1 },
    fogFar: 200,
    fogNear: 10,
    id: 2001,
    loop: {
      currentTick: 42,
      timestepS: 0.05,
    },
    name: 'Recovery Test World',
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
    serialize() {
      return worldSchema;
    },
    simulation: {
      gravity: { x: 0, y: -9.81, z: 0 },
    },
    skyboxIntensity: 1,
    skyboxUri: 'skyboxes/test',
    tag: 'recovery',
  };
  player.world = world;

  return { player, playerEntity, world };
};

const createSessionHarness = () => {
  const { player, playerEntity, world } = createWorldHarness();
  const sentMessages: any[] = [];
  const session = new GatewayPlayerSession({
    ...player,
    connection: {
      id: 'connection-1',
      send() {},
      sendSerializedBuffer() {},
    },
  } as any);
  const inlineClient = createInlineClientStub(world) as any;
  const worldDescriptor = { id: world.id, mode: 'process', name: world.name, processId: 'shadow-test' } as const;

  (ProcessWorldHostClient.prototype as any)._spawnChild = function noop() {};

  const client = new ProcessWorldHostClient(inlineClient);
  (client as any)._send = (message: any) => {
    if ((client as any)._child?.connected) {
      sentMessages.push(message);
    }
  };
  (client as any)._descriptorsByWorldId.set(world.id, worldDescriptor);

  return { client, inlineClient, player: session.player, playerEntity, sentMessages, session, world, worldDescriptor };
};

class CustomPredictionController extends BaseEntityController {
  public override localPredictionMode = 'custom' as const;
  public override localPredictionCustomState = [ 3, 9 ] as const;
  public override rollbackPredictedInputs = [ 'w', 'q' ] as const;
}

test('replays cached and recoverable player-local entity state during mirrored world bootstrap', () => {
  const { player, playerEntity, world } = createWorldHarness();
  const sentMessages: any[] = [];
  const worldDescriptor = { id: world.id, mode: 'process', name: world.name, processId: 'shadow-test' } as const;
  const session = new GatewayPlayerSession(player as any);
  const inlineClient = createInlineClientStub(world);

  (ProcessWorldHostClient.prototype as any)._spawnChild = function noop() {};
  PlayerManager.instance.getConnectedPlayersByWorldSet = () => new Set([ player as any ]);
  GatewayPlayerSessionManager.instance.getSessionByPlayer = () => session;

  const client = new ProcessWorldHostClient(inlineClient as any);
  (client as any)._child = { connected: true };
  (client as any)._send = (message: any) => {
    sentMessages.push(message);
  };
  (client as any)._descriptorsByWorldId.set(world.id, worldDescriptor);

  client.sendEntitiesToPlayer(session, [{
    i: playerEntity.id,
    ol: createOutlineSchema(),
  }], world.loop.currentTick);
  sentMessages.length = 0;

  (client as any)._bootstrapMirroredWorlds();

  const attachMessage = sentMessages.find(message => {
    return message.type === 'player_attach' && message.player.id === player.id;
  });
  expect(attachMessage).toBeDefined();

  const playerEntitiesMessage = sentMessages.find(message => {
    return message.type === 'player_entities' && message.playerId === player.id;
  });
  expect(playerEntitiesMessage).toBeDefined();
  expect(playerEntitiesMessage.entities).toHaveLength(1);
  expect(playerEntitiesMessage.entities[0]).toEqual(expect.objectContaining({
    aq: 77,
    fd: true,
    i: playerEntity.id,
    m: 'models/view.glb',
    ol: createOutlineSchema(),
    pc: 23,
    pf: 3,
    py: 1.25,
  }));
});

test('custom player controllers preserve owner prediction mode during mirrored world bootstrap', () => {
  const { player, playerEntity, world } = createWorldHarness();
  const sentMessages: any[] = [];
  const worldDescriptor = { id: world.id, mode: 'process', name: world.name, processId: 'shadow-test' } as const;
  const session = new GatewayPlayerSession(player as any);
  const inlineClient = createInlineClientStub(world);

  playerEntity.controller = new CustomPredictionController();
  player.rollbackPredictedInputMaskLow = 1;
  player.rollbackPredictedInputMaskHigh = 0;

  (ProcessWorldHostClient.prototype as any)._spawnChild = function noop() {};
  PlayerManager.instance.getConnectedPlayersByWorldSet = () => new Set([ player as any ]);
  GatewayPlayerSessionManager.instance.getSessionByPlayer = () => session;

  const client = new ProcessWorldHostClient(inlineClient as any);
  (client as any)._child = { connected: true };
  (client as any)._send = (message: any) => {
    sentMessages.push(message);
  };
  (client as any)._descriptorsByWorldId.set(world.id, worldDescriptor);

  (client as any)._bootstrapMirroredWorlds();

  const playerEntitiesMessage = sentMessages.find(message => {
    return message.type === 'player_entities' && message.playerId === player.id;
  });
  expect(playerEntitiesMessage).toBeDefined();
  expect(playerEntitiesMessage.entities).toHaveLength(1);
  expect(playerEntitiesMessage.entities[0]).toEqual(expect.objectContaining({
    aq: 77,
    i: playerEntity.id,
    m: 'models/view.glb',
    pm: 2,
    ps: [ 3, 9 ],
    rl: 1,
  }));
  expect(playerEntitiesMessage.entities[0].pc).toBeUndefined();
  expect(playerEntitiesMessage.entities[0].pf).toBeUndefined();
});

test('clears cached per-player entity overlay state when a player detaches from a mirrored world', () => {
  const { player, playerEntity, world } = createWorldHarness();
  const worldDescriptor = { id: world.id, mode: 'process', name: world.name, processId: 'shadow-test' } as const;
  const session = new GatewayPlayerSession(player as any);
  const inlineClient = createInlineClientStub(world);

  (ProcessWorldHostClient.prototype as any)._spawnChild = function noop() {};

  const client = new ProcessWorldHostClient(inlineClient as any);
  (client as any)._child = { connected: true };
  (client as any)._send = () => {};
  (client as any)._descriptorsByWorldId.set(world.id, worldDescriptor);

  client.sendEntitiesToPlayer(session, [{
    i: playerEntity.id,
    ol: createOutlineSchema(),
  }], world.loop.currentTick);

  client.detachPlayerFromWorld(session, worldDescriptor, 'world_shutdown');

  expect((client as any)._perPlayerEntityStateByWorldId.get(world.id)).toBeUndefined();
});

test('respawn scheduling only boots one replacement child for repeated exit signals', async () => {
  const { world } = createWorldHarness();
  const inlineClient = createInlineClientStub(world);
  let spawnCalls = 0;

  (ProcessWorldHostClient.prototype as any)._spawnChild = function spawnStub(this: ProcessWorldHostClient) {
    spawnCalls += 1;
    (this as any)._child = { connected: true };
  };
  (ProcessWorldHostClient as any)._RESPAWN_DELAY_MS = 5;

  const client = new ProcessWorldHostClient(inlineClient as any);
  (client as any)._child = null;

  (client as any)._scheduleRespawn();
  (client as any)._scheduleRespawn();

  await Bun.sleep(25);

  expect(spawnCalls).toBe(2);
});

test('does not duplicate sync requests inline while a connected child owns the mirrored world', () => {
  const { client, inlineClient, sentMessages, session, worldDescriptor } = createSessionHarness();
  let inlineHandlePlayerPacketCalls = 0;

  inlineClient.handlePlayerPacket = () => {
    inlineHandlePlayerPacketCalls += 1;
  };
  (client as any)._child = { connected: true };
  session.player.world = worldDescriptor as any;

  client.handlePlayerPacket(session, {
    packet: [ protocol.PacketId.SYNC_REQUEST, null ],
    receivedAtMonotonicMs: 10,
    receivedAtUnixMs: 20,
  });

  expect(sentMessages).toHaveLength(1);
  expect(sentMessages[0]).toEqual(expect.objectContaining({
    playerId: session.playerId,
    type: 'player_packets',
    worldId: worldDescriptor.id,
  }));
  expect(inlineHandlePlayerPacketCalls).toBe(0);
});

test('falls back inline for sync requests when the mirrored child is unavailable', () => {
  const { client, inlineClient, sentMessages, session, world } = createSessionHarness();
  let inlineHandlePlayerPacketCalls = 0;

  inlineClient.handlePlayerPacket = () => {
    inlineHandlePlayerPacketCalls += 1;
  };
  (client as any)._child = null;
  session.player.world = world as any;

  client.handlePlayerPacket(session, {
    packet: [ protocol.PacketId.SYNC_REQUEST, null ],
    receivedAtMonotonicMs: 10,
    receivedAtUnixMs: 20,
  });

  expect(sentMessages).toHaveLength(0);
  expect(inlineHandlePlayerPacketCalls).toBe(1);
});

test('does not duplicate targeted entity sends inline while a connected child owns the mirrored world', () => {
  const { client, inlineClient, sentMessages, session, worldDescriptor } = createSessionHarness();
  let inlineEntitySendCalls = 0;

  inlineClient.sendEntitiesToPlayer = () => {
    inlineEntitySendCalls += 1;
  };
  (client as any)._child = { connected: true };
  session.player.world = worldDescriptor as any;

  client.sendEntitiesToPlayer(session, [{
    i: 999,
    ol: createOutlineSchema(),
  }], 123);

  expect(sentMessages).toHaveLength(1);
  expect(sentMessages[0]).toEqual(expect.objectContaining({
    playerId: session.playerId,
    type: 'player_entities',
    worldId: worldDescriptor.id,
    worldTick: 123,
  }));
  expect(inlineEntitySendCalls).toBe(0);
});

test('falls back inline for targeted entity sends when the mirrored child is unavailable', () => {
  const { client, inlineClient, sentMessages, session, world } = createSessionHarness();
  let inlineEntitySendCalls = 0;

  inlineClient.sendEntitiesToPlayer = () => {
    inlineEntitySendCalls += 1;
  };
  (client as any)._child = null;
  session.player.world = world as any;

  client.sendEntitiesToPlayer(session, [{
    i: 999,
    ol: createOutlineSchema(),
  }], 123);

  expect(sentMessages).toHaveLength(0);
  expect(inlineEntitySendCalls).toBe(1);
});

test('real child restart reboots mirrored world state and resumes targeted entity forwarding without inline fallback', async () => {
  const { player, playerEntity, world } = createWorldHarness();
  const serializedBatches: Uint8Array[] = [];
  const inlineClient = createInlineClientStub(world) as any;
  const worldDescriptor = { id: world.id, mode: 'process', name: world.name, processId: 'shadow-test' } as const;
  const session = new GatewayPlayerSession({
    ...player,
    connection: {
      id: 'connection-1',
      send() {},
      sendSerializedBuffer(wireBytes: Uint8Array) {
        serializedBatches.push(wireBytes);
      },
    },
  } as any);
  let inlineEntitySends = 0;

  inlineClient.sendEntitiesToPlayer = () => {
    inlineEntitySends += 1;
  };

  (ProcessWorldHostClient as any)._RESPAWN_DELAY_MS = 25;
  PlayerManager.instance.getConnectedPlayersByWorldSet = () => new Set([ session.player ]);
  GatewayPlayerSessionManager.instance.getSessionByPlayer = () => session;
  GatewayPlayerSessionManager.instance.getSessionByPlayerId = playerId => {
    return playerId === session.playerId ? session : undefined;
  };

  const client = new ProcessWorldHostClient(inlineClient);
  cleanupCallbacks.push(async () => {
    const activeChild = (client as any)._child;
    clearTimeout((client as any)._respawnTimer);
    (client as any)._respawnTimer = undefined;
    (client as any)._scheduleRespawn = () => {};

    if (activeChild?.exitCode === null && activeChild?.signalCode === null) {
      activeChild.kill('SIGTERM');
      await once(activeChild, 'exit');
    }
  });

  (client as any)._descriptorsByWorldId.set(world.id, worldDescriptor);
  (client as any)._bootstrapMirroredWorlds();

  await waitFor(() => serializedBatches.length > 0);
  serializedBatches.length = 0;

  const firstChild = (client as any)._child;
  firstChild.kill('SIGTERM');
  await once(firstChild, 'exit');

  await waitFor(() => {
    const nextChild = (client as any)._child;
    return !!nextChild && nextChild !== firstChild && nextChild.connected;
  }, 5_000);
  await waitFor(() => serializedBatches.length > 0, 5_000);
  serializedBatches.length = 0;

  client.sendEntitiesToPlayer(session, [{
    i: playerEntity.id,
    ol: createOutlineSchema(),
  }], world.loop.currentTick);

  await waitFor(() => {
    return serializedBatches.some(batch => {
      const packets = decodeWirePackets(batch) as any[];
      return packets.some(packet => {
        return packet[0] === 38 && packet[1]?.[0]?.i === playerEntity.id;
      });
    });
  }, 5_000);

  const matchingBatches = serializedBatches.filter(batch => {
    const packets = decodeWirePackets(batch) as any[];
    return packets.some(packet => {
      return packet[0] === 38 && packet[1]?.[0]?.i === playerEntity.id && packet[1]?.[0]?.ol;
    });
  });

  expect(matchingBatches).toHaveLength(1);
  expect(inlineEntitySends).toBe(0);
});
