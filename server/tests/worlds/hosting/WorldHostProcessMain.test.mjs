import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { unpack } from 'msgpackr';

const WORLD_HOST_PROCESS_MAIN_PATH = fileURLToPath(
  new URL('../../../src/worlds/hosting/WorldHostProcessMain.js', import.meta.url),
);
const WORLD_PACKET_ID = 39;
const BLOCKS_PACKET_ID = 34;
const CAMERA_PACKET_ID = 40;
const CHUNKS_PACKET_ID = 37;
const ENTITIES_PACKET_ID = 38;
const PARTICLE_EMITTERS_PACKET_ID = 46;
const PLAYERS_PACKET_ID = 45;
const SCENE_UIS_PACKET_ID = 43;

const createWorldDescriptor = worldId => ({
  id: worldId,
  mode: 'process',
  name: `Test World ${worldId}`,
  processId: `shadow-test-${worldId}`,
});

const createWorldBootOptions = worldId => ({
  id: worldId,
  name: `Test World ${worldId}`,
  skyboxUri: 'skyboxes/test',
  tickRate: 20,
});

const createPlayerDescriptor = playerId => ({
  connectionId: `connection-${playerId}`,
  id: playerId,
  isGuest: false,
  username: `Player ${playerId}`,
});

const decodeWirePackets = wireBytes => {
  let buffer = Buffer.from(wireBytes);
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    buffer = gunzipSync(buffer);
  }

  return unpack(buffer);
};

const createChildHarness = async t => {
  let stderrOutput = '';
  const child = spawn(process.execPath, [ WORLD_HOST_PROCESS_MAIN_PATH ], {
    serialization: 'advanced',
    stdio: [ 'ignore', 'ignore', 'pipe', 'ipc' ],
  });
  const messages = [];

  const onMessage = message => {
    messages.push(message);
  };

  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', chunk => {
    stderrOutput += chunk;
  });
  child.on('message', onMessage);

  const waitForMessage = async (predicate, timeoutMs = 2_000) => {
    const start = Date.now();

    for (;;) {
      const existingIndex = messages.findIndex(predicate);
      if (existingIndex >= 0) {
        return messages.splice(existingIndex, 1)[0];
      }

      const remainingMs = timeoutMs - (Date.now() - start);
      if (remainingMs <= 0) {
        throw new Error(`Timed out waiting for child host message.${stderrOutput ? ` stderr: ${stderrOutput}` : ''}`);
      }

      await Promise.race([
        once(child, 'message'),
        new Promise((_, reject) => {
          setTimeout(() => {
            reject(new Error(`Timed out waiting for child host message.${stderrOutput ? ` stderr: ${stderrOutput}` : ''}`));
          }, remainingMs);
        }),
      ]);
    }
  };

  const expectNoMessage = async (predicate, timeoutMs = 150) => {
    const existingIndex = messages.findIndex(predicate);
    if (existingIndex >= 0) {
      throw new Error(`Unexpected child host message: ${JSON.stringify(messages[existingIndex])}`);
    }

    try {
      await waitForMessage(predicate, timeoutMs);
      throw new Error('Unexpected child host message.');
    } catch (error) {
      if (error instanceof Error && error.message === 'Unexpected child host message.') {
        throw error;
      }
    }
  };

  const send = message => {
    child.send(message);
  };

  t.after(async () => {
    child.off('message', onMessage);
    child.stderr?.removeAllListeners('data');

    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }

    child.kill('SIGTERM');
    try {
      await Promise.race([
        once(child, 'exit'),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Timed out waiting for child host exit.')), 500);
        }),
      ]);
    } catch {
      child.kill('SIGKILL');
      if (child.exitCode === null && child.signalCode === null) {
        await once(child, 'exit');
      }
    }
  });

  return { child, expectNoMessage, send, waitForMessage };
};

