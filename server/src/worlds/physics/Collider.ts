import RAPIER from '@dimforge/rapier3d-simd-compat';
import CollisionGroupsBuilder from '@/worlds/physics/CollisionGroupsBuilder';
import ErrorHandler from '@/errors/ErrorHandler';
import EventRouter from '@/events/EventRouter';
import ModelRegistry from '@/models/ModelRegistry';
import type { CollisionCallback } from '@/worlds/physics/ColliderMap';
import type { CollisionGroups } from '@/worlds/physics/CollisionGroupsBuilder';
import type QuaternionLike from '@/shared/types/math/QuaternionLike';
import type RigidBody from '@/worlds/physics/RigidBody';
import { RigidBodyType } from '@/worlds/physics/RigidBody';
import type Simulation from '@/worlds/physics/Simulation';
import type Vector3Like from '@/shared/types/math/Vector3Like';

/**
 * The coefficient for friction or bounciness combine rule. @public
 *
 * **Category:** Physics
 */
export enum CoefficientCombineRule {
  Average = 0,
  Min = 1,
  Multiply = 2,
  Max = 3,
}

/**
 * The shapes a collider can be. @public
 *
 * **Category:** Physics
 */
export enum ColliderShape {
  NONE = 'none',
  BALL = 'ball',
  BLOCK = 'block',
  CAPSULE = 'capsule',
  CONE = 'cone',
  CYLINDER = 'cylinder',
  ROUND_CYLINDER = 'round-cylinder',
  TRIMESH = 'trimesh',
  VOXELS = 'voxels',
  WEDGE = 'wedge',
}

/**
 * The base options for a collider. @public
 *
 * Use for: configuring colliders when creating entities or rigid bodies.
 * Do NOT use for: runtime changes; use `Collider` methods instead.
 *
 * **Category:** Physics
 */
export interface BaseColliderOptions {
  /**
   * The shape of the collider.
   *
   * **Category:** Physics
   */
  shape: ColliderShape;

  /**
   * The bounciness of the collider.
   *
   * **Category:** Physics
   */
  bounciness?: number;

  /**
   * The bounciness combine rule of the collider.
   *
   * **Category:** Physics
   */
  bouncinessCombineRule?: CoefficientCombineRule;

  /**
   * The collision groups the collider belongs to.
   *
   * **Category:** Physics
   */
  collisionGroups?: CollisionGroups;

  /**
   * Whether the collider is enabled.
   *
   * **Category:** Physics
   */
  enabled?: boolean;

  /**
   * The flags of the collider if the shape is a trimesh
   *
   * **Category:** Physics
   */
  flags?: number;

  /**
   * The friction of the collider.
   *
   * **Category:** Physics
   */
  friction?: number;

  /**
   * The friction combine rule of the collider.
   *
   * **Category:** Physics
   */
  frictionCombineRule?: CoefficientCombineRule;

  /**
   * Whether the collider is a sensor.
   *
   * **Category:** Physics
   */
  isSensor?: boolean;

  /**
   * The mass of the collider.
   *
   * **Category:** Physics
   */
  mass?: number;

  /**
   * The on collision callback for the collider.
   *
   * **Category:** Physics
   */
  onCollision?: CollisionCallback;

  /**
   * The parent rigid body of the collider.
   *
   * **Category:** Physics
   */
  parentRigidBody?: RigidBody;

  /**
   * The relative position of the collider. Relative to parent rigid body.
   *
   * **Category:** Physics
   */
  relativePosition?: Vector3Like;

  /**
   * The relative rotation of the collider. Relative to parent rigid body.
   *
   * **Category:** Physics
   */
  relativeRotation?: QuaternionLike;

  /**
   * The simulation the collider is in, if provided the collider will automatically be added to the simulation.
   *
   * **Category:** Physics
   */
  simulation?: Simulation;

  /**
   * An arbitrary identifier tag of the collider. Useful for your own logic.
   *
   * **Category:** Physics
   */
  tag?: string;
}

/**
 * The options for a ball collider. @public
 *
 * Use for: sphere-shaped colliders.
 * Do NOT use for: other shapes; use the matching collider option type.
 *
 * **Category:** Physics
 */
export interface BallColliderOptions extends BaseColliderOptions {
  shape: ColliderShape.BALL;

  /**
   * The radius of the ball collider.
   *
   * **Category:** Physics
   */
  radius?: number;
}

/**
 * The options for a block collider. @public
 *
 * Use for: axis-aligned box colliders.
 * Do NOT use for: other shapes; use the matching collider option type.
 *
 * **Category:** Physics
 */
export interface BlockColliderOptions extends BaseColliderOptions {
  shape: ColliderShape.BLOCK;

  /**
   * The half extents of the block collider.
   *
   * **Category:** Physics
   */
  halfExtents?: Vector3Like;
}

/**
 * The options for a capsule collider. @public
 *
 * Use for: capsule-shaped colliders.
 * Do NOT use for: other shapes; use the matching collider option type.
 *
 * **Category:** Physics
 */
export interface CapsuleColliderOptions extends BaseColliderOptions {
  shape: ColliderShape.CAPSULE;

  /**
   * The half height of the capsule collider.
   *
   * **Category:** Physics
   */
  halfHeight?: number;

  /**
   * The radius of the capsule collider.
   *
   * **Category:** Physics
   */
  radius?: number;
}

/**
 * The options for a cone collider. @public
 *
 * Use for: cone-shaped colliders.
 * Do NOT use for: other shapes; use the matching collider option type.
 *
 * **Category:** Physics
 */
export interface ConeColliderOptions extends BaseColliderOptions {
  shape: ColliderShape.CONE;

  /**
   * The half height of the cone collider.
   *
   * **Category:** Physics
   */
  halfHeight?: number;

  /**
   * The radius of the cone collider.
   *
   * **Category:** Physics
   */
  radius?: number;
}

/**
 * The options for a cylinder collider. @public
 *
 * Use for: cylinder-shaped colliders.
 * Do NOT use for: other shapes; use the matching collider option type.
 *
 * **Category:** Physics
 */
export interface CylinderColliderOptions extends BaseColliderOptions {
  shape: ColliderShape.CYLINDER;

  /**
   * The half height of the cylinder collider.
   *
   * **Category:** Physics
   */
  halfHeight?: number;

