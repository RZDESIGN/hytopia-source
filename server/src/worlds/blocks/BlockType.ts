import protocol from '@hytopia.com/server-protocol';
import BlockTextureRegistry from '@/textures/BlockTextureRegistry';
import Collider, { ColliderShape } from '@/worlds/physics/Collider';
import CollisionGroupsBuilder, { CollisionGroup } from '@/worlds/physics/CollisionGroupsBuilder';
import ErrorHandler from '@/errors/ErrorHandler';
import EventRouter from '@/events/EventRouter';
import Serializer from '@/networking/Serializer';
import type Entity from '@/worlds/entities/Entity';
import type Player from '@/players/Player';
import type { BlockPlacement } from '@/worlds/blocks/Block';
import type { ContactForceData, RaycastHit } from '@/worlds/physics/Simulation';
import type { VoxelsColliderOptions, TrimeshColliderOptions } from '@/worlds/physics/Collider';

/**
 * Options for creating a block type instance.
 *
 * Use for: defining new block types to register in a `BlockTypeRegistry`.
 * Do NOT use for: placing blocks; use `ChunkLattice.setBlock`.
 *
 * **Category:** Blocks
 * @public
 */
export interface BlockTypeOptions {
  /** The unique numeric identifier for the block type. */
  id: number;

  /** The custom collider options for the block type. */
  customColliderOptions?: VoxelsColliderOptions | TrimeshColliderOptions;

  /** Whether the block type is a liquid. */
  isLiquid?: boolean;

  /** The light emission level, between 0 and 15. */
  lightLevel?: number;

  /** The name of the block type. */
  name: string;

  /** The URI of the texture asset for the block type. */
  textureUri: string;
}

/**
 * Event types a BlockType instance can emit.
 *
 * See `BlockTypeEventPayloads` for the payloads.
 *
 * **Category:** Events
 * @public
 */
export enum BlockTypeEvent {
  ENTITY_COLLISION     = 'BLOCK_TYPE.ENTITY_COLLISION',
  ENTITY_CONTACT_FORCE = 'BLOCK_TYPE.ENTITY_CONTACT_FORCE',
  INTERACT             = 'BLOCK_TYPE.INTERACT',
}

/**
 * Event payloads for BlockType emitted events.
 *
 * **Category:** Events
 * @public
 */
export interface BlockTypeEventPayloads {
  /** Emitted when an entity collides with a block type. */
  [BlockTypeEvent.ENTITY_COLLISION]:     { blockType: BlockType, entity: Entity, started: boolean, colliderHandleA: number, colliderHandleB: number }

  /** Emitted when an entity's contact force is applied to a block type. */
  [BlockTypeEvent.ENTITY_CONTACT_FORCE]: { blockType: BlockType, entity: Entity, contactForceData: ContactForceData }

  /** Emitted when a player interacts with a block type. */
  [BlockTypeEvent.INTERACT]:             { blockType: BlockType, player: Player, raycastHit?: RaycastHit }
}

/**
 * Represents a block type definition.
 *
 * When to use: defining new block types (textures, colliders, liquid behavior).
 * Do NOT use for: placing blocks directly; use `ChunkLattice.setBlock`.
 *
 * @remarks
 * Block types are created as instances and registered with a `BlockTypeRegistry`
 * for a specific world. Liquids are treated as sensors in physics.
 *
 * <h2>Events</h2>
 *
 * This class is an EventRouter, and instances of it emit events with payloads listed under
 * `BlockTypeEventPayloads`.
 *
 * @example
 * ```typescript
 * const stoneBlockTypeId = 10;
 * world.blockTypeRegistry.registerBlockType(new BlockType({
 *   id: stoneBlockTypeId,
 *   textureUri: 'textures/stone.png',
 *   name: 'Stone',
 * }));
 *
 * // Create a stone block at coordinate 0, 1, 0
 * world.chunkLattice.setBlock({ x: 0, y: 1, z: 0 }, stoneBlockTypeId);
 * ```
 *
 * **Category:** Blocks
 * @public
 */
export default class BlockType extends EventRouter implements protocol.Serializable {
  /** @internal */
  private readonly _id: number;

  /** @internal */
  private _customColliderOptions: VoxelsColliderOptions | TrimeshColliderOptions | undefined;