test('bootstraps world, entities, and players in stable attach order', async t => {
  const harness = await createChildHarness(t);
  const worldId = 101;

  harness.send({
    options: createWorldBootOptions(worldId),
    processId: 'shadow-test',
    type: 'world_boot',
    world: createWorldDescriptor(worldId),
  });
  await harness.waitForMessage(message => message.type === 'world_ready' && message.world?.id === worldId);

  harness.send({
    type: 'world_state_patch',
    world: { i: worldId, n: 'Bootstrapped World' },
    worldId,
    worldTick: 7,
  });
  harness.send({
    entity: {
      i: 5001,
      ma: [{ n: 'idle', p: true }],
      mo: [{ h: true, n: 'hat' }],
      n: 'Training Bot',
      p: [ 1, 2, 3 ],
      r: [ 0, 0, 0, 1 ],
    },
    type: 'entity_state_patch',
    worldId,
    worldTick: 8,
  });
  harness.send({
    player: createPlayerDescriptor('player-a'),
    type: 'player_attach',
    worldId,
  });

  const batchMessage = await harness.waitForMessage(message => {
    return message.type === 'player_packet_batch' && message.playerId === 'player-a';
  });
  const packets = decodeWirePackets(batchMessage.wireBytes);
  const packetIds = packets.map(packet => packet[0]);

  assert.deepEqual(packetIds, [ WORLD_PACKET_ID, PLAYERS_PACKET_ID ]);
  assert.equal(packets[0][1].n, 'Bootstrapped World');
  assert.equal(packets[1][1][0].i, 'player-a');

  harness.send({
    camera: { e: 5001 },
    playerId: 'player-a',
    type: 'player_camera',
    worldId,
    worldTick: 9,
  });

  const spatialBootstrapMessage = await harness.waitForMessage(message => {
    return message.type === 'player_packet_batch' && message.playerId === 'player-a';
  });
  const spatialBootstrapPackets = decodeWirePackets(spatialBootstrapMessage.wireBytes);
  const entityPackets = spatialBootstrapPackets.filter(packet => packet[0] === ENTITIES_PACKET_ID);
  assert.equal(entityPackets.length > 0, true);
  const bootstrappedEntities = entityPackets.flatMap(packet => packet[1]);
  assert.equal(bootstrappedEntities[0].n, 'Training Bot');
  assert.deepEqual(bootstrappedEntities[0].ma, [{ n: 'idle', p: true }]);
  assert.equal(bootstrappedEntities[0].mo.length, 1);
  assert.equal(bootstrappedEntities[0].mo[0].n, 'hat');
  assert.equal(bootstrappedEntities[0].mo[0].h, true);
});

test('merges nested entity patches into bootstrap state for future joins', async t => {
  const harness = await createChildHarness(t);
  const worldId = 102;

  harness.send({
    options: createWorldBootOptions(worldId),
    processId: 'shadow-test',
    type: 'world_boot',
    world: createWorldDescriptor(worldId),
  });
  await harness.waitForMessage(message => message.type === 'world_ready' && message.world?.id === worldId);

  harness.send({
    entity: {
      i: 5002,
      ma: [{ l: 1, n: 'idle', p: true }],
      mo: [{ h: true, n: 'hat' }],
      n: 'Merge Bot',
      p: [ 4, 5, 6 ],
      r: [ 0, 0, 0, 1 ],
    },
    type: 'entity_state_patch',
    worldId,
    worldTick: 4,
  });
  harness.send({
    entity: {
      i: 5002,
      ma: [{ n: 'idle', w: 0.5 }],
      mo: [{ n: 'hat', rm: true }, { h: false, n: 'visor' }],
    },
    type: 'entity_state_patch',
    worldId,
    worldTick: 5,
  });
  harness.send({
    player: createPlayerDescriptor('player-b'),
    type: 'player_attach',
    worldId,
  });

  const batchMessage = await harness.waitForMessage(message => {
    return message.type === 'player_packet_batch' && message.playerId === 'player-b';
  });
  const packets = decodeWirePackets(batchMessage.wireBytes);
  assert.equal(packets.some(packet => packet[0] === ENTITIES_PACKET_ID), false);

  harness.send({
    camera: { e: 5002 },
    playerId: 'player-b',
    type: 'player_camera',
    worldId,
    worldTick: 6,
  });

  const spatialBootstrapMessage = await harness.waitForMessage(message => {
    return message.type === 'player_packet_batch' && message.playerId === 'player-b';
  });
  const spatialBootstrapPackets = decodeWirePackets(spatialBootstrapMessage.wireBytes);
  const entitiesPacket = spatialBootstrapPackets.find(packet => packet[0] === ENTITIES_PACKET_ID);
  const mergedEntity = entitiesPacket[1][0];

  assert.deepEqual(mergedEntity.ma, [{ l: 1, n: 'idle', p: true, w: 0.5 }]);
  assert.equal(mergedEntity.mo.length, 1);
  assert.equal(mergedEntity.mo[0].n, 'visor');
  assert.equal(mergedEntity.mo[0].h, false);
});

