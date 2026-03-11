import RAPIER from '@dimforge/rapier3d-simd-compat';
import Block from '@/worlds/blocks/Block';
import BlockType from '@/worlds/blocks/BlockType';
import ColliderMap from '@/worlds/physics/ColliderMap';
import Entity from '@/worlds/entities/Entity';
import EventRouter from '@/events/EventRouter';
import Telemetry, { TelemetrySpanOperation } from '@/metrics/Telemetry';
import { BlockTypeEvent } from '@/worlds/blocks/BlockType';
import { EntityEvent } from '@/worlds/entities/Entity';
import type { CollisionObject } from '@/worlds/physics/ColliderMap';
import type QuaternionLike from '@/shared/types/math/QuaternionLike';
import type { RawCollider, RawShape } from '@/worlds/physics/Collider';
import type Vector3Like from '@/shared/types/math/Vector3Like';
import type World from '@/worlds/World';

/**
 * The default gravity for the simulation.
 *
 * **Category:** Physics
 * @public
 */
export const DEFAULT_GRAVITY = { x: 0, y: -32, z: 0 } as const; // -32 is minecraft-like gravity

/**
 * The default tick rate for the simulation.
 *
 * **Category:** Physics
 * @public
 */
export const DEFAULT_TICK_RATE = 60; // per second

/**
 * Data for contact forces.
 *
 * **Category:** Physics
 * @public
 */
export type ContactForceData = {
  /** The total force vector. */
  totalForce: RAPIER.Vector;

  /** The magnitude of the total force. */
  totalForceMagnitude: number;

  /** The direction of the maximum force. */
  maxForceDirection: RAPIER.Vector;

  /** The magnitude of the maximum force. */
  maxForceMagnitude: number;
}

/**
 * A contact manifold.
 *
 * **Category:** Physics
 * @public
 */
export type ContactManifold = {
  /** The contact points as global coordinates. */
  contactPoints: Vector3Like[];
  
  /** The local normal vector of the first collider. */
  localNormalA: Vector3Like;
  
  /** The local normal vector of the second collider. */
  localNormalB: Vector3Like;

  /** The normal vector of the contact. */
  normal: Vector3Like;
}

/**
 * Filter options for raycasting and intersection queries.
 *
 * Use for: scoping physics queries to specific colliders or groups.
 * Do NOT use for: persistent collision configuration; use `CollisionGroupsBuilder`.
 *
 * **Category:** Physics
 * @public
 */
export type FilterOptions = {
  /** The query filter flags. */
  filterFlags?: RAPIER.QueryFilterFlags;

  /** The collision group to filter by. */
  filterGroups?: number;

  /** The collider to exclude. */
  filterExcludeCollider?: RawCollider;

  /** The rigid body to exclude. */
  filterExcludeRigidBody?: RAPIER.RigidBody;

  /** The predicate to filter by. */
  filterPredicate?: (collider: RawCollider) => boolean;
}

/**
 * An intersection result.
 *
 * **Category:** Physics
 * @public
 */
export type IntersectionResult = {
  /** The block type that was intersected. */
  intersectedBlockType?: BlockType,
  
  /** The entity that was intersected. */
  intersectedEntity?: Entity,
}

/**
 * A hit result from a raycast.
 *
 * **Category:** Physics
 * @public
 */
export type RaycastHit = {
  /** The block the raycast hit. */
  hitBlock?: Block,

  /** The entity the raycast hit */
  hitEntity?: Entity,

  /** The point in global coordinate space the raycast hit the object. */
  hitPoint: Vector3Like,

  /** The distance from origin where the raycast hit. */
  hitDistance: number,

  /** The origin of the raycast. */
  origin: Vector3Like,

  /** The direction of the raycast from the origin. */
  originDirection: Vector3Like,
}

// TODO: Clean this up to hide RAPIER types from the public API.
/**
 * Options for raycasting.
 *
 * Use for: configuring `Simulation.raycast` calls.
 * Do NOT use for: caching long-term query state; build per query.
 *
 * **Category:** Physics
 * @public
 */
export type RaycastOptions = {
  /** Whether to use solid mode for the raycast, defaults to true. */
  solidMode?: boolean;
} & FilterOptions;

/**
 * Event types a Simulation instance can emit.
 *
 * See `SimulationEventPayloads` for the payloads.
 *
 * **Category:** Events
 * @public
 */
