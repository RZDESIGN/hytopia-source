import protocol from '@hytopia.com/server-protocol';
import AudioManager from '@/worlds/audios/AudioManager';
import BlockTypeRegistry from '@/worlds/blocks/BlockTypeRegistry';
import ChatManager from '@/worlds/chat/ChatManager';
import ChunkLattice from '@/worlds/blocks/ChunkLattice';
import Entity from '@/worlds/entities/Entity';
import EntityManager from '@/worlds/entities/EntityManager';
import EventRouter from '@/events/EventRouter';
import NetworkSynchronizer from '@/networking/NetworkSynchronizer';
import ParticleEmitterManager from '@/worlds/particles/ParticleEmitterManager';
import SceneUIManager from '@/worlds/ui/SceneUIManager';
import Serializer from '@/networking/Serializer';
import Simulation from '@/worlds/physics/Simulation';
import WorldLoop from '@/worlds/WorldLoop';
import { BLOCK_ROTATIONS } from '@/worlds/blocks/Block';
import type { BlockTypeOptions } from '@/worlds/blocks/BlockType';
import type { EntityOptions } from '@/worlds/entities/Entity';
import type RgbColor from '@/shared/types/RgbColor';
import type Vector3Like from '@/shared/types/math/Vector3Like';

/**
 * A map representation for initializing a world.
 *
 * Use for: importing static maps or tooling exports via `World.loadMap`.
 * Do NOT use for: incremental edits while a world is live; use chunk/block APIs instead.
 *
 * @remarks
 * `blocks` uses `"x,y,z"` world block coordinates as string keys.
 *
 * **Category:** Core
 * @public
 */
export interface WorldMap {
  /** The block types in the map. */
  blockTypes?: BlockTypeOptions[];

  /** The blocks in the map */
  blocks?: {
    /** The global coordinate to block mapping. */
    [coordinate: string]: number | {
      i: number;  // block id
      r?: number; // block rotation index
    };
  };

  /** The entities in the map. */
  entities?: {
    /** The position to entity as entity options mapping. */
    [position: string]: Omit<EntityOptions, 'rigidBodyOptions'> & {
      // We have to "any" cast "type" to prevent map import errors since type is a string in map JSON and not a RigidBodyType.
      rigidBodyOptions?: Omit<NonNullable<EntityOptions['rigidBodyOptions']>, 'type'> & { type?: any }
    };
  }
}

/**
 * Options for creating a World instance.
 *
 * Use for: initializing a world and its environment at construction time.
 * Do NOT use for: runtime changes; use the corresponding `set*` methods on `World`.
 *
 * @remarks
 * Options are applied once at construction time. For runtime changes, use the
 * corresponding `set*` methods on `World`.
 *
 * **Category:** Core
 * @public
 */
export interface WorldOptions {
  /** The unique ID of the world. */
  id: number;

  /** The color of the ambient light for the world. */
  ambientLightColor?: RgbColor;

  /** The intensity of the ambient light for the world. 0 to 1+ */
  ambientLightIntensity?: number;

  /** The color of the directional light for the world. */
  directionalLightColor?: RgbColor;

  /** The intensity of the directional light for the world. 0 to 1+ */
  directionalLightIntensity?: number;

  /** The position the directional light originates from for the world. */
  directionalLightPosition?: Vector3Like;

  /** The color of the fog for the world. Defaults to ambient light color. */
  fogColor?: RgbColor;

  /** The maximum distance from the camera at which fog stops being applied.  */
  fogFar?: number;

  /** The minimum distance from the camera to start applying fog. */
  fogNear?: number;

  /** The map of the world. */
  map?: WorldMap;

  /** The name of the world. */
  name: string;

  /** The intensity of the skybox brightness for the world. 0 is black, 1 is full brightness, 1+ is brighter. */
  skyboxIntensity?: number;

  /** The URI of the skybox cubemap for the world. */
  skyboxUri: string;

  /** An arbitrary identifier tag of the world. Useful for your own logic */
  tag?: string;

  /** The tick rate for the world. */
  tickRate?: number;

  /** The gravity vector for the world. */
  gravity?: Vector3Like;
}