test('streams static environment entities outside chunk interest', async t => {
  const harness = await createChildHarness(t);
  const worldId = 107;

  harness.send({
    options: createWorldBootOptions(worldId),
    processId: 'shadow-test',
    type: 'world_boot',
    world: createWorldDescriptor(worldId),
  });
  await harness.waitForMessage(message => message.type === 'world_ready' && message.world?.id === worldId);

  harness.send({
    entity: {
      e: true,
      i: 7301,
      m: 'models/environment/trackside-palm.gltf',
      ma: [],
      mo: [],
      o: 1,
      p: [112, 0, 0],
      r: [0, 0, 0, 1],
    },
    type: 'entity_state_patch',
    worldId,
    worldTick: 2,
  });
  harness.send({
    player: createPlayerDescriptor('player-static-env'),
    type: 'player_attach',
    worldId,
  });
  await harness.waitForMessage(message => {
    return message.type === 'player_packet_batch' && message.playerId === 'player-static-env';
  });

  harness.send({
    camera: { e: null, p: [0, 0, 0] },
    playerId: 'player-static-env',
    type: 'player_camera',
    worldId,
    worldTick: 3,
  });

  const bootstrapPackets = [];
  const bootstrapStartedAt = Date.now();
  while (Date.now() - bootstrapStartedAt < 4_000) {
    const batchMessage = await harness.waitForMessage(message => {
      return message.type === 'player_packet_batch' && message.playerId === 'player-static-env';
    }, 4_000 - (Date.now() - bootstrapStartedAt));
    bootstrapPackets.push(...decodeWirePackets(batchMessage.wireBytes));

    const entityPayloads = bootstrapPackets.filter(packet => packet[0] === ENTITIES_PACKET_ID).flatMap(packet => packet[1]);
    const staticEnvironmentEntity = entityPayloads.find(entity => entity.i === 7301 && entity.e === true);
    if (staticEnvironmentEntity) {
      assert.equal(staticEnvironmentEntity.m, 'models/environment/trackside-palm.gltf');
      break;
    }
  }

  const bootstrappedEntityPayloads = bootstrapPackets.filter(packet => packet[0] === ENTITIES_PACKET_ID).flatMap(packet => packet[1]);
  assert.equal(bootstrappedEntityPayloads.some(entity => entity.i === 7301 && entity.e === true), true);

  harness.send({
    entity: {
      i: 7301,
      t: [255, 0, 0],
    },
    type: 'entity_state_patch',
    worldId,
    worldTick: 4,
  });

  const updateStartedAt = Date.now();
  while (Date.now() - updateStartedAt < 4_000) {
    const batchMessage = await harness.waitForMessage(message => {
      return message.type === 'player_packet_batch' && message.playerId === 'player-static-env';
    }, 4_000 - (Date.now() - updateStartedAt));
    const packets = decodeWirePackets(batchMessage.wireBytes);
    const entityPayloads = packets.filter(packet => packet[0] === ENTITIES_PACKET_ID).flatMap(packet => packet[1]);
    const tintUpdate = entityPayloads.find(entity => entity.i === 7301 && entity.t);
    if (tintUpdate) {
      assert.deepEqual(tintUpdate.t, [255, 0, 0]);
      return;
    }
  }

  assert.fail('Timed out waiting for long-range static environment entity update.');
});

test('routes targeted entity batches only to the addressed player', async t => {
  const harness = await createChildHarness(t);
  const worldId = 103;

  harness.send({
    options: createWorldBootOptions(worldId),
    processId: 'shadow-test',
    type: 'world_boot',
    world: createWorldDescriptor(worldId),
  });
  await harness.waitForMessage(message => message.type === 'world_ready' && message.world?.id === worldId);

  harness.send({
    player: createPlayerDescriptor('player-c'),
    type: 'player_attach',
    worldId,
  });
  harness.send({
    player: createPlayerDescriptor('player-d'),
    type: 'player_attach',
    worldId,
  });
  await harness.waitForMessage(message => message.type === 'player_packet_batch' && message.playerId === 'player-c');
  await harness.waitForMessage(message => message.type === 'player_packet_batch' && message.playerId === 'player-d');

  harness.send({
    entities: [{
      i: 7001,
      ol: {
        c: [ 1, 0.5, 0 ],
        ci: 2,
        o: 1,
        oc: true,
        th: 0.1,
      },
    }],
    playerId: 'player-c',
    type: 'player_entities',
    worldId,
    worldTick: 12,
  });

  const batchMessage = await harness.waitForMessage(message => {
    if (message.type !== 'player_packet_batch' || message.playerId !== 'player-c') {
      return false;
    }

    return decodeWirePackets(message.wireBytes).some(packet => {
      return packet[0] === ENTITIES_PACKET_ID && packet[1][0]?.i === 7001;
    });
  });
  const packets = decodeWirePackets(batchMessage.wireBytes);

  assert.deepEqual(packets.map(packet => packet[0]), [ ENTITIES_PACKET_ID ]);
  assert.equal(packets[0][1][0].i, 7001);
  await harness.expectNoMessage(message => message.type === 'player_packet_batch' && message.playerId === 'player-d');
});

