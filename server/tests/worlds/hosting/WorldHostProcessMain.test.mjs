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
const ENTITIES_PACKET_ID = 38;
const PLAYERS_PACKET_ID = 45;

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

  assert.deepEqual(packetIds, [ WORLD_PACKET_ID, ENTITIES_PACKET_ID, PLAYERS_PACKET_ID ]);
  assert.equal(packets[0][1].n, 'Bootstrapped World');
  assert.equal(packets[1][1][0].n, 'Training Bot');
  assert.deepEqual(packets[1][1][0].ma, [{ n: 'idle', p: true }]);
  assert.equal(packets[1][1][0].mo.length, 1);
  assert.equal(packets[1][1][0].mo[0].n, 'hat');
  assert.equal(packets[1][1][0].mo[0].h, true);
  assert.equal(packets[2][1][0].i, 'player-a');
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
  const entitiesPacket = packets.find(packet => packet[0] === ENTITIES_PACKET_ID);
  const mergedEntity = entitiesPacket[1][0];

  assert.deepEqual(mergedEntity.ma, [{ l: 1, n: 'idle', p: true, w: 0.5 }]);
  assert.equal(mergedEntity.mo.length, 1);
  assert.equal(mergedEntity.mo[0].n, 'visor');
  assert.equal(mergedEntity.mo[0].h, false);
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