/**
 * Event types a World instance can emit.
 *
 * See `WorldEventPayloads` for the payloads.
 *
 * **Category:** Events
 * @public
 */
export enum WorldEvent {
  SET_AMBIENT_LIGHT_COLOR         = 'WORLD.SET_AMBIENT_LIGHT_COLOR',
  SET_AMBIENT_LIGHT_INTENSITY     = 'WORLD.SET_AMBIENT_LIGHT_INTENSITY',
  SET_DIRECTIONAL_LIGHT_COLOR     = 'WORLD.SET_DIRECTIONAL_LIGHT_COLOR',
  SET_DIRECTIONAL_LIGHT_INTENSITY = 'WORLD.SET_DIRECTIONAL_LIGHT_INTENSITY',
  SET_DIRECTIONAL_LIGHT_POSITION  = 'WORLD.SET_DIRECTIONAL_LIGHT_POSITION',
  SET_FOG_COLOR                   = 'WORLD.SET_FOG_COLOR',
  SET_FOG_FAR                     = 'WORLD.SET_FOG_FAR',
  SET_FOG_NEAR                    = 'WORLD.SET_FOG_NEAR',
  SET_SKYBOX_INTENSITY            = 'WORLD.SET_SKYBOX_INTENSITY',
  SET_SKYBOX_URI                  = 'WORLD.SET_SKYBOX_URI',
  START                           = 'WORLD.START',
  STOP                            = 'WORLD.STOP',
}

/**
 * Event payloads for World emitted events.
 *
 * **Category:** Events
 * @public
 */
export interface WorldEventPayloads {
  /** Emitted when the color of the world's ambient light is set. */
  [WorldEvent.SET_AMBIENT_LIGHT_COLOR]:         { world: World, color: RgbColor }

  /** Emitted when the intensity of the world's ambient light is set. */
  [WorldEvent.SET_AMBIENT_LIGHT_INTENSITY]:     { world: World, intensity: number }

  /** Emitted when the color of the world's directional light is set. */
  [WorldEvent.SET_DIRECTIONAL_LIGHT_COLOR]:     { world: World, color: RgbColor }

  /** Emitted when the intensity of the world's directional light is set. */
  [WorldEvent.SET_DIRECTIONAL_LIGHT_INTENSITY]: { world: World, intensity: number }

  /** Emitted when the position of the world's directional light is set. */
  [WorldEvent.SET_DIRECTIONAL_LIGHT_POSITION]:  { world: World, position: Vector3Like }

  /** Emitted when the color of the world's fog is set. */
  [WorldEvent.SET_FOG_COLOR]:                   { world: World, color: RgbColor }

  /** Emitted when the density of the world's fog is set. */
  [WorldEvent.SET_FOG_FAR]:                     { world: World, far: number }

  /** Emitted when the density of the world's fog is set. */
  [WorldEvent.SET_FOG_NEAR]:                    { world: World, near: number }

  /** Emitted when the intensity of the world's skybox brightness is set. */
  [WorldEvent.SET_SKYBOX_INTENSITY]:            { world: World, intensity: number }

  /** Emitted when the URI of the world's skybox is set. */
  [WorldEvent.SET_SKYBOX_URI]:                   { world: World, uri: string }

  /** Emitted when the world starts. */
  [WorldEvent.START]:                           { world: World, startedAtMs: number }

  /** Emitted when the world stops. */
  [WorldEvent.STOP]:                            { world: World, stoppedAtMs: number }
}

/**
 * Represents an isolated simulation space (a world) on the server.
 *
 * When to use: your primary container for game objects, physics, and players.
 * Use multiple worlds to run separate rooms, arenas, or instances.
 * Do NOT use for: cross-world global state; keep that in your own services or `GameServer`.
 *
 * @remarks
 * Prefer creating worlds via `WorldManager.createWorld` or
 * `WorldManager.getDefaultWorld` so IDs and lifecycle are managed consistently.
 *
 * Initialization:
 * - Call `World.start` to begin ticking (auto-started when created by `WorldManager`).
 * - Use `set*` methods for runtime lighting or skybox changes.
 *
 * <h2>Events</h2>
 *
 * This class is an EventRouter, and instances of it emit events with payloads listed
 * under `WorldEventPayloads`.
 *
 * @example
 * ```typescript
 * const world = WorldManager.instance.createWorld({
 *   name: 'My World',
 *   skyboxUri: 'skyboxes/partly-cloudy',
 * });
 * ```
 *
 * **Category:** Core
 * @public
 */
