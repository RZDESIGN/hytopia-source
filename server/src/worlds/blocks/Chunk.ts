import protocol from '@hytopia.com/server-protocol';
import ErrorHandler from '@/errors/ErrorHandler';
import Serializer from '@/networking/Serializer';
import { BLOCK_ROTATIONS } from '@/worlds/blocks/Block';
import type Vector3Like from '@/shared/types/math/Vector3Like';
import type { BlockRotation } from '@/worlds/blocks/Block';

/** @internal */
export const CHUNK_SIZE = 16;

/** @internal */
export const CHUNK_AXES_RANGE = CHUNK_SIZE - 1;

/** @internal */
export const CHUNK_SIZE_BITS = Math.log2(CHUNK_SIZE);

/** @internal */
export const CHUNK_VOLUME = CHUNK_SIZE ** 3;

/** @internal */
export const MAX_BLOCK_TYPE_ID = 255;

/**
 * A 16^3 chunk of blocks representing a slice of world terrain.
 *
 * When to use: reading chunk data or working with bulk block operations.
 * Do NOT use for: creating terrain directly; prefer `ChunkLattice`.
 *
 * @remarks
 * Chunks are fixed-size (16×16×16) and store block IDs by local coordinates.
 *
 * <h2>Coordinate System</h2>
 *
 * - **Global (world) coordinates:** integer block positions in world space.
 * - **Chunk origin:** the world coordinate at the chunk's minimum corner (multiples of 16).
 * - **Local coordinates:** 0..15 per axis within the chunk.
 *
 * **Category:** Blocks
 * @public
 */
export default class Chunk implements protocol.Serializable {
  /** @internal */
  private _blocks: Uint8Array;

  /** @internal */
  private _blockRotations: Map<number, BlockRotation> = new Map();

  /** @internal */
  private _originCoordinate: Vector3Like;

  /** @internal */
  private _serialized: protocol.ChunkSchema | undefined;

  /**
   * Creates a new chunk instance.
   */
  public constructor(originCoordinate: Vector3Like) {
    this._blocks = new Uint8Array(CHUNK_VOLUME);
    this._originCoordinate = originCoordinate;
  }

  /**
   * The blocks in the chunk as a flat Uint8Array[4096], each index as 0 or a block type ID.
   *
   * **Category:** Blocks
   */
  public get blocks(): Readonly<Uint8Array> { return this._blocks; }

  /**
   * The rotations of the blocks in the chunk as a map of block index to rotation.
   *
   * **Category:** Blocks
   */
  public get blockRotations(): Readonly<Map<number, BlockRotation>> { return this._blockRotations; }

  /**
   * The origin coordinate of the chunk (world-space, multiples of 16).
   *
   * **Category:** Blocks
   */
  public get originCoordinate(): Vector3Like { return this._originCoordinate; }

  /**
   * Converts a block index to a local coordinate.
   *
   * @param index - The index of the block to convert.
   * @returns The local coordinate of the block.
   *
   * **Category:** Blocks
   */
  public static blockIndexToLocalCoordinate(index: number): Vector3Like {
    return {
      x: index & CHUNK_AXES_RANGE,
      y: (index >> CHUNK_SIZE_BITS) & CHUNK_AXES_RANGE,
      z: (index >> (CHUNK_SIZE_BITS * 2)) & CHUNK_AXES_RANGE,
    };
  }

  /**
   * Converts a local coordinate to a block index.
   *
   * @param localCoordinate - The local coordinate to convert.
   * @returns The block index.
   *
   * @internal
   */
  public static localCoordinateToBlockIndex(localCoordinate: Vector3Like): number {
    return localCoordinate.x + (localCoordinate.y << CHUNK_SIZE_BITS) + (localCoordinate.z << (CHUNK_SIZE_BITS * 2));
  }

  /**
   * Converts a global coordinate to a local coordinate.
   *
   * @param globalCoordinate - The global coordinate to convert.
   * @returns The local coordinate.
   *
   * **Category:** Blocks
   */
  public static globalCoordinateToLocalCoordinate(globalCoordinate: Vector3Like): Vector3Like {
    return {
      x: globalCoordinate.x & CHUNK_AXES_RANGE,
      y: globalCoordinate.y & CHUNK_AXES_RANGE,
      z: globalCoordinate.z & CHUNK_AXES_RANGE,
    };
  }

  /**
   * Converts a global coordinate to a chunk origin coordinate.
   *
   * @param globalCoordinate - The global coordinate to convert.
   * @returns The origin coordinate.
   *
   * **Category:** Blocks
   */
  public static globalCoordinateToOriginCoordinate(globalCoordinate: Vector3Like): Vector3Like {
    return {
      x: (globalCoordinate.x | 0) - (globalCoordinate.x & CHUNK_AXES_RANGE),
      y: (globalCoordinate.y | 0) - (globalCoordinate.y & CHUNK_AXES_RANGE),
      z: (globalCoordinate.z | 0) - (globalCoordinate.z & CHUNK_AXES_RANGE),
    };
  }

