import RAPIER from '@dimforge/rapier3d-simd-compat';
import BlockTextureRegistry from '@/textures/BlockTextureRegistry';
import EventRouter from '@/events/EventRouter';
import ErrorHandler from '@/errors/ErrorHandler';
import ModelRegistry from '@/models/ModelRegistry';
import PlayerManager from '@/players/PlayerManager';
import Socket from '@/networking/Socket';
import WebServer from '@/networking/WebServer';
import ProcessWorldHostClient from '@/worlds/hosting/ProcessWorldHostClient';
import WorldHostManager from '@/worlds/hosting/WorldHostManager';
import WorldManager from '@/worlds/WorldManager';
import type World from '@/worlds/World';

/**
 * Event types a GameServer instance can emit to the global event router.
 *
 * See `GameServerEventPayloads` for the payloads.
 *
 * **Category:** Events
 * @public
 */
export enum GameServerEvent {
  START = 'GAMESERVER.START',
  STOP  = 'GAMESERVER.STOP',
}

/**
 * Event payloads for GameServer emitted events.
 *
 * **Category:** Events
 * @public
 */
export interface GameServerEventPayloads {
  /** Emitted when the game server starts. */
  [GameServerEvent.START]: { startedAtMs: number }

  /** Emitted when the game server stops. */
  [GameServerEvent.STOP]:  { stoppedAtMs: number }
}

/**
 * Boots the server runtime, runs your init callback, and starts accepting connections.
 *
 * Use for: normal server startup in your entry file.
 * Do NOT use for: restarting an already running server within the same process.
 *
 * @remarks
 * Initialization order:
 * 1) Physics engine (RAPIER)
 * 2) Block texture atlas preload
 * 3) Model preload
 * 4) Your `init` callback (awaited if async)
 * 5) Server starts accepting connections
 *
 * If `init` declares a `world` parameter, a default world is created and provided.
 *
 * @param init - Game initialization callback. It can be sync or async. If it accepts a
 * world parameter, the default world is created and passed in.
 *
 * **Requires:** Call once per process before using gameplay systems.
 *
 * @see `GameServer`
 * @see `WorldManager.getDefaultWorld`
 *
 * **Category:** Core
 * @public
 */
export function startServer(init: ((() => void | Promise<void>) | ((world: World) => void | Promise<void>))) {
  RAPIER.init().then(() => {
    return GameServer.instance.blockTextureRegistry.preloadAtlas();
  }).then(() => {
    return GameServer.instance.modelRegistry.preloadModels();
  }).then(() => {
    let initResult: void | Promise<void>;

    if (init.length > 0) {
      // If the init function accepts a world parameter, lazy load a default world via getter
      initResult = init(GameServer.instance.worldManager.getDefaultWorld());
    } else {
      initResult = (init as () => void | Promise<void>)();
    }

    // Waits if async init function, otherwise resolves 
    // immediately if init function is synchronous.
    return Promise.resolve(initResult);
  }).then(() => {
    GameServer.instance.start();
  }).catch(error => {
    ErrorHandler.fatalError(`Failed to initialize the game engine, exiting. Error: ${error}`);
  });
}

/**
 * Global entry point for server systems (players, worlds, assets).
 *
 * When to use: accessing global managers and registries after startup.
 * Do NOT use for: constructing your own server instance.
 *
 * @remarks
 * Access via `GameServer.instance` — do not construct directly.
 * Initialize with `startServer` to ensure physics and assets are ready.
 *
 * **Category:** Core
 * @public
 */
export default class GameServer {
  /** @internal */
  private static _instance: GameServer;

  /** @internal */
  private _blockTextureRegistry = BlockTextureRegistry.instance;

  /** @internal */
  private _modelRegistry = ModelRegistry.instance;

  /** @internal */
  private _playerManager = PlayerManager.instance;

  /** @internal */
  private _socket = Socket.instance;

  /** @internal */
  private _worldManager = WorldManager.instance;

  /** @internal */
  private _webServer = WebServer.instance;

  /** @internal */
  private constructor() {
    if (ProcessWorldHostClient.shouldEnableFromEnvironment()) {
      WorldHostManager.instance.setClient(new ProcessWorldHostClient());
    }
  }

  /**
   * The singleton instance of the game server.
   *
   * @remarks
   * Access this after calling `startServer`.
   *
   * **Category:** Core
   */
  public static get instance(): GameServer {
    if (!this._instance) {
      this._instance = new GameServer();
    }

    return this._instance;
  }

  /**
   * The block texture registry for the game server.
   *
   * **Category:** Core
   */
  public get blockTextureRegistry(): BlockTextureRegistry {
    return this._blockTextureRegistry;
  }

  /**
   * The model registry for the game server.
   *
   * **Category:** Core
   */
  public get modelRegistry(): ModelRegistry {
    return this._modelRegistry;
  }

  /**
   * The player manager for the game server.
   *
   * **Category:** Core
   */
  public get playerManager(): PlayerManager {
    return this._playerManager;
  }

  /** @internal */
  public get socket(): Socket {
    return this._socket;
  }

  /**
   * The web server for the game server.
   *
   * **Category:** Core
   */
  public get webServer(): WebServer {
    return this._webServer;
  }

  /**
   * The world manager for the game server.
   *
   * **Category:** Core
   */
  public get worldManager(): WorldManager {
    return this._worldManager;
  }

  /** @internal */
  public start(): void {
    EventRouter.globalInstance.emit(GameServerEvent.START, { startedAtMs: performance.now() });

    this._webServer.start();

    if (process.env.NODE_ENV !== 'production') {
      console.log('---');
      console.log('🟢 Server Running: You can test & play it at: https://hammyhytopia.com/?join=local.hytopiahosting.com:8080');
    }

    ErrorHandler.enableCrashProtection();
  }
}