  /**
   * The radius of the cylinder collider.
   *
   * **Category:** Physics
   */
  radius?: number;
}

/**
 * The options for a round cylinder collider. @public
 *
 * Use for: rounded cylinder colliders.
 * Do NOT use for: other shapes; use the matching collider option type.
 *
 * **Category:** Physics
 */
export interface RoundCylinderColliderOptions extends BaseColliderOptions {
  shape: ColliderShape.ROUND_CYLINDER;
  
  /**
   * The border radius of the round cylinder collider.
   *
   * **Category:** Physics
   */
  borderRadius?: number;

  /**
   * The half height of the round cylinder collider.
   *
   * **Category:** Physics
   */
  halfHeight?: number;

  /**
   * The radius of the round cylinder collider.
   *
   * **Category:** Physics
   */
  radius?: number;
}

/**
 * The options for a trimesh collider. @public
 *
 * Use for: mesh-based colliders from model data.
 * Do NOT use for: simple primitives; prefer analytic shapes when possible.
 *
 * **Category:** Physics
 */
export interface TrimeshColliderOptions extends BaseColliderOptions {
  shape: ColliderShape.TRIMESH;
  
  /**
   * The indices of the trimesh collider.
   *
   * **Category:** Physics
   */
  indices?: Uint32Array;

  /**
   * The vertices of the trimesh collider.
   *
   * **Category:** Physics
   */
  vertices?: Float32Array;
}

/**
 * The options for a voxels collider. @public
 *
 * Use for: voxel-based colliders (block volumes).
 * Do NOT use for: simple primitives; prefer analytic shapes when possible.
 *
 * **Category:** Physics
 */
export interface VoxelsColliderOptions extends BaseColliderOptions {
  shape: ColliderShape.VOXELS;

  /**
   * The coordinate of each voxel in the collider.
   *
   * **Category:** Physics
   */
  coordinates?: Vector3Like[];

  /**
   * The size of each voxel in the collider.
   *
   * **Category:** Physics
   */
  size?: Vector3Like;
}

/**
 * The options for a wedge collider. @public
 *
 * Use for: wedge-shaped colliders (inclined planes).
 * Do NOT use for: other shapes; use the matching collider option type.
 *
 * **Category:** Physics
 */
export interface WedgeColliderOptions extends BaseColliderOptions {
  shape: ColliderShape.WEDGE;

  /**
   * The extents of the wedge collider, defining full width (x), height (y), and length (z).
   *
   * **Category:** Physics
   */
  extents?: Vector3Like;
}

/**
 * The options for an error type "none" collider. @public
 *
 * Use for: explicitly disabling collider creation.
 * Do NOT use for: physical interactions; no collider will be created.
 *
 * **Category:** Physics
 */
export interface NoneColliderOptions extends BaseColliderOptions {
  shape: ColliderShape.NONE;
}

/**
 * The options for a collider. @public
 *
 * Use for: providing collider definitions when creating rigid bodies or entities.
 * Do NOT use for: runtime changes; use `Collider` APIs instead.
 *
 * **Category:** Physics
 */
export type ColliderOptions = 
  | BallColliderOptions
  | BlockColliderOptions
  | CapsuleColliderOptions
  | ConeColliderOptions
  | CylinderColliderOptions
  | RoundCylinderColliderOptions
  | TrimeshColliderOptions
  | VoxelsColliderOptions
  | WedgeColliderOptions
  | NoneColliderOptions;

/**
 * A raw collider object from the Rapier physics engine. @public
 *
 * **Category:** Physics
 */
export type RawCollider = RAPIER.Collider;

/**
 * A raw shape object from the Rapier physics engine. @public
 *
 * **Category:** Physics
 */
export type RawShape = RAPIER.Shape;

/**
 * Represents a collider in a world's physics simulation.
 *
 * When to use: defining collision shapes for rigid bodies or entities.
 * Do NOT use for: gameplay queries; use `Simulation.raycast` or intersection APIs instead.
 *
 * @remarks
 * Colliders are usually created via `RigidBody` or `Entity` options.
 * You can also create and manage them directly for advanced use cases.
 *
 * **Category:** Physics
 * @public
 */
export default class Collider extends EventRouter {
  /**
   * @internal
   */
  private _collider: RAPIER.Collider | undefined;

  /**
   * @internal
   */
  private _colliderDesc: RAPIER.ColliderDesc | undefined;

  /**
   * @internal
   */
  private _onCollision: CollisionCallback | undefined;

  /**
   * @internal
   */
  private _parentRigidBody: RigidBody | undefined;

  /**
   * @internal
   */
  private _relativePosition: Vector3Like = { x: 0, y: 0, z: 0 };

  /**
   * @internal
   */
  private _relativeRotation: QuaternionLike = { x: 0, y: 0, z: 0, w: 1 };

  /**
   * @internal
   */
  private _scale: Vector3Like = { x: 1, y: 1, z: 1 };

  /**
   * @internal
   */
  private _shape: ColliderShape;

  /**
   * @internal
   */
  private _simulation: Simulation | undefined;

  /**
   * @internal
   */
  private _tag: string | undefined;
  
  /**
   * Creates a collider with the provided options.
   *
   * Use for: configuring a collider before adding it to a simulation or rigid body.
   *
   * @param colliderOptions - The options for the collider instance.
   *
   * **Category:** Physics
   */
  public constructor(colliderOptions: ColliderOptions) {
    super();

    this._colliderDesc = this._createColliderDesc(colliderOptions);
    this._shape = colliderOptions.shape;
    this._applyColliderOptions(colliderOptions);
    this._autoAddToSimulation(colliderOptions);
  }

  /**
   * Creates collider options from a block's half extents.
   *
   * @param halfExtents - The half extents of the block.
   * @returns The collider options object.
   *
   * **Category:** Physics
   */
  public static optionsFromBlockHalfExtents(halfExtents: Vector3Like): ColliderOptions {
    return {
      shape: ColliderShape.BLOCK,
      halfExtents,
    };
  }