export default class World extends EventRouter implements protocol.Serializable {
  /** @internal */
  private _id: number;

  /** @internal */
  private _ambientLightColor: RgbColor;

  /** @internal */
  private _ambientLightIntensity: number;

  /** @internal */
  private _audioManager: AudioManager;

  /** @internal */
  private _blockTypeRegistry: BlockTypeRegistry;

  /** @internal */
  private _chatManager: ChatManager;

  /** @internal */
  private _chunkLattice: ChunkLattice;

  /** @internal */
  private _directionalLightColor: RgbColor;

  /** @internal */
  private _directionalLightIntensity: number;

  /** @internal */
  private _directionalLightPosition: Vector3Like;

  /** @internal */
  private _entityManager: EntityManager;

  /** @internal */
  private _fogColor: RgbColor | undefined;

  /** @internal */
  private _fogFar: number;

  /** @internal */
  private _fogNear: number;

  /** @internal */
  private _loop: WorldLoop;

  /** @internal */
  private _name: string;

  /** @internal */
  private _networkSynchronizer: NetworkSynchronizer;

  /** @internal */
  private _serialized: protocol.WorldSchema | undefined;

  /** @internal */
  private _particleEmitterManager: ParticleEmitterManager;

  /** @internal */
  private _sceneUIManager: SceneUIManager;

  /** @internal */
  private _simulation: Simulation;

  /** @internal */
  private _skyboxIntensity: number;

  /** @internal */
  private _skyboxUri: string;

  /** @internal */
  private _tag: string | undefined;

  /**
   * Creates a world instance with the provided options.
   *
   * Use for: direct construction only when you need custom lifecycle control.
   * Do NOT use for: routine world creation; prefer `WorldManager.createWorld`.
   *
   * @param options - Initial world configuration. Options are applied once at construction.
   *
   * @see `WorldManager.createWorld`
   *
   * **Category:** Core
   */
  constructor(options: WorldOptions) {    
    super();

    this._id = options.id;
    this._ambientLightColor = options.ambientLightColor ?? { r: 255, g: 255, b: 255 };
    this._ambientLightIntensity = options.ambientLightIntensity ?? 1;
    this._directionalLightColor = options.directionalLightColor ?? { r: 255, g: 255, b: 255 };
    this._directionalLightIntensity = options.directionalLightIntensity ?? 3;
    this._directionalLightPosition = options.directionalLightPosition ?? { x: 100, y: 150, z: 100 };
    this._fogColor = options.fogColor;
    this._fogFar = options.fogFar ?? 550;
    this._fogNear = options.fogNear ?? 500;
    this._name = options.name;
    this._skyboxIntensity = options.skyboxIntensity ?? 1;
    this._skyboxUri = options.skyboxUri;
    this._tag = options.tag;
  
    this._audioManager = new AudioManager(this);
    this._blockTypeRegistry = new BlockTypeRegistry(this);
    this._chatManager = new ChatManager(this);
    this._chunkLattice = new ChunkLattice(this);
    this._entityManager = new EntityManager(this);
    this._loop = new WorldLoop(this, options.tickRate);
    this._networkSynchronizer = new NetworkSynchronizer(this);
    this._particleEmitterManager = new ParticleEmitterManager(this);
    this._sceneUIManager = new SceneUIManager(this);
    this._simulation = new Simulation(this, options.tickRate, options.gravity);

    if (options.map) {
      this.loadMap(options.map);
    }
  }

  /**
   * The unique ID of the world.
   *
   * **Category:** Core
   */
  public get id(): number { return this._id; }

  /**
   * The color of the ambient light.
   *
   * **Category:** Core
   */
  public get ambientLightColor(): RgbColor { return this._ambientLightColor; }

  /**
   * The intensity of the ambient light.
   *
   * **Category:** Core
   */
  public get ambientLightIntensity(): number { return this._ambientLightIntensity; }