test('streams nearby chunks and spatial state only after player camera interest is known', async t => {
  const harness = await createChildHarness(t);
  const worldId = 104;
  const nearChunkBlocks = new Uint8Array(16 ** 3).fill(1);
  const farChunkBlocks = new Uint8Array(16 ** 3).fill(2);

  harness.send({
    options: createWorldBootOptions(worldId),
    processId: 'shadow-test',
    type: 'world_boot',
    world: createWorldDescriptor(worldId),
  });
  await harness.waitForMessage(message => message.type === 'world_ready' && message.world?.id === worldId);

  harness.send({
    chunk: { b: nearChunkBlocks, c: [0, 0, 0] },
    type: 'chunk_state_patch',
    worldId,
    worldTick: 2,
  });
  harness.send({
    chunk: { b: farChunkBlocks, c: [160, 0, 0] },
    type: 'chunk_state_patch',
    worldId,
    worldTick: 2,
  });
  harness.send({
    entity: {
      i: 7001,
      p: [1, 2, 3],
      r: [0, 0, 0, 1],
    },
    type: 'entity_state_patch',
    worldId,
    worldTick: 3,
  });
  harness.send({
    entity: {
      i: 7002,
      p: [160, 2, 3],
      r: [0, 0, 0, 1],
    },
    type: 'entity_state_patch',
    worldId,
    worldTick: 3,
  });
  harness.send({
    particleEmitter: {
      i: 8001,
      p: [2, 2, 2],
      tu: 'particles/near.png',
    },
    type: 'particle_emitter_state_patch',
    worldId,
    worldTick: 3,
  });
  harness.send({
    particleEmitter: {
      i: 8002,
      p: [160, 2, 2],
      tu: 'particles/far.png',
    },
    type: 'particle_emitter_state_patch',
    worldId,
    worldTick: 3,
  });
  harness.send({
    sceneUI: {
      i: 9001,
      p: [1, 3, 1],
      s: { label: 'near' },
      t: 'nametag',
      v: 30,
    },
    type: 'scene_ui_state_patch',
    worldId,
    worldTick: 3,
  });
  harness.send({
    sceneUI: {
      i: 9002,
      p: [160, 3, 1],
      s: { label: 'far' },
      t: 'nametag',
      v: 30,
    },
    type: 'scene_ui_state_patch',
    worldId,
    worldTick: 3,
  });
  harness.send({
    player: createPlayerDescriptor('player-e'),
    type: 'player_attach',
    worldId,
  });

  const bootstrapMessage = await harness.waitForMessage(message => {
    return message.type === 'player_packet_batch' && message.playerId === 'player-e';
  });
  const bootstrapPackets = decodeWirePackets(bootstrapMessage.wireBytes);
  assert.equal(bootstrapPackets.some(packet => packet[0] === CHUNKS_PACKET_ID), false);
  assert.equal(bootstrapPackets.some(packet => packet[0] === ENTITIES_PACKET_ID), false);
  assert.equal(bootstrapPackets.some(packet => packet[0] === PARTICLE_EMITTERS_PACKET_ID), false);
  assert.equal(bootstrapPackets.some(packet => packet[0] === SCENE_UIS_PACKET_ID), false);

  harness.send({
    camera: { e: 7001 },
    playerId: 'player-e',
    type: 'player_camera',
    worldId,
    worldTick: 4,
  });

  const chunkLoadMessage = await harness.waitForMessage(message => {
    return message.type === 'player_packet_batch' && message.playerId === 'player-e';
  });
  const chunkLoadPackets = decodeWirePackets(chunkLoadMessage.wireBytes);
  assert.equal(chunkLoadPackets[0][0], CAMERA_PACKET_ID);
  const chunkLoads = chunkLoadPackets.filter(packet => packet[0] === CHUNKS_PACKET_ID).flatMap(packet => packet[1]);
  const entityLoads = chunkLoadPackets.filter(packet => packet[0] === ENTITIES_PACKET_ID).flatMap(packet => packet[1]);
  const particleLoads = chunkLoadPackets.filter(packet => packet[0] === PARTICLE_EMITTERS_PACKET_ID).flatMap(packet => packet[1]);
  const sceneUILoads = chunkLoadPackets.filter(packet => packet[0] === SCENE_UIS_PACKET_ID).flatMap(packet => packet[1]);
  assert.deepEqual(chunkLoads.map(chunk => chunk.c), [[0, 0, 0]]);
  assert.equal(Array.isArray(chunkLoads[0].b) || ArrayBuffer.isView(chunkLoads[0].b), true);
  assert.equal(chunkLoads[0].b[0], 1);
  assert.deepEqual(entityLoads.map(entity => entity.i), [7001]);
  assert.deepEqual(particleLoads.map(particleEmitter => particleEmitter.i), [8001]);
  assert.deepEqual(sceneUILoads.map(sceneUI => sceneUI.i), [9001]);

  harness.send({
    camera: { e: null, p: [160, 2, 3] },
    playerId: 'player-e',
    type: 'player_camera',
    worldId,
    worldTick: 4,
  });

  const farInterestMessage = await harness.waitForMessage(message => {
    return message.type === 'player_packet_batch' && message.playerId === 'player-e';
  });
  const farInterestPackets = decodeWirePackets(farInterestMessage.wireBytes);
  assert.equal(farInterestPackets[0][0], CAMERA_PACKET_ID);
  const farChunkPackets = farInterestPackets.filter(packet => packet[0] === CHUNKS_PACKET_ID).flatMap(packet => packet[1]);
  const farEntityPackets = farInterestPackets.filter(packet => packet[0] === ENTITIES_PACKET_ID).flatMap(packet => packet[1]);
  const farParticlePackets = farInterestPackets.filter(packet => packet[0] === PARTICLE_EMITTERS_PACKET_ID).flatMap(packet => packet[1]);
  const farSceneUIPackets = farInterestPackets.filter(packet => packet[0] === SCENE_UIS_PACKET_ID).flatMap(packet => packet[1]);
  assert.deepEqual(farChunkPackets.map(chunk => chunk.c).sort(), [[0, 0, 0], [160, 0, 0]]);
  assert.deepEqual(
    farChunkPackets.map(chunk => chunk.rm === true ? { c: chunk.c, rm: true } : { c: chunk.c, rm: false }).sort((a, b) => a.c[0] - b.c[0]),
    [{ c: [0, 0, 0], rm: true }, { c: [160, 0, 0], rm: false }],
  );
  assert.deepEqual(
    farEntityPackets.map(entity => entity.rm ? { i: entity.i, rm: true } : { i: entity.i, rm: false }).sort((a, b) => a.i - b.i),
    [{ i: 7001, rm: true }, { i: 7002, rm: false }],
  );
  assert.deepEqual(
    farParticlePackets.map(particleEmitter => particleEmitter.rm ? { i: particleEmitter.i, rm: true } : { i: particleEmitter.i, rm: false }).sort((a, b) => a.i - b.i),
    [{ i: 8001, rm: true }, { i: 8002, rm: false }],
  );
  assert.deepEqual(
    farSceneUIPackets.map(sceneUI => sceneUI.rm ? { i: sceneUI.i, rm: true } : { i: sceneUI.i, rm: false }).sort((a, b) => a.i - b.i),
    [{ i: 9001, rm: true }, { i: 9002, rm: false }],
  );

  harness.send({
    block: { c: [1, 0, 1], i: 3 },
    type: 'block_state_patch',
    worldId,
    worldTick: 5,
  });
  harness.send({
    block: { c: [160, 0, 1], i: 4 },
    type: 'block_state_patch',
    worldId,
    worldTick: 5,
  });

  const blockDeltaMessage = await harness.waitForMessage(message => {
    return message.type === 'player_packet_batch' && message.playerId === 'player-e';
  });
  const blockDeltaPackets = decodeWirePackets(blockDeltaMessage.wireBytes);
  assert.deepEqual(blockDeltaPackets.map(packet => packet[0]), [ BLOCKS_PACKET_ID ]);
  assert.deepEqual(blockDeltaPackets[0][1], [{ c: [160, 0, 1], i: 4 }]);
});