export enum SimulationEvent {
  STEP_START    = 'SIMULATION.STEP_START',
  STEP_END      = 'SIMULATION.STEP_END',
  DEBUG_RAYCAST = 'SIMULATION.DEBUG_RAYCAST',
  DEBUG_RENDER  = 'SIMULATION.DEBUG_RENDER',
}

/**
 * Event payloads for Simulation emitted events.
 *
 * **Category:** Events
 * @public
 */
export interface SimulationEventPayloads {
  /** Emitted when the simulation step starts. */
  [SimulationEvent.STEP_START]:    { simulation: Simulation, tickDeltaMs: number };

  /** Emitted when the simulation step ends. */
  [SimulationEvent.STEP_END]:      { simulation: Simulation, stepDurationMs: number };

  /** Emitted when a debug raycast is performed. */
  [SimulationEvent.DEBUG_RAYCAST]: { simulation: Simulation, origin: Vector3Like, direction: Vector3Like, length: number, hit: boolean };

  /** Emitted when the simulation debug rendering is enabled. */
  [SimulationEvent.DEBUG_RENDER]:  { simulation: Simulation, vertices: Float32Array, colors: Float32Array };
}

/**
 * Represents the physics simulation for a world.
 *
 * When to use: advanced physics queries, custom gravity, or debug rendering.
 * Do NOT use for: typical movement; use entity/rigid body APIs instead.
 *
 * @remarks
 * Access via `World.simulation`. The simulation drives all collision and contact
 * events for blocks and entities.
 *
 * <h2>Events</h2>
 *
 * This class is an EventRouter, and instances of it emit events with payloads listed under
 * `SimulationEventPayloads`.
 *
 * **Category:** Physics
 * @public
 */
export default class Simulation extends EventRouter {
  /** @internal */
  private _colliderMap: ColliderMap = new ColliderMap();

  /** @internal */
  private _debugRaycastingEnabled: boolean = false;

  /** @internal */
  private _debugRenderingEnabled: boolean = false;

  /** @internal */
  private _debugRenderingFilterFlags: RAPIER.QueryFilterFlags | undefined;

  /** @internal */
  private _rapierEventQueue: RAPIER.EventQueue;

  /** @internal */
  private _rapierSimulation: RAPIER.World;

  /** @internal */
  private _world: World;

  /** @internal */
  constructor(world: World, tickRate: number = DEFAULT_TICK_RATE, gravity: RAPIER.Vector3 = DEFAULT_GRAVITY) {
    super();

    this._rapierEventQueue = new RAPIER.EventQueue(true);
    this._rapierSimulation = new RAPIER.World(gravity);
    this._rapierSimulation.timestep = Math.fround(1 / tickRate);
    this._world = world;
  }

  /** @internal */
  public get colliderMap(): ColliderMap { return this._colliderMap; }

  /**
   * Whether debug raycasting is enabled.
   *
   * **Category:** Physics
   */
  public get isDebugRaycastingEnabled(): boolean { return this._debugRaycastingEnabled; }

  /**
   * Whether debug rendering is enabled.
   *
   * **Category:** Physics
   */
  public get isDebugRenderingEnabled(): boolean { return this._debugRenderingEnabled; }

  /**
   * The gravity vector for the simulation.
   *
   * **Category:** Physics
   */
  public get gravity(): RAPIER.Vector3 { return this._rapierSimulation.gravity; }

  /**
   * The fixed timestep for the simulation.
   *
   * **Category:** Physics
   */
  public get timestepS(): number { return this._rapierSimulation.timestep; }

  /**
   * The world this simulation belongs to.
   *
   * **Category:** Physics
   */
  public get world(): World { return this._world; }

  /** @internal */
  public createRawCollider(rawColliderDesc: RAPIER.ColliderDesc, rawParent?: RAPIER.RigidBody): RawCollider {
    return this._rapierSimulation.createCollider(rawColliderDesc, rawParent);
  }
  
  /** @internal */
  public createRawRigidBody(rawRigidBodyDesc: RAPIER.RigidBodyDesc): RAPIER.RigidBody {
    return this._rapierSimulation.createRigidBody(rawRigidBodyDesc);
  }

  /**
   * Enables or disables debug raycasting for the simulation.
   *
   * @remarks
   * When enabled, raycasts emit `SimulationEvent.DEBUG_RAYCAST` for visualization.
   *
   * @param enabled - Whether to enable debug raycasting.
   *
   * **Side effects:** Emits debug raycast events when `Simulation.raycast` is called.
   *
   * **Category:** Physics
   */
  public enableDebugRaycasting(enabled: boolean) {
    this._debugRaycastingEnabled = enabled;
  }