  /**
   * The block type registry for this world.
   *
   * **Category:** Core
   */
  public get blockTypeRegistry(): BlockTypeRegistry { return this._blockTypeRegistry; }

  /**
   * The chat manager for this world.
   *
   * **Category:** Core
   */
  public get chatManager(): ChatManager { return this._chatManager; }

  /**
   * The chunk lattice for this world.
   *
   * **Category:** Core
   */
  public get chunkLattice(): ChunkLattice { return this._chunkLattice; }

  /**
   * The color of the directional light.
   *
   * **Category:** Core
   */
  public get directionalLightColor(): RgbColor { return this._directionalLightColor; }

  /**
   * The intensity of the directional light.
   *
   * **Category:** Core
   */
  public get directionalLightIntensity(): number { return this._directionalLightIntensity; }

  /**
   * The position the directional light originates from (relative to the camera).
   *
   * **Category:** Core
   */
  public get directionalLightPosition(): Vector3Like { return this._directionalLightPosition; }

  /**
   * The entity manager for this world.
   *
   * **Category:** Core
   */
  public get entityManager(): EntityManager { return this._entityManager; }

  /**
   * The fog color, or undefined to use ambient light color.
   *
   * **Category:** Core
   */
  public get fogColor(): RgbColor | undefined { return this._fogColor; }

  /**
   * The maximum distance from the camera at which fog stops being applied.
   *
   * **Category:** Core
   */
  public get fogFar(): number { return this._fogFar; }

  /**
   * The minimum distance from the camera to start applying fog.
   *
   * **Category:** Core
   */
  public get fogNear(): number { return this._fogNear; }

  /**
   * The world loop that drives ticking for this world.
   *
   * @remarks
   * Use `World.start` and `World.stop` for lifecycle control.
   *
   * **Category:** Core
   */
  public get loop(): WorldLoop { return this._loop; }

  /**
   * The name of the world.
   *
   * **Category:** Core
   */
  public get name(): string { return this._name; }

  /** @internal */
  public get networkSynchronizer(): NetworkSynchronizer { return this._networkSynchronizer; }

  /**
   * The particle emitter manager for this world.
   *
   * **Category:** Core
   */
  public get particleEmitterManager(): ParticleEmitterManager { return this._particleEmitterManager; }

  /**
   * The scene UI manager for this world.
   *
   * **Category:** Core
   */
  public get sceneUIManager(): SceneUIManager { return this._sceneUIManager; }

  /**
   * The physics simulation for this world.
   *
   * **Category:** Core
   */
  public get simulation(): Simulation { return this._simulation; }

  /**
   * The intensity of the world's skybox brightness.
   *
   * **Category:** Core
   */
  public get skyboxIntensity(): number { return this._skyboxIntensity; }

  /**
   * The URI of the skybox cubemap for this world.
   *
   * **Category:** Core
   */
  public get skyboxUri(): string { return this._skyboxUri; }

  /**
   * The audio manager for this world.
   *
   * **Category:** Core
   */
  public get audioManager(): AudioManager { return this._audioManager; }

  /**
   * An arbitrary identifier tag for your own logic.
   *
   * **Category:** Core
   */
  public get tag(): string | undefined { return this._tag; }

