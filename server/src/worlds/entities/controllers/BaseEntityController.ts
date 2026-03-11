import EventRouter from '@/events/EventRouter';
import type Entity from '@/worlds/entities/Entity';
import type PlayerEntity from '@/worlds/entities/PlayerEntity';
import type { PlayerInput, PredictedBlockEditBatch } from '@/players/Player';
import type { PlayerCameraOrientation } from '@/players/PlayerCamera';

/**
 * Event types a BaseEntityController instance can emit.
 *
 * See `BaseEntityControllerEventPayloads` for the payloads.
 *
 * **Category:** Events
 * @public
 */
export enum BaseEntityControllerEvent {
  ATTACH                 = 'BASE_ENTITY_CONTROLLER.ATTACH',
  DESPAWN                = 'BASE_ENTITY_CONTROLLER.DESPAWN',
  DETACH                 = 'BASE_ENTITY_CONTROLLER.DETACH',
  SPAWN                  = 'BASE_ENTITY_CONTROLLER.SPAWN',
  TICK                   = 'BASE_ENTITY_CONTROLLER.TICK',
  TICK_WITH_PLAYER_INPUT = 'BASE_ENTITY_CONTROLLER.TICK_WITH_PLAYER_INPUT',
}

/**
 * Event payloads for BaseEntityController emitted events.
 *
 * **Category:** Events
 * @public
 */
export interface BaseEntityControllerEventPayloads {
  /** Emitted when an entity is attached to the controller. */
  [BaseEntityControllerEvent.ATTACH]:                 { entity: Entity }

  /** Emitted when an entity is despawned. */
  [BaseEntityControllerEvent.DESPAWN]:                { entity: Entity }

  /** Emitted when an entity is detached from the controller. */
  [BaseEntityControllerEvent.DETACH]:                 { entity: Entity }

  /** Emitted when an entity is spawned. */
  [BaseEntityControllerEvent.SPAWN]:                  { entity: Entity }

  /** Emitted when an entity is ticked. */
  [BaseEntityControllerEvent.TICK]:                   { entity: Entity, deltaTimeMs: number }

  /** Emitted when an entity is ticked with player input. */
  [BaseEntityControllerEvent.TICK_WITH_PLAYER_INPUT]: {
    entity: PlayerEntity,
    input: PlayerInput,
    predictedBlockEditBatches: readonly PredictedBlockEditBatch[],
    cameraOrientation: PlayerCameraOrientation,
    deltaTimeMs: number
  }
}

/**
 * A base class for entity controller implementations.
 *
 * When to use: implementing custom entity behavior and movement logic.
 * Do NOT use for: one-off entity changes; prefer direct entity APIs.
 *
 * @remarks
 * Controllers are typically one instance per entity, but can be shared across
 * entities if you manage state carefully.
 *
 * <h2>Lifecycle</h2>
 *
 * 1) `attach()` — called during `Entity` construction when a controller is provided.
 * 2) `spawn()` — called after the entity is added to the physics simulation.
 * 3) `tickWithPlayerInput()` — called each world tick for `PlayerEntity` before `tick()`.
 * 4) `tick()` — called each world tick before physics stepping.
 * 5) `detach()` → `despawn()` — called during `Entity.despawn`.
 *
 * <h2>Events</h2>
 *
 * This class is an EventRouter, and instances of it emit events with payloads listed under
 * `BaseEntityControllerEventPayloads`.
 *
 * **Category:** Controllers
 * @public
 */
export default abstract class BaseEntityController extends EventRouter {
  /**
   * Override this method to handle the attachment of an entity
   * to your entity controller.
   * 
   * @remarks
   * **Called by:** `Entity` constructor when a controller is provided in options.
   * 
   * **Super call:** Call `super.attach(entity)` to emit the `ATTACH` event.
   * 
   * @param entity - The entity to attach the controller to.
   *
   * **Category:** Controllers
   */
  public attach(entity: Entity): void {
    this.emit(BaseEntityControllerEvent.ATTACH, { entity });
  };

  /**
   * Override this method to handle the despawn of an entity
   * from your entity controller.
   * 
   * @remarks
   * **Called by:** `Entity.despawn()` after `detach()` is called.
   * 
   * **Super call:** Call `super.despawn(entity)` to emit the `DESPAWN` event.
   * 
   * @param entity - The entity being despawned.
   *
   * **Category:** Controllers
   */
  public despawn(entity: Entity): void {
    this.emit(BaseEntityControllerEvent.DESPAWN, { entity });
  };

  /**
   * Override this method to handle the detachment of an entity
   * from your entity controller.
   * 
   * @remarks
   * **Called by:** `Entity.despawn()` before `despawn()` is called.
   * 
   * **Super call:** Call `super.detach(entity)` to emit the `DETACH` event.
   * 
   * @param entity - The entity being detached.
   *
   * **Category:** Controllers
   */
  public detach(entity: Entity): void {
    this.emit(BaseEntityControllerEvent.DETACH, { entity });
  };
  
  /**
   * Override this method to handle the spawning of an entity
   * to your entity controller.
   * 
   * @remarks
   * **Called by:** `Entity.spawn()` after the entity is added to the physics simulation.
   * 
   * **Super call:** Call `super.spawn(entity)` to emit the `SPAWN` event.
   * 
   * @param entity - The entity being spawned.
   *
   * **Category:** Controllers
   */
  public spawn(entity: Entity): void {
    this.emit(BaseEntityControllerEvent.SPAWN, { entity });
  };

  /**
   * Override this method to handle entity movements
   * based on player input for your entity controller.
   * 
   * @remarks
   * **Called by:** `PlayerEntity.tick()` every tick when `isTickWithPlayerInputEnabled` is true.
   * Called before `tick()`.
   * 
   * **Super call:** Call `super.tickWithPlayerInput(...)` to emit the `TICK_WITH_PLAYER_INPUT` event.
   * 
   * @param entity - The player entity being ticked.
   * @param input - The current input state of the player.
   * @param cameraOrientation - The current camera orientation state of the player.
   * @param deltaTimeMs - The delta time in milliseconds since the last tick.
   *
   * **Category:** Controllers
   */
  public tickWithPlayerInput(entity: PlayerEntity, input: PlayerInput, cameraOrientation: PlayerCameraOrientation, deltaTimeMs: number): void {
    this.emit(BaseEntityControllerEvent.TICK_WITH_PLAYER_INPUT, {
      entity,
      input,
      predictedBlockEditBatches: entity.player.predictedBlockEditBatches,
      cameraOrientation,
      deltaTimeMs,
    });
  }

  /**
   * Override this method to handle entity movements
   * based on your entity controller.
   * 
   * @remarks
   * **Called by:** `Entity.tick()` every tick for non-environmental entities.
   * For `PlayerEntity`, this is called after `tickWithPlayerInput()`.
   * 
   * **Super call:** Call `super.tick(entity, deltaTimeMs)` to emit the `TICK` event.
   * 
   * @param entity - The entity being ticked.
   * @param deltaTimeMs - The delta time in milliseconds since the last tick.
   *
   * **Category:** Controllers
   */
  public tick(entity: Entity, deltaTimeMs: number): void {
    this.emit(BaseEntityControllerEvent.TICK, { entity, deltaTimeMs });
  }
}