  /**
   * Enables or disables debug rendering for the simulation.
   *
   * @remarks
   * When enabled, all colliders and rigid body outlines are rendered.
   * Avoid enabling in production; it can cause noticeable lag.
   *
   * @param enabled - Whether to enable debug rendering.
   * @param filterFlags - Optional query filter flags for debug rendering.
   *
   * **Side effects:** Emits `SimulationEvent.DEBUG_RENDER` each step while enabled.
   *
   * **Category:** Physics
   */
  public enableDebugRendering(enabled: boolean, filterFlags: RAPIER.QueryFilterFlags = RAPIER.QueryFilterFlags.EXCLUDE_FIXED) {
    this._debugRenderingEnabled = enabled;
    this._debugRenderingFilterFlags = filterFlags;
  }

  /**
   * Gets the contact manifolds for a pair of colliders.
   *
   * @remarks
   * Returns an empty array for sensor contacts (sensors do not generate manifolds).
   *
   * @param colliderHandleA - The handle of the first collider.
   * @param colliderHandleB - The handle of the second collider.
   * @returns The contact manifolds, or an empty array if no contact.
   *
   * **Category:** Physics
   */
  public getContactManifolds(colliderHandleA: RAPIER.ColliderHandle, colliderHandleB: RAPIER.ColliderHandle): ContactManifold[] {
    this._flushPendingTerrainColliders();
    const contactManifolds: ContactManifold[] = [];
    
    this._rapierSimulation.narrowPhase.contactPair(colliderHandleA, colliderHandleB, (manifold, flipped) => {
      if (manifold.numContacts() === 0) return;

      const normal = manifold.normal();
      const contactPoints = [];

      for (let i = 0; i < manifold.numSolverContacts(); i++) {
        contactPoints.push(manifold.solverContactPoint(i));
      }

      contactManifolds.push({
        contactPoints,
        localNormalA: !flipped ? manifold.localNormal1() : manifold.localNormal2(),
        localNormalB: !flipped ? manifold.localNormal2() : manifold.localNormal1(),
        normal: !flipped ? normal : { x: -normal.x, y: -normal.y, z: -normal.z },
      });
    });

    return contactManifolds;
  }

  /**
   * Gets the intersections with a raw shape.
   *
   * @remarks
   * `rawShape` can be retrieved from a simulated or unsimulated collider using
   * `Collider.rawShape`.
   *
   * @param rawShape - The raw shape to get intersections with.
   * @param position - The position of the shape.
   * @param rotation - The rotation of the shape.
   * @param options - The options for the intersections.
   * @returns The intersections.
   *
   * **Category:** Physics
   */
  public intersectionsWithRawShape(rawShape: RawShape, position: Vector3Like, rotation: QuaternionLike, options: FilterOptions = {}): IntersectionResult[] {
    this._flushPendingTerrainColliders();
    const intersectionDeduplicationSet = new Set<any>(); // prevent returning duplicates such as for multiple colliders of the same entity, etc.
    const intersectionResults: IntersectionResult[] = [];

    this._rapierSimulation.intersectionsWithShape(
      position,
      rotation,
      rawShape,
      intersectedCollider => {
        const collidedBlockType = this._colliderMap.getColliderHandleBlockType(intersectedCollider.handle);
        if (collidedBlockType && !intersectionDeduplicationSet.has(collidedBlockType)) {
          intersectionDeduplicationSet.add(collidedBlockType);
          intersectionResults.push({ intersectedBlockType: collidedBlockType });

          return true;
        }

        const collidedEntity = this._colliderMap.getColliderHandleEntity(intersectedCollider.handle);
        if (collidedEntity && !intersectionDeduplicationSet.has(collidedEntity)) {
          intersectionDeduplicationSet.add(collidedEntity);
          intersectionResults.push({ intersectedEntity: collidedEntity });

          return true;
        }

        return true;
      },
      options.filterFlags,
      options.filterGroups,
      options.filterExcludeCollider,
      options.filterExcludeRigidBody,
      options.filterPredicate,
    );

    return intersectionResults;
  }

