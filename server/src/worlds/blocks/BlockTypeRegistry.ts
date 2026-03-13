import protocol from '@hytopia.com/server-protocol';
import BlockType from '@/worlds/blocks/BlockType';
import ErrorHandler from '@/errors/ErrorHandler';
import EventRouter from '@/events/EventRouter';
import Serializer from '@/networking/Serializer';
import type { BlockTypeOptions } from '@/worlds/blocks/BlockType';
import type World from '@/worlds/World';

/**
 * Event types a BlockTypeRegistry instance can emit.
 *
 * See `BlockTypeRegistryEventPayloads` for the payloads.
 *
 * **Category:** Events
 * @public
 */
export enum BlockTypeRegistryEvent {
  REGISTER_BLOCK_TYPE = 'BLOCK_TYPE_REGISTRY.REGISTER_BLOCK_TYPE',
}

/**
 * Event payloads for BlockTypeRegistry emitted events.
 *
 * **Category:** Events
 * @public
 */
export interface BlockTypeRegistryEventPayloads {
  /** Emitted when a block type is registered. */
  [BlockTypeRegistryEvent.REGISTER_BLOCK_TYPE]: { blockTypeRegistry: BlockTypeRegistry, id: number, blockType: BlockType }
}

/**
 * Manages known block types in a world.
 *
 * When to use: registering and retrieving block types for a specific world.
 * Do NOT use for: placing blocks; use `ChunkLattice.setBlock`.
 *
 * @remarks
 * Each `World` has its own registry. Block type IDs are unique per world.
 *
 * <h2>Events</h2>
 *
 * This class is an EventRouter, and instances of it emit events with payloads listed under
 * `BlockTypeRegistryEventPayloads`.
 *
 * @example
 * ```typescript
 * world.blockTypeRegistry.registerGenericBlockType({
 *   id: 15,
 *   textureUri: 'textures/dirt.png',
 *   name: 'Dirt',
 * });
 * ```
 *
 * **Category:** Blocks
 * @public
 */
export default class BlockTypeRegistry extends EventRouter implements protocol.Serializable {
  /** @internal */
  private _blockTypes: Map<number, BlockType> = new Map();

  /** @internal */
  private _world: World;
  
  /** @internal */
  public constructor(world: World) {
    super();

    this._world = world;
  }

  /**
   * The world the block type registry is for.
   *
   * **Category:** Blocks
   */
  public get world(): World { return this._world; }

  /**
   * Get all registered block types.
   * @returns An array of all registered block types.
   *
   * **Category:** Blocks
   */
  public getAllBlockTypes(): IterableIterator<BlockType> {
    return this._blockTypes.values();
  }

  /**
   * Get a registered block type by its id.
   *
   * @remarks
   * Throws a fatal error if the block type is not registered.
   *
   * @param id - The id of the block type to get.
   * @returns The block type with the given id.
   *
   * **Category:** Blocks
   */
  public getBlockType(id: number): BlockType {
    const blockType = this._blockTypes.get(id);

    if (!blockType) {
      ErrorHandler.fatalError(`BlockTypeRegistry.getBlockType(): BlockType with id ${id} not found.`);
    }

    return blockType;
  }

  /**
   * Register a generic block type.
   * 
   * @remarks
   * **Creates anonymous class:** Internally creates an anonymous class extending `BlockType` with the
   * provided options, then calls `registerBlockType()`.
   * 
   * @param blockTypeOptions - The options for the block type.
   * @returns The registered block type.
   *
   * **Side effects:** Emits `BlockTypeRegistryEvent.REGISTER_BLOCK_TYPE`.
   *
   * **Category:** Blocks
   */
  public registerGenericBlockType(blockTypeOptions: BlockTypeOptions): BlockType {
    const GenericBlockType = class extends BlockType {
      constructor(_options: BlockTypeOptions = blockTypeOptions) { super(_options); }
    };
    
    const blockType = new GenericBlockType();
    
    this.registerBlockType(blockType);

    return blockType;
  }

  /**
   * Register a block type.
   * @param blockType - The block type to register.
   *
   * **Side effects:** Emits `BlockTypeRegistryEvent.REGISTER_BLOCK_TYPE`.
   *
   * **Category:** Blocks
   */
  public registerBlockType(blockType: BlockType) {
    this._blockTypes.set(blockType.id, blockType);

    this.emitWithWorld(this._world, BlockTypeRegistryEvent.REGISTER_BLOCK_TYPE, {
      blockTypeRegistry: this,
      id: blockType.id,
      blockType,
    });
  }

  /** @internal */
  public serialize(): protocol.BlockTypesSchema {
    return Serializer.serializeBlockTypeRegistry(this);
  }
}
