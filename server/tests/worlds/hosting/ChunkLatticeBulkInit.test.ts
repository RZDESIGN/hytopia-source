import { expect, test } from 'bun:test';
import protocol from '@hytopia.com/server-protocol';
import Serializer from '@/networking/Serializer';
import Chunk from '@/worlds/blocks/Chunk';
import ChunkLattice from '@/worlds/blocks/ChunkLattice';
import { ChunkLatticeEvent } from '@/worlds/blocks/ChunkLattice';

test('serializeChunk snapshots blocks as a packet-valid array', () => {
  const chunk = new Chunk({ x: 0, y: 0, z: 0 });

  chunk.setBlock({ x: 0, y: 0, z: 0 }, 7);

  const serialized = Serializer.serializeChunk(chunk);

  expect(Array.isArray(serialized.b)).toBe(true);
  expect(serialized.b?.[0]).toBe(7);
  expect(protocol.createPacket(protocol.outboundPackets.chunksPacketDefinition, [ serialized ], 1)).toEqual([
    protocol.PacketId.CHUNKS,
    [ serialized ],
    1,
  ]);

  chunk.setBlock({ x: 0, y: 0, z: 0 }, 3);

  expect(serialized.b?.[0]).toBe(7);
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
