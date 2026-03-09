import EventRouter from '@/events/EventRouter';
import World from '@/worlds/World';
import WorldHostManager from '@/worlds/hosting/WorldHostManager';
import type { WorldOptions } from '@/worlds/World';

/**
 * Event types a WorldManager instance can emit to the global event router.
 *
 * See `WorldManagerEventPayloads` for the payloads.
 *
 * **Category:** Events
 * @public
 */
export enum WorldManagerEvent {
  WORLD_CREATED = 'WORLD_MANAGER.WORLD_CREATED',
}

/**
 * Event payloads for WorldManager emitted events.
 *
 * **Category:** Events
 * @public
 */
export interface WorldManagerEventPayloads {
  /** Emitted when a world is created. */
  [WorldManagerEvent.WORLD_CREATED]: { world: World }
}

/**
 * Manages all worlds in a game server.
 *
 * When to use: creating additional worlds, routing players, or querying the active world set.
 * Do NOT use for: instantiating `World` directly for gameplay; use `WorldManager.createWorld`
 * to ensure IDs and lifecycle are managed consistently.
 *
 * @remarks
 * Access via `WorldManager.instance` — do not construct directly.
 *
 * <h2>Events</h2>
 *
 * This class emits global events with payloads listed under
 * `WorldManagerEventPayloads`.
 *
 * @example
 * ```typescript
 * import { WorldManager } from 'hytopia';
 *
 * const worldManager = WorldManager.instance;
 * const newWorld = worldManager.createWorld({
 *   name: 'My New World',
 *   skyboxUri: 'skyboxes/partly-cloudy',
 * });
 * ```
 *
 * **Category:** Core
 * @public
 */
export default class WorldManager {
  /**
   * The global WorldManager instance (singleton).
   *
   * **Category:** Core
   */
  public static readonly instance: WorldManager = new WorldManager();

  /** @internal */
  private _defaultWorld: World | undefined;

  /** @internal */
  private _nextWorldId: number = 1;

  /** @internal */
  private _worlds: Map<number, World> = new Map();

  /**
   * Creates and starts a new world with a unique ID.
   *
   * Use for: additional game rooms, arenas, or isolated simulations.
   * Do NOT use for: deferred world creation without starting; this always starts.
   *
   * @remarks
   * Auto-starts the world after creation.
   *
   * @param options - The options for the world (ID is assigned automatically).
   * @returns The created world.
   *
   * **Side effects:** Starts the world's tick loop and emits `WorldManagerEvent.WORLD_CREATED`.
   *
   * @see `World.start`
   * @see `WorldManager.getDefaultWorld`
   *
   * **Category:** Core
   */
  public createWorld(options: Omit<WorldOptions, 'id'>): World {
    const world = new World({
      ...options,
      id: this._nextWorldId++,
    });

    world.start();

    this._worlds.set(world.id, world);
    WorldHostManager.instance.client.registerWorld(world);

    EventRouter.globalInstance.emit(WorldManagerEvent.WORLD_CREATED, { world });

    return world;
  }

  /**
   * Gets all worlds currently managed by the server.
   *
   * @returns All worlds.
   *
   * **Category:** Core
   */
  public getAllWorlds(): World[] {
    return Array.from(this._worlds.values());
  }

  /**
   * Gets the default world, creating it if it does not exist.
   *
   * Use for: a single-world game or as a safe fallback when routing players.
   * Do NOT use for: creating specialized worlds with unique options.
   *
   * @remarks
   * Lazy-creates and auto-starts a default world if none exists.
   *
   * @returns The default world.
   *
   * **Side effects:** Creates and starts a world if it does not yet exist.
   *
   * **Category:** Core
   */
  public getDefaultWorld(): World {
    if (!this._defaultWorld) {
      this._defaultWorld = this.createWorld({ // Lazy init if none exist
        name: 'Default World',
        skyboxUri: 'skyboxes/partly-cloudy',
      });
      WorldHostManager.instance.client.setDefaultWorld(this._defaultWorld);
    }

    return this._defaultWorld;
  }

  /**
   * Gets all worlds with a specific tag.
   *
   * @param tag - The tag to filter worlds by.
   * @returns All worlds with the provided tag.
   *
   * **Category:** Core
   */
  public getWorldsByTag(tag: string): World[] {
    const worlds: World[] = [];

    this._worlds.forEach(world => {
      if (world.tag === tag) {
        worlds.push(world);
      }
    });

    return worlds;
  }

  /**
   * Gets a world by its ID.
   *
   * @param id - The ID of the world to get.
   * @returns The world with the provided ID, or undefined if no world is found.
   *
   * **Category:** Core
   */
  public getWorld(id: number): World | undefined {
    return this._worlds.get(id);
  }

  /**
   * Sets the default world players join on connect.
   *
   * Use for: changing the lobby or main world at runtime.
   * Do NOT use for: moving already connected players; use `Player.joinWorld`.
   *
   * @param world - The world to set as the default.
   *
   * **Category:** Core
   */
  public setDefaultWorld(world: World) {
    this._defaultWorld = world;
    WorldHostManager.instance.client.setDefaultWorld(world);
  }
}
