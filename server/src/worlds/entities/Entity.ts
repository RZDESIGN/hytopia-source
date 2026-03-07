import protocol from '@hytopia.com/server-protocol';
import Collider, { ColliderShape } from '@/worlds/physics/Collider';
import CollisionGroupsBuilder, { CollisionGroup } from '@/worlds/physics/CollisionGroupsBuilder';
import EntityModelAnimation, { EntityModelAnimationLoopMode } from '@/worlds/entities/EntityModelAnimation';
import EntityModelNodeOverride from '@/worlds/entities/EntityModelNodeOverride';
import ErrorHandler from '@/errors/ErrorHandler';
import ModelRegistry from '@/models/ModelRegistry';
import RigidBody, { RigidBodyType } from '@/worlds/physics/RigidBody';
import Serializer from '@/networking/Serializer';
import type BaseEntityController from '@/worlds/entities/controllers/BaseEntityController';
import type BlockType from '@/worlds/blocks/BlockType';
import type Outline from '@/shared/types/Outline';
import type Player from '@/players/Player';
import type QuaternionLike from '@/shared/types/math/QuaternionLike';
import type RgbColor from '@/shared/types/RgbColor';
import type Vector3Like from '@/shared/types/math/Vector3Like';
import type World from '@/worlds/World';
import type { ContactForceData, RaycastHit } from '@/worlds/physics/Simulation';
import type { EntityModelAnimationOptions } from '@/worlds/entities/EntityModelAnimation';
import type { EntityModelNodeOverrideOptions } from '@/worlds/entities/EntityModelNodeOverride';
import type { RigidBodyOptions } from '@/worlds/physics/RigidBody';

/**
 * The default rigid body options for a model entity when `EntityOptions.rigidBodyOptions` is not provided.
 *
 * **Category:** Entities
 * @public
 */
export const DEFAULT_ENTITY_RIGID_BODY_OPTIONS: RigidBodyOptions = {
  type: RigidBodyType.DYNAMIC,
  softCcdPrediction: 1,
} as const;

/** @internal */
export const ENTITY_POSITION_UPDATE_THRESHOLD_SQ = 0.04 * 0.04; // 1/25 of a block unit

/** @internal */
export const ENTITY_ROTATION_UPDATE_THRESHOLD = Math.cos(0.052 / 2); // 0.052 radians ~= 3 degrees

/**
 * The base options for an entity.
 *
 * Use for: common entity configuration shared by block and model entities.
 * Do NOT use for: runtime changes after spawn; use `Entity` setters instead.
 *
 * **Category:** Entities
 * @public
 */
export interface BaseEntityOptions {
  /** The entity controller to use for the entity. */
  controller?: BaseEntityController;

  /** The emissive color of the entity. */
  emissiveColor?: RgbColor;

  /** The emissive intensity of the entity. Use a value over 1 for brighter emissive effects. */
  emissiveIntensity?: number;

  /** The opacity of the entity between 0 and 1. 0 is fully transparent, 1 is fully opaque. */
  opacity?: number;

  /** The outline rendering options for the entity. */
  outline?: Outline;

  /** Whether the entity is environmental, if true it will not invoke its tick function or change position. Defaults to false. */
  isEnvironmental?: boolean;
  
  /** The parent entity of the entity, entities with a parent will ignore creating their own colliders. */
  parent?: Entity;

  /** The name of the parent's node (if parent is a model entity) to attach the entity to. */
  parentNodeName?: string;

  /** The interpolation time in milliseconds applied to position changes. */
  positionInterpolationMs?: number;

  /** The rigid body options for the entity. */
  rigidBodyOptions?: RigidBodyOptions;

  /** The interpolation time in milliseconds applied to rotation changes. */
  rotationInterpolationMs?: number;

  /** An arbitrary identifier tag of the entity. Useful for your own logic. */
  tag?: string;

  /** The tint color of the entity as a hex code. */
  tintColor?: RgbColor;

  /** The name of the entity. */
  name?: string;
}

/**
 * The options for creating a block entity.
 *
 * Use for: entities rendered as blocks with a `BlockType` texture.
 * Do NOT use for: model entities; use `ModelEntityOptions`.
 *
 * **Category:** Entities
 * @public
 */
export interface BlockEntityOptions extends BaseEntityOptions {
  /** The half extents of the visual size of the block entity when blockTextureUri is set. If no rigidBodyOptions.colliders are provided, a block collider with the size of the half extents will be created. */
  blockHalfExtents?: Vector3Like;

  /** The texture uri of a entity if the entity is a block entity, if set rigidBodyOptions collider shape [0] must be a block */
  blockTextureUri?: string;
}

/**
 * The options for creating a model entity.
 *
 * Use for: entities rendered from a glTF model.
 * Do NOT use for: block entities; use `BlockEntityOptions`.
 *
 * **Category:** Entities
 * @public
 */
export interface ModelEntityOptions extends BaseEntityOptions {
  /** The model animation options for animations to configure immediately. */
  modelAnimations?: Omit<EntityModelAnimationOptions, 'entity'>[];

  /** The node overrides for the entity's model. `nameMatch` is exact by default, with optional edge wildcard (`head*`, `*head`, `*head*`). */
  modelNodeOverrides?: Omit<EntityModelNodeOverrideOptions, 'entity'>[];

  /** The preferred shape of the entity's model when automatically generating its collider when no explicit colliders are provided. */
  modelPreferredShape?: ColliderShape;

  /** The scale of the entity's model. Can be a vector3 for per-axis scaling, or a number for uniform scaling. */
  modelScale?: Vector3Like | number;

  /** The interpolation time in milliseconds applied to model scale changes. */
  modelScaleInterpolationMs?: number;

  /** The texture uri of the entity's model. Setting this overrides the model's default texture. */
  modelTextureUri?: string;

  /** The URI or path to the .gltf model asset to be used for the entity. */
  modelUri?: string;
}

/**
 * The options for creating an `Entity` instance.
 *
 * Use for: constructing an entity; choose `BlockEntityOptions` or `ModelEntityOptions`.
 * Do NOT use for: mutating entity state after spawn; use entity setters and methods.
 *
 * **Category:** Entities
 * @public
 */
export type EntityOptions = 
  | BlockEntityOptions
  | ModelEntityOptions;

/**
 * Event types an Entity instance can emit.
 *
 * See `EntityEventPayloads` for the payloads.
 *
 * **Category:** Events
 * @public
 */