test('shadow host spatial interest follows camera target before physical attachment', async t => {
  const harness = await createChildHarness(t);
  const worldId = 108;

  harness.send({
    options: createWorldBootOptions(worldId),
    processId: 'shadow-test',
    type: 'world_boot',
    world: createWorldDescriptor(worldId),
  });
  await harness.waitForMessage(message => message.type === 'world_ready' && message.world?.id === worldId);

  harness.send({
    entity: {
      i: 7101,
      n: 'Kart Root',
      p: [1, 2, 3],
      r: [0, 0, 0, 1],
    },
    type: 'entity_state_patch',
    worldId,
    worldTick: 3,
  });
  harness.send({
    entity: {
      i: 7102,
      n: 'Camera Boom',
      p: [160, 2, 3],
      r: [0, 0, 0, 1],
    },
    type: 'entity_state_patch',
    worldId,
    worldTick: 3,
  });
  harness.send({
    entity: {
      i: 7103,
      n: 'Parented Target Focus',
      p: [1000, 0, 1000],
      pe: 7101,
      r: [0, 0, 0, 1],
    },
    type: 'entity_state_patch',
    worldId,
    worldTick: 3,
  });
  harness.send({
    particleEmitter: {
      e: 7103,
      i: 8101,
      p: [-1000, 0, -1000],
      tu: 'particles/attached.png',
    },
    type: 'particle_emitter_state_patch',
    worldId,
    worldTick: 3,
  });
  harness.send({
    player: createPlayerDescriptor('player-focus'),
    type: 'player_attach',
    worldId,
  });

  const bootstrapMessage = await harness.waitForMessage(message => {
    return message.type === 'player_packet_batch' && message.playerId === 'player-focus';
  });
  const bootstrapPackets = decodeWirePackets(bootstrapMessage.wireBytes);
  assert.equal(bootstrapPackets.some(packet => packet[0] === ENTITIES_PACKET_ID), false);

  harness.send({
    camera: { e: 7102, et: 7103 },
    playerId: 'player-focus',
    type: 'player_camera',
    worldId,
    worldTick: 4,
  });

  const focusInterestMessage = await harness.waitForMessage(message => {
    return message.type === 'player_packet_batch' && message.playerId === 'player-focus';
  });
  const focusInterestPackets = decodeWirePackets(focusInterestMessage.wireBytes);
  const entityLoads = focusInterestPackets.filter(packet => packet[0] === ENTITIES_PACKET_ID).flatMap(packet => packet[1]);
  const particleLoads = focusInterestPackets.filter(packet => packet[0] === PARTICLE_EMITTERS_PACKET_ID).flatMap(packet => packet[1]);

  assert.deepEqual(entityLoads.map(entity => entity.i).sort((a, b) => a - b), [7101, 7103]);
  assert.deepEqual(particleLoads.map(particleEmitter => particleEmitter.i), [8101]);

  harness.send({
    entity: {
      i: 7101,
      p: [160, 2, 3],
    },
    type: 'entity_state_patch',
    worldId,
    worldTick: 5,
  });

  const parentMoveMessage = await harness.waitForMessage(message => {
    return message.type === 'player_packet_batch' && message.playerId === 'player-focus';
  });
  const parentMovePackets = decodeWirePackets(parentMoveMessage.wireBytes);
  const parentMoveEntityLoads = parentMovePackets.filter(packet => packet[0] === ENTITIES_PACKET_ID).flatMap(packet => packet[1]);

  assert.equal(parentMoveEntityLoads.some(entity => entity.i === 7102 && !entity.rm), true);
});