  /**
   * Casts a ray through the simulation and returns the first hit.
   *
   * @remarks
   * The ray stops at the first block or entity hit within the length of the ray.
   *
   * @param origin - The origin of the ray.
   * @param direction - The direction of the ray.
   * @param length - The length of the ray.
   * @param options - The options for the raycast.
   * @returns A RaycastHit object containing the first block or entity hit by the ray, or null if no hit.
   *
   * **Category:** Physics
   */
  public raycast(origin: RAPIER.Vector3, direction: RAPIER.Vector3, length: number, options: RaycastOptions = {}): RaycastHit | null {
    this._flushPendingTerrainColliders();
    const ray = new RAPIER.Ray(origin, direction);
    const rayColliderHit = this._rapierSimulation.castRay(
      ray,
      length,
      options.solidMode ?? true,
      options.filterFlags,
      options.filterGroups,
      options.filterExcludeCollider,
      options.filterExcludeRigidBody,
      options.filterPredicate,
    );

    if (this._debugRaycastingEnabled) {
      this.emitWithWorld(this._world, SimulationEvent.DEBUG_RAYCAST, {
        simulation: this,
        origin,
        direction,
        length,
        hit: !!rayColliderHit,
      });
    }

    if (!rayColliderHit) return null;

    const hitPoint = ray.pointAt(rayColliderHit.timeOfImpact);
    const hitDistance = rayColliderHit.timeOfImpact;
    const collider = rayColliderHit.collider;
    
    const collidedBlockType = this._colliderMap.getColliderHandleBlockType(collider.handle);

    if (collidedBlockType) {
      const epsilon = 1e-4; // Small value to account for floating-point precision

      // We subtract/add epsilon from the hit point based on ray direction to 
      // ensure we get the correct block when the ray hits exactly on a 
      // block boundary. Without this, floating point precision issues could
      // cause us to get the wrong block.
      const hitBlock = Block.fromGlobalCoordinate({
        x: Math.floor(hitPoint.x - (ray.dir.x < 0 ? epsilon : -epsilon)),
        y: Math.floor(hitPoint.y - (ray.dir.y < 0 ? epsilon : -epsilon)),
        z: Math.floor(hitPoint.z - (ray.dir.z < 0 ? epsilon : -epsilon)),
      }, collidedBlockType);

      return {
        hitBlock,
        hitPoint,
        hitDistance,
        origin,
        originDirection: direction,
      };
    }

    const hitEntity = this._colliderMap.getColliderHandleEntity(collider.handle);

    if (hitEntity) {
      return {
        hitEntity,
        hitPoint,
        hitDistance,
        origin,
        originDirection: direction,
      };
    }

    return null;
  }

  /** @internal */
  public removeRawCollider(rawCollider: RawCollider) {
    this._colliderMap.queueColliderHandleForCleanup(rawCollider.handle);
    this._rapierSimulation.removeCollider(rawCollider, false);
  }

  /** @internal */
  public removeRawRigidBody(rawRigidBody: RAPIER.RigidBody) {
    this._rapierSimulation.removeRigidBody(rawRigidBody);
  }

  /**
   * Sets the gravity vector for the simulation.
   *
   * @param gravity - The gravity vector.
   *
   * **Side effects:** Changes gravity for all simulated rigid bodies.
   *
   * **Category:** Physics
   */
  public setGravity(gravity: RAPIER.Vector3) {
    this._rapierSimulation.gravity = gravity;
  }

  /** @internal */
  public step = (tickDeltaMs: number): void => {
    this._flushPendingTerrainColliders();
    this.emitWithWorld(this._world, SimulationEvent.STEP_START, {
      simulation: this,
      tickDeltaMs,
    });

    const stepStart = performance.now();

    Telemetry.startSpan({ operation: TelemetrySpanOperation.PHYSICS_STEP }, () => {
      this._rapierSimulation.step(this._rapierEventQueue);
    });

    Telemetry.startSpan({ operation: TelemetrySpanOperation.PHYSICS_CLEANUP }, () => {
      this._rapierEventQueue.drainContactForceEvents(this._onContactForceEvent);
      this._rapierEventQueue.drainCollisionEvents(this._onCollisionEvent);
      this._colliderMap.cleanup();
    });
    
    this.emitWithWorld(this._world, SimulationEvent.STEP_END, {
      simulation: this,
      stepDurationMs: performance.now() - stepStart,
    });

    if (this._debugRenderingEnabled) {
      this.emitWithWorld(this._world, SimulationEvent.DEBUG_RENDER, {
        simulation: this,
        ...this._rapierSimulation.debugRender(this._debugRenderingFilterFlags),
      });
    }
  };

