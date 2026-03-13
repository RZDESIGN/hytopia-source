import { expect, test } from 'bun:test';
import RAPIER from '@dimforge/rapier3d-simd-compat';
import protocol from '@hytopia.com/server-protocol';
import Serializer from '@/networking/Serializer';
import { BLOCK_ROTATIONS } from '@/worlds/blocks/Block';
import Chunk from '@/worlds/blocks/Chunk';
import ChunkLattice from '@/worlds/blocks/ChunkLattice';
import { ChunkLatticeEvent } from '@/worlds/blocks/ChunkLattice';
import Simulation from '@/worlds/physics/Simulation';

function createDeferredVoxelLattice() {
  const createColliderPlacements: Array<Array<{ globalCoordinate: { x: number; y: number; z: number } }>> = [];
  const collider = {
    addToSimulationCalls: 0,
    combineVoxelStates() {},
    isSensor: false,
    isTrimesh: false,
    isVoxel: true,
    propagateVoxelChange() {},
    removeFromSimulationCalls: 0,
    setVoxelCalls: [] as Array<{ coordinate: { x: number; y: number; z: number }; filled: boolean }>,
    addToSimulation() {
      this.addToSimulationCalls++;
    },
    removeFromSimulation() {
      this.removeFromSimulationCalls++;
    },
    setVoxel(coordinate: { x: number; y: number; z: number }, filled: boolean) {
      this.setVoxelCalls.push({
        coordinate: { ...coordinate },
        filled,
      });
    },
  };
  const colliderMap = {
    removeCalls: 0,
    setCalls: 0,
    removeColliderBlockType() {
      this.removeCalls++;
    },
    setColliderBlockType() {
      this.setCalls++;
    },
  };
  const world = {
    blockTypeRegistry: {
      getBlockType() {
        return {
          createCollider(blockPlacements: Array<{ globalCoordinate: { x: number; y: number; z: number } }>) {
            createColliderPlacements.push(blockPlacements.map(blockPlacement => ({
              globalCoordinate: { ...blockPlacement.globalCoordinate },
            })));
            return collider;
          },
        };
      },
    },
    chunkLattice: undefined,
    emit() {
      return false;
    },
    simulation: {
      colliderMap,
    },
  } as any;
  const lattice = new ChunkLattice(world);

  world.chunkLattice = lattice;
  (lattice as any)._rigidBody = {};

  return {
    lattice,
    collider,
    colliderMap,
    createColliderPlacements,
  };
}

test('serializeChunk snapshots blocks as a packet-valid typed array', () => {
  const chunk = new Chunk({ x: 0, y: 0, z: 0 });

  chunk.setBlock({ x: 0, y: 0, z: 0 }, 7);

  const serialized = Serializer.serializeChunk(chunk);

  expect(serialized.b).toBeInstanceOf(Uint8Array);
  expect(serialized.b?.[0]).toBe(7);
  expect(protocol.createPacket(protocol.outboundPackets.chunksPacketDefinition, [ serialized ], 1)).toEqual([
    protocol.PacketId.CHUNKS,
    [ serialized ],
    1,
  ]);

  chunk.setBlock({ x: 0, y: 0, z: 0 }, 3);

  expect(serialized.b?.[0]).toBe(7);
});

test('setBlock does not create phantom air chunks and emits populated add/remove events', () => {
  const world = {
    blockTypeRegistry: {
      getBlockType() {
        return {
          createCollider() {
            return {
              addToSimulation() {},
              isSensor: false,
              isTrimesh: false,
              isVoxel: false,
              removeFromSimulation() {},
            };
          },
        };
      },
    },
    emit() {
      return false;
    },
    simulation: {
      colliderMap: {
        removeColliderBlockType() {},
        setColliderBlockType() {},
      },
    },
  } as any;
  const lattice = new ChunkLattice(world);
  (lattice as any)._rigidBody = {};

  const events: string[] = [];
  lattice.on(ChunkLatticeEvent.ADD_CHUNK, ({ chunk }) => {
    events.push(`add:${chunk.getBlockId({ x: 0, y: 0, z: 0 })}`);
  });
  lattice.on(ChunkLatticeEvent.REMOVE_CHUNK, ({ chunk }) => {
    events.push(`remove:${chunk.getBlockId({ x: 0, y: 0, z: 0 })}`);
  });
  lattice.on(ChunkLatticeEvent.SET_BLOCK, ({ chunk }) => {
    events.push(`set:${chunk.getBlockId({ x: 0, y: 0, z: 0 })}`);
  });

  lattice.setBlock({ x: 0, y: 0, z: 0 }, 0);
  expect(lattice.chunkCount).toBe(0);

  lattice.setBlock({ x: 0, y: 0, z: 0 }, 1);
  expect(lattice.chunkCount).toBe(1);

  lattice.setBlock({ x: 0, y: 0, z: 0 }, 0);
  expect(lattice.chunkCount).toBe(0);

  expect(events).toEqual([
    'add:1',
    'set:1',
    'remove:0',
  ]);
});

