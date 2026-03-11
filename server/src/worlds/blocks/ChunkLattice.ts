import Chunk, { CHUNK_VOLUME, MAX_BLOCK_TYPE_ID } from '@/worlds/blocks/Chunk';
import EventRouter from '@/events/EventRouter';
import RigidBody, { RigidBodyType } from '../physics/RigidBody';
import { BLOCK_ROTATIONS } from '@/worlds/blocks/Block';
import ErrorHandler from '@/errors/ErrorHandler';
import type BlockType from '@/worlds/blocks/BlockType';
import type Collider from '@/worlds/physics/Collider';
import type Vector3Like from '@/shared/types/math/Vector3Like';
import type World from '@/worlds/World';
import type { BlockPlacement, BlockRotation } from '@/worlds/blocks/Block';

const CHUNK_MASK_WORD_BITS = 32;
const CHUNK_MASK_WORD_COUNT = CHUNK_VOLUME / CHUNK_MASK_WORD_BITS;
const CHUNK_KEY_COORD_BITS = 54;
const CHUNK_KEY_Y_SHIFT = BigInt(CHUNK_KEY_COORD_BITS);
const CHUNK_KEY_X_SHIFT = BigInt(CHUNK_KEY_COORD_BITS * 2);

type BlockPlacementEntry = {
  globalCoordinate: Vector3Like;
  blockTypeId: number;
  blockRotation?: BlockRotation;
};

/**
 * Event types a ChunkLattice instance can emit.
 *
 * See `ChunkLatticeEventPayloads` for the payloads.
 *
 * **Category:** Events
 * @public
 */
export enum ChunkLatticeEvent {
  ADD_CHUNK = 'CHUNK_LATTICE.ADD_CHUNK',
  REMOVE_CHUNK = 'CHUNK_LATTICE.REMOVE_CHUNK',
  SET_BLOCK = 'CHUNK_LATTICE.SET_BLOCK',
}

/**
 * Event payloads for ChunkLattice emitted events.
 *
 * **Category:** Events
 * @public
 */
export interface ChunkLatticeEventPayloads {
  /** Emitted when a chunk is added to the lattice. */
  [ChunkLatticeEvent.ADD_CHUNK]: { chunkLattice: ChunkLattice, chunk: Chunk }

  /** Emitted when a chunk is removed from the lattice. */
  [ChunkLatticeEvent.REMOVE_CHUNK]: { chunkLattice: ChunkLattice, chunk: Chunk }

  /** Emitted when a block is set in the lattice. */
  [ChunkLatticeEvent.SET_BLOCK]: { chunkLattice: ChunkLattice, chunk: Chunk, globalCoordinate: Vector3Like, localCoordinate: Vector3Like, blockTypeId: number, blockRotation?: BlockRotation }
}

/**
 * A lattice of chunks that represent a world's terrain.
 *
 * When to use: reading or mutating blocks in world space.
 * Do NOT use for: per-entity placement logic; prefer higher-level game systems.
 *
 * @remarks
 * The lattice owns all chunks and keeps physics colliders in sync with blocks.
 *
 * <h2>Coordinate System</h2>
 *
 * - **Global (world) coordinates:** integer block positions in world space.
 * - **Chunk origin:** world coordinate at the chunk's minimum corner (multiples of 16).
 * - **Local coordinates:** 0..15 per axis within a chunk.
 * - **Axes:** +X right, +Y up, -Z forward.
 * - **Origin:** (0,0,0) is the world origin.
 *
 * **Category:** Blocks
 * @public
 */
export default class ChunkLattice extends EventRouter {
  /** @internal */
  private _blockTypeColliders: Map<number, Collider> = new Map(); // block type id -> collider
 
  /** @internal */
  private _blockTypeChunkMasks: Map<number, Map<bigint, Uint32Array>> = new Map(); // block type id -> (chunk key -> 4096-bit occupancy mask)

  /** @internal */
  private _blockTypeCounts: Map<number, number> = new Map(); // block type id -> total block count

  /** @internal */
  private _chunks: Map<bigint, Chunk> = new Map(); // origin coordinate (packed key) -> chunk

  /** @internal */
  private _rigidBody: RigidBody | undefined;

  /** @internal */
  private _world: World;