export enum EntityEvent {
  BLOCK_COLLISION                    = 'ENTITY.BLOCK_COLLISION',
  BLOCK_CONTACT_FORCE                = 'ENTITY.BLOCK_CONTACT_FORCE',
  DESPAWN                            = 'ENTITY.DESPAWN',
  ENTITY_COLLISION                   = 'ENTITY.ENTITY_COLLISION',
  ENTITY_CONTACT_FORCE               = 'ENTITY.ENTITY_CONTACT_FORCE',
  INTERACT                           = 'ENTITY.INTERACT',
  REMOVE_MODEL_NODE_OVERRIDE         = 'ENTITY.REMOVE_MODEL_NODE_OVERRIDE',
  SET_BLOCK_TEXTURE_URI              = 'ENTITY.SET_BLOCK_TEXTURE_URI',
  SET_EMISSIVE_COLOR                 = 'ENTITY.SET_EMISSIVE_COLOR',
  SET_EMISSIVE_INTENSITY             = 'ENTITY.SET_EMISSIVE_INTENSITY',
  SET_MODEL_SCALE                    = 'ENTITY.SET_MODEL_SCALE',
  SET_MODEL_SCALE_INTERPOLATION_MS    = 'ENTITY.SET_MODEL_SCALE_INTERPOLATION_MS',
  SET_MODEL_TEXTURE_URI              = 'ENTITY.SET_MODEL_TEXTURE_URI',
  SET_OPACITY                        = 'ENTITY.SET_OPACITY',
  SET_OUTLINE                        = 'ENTITY.SET_OUTLINE',
  SET_PARENT                         = 'ENTITY.SET_PARENT',
  SET_POSITION_INTERPOLATION_MS      = 'ENTITY.SET_POSITION_INTERPOLATION_MS',
  SET_ROTATION_INTERPOLATION_MS      = 'ENTITY.SET_ROTATION_INTERPOLATION_MS',
  SET_TINT_COLOR                     = 'ENTITY.SET_TINT_COLOR',
  SPAWN                              = 'ENTITY.SPAWN',
  TICK                               = 'ENTITY.TICK',
  UPDATE_POSITION                    = 'ENTITY.UPDATE_POSITION',
  UPDATE_ROTATION                    = 'ENTITY.UPDATE_ROTATION',
}

/**
 * Event payloads for Entity emitted events.
 *
 * **Category:** Events
 * @public
 */
export interface EntityEventPayloads {
  /** Emitted when an entity collides with a block type. */
  [EntityEvent.BLOCK_COLLISION]:                    { entity: Entity, blockType: BlockType, started: boolean, colliderHandleA: number, colliderHandleB: number }

  /** Emitted when an entity's contact force is applied to a block type. */
  [EntityEvent.BLOCK_CONTACT_FORCE]:                { entity: Entity, blockType: BlockType, contactForceData: ContactForceData }

  /** Emitted when an entity is despawned. */
  [EntityEvent.DESPAWN]:                            { entity: Entity }

  /** Emitted when an entity collides with another entity. */
  [EntityEvent.ENTITY_COLLISION]:                   { entity: Entity, otherEntity: Entity, started: boolean, colliderHandleA: number, colliderHandleB: number  }
  
  /** Emitted when an entity's contact force is applied to another entity. */
  [EntityEvent.ENTITY_CONTACT_FORCE]:               { entity: Entity, otherEntity: Entity, contactForceData: ContactForceData }

  /** Emitted when a player interacts with the entity by clicking or tapping it. */
  [EntityEvent.INTERACT]:                           { entity: Entity, player: Player, raycastHit?: RaycastHit }

  /** Emitted when a model node override is removed from the entity's model. */
  [EntityEvent.REMOVE_MODEL_NODE_OVERRIDE]:         { entity: Entity, entityModelNodeOverride: EntityModelNodeOverride }

  /** Emitted when the texture uri of a block entity is set. */
  [EntityEvent.SET_BLOCK_TEXTURE_URI]:              { entity: Entity, blockTextureUri: string | undefined }

  /** Emitted when the emissive color is set. */
  [EntityEvent.SET_EMISSIVE_COLOR]:                 { entity: Entity, emissiveColor: RgbColor | undefined }
  
  /** Emitted when the emissive intensity is set. */
  [EntityEvent.SET_EMISSIVE_INTENSITY]:             { entity: Entity, emissiveIntensity: number | undefined }

  /** Emitted when the scale of the entity's model is set. */
  [EntityEvent.SET_MODEL_SCALE]:                    { entity: Entity, modelScale: Vector3Like }

  /** Emitted when the interpolation time in milliseconds applied to model scale changes is set. */
  [EntityEvent.SET_MODEL_SCALE_INTERPOLATION_MS]:    { entity: Entity, interpolationMs: number | undefined }

  /** Emitted when the texture uri of the entity's model is set. */
  [EntityEvent.SET_MODEL_TEXTURE_URI]:              { entity: Entity, modelTextureUri: string | undefined }

  /** Emitted when the opacity of the entity is set. */
  [EntityEvent.SET_OPACITY]:                        { entity: Entity, opacity: number }

  /** Emitted when the outline of the entity is set. */
  [EntityEvent.SET_OUTLINE]:                        { entity: Entity, outline: Outline | undefined, forPlayer?: Player }

  /** Emitted when the parent of the entity is set. */
  [EntityEvent.SET_PARENT]:                         { entity: Entity, parent: Entity | undefined, parentNodeName: string | undefined }

  /** Emitted when the interpolation time in milliseconds applied to position changes is set. */
  [EntityEvent.SET_POSITION_INTERPOLATION_MS]:      { entity: Entity, interpolationMs: number | undefined }

  /** Emitted when the interpolation time in milliseconds applied to rotation changes is set. */
  [EntityEvent.SET_ROTATION_INTERPOLATION_MS]:      { entity: Entity, interpolationMs: number | undefined }

  /** Emitted when the tint color of the entity is set. */
  [EntityEvent.SET_TINT_COLOR]:                     { entity: Entity, tintColor: RgbColor | undefined }

  /** Emitted when the entity is spawned. */
  [EntityEvent.SPAWN]:                              { entity: Entity }

  /** Emitted when the entity is ticked. */
  [EntityEvent.TICK]:                               { entity: Entity, tickDeltaMs: number }

  /** Emitted when the position of the entity is updated at the end of the tick, either directly or by physics. */
  [EntityEvent.UPDATE_POSITION]:                    { entity: Entity, position: Vector3Like }

  /** Emitted when the rotation of the entity is updated at the end of the tick, either directly or by physics. */
  [EntityEvent.UPDATE_ROTATION]:                    { entity: Entity, rotation: QuaternionLike }
}

/**
 * Represents a dynamic or static object in a world.
 *
 * When to use: any non-player object that needs physics, visuals, or interactions.
 * Do NOT use for: player-controlled avatars (use `PlayerEntity` / `DefaultPlayerEntity`).
 * Do NOT use for: voxel blocks (use block APIs on `ChunkLattice`).
 *
 * @remarks
 * Entities are created from a block texture or a `.gltf` model and can have rigid bodies,
 * colliders, animations, and controllers.
 *
 * <h2>Coordinate System</h2>
 *
 * HYTOPIA uses a right-handed coordinate system where:
 * - **+X** is right
 * - **+Y** is up
 * - **-Z** is forward (identity orientation)
 *
 * Models should be authored with their front/forward facing the **-Z axis**.
 * When an entity has identity rotation (0,0,0,1 quaternion or yaw=0), it faces -Z.
 *
 * <h2>Events</h2>
 *
 * This class is an EventRouter, and instances of it emit events with payloads listed under
 * `EntityEventPayloads`.
 *
 * @example
 * ```typescript
 * const spider = new Entity({
 *   name: 'Spider',
 *   modelUri: 'models/spider.gltf',
 *   rigidBodyOptions: {
 *     type: RigidBodyType.DYNAMIC,
 *     enabledRotations: { x: false, y: true, z: false },
 *     colliders: [
 *       {
 *         shape: ColliderShape.ROUND_CYLINDER,
 *         borderRadius: 0.1,
 *         halfHeight: 0.225,
 *         radius: 0.5,
 *         tag: 'body',
 *       }
 *     ],
 *   },
 * });
 *
 * spider.spawn(world, { x: 20, y: 6, z: 10 });
 * ```
 *
 * **Category:** Entities
 * @public
 */
