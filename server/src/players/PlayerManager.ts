import { ConnectionEvent } from '@/networking/Connection';
import EventRouter from '@/events/EventRouter';
import ErrorHandler from '@/errors/ErrorHandler';
import PersistenceManager from '@/persistence/PersistenceManager';
import Player, { PlayerEvent } from '@/players/Player';
import WorldManager from '@/worlds/WorldManager';
import type Connection from '@/networking/Connection';
import type { Session } from '@/networking/PlatformGateway';
import type World from '@/worlds/World';

const EMPTY_WORLD_PLAYERS: ReadonlySet<Player> = new Set<Player>();

/**
 * Event types a PlayerManager can emit.
 *
 * See `PlayerManagerEventPayloads` for the payloads.
 *
 * **Category:** Events
 * @public
 */
export enum PlayerManagerEvent {
  PLAYER_CONNECTED    = 'PLAYER_MANAGER.PLAYER_CONNECTED',
  PLAYER_DISCONNECTED = 'PLAYER_MANAGER.PLAYER_DISCONNECTED',
  PLAYER_RECONNECTED  = 'PLAYER_MANAGER.PLAYER_RECONNECTED',
}

/**
 * Event payloads for PlayerManager emitted events.
 *
 * **Category:** Events
 * @public
 */
export interface PlayerManagerEventPayloads {
  /** Emitted when a player connects to the server. */
  [PlayerManagerEvent.PLAYER_CONNECTED]:    { player: Player, connectionParams?: URLSearchParams }

  /** Emitted when a player disconnects from the server for any reason (lost connection, kick, world switch, etc). */
  [PlayerManagerEvent.PLAYER_DISCONNECTED]: { player: Player }

  /** Emitted when a player reconnects to the server for any reason (reconnection, world switch, etc). */
  [PlayerManagerEvent.PLAYER_RECONNECTED]: { player: Player }
}

/**
 * Manages all connected players in a game server.
 *
 * When to use: accessing online players, reacting to connection lifecycle events,
 * or routing players to worlds.
 * Do NOT use for: constructing or persisting players yourself; players are created
 * automatically on connection.
 *
 * @remarks
 * Access via `PlayerManager.instance` — do not construct directly.
 *
 * <h2>Events</h2>
 *
 * This class emits global events with payloads listed under
 * `PlayerManagerEventPayloads`.
 *
 * @example
 * ```typescript
 * import { PlayerManager } from 'hytopia';
 *
 * const playerManager = PlayerManager.instance;
 * const connectedPlayers = playerManager.getConnectedPlayers();
 * ```
 *
 * **Category:** Players
 * @public
 */
export default class PlayerManager {
  /**
   * The global PlayerManager instance (singleton).
   *
   * **Category:** Players
   */
  public static readonly instance: PlayerManager = new PlayerManager();

  /**
   * Optional handler for selecting the world a newly connected player joins.
   *
   * Use for: lobby routing or game mode selection.
   * Do NOT use for: moving players after they have already joined a world; use `Player.joinWorld`.
   *
   * @remarks
   * Return `undefined` to place the player in the default world.
   *
   * **Category:** Players
   */
  public worldSelectionHandler?: (player: Player) => Promise<World | undefined>;

  /** @internal */
  private _connectionPlayers: Map<Connection, Player> = new Map<Connection, Player>();

  /** @internal */
  private _worldPlayers: Map<World, Set<Player>> = new Map<World, Set<Player>>();

  /** @internal */
  private constructor() {
    EventRouter.globalInstance.on(ConnectionEvent.OPENED, ({ connection, session }) => {
      void this._onConnectionOpened(connection, session);
    });

    EventRouter.globalInstance.on(ConnectionEvent.DISCONNECTED, ({ connection }) => {
      this._onConnectionDisconnected(connection);
    });

    EventRouter.globalInstance.on(ConnectionEvent.RECONNECTED, ({ connection }) => {
      this._onConnectionReconnected(connection);
    });

    EventRouter.globalInstance.on(ConnectionEvent.CLOSED, ({ connection }) => {
      this._onConnectionClosed(connection);
    });
  }