  /**
   * Loads a map into the world, replacing any prior map contents.
   *
   * Use for: initializing or fully resetting a world from serialized map data.
   * Do NOT use for: incremental edits while players are actively interacting with the world.
   *
   * @remarks
   * - Clears existing blocks and colliders via `ChunkLattice.clear`.
   * - Registers block types from the map into `World.blockTypeRegistry`.
   * - Spawns map entities as `isEnvironmental: true` by default.
   *
   * @param map - The map to load.
   *
   * **Side effects:** Clears the chunk lattice, registers block types, and spawns entities.
   *
   * **Category:** Core
   */
  public loadMap(map: WorldMap) {
    // Clear any prior map
    this.chunkLattice.clear();

    // Rotations LUT
    const BLOCK_ROTATIONS_BY_INDEX = Object.values(BLOCK_ROTATIONS).sort((a, b) => a.enumIndex - b.enumIndex);

    // load map block types
    if (map.blockTypes) {
      for (const blockTypeData of map.blockTypes) {
        this.blockTypeRegistry.registerGenericBlockType({
          id: blockTypeData.id,
          isLiquid: blockTypeData.isLiquid,
          lightLevel: blockTypeData.lightLevel,
          name: blockTypeData.name,
          textureUri: blockTypeData.textureUri,
          customColliderOptions: blockTypeData.customColliderOptions,
        });
      }
    }

    // load map chunk blocks
    if (map.blocks) {
      const mapBlocks = map.blocks;
      const blockEntries = function* () {
        for (const key in mapBlocks) {
          const blockValue = mapBlocks[key];
          const blockTypeId = typeof blockValue === 'number' ? blockValue : blockValue.i;
          const blockRotationIndex = typeof blockValue === 'number' ? undefined : blockValue.r;
          const i1 = key.indexOf(',');
          const i2 = key.indexOf(',', i1 + 1);

          yield {
            globalCoordinate: {
              x: Number(key.slice(0, i1)),
              y: Number(key.slice(i1 + 1, i2)),
              z: Number(key.slice(i2 + 1)),
            },
            blockTypeId,
            blockRotation: blockRotationIndex !== undefined ? BLOCK_ROTATIONS_BY_INDEX[blockRotationIndex] : undefined,
          };
        }
      };

      this.chunkLattice.initializeBlockEntries(blockEntries());
    }

    // load map entities
    if (map.entities) {
      for (const key in map.entities) {
        const entityOptions = map.entities[key];
        const i1 = key.indexOf(',');
        const i2 = key.indexOf(',', i1 + 1);
        const x = Number(key.slice(0, i1));
        const y = Number(key.slice(i1 + 1, i2));
        const z = Number(key.slice(i2 + 1));

        const entity = new Entity({
          isEnvironmental: true,
          ...entityOptions,
        });

        entity.spawn(this, { x, y, z });
      }
    }
  }

  /**
   * Sets the color of the world's ambient light.
   *
   * @param color - The color of the light.
   *
   * **Side effects:** Emits `WorldEvent.SET_AMBIENT_LIGHT_COLOR`.
   *
   * **Category:** Core
   */
  public setAmbientLightColor(color: RgbColor) {
    this._ambientLightColor = color;
    this._serialized = undefined;

    this.emit(WorldEvent.SET_AMBIENT_LIGHT_COLOR, {
      world: this,
      color,
    });
  }

  /**
   * Sets the intensity of the world's ambient light.
   *
   * @param intensity - The intensity.
   *
   * **Side effects:** Emits `WorldEvent.SET_AMBIENT_LIGHT_INTENSITY`.
   *
   * **Category:** Core
   */
  public setAmbientLightIntensity(intensity: number) {
    this._ambientLightIntensity = intensity;
    this._serialized = undefined;

    this.emit(WorldEvent.SET_AMBIENT_LIGHT_INTENSITY, {
      world: this,
      intensity,
    });
  }

  /**
   * Sets the color of the world's directional light.
   *
   * @param color - The color of the light.
   *
   * **Side effects:** Emits `WorldEvent.SET_DIRECTIONAL_LIGHT_COLOR`.
   *
   * **Category:** Core
   */
  public setDirectionalLightColor(color: RgbColor) {
    this._directionalLightColor = color;
    this._serialized = undefined;

    this.emit(WorldEvent.SET_DIRECTIONAL_LIGHT_COLOR, {
      world: this,
      color,
    });
  }

  /**
   * Sets the intensity of the world's directional light.
   *
   * @param intensity - The intensity.
   *
   * **Side effects:** Emits `WorldEvent.SET_DIRECTIONAL_LIGHT_INTENSITY`.
   *
   * **Category:** Core
   */
  public setDirectionalLightIntensity(intensity: number) {
    this._directionalLightIntensity = intensity;
    this._serialized = undefined;

    this.emit(WorldEvent.SET_DIRECTIONAL_LIGHT_INTENSITY, {
      world: this,
      intensity,
    });
  }