  /**
   * Creates a new chunk lattice instance.
   * @param world - The world the chunk lattice is for.
   */
  public constructor(world: World) {
    super();

    this._world = world;
  }

  /**
   * The number of chunks in the lattice.
   *
   * **Category:** Blocks
   */
  public get chunkCount(): number {
    return this._chunks.size;
  }

  /**
   * Removes and clears all chunks and their blocks from the lattice.
   *
   * Use for: full world resets or map reloads.
   * Do NOT use for: incremental changes; use `ChunkLattice.setBlock`.
   *
   * @remarks
   * **Removes colliders:** All block type colliders are removed from the physics simulation.
   *
   * **Emits events:** Emits `REMOVE_CHUNK` for each chunk before clearing.
   *
   * **Side effects:** Clears all chunks, placements, and block colliders.
   *
   * **Category:** Blocks
   */
  public clear(): void {
    for (const collider of this._blockTypeColliders.values()) {
      collider.removeFromSimulation();
    }

    this._chunks.forEach(chunk => {
      this.emitWithWorld(this._world, ChunkLatticeEvent.REMOVE_CHUNK, {
        chunkLattice: this,
        chunk,
      });
    });

    this._blockTypeColliders.clear();
    this._blockTypeChunkMasks.clear();
    this._blockTypeCounts.clear();
    this._chunks.clear();
  }

  /**
   * Gets the block type ID at a specific global coordinate.
   *
   * @param globalCoordinate - The global coordinate of the block to get.
   * @returns The block type ID, or 0 if no block is set.
   *
   * **Category:** Blocks
   */
  public getBlockId(globalCoordinate: Vector3Like): number {
    const chunk = this.getChunk(globalCoordinate);
    
    if (!chunk) {
      return 0;
    }

    return chunk.getBlockId(Chunk.globalCoordinateToLocalCoordinate(globalCoordinate));
  }

  /** @internal */
  public getBlockTypeCollider(blockTypeId: number): Collider | undefined {
    return this._blockTypeColliders.get(blockTypeId);
  }

  /**
   * Gets the block type at a specific global coordinate.
   *
   * @param globalCoordinate - The global coordinate of the block to get.
   * @returns The block type, or null if no block is set.
   *
   * **Category:** Blocks
   */
  public getBlockType(globalCoordinate: Vector3Like): BlockType | null {
    const blockId = this.getBlockId(globalCoordinate);

    return blockId ? this._world.blockTypeRegistry.getBlockType(blockId) : null;
  }

  /**
   * Gets the number of blocks of a specific block type in the lattice.
   *
   * @param blockTypeId - The block type ID to count.
   * @returns The number of blocks of the block type.
   *
   * **Category:** Blocks
   */
  public getBlockTypeCount(blockTypeId: number): number {
    if (!this._isValidBlockTypeId(blockTypeId)) {
      return 0;
    }

    return this._blockTypeCounts.get(blockTypeId) ?? 0;
  }

  /**
   * Gets the chunk that contains the given global coordinate.
   *
   * @param globalCoordinate - The global coordinate to get the chunk for.
   * @returns The chunk that contains the given global coordinate or undefined if not found.
   *
   * **Category:** Blocks
   */
  public getChunk(globalCoordinate: Vector3Like): Chunk | undefined {
    return this._chunks.get(this._getChunkKey(globalCoordinate));
  }

  /** @internal */
  public getOrCreateBlockTypeCollider(blockTypeId: number, blockPlacements: BlockPlacement[]): Collider {
    const existingCollider = this._blockTypeColliders.get(blockTypeId);

    if (existingCollider) {
      return existingCollider;
    }

    const blockType = this._world.blockTypeRegistry.getBlockType(blockTypeId);
    const collider = blockType.createCollider(blockPlacements);
    this._blockTypeColliders.set(blockTypeId, collider);

    return collider;
  }

  /**
   * Gets the chunk for a given global coordinate, creating it if it doesn't exist.
   *
   * @remarks
   * Creates a new chunk and emits `ChunkLatticeEvent.ADD_CHUNK` if needed.
   *
   * @param globalCoordinate - The global coordinate of the chunk to get.
   * @returns The chunk at the given global coordinate (created if needed).
   *
   * **Side effects:** May create and register a new chunk.
   *
   * **Category:** Blocks
   */
  public getOrCreateChunk(globalCoordinate: Vector3Like): Chunk {
    return this._getOrCreateChunk(globalCoordinate, true);
  }