  /**
   * The number of players currently connected to the server.
   *
   * **Category:** Players
   */
  public get playerCount(): number {
    return this._connectionPlayers.size;
  }

  /**
   * Get all connected players.
   *
   * @returns An array of all connected players.
   *
   * **Category:** Players
   */
  public getConnectedPlayers(): Player[] {
    return Array.from(this._connectionPlayers.values());
  }

  /**
   * Get all connected players in a specific world.
   *
   * @param world - The world to get connected players for.
   * @returns An array of all connected players in the world.
   *
   * **Category:** Players
   */
  public getConnectedPlayersByWorld(world: World): Player[] {
    const players = this._worldPlayers.get(world);
    return players ? Array.from(players) : [];
  }

  /** @internal */
  public getConnectedPlayersByWorldSet(world: World): ReadonlySet<Player> {
    return this._worldPlayers.get(world) ?? EMPTY_WORLD_PLAYERS;
  }

  /**
   * Get a connected player by their username (case-insensitive).
   *
   * @param username - The username of the player to get.
   * @returns The connected player with the given username or undefined if not found.
   *
   * **Category:** Players
   */
  public getConnectedPlayerByUsername(username: string): Player | undefined {
    return Array.from(this._connectionPlayers.values()).find(player => {
      return player.username.toLowerCase() === username.toLowerCase();
    });
  }

  /** @internal */
  private async _onConnectionOpened(connection: Connection, session: Session | undefined) {
    const player = new Player(connection, session);
    player.on(PlayerEvent.JOINED_WORLD, this._onPlayerJoinedWorld);
    player.on(PlayerEvent.LEFT_WORLD, this._onPlayerLeftWorld);

    await player.loadInitialPersistedData();

    EventRouter.globalInstance.emit(PlayerManagerEvent.PLAYER_CONNECTED, { player, connectionParams: connection.initialConnectionParams });
    
    const world = await this.worldSelectionHandler?.(player);
    player.joinWorld(world ?? WorldManager.instance.getDefaultWorld());

    this._connectionPlayers.set(connection, player);
  }

  /** @internal */
  private _onConnectionDisconnected(connection: Connection) {
    const player = this._connectionPlayers.get(connection);

    if (player) {
      player.resetInputs(); // prevent movement/actions if keys were pressed at time of disconnect
      player.camera.reset();
    }
  }

  /** @internal */
  private _onConnectionReconnected(connection: Connection) {
    const player = this._connectionPlayers.get(connection);

    if (player) {
      player.reconnected();
      EventRouter.globalInstance.emit(PlayerManagerEvent.PLAYER_RECONNECTED, { player });
    } else {
      ErrorHandler.warning(`PlayerManager._onConnectionReconnected(): Connection ${connection.id} not in the PlayerManager._connectionPlayers map.`);
    }
  }
  
  /** @internal */
  private _onConnectionClosed(connection: Connection) {
    const player = this._connectionPlayers.get(connection);

    if (player) {
      player.disconnect();

      this._connectionPlayers.delete(connection);

      if (!connection.isDuplicate) {
        PersistenceManager.instance.unloadPlayerData(player).catch(error => {
          ErrorHandler.warning(`PlayerManager._onConnectionClosed(): Failed to unload player data for player ${player.id}. Error: ${error}`);
        });
      }

      EventRouter.globalInstance.emit(PlayerManagerEvent.PLAYER_DISCONNECTED, { player });
    } else {
      ErrorHandler.warning(`PlayerManager._onConnectionClosed(): Connection ${connection.id} not in the PlayerManager._connectionPlayers map.`);
    }
  }

  /** @internal */
  private _onPlayerJoinedWorld = ({ player, world }: { player: Player, world: World }) => {
    let players = this._worldPlayers.get(world);

    if (!players) {
      players = new Set<Player>();
      this._worldPlayers.set(world, players);
    }

    players.add(player);
  };

  /** @internal */
  private _onPlayerLeftWorld = ({ player, world }: { player: Player, world: World }) => {
    const players = this._worldPlayers.get(world);

    if (!players) {
      return;
    }

    players.delete(player);

    if (players.size === 0) {
      this._worldPlayers.delete(world);
    }
  };
}