export default class Entity extends RigidBody implements protocol.Serializable {
  /** @internal */
  private _id: number | undefined;

  /** @internal */
  private _blockHalfExtents: Vector3Like | undefined;

  /** @internal */
  private _blockTextureUri: string | undefined;

  /** @internal */
  private _controller: BaseEntityController | undefined;

  private _tickPayload: { entity: Entity, tickDeltaMs: number } = { entity: this, tickDeltaMs: 0 };

  /** @internal */
  private _isEnvironmental: boolean = false;

  /** @internal */
  private _modelAnimations: Map<string, EntityModelAnimation> = new Map();

  /** @internal */
  private _modelNodeOverrides: Map<string, EntityModelNodeOverride> = new Map(); // name match -> model node override

  /** @internal */
  private _modelHiddenNodes: Set<string> = new Set();

  /** @internal */
  private _modelShownNodes: Set<string> = new Set();

  /** @internal */
  private _modelPreferredShape: ColliderShape | undefined;

  /** @internal */
  private _modelScale: Vector3Like = { x: 1, y: 1, z: 1 };

  /** @internal */
  private _modelScaleInterpolationMs: number | undefined;

  /** @internal */
  private _modelTextureUri: string | undefined;

  /** @internal */
  private _modelUri: string | undefined;

  /** @internal */
  private _name: string;

  /** @internal */
  private _opacity: number;

  /** @internal */
  private _outline: Outline | undefined;

  /** @internal */
  private _parent: Entity | undefined;

  /** @internal */
  private _parentNodeName: string | undefined;

  /** @internal */
  private _positionInterpolationMs: number | undefined;

  /** @internal */
  private _rotationInterpolationMs: number | undefined;

  /** @internal */
  private _tag: string | undefined;

  /** @internal */
  private _tintColor: RgbColor | undefined;

  /** @internal */
  private _emissiveColor: RgbColor | undefined;

  /** @internal */
  private _emissiveIntensity: number | undefined;

  /** @internal */
  private _lastUpdatedPosition: Vector3Like = { x: 0, y: 0, z: 0 };

  /** @internal */
  private _lastUpdatedRotation: QuaternionLike = { x: 0, y: 0, z: 0, w: 1 };

  /** @internal */
  private _lastParentlessType: RigidBodyType = RigidBodyType.DYNAMIC;

  /** @internal */
  private _world: World | undefined;

  /** @internal */
  protected _positionUpdateThresholdSq: number;

  /** @internal */
  protected _rotationUpdateThreshold: number;

  /**
   * Creates a new Entity instance.
   *
   * Use for: defining a new entity before spawning it into a world.
   * Do NOT use for: player-controlled avatars (use `PlayerEntity` or `DefaultPlayerEntity`).
   *
   * @remarks
   * Exactly one of `blockTextureUri` or `modelUri` must be provided.
   * If `controller` is provided, `controller.attach(this)` is called during construction (before spawn).
   *
   * @param options - The options for the entity.
   *
   * **Requires:** If `parent` is provided, it must already be spawned.
   *
   * **Side effects:** May attach the provided controller.
   *
   * **Category:** Entities
   */
  public constructor(options: EntityOptions) {
    const isBlockEntity = 'blockTextureUri' in options;
    const isModelEntity = 'modelUri' in options;

    if (!isBlockEntity === !isModelEntity) {
      ErrorHandler.fatalError('Entity.constructor(): Entity data must include a blockTextureUri or modelUri, but not both.');
    }

    if (isBlockEntity && !options.blockHalfExtents) {
      ErrorHandler.fatalError('Entity.constructor(): Block entity must have blockHalfExtents!');
    }

    if (options.parent && !options.parent.isSpawned) {
      ErrorHandler.fatalError('Entity.constructor(): Parent entity must be spawned before child entity!');
    }

    if (options.parent?.modelUri && options.parentNodeName && !ModelRegistry.instance.modelHasNode(options.parent.modelUri, options.parentNodeName)) {
      ErrorHandler.fatalError(`Entity.constructor(): Parent node name ${options.parentNodeName} not found in parent model ${options.parent.modelUri}!`);
    }

    super(options.rigidBodyOptions ?? DEFAULT_ENTITY_RIGID_BODY_OPTIONS);

    if (isBlockEntity) {
      this._blockHalfExtents = options.blockHalfExtents;
      this._blockTextureUri = options.blockTextureUri;
    }
    
    if (isModelEntity) {
      const modelScale = this._modelScale = typeof options.modelScale === 'number'
        ? { x: options.modelScale, y: options.modelScale, z: options.modelScale }
        : (options.modelScale ?? { x: 1, y: 1, z: 1 });

      this._modelPreferredShape = options.modelPreferredShape;
      this._modelScale = modelScale;
      this._modelScaleInterpolationMs = options.modelScaleInterpolationMs;
      this._modelTextureUri = options.modelTextureUri;
      this._modelUri = options.modelUri;

      if (!this._modelUri!.startsWith('http')) { // local model only
        if (ModelRegistry.instance.hasModel(this._modelUri!)) {
          options.modelAnimations?.forEach(modelAnimation => {
            this._modelAnimations.set(modelAnimation.name, new EntityModelAnimation({
              ...modelAnimation,
              entity: this,
            }));
          });
        } else {
          ErrorHandler.error(`Entity.constructor(): Model ${this._modelUri} does not exist!`);
        }
      }

      options.modelNodeOverrides?.forEach(modelNodeOverride => {
        this._modelNodeOverrides.set(modelNodeOverride.nameMatch.toLowerCase(), new EntityModelNodeOverride({
          ...modelNodeOverride,
          entity: this,
        }));
      });
    }

    this._emissiveColor = options.emissiveColor;
    this._emissiveIntensity = options.emissiveIntensity;
    this._isEnvironmental = options.isEnvironmental ?? false;
    this._name = options.name ?? 'Nameless';
    this._opacity = options.opacity ?? 1;
    this._outline = options.outline;
    this._parent = options.parent;
    this._parentNodeName = options.parentNodeName;
    this._positionInterpolationMs = options.positionInterpolationMs;
    this._rotationInterpolationMs = options.rotationInterpolationMs;
    this._tag = options.tag;
    this._tintColor = options.tintColor;
    this._positionUpdateThresholdSq = ENTITY_POSITION_UPDATE_THRESHOLD_SQ;
    this._rotationUpdateThreshold = ENTITY_ROTATION_UPDATE_THRESHOLD;

    if (options.controller) {
      this._controller = options.controller;
      this._controller.attach(this);
    }
  }

  /**
   * The unique identifier for the entity.
   *
   * @remarks
   * Assigned when the entity is spawned.
   *
   * **Category:** Entities
   */
  public get id(): number | undefined { return this._id; }