  /** @internal */
  private _getOrCreateChunk(globalCoordinate: Vector3Like, emitAddEvent: boolean): Chunk {
    const originCoordinate = Chunk.globalCoordinateToOriginCoordinate(globalCoordinate);
    const chunkKey = this._packCoordinate(originCoordinate);
    let chunk = this._chunks.get(chunkKey);

    if (chunk) {
      return chunk;
    }

    chunk = new Chunk(originCoordinate);

    this._chunks.set(chunkKey, chunk);

    if (emitAddEvent) {
      this.emitWithWorld(this._world, ChunkLatticeEvent.ADD_CHUNK, {
        chunkLattice: this,
        chunk,
      });
    }

    return chunk;
  }

  /**
   * Gets all chunks in the lattice.
   *
   * @returns An array of all chunks in the lattice.
   *
   * **Category:** Blocks
   */
  public getAllChunks(): Chunk[] {
    return Array.from(this._chunks.values());
  }

  /**
   * Checks if a block exists at a specific global coordinate.
   *
   * @param globalCoordinate - The global coordinate of the block to check.
   * @returns Whether a block exists.
   *
   * **Category:** Blocks
   */
  public hasBlock(globalCoordinate: Vector3Like): boolean {
    const chunk = this.getChunk(globalCoordinate);
    if (!chunk) { return false; }

    return chunk.hasBlock(Chunk.globalCoordinateToLocalCoordinate(globalCoordinate));
  }

  /**
   * Checks if a chunk exists for a given global coordinate.
   *
   * @param globalCoordinate - The global coordinate of the chunk to check.
   * @returns Whether the chunk exists.
   *
   * **Category:** Blocks
   */
  public hasChunk(globalCoordinate: Vector3Like): boolean {
    return this._chunks.has(this._getChunkKey(globalCoordinate));
  }

  /**
   * Initializes all blocks in the lattice in bulk, replacing existing blocks.
   *
   * Use for: loading maps or generating terrain in one pass.
   * Do NOT use for: incremental edits; use `ChunkLattice.setBlock`.
   *
   * @remarks
   * **Clears first:** Calls `ChunkLattice.clear` before initializing, removing all existing blocks and colliders.
   *
   * **Collider optimization:** Creates one collider per block type with all placements combined.
   * Voxel colliders have their states combined for efficient neighbor collision detection.
   *
   * @param blocks - The blocks to initialize, keyed by block type ID.
   *
   * **Side effects:** Clears existing data, creates colliders, and emits `ChunkLatticeEvent.ADD_CHUNK`
   * for each fully initialized chunk.
   *
   * **Category:** Blocks
   */
  public initializeBlocks(blocks: { [blockTypeId: number]: BlockPlacement[] }): void {
    const blockEntries = function* (): Generator<BlockPlacementEntry> {
      for (const id in blocks) {
        const blockTypeId = Number(id);
        const blockPlacements = blocks[blockTypeId];

        for (let i = 0; i < blockPlacements.length; i++) {
          const blockPlacement = blockPlacements[i];
          yield {
            globalCoordinate: blockPlacement.globalCoordinate,
            blockTypeId,
            blockRotation: blockPlacement.blockRotation,
          };
        }
      }
    };

    this.initializeBlockEntries(blockEntries());
  }

  /** @internal */
  public initializeBlockEntries(blockEntries: Iterable<BlockPlacementEntry>): void {
    this.clear();
    const initializedChunks: Chunk[] = [];

    if (!this._rigidBody) {
      this._rigidBody = new RigidBody({ type: RigidBodyType.FIXED });
      this._rigidBody.addToSimulation(this._world.simulation);
    }

    for (const { globalCoordinate, blockTypeId, blockRotation } of blockEntries) {
      if (!this._isValidBlockTypeId(blockTypeId)) {
        continue;
      }

      const localCoordinate = Chunk.globalCoordinateToLocalCoordinate(globalCoordinate);
      let chunk = this.getChunk(globalCoordinate);

      if (!chunk) {
        if (blockTypeId === 0) {
          continue;
        }

        chunk = this._getOrCreateChunk(globalCoordinate, false);
        initializedChunks.push(chunk);
      }

      const previousBlockTypeId = chunk.getBlockId(localCoordinate);
      const previousBlockRotation = chunk.getBlockRotation(localCoordinate);

      if (previousBlockTypeId === blockTypeId && previousBlockRotation === (blockRotation ?? BLOCK_ROTATIONS.Y_0)) {
        continue;
      }

      if (previousBlockTypeId !== 0) {
        this._removeBlockTypePlacement(previousBlockTypeId, globalCoordinate);
      }

      chunk.setBlock(localCoordinate, blockTypeId, blockRotation);

      if (blockTypeId !== 0) {
        this._addBlockTypePlacement(blockTypeId, { globalCoordinate, blockRotation });
      }
    }

    for (let blockTypeId = 1; blockTypeId <= MAX_BLOCK_TYPE_ID; blockTypeId++) {
      const blockCount = this.getBlockTypeCount(blockTypeId);
      if (blockCount === 0) {
        continue;
      }

      const blockPlacements = this._getBlockTypePlacements(blockTypeId);
      const collider = this.getOrCreateBlockTypeCollider(blockTypeId, blockPlacements);
      const blockType = this._world.blockTypeRegistry.getBlockType(blockTypeId);

      collider.addToSimulation(this._world.simulation, this._rigidBody);
      this._world.simulation.colliderMap.setColliderBlockType(collider, blockType);

      if (collider.isVoxel) {
        this._combineVoxelStates(collider);
      }
    }

    for (let i = 0; i < initializedChunks.length; i++) {
      this.emitWithWorld(this._world, ChunkLatticeEvent.ADD_CHUNK, {
        chunkLattice: this,
        chunk: initializedChunks[i],
      });
    }
  }

  /**
   * Sets the block at a global coordinate by block type ID.
   *
   * Use for: incremental terrain edits.
   * Do NOT use for: bulk terrain loading; use `ChunkLattice.initializeBlocks`.
   *
   * @remarks
   * **Air:** Use block type ID `0` to remove a block (set to air).
   *
   * **Collider updates:** For voxel block types, updates the existing collider.
   * For trimesh block types, recreates the entire collider.
   *
   * **Removes previous:** If replacing an existing block, removes it from its collider first.
   * If the previous block type has no remaining blocks, its collider is removed from simulation.
   *
   * @param globalCoordinate - The global coordinate of the block to set.
   * @param blockTypeId - The block type ID to set. Use 0 to remove the block and replace with air.
   * @param blockRotation - The rotation of the block.
   *
   * **Side effects:** Emits `ChunkLatticeEvent.SET_BLOCK` and mutates block colliders.
   *
   * **Category:** Blocks
   */
  public setBlock(globalCoordinate: Vector3Like, blockTypeId: number, blockRotation?: BlockRotation): void {
    if (!this._isValidBlockTypeId(blockTypeId)) {
      return;
    }

    const localCoordinate = Chunk.globalCoordinateToLocalCoordinate(globalCoordinate);
    const chunk = this.getOrCreateChunk(globalCoordinate);
    const previousBlockTypeId = chunk.getBlockId(localCoordinate);

    if (previousBlockTypeId === blockTypeId && !blockRotation) return;

    chunk.setBlock(localCoordinate, blockTypeId, blockRotation);

    if (!this._rigidBody) {
      this._rigidBody = new RigidBody({ type: RigidBodyType.FIXED });
      this._rigidBody.addToSimulation(this._world.simulation);
    }

    // Remove previous block from colliders
    if (previousBlockTypeId !== 0) {
      const newCount = Math.max(0, this.getBlockTypeCount(previousBlockTypeId) - 1);
      const collider = this.getBlockTypeCollider(previousBlockTypeId);

      this._removeBlockTypePlacement(previousBlockTypeId, globalCoordinate);

      if (collider) {
        if (newCount === 0) {
          this._world.simulation.colliderMap.removeColliderBlockType(collider);
          collider.removeFromSimulation();
          this._blockTypeColliders.delete(previousBlockTypeId);
        } else {
          if (collider.isVoxel) {
            collider.setVoxel(globalCoordinate, false);
            this._propagateVoxelChange(collider, globalCoordinate);
          }

          if (collider.isTrimesh) {
            this._recreateTrimeshCollider(previousBlockTypeId);
          }
        }
      }
    }

    // Add new block to colliders
    if (blockTypeId !== 0) {
      const newCount = this.getBlockTypeCount(blockTypeId) + 1;
      const collider = this.getOrCreateBlockTypeCollider(blockTypeId, [ { globalCoordinate, blockRotation } ]);
     
      this._addBlockTypePlacement(blockTypeId, { globalCoordinate, blockRotation });

      if (newCount === 1) {
        const blockType = this._world.blockTypeRegistry.getBlockType(blockTypeId);
        collider.addToSimulation(this._world.simulation, this._rigidBody);
        this._world.simulation.colliderMap.setColliderBlockType(collider, blockType);

        if (collider.isVoxel) {
          this._combineVoxelStates(collider);
        }
      } else {
        if (collider.isVoxel) {
          collider.setVoxel(globalCoordinate, true);
          this._propagateVoxelChange(collider, globalCoordinate);
        }

        if (collider.isTrimesh) {
          this._recreateTrimeshCollider(blockTypeId);
        }
      }
    }

    this.emitWithWorld(this._world, ChunkLatticeEvent.SET_BLOCK, {
      chunkLattice: this,
      chunk,
      globalCoordinate,
      localCoordinate,
      blockTypeId,
      blockRotation,
    });
  }

  /** @internal */
  private _addBlockTypePlacement(blockTypeId: number, blockPlacement: BlockPlacement): void {
    this._setBlockTypePlacement(blockTypeId, blockPlacement.globalCoordinate, true);
  }

  /** @internal */
  private _combineVoxelStates(collider: Collider): void {
    if (collider.isSensor || !collider.isVoxel) { return; } // states should not be combined for sensors, it breaks non-sensor neighbor collisions

    for (const otherCollider of this._blockTypeColliders.values()) {
      if (otherCollider === collider || otherCollider.isSensor || !otherCollider.isVoxel) { continue; }
      collider.combineVoxelStates(otherCollider);
    }
  }

  /** @internal */
  private _propagateVoxelChange(collider: Collider, coordinate: Vector3Like): void {
    if (collider.isSensor) { return; } // states should not be propagated for sensors, it breaks non-sensor neighbor collisions.

    for (const otherCollider of this._blockTypeColliders.values()) {
      if (otherCollider === collider || otherCollider.isSensor || !otherCollider.isVoxel) { continue; }
      collider.propagateVoxelChange(otherCollider, coordinate);
    }
  }

  /** @internal */
  private _recreateTrimeshCollider(blockTypeId: number): void {
    const existingCollider = this._blockTypeColliders.get(blockTypeId);

    if (existingCollider) {
      existingCollider.removeFromSimulation();
      this._blockTypeColliders.delete(blockTypeId);
    }

    const blockType = this._world.blockTypeRegistry.getBlockType(blockTypeId);
    const blockPlacements = this._getBlockTypePlacements(blockTypeId);
    const collider = this.getOrCreateBlockTypeCollider(blockTypeId, blockPlacements);

    collider.addToSimulation(this._world.simulation, this._rigidBody);
    this._world.simulation.colliderMap.setColliderBlockType(collider, blockType);
  }

  /** @internal */
  private _removeBlockTypePlacement(blockTypeId: number, globalCoordinate: Vector3Like): void {
    this._setBlockTypePlacement(blockTypeId, globalCoordinate, false);
  }

  /** @internal */
  private _getChunkKey(globalCoordinate: Vector3Like): bigint {
    const originCoordinate = Chunk.globalCoordinateToOriginCoordinate(globalCoordinate);

    return this._packCoordinate(originCoordinate);
  }

  /** @internal */
  private _getBlockTypePlacements(blockTypeId: number): BlockPlacement[] {
    const placements: BlockPlacement[] = [];
    const chunkMasks = this._blockTypeChunkMasks.get(blockTypeId);

    if (!chunkMasks) {
      return placements;
    }

    for (const [ chunkKey, chunkMask ] of chunkMasks.entries()) {
      const chunk = this._chunks.get(chunkKey);

      if (!chunk) {
        continue;
      }

      for (let wordIndex = 0; wordIndex < chunkMask.length; wordIndex++) {
        const word = chunkMask[wordIndex] >>> 0;

        if (word === 0) {
          continue;
        }

        let bits = word;
        while (bits !== 0) {
          const leastBit = bits & -bits;
          const bitOffset = 31 - Math.clz32(leastBit);
          const blockIndex = (wordIndex << 5) + bitOffset;
          const localCoordinate = Chunk.blockIndexToLocalCoordinate(blockIndex);
          const blockRotation = chunk.getBlockRotation(localCoordinate);

          placements.push({
            globalCoordinate: {
              x: chunk.originCoordinate.x + localCoordinate.x,
              y: chunk.originCoordinate.y + localCoordinate.y,
              z: chunk.originCoordinate.z + localCoordinate.z,
            },
            blockRotation: blockRotation === BLOCK_ROTATIONS.Y_0 ? undefined : blockRotation,
          });

          bits = (bits & (bits - 1)) >>> 0;
        }
      }
    }

    return placements;
  }

  /** @internal */
  private _isChunkMaskEmpty(chunkMask: Uint32Array): boolean {
    for (let i = 0; i < chunkMask.length; i++) {
      if (chunkMask[i] !== 0) {
        return false;
      }
    }

    return true;
  }

  /** @internal */
  private _packCoordinate(coordinate: Vector3Like): bigint {
    const x = BigInt.asUintN(CHUNK_KEY_COORD_BITS, BigInt(Math.trunc(coordinate.x)));
    const y = BigInt.asUintN(CHUNK_KEY_COORD_BITS, BigInt(Math.trunc(coordinate.y)));
    const z = BigInt.asUintN(CHUNK_KEY_COORD_BITS, BigInt(Math.trunc(coordinate.z)));

    return (x << CHUNK_KEY_X_SHIFT) | (y << CHUNK_KEY_Y_SHIFT) | z;
  }

  /** @internal */
  private _isValidBlockTypeId(blockTypeId: number): boolean {
    const valid = Number.isInteger(blockTypeId) && blockTypeId >= 0 && blockTypeId <= MAX_BLOCK_TYPE_ID;

    if (!valid) {
      ErrorHandler.error(`ChunkLattice._isValidBlockTypeId(): Block type id ${blockTypeId} is out of bounds (expected 0-${MAX_BLOCK_TYPE_ID}).`);
    }

    return valid;
  }

  /** @internal */
  private _setBlockTypePlacement(blockTypeId: number, globalCoordinate: Vector3Like, present: boolean): void {
    let chunkMasks = this._blockTypeChunkMasks.get(blockTypeId);

    if (!chunkMasks) {
      if (!present) {
        return;
      }

      chunkMasks = new Map();
      this._blockTypeChunkMasks.set(blockTypeId, chunkMasks);
    }

    const chunkKey = this._getChunkKey(globalCoordinate);
    const localCoordinate = Chunk.globalCoordinateToLocalCoordinate(globalCoordinate);
    const blockIndex = Chunk.localCoordinateToBlockIndex(localCoordinate);
    const wordIndex = blockIndex >>> 5;
    const bitMask = (1 << (blockIndex & 31)) >>> 0;
    let chunkMask = chunkMasks.get(chunkKey);

    if (!chunkMask) {
      if (!present) {
        return;
      }

      chunkMask = new Uint32Array(CHUNK_MASK_WORD_COUNT);
      chunkMasks.set(chunkKey, chunkMask);
    }

    const hasBlock = (chunkMask[wordIndex] & bitMask) !== 0;

    if (present) {
      if (hasBlock) {
        return;
      }

      chunkMask[wordIndex] |= bitMask;
      this._blockTypeCounts.set(blockTypeId, (this._blockTypeCounts.get(blockTypeId) ?? 0) + 1);

      return;
    }

    if (!hasBlock) {
      return;
    }

    chunkMask[wordIndex] &= ~bitMask;

    const nextCount = Math.max(0, (this._blockTypeCounts.get(blockTypeId) ?? 0) - 1);
    if (nextCount > 0) {
      this._blockTypeCounts.set(blockTypeId, nextCount);
    } else {
      this._blockTypeCounts.delete(blockTypeId);
      this._blockTypeChunkMasks.delete(blockTypeId);
    }

    if (this._blockTypeChunkMasks.has(blockTypeId) && this._isChunkMaskEmpty(chunkMask)) {
      chunkMasks.delete(chunkKey);
    }
  }
}
