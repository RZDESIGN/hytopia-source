import type { Vector3Like } from 'three';
import { type BatchId, type ChunkId, BATCH_SIZE, BATCH_WORLD_SIZE, CHUNK_INDEX_RANGE, CHUNK_SIZE } from './ChunkConstants';
import { BLOCK_ROTATION_MATRICES, type BlockId } from '../blocks/BlockConstants';
import type BlockTypeRegistry from '../blocks/BlockTypeRegistry';
import type { Vector3LikeMutable } from '../three/utils';

export interface LightSource {
  position: Vector3Like;
  level: number;
}

// Working variables
const vec3like: Vector3LikeMutable = { x: 0, y: 0, z: 0 };

// Caches for parsed string-ID → numeric-origin lookups.
// These are called in hot per-frame loops (view distance, sorting, culling).
// Each uncached call does split(',') + .map(Number) — 5 allocations per call.
const chunkOriginCache = new Map<ChunkId, Vector3Like>();
const batchOriginCache = new Map<BatchId, Vector3Like>();

export default class Chunk {
  public readonly originCoordinate: Vector3Like;
  private _chunkId: ChunkId;
  private _blocks: Uint8Array;
  private _blockRotations: Map<number, number> = new Map(); // blockIndex → rotationIndex
  // This class is accessed from both the main thread and the worker. Currently,
  // light sources are only used within the worker, so they are created lazily
  // when needed. Since the creation cost is high, they are cached once created.
  private _lightSources?: LightSource[] = undefined;

  public constructor(originCoordinate: Vector3Like, blocks: Uint8Array, blockRotations?: number[]) {
    if (!this._isValidOriginCoordinate(originCoordinate)) {
      throw new Error(`Chunk.constructor(): Chunk origin coordinate must be divisible by CHUNK_SIZE (${CHUNK_SIZE}).`);
    }

    this.originCoordinate = originCoordinate;
    this._blocks = blocks;
    this._chunkId = Chunk.originCoordinateToChunkId(this.originCoordinate);

    // Parse block rotations from sparse array format [blockIndex, rotationIndex, ...]
    if (blockRotations) {
      for (let i = 0; i < blockRotations.length; i += 2) {
        this._blockRotations.set(blockRotations[i], blockRotations[i + 1]);
      }
    }
  }

  public get chunkId(): ChunkId {
    return this._chunkId;
  }

  public static chunkIdToOriginCoordinate(chunkId: ChunkId): Vector3Like {
    let cached = chunkOriginCache.get(chunkId);
    if (!cached) {
      const [x, y, z] = chunkId.split(',').map(str => Number(str)) as [number, number, number];
      cached = { x, y, z };
      chunkOriginCache.set(chunkId, cached);
    }
    return cached;
  }

  public static originCoordinateToChunkId(originCoordinate: Vector3Like): ChunkId {
    return `${originCoordinate.x},${originCoordinate.y},${originCoordinate.z}`;
  }

  public static globalCoordinateToChunkId(globalCoordinate: Vector3Like): ChunkId {
    return Chunk.originCoordinateToChunkId(Chunk.globalCoordinateToOriginCoordinate(globalCoordinate, vec3like));
  }

  public static globalCoordinateToOriginCoordinate(globalCoordinate: Vector3Like, out: Vector3LikeMutable = { x: 0, y: 0, z: 0 }): Vector3Like {
    out.x = globalCoordinate.x & ~(CHUNK_SIZE - 1);
    out.y = globalCoordinate.y & ~(CHUNK_SIZE - 1);
    out.z = globalCoordinate.z & ~(CHUNK_SIZE - 1);
    return out;
  }

  public static globalCoordinateToLocalCoordinate(globalCoordinate: Vector3Like, out: Vector3LikeMutable = { x: 0, y: 0, z: 0 }): Vector3Like {
    out.x = globalCoordinate.x & (CHUNK_SIZE - 1);
    out.y = globalCoordinate.y & (CHUNK_SIZE - 1);
    out.z = globalCoordinate.z & (CHUNK_SIZE - 1);
    return out;
  }

  // Batch meshing helpers
  public static originCoordinateToBatchOrigin(originCoordinate: Vector3Like): Vector3Like {
    return {
      x: Math.floor(originCoordinate.x / BATCH_WORLD_SIZE) * BATCH_WORLD_SIZE,
      y: Math.floor(originCoordinate.y / BATCH_WORLD_SIZE) * BATCH_WORLD_SIZE,
      z: Math.floor(originCoordinate.z / BATCH_WORLD_SIZE) * BATCH_WORLD_SIZE,
    };
  }

  public static originCoordinateToBatchId(originCoordinate: Vector3Like): BatchId {
    const batchOrigin = Chunk.originCoordinateToBatchOrigin(originCoordinate);
    return `${batchOrigin.x},${batchOrigin.y},${batchOrigin.z}`;
  }

  public static chunkIdToBatchId(chunkId: ChunkId): BatchId {
    return Chunk.originCoordinateToBatchId(Chunk.chunkIdToOriginCoordinate(chunkId));
  }

  public static batchIdToBatchOrigin(batchId: BatchId): Vector3Like {
    let cached = batchOriginCache.get(batchId);
    if (!cached) {
      const [x, y, z] = batchId.split(',').map(str => Number(str)) as [number, number, number];
      cached = { x, y, z };
      batchOriginCache.set(batchId, cached);
    }
    return cached;
  }