  /**
   * The names of the animations available in the entity's model.
   *
   * **Category:** Entities
   */
  public get availableModelAnimationNames(): Readonly<string[]> { return this.isModelEntity ? ModelRegistry.instance.getAnimationNames(this._modelUri!) : []; }

  /**
   * The names of the nodes available in the entity's model.
   *
   * **Category:** Entities
   */
  public get availableModelNodeNames(): Readonly<string[]> { return this.isModelEntity ? ModelRegistry.instance.getNodeNames(this._modelUri!) : []; }

  /**
   * The half extents of the block entity's visual size.
   *
   * @remarks
   * Only set for block entities.
   *
   * **Category:** Entities
   */
  public get blockHalfExtents(): Vector3Like | undefined { return this._blockHalfExtents; }

  /**
   * The texture URI for block entities.
   *
   * @remarks
   * When set, this entity is treated as a block entity.
   *
   * **Category:** Entities
   */
  public get blockTextureUri(): string | undefined { return this._blockTextureUri; }

  /**
   * The controller for the entity.
   *
   * **Category:** Entities
   */
  public get controller(): BaseEntityController | undefined { return this._controller; }

  /**
   * The emissive color of the entity.
   *
   * **Category:** Entities
   */
  public get emissiveColor(): RgbColor | undefined { return this._emissiveColor; }

  /**
   * The emissive intensity of the entity.
   *
   * **Category:** Entities
   */
  public get emissiveIntensity(): number | undefined { return this._emissiveIntensity; }

  /**
   * The depth (Z-axis) of the entity's model or block size.
   *
   * **Category:** Entities
   */
  public get depth(): number { return this.isModelEntity ? ModelRegistry.instance.getDepth(this._modelUri!) * this._modelScale.z : this._blockHalfExtents!.z * 2; }

  /**
   * The height (Y-axis) of the entity's model or block size.
   *
   * **Category:** Entities
   */
  public get height(): number { return this.isModelEntity ? ModelRegistry.instance.getHeight(this._modelUri!) * this._modelScale.y : this._blockHalfExtents!.y * 2; }

  /**
   * The animations of the entity's model that have been accessed or configured.
   *
   * @remarks
   * Animations are lazily created on first access via `getModelAnimation()`.
   * This array only contains animations that have been explicitly used, not every
   * clip in the model.
   *
   * **Category:** Entities
   */
  public get modelAnimations(): Readonly<EntityModelAnimation[]> { return Array.from(this._modelAnimations.values()); }

  /**
   * The node overrides of the entity's model that have been accessed or configured.
   *
   * @remarks
   * Node overrides are lazily created on first access via `getModelNodeOverride()`.
   * This array only contains overrides that have been explicitly used.
   *
   * **Category:** Entities
   */
  public get modelNodeOverrides(): Readonly<EntityModelNodeOverride[]> { return Array.from(this._modelNodeOverrides.values()); }

  /**
   * Model nodes that will not be rendered for this entity.
   *
   * @remarks
   * Uses case-insensitive substring matching.
   *
   * **Category:** Entities
   */
  public get modelHiddenNodes(): Set<string> { return this._modelHiddenNodes; }

  /**
   * Model nodes that will be rendered for this entity, overriding hidden nodes.
   *
   * @remarks
   * Uses case-insensitive substring matching.
   *
   * **Category:** Entities
   */
  public get modelShownNodes(): Set<string> { return this._modelShownNodes; }

  /**
   * The preferred collider shape when auto-generating colliders from the model.
   *
   * **Category:** Entities
   */
  public get modelPreferredShape(): ColliderShape | undefined { return this._modelPreferredShape; }

  /**
   * The scale of the entity's model.
   *
   * **Category:** Entities
   */
  public get modelScale(): Vector3Like { return this._modelScale; }

  /**
   * The interpolation time in milliseconds applied to model scale changes.
   *
   * **Category:** Entities
   */
  public get modelScaleInterpolationMs(): number | undefined { return this._modelScaleInterpolationMs; }

  /**
   * The texture URI that overrides the model entity's default texture.
   *
   * **Category:** Entities
   */
  public get modelTextureUri(): string | undefined { return this._modelTextureUri; }

  /**
   * The URI or path to the `.gltf` model asset.
   *
   * **Category:** Entities
   */
  public get modelUri(): string | undefined { return this._modelUri; }

  /**
   * The name of the entity.
   *
   * **Category:** Entities
   */
  public get name(): string { return this._name; }

  /**
   * The opacity of the entity between 0 and 1.
   *
   * **Category:** Entities
   */
  public get opacity(): number { return this._opacity; }

  /**
   * The outline rendering options for the entity.
   *
   * **Category:** Entities
   */
  public get outline(): Outline | undefined { return this._outline; }

  /**
   * The parent entity, if attached.
   *
   * **Category:** Entities
   */
  public get parent(): Entity | undefined { return this._parent; }

  /**
   * The parent model node name, if attached.
   *
   * **Category:** Entities
   */
  public get parentNodeName(): string | undefined { return this._parentNodeName; }

  /**
   * The interpolation time in milliseconds applied to position changes.
   *
   * **Category:** Entities
   */
  public get positionInterpolationMs(): number | undefined { return this._positionInterpolationMs; }

  /**
   * The interpolation time in milliseconds applied to rotation changes.
   *
   * **Category:** Entities
   */
  public get rotationInterpolationMs(): number | undefined { return this._rotationInterpolationMs; }

  /**
   * An arbitrary identifier tag for your own logic.
   *
   * **Category:** Entities
   */
  public get tag(): string | undefined { return this._tag; }

  /**
   * The tint color of the entity.
   *
   * **Category:** Entities
   */
  public get tintColor(): RgbColor | undefined { return this._tintColor; }

  /**
   * Whether this entity is a block entity.
   *
   * **Category:** Entities
   */
  public get isBlockEntity(): boolean { return !!this._blockTextureUri; }

  /**
   * Whether the entity is environmental.
   *
   * @remarks
   * Environmental entities are excluded from per-tick controller updates and update emission.
   *
   * **Category:** Entities
   */
  public get isEnvironmental(): boolean { return this._isEnvironmental; }

  /**
   * Whether this entity is a model entity.
   *
   * **Category:** Entities
   */
  public get isModelEntity(): boolean { return !!this._modelUri; }

  /**
   * Whether the entity is spawned in a world.
   *
   * **Category:** Entities
   */
  public get isSpawned(): boolean { return !!this._world; } // this should prob be changed to type predicate so we don't have to assert (!) in areas.

  /**
   * The width (X-axis) of the entity's model or block size.
   *
   * **Category:** Entities
   */
  public get width(): number { return this.isModelEntity ? ModelRegistry.instance.getWidth(this._modelUri!) * this._modelScale.x : this._blockHalfExtents!.x * 2; }

  /**
   * The world the entity is in, if spawned.
   *
   * **Category:** Entities
   */
  public get world(): World | undefined { return this._world; }

  /**
   * Clears all model node overrides from the entity's model.
   *
   * **Category:** Entities
   */
  public clearModelNodeOverrides() {
    if (!this.isModelEntity) {
      return;
    }

    this._modelHiddenNodes.clear();
    this._modelShownNodes.clear();
    this.removeModelNodeOverrides(Array.from(this._modelNodeOverrides.keys()));
  }