test('applies block deltas to mirrored typed-array chunk state for future chunk loads', async t => {
  const harness = await createChildHarness(t);
  const worldId = 107;
  const initialBlocks = new Uint8Array(16 ** 3).fill(1);

  harness.send({
    options: createWorldBootOptions(worldId),
    processId: 'shadow-test',
    type: 'world_boot',
    world: createWorldDescriptor(worldId),
  });
  await harness.waitForMessage(message => message.type === 'world_ready' && message.world?.id === worldId);

  harness.send({
    chunk: { b: initialBlocks, c: [0, 0, 0] },
    type: 'chunk_state_patch',
    worldId,
    worldTick: 2,
  });
  harness.send({
    block: { c: [1, 0, 1], i: 3 },
    type: 'block_state_patch',
    worldId,
    worldTick: 3,
  });
  harness.send({
    player: createPlayerDescriptor('player-h'),
    type: 'player_attach',
    worldId,
  });
  await harness.waitForMessage(message => message.type === 'player_packet_batch' && message.playerId === 'player-h');

  harness.send({
    camera: { e: null, p: [0, 2, 0] },
    playerId: 'player-h',
    type: 'player_camera',
    worldId,
    worldTick: 4,
  });

  const chunkLoadMessage = await harness.waitForMessage(message => {
    return message.type === 'player_packet_batch' && message.playerId === 'player-h';
  });
  const chunkLoadPackets = decodeWirePackets(chunkLoadMessage.wireBytes);
  const chunkLoads = chunkLoadPackets.filter(packet => packet[0] === CHUNKS_PACKET_ID).flatMap(packet => packet[1]);

  assert.equal(chunkLoads.length, 1);
  assert.equal(Array.isArray(chunkLoads[0].b) || ArrayBuffer.isView(chunkLoads[0].b), true);
  assert.equal(chunkLoads[0].b[257], 3);
});