  /** @internal */
  private _isLiquid: boolean;

  /** @internal */
  private _lightLevel: number;

  /** @internal */
  private _name: string;

  /** @internal */
  private _textureUri: string;

  /** @internal */
  private _serialized: protocol.BlockTypeSchema | undefined;
 
  /**
   * Creates a new block type instance.
   *
   * Use for: defining a block type before registering it with a `BlockTypeRegistry`.
   *
   * @param options - The options for the block type.
   *
   * **Category:** Blocks
   */
  constructor(options: BlockTypeOptions = { id: -1, textureUri: 'textures/missing.png', name: 'Unknown' }) {
    if (options.id < 0) { ErrorHandler.fatalError('BlockType.constructor(): BlockType id not set.'); }

    if (!BlockTextureRegistry.instance.hasBlockTexture(options.textureUri)) {
      ErrorHandler.fatalError(`BlockType.constructor(): Block texture ${options.textureUri} not found. If it is a cubemap texture, make sure every face is present in the folder (+x.png, -x.png, +y.png, -y.png, +z.png, -z.png).`);
    }

    super();

    this._id = options.id;
    this._customColliderOptions = options.customColliderOptions;
    this._isLiquid = options.isLiquid ?? false;
    this._name = options.name;
    this._textureUri = options.textureUri;
    this._lightLevel = Math.min(options.lightLevel ?? 0, 15);
  }

  /**
   * The unique identifier for the block type.
   *
   * **Category:** Blocks
   */
  public get id(): number { return this._id; }

  /**
   * The collider options for the block type.
   *
   * **Category:** Blocks
   */
  public get colliderOptions(): VoxelsColliderOptions | TrimeshColliderOptions { return this._customColliderOptions ?? { shape: ColliderShape.VOXELS }; }

  /**
   * Whether the block type is a liquid.
   *
   * **Category:** Blocks
   */
  public get isLiquid(): boolean { return this._isLiquid; }

  /**
   * Whether the block type is meshable (voxel-based).
   *
   * **Category:** Blocks
   */
  public get isMeshable(): boolean { return !this._customColliderOptions; }

  /**
   * Whether the block type uses a trimesh collider.
   *
   * **Category:** Blocks
   */
  public get isTrimesh(): boolean { return this.colliderOptions.shape === ColliderShape.TRIMESH; }

  /**
   * Whether the block type uses a voxel collider.
   *
   * **Category:** Blocks
   */
  public get isVoxel(): boolean { return this.colliderOptions.shape === ColliderShape.VOXELS; }

  /**
   * The light emission level (0-15).
   *
   * **Category:** Blocks
   */
  public get lightLevel(): number { return this._lightLevel; }

  /**
   * The name of the block type.
   *
   * **Category:** Blocks
   */
  public get name(): string { return this._name; }

  /**
   * The URI of the texture for the block type.
   *
   * **Category:** Blocks
   */
  public get textureUri(): string { return this._textureUri; }

  /**
   * Creates a collider for the block type.
   * @param coordinates - Block positions to include in the collider. For VOXELS shapes, these are
   * combined into an optimized voxel collider. For TRIMESH shapes, the base mesh is duplicated
   * at each position with vertices offset accordingly.
   * @returns The collider for the block type.
   * @internal
   */
  public createCollider(blockPlacements: BlockPlacement[]): Collider {
    const collider = this.colliderOptions.shape === ColliderShape.VOXELS ? new Collider({
      ...this.colliderOptions,
      coordinates: blockPlacements.map(placement => placement.globalCoordinate),
      size: { x: 1, y: 1, z: 1 },
    }) : new Collider({
      ...this.colliderOptions,
      ...this._buildTrimeshFromBlockPlacements(blockPlacements),
    });

    if (this.isLiquid) {
      collider.setSensor(true);
    }

    if (this.hasListeners(BlockTypeEvent.ENTITY_COLLISION) || this.isLiquid) {
      collider.enableCollisionEvents(true);
    }

    if (this.hasListeners(BlockTypeEvent.ENTITY_CONTACT_FORCE)) {
      collider.enableContactForceEvents(true);
    }

    if (CollisionGroupsBuilder.isDefaultCollisionGroups(collider.collisionGroups)) {
      collider.setCollisionGroups({
        belongsTo: [ CollisionGroup.BLOCK ],
        collidesWith: [ CollisionGroup.ALL & ~(CollisionGroup.BLOCK) ],
      });
    }

    return collider;
  }