  /**
   * Gets the block type ID at a specific local coordinate.
   *
   * @remarks
   * Expects local coordinates in the range 0..15 for each axis.
   *
   * @param localCoordinate - The local coordinate of the block to get.
   * @returns The block type ID.
   *
   * **Category:** Blocks
   */
  public getBlockId(localCoordinate: Vector3Like): number {
    return this._blocks[this._getIndex(localCoordinate)];
  }

  /** @internal */
  public getBlockIdByIndex(blockIndex: number): number {
    return this._blocks[blockIndex] ?? 0;
  }

  /**
   * Gets the rotation of a block at a specific local coordinate.
   *
   * @param localCoordinate - The local coordinate of the block to get the rotation of.
   * @returns The rotation of the block (defaults to identity rotation).
   *
   * **Category:** Blocks
   */
  public getBlockRotation(localCoordinate: Vector3Like): BlockRotation {
    return this._blockRotations.get(this._getIndex(localCoordinate)) ?? BLOCK_ROTATIONS.Y_0;
  }

  /** @internal */
  public getBlockRotationByIndex(blockIndex: number): BlockRotation {
    return this._blockRotations.get(blockIndex) ?? BLOCK_ROTATIONS.Y_0;
  }

  /**
   * Checks if a block exists at a specific local coordinate.
   *
   * @param localCoordinate - The local coordinate of the block to check.
   * @returns Whether a block exists.
   *
   * **Category:** Blocks
   */
  public hasBlock(localCoordinate: Vector3Like): boolean {
    return this._blocks[this._getIndex(localCoordinate)] !== 0;
  }

  /** @internal */
  public setBlock(localCoordinate: Vector3Like, blockTypeId: number, blockRotation?: BlockRotation): void {
    if (!this._isValidLocalCoordinate(localCoordinate)) {
      return ErrorHandler.error('Chunk.setBlock(): Block local coordinate is out of bounds');
    }

    if (!Number.isInteger(blockTypeId) || blockTypeId < 0 || blockTypeId > MAX_BLOCK_TYPE_ID) {
      return ErrorHandler.error(`Chunk.setBlock(): Block type id ${blockTypeId} is out of bounds (expected 0-${MAX_BLOCK_TYPE_ID}).`);
    }

    const blockIndex = this._getIndex(localCoordinate);
    this._serialized = undefined;

    this._blocks[blockIndex] = blockTypeId;
    this._blockRotations.delete(blockIndex);

    if (blockRotation && blockRotation !== BLOCK_ROTATIONS.Y_0) {
      this._blockRotations.set(blockIndex, blockRotation);
    }
  }

  /** @internal */
  public setBlockByIndex(blockIndex: number, blockTypeId: number, blockRotation?: BlockRotation): void {
    if (!Number.isInteger(blockIndex) || blockIndex < 0 || blockIndex >= CHUNK_VOLUME) {
      return ErrorHandler.error(`Chunk.setBlockByIndex(): Block index ${blockIndex} is out of bounds.`);
    }

    if (!Number.isInteger(blockTypeId) || blockTypeId < 0 || blockTypeId > MAX_BLOCK_TYPE_ID) {
      return ErrorHandler.error(`Chunk.setBlockByIndex(): Block type id ${blockTypeId} is out of bounds (expected 0-${MAX_BLOCK_TYPE_ID}).`);
    }

    this._serialized = undefined;
    this._blocks[blockIndex] = blockTypeId;
    this._blockRotations.delete(blockIndex);

    if (blockRotation && blockRotation !== BLOCK_ROTATIONS.Y_0) {
      this._blockRotations.set(blockIndex, blockRotation);
    }
  }

  /** @internal */
  public serialize(): protocol.ChunkSchema {
    this._serialized ??= Serializer.serializeChunk(this);
    return this._serialized;
  }

  /** @internal */
  private _getIndex(localCoordinate: Vector3Like): number {
    return Chunk.localCoordinateToBlockIndex(localCoordinate);
  }

  /** @internal */
  private _isValidLocalCoordinate(localCoordinate: Vector3Like): boolean {
    return localCoordinate.x >= 0 && localCoordinate.x <= CHUNK_AXES_RANGE &&
           localCoordinate.y >= 0 && localCoordinate.y <= CHUNK_AXES_RANGE &&
           localCoordinate.z >= 0 && localCoordinate.z <= CHUNK_AXES_RANGE;
  }
}