  /**
   * Despawns the entity and all children from the world.
   *
   * Use for: removing entities from the world.
   * Do NOT use for: temporary hiding; consider visibility or animations instead.
   *
   * @remarks
   * **Cascading:** Recursively despawns all child entities first (depth-first).
   * 
   * **Controller:** Calls `controller.detach()` then `controller.despawn()` if attached.
   * 
   * **Cleanup:** Automatically unregisters attached audios, despawns attached particle emitters,
   * and unloads attached scene UIs from their respective managers.
   * 
   * **Simulation:** Removes from physics simulation.
   *
   * **Side effects:** Emits `EntityEvent.DESPAWN` and unregisters from world managers.
   *
   * **Category:** Entities
   */
  public despawn() { 
    if (!this._requireSpawned('despawn')) {
      return;
    }

    this._world!.entityManager.getEntityChildren(this).forEach(child => {
      child.despawn();
    });

    if (this._controller) {
      this._controller.detach(this);
      this._controller.despawn(this);
    }

    this.emitWithWorld(this._world!, EntityEvent.DESPAWN, { entity: this });

    if (this.isSimulated) { // may not be simulated, such as if it is a child entity.
      this.removeFromSimulation();
    }

    this._world!.entityManager.unregisterEntity(this);
    this._world!.audioManager.unregisterEntityAttachedAudios(this);
    this._world!.particleEmitterManager.despawnEntityAttachedParticleEmitters(this);
    this._world!.sceneUIManager.unloadEntityAttachedSceneUIs(this);
    
    this._id = undefined;
    this._world = undefined;
  }

  /**
   * Gets or lazily creates a model animation for the entity's model by name.
   *
   * @remarks
   * Model entities only; returns `undefined` for block entities.
   * If the animation does not yet exist, a new instance with default settings is created
   * and added to `modelAnimations`. Use `availableModelAnimationNames` to discover
   * which animation names exist in the model.
   *
   * @param name - The name of the animation to get or create.
   * @returns The model animation instance, or `undefined` for block entities.
   *
   * **Category:** Entities
   */
  public getModelAnimation(name: string): EntityModelAnimation | undefined {
    if (!this.isModelEntity) {
      return undefined;
    }

    let modelAnimation = this._modelAnimations.get(name);

    if (!modelAnimation) {
      modelAnimation = new EntityModelAnimation({ name, entity: this });
      this._modelAnimations.set(name, modelAnimation);
    }

    return modelAnimation;
  }

  /**
   * Gets or lazily creates a model node override for the entity's model.
   * 
   * @remarks
   * Model entities only; returns `undefined` for block entities.
   * If the override does not yet exist, a new instance with default settings is created
   * and added to `modelNodeOverrides`. Use `availableModelNodeNames` to discover
   * which node names exist in the model.
   *
   * @param nameMatch - The node selector for the model node override to get or create.
   * Case-insensitive exact match by default, with optional edge wildcard (`head*`, `*head`, `*head*`).
   * 
   * @returns The model node override instance, or `undefined` for block entities.
   *
   * **Category:** Entities
   */
  public getModelNodeOverride(nameMatch: string): EntityModelNodeOverride | undefined {
    if (!this.isModelEntity) {
      return undefined;
    }

    nameMatch = nameMatch.toLowerCase();
    
    let modelNodeOverride = this._modelNodeOverrides.get(nameMatch);

    if (!modelNodeOverride) {
      modelNodeOverride = new EntityModelNodeOverride({ nameMatch, entity: this });
      this._modelNodeOverrides.set(nameMatch, modelNodeOverride);
    }

    return modelNodeOverride;
  }

  /**
   * Triggers an interaction on the entity from a player.
   *
   * Use for: programmatic interactions that should mimic a player click/tap.
   * Do NOT use for: server-only effects without player context.
   *
   * @remarks
   * This is automatically called when a player clicks or taps the entity, but can also be called directly
   * for programmatic interactions. Emits `EntityEvent.INTERACT`.
   *
   * @param player - The player interacting with the entity.
   * @param raycastHit - The raycast hit result, if the interaction was triggered by a client-side click/tap.
   *
   * **Requires:** Entity must be spawned.
   *
   * **Side effects:** Emits `EntityEvent.INTERACT`.
   *
   * **Category:** Entities
   */
  public interact(player: Player, raycastHit?: RaycastHit) {
    if (!this._requireSpawned('interact')) {
      return;
    }

    this.emitWithWorld(this._world!, EntityEvent.INTERACT, { entity: this, player, raycastHit });
  }

  public setBlockTextureUri(blockTextureUri: string | undefined) {
    if (this._blockTextureUri === blockTextureUri) {
      return;
    }

    this._blockTextureUri = blockTextureUri;
    
    if (this.isSpawned) {
      this.emitWithWorld(this._world!, EntityEvent.SET_BLOCK_TEXTURE_URI, { entity: this, blockTextureUri });
    }
  }

  /**
   * Removes a model node override from the entity's model.
   * 
   * @param nameMatch - The name match of the model node override to remove.
   * 
   * **Category:** Entities
   */
  public removeModelNodeOverride(nameMatch: string) {
    if (!this.isModelEntity) {
      return;
    }

    nameMatch = nameMatch.toLowerCase();
    this._modelHiddenNodes.delete(nameMatch);
    this._modelShownNodes.delete(nameMatch);

    const entityModelNodeOverride = this._modelNodeOverrides.get(nameMatch);

    if (!entityModelNodeOverride) {
      return;
    }

    entityModelNodeOverride.markRemoved();

    this._modelNodeOverrides.delete(nameMatch);

    if (this.isSpawned) {
      this.emitWithWorld(this._world!, EntityEvent.REMOVE_MODEL_NODE_OVERRIDE, {
        entity: this,
        entityModelNodeOverride,
      });
    }
  }

  /**
   * Removes multiple model node overrides from the entity's model.
   * 
   * @param nameMatches - The name matches of the model node overrides to remove.
   * 
   * **Category:** Entities
   */
  public removeModelNodeOverrides(nameMatches: string[]) {
    if (!this.isModelEntity) {
      return;
    }
    
    for (const nameMatch of nameMatches) {
      this.removeModelNodeOverride(nameMatch);
    }
  }

  /**
   * Sets the emissive color of the entity.
   *
   * Use for: glow effects or highlighted states.
   *
   * @param emissiveColor - The emissive color of the entity.
   *
   * **Side effects:** Emits `EntityEvent.SET_EMISSIVE_COLOR` when spawned.
   *
   * **Category:** Entities
   */
  public setEmissiveColor(emissiveColor: RgbColor | undefined) {
    if ((!emissiveColor && !this._emissiveColor) || (emissiveColor && this._emissiveColor && 
      emissiveColor.r === this._emissiveColor.r &&
      emissiveColor.g === this._emissiveColor.g && 
      emissiveColor.b === this._emissiveColor.b)) {
      return;
    }

    this._emissiveColor = emissiveColor;

    if (this.isSpawned) {
      this.emitWithWorld(this._world!, EntityEvent.SET_EMISSIVE_COLOR, { entity: this, emissiveColor });
    }
  }