  /**
   * Sets the position the world's directional light originates from relative to a player's camera.
   *
   * @param position - The light position relative to the player's camera.
   *
   * **Side effects:** Emits `WorldEvent.SET_DIRECTIONAL_LIGHT_POSITION`.
   *
   * **Category:** Core
   */
  public setDirectionalLightPosition(position: Vector3Like) {
    this._directionalLightPosition = position;
    this._serialized = undefined;

    this.emit(WorldEvent.SET_DIRECTIONAL_LIGHT_POSITION, {
      world: this,
      position,
    });
  }

  /**
   * Sets the color of the world's fog.
   *
   * @param color - The color of the fog, or undefined to reset to ambient light color.
   *
   * **Side effects:** Emits `WorldEvent.SET_FOG_COLOR`.
   *
   * **Category:** Core
   */
  public setFogColor(color: RgbColor | undefined) {
    this._fogColor = color;
    this._serialized = undefined;

    this.emit(WorldEvent.SET_FOG_COLOR, {
      world: this,
      color,
    });
  }

  /**
   * Sets the maximum distance from the camera at which fog stops being applied.
   *
   * @param far - The far distance.
   *
   * **Side effects:** Emits `WorldEvent.SET_FOG_FAR`.
   *
   * **Category:** Core
   */
  public setFogFar(far: number) {
    this._fogFar = far;
    this._serialized = undefined;

    this.emit(WorldEvent.SET_FOG_FAR, {
      world: this,
      far,
    });
  }

  /**
   * Sets the minimum distance from the camera to start applying fog.
   *
   * @param near - The near distance.
   *
   * **Side effects:** Emits `WorldEvent.SET_FOG_NEAR`.
   *
   * **Category:** Core
   */
  public setFogNear(near: number) {
    this._fogNear = near;
    this._serialized = undefined;

    this.emit(WorldEvent.SET_FOG_NEAR, {
      world: this,
      near,
    });
  }

  /**
   * Sets the intensity of the world's skybox brightness.
   *
   * @param intensity - The intensity.
   *
   * **Side effects:** Emits `WorldEvent.SET_SKYBOX_INTENSITY`.
   *
   * **Category:** Core
   */
  public setSkyboxIntensity(intensity: number) {
    this._skyboxIntensity = intensity;
    this._serialized = undefined;

    this.emit(WorldEvent.SET_SKYBOX_INTENSITY, {
      world: this,
      intensity,
    });
  }

  /**
   * Sets the cubemap URI of the world's skybox.
   *
   * @param skyboxUri - The cubemap URI of the skybox.
   *
   * **Side effects:** Emits `WorldEvent.SET_SKYBOX_URI`.
   *
   * **Category:** Core
   */
  public setSkyboxUri(skyboxUri: string) {
    this._skyboxUri = skyboxUri;
    this._serialized = undefined;

    this.emit(WorldEvent.SET_SKYBOX_URI, {
      world: this,
      uri: skyboxUri,
    });
  }

  /**
   * Starts the world loop, which begins ticking physics, entities, and networking.
   *
   * Use for: resuming a previously stopped world.
   * Do NOT use for: standard world creation when using `WorldManager.createWorld` (it auto-starts).
   *
   * **Side effects:** Emits `WorldEvent.START`.
   *
   * **Category:** Core
   */
  public start(): void {
    if (this._loop.isStarted) return; // already started

    this._loop.start();

    this.emit(WorldEvent.START, {
      world: this,
      startedAtMs: Date.now(),
    });
  }

  /**
   * Stops the world loop, pausing physics, entities, and networking ticks.
   *
   * Use for: pausing a world or preparing for a full map reset.
   * Do NOT use for: disconnecting players; they remain assigned to this world.
   *
   * **Side effects:** Emits `WorldEvent.STOP`.
   *
   * **Category:** Core
   */
  public stop(): void {
    if (!this._loop.isStarted) return; // not started
    
    this._loop.stop();

    this.emit(WorldEvent.STOP, {
      world: this,
      stoppedAtMs: Date.now(),
    });
  }

  /** @internal */
  public serialize(): protocol.WorldSchema {
    this._serialized ??= Serializer.serializeWorld(this);
    return this._serialized;
  }
}