test('coalesces same-tick spatial interest loads with same-channel patches to latest state', async t => {
  const harness = await createChildHarness(t);
  const worldId = 105;

  harness.send({
    options: createWorldBootOptions(worldId),
    processId: 'shadow-test',
    type: 'world_boot',
    world: createWorldDescriptor(worldId),
  });
  await harness.waitForMessage(message => message.type === 'world_ready' && message.world?.id === worldId);

  harness.send({
    entity: {
      i: 7101,
      n: 'Far Bot',
      p: [160, 2, 3],
      r: [0, 0, 0, 1],
    },
    type: 'entity_state_patch',
    worldId,
    worldTick: 2,
  });
  harness.send({
    particleEmitter: {
      i: 8101,
      p: [160, 2, 2],
      tu: 'particles/far.png',
    },
    type: 'particle_emitter_state_patch',
    worldId,
    worldTick: 2,
  });
  harness.send({
    sceneUI: {
      i: 9101,
      p: [160, 3, 1],
      s: { label: 'far' },
      t: 'nametag',
      v: 30,
    },
    type: 'scene_ui_state_patch',
    worldId,
    worldTick: 2,
  });
  harness.send({
    player: createPlayerDescriptor('player-f'),
    type: 'player_attach',
    worldId,
  });
  await harness.waitForMessage(message => message.type === 'player_packet_batch' && message.playerId === 'player-f');

  harness.send({
    camera: { e: null, p: [160, 2, 3] },
    playerId: 'player-f',
    type: 'player_camera',
    worldId,
    worldTick: 4,
  });
  harness.send({
    entity: {
      i: 7101,
      n: 'Far Bot Updated',
    },
    type: 'entity_state_patch',
    worldId,
    worldTick: 4,
  });
  harness.send({
    particleEmitter: {
      i: 8101,
      tu: 'particles/far-updated.png',
    },
    type: 'particle_emitter_state_patch',
    worldId,
    worldTick: 4,
  });
  harness.send({
    sceneUI: {
      i: 9101,
      s: { label: 'far-updated' },
    },
    type: 'scene_ui_state_patch',
    worldId,
    worldTick: 4,
  });

  const collectedPackets = [];
  const startedAt = Date.now();

  while (Date.now() - startedAt < 4_000) {
    const batchMessage = await harness.waitForMessage(message => {
      return message.type === 'player_packet_batch' && message.playerId === 'player-f';
    }, 4_000 - (Date.now() - startedAt));
    collectedPackets.push(...decodeWirePackets(batchMessage.wireBytes));

    const entityPayloads = collectedPackets.filter(packet => packet[0] === ENTITIES_PACKET_ID).flatMap(packet => packet[1]);
    const particlePayloads = collectedPackets.filter(packet => packet[0] === PARTICLE_EMITTERS_PACKET_ID).flatMap(packet => packet[1]);
    const sceneUIPayloads = collectedPackets.filter(packet => packet[0] === SCENE_UIS_PACKET_ID).flatMap(packet => packet[1]);

    const mergedEntityPayload = entityPayloads.find(entity => entity.i === 7101 && entity.n === 'Far Bot Updated');
    const mergedParticlePayload = particlePayloads.find(particleEmitter => {
      return particleEmitter.i === 8101 && particleEmitter.tu === 'particles/far-updated.png';
    });
    const mergedSceneUIPayload = sceneUIPayloads.find(sceneUI => {
      return sceneUI.i === 9101 && sceneUI.s?.label === 'far-updated';
    });

    if (mergedEntityPayload && mergedParticlePayload && mergedSceneUIPayload) {
      assert.equal(mergedEntityPayload.n, 'Far Bot Updated');
      assert.equal(mergedParticlePayload.tu, 'particles/far-updated.png');
      assert.deepEqual(mergedSceneUIPayload.s, { label: 'far-updated' });
      return;
    }
  }

  assert.fail('Timed out waiting for coalesced same-tick spatial interest state.');
});