  /**
   * Sets the emissive intensity of the entity.
   *
   * @param emissiveIntensity - The emissive intensity of the entity. Use a value over 1 for brighter emissive effects.
   *
   * **Side effects:** Emits `EntityEvent.SET_EMISSIVE_INTENSITY` when spawned.
   *
   * **Category:** Entities
   */
  public setEmissiveIntensity(emissiveIntensity: number | undefined) {
    if (this._emissiveIntensity === emissiveIntensity) {
      return;
    }

    this._emissiveIntensity = emissiveIntensity;

    if (this.isSpawned) {
      this.emitWithWorld(this._world!, EntityEvent.SET_EMISSIVE_INTENSITY, { entity: this, emissiveIntensity });
    }
  }

  /**
   * Sets the scale of the entity's model and proportionally
   * scales its colliders.
   * 
   * @remarks
   * Model entities only; no effect for block entities.
   *
   * **Collider scaling is relative:** Colliders are scaled by the ratio of new/old scale, not set to absolute values.
   * Example: scaling from 1 to 2 doubles collider size; scaling from 2 to 4 also doubles it.
   * 
   * **Reference equality check:** Uses `===` to compare with current scale, so passing the same
   * object reference will early return even if values changed. Always pass a new object.
   * 
   * @param modelScale - The scale of the entity's model. Can be a vector or a number for uniform scaling.
   *
   * **Side effects:** Scales existing colliders and emits `EntityEvent.SET_MODEL_SCALE` when spawned.
   *
   * **Category:** Entities
   */
  public setModelScale(modelScale: Vector3Like | number) {
    if (!this.isModelEntity) {
      return;
    }

    // Convert to vector3 if a number is provided.
    if (typeof modelScale === 'number') {
      modelScale = { x: modelScale, y: modelScale, z: modelScale };
    }

    if (this._modelScale === modelScale) {
      return;
    }

    const scalar: Vector3Like = {
      x: modelScale.x / this._modelScale.x,
      y: modelScale.y / this._modelScale.y,
      z: modelScale.z / this._modelScale.z,
    };

    this._modelScale = modelScale;

    this.colliders.forEach(collider => collider.setScale(scalar));

    if (this.isSpawned) {
      this.emitWithWorld(this._world!, EntityEvent.SET_MODEL_SCALE, {
        entity: this,
        modelScale,
      });
    }
  }

  /**
   * Sets the interpolation time in milliseconds applied to model scale changes.
   * 
   * @param interpolationMs - The interpolation time in milliseconds to set.
   *
   * **Side effects:** Emits `EntityEvent.SET_MODEL_SCALE_INTERPOLATION_MS` when spawned.
   *
   * **Category:** Entities
   */
  public setModelScaleInterpolationMs(interpolationMs: number | undefined) {
    if (!this.isModelEntity) {
      return;
    }
    
    if (this._modelScaleInterpolationMs === interpolationMs) {
      return;
    }

    this._modelScaleInterpolationMs = interpolationMs;

    if (this.isSpawned) {
      this.emitWithWorld(this._world!, EntityEvent.SET_MODEL_SCALE_INTERPOLATION_MS, {
        entity: this,
        interpolationMs,
      });
    }
  }

  /**
   * Sets the texture uri of the entity's model. Setting 
   * this overrides the model's default texture.
   *
   * @remarks
   * Model entities only; no effect for block entities.
   *
   * @param modelTextureUri - The texture uri of the entity's model.
   *
   * **Side effects:** Emits `EntityEvent.SET_MODEL_TEXTURE_URI` when spawned.
   *
   * **Category:** Entities
   */
  public setModelTextureUri(modelTextureUri: string | undefined) {
    if (!this.isModelEntity || this._modelTextureUri === modelTextureUri) {
      return;
    }

    this._modelTextureUri = modelTextureUri;

    if (this.isSpawned) {
      this.emitWithWorld(this._world!, EntityEvent.SET_MODEL_TEXTURE_URI, {
        entity: this,
        modelTextureUri,
      });
    }
  }

  /**
   * Sets model nodes to hide for this entity.
   *
   * @remarks
   * This compatibility API is backed by model node overrides. Exact node-match
   * overrides are created with `hidden=true`, while shown-node overrides remain
   * exact-match `hidden=false` so they continue to win over broader hidden rules.
   *
   * **Category:** Entities
   */
  public setModelHiddenNodes(hiddenNodes: string[]) {
    if (!this.isModelEntity) {
      return;
    }

    const nextHiddenNodes = new Set(hiddenNodes.map(node => node.toLowerCase()));

    for (const hiddenNode of this._modelHiddenNodes) {
      if (!nextHiddenNodes.has(hiddenNode)) {
        this.removeModelNodeOverride(hiddenNode);
      }
    }

    for (const hiddenNode of nextHiddenNodes) {
      if (this._modelShownNodes.has(hiddenNode)) {
        continue;
      }

      this.getModelNodeOverride(hiddenNode)?.setHidden(true);
    }

    this._modelHiddenNodes = nextHiddenNodes;
  }

  /**
   * Sets model nodes to explicitly show for this entity.
   *
   * @remarks
   * This compatibility API is backed by exact-match model node overrides with
   * `hidden=false`, allowing shown nodes to override broader hidden matches.
   *
   * **Category:** Entities
   */
  public setModelShownNodes(shownNodes: string[]) {
    if (!this.isModelEntity) {
      return;
    }

    const nextShownNodes = new Set(shownNodes.map(node => node.toLowerCase()));

    for (const shownNode of this._modelShownNodes) {
      if (!nextShownNodes.has(shownNode)) {
        if (this._modelHiddenNodes.has(shownNode)) {
          this.getModelNodeOverride(shownNode)?.setHidden(true);
        } else {
          this.removeModelNodeOverride(shownNode);
        }
      }
    }

    for (const shownNode of nextShownNodes) {
      this.getModelNodeOverride(shownNode)?.setHidden(false);
    }

    this._modelShownNodes = nextShownNodes;
  }

  /**
   * Sets the opacity of the entity.
   * @param opacity - The opacity of the entity between 0 and 1. 0 is fully transparent, 1 is fully opaque.
   *
   * **Side effects:** Emits `EntityEvent.SET_OPACITY` when spawned.
   *
   * **Category:** Entities
   */
  public setOpacity(opacity: number) {
    if (this._opacity === opacity) {
      return;
    }

    this._opacity = opacity;

    if (this.isSpawned) {
      this.emitWithWorld(this._world!, EntityEvent.SET_OPACITY, {
        entity: this,
        opacity,
      });
    }
  }

  /**
   * Sets the outline rendering options for the entity.
   * @param outline - The outline options, or undefined to remove the outline.
   * @param forPlayer - The player to set the outline for, if undefined the outline will be set for all players.
   *
   * **Side effects:** Emits `EntityEvent.SET_OUTLINE` when spawned.
   *
   * **Category:** Entities
   */
  public setOutline(outline: Outline | undefined, forPlayer?: Player) {
    this._outline = outline;

    if (this.isSpawned) {
      this.emitWithWorld(this._world!, EntityEvent.SET_OUTLINE, {
        entity: this,
        forPlayer,
        outline,
      });
    }
  }

  /**
   * Sets the parent of the entity and resets this entity's position and rotation.
   * 
   * @remarks
   * When setting the parent, all forces, torques and velocities of this entity are reset.
   * Additionally, this entity's type will be set to `KINEMATIC_VELOCITY` if it is not already.
   * All colliders of this entity will be disabled when parent is not undefined. If the provided parent
   * is undefined, this entity will be removed from its parent and all colliders will be re-enabled.
   * When setting an undefined parent to remove this entity from its parent, this entity's type
   * will be set to the last type it was set to before being a child.
   * 
   * @param parent - The parent entity to set, or undefined to remove from an existing parent.
   * @param parentNodeName - The name of the parent's node (if parent is a model entity) this entity will attach to.
   * @param position - The position to set for the entity. If parent is provided, this is relative to the parent's attachment point.
   * @param rotation - The rotation to set for the entity. If parent is provided, this is relative to the parent's rotation.
   *
   * **Requires:** If `parent` is provided, it must be spawned.
   *
   * **Side effects:** Disables/enables colliders, changes rigid body type, and emits `EntityEvent.SET_PARENT`.
   *
   * **Category:** Entities
   */
  public setParent(parent: Entity | undefined, parentNodeName?: string, position?: Vector3Like, rotation?: QuaternionLike) {
    if (parent && !parent.isSpawned) {
      return ErrorHandler.error('Entity.setParent(): Parent entity is not spawned, cannot set parent!');
    }

    if (!this._parent && parent) {
      this._lastParentlessType = this.type;
    }

    this._parent = parent;
    this._parentNodeName = parentNodeName;

    if (!this.isSpawned) {
      return;
    }

    this.colliders.forEach(collider => collider.setEnabled(!parent));
    this.setType(!parent ? this._lastParentlessType : RigidBodyType.KINEMATIC_VELOCITY);
    this.setPosition(position ?? { x: 0, y: 0, z: 0 });
    this.setRotation(rotation ?? { x: 0, y: 0, z: 0, w: 1 });

    if (!this.isKinematicPositionBased) {
      this.resetAngularVelocity();
      this.resetForces();
      this.resetLinearVelocity();
      this.resetTorques();
    }
    
    this.emitWithWorld(this._world!, EntityEvent.SET_PARENT, {
      entity: this,
      parent,
      parentNodeName,
    });
  }

  /**
   * Sets the interpolation time in milliseconds applied to position changes.
   * 
   * @param interpolationMs - The interpolation time in milliseconds to set.
   *
   * **Side effects:** Emits `EntityEvent.SET_POSITION_INTERPOLATION_MS` when spawned.
   *
   * **Category:** Entities
   */
  public setPositionInterpolationMs(interpolationMs: number | undefined) {
    if (this._positionInterpolationMs === interpolationMs) {
      return;
    }

    this._positionInterpolationMs = interpolationMs;

    if (this.isSpawned) {
      this.emitWithWorld(this._world!, EntityEvent.SET_POSITION_INTERPOLATION_MS, {
        entity: this,
        interpolationMs,
      });
    }
  }

  /**
   * Sets the interpolation time in milliseconds applied to rotation changes.
   * 
   * @param interpolationMs - The interpolation time in milliseconds to set.
   *
   * **Side effects:** Emits `EntityEvent.SET_ROTATION_INTERPOLATION_MS` when spawned.
   *
   * **Category:** Entities
   */
  public setRotationInterpolationMs(interpolationMs: number | undefined) {
    if (this._rotationInterpolationMs === interpolationMs) {
      return;
    }

    this._rotationInterpolationMs = interpolationMs;

    if (this.isSpawned) {
      this.emitWithWorld(this._world!, EntityEvent.SET_ROTATION_INTERPOLATION_MS, {
        entity: this,
        interpolationMs,
      });
    }
  }

  /**
   * Sets the tint color of the entity.
   * @param tintColor - The tint color of the entity.
   *
   * **Side effects:** Emits `EntityEvent.SET_TINT_COLOR` when spawned.
   *
   * **Category:** Entities
   */
  public setTintColor(tintColor: RgbColor | undefined) {
    if ((!tintColor && !this._tintColor) || (tintColor && this._tintColor && 
      tintColor.r === this._tintColor.r &&
      tintColor.g === this._tintColor.g && 
      tintColor.b === this._tintColor.b)) {
      return;
    }

    this._tintColor = tintColor;

    if (this.isSpawned) {
      this.emitWithWorld(this._world!, EntityEvent.SET_TINT_COLOR, {
        entity: this,
        tintColor,
      });
    }
  }

  /**
   * Spawns the entity in the world.
   *
   * Use for: placing the entity into a world so it simulates and syncs to clients.
   * Do NOT use for: reusing a single entity instance across multiple worlds.
   *
   * @remarks
   * **Rotation default:** If no rotation is provided, entity spawns with identity rotation facing -Z.
   * For Y-axis rotation (yaw): `{ x: 0, y: sin(yaw/2), z: 0, w: cos(yaw/2) }`. Yaw 0 = facing -Z.
   * 
   * **Auto-collider creation:** If no colliders are provided, a default collider is auto-generated
   * from the model bounds (or block half extents). Set `modelPreferredShape` to `ColliderShape.NONE` to disable.
   * 
   * **Collision groups:** Colliders with default collision groups are auto-assigned based on `isEnvironmental`
   * and `isSensor` flags. Environmental entities don't collide with blocks or other environmental entities.
   * 
   * **Event enabling:** Collision/contact force events are auto-enabled on colliders if listeners
   * are registered for `BLOCK_COLLISION`, `ENTITY_COLLISION`, `BLOCK_CONTACT_FORCE`, or `ENTITY_CONTACT_FORCE` prior to spawning.
   * 
   * **Controller:** If a controller is attached, `controller.spawn()` is called after the entity is added to the physics simulation.
   * 
   * **Parent handling:** If `parent` was set in options, `setParent()` is called after spawn with the provided position/rotation.
   *
   * @param world - The world to spawn the entity in.
   * @param position - The position to spawn the entity at.
   * @param rotation - The optional rotation to spawn the entity with.
   *
   * **Requires:** Entity must not already be spawned.
   *
   * **Side effects:** Registers the entity, adds it to the simulation, and emits `EntityEvent.SPAWN`.
   *
   * **Category:** Entities
   */
  public spawn(world: World, position: Vector3Like, rotation?: QuaternionLike) {
    if (this.isSpawned) {
      return ErrorHandler.error(`Entity.spawn(): Entity ${this._name} is already spawned with id ${this._id}!`);
    }

    if (!this.isSimulated) {
      this.addToSimulation(world.simulation);
    }

    if (this._blockTextureUri && this._blockHalfExtents && this.numColliders === 0) { // add a default collider for block entities if none are provided.
      this.addChildColliderToSimulation(new Collider(
        Collider.optionsFromBlockHalfExtents(this._blockHalfExtents),
      ));
    }

    if (this._modelUri && this.numColliders === 0 && this._modelPreferredShape !== ColliderShape.NONE) {
      this.addChildColliderToSimulation(new Collider(
        Collider.optionsFromModelUri(this._modelUri, this._modelScale, this._modelPreferredShape),
      ));
    }

    this.colliders.forEach(collider => {
      if (this.hasListeners(EntityEvent.BLOCK_COLLISION) || this.hasListeners(EntityEvent.ENTITY_COLLISION)) {
        collider.enableCollisionEvents(true);
      }

      if (this.hasListeners(EntityEvent.BLOCK_CONTACT_FORCE) || this.hasListeners(EntityEvent.ENTITY_CONTACT_FORCE)) {
        collider.enableContactForceEvents(true);
      }

      if (CollisionGroupsBuilder.isDefaultCollisionGroups(collider.collisionGroups)) {
        const belongsTo = this.isEnvironmental
          ? [ CollisionGroup.ENVIRONMENT_ENTITY ]
          : [ collider.isSensor ? CollisionGroup.ENTITY_SENSOR : CollisionGroup.ENTITY ];

        const collidesWith = this.isEnvironmental
          ? [ CollisionGroup.ALL & ~CollisionGroup.ENVIRONMENT_ENTITY & ~CollisionGroup.BLOCK ] // all except environment entities and blocks
          : [ CollisionGroup.ALL ];

        collider.setCollisionGroups({ belongsTo, collidesWith });
      }
    });

    this.setPosition(position);

    if (rotation) {
      this.setRotation(rotation);
    }

    this._id = world.entityManager.registerEntity(this);
    this._world = world;

    if (this._controller) {
      this._controller.spawn(this);
    }

    if (this._parent) {
      this.setParent(this._parent, this._parentNodeName, position, rotation);
    }

    this.colliders.forEach(collider => {
      world.simulation.colliderMap.setColliderEntity(collider, this);
    });

    this.emitWithWorld(world, EntityEvent.SPAWN, { entity: this });
  }

  /**
   * Stops all model animations for the entity, optionally excluding specific animations from stopping.
   *
   * @param exclusionFilter - Either a filter function or a list of animation names to exclude.
   *
   * **Side effects:** May emit `EntityModelAnimationEvent.STOP` for each stopped animation.
   *
   * **Category:** Entities
   */
  public stopAllModelAnimations(
    exclusionFilter?: ((modelAnimation: Readonly<EntityModelAnimation>) => boolean) | readonly string[],
  ) {
    const exclusionNames = Array.isArray(exclusionFilter) ? new Set(exclusionFilter) : undefined;

    for (const modelAnimation of this._modelAnimations.values()) {
      if (exclusionNames?.has(modelAnimation.name)) continue;
      if (typeof exclusionFilter === 'function' && exclusionFilter(modelAnimation)) continue;
      modelAnimation.stop();
    }
  }

  /**
   * Stops the provided model animations for the entity.
   *
   * @param modelAnimationNames - The model animation names to stop.
   *
   * **Side effects:** May emit `EntityModelAnimationEvent.STOP` for each stopped animation.
   *
   * **Category:** Entities
   */
  public stopModelAnimations(modelAnimationNames: readonly string[]) {
    for (const modelAnimationName of modelAnimationNames) {
      const modelAnimation = this._modelAnimations.get(modelAnimationName);
      if (!modelAnimation) continue;
      modelAnimation.stop();
    }
  }

  /**
   * Starts the provided model animations as looped animations for the entity.
   *
   * @param modelAnimationNames - The model animation names to start looping.
   *
   * **Side effects:** May emit `EntityModelAnimationEvent.SET_LOOP_MODE` and
   * `EntityModelAnimationEvent.PLAY` for each started animation.
   *
   * **Category:** Entities
   */
  public startModelLoopedAnimations(modelAnimationNames: readonly string[]) {
    for (const modelAnimationName of modelAnimationNames) {
      const modelAnimation = this.getModelAnimation(modelAnimationName);
      if (!modelAnimation) continue;

      modelAnimation.setLoopMode(EntityModelAnimationLoopMode.LOOP);
      modelAnimation.play();
    }
  }

  /**
   * Starts the provided model animations as one-shot animations for the entity.
   *
   * @param modelAnimationNames - The model animation names to restart once.
   *
   * **Side effects:** May emit `EntityModelAnimationEvent.SET_LOOP_MODE` and
   * `EntityModelAnimationEvent.RESTART` for each started animation.
   *
   * **Category:** Entities
   */
  public startModelOneshotAnimations(modelAnimationNames: readonly string[]) {
    for (const modelAnimationName of modelAnimationNames) {
      const modelAnimation = this.getModelAnimation(modelAnimationName);
      if (!modelAnimation) continue;

      modelAnimation.setLoopMode(EntityModelAnimationLoopMode.ONCE);
      modelAnimation.restart();
    }
  }

  /**
   * Sets the playback rate for all currently created model animations on the entity.
   *
   * @param playbackRate - The playback rate to apply to the entity's model animations.
   *
   * **Side effects:** May emit `EntityModelAnimationEvent.SET_PLAYBACK_RATE` for
   * each tracked model animation.
   *
   * **Category:** Entities
   */
  public setModelAnimationsPlaybackRate(playbackRate: number) {
    for (const modelAnimation of this._modelAnimations.values()) {
      modelAnimation.setPlaybackRate(playbackRate);
    }
  }

  /** @internal */
  public checkAndEmitUpdates(): void {
    if (!this._requireSpawned('checkAndEmitUpdates')) {
      return;
    }

    const position = this.position;
    const rotation = this.rotation;

    if (this._rotationExceedsThreshold(rotation, this._lastUpdatedRotation)) {
      this._lastUpdatedRotation = rotation;
      this.emitWithWorld(this._world!, EntityEvent.UPDATE_ROTATION, {
        entity: this,
        rotation,
      });
    }

    if (this._positionExceedsThreshold(position, this._lastUpdatedPosition)) {
      this._lastUpdatedPosition = position;
      this.emitWithWorld(this._world!, EntityEvent.UPDATE_POSITION, {
        entity: this,
        position,
      });
    }
  }

  /** @internal */
  public serialize(): protocol.EntitySchema {
    return Serializer.serializeEntity(this);
  }

  /** @internal */
  public tick(tickDeltaMs: number): void {
    this._tickPayload.tickDeltaMs = tickDeltaMs;
    this.emit(EntityEvent.TICK, this._tickPayload);

    if (this._controller) {
      this._controller.tick(this, tickDeltaMs);
    }
  }

  /*
   * Helpers
   */

  /** @internal */
  private _positionExceedsThreshold(a: Vector3Like, b: Vector3Like): boolean {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    
    return (dx * dx + dy * dy + dz * dz) > this._positionUpdateThresholdSq;
  }

  /** @internal */
  private _requireSpawned(methodName: string): boolean {
    if (!this.isSpawned) {
      ErrorHandler.error(`Entity._requireSpawned(): Entity ${this._name} is not spawned, cannot invoke ${methodName}()!`);
    }

    return this.isSpawned;
  }

  /** @internal */
  private _rotationExceedsThreshold(a: QuaternionLike, b: QuaternionLike): boolean {
    // Dot product of quaternions
    return Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w) < this._rotationUpdateThreshold;
  }
}