  /**
   * Creates collider options from a model URI using an approximate shape and size.
   *
   * @remarks
   * Uses model bounds and heuristics unless `preferredShape` is specified.
   *
   * @param modelUri - The URI of the model.
   * @param scale - The scale of the model.
   * @param preferredShape - The preferred shape to use for the collider.
   * @returns The collider options object.
   *
   * **Category:** Physics
   */
  public static optionsFromModelUri(modelUri: string, scale: Vector3Like | number = 1, preferredShape?: ColliderShape): ColliderOptions {
    scale = typeof scale === 'number' ? { x: scale, y: scale, z: scale } : scale;

    const boundingBox = ModelRegistry.instance.getBoundingBox(modelUri);
    
    const width = boundingBox.max.x - boundingBox.min.x;
    const height = boundingBox.max.y - boundingBox.min.y;
    const depth = boundingBox.max.z - boundingBox.min.z;

    const scaledWidth = width * scale.x;
    const scaledHeight = height * scale.y;
    const scaledDepth = depth * scale.z;
    
    const maxHorizontal = Math.max(scaledWidth, scaledDepth);
    const minHorizontal = Math.min(scaledWidth, scaledDepth);
    const horizontalRatio = maxHorizontal / minHorizontal;
    const widthToHeightRatio = maxHorizontal / scaledHeight;
    const radius = maxHorizontal / 2;
    
    // Helper function to ensure minimum size
    const ensureMinSize = (value: number) => Math.max(0.01, value);
    
    // Create block shape options
    const createBlockOptions = () => ({
      shape: ColliderShape.BLOCK,
      halfExtents: {
        x: ensureMinSize(scaledWidth / 2),
        y: ensureMinSize(scaledHeight / 2), 
        z: ensureMinSize(scaledDepth / 2),
      },
    });
    
    // Create round cylinder options
    const createRoundCylinderOptions = () => ({
      shape: ColliderShape.ROUND_CYLINDER,
      radius: ensureMinSize(radius),
      halfHeight: ensureMinSize(scaledHeight / 2),
      borderRadius: ensureMinSize(radius * 0.1),
    });

    // Create trimesh options
    const createTrimeshOptions = () => {
      const trimesh = ModelRegistry.instance.getTrimesh(modelUri, scale);

      if (!trimesh) {
        return undefined;
      }

      return {
        shape: ColliderShape.TRIMESH,
        vertices: trimesh.vertices,
        indices: trimesh.indices,
      };
    };
    
    // Create wedge options
    const createWedgeOptions = () => ({
      shape: ColliderShape.WEDGE,
      extents: {
        x: scaledWidth,
        y: scaledHeight,
        z: scaledDepth,
      },
    });
    
    // Create capsule options
    const createCapsuleOptions = () => ({
      shape: ColliderShape.CAPSULE,
      radius: ensureMinSize(radius),
      halfHeight: ensureMinSize((scaledHeight / 2) - radius),
    });
    
    // If preferred shape is specified, use it
    if (preferredShape) {
      switch (preferredShape) {
        case ColliderShape.BLOCK:
          return createBlockOptions();
        case ColliderShape.CAPSULE:
          return createCapsuleOptions();
        case ColliderShape.ROUND_CYLINDER:
          return createRoundCylinderOptions();
        case ColliderShape.TRIMESH: {
          const trimesh = createTrimeshOptions();

          if (!trimesh) {
            ErrorHandler.error(`Collider.optionsFromModelUri(): Failed to create trimesh options for model ${modelUri}, falling back to generic shape!`);
            break;
          }

          return trimesh;
        }
        case ColliderShape.WEDGE:
          return createWedgeOptions();
        default:
          ErrorHandler.warning(`Collider.optionsFromModelUri(): Preferred shape ${preferredShape} is not yet supported with Collider.optionsFromModelUri(), defaulting to generic shape!`);
      }
    }
    
    // No preferred shape, use heuristics to determine best shape
    if (horizontalRatio > 2) {
      // Use block for objects with very different horizontal dimensions
      return createBlockOptions();
    }
    
    if (widthToHeightRatio > 1.5) {
      // Use rounded cylinder for wider objects
      return createRoundCylinderOptions();
    }
    
    // Default to capsule shape
    return createCapsuleOptions();
  }

  /*
   * Getters
   */

  /**
   * The bounciness of the collider.
   *
   * **Category:** Physics
   */
  public get bounciness(): number {
    if (!this._requireNotRemoved('bounciness')) { return 0; }

    return this._collider
      ? this._collider.restitution()
      : this._colliderDesc!.restitution;
  }

  /**
   * The bounciness combine rule of the collider.
   *
   * **Category:** Physics
   */
  public get bouncinessCombineRule(): CoefficientCombineRule {
    if (!this._requireNotRemoved('bouncinessCombineRule')) { return CoefficientCombineRule.Average; }

    return this._collider
      ? this._collider.restitutionCombineRule()
      : this._colliderDesc!.restitutionCombineRule;
  }

  /**
   * The collision groups the collider belongs to.
   *
   * **Category:** Physics
   */
  public get collisionGroups(): CollisionGroups {
    if (!this._requireNotRemoved('collisionGroups')) { return { belongsTo: [], collidesWith: [] }; }

    return this._collider
      ? CollisionGroupsBuilder.decodeRawCollisionGroups(this._collider.collisionGroups())
      : CollisionGroupsBuilder.decodeRawCollisionGroups(this._colliderDesc!.collisionGroups);
  }

  /**
   * The friction of the collider.
   *
   * **Category:** Physics
   */
  public get friction(): number {
    if (!this._requireNotRemoved('friction')) { return 0; }

    return this._collider
      ? this._collider.friction()
      : this._colliderDesc!.friction;
  }

  /**
   * The friction combine rule of the collider.
   *
   * **Category:** Physics
   */
  public get frictionCombineRule(): CoefficientCombineRule {
    if (!this._requireNotRemoved('frictionCombineRule')) { return CoefficientCombineRule.Average; }

    return this._collider
      ? this._collider.frictionCombineRule()
      : this._colliderDesc!.frictionCombineRule;
  }

  /**
   * Whether the collider is enabled.
   *
   * **Category:** Physics
   */
  public get isEnabled(): boolean {
    if (!this._requireNotRemoved('isEnabled')) { return false; }

    return this._collider
      ? this._collider.isEnabled()
      : this._colliderDesc!.enabled;
  }

  /**
   * Whether the collider has been removed from the simulation.
   *
   * **Category:** Physics
   */
  public get isRemoved(): boolean {
    return !this._collider && !this._colliderDesc;
  }

  /**
   * Whether the collider is a sensor.
   *
   * **Category:** Physics
   */
  public get isSensor(): boolean {   
    if (!this._requireNotRemoved('isSensor')) { return false; }

    return this._collider
      ? this._collider.isSensor()
      : this._colliderDesc!.isSensor;
  }

  /**
   * Whether the collider is simulated.
   *
   * **Category:** Physics
   */
  public get isSimulated(): boolean {   
    if (!this._requireNotRemoved('isSimulated')) { return false; }

    return !!this._collider;
  }

  /**
   * Whether the collider is a ball collider.
   *
   * **Category:** Physics
   */
  public get isBall(): boolean {
    return this.shape === ColliderShape.BALL;
  }

  /**
   * Whether the collider is a block collider.
   *
   * **Category:** Physics
   */
  public get isBlock(): boolean {
    return this.shape === ColliderShape.BLOCK;
  }

  /**
   * Whether the collider is a capsule collider.
   *
   * **Category:** Physics
   */
  public get isCapsule(): boolean {
    return this.shape === ColliderShape.CAPSULE;
  }

  /**
   * Whether the collider is a cone collider.
   *
   * **Category:** Physics
   */
  public get isCone(): boolean {
    return this.shape === ColliderShape.CONE;
  }

  /**
   * Whether the collider is a cylinder collider.
   *
   * **Category:** Physics
   */
  public get isCylinder(): boolean {
    return this.shape === ColliderShape.CYLINDER;
  }

  /**
   * Whether the collider is a none collider.
   *
   * **Category:** Physics
   */
  public get isNone(): boolean {
    return this.shape === ColliderShape.NONE;
  }

  /**
   * Whether the collider is a round cylinder collider.
   *
   * **Category:** Physics
   */
  public get isRoundCylinder(): boolean {
    return this.shape === ColliderShape.ROUND_CYLINDER;
  }

  /**
   * Whether the collider is a trimesh collider.
   *
   * **Category:** Physics
   */
  public get isTrimesh(): boolean {
    return this.shape === ColliderShape.TRIMESH;
  }

  /**
   * Whether the collider is a voxel collider.
   *
   * **Category:** Physics
   */
  public get isVoxel(): boolean {
    return this.shape === ColliderShape.VOXELS;
  }

  /**
   * Whether the collider is a wedge collider.
   *
   * **Category:** Physics
   */
  public get isWedge(): boolean {
    return this.shape === ColliderShape.WEDGE;
  }

  /**
   * The parent rigid body of the collider.
   *
   * **Category:** Physics
   */
  public get parentRigidBody(): RigidBody | undefined {   
    if (!this._requireNotRemoved('parentRigidBody')) { return undefined; }

    return this._parentRigidBody;
  }

  /**
   * The raw collider object from the Rapier physics engine.
   *
   * **Category:** Physics
   */
  public get rawCollider(): RawCollider | undefined {   
    if (!this._requireNotRemoved('rawCollider')) { return undefined; }

    return this._collider;
  }

  /**
   * The raw shape object from the Rapier physics engine.
   *
   * **Category:** Physics
   */
  public get rawShape(): RawShape | undefined {
    if (!this._requireNotRemoved('rawShape')) { return undefined; }

    return this._collider
      ? this._collider.shape
      : this._colliderDesc!.shape;
  }

  /**
   * The relative position of the collider to its parent rigid body.
   *
   * **Category:** Physics
   */
  public get relativePosition(): Vector3Like {
    if (!this._requireNotRemoved('relativePosition')) { return { x: 0, y: 0, z: 0 }; }

    return this._relativePosition;
  }

  /**
   * The relative rotation of the collider.
   *
   * **Category:** Physics
   */
  public get relativeRotation(): QuaternionLike {
    if (!this._requireNotRemoved('relativeRotation')) { return { x: 0, y: 0, z: 0, w: 1 }; }

    return this._relativeRotation;
  }

  /**
   * The scale of the collider.
   *
   * **Category:** Physics
   */
  public get scale(): Vector3Like {
    if (!this._requireNotRemoved('scale')) { return { x: 1, y: 1, z: 1 }; }

    return this._scale;
  }

  /**
   * The shape of the collider.
   *
   * **Category:** Physics
   */
  public get shape(): ColliderShape {
    if (!this._requireNotRemoved('shape')) { return ColliderShape.NONE; }

    return this._shape;
  }

  /**
   * An arbitrary identifier tag of the collider. Useful for your own logic.
   *
   * **Category:** Physics
   */
  public get tag(): string | undefined {   
    if (!this._requireNotRemoved('tag')) { return undefined; }

    return this._tag;
  }

  /*
   * Setters
   */

  /**
   * Sets the bounciness of the collider.
   * @param bounciness - The bounciness of the collider.
   *
   *
   * **Category:** Physics
   */
  public setBounciness(bounciness: number): void {
    if (!this._requireNotRemoved('setBounciness')) { return; }

    this._collider
      ? this._collider.setRestitution(bounciness)
      : this._colliderDesc!.setRestitution(bounciness);
  }

  /**
   * Sets the bounciness combine rule of the collider.
   * @param bouncinessCombineRule - The bounciness combine rule of the collider.
   *
   *
   * **Category:** Physics
   */
  public setBouncinessCombineRule(bouncinessCombineRule: CoefficientCombineRule): void {
    if (!this._requireNotRemoved('setBouncinessCombineRule')) { return; }

    this._collider
      ? this._collider.setRestitutionCombineRule(bouncinessCombineRule)
      : this._colliderDesc!.setRestitutionCombineRule(bouncinessCombineRule);
  }

  /**
   * Sets the collision groups of the collider.
   * @param collisionGroups - The collision groups of the collider.
   *
   *
   * **Category:** Physics
   */
  public setCollisionGroups(collisionGroups: CollisionGroups): void {
    if (!this._requireNotRemoved('setCollisionGroups')) { return; }
    
    const rawGroups = CollisionGroupsBuilder.buildRawCollisionGroups(collisionGroups);

    this._collider
      ? this._collider.setCollisionGroups(rawGroups)
      : this._colliderDesc!.setCollisionGroups(rawGroups);
  }

  /**
   * Sets whether the collider is enabled.
   * @param enabled - Whether the collider is enabled.
   *
   *
   * **Category:** Physics
   */
  public setEnabled(enabled: boolean): void {
    if (!this._requireNotRemoved('setEnabled')) { return; }

    this._collider
      ? this._collider.setEnabled(enabled)
      : this._colliderDesc!.setEnabled(enabled);
  }

  /**
   * Sets the friction of the collider.
   * @param friction - The friction of the collider.
   *
   *
   * **Category:** Physics
   */
  public setFriction(friction: number): void {
    if (!this._requireNotRemoved('setFriction')) { return; }

    this._collider
      ? this._collider.setFriction(friction)
      : this._colliderDesc!.setFriction(friction);
  }

  /**
   * Sets the friction combine rule of the collider.
   * @param frictionCombineRule - The friction combine rule of the collider.
   *
   *
   * **Category:** Physics
   */
  public setFrictionCombineRule(frictionCombineRule: CoefficientCombineRule): void {
    if (!this._requireNotRemoved('setFrictionCombineRule')) { return; }

    this._collider
      ? this._collider.setFrictionCombineRule(frictionCombineRule)
      : this._colliderDesc!.setFrictionCombineRule(frictionCombineRule);
  }

  /**
   * Sets the half extents of a simulated block collider.
   * @param halfExtents - The half extents of the block collider.
   *
   *
   * **Category:** Physics
   */
  public setHalfExtents(halfExtents: Vector3Like): void {
    if (!this._requireSimulated('setHalfExtents')) { return; }
    if (!this._requireNotRemoved('setHalfExtents')) { return; }

    if (this.shape !== ColliderShape.BLOCK) {
      return ErrorHandler.error('Collider.setHalfExtents(): Collider is not a block collider!');
    }

    this._collider!.setHalfExtents(halfExtents);
  }

  /**
   * Sets the half height of a simulated capsule, cone, cylinder, or round cylinder collider.
   * @param halfHeight - The half height of the capsule, cone, cylinder, or round cylinder collider.
   *
   *
   * **Category:** Physics
   */
  public setHalfHeight(halfHeight: number): void {
    if (!this._requireSimulated('setHalfHeight')) { return; }
    if (!this._requireNotRemoved('setHalfHeight')) { return; }

    if (
      this.shape !== ColliderShape.CAPSULE &&
      this.shape !== ColliderShape.CONE &&
      this.shape !== ColliderShape.CYLINDER &&
      this.shape !== ColliderShape.ROUND_CYLINDER
    ) {
      return ErrorHandler.error('Collider.setHalfHeight(): Collider is not a capsule, cone, cylinder, or round cylinder collider!');
    }

    this._collider!.setHalfHeight(halfHeight);
  }

  /**
   * Sets the mass of the collider.
   * @param mass - The mass of the collider.
   *
   *
   * **Category:** Physics
   */
  public setMass(mass: number): void {
    if (!this._requireNotRemoved('setMass')) { return; }

    this._collider
      ? this._collider.setMass(mass)
      : this._colliderDesc!.setMass(mass);
  }

  /**
   * Sets the on collision callback for the collider.
   *
   * @remarks
   * **Auto-enables events:** Automatically enables/disables collision events based on whether callback is set.
   *
   * @param callback - The on collision callback for the collider.
   *
   *
   * **Category:** Physics
   */
  public setOnCollision(callback: CollisionCallback | undefined): void {
    if (!this._requireNotRemoved('setOnCollision')) { return; }

    this._onCollision = callback;

    if (this.isSimulated) {
      this.enableCollisionEvents(!!callback);

      if (callback) {
        this._simulation!.colliderMap.setColliderCollisionCallback(this, callback);
      } else {
        this._simulation!.colliderMap.removeColliderCollisionCallback(this);
      }
    }
  }

  /**
   * Sets the radius of a simulated ball, capsule, cylinder, or round cylinder collider.
   * @param radius - The radius of the collider.
   *
   *
   * **Category:** Physics
   */
  public setRadius(radius: number): void {
    if (!this._requireSimulated('setRadius')) { return; }
    if (!this._requireNotRemoved('setRadius')) { return; }

    if (
      this.shape !== ColliderShape.BALL &&
      this.shape !== ColliderShape.CAPSULE &&
      this.shape !== ColliderShape.CYLINDER &&
      this.shape !== ColliderShape.ROUND_CYLINDER
    ) {
      return ErrorHandler.error('Collider.setRadius(): Collider is not a ball, capsule, cylinder, or round cylinder collider!');
    }
    
    this._collider!.setRadius(radius);
  }

  /**
   * Sets the relative rotation of the collider to its parent rigid body or the world origin.
   *
   * @remarks
   * Colliders can be added as a child of a rigid body, or to the world directly. This rotation
   * is relative to the parent rigid body or the world origin.
   *
   * @param rotation - The relative rotation of the collider.
   *
   *
   * **Category:** Physics
   */
  public setRelativeRotation(rotation: QuaternionLike): void {
    if (!this._requireNotRemoved('setRelativeRotation')) { return; }

    this._relativeRotation = rotation;

    this._collider
      ? this._collider.parent() ? this._collider.setRotationWrtParent(rotation) : this._collider.setRotation(rotation)
      : this._colliderDesc!.setRotation(rotation);
  }

  /**
   * Sets the position of the collider relative to its parent rigid body or the world origin.
   *
   * @remarks
   * Colliders can be added as a child of a rigid body, or to the world directly. This position
   * is relative to the parent rigid body or the world origin.
   *
   * @param position - The relative position of the collider.
   *
   *
   * **Category:** Physics
   */
  public setRelativePosition(position: Vector3Like): void {
    if (!this._requireNotRemoved('setRelativePosition')) { return; }

    this._relativePosition = position;

    this._collider
      ? this._collider.parent() ? this._collider.setTranslationWrtParent(position) : this._collider.setTranslation(position)
      : this._colliderDesc!.setTranslation(position.x, position.y, position.z);
  }

  /**
   * Sets whether the collider is a sensor.
   * @param sensor - Whether the collider is a sensor.
   *
   *
   * **Category:** Physics
   */
  public setSensor(sensor: boolean): void {
    if (!this._requireNotRemoved('setSensor')) { return; }

    this._collider
      ? this._collider.setSensor(sensor)
      : this._colliderDesc!.setSensor(sensor);
  }

  /**
   * Sets the tag of the collider.
   * @param tag - The tag of the collider.
   *
   *
   * **Category:** Physics
   */
  public setTag(tag: string): void {
    if (!this._requireNotRemoved('setTag')) { return; }

    this._tag = tag;
  }

  /**
   * Sets the voxel at the given coordinate as filled or not filled.
   * @param coordinate - The coordinate of the voxel to set.
   * @param filled - True if the voxel at the coordinate should be filled, false if it should be removed.
   *
   *
   * **Category:** Physics
   */
  public setVoxel(coordinate: Vector3Like, filled: boolean) {
    if (!this._requireNotRemoved('setVoxel')) { return; }
    if (!this._requireSimulated('setVoxel')) { return; }

    if (this.shape !== ColliderShape.VOXELS) {
      return ErrorHandler.error('Collider.setVoxel(): Collider is not a voxels collider!');
    }

    this._collider!.setVoxel(coordinate.x, coordinate.y, coordinate.z, filled);
  }

  /*
   * Other Methods
   */

  /**
   * Adds the collider to the simulation.
   *
   * @remarks
   * **Parent linking:** Links the collider to the parent rigid body if provided.
   *
   * **Collision callback:** Applies any configured `onCollision` callback.
   *
   * @param simulation - The simulation to add the collider to.
   * @param parentRigidBody - The parent rigid body of the collider.
   *
   * **Category:** Physics
   */
  public addToSimulation(simulation: Simulation, parentRigidBody?: RigidBody): void {
    if (!this._requireNotRemoved('addToSimulation')) {
      return;
    }
    
    if (!this._requireUnsimulated('addToSimulation')) {
      return;
    }

    if (parentRigidBody) {
      if (!parentRigidBody.isSimulated) {
        return ErrorHandler.error('Collider.addToSimulation(): Rigid body must be simulated before adding a collider to it!');
      }

      if (parentRigidBody.type === RigidBodyType.DYNAMIC && this.shape === ColliderShape.TRIMESH) {
        ErrorHandler.warning('Collider.addToSimulation(): Trimesh colliders are strongly discouraged to be used with dynamic rigid bodies, they will not contribute any mass!');
      }
    }

    this._simulation = simulation; 
    this._parentRigidBody = parentRigidBody;
    this._collider = this._simulation.createRawCollider(this._colliderDesc!, parentRigidBody?.rawRigidBody);
    this._colliderDesc = undefined;

    if (parentRigidBody) {
      parentRigidBody.linkCollider(this);
    }
    
    if (this._onCollision) {
      this.setOnCollision(this._onCollision);
    }
  }

  /**
   * @internal
   */
  public combineVoxelStates(otherVoxelsCollider: Collider): void {
    if (!this._requireNotRemoved('combineVoxelStates')) { return; }
    if (!this._requireSimulated('combineVoxelStates')) { return; }
    
    if (!otherVoxelsCollider.isSimulated) {
      return ErrorHandler.error('Collider.combineVoxelStates(): Other collider is not simulated!');
    }

    if (this.shape !== ColliderShape.VOXELS) {
      return ErrorHandler.error('Collider.combineVoxelStates(): Collider is not a voxels collider!');
    }

    if (otherVoxelsCollider.shape !== ColliderShape.VOXELS) {
      return ErrorHandler.error('Collider.combineVoxelStates(): Other collider is not a voxels collider!');
    }

    // This is a rapier internal requirement with the voxels collider implementation.
    // We must combine voxel states of voxel colliders with intersection domains to 
    // prevent internal edges of transitioning faces between blocks from being an issue.
    // We should only call combineVoxelStates once between a given collider and another collider.
    // It can be called in either relationship direction, but only once.
    this._collider!.combineVoxelStates(otherVoxelsCollider.rawCollider!, 0, 0, 0);
  }

  /**
   * Enables or disables collision events for the collider.
   * This is automatically enabled if an on collision callback is set.
   * @param enabled - Whether collision events are enabled.
   *
   *
   * **Category:** Physics
   */
  public enableCollisionEvents(enabled: boolean): void {
    if (!this._requireNotRemoved('enableCollisionEvents')) {
      return;
    }

    const currentEvents = this._collider
      ? this._collider.activeEvents()
      : this._colliderDesc!.activeEvents;

    const newEvents = enabled
      ? currentEvents | RAPIER.ActiveEvents.COLLISION_EVENTS
      : currentEvents & ~RAPIER.ActiveEvents.COLLISION_EVENTS;

    (this._collider ?? this._colliderDesc)!.setActiveEvents(newEvents);
    
    this._setActiveCollisionTypes();
  }

  /**
   * Enables or disables contact force events for the collider.
   * This is automatically enabled if an on contact force callback is set.
   * @param enabled - Whether contact force events are enabled.
   *
   *
   * **Category:** Physics
   */
  public enableContactForceEvents(enabled: boolean): void {
    if (!this._requireNotRemoved('enableContactForceEvents')) {
      return;
    }

    const currentEvents = this._collider
      ? this._collider.activeEvents()
      : this._colliderDesc!.activeEvents;

    const newEvents = enabled
      ? currentEvents | RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS
      : currentEvents & ~RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS;

    (this._collider ?? this._colliderDesc)!.setActiveEvents(newEvents);
    
    this._setActiveCollisionTypes();
  }



  /**
   * Removes the collider from the simulation.
   *
   * @remarks
   * **Parent unlinking:** Unlinks from parent rigid body if attached.
   *
   * **Side effects:** Removes the collider from the simulation and unlinks it from any parent rigid body.
   *
   * **Category:** Physics
   */
  public removeFromSimulation(): void {
    if (!this._requireNotRemoved('removeFromSimulation')) {
      return;
    }
    
    if (!this._requireSimulated('removeFromSimulation')) {
      return;
    }

    this._simulation!.removeRawCollider(this._collider!);

    this._simulation = undefined;
    this._collider = undefined;

    if (this._parentRigidBody) {
      this._parentRigidBody.unlinkCollider(this);
    }

    this._parentRigidBody = undefined;
  }

  /**
   * Scales the collider by the given scalar. Only
   * ball, block, capsule, cone, cylinder, round cylinder
   * are supported.
   *
   * @remarks
   * **Ratio-based:** Uses ratio-based scaling relative to current scale, not absolute dimensions.
   * Also scales `relativePosition` proportionally.
   *
   * @param scalar - The scalar to scale the collider by.
   *
   *
   * **Category:** Physics
   */
  public setScale(scale: Vector3Like): void {
    if (!this._requireNotRemoved('scale')) { return; }

    // Calculate incremental scalar (delta) from current to new scale.
    // This converts absolute scale to a multiplier for current dimensions.
    const adjustedScale = {
      x: scale.x / this._scale.x,
      y: scale.y / this._scale.y,
      z: scale.z / this._scale.z,
    };
    
    this.setRelativePosition({
      x: this.relativePosition.x * adjustedScale.x,
      y: this.relativePosition.y * adjustedScale.y,
      z: this.relativePosition.z * adjustedScale.z,
    });
    
    // For round shapes (ball, capsule, cylinder, etc.), calculate the horizontal scaling
    // factor from absolute scales (not deltas) to handle non-uniform scaling correctly.
    // This ensures radius scales properly when max(x,z) changes direction (e.g., x→z dominant).
    const currentHorizontalScale = Math.max(this._scale.x, this._scale.z);
    const newHorizontalScale = Math.max(scale.x, scale.z);
    const horizontalScalar = newHorizontalScale / currentHorizontalScale;
    
    this._scale = scale;

    switch (this._shape) {
      case ColliderShape.BALL: {
        if (this._collider) {
          this._collider.setRadius(this._collider.radius() * horizontalScalar);
        } else {
          (this._colliderDesc!.shape as RAPIER.Ball).radius *= horizontalScalar;
        }

        return;
      }
      case ColliderShape.BLOCK: {
        if (this._collider) {
          const halfExtents = this._collider.halfExtents();
          this._collider.setHalfExtents({
            x: halfExtents.x * adjustedScale.x,
            y: halfExtents.y * adjustedScale.y,
            z: halfExtents.z * adjustedScale.z,
          });
        } else {
          (this._colliderDesc!.shape as RAPIER.Cuboid).halfExtents.x *= adjustedScale.x;
          (this._colliderDesc!.shape as RAPIER.Cuboid).halfExtents.y *= adjustedScale.y;
          (this._colliderDesc!.shape as RAPIER.Cuboid).halfExtents.z *= adjustedScale.z;
        }

        return;
      }
      case ColliderShape.CAPSULE: {
        if (this._collider) {
          this._collider.setHalfHeight(this._collider.halfHeight() * adjustedScale.y);
          this._collider.setRadius(this._collider.radius() * horizontalScalar);
        }
        else {
          (this._colliderDesc!.shape as RAPIER.Capsule).halfHeight *= adjustedScale.y;
          (this._colliderDesc!.shape as RAPIER.Capsule).radius *= horizontalScalar;
        }

        return;
      }
      case ColliderShape.CONE: {
        if (this._collider) {
          this._collider.setHalfHeight(this._collider.halfHeight() * adjustedScale.y);
          this._collider.setRadius(this._collider.radius() * horizontalScalar);
        }
        else {
          (this._colliderDesc!.shape as RAPIER.Cone).halfHeight *= adjustedScale.y;
          (this._colliderDesc!.shape as RAPIER.Cone).radius *= horizontalScalar;
        }

        return;
      }
      case ColliderShape.CYLINDER: {
        if (this._collider) {
          this._collider.setHalfHeight(this._collider.halfHeight() * adjustedScale.y);
          this._collider.setRadius(this._collider.radius() * horizontalScalar);
        }
        else {
          (this._colliderDesc!.shape as RAPIER.Cylinder).halfHeight *= adjustedScale.y;
          (this._colliderDesc!.shape as RAPIER.Cylinder).radius *= horizontalScalar;
        }

        return;
      }
      case ColliderShape.ROUND_CYLINDER: {
        if (this._collider) {
          this._collider.setHalfHeight(this._collider.halfHeight() * adjustedScale.y);
          this._collider.setRoundRadius(this._collider.roundRadius() * horizontalScalar);
          this._collider.setRadius(this._collider.radius() * horizontalScalar);
        }
        else {
          (this._colliderDesc!.shape as RAPIER.RoundCylinder).halfHeight = (this._colliderDesc!.shape as RAPIER.RoundCylinder).halfHeight * adjustedScale.y;
          (this._colliderDesc!.shape as RAPIER.RoundCylinder).borderRadius = (this._colliderDesc!.shape as RAPIER.RoundCylinder).borderRadius * horizontalScalar;
          (this._colliderDesc!.shape as RAPIER.RoundCylinder).radius = (this._colliderDesc!.shape as RAPIER.RoundCylinder).radius * horizontalScalar;
        }

        return;
      }
      case ColliderShape.TRIMESH: {
        ErrorHandler.error('Collider.setScale(): Trimesh colliders cannot be scaled at runtime!');

        return;
      }
      case ColliderShape.VOXELS: {
        ErrorHandler.error('Collider.setScale(): Voxels colliders cannot be scaled!');

        return;
      }
      case ColliderShape.WEDGE: {
        ErrorHandler.error('Collider.setScale(): Wedge colliders cannot be scaled!');

        return;
      }
      default: {
        ErrorHandler.fatalError(`Collider.setScale(): ${this._shape} is not a valid collider shape!`);
      }
    }
  }

  /*
   * Helpers
   */

  /**
   * @internal
   */
  private _applyColliderOptions(options: ColliderOptions): void {
    const setters: Array<[keyof ColliderOptions, (value: any) => void]> = [
      [ 'bounciness', this.setBounciness.bind(this) ],
      [ 'bouncinessCombineRule', this.setBouncinessCombineRule.bind(this) ],
      [ 'collisionGroups', this.setCollisionGroups.bind(this) ],
      [ 'enabled', this.setEnabled.bind(this) ],
      [ 'friction', this.setFriction.bind(this) ],
      [ 'frictionCombineRule', this.setFrictionCombineRule.bind(this) ],
      [ 'isSensor', this.setSensor.bind(this) ],
      [ 'mass', this.setMass.bind(this) ],
      [ 'onCollision', this.setOnCollision.bind(this) ],
      [ 'relativePosition', this.setRelativePosition.bind(this) ],
      [ 'relativeRotation', this.setRelativeRotation.bind(this) ],
      [ 'tag', this.setTag.bind(this) ],
    ];

    setters.forEach(([ key, setter ]) => {
      if (options[key] !== undefined) {
        setter.call(this, options[key]);
      }
    });
  }

  /**
   * @internal
   */
  private _autoAddToSimulation(options: ColliderOptions): void {
    if (options.simulation) {
      this.addToSimulation(options.simulation, options.parentRigidBody);
    }
  }

  private _buildWedgeConvexHullVertices(extents: Vector3Like): Float32Array {
    const { x: width, y: height, z: length } = extents;
    const halfWidth = width / 2;
    const halfLength = length / 2;
    const halfHeight = height / 2; // Center based on AABB height

    return new Float32Array([
      -halfWidth, 0 - halfHeight, -halfLength,      // v0: bottom left back
      halfWidth, 0 - halfHeight, -halfLength,       // v1: bottom right back
      halfWidth, 0 - halfHeight,  halfLength,       // v2: bottom right front
      -halfWidth, 0 - halfHeight,  halfLength,      // v3: bottom left front
      -halfWidth, height - halfHeight, -halfLength, // v4: top left back
      halfWidth, height - halfHeight, -halfLength,  // v5: top right back
    ]);
  }

  /**
   * @internal
   */
  private _createColliderDesc(colliderOptions: ColliderOptions): RAPIER.ColliderDesc {
    const { shape, flags } = colliderOptions;

    switch (shape) {
      case ColliderShape.BALL: {
        if (!colliderOptions.radius) ErrorHandler.fatalError('Ball collider must have a radius!');
        
        return RAPIER.ColliderDesc.ball(colliderOptions.radius);
      }
      case ColliderShape.BLOCK: {
        if (!colliderOptions.halfExtents) ErrorHandler.fatalError('Block collider must have halfExtents!');
        
        return RAPIER.ColliderDesc.cuboid(colliderOptions.halfExtents.x, colliderOptions.halfExtents.y, colliderOptions.halfExtents.z);
      }
      case ColliderShape.CAPSULE: {
        if (!colliderOptions.halfHeight || !colliderOptions.radius) ErrorHandler.fatalError('Capsule collider must have halfHeight and radius!');
        
        return RAPIER.ColliderDesc.capsule(colliderOptions.halfHeight, colliderOptions.radius);
      }
      case ColliderShape.CONE: {
        if (!colliderOptions.radius || !colliderOptions.halfHeight) ErrorHandler.fatalError('Cone collider must have radius and halfHeight!');
        
        return RAPIER.ColliderDesc.cone(colliderOptions.halfHeight, colliderOptions.radius);
      }
      case ColliderShape.CYLINDER: {
        if (!colliderOptions.radius || !colliderOptions.halfHeight) ErrorHandler.fatalError('Cylinder collider must have radius and halfHeight!');
        
        return RAPIER.ColliderDesc.cylinder(colliderOptions.halfHeight, colliderOptions.radius);
      }
      case ColliderShape.ROUND_CYLINDER: {
        if (!colliderOptions.radius || !colliderOptions.halfHeight || !colliderOptions.borderRadius) ErrorHandler.fatalError('Round cylinder collider must have radius, halfHeight, and borderRadius!');
        
        return RAPIER.ColliderDesc.roundCylinder(colliderOptions.halfHeight, colliderOptions.radius, colliderOptions.borderRadius);
      }
      case ColliderShape.TRIMESH: {
        if (!colliderOptions.indices || !colliderOptions.vertices) ErrorHandler.fatalError('Trimesh collider must have vertices and indices!');

        return RAPIER.ColliderDesc.trimesh(colliderOptions.vertices, colliderOptions.indices, flags);
      }
      case ColliderShape.VOXELS: {
        if (!colliderOptions.coordinates || !colliderOptions.size) ErrorHandler.fatalError('Voxels collider must have coordinates and size!');

        return RAPIER.ColliderDesc.voxels(this._coordinatesToInt32Array(colliderOptions.coordinates), colliderOptions.size);
      }
      case ColliderShape.WEDGE: {
        if (!colliderOptions.extents) ErrorHandler.fatalError('Wedge collider must have extents!');
        
        // Vertices are now pre-centered based on AABB
        const vertices = this._buildWedgeConvexHullVertices(colliderOptions.extents);
        const desc = RAPIER.ColliderDesc.convexHull(vertices);

        if (!desc) {
          ErrorHandler.fatalError('Failed to create convex hull for wedge collider!');
          throw new Error('Convex hull creation failed'); 
        }

        return desc;
      }
      default: {
        ErrorHandler.fatalError(`Collider._createColliderDesc(): ${shape} is not a valid collider shape!`);
      }
    }
  }

  /**
   * @internal
   */
  private _requireSimulated(methodName: string): boolean {
    if (!this.isSimulated) {
      ErrorHandler.error(`Collider._requireSimulated(): Collider is not simulated, invoked method: ${methodName}()`);
    }

    return this.isSimulated;
  }

  /**
   * @internal
   */
  private _requireUnsimulated(methodName: string): boolean {
    if (this.isSimulated) {
      ErrorHandler.error(`Collider._requireUnsimulated(): Collider is already simulated, invoked method: ${methodName}()`);
    }

    return !this.isSimulated;
  }

  /**
   * @internal
   */
  private _requireNotRemoved(methodName: string): boolean {
    if (this.isRemoved) {
      ErrorHandler.error(`Collider._requireNotRemoved(): Collider is removed, invoked method: ${methodName}()`);
    }

    return !this.isRemoved;
  }

  /**
   * @internal
   */
  private _setActiveCollisionTypes(): void {
    (this._collider ?? this._colliderDesc)!.setActiveCollisionTypes(
      RAPIER.ActiveCollisionTypes.DYNAMIC_DYNAMIC |
      RAPIER.ActiveCollisionTypes.DYNAMIC_KINEMATIC |
      RAPIER.ActiveCollisionTypes.DYNAMIC_FIXED |
      RAPIER.ActiveCollisionTypes.KINEMATIC_KINEMATIC |
      RAPIER.ActiveCollisionTypes.KINEMATIC_FIXED,
    );
  }

  /**
   * @internal
   */
  private _coordinatesToInt32Array(coordinates: Vector3Like[]): Int32Array {
    const int32Array = new Int32Array(coordinates.length * 3);

    for (let i = 0; i < coordinates.length; i++) {
      const coordinate = coordinates[i];
      const baseIndex = i * 3;

      int32Array[baseIndex] = Math.floor(coordinate.x);
      int32Array[baseIndex + 1] = Math.floor(coordinate.y);
      int32Array[baseIndex + 2] = Math.floor(coordinate.z);
    }

    return int32Array;
  }
}