test('same-tick spatial removals dominate stale later patches for the same id', async t => {
  const harness = await createChildHarness(t);
  const worldId = 106;

  harness.send({
    options: createWorldBootOptions(worldId),
    processId: 'shadow-test',
    type: 'world_boot',
    world: createWorldDescriptor(worldId),
  });
  await harness.waitForMessage(message => message.type === 'world_ready' && message.world?.id === worldId);

  harness.send({
    player: createPlayerDescriptor('player-g'),
    type: 'player_attach',
    worldId,
  });
  await harness.waitForMessage(message => message.type === 'player_packet_batch' && message.playerId === 'player-g');

  harness.send({
    camera: { e: null, p: [0, 2, 0] },
    playerId: 'player-g',
    type: 'player_camera',
    worldId,
    worldTick: 2,
  });
  harness.send({
    entity: {
      i: 7201,
      n: 'Temp Bot',
      p: [0, 2, 0],
      r: [0, 0, 0, 1],
    },
    type: 'entity_state_patch',
    worldId,
    worldTick: 2,
  });
  harness.send({
    particleEmitter: {
      i: 8201,
      p: [0, 2, 1],
      tu: 'particles/temp.png',
    },
    type: 'particle_emitter_state_patch',
    worldId,
    worldTick: 2,
  });
  harness.send({
    sceneUI: {
      i: 9201,
      p: [0, 3, 0],
      s: { label: 'temp' },
      t: 'nametag',
      v: 30,
    },
    type: 'scene_ui_state_patch',
    worldId,
    worldTick: 2,
  });
  await harness.waitForMessage(message => message.type === 'player_packet_batch' && message.playerId === 'player-g');

  harness.send({
    entity: {
      i: 7201,
      rm: true,
    },
    type: 'entity_state_patch',
    worldId,
    worldTick: 4,
  });
  harness.send({
    entity: {
      i: 7201,
      n: 'Stale Bot Update',
    },
    type: 'entity_state_patch',
    worldId,
    worldTick: 4,
  });
  harness.send({
    particleEmitter: {
      i: 8201,
      rm: true,
    },
    type: 'particle_emitter_state_patch',
    worldId,
    worldTick: 4,
  });
  harness.send({
    particleEmitter: {
      i: 8201,
      tu: 'particles/stale.png',
    },
    type: 'particle_emitter_state_patch',
    worldId,
    worldTick: 4,
  });
  harness.send({
    sceneUI: {
      i: 9201,
      rm: true,
    },
    type: 'scene_ui_state_patch',
    worldId,
    worldTick: 4,
  });
  harness.send({
    sceneUI: {
      i: 9201,
      s: { label: 'stale' },
    },
    type: 'scene_ui_state_patch',
    worldId,
    worldTick: 4,
  });

  const collectedPackets = [];
  const startedAt = Date.now();

  while (Date.now() - startedAt < 4_000) {
    const batchMessage = await harness.waitForMessage(message => {
      return message.type === 'player_packet_batch' && message.playerId === 'player-g';
    }, 4_000 - (Date.now() - startedAt));
    collectedPackets.push(...decodeWirePackets(batchMessage.wireBytes));

    const entityPayloads = collectedPackets.filter(packet => packet[0] === ENTITIES_PACKET_ID).flatMap(packet => packet[1]);
    const particlePayloads = collectedPackets.filter(packet => packet[0] === PARTICLE_EMITTERS_PACKET_ID).flatMap(packet => packet[1]);
    const sceneUIPayloads = collectedPackets.filter(packet => packet[0] === SCENE_UIS_PACKET_ID).flatMap(packet => packet[1]);

    const hasEntityRemoval = entityPayloads.some(entity => entity.i === 7201 && entity.rm === true && !('n' in entity));
    const hasParticleRemoval = particlePayloads.some(particle => particle.i === 8201 && particle.rm === true && !('tu' in particle));
    const hasSceneUIRemoval = sceneUIPayloads.some(sceneUI => sceneUI.i === 9201 && sceneUI.rm === true && !('s' in sceneUI));

    if (!hasEntityRemoval || !hasParticleRemoval || !hasSceneUIRemoval) {
      continue;
    }

    const entityRemovalPayload = entityPayloads.find(entity => entity.i === 7201 && entity.rm === true);
    const particleRemovalPayload = particlePayloads.find(particle => particle.i === 8201 && particle.rm === true);
    const sceneUIRemovalPayload = sceneUIPayloads.find(sceneUI => sceneUI.i === 9201 && sceneUI.rm === true);

    assert.ok(entityRemovalPayload);
    assert.equal('n' in entityRemovalPayload, false);

    assert.ok(particleRemovalPayload);
    assert.equal('tu' in particleRemovalPayload, false);

    assert.ok(sceneUIRemovalPayload);
    assert.equal('s' in sceneUIRemovalPayload, false);
    return;
  }

  assert.fail('Timed out waiting for removal-dominated spatial payloads.');
});