  /** @internal */
  private _onCollisionEvent = (colliderHandleA: RAPIER.ColliderHandle, colliderHandleB: RAPIER.ColliderHandle, started: boolean) => {
    const [ objectA, objectB ] = this._getCollisionObjects(colliderHandleA, colliderHandleB);

    if (!objectA || !objectB) return;

    const handleCollision = (objectA: CollisionObject, objectB: CollisionObject) => {
      if (objectA instanceof BlockType && objectB instanceof Entity && objectA.hasListeners(BlockTypeEvent.ENTITY_COLLISION)) {
        objectA.emit(BlockTypeEvent.ENTITY_COLLISION, { blockType: objectA, entity: objectB, started, colliderHandleA, colliderHandleB });
      } else if (objectA instanceof Entity && objectB instanceof BlockType && objectA.hasListeners(EntityEvent.BLOCK_COLLISION)) {
        objectA.emit(EntityEvent.BLOCK_COLLISION, { entity: objectA, blockType: objectB, started, colliderHandleA, colliderHandleB });
      } else if (objectA instanceof Entity && objectB instanceof Entity && objectA.hasListeners(EntityEvent.ENTITY_COLLISION)) {
        objectA.emit(EntityEvent.ENTITY_COLLISION, { entity: objectA, otherEntity: objectB, started, colliderHandleA, colliderHandleB });
      } else if (typeof objectA === 'function' && (objectB instanceof Entity || objectB instanceof BlockType)) { 
        (objectA)(objectB, started, colliderHandleA, colliderHandleB);
      }
    };

    handleCollision(objectA, objectB);
    handleCollision(objectB, objectA);    
  };

  /** @internal */
  private _onContactForceEvent = (event: RAPIER.TempContactForceEvent) => {
    const [ objectA, objectB ] = this._getCollisionObjects(event.collider1(), event.collider2());
    if (!objectA || typeof objectA === 'function' || !objectB || typeof objectB === 'function') return; 
    
    const contactForceData: ContactForceData = {
      totalForce: event.totalForce(),
      totalForceMagnitude: event.totalForceMagnitude(),
      maxForceDirection: event.maxForceDirection(),
      maxForceMagnitude: event.maxForceMagnitude(),
    };

    const handleContactForce = (objectA: BlockType | Entity, objectB: BlockType | Entity) => {
      if (objectA instanceof BlockType && objectB instanceof Entity && objectA.hasListeners(BlockTypeEvent.ENTITY_CONTACT_FORCE)) {
        objectA.emit(BlockTypeEvent.ENTITY_CONTACT_FORCE, { blockType: objectA, entity: objectB, contactForceData });
      } else if (objectA instanceof Entity && objectB instanceof BlockType && objectA.hasListeners(EntityEvent.BLOCK_CONTACT_FORCE)) {
        objectA.emit(EntityEvent.BLOCK_CONTACT_FORCE, { entity: objectA, blockType: objectB, contactForceData });
      } else if (objectA instanceof Entity && objectB instanceof Entity && objectA.hasListeners(EntityEvent.ENTITY_CONTACT_FORCE)) {
        objectA.emit(EntityEvent.ENTITY_CONTACT_FORCE, { entity: objectA, otherEntity: objectB, contactForceData });
      }
    };

    handleContactForce(objectA, objectB);
    handleContactForce(objectB, objectA);
  };

  // may need to refactor this, such as a case where a collider is attached to an entity but also has a collision callback.
  /** @internal */
  private _getCollisionObjects(colliderHandleA: RAPIER.ColliderHandle, colliderHandleB: RAPIER.ColliderHandle): [CollisionObject | undefined, CollisionObject | undefined] {
    const objectA = this._colliderMap.getColliderHandleBlockType(colliderHandleA) ??
                    this._colliderMap.getColliderHandleCollisionCallback(colliderHandleA) ??
                    this._colliderMap.getColliderHandleEntity(colliderHandleA);
    
    const objectB = this._colliderMap.getColliderHandleBlockType(colliderHandleB) ??
                    this._colliderMap.getColliderHandleCollisionCallback(colliderHandleB) ??
                    this._colliderMap.getColliderHandleEntity(colliderHandleB);

    return [ objectA, objectB ];
  }

  /** @internal */
  private _flushPendingTerrainColliders(): void {
    this._world.chunkLattice.flushPendingColliderUpdates();
  }
}