  // Get all chunk IDs that belong to a batch (some may not exist in world)
  // With BATCH_SIZE=2, this returns 8 chunk IDs (2x2x2)
  public static getChunkIdsInBatch(batchId: BatchId): ChunkId[] {
    const batchOrigin = Chunk.batchIdToBatchOrigin(batchId);
    const chunkIds: ChunkId[] = [];

    for (let dy = 0; dy < BATCH_SIZE; dy++) {
      for (let dz = 0; dz < BATCH_SIZE; dz++) {
        for (let dx = 0; dx < BATCH_SIZE; dx++) {
          const chunkOrigin = {
            x: batchOrigin.x + dx * CHUNK_SIZE,
            y: batchOrigin.y + dy * CHUNK_SIZE,
            z: batchOrigin.z + dz * CHUNK_SIZE,
          };
          chunkIds.push(Chunk.originCoordinateToChunkId(chunkOrigin));
        }
      }
    }

    return chunkIds;
  }

  public static worldPositionToGlobalCoordinate(worldPosition: Vector3Like, out: Vector3LikeMutable = { x: 0, y: 0, z: 0 }): Vector3Like {
    out.x = Math.floor(worldPosition.x);
    out.y = Math.floor(worldPosition.y);
    out.z = Math.floor(worldPosition.z);
    return out;
  }

  private _isValidLocalCoordinate(localCoordinate: Vector3Like): boolean {
    return localCoordinate.x >= 0 && localCoordinate.x <= CHUNK_INDEX_RANGE &&
           localCoordinate.y >= 0 && localCoordinate.y <= CHUNK_INDEX_RANGE &&
           localCoordinate.z >= 0 && localCoordinate.z <= CHUNK_INDEX_RANGE;
  }

  private _isValidOriginCoordinate(originCoordinate: Vector3Like): boolean {
    return originCoordinate.x % CHUNK_SIZE === 0 && 
           originCoordinate.y % CHUNK_SIZE === 0 &&
           originCoordinate.z % CHUNK_SIZE === 0
  }

  public getGlobalCoordinate(localCoordinate: Vector3Like): Vector3Like {
    return {
      x: this.originCoordinate.x + localCoordinate.x,
      y: this.originCoordinate.y + localCoordinate.y,
      z: this.originCoordinate.z + localCoordinate.z,
    };
  }

  public setBlock(localCoordinate: Vector3Like, blockTypeId: BlockId, blockRotationIndex?: number): void {
    if (!this._isValidLocalCoordinate(localCoordinate)) {
      throw new Error('Chunk.setBlock(): Block coordinate is out of bounds');
    }

    const blockIndex = this._getIndex(localCoordinate);
    const oldBlockType = this._blocks[blockIndex];
    this._blocks[blockIndex] = blockTypeId;

    // Update rotation (delete if not provided or 0, as 0 is identity)
    this._blockRotations.delete(blockIndex);
    if (blockRotationIndex && blockRotationIndex !== 0) {
      this._blockRotations.set(blockIndex, blockRotationIndex);
    }

    if (oldBlockType !== blockTypeId) {
      // TODO: Invalidate only when light level changes?
      this._lightSources = undefined;
    }
  }

  public getBlockRotation(localCoordinate: Vector3Like): number {
    const blockIndex = this._getIndex(localCoordinate);
    const rotation = this._blockRotations.get(blockIndex) ?? 0;
    return rotation >= 0 && rotation < BLOCK_ROTATION_MATRICES.length ? rotation : 0;
  }

  public getBlockType(localCoordinate: Vector3Like): BlockId {
    if (!this._isValidLocalCoordinate(localCoordinate)) {
      throw new Error('Chunk.getBlockType(): Block coordinate is out of bounds');
    }

    const blockIndex = this._getIndex(localCoordinate);
    return this._blocks[blockIndex];
  }

  private _getIndex(localCoordinate: Vector3Like): number {
    return localCoordinate.x + CHUNK_SIZE * (localCoordinate.y + CHUNK_SIZE * localCoordinate.z);
  }

  // Get all light sources in this chunk, with caching
  public getLightSources(blockTypeRegistry: BlockTypeRegistry): LightSource[] {
    if (this._lightSources === undefined) {
      this._lightSources = [];

      // Find all light sources in this chunk
      // TODO: Optimize if possible
      for (let y = 0; y < CHUNK_SIZE; y++) {
        for (let z = 0; z < CHUNK_SIZE; z++) {
          for (let x = 0; x < CHUNK_SIZE; x++) {
            const blockId = this.getBlockType({ x, y, z });

            if (blockId !== 0) {
              const blockType = blockTypeRegistry.getBlockType(blockId);
              if (blockType?.lightLevel) {
                // Store world position (center of block) and light level
                this._lightSources.push({
                  position: {
                    x: this.originCoordinate.x + x + 0.5,
                    y: this.originCoordinate.y + y + 0.5,
                    z: this.originCoordinate.z + z + 0.5,
                  },
                  level: blockType.lightLevel,
                });
              }
            }
          }
        }
      }
    }

    return this._lightSources;
  }

  public clearLightSourceCache(): void {
    this._lightSources = undefined;
  }
}