import Chunk, { CHUNK_AXES_RANGE, CHUNK_SIZE_BITS, CHUNK_VOLUME, MAX_BLOCK_TYPE_ID } from '@/worlds/blocks/Chunk';
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
  private _dirtyColliderBlockTypeIds: Set<number> = new Set();
 
  /** @internal */
  private _blockTypeChunkMasks: Map<number, Map<bigint, Uint32Array>> = new Map(); // block type id -> (chunk key -> 4096-bit occupancy mask)

  /** @internal */
  private _blockTypeCounts: Map<number, number> = new Map(); // block type id -> total block count

  /** @internal */
  private _dirtyVoxelChunkMasksByBlockType: Map<number, Map<bigint, Uint32Array>> = new Map();

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
    this._dirtyColliderBlockTypeIds.clear();
    this._dirtyVoxelChunkMasksByBlockType.clear();
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

  /** @internal */
  public get hasPendingColliderUpdates(): boolean {
    return this._dirtyColliderBlockTypeIds.size > 0;
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
  public getAllChunks(): IterableIterator<Chunk> {
    return this._chunks.values();
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
    const blockIndexZShift = CHUNK_SIZE_BITS * 2;

    if (!this._rigidBody) {
      this._rigidBody = new RigidBody({ type: RigidBodyType.FIXED });
      this._rigidBody.addToSimulation(this._world.simulation);
    }

    for (const { globalCoordinate, blockTypeId, blockRotation } of blockEntries) {
      if (!this._isValidBlockTypeId(blockTypeId)) {
        continue;
      }

      const x = globalCoordinate.x | 0;
      const y = globalCoordinate.y | 0;
      const z = globalCoordinate.z | 0;
      const localX = x & CHUNK_AXES_RANGE;
      const localY = y & CHUNK_AXES_RANGE;
      const localZ = z & CHUNK_AXES_RANGE;
      const originX = x - localX;
      const originY = y - localY;
      const originZ = z - localZ;
      const chunkKey = this._packCoordinateInts(originX, originY, originZ);
      const blockIndex = localX + (localY << CHUNK_SIZE_BITS) + (localZ << blockIndexZShift);
      let chunk = this._chunks.get(chunkKey);

      if (!chunk) {
        if (blockTypeId === 0) {
          continue;
        }

        chunk = new Chunk({ x: originX, y: originY, z: originZ });
        this._chunks.set(chunkKey, chunk);
        initializedChunks.push(chunk);
      }

      const previousBlockTypeId = chunk.getBlockIdByIndex(blockIndex);
      const previousBlockRotation = chunk.getBlockRotationByIndex(blockIndex);

      if (previousBlockTypeId === blockTypeId && previousBlockRotation === (blockRotation ?? BLOCK_ROTATIONS.Y_0)) {
        continue;
      }

      if (previousBlockTypeId !== 0) {
        this._setBlockTypePlacementByIndex(previousBlockTypeId, chunkKey, blockIndex, false);
      }

      chunk.setBlockByIndex(blockIndex, blockTypeId, blockRotation);

      if (blockTypeId !== 0) {
        this._setBlockTypePlacementByIndex(blockTypeId, chunkKey, blockIndex, true);
      }
    }

    for (const [blockTypeId, blockCount] of this._blockTypeCounts.entries()) {
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
   * **Collider updates:** Collider changes are batched and applied before the next
   * physics step or physics query.
   *
   * **Removes previous:** If replacing an existing block, removes it from its collider first.
   * If the previous block type has no remaining blocks, its collider is removed from simulation.
   *
   * @param globalCoordinate - The global coordinate of the block to set.
   * @param blockTypeId - The block type ID to set. Use 0 to remove the block and replace with air.
   * @param blockRotation - The rotation of the block.
   *
   * **Side effects:** Emits `ChunkLatticeEvent.SET_BLOCK` and queues collider updates.
   *
   * **Category:** Blocks
   */
  public setBlock(globalCoordinate: Vector3Like, blockTypeId: number, blockRotation?: BlockRotation): void {
    if (!this._isValidBlockTypeId(blockTypeId)) {
      return;
    }

    const x = globalCoordinate.x | 0;
    const y = globalCoordinate.y | 0;
    const z = globalCoordinate.z | 0;
    const localCoordinate = {
      x: x & CHUNK_AXES_RANGE,
      y: y & CHUNK_AXES_RANGE,
      z: z & CHUNK_AXES_RANGE,
    };
    const chunkKey = this._packCoordinateInts(x - localCoordinate.x, y - localCoordinate.y, z - localCoordinate.z);
    let chunk = this._chunks.get(chunkKey);
    const targetBlockRotation = blockRotation ?? BLOCK_ROTATIONS.Y_0;
    let createdChunk = false;

    if (!chunk) {
      if (blockTypeId === 0 && targetBlockRotation === BLOCK_ROTATIONS.Y_0) {
        return;
      }

      chunk = this._getOrCreateChunk({ x, y, z }, false);
      createdChunk = true;
    }

    const blockIndex = Chunk.localCoordinateToBlockIndex(localCoordinate);
    const previousBlockTypeId = chunk.getBlockIdByIndex(blockIndex);
    const previousBlockRotation = chunk.getBlockRotationByIndex(blockIndex);

    if (previousBlockTypeId === blockTypeId && previousBlockRotation === targetBlockRotation) {
      return;
    }

    chunk.setBlockByIndex(blockIndex, blockTypeId, blockRotation);

    if (previousBlockTypeId !== 0) {
      this._setBlockTypePlacementByIndex(previousBlockTypeId, chunkKey, blockIndex, false);
      this._queueColliderUpdate(previousBlockTypeId, chunkKey, blockIndex);
    }

    if (blockTypeId !== 0) {
      this._setBlockTypePlacementByIndex(blockTypeId, chunkKey, blockIndex, true);
      this._queueColliderUpdate(blockTypeId, chunkKey, blockIndex);
    }

    if (previousBlockTypeId === blockTypeId && previousBlockRotation !== (blockRotation ?? BLOCK_ROTATIONS.Y_0)) {
      this._dirtyColliderBlockTypeIds.add(blockTypeId);
    }

    if (createdChunk) {
      this.emitWithWorld(this._world, ChunkLatticeEvent.ADD_CHUNK, {
        chunkLattice: this,
        chunk,
      });
    }

    if (chunk.isEmpty) {
      this._chunks.delete(chunkKey);
      this.emitWithWorld(this._world, ChunkLatticeEvent.REMOVE_CHUNK, {
        chunkLattice: this,
        chunk,
      });
      return;
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
  public flushPendingColliderUpdates(): void {
    if (!this.hasPendingColliderUpdates) {
      return;
    }

    const dirtyBlockTypeIds = Array.from(this._dirtyColliderBlockTypeIds);
    const dirtyVoxelChunkMasksByBlockType = this._dirtyVoxelChunkMasksByBlockType;
    const newlyCreatedVoxelColliders: Collider[] = [];

    this._dirtyColliderBlockTypeIds = new Set();
    this._dirtyVoxelChunkMasksByBlockType = new Map();

    for (let index = 0; index < dirtyBlockTypeIds.length; index++) {
      const blockTypeId = dirtyBlockTypeIds[index];
      const blockCount = this._blockTypeCounts.get(blockTypeId) ?? 0;
      const existingCollider = this._blockTypeColliders.get(blockTypeId);

      if (blockCount === 0) {
        if (existingCollider) {
          this._world.simulation.colliderMap.removeColliderBlockType(existingCollider);
          existingCollider.removeFromSimulation();
          this._blockTypeColliders.delete(blockTypeId);
        }

        continue;
      }

      const blockType = this._world.blockTypeRegistry.getBlockType(blockTypeId);

      if (!existingCollider) {
        const collider = this.getOrCreateBlockTypeCollider(blockTypeId, this._getBlockTypePlacements(blockTypeId));
        this._ensureRigidBody();
        collider.addToSimulation(this._world.simulation, this._rigidBody);
        this._world.simulation.colliderMap.setColliderBlockType(collider, blockType);

        if (collider.isVoxel) {
          newlyCreatedVoxelColliders.push(collider);
        }

        continue;
      }

      if (existingCollider.isTrimesh) {
        this._recreateTrimeshCollider(blockTypeId);
        continue;
      }

      if (!existingCollider.isVoxel) {
        continue;
      }

      const dirtyVoxelChunkMasks = dirtyVoxelChunkMasksByBlockType.get(blockTypeId);
      if (!dirtyVoxelChunkMasks) {
        continue;
      }

      // Apply the voxel changes (setVoxel calls) — this updates the collision shape.
      // We intentionally skip propagateVoxelChange here. That function smooths
      // internal edges between different block-type colliders, which is cosmetic.
      // Skipping it eliminates the major server-side lag during block operations.
      this._applyPendingVoxelChanges(blockTypeId, existingCollider, dirtyVoxelChunkMasks);
    }

    for (let index = 0; index < newlyCreatedVoxelColliders.length; index++) {
      this._combineVoxelStates(newlyCreatedVoxelColliders[index]);
    }
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
  private _recreateTrimeshCollider(blockTypeId: number): void {
    const existingCollider = this._blockTypeColliders.get(blockTypeId);

    if (existingCollider) {
      existingCollider.removeFromSimulation();
      this._blockTypeColliders.delete(blockTypeId);
    }

    const blockType = this._world.blockTypeRegistry.getBlockType(blockTypeId);
    const blockPlacements = this._getBlockTypePlacements(blockTypeId);
    const collider = this.getOrCreateBlockTypeCollider(blockTypeId, blockPlacements);

    this._ensureRigidBody();
    collider.addToSimulation(this._world.simulation, this._rigidBody);
    this._world.simulation.colliderMap.setColliderBlockType(collider, blockType);
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
    return this._packCoordinateInts(coordinate.x, coordinate.y, coordinate.z);
  }

  /** @internal */
  private _packCoordinateInts(x: number, y: number, z: number): bigint {
    const packedX = BigInt.asUintN(CHUNK_KEY_COORD_BITS, BigInt(Math.trunc(x)));
    const packedY = BigInt.asUintN(CHUNK_KEY_COORD_BITS, BigInt(Math.trunc(y)));
    const packedZ = BigInt.asUintN(CHUNK_KEY_COORD_BITS, BigInt(Math.trunc(z)));

    return (packedX << CHUNK_KEY_X_SHIFT) | (packedY << CHUNK_KEY_Y_SHIFT) | packedZ;
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
  private _setBlockTypePlacementByIndex(blockTypeId: number, chunkKey: bigint, blockIndex: number, present: boolean): void {
    let chunkMasks = this._blockTypeChunkMasks.get(blockTypeId);

    if (!chunkMasks) {
      if (!present) {
        return;
      }

      chunkMasks = new Map();
      this._blockTypeChunkMasks.set(blockTypeId, chunkMasks);
    }

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

  /** @internal */
  private _queueColliderUpdate(blockTypeId: number, chunkKey: bigint, blockIndex: number): void {
    this._dirtyColliderBlockTypeIds.add(blockTypeId);

    let dirtyChunkMasks = this._dirtyVoxelChunkMasksByBlockType.get(blockTypeId);
    if (!dirtyChunkMasks) {
      dirtyChunkMasks = new Map();
      this._dirtyVoxelChunkMasksByBlockType.set(blockTypeId, dirtyChunkMasks);
    }

    let dirtyChunkMask = dirtyChunkMasks.get(chunkKey);
    if (!dirtyChunkMask) {
      dirtyChunkMask = new Uint32Array(CHUNK_MASK_WORD_COUNT);
      dirtyChunkMasks.set(chunkKey, dirtyChunkMask);
    }

    dirtyChunkMask[blockIndex >>> 5] |= (1 << (blockIndex & 31)) >>> 0;
  }

  /** @internal */
  private _applyPendingVoxelChanges(
    blockTypeId: number,
    collider: Collider,
    dirtyVoxelChunkMasks: Map<bigint, Uint32Array>,
  ): void {
    const blockIndexZShift = CHUNK_SIZE_BITS * 2;

    for (const [chunkKey, dirtyChunkMask] of dirtyVoxelChunkMasks.entries()) {
      const chunk = this._chunks.get(chunkKey);
      if (!chunk) {
        continue;
      }

      const occupancyMask = this._blockTypeChunkMasks.get(blockTypeId)?.get(chunkKey);

      for (let wordIndex = 0; wordIndex < dirtyChunkMask.length; wordIndex++) {
        let dirtyBits = dirtyChunkMask[wordIndex] >>> 0;

        while (dirtyBits !== 0) {
          const leastBit = dirtyBits & -dirtyBits;
          const bitOffset = 31 - Math.clz32(leastBit);
          const blockIndex = (wordIndex << 5) + bitOffset;
          const isFilled = occupancyMask ? (occupancyMask[wordIndex] & leastBit) !== 0 : false;

          collider.setVoxel({
            x: chunk.originCoordinate.x + (blockIndex & CHUNK_AXES_RANGE),
            y: chunk.originCoordinate.y + ((blockIndex >> CHUNK_SIZE_BITS) & CHUNK_AXES_RANGE),
            z: chunk.originCoordinate.z + ((blockIndex >> blockIndexZShift) & CHUNK_AXES_RANGE),
          }, isFilled);

          dirtyBits = (dirtyBits & (dirtyBits - 1)) >>> 0;
        }
      }
    }
  }

  /** @internal */
  private _ensureRigidBody(): void {
    if (!this._rigidBody) {
      this._rigidBody = new RigidBody({ type: RigidBodyType.FIXED });
      this._rigidBody.addToSimulation(this._world.simulation);
    }
  }
}