test('setBlock can reset rotation back to identity without changing block type', () => {
  const { lattice } = createDeferredVoxelLattice();

  lattice.setBlock({ x: 0, y: 0, z: 0 }, 1, BLOCK_ROTATIONS.Y_90);
  lattice.setBlock({ x: 0, y: 0, z: 0 }, 1);

  const chunk = lattice.getChunk({ x: 0, y: 0, z: 0 });
  expect(chunk?.getBlockRotation({ x: 0, y: 0, z: 0 }).enumIndex).toBe(0);
});

test('initializeBlockEntries emits completed chunks without per-block events', () => {
  const collider = {
    addToSimulation() {},
    isSensor: false,
    isTrimesh: false,
    isVoxel: false,
    removeFromSimulation() {},
  };
  const world = {
    blockTypeRegistry: {
      getBlockType() {
        return {
          createCollider() {
            return collider;
          },
        };
      },
    },
    emit() {
      return false;
    },
    simulation: {
      colliderMap: {
        removeColliderBlockType() {},
        setColliderBlockType() {},
      },
    },
  } as any;
  const lattice = new ChunkLattice(world);
  (lattice as any)._rigidBody = {};

  const addChunkEvents: Array<{ blockAtOrigin: number; blockAtNeighbor: number }> = [];
  let setBlockEvents = 0;

  lattice.on(ChunkLatticeEvent.ADD_CHUNK, ({ chunk }) => {
    addChunkEvents.push({
      blockAtOrigin: chunk.getBlockId({ x: 0, y: 0, z: 0 }),
      blockAtNeighbor: chunk.getBlockId({ x: 1, y: 0, z: 0 }),
    });
  });
  lattice.on(ChunkLatticeEvent.SET_BLOCK, () => {
    setBlockEvents++;
  });

  lattice.initializeBlockEntries([
    {
      globalCoordinate: { x: 0, y: 0, z: 0 },
      blockTypeId: 1,
    },
    {
      globalCoordinate: { x: 1, y: 0, z: 0 },
      blockTypeId: 1,
    },
  ]);

  expect(addChunkEvents).toEqual([
    {
      blockAtOrigin: 1,
      blockAtNeighbor: 1,
    },
  ]);
  expect(setBlockEvents).toBe(0);
});

test('setBlock batches voxel collider creation until flush', () => {
  const { lattice, collider, colliderMap, createColliderPlacements } = createDeferredVoxelLattice();

  lattice.setBlock({ x: 0, y: 0, z: 0 }, 1);
  lattice.setBlock({ x: 1, y: 0, z: 0 }, 1);

  expect(lattice.hasPendingColliderUpdates).toBe(true);
  expect(createColliderPlacements).toEqual([]);
  expect(collider.addToSimulationCalls).toBe(0);
  expect(colliderMap.setCalls).toBe(0);

  lattice.flushPendingColliderUpdates();

  expect(lattice.hasPendingColliderUpdates).toBe(false);
  expect(createColliderPlacements).toEqual([
    [
      { globalCoordinate: { x: 0, y: 0, z: 0 } },
      { globalCoordinate: { x: 1, y: 0, z: 0 } },
    ],
  ]);
  expect(collider.addToSimulationCalls).toBe(1);
  expect(colliderMap.setCalls).toBe(1);
});

test('setBlock batches voxel collider updates and removal until flush', () => {
  const { lattice, collider, colliderMap } = createDeferredVoxelLattice();

  lattice.setBlock({ x: 0, y: 0, z: 0 }, 1);
  lattice.flushPendingColliderUpdates();
  collider.setVoxelCalls.length = 0;

  lattice.setBlock({ x: 1, y: 0, z: 0 }, 1);
  lattice.setBlock({ x: 0, y: 0, z: 0 }, 0);

  expect(collider.setVoxelCalls).toEqual([]);

  lattice.flushPendingColliderUpdates();

  expect(collider.setVoxelCalls).toEqual([
    {
      coordinate: { x: 0, y: 0, z: 0 },
      filled: false,
    },
    {
      coordinate: { x: 1, y: 0, z: 0 },
      filled: true,
    },
  ]);

  lattice.setBlock({ x: 1, y: 0, z: 0 }, 0);

  expect(collider.removeFromSimulationCalls).toBe(0);
  expect(colliderMap.removeCalls).toBe(0);

  lattice.flushPendingColliderUpdates();

  expect(collider.removeFromSimulationCalls).toBe(1);
  expect(colliderMap.removeCalls).toBe(1);
});

test('simulation flushes pending terrain colliders before queries and steps', async () => {
  await RAPIER.init();

  let flushCalls = 0;
  const world = {
    chunkLattice: {
      flushPendingColliderUpdates() {
        flushCalls++;
      },
    },
    emit() {
      return false;
    },
  } as any;
  const simulation = new Simulation(world);

  world.simulation = simulation;

  simulation.raycast({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 4);
  simulation.step(16);

  expect(flushCalls).toBe(2);
});