  /**
   * Triggers an interaction on the block type from a player.
   *
   * Use for: programmatic interactions that should mimic player clicks.
   *
   * @remarks
   * This is automatically called when a player clicks or taps a block of this block type, but can also be called directly
   * for programmatic interactions. Emits `BlockTypeEvent.INTERACT`.
   *
   * @param player - The player interacting with the block type.
   * @param raycastHit - The raycast hit result, if the interaction was triggered by a client-side click/tap.
   *
   * **Side effects:** Emits `BlockTypeEvent.INTERACT`.
   *
   * **Category:** Blocks
   */
  public interact(player: Player, raycastHit?: RaycastHit) {
    if (!player.world) return;
    
    this.emitWithWorld(player.world, BlockTypeEvent.INTERACT, { blockType: this, player, raycastHit });
  }

  /** @internal */
  public serialize(): protocol.BlockTypeSchema {
    this._serialized ??= Serializer.serializeBlockType(this);
    return this._serialized;
  }

  /**
   * Builds combined trimesh vertices and indices by replicating the base mesh at each coordinate.
   * @param coordinates - The coordinates where the mesh should be placed.
   * @returns The combined vertices and indices for the trimesh collider.
   * @internal
   */
  private _buildTrimeshFromBlockPlacements(blockPlacements: BlockPlacement[]): { vertices: Float32Array; indices: Uint32Array } {
    const options = this.colliderOptions as TrimeshColliderOptions;
    const baseVertices = options.vertices;
    const baseIndices = options.indices;

    if (!baseVertices || !baseIndices) {
      ErrorHandler.fatalError(`BlockType._buildTrimeshFromCoordinates(): Block type id ${this.id} (${this.name}) is a trimesh but is missing vertices or indices!`);
    }

    if (baseVertices.length % 3 !== 0 || baseIndices.length % 3 !== 0) {
      ErrorHandler.fatalError(`BlockType._buildTrimeshFromCoordinates(): Block type id ${this.id} (${this.name}) has an invalid number of vertices or indices! Expected a multiple of 3, got ${baseVertices.length} and ${baseIndices.length}.`);
    }


    const baseVertexCount = baseVertices.length / 3;
    const blockPlacementsCount = blockPlacements.length;

    // Create combined arrays
    const vertices = new Float32Array(baseVertices.length * blockPlacementsCount);
    const indices = new Uint32Array(baseIndices.length * blockPlacementsCount);

    // Replicate mesh at each coordinate
    for (let i = 0; i < blockPlacementsCount; i++) {
      const coord = blockPlacements[i].globalCoordinate;
      const rotationMatrix = blockPlacements[i].blockRotation?.matrix;
      const vertexOffset = i * baseVertices.length;
      const indexOffset = i * baseIndices.length;
      const vertexIndexOffset = i * baseVertexCount;

      // Copy vertices with rotation and coordinate offset
      for (let v = 0; v < baseVertices.length; v += 3) {
        let vx = baseVertices[v];
        let vy = baseVertices[v + 1];
        let vz = baseVertices[v + 2];

        if (rotationMatrix) {
          // Rotate around block center (0.5, 0.5, 0.5)
          const cx = vx - 0.5;
          const cy = vy - 0.5;
          const cz = vz - 0.5;
          const m = rotationMatrix;

          vx = m[0] * cx + m[1] * cy + m[2] * cz + 0.5;
          vy = m[3] * cx + m[4] * cy + m[5] * cz + 0.5;
          vz = m[6] * cx + m[7] * cy + m[8] * cz + 0.5;
        }

        vertices[vertexOffset + v] = vx + coord.x;
        vertices[vertexOffset + v + 1] = vy + coord.y;
        vertices[vertexOffset + v + 2] = vz + coord.z;
      }

      // Copy indices with vertex index offset
      for (let j = 0; j < baseIndices.length; j++) {
        indices[indexOffset + j] = baseIndices[j] + vertexIndexOffset;
      }
    }

    return { vertices, indices };
  }
}
