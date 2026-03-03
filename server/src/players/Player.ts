import protocol from '@hytopia.com/server-protocol';
import RAPIER from '@dimforge/rapier3d-simd-compat';
import ErrorHandler from '@/errors/ErrorHandler';
import EventRouter from '@/events/EventRouter';
import PersistenceManager from '@/persistence/PersistenceManager';
import PlatformGateway from '@/networking/PlatformGateway';
import PlayerCamera from '@/players/PlayerCamera';
import PlayerUI from '@/players/PlayerUI';
import Serializer from '@/networking/Serializer';
import type Connection from '@/networking/Connection';
import { PlayerUIEvent } from '@/players/PlayerUI';
import type Vector3Like from '@/shared/types/math/Vector3Like';
import type World from '@/worlds/World';
import type { InputSchema } from '@hytopia.com/server-protocol';
import type { PlayerCosmetics, Session } from '@/networking/PlatformGateway';
import type { RaycastHit } from '@/worlds/physics/Simulation';

/**
 * The inputs that are included in `PlayerInput`.
 *
 * **Category:** Players
 * @public
 */
export const SUPPORTED_INPUTS = [
  'w', 'a', 's', 'd',                               // Common movement keys
  'sp', 'sh', 'tb',                                 // Common action keys - space, shift, tab
  'ml', 'mr',                                       // Mouse keys - mouse left, mouse right
  'q', 'e', 'r', 'f', 'z', 'x', 'c', 'v',           // Other keys
  'u', 'i', 'o', 'j', 'k', 'l', 'n', 'm',           // Other keys
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', // Number keys
  'cp', 'cy',                                       // Camera pitch/yaw (radians)
  'iro', 'ird',                                     // Interact ray origin/direction
  'jd',                                             // Joystick direction (radians)
] as const satisfies readonly (keyof InputSchema)[];

const SEQUENCED_MOVEMENT_INPUTS = [
  'w',
  'a',
  's',
  'd',
  'sp',
  'sh',
  'c',
  'jd',
] as const satisfies readonly (keyof InputSchema)[];
const SEQUENCED_MOVEMENT_INPUT_SET = new Set<string>(SEQUENCED_MOVEMENT_INPUTS);
const MAX_QUEUED_SEQUENCED_MOVEMENT_COMMANDS = 64;

type SequencedMovementInputCommand = {
  sequenceNumber: number;
  w: boolean;
  a: boolean;
  s: boolean;
  d: boolean;
  sp: boolean;
  sh: boolean;
  c: boolean;
  jd: number | null;
  cp?: number;
  cy?: number;
};

/**
 * The input state of a `Player`.
 *
 * **Category:** Players
 * @public
 */
export type PlayerInput = InputSchema;

/**
 * Event types a Player can emit.
 *
 * See `PlayerEventPayloads` for the payloads.
 *
 * **Category:** Events
 * @public
 */
export enum PlayerEvent {
  CHAT_MESSAGE_SEND               = 'PLAYER.CHAT_MESSAGE_SEND',
  INTERACT                        = 'PLAYER.INTERACT',
  JOINED_WORLD                    = 'PLAYER.JOINED_WORLD',
  LEFT_WORLD                      = 'PLAYER.LEFT_WORLD',
  RECONNECTED_WORLD               = 'PLAYER.RECONNECTED_WORLD',
  REQUEST_NOTIFICATION_PERMISSION = 'PLAYER.REQUEST_NOTIFICATION_PERMISSION',
  REQUEST_SYNC                    = 'PLAYER.REQUEST_SYNC',
}

/**
 * Event payloads for Player emitted events.
 *
 * **Category:** Events
 * @public
 */
export interface PlayerEventPayloads {
  /** Emitted when a player sends a chat message. */
  [PlayerEvent.CHAT_MESSAGE_SEND]:               { player: Player, message: string }

  /** Emitted when a player joins a world. */
  [PlayerEvent.JOINED_WORLD]:                    { player: Player, world: World }

  /** Emitted when a player interacts the world. */
  [PlayerEvent.INTERACT]:                        { player: Player, interactOrigin: Vector3Like, interactDirection: Vector3Like, raycastHit?: RaycastHit }

  /** Emitted when a player leaves a world. */
  [PlayerEvent.LEFT_WORLD]:                      { player: Player, world: World }

  /** Emitted when a player reconnects to a world after a unintentional disconnect. */
  [PlayerEvent.RECONNECTED_WORLD]:               { player: Player, world: World }

  /** Emitted when notification permission is requested by a game. */
  [PlayerEvent.REQUEST_NOTIFICATION_PERMISSION]: { player: Player }

  /** Emitted when a player's client requests a round trip time synchronization. */
  [PlayerEvent.REQUEST_SYNC]:                    { player: Player, receivedAt: number, receivedAtMs: number }
}

/**
 * A connected player in the game.
 *
 * When to use: interacting with a connected player's state, UI, and world membership.
 * Do NOT use for: constructing players or representing offline users.
 *
 * @remarks
 * Players are created automatically on connection by `PlayerManager`.
 *
 * <h2>Events</h2>
 *
 * This class is an EventRouter, and instances of it emit events with payloads listed under
 * `PlayerEventPayloads`.
 *
 * **Category:** Players
 * @public
 */
export default class Player extends EventRouter implements protocol.Serializable {
  /** @internal */
  private static _devNextPlayerId: number = 1;

  /**
   * The unique HYTOPIA UUID for the player.
   *
   * **Category:** Players
   */
  public readonly id: string;

  /**
   * The unique HYTOPIA username for the player.
   *
   * **Category:** Players
   */
  public readonly username: string;

  /**
   * The profile picture URL for the player.
   *
   * **Category:** Players
   */
  public readonly profilePictureUrl: string | undefined;

  /**
   * The camera for the player.
   *
   * **Category:** Players
   */
  public readonly camera: PlayerCamera;

  /** @internal */
  public readonly connection: Connection;

  /**
   * The cosmetics for the player.
   *
   * @remarks
   * This resolves asynchronously and may resolve to `void` if unavailable.
   *
   * **Category:** Players
   */
  public readonly cosmetics: Promise<PlayerCosmetics | void>;

  /**
   * The UI for the player.
   *
   * **Category:** Players
   */
  public readonly ui: PlayerUI;

  /** @internal */
  private _input: PlayerInput = {};

  /** @internal */
  private _interactEnabled: boolean = true;

  /** @internal */
  private _lastUnreliableInputSequenceNumber: number = -1;

  /** @internal */
  private _lastAppliedInputSequenceNumber: number = -1;

  /** @internal */
  private _queuedSequencedMovementInputs: SequencedMovementInputCommand[] = [];

  /** @internal */
  private _maxInteractDistance: number = 20;

  /** @internal */
  private _persistedData: Record<string, unknown> | undefined;

  /** @internal */
  private _world: World | undefined;

  /** @internal */
  private _worldSwitched: boolean = false;

  /** @internal */
  public constructor(connection: Connection, session: Session | undefined) {
    super();

    this.id = session?.user.id ?? `player-${Player._devNextPlayerId++}`;
    this.username = session?.user.username ?? this.id;
    this.profilePictureUrl = session?.user.profilePictureURL ?? undefined;
    this.camera = new PlayerCamera(this);
    this.connection = connection;
    this.cosmetics = PlatformGateway.instance.getPlayerCosmetics(this.id);
    this.ui = new PlayerUI(this);

    connection.onPacket(protocol.PacketId.CHAT_MESSAGE_SEND, this._onChatMessageSendPacket);
    connection.onPacket(protocol.PacketId.DEBUG_CONFIG, this._onDebugConfigPacket);
    connection.onPacket(protocol.PacketId.INPUT, this._onInputPacket);
    connection.onPacket(protocol.PacketId.SYNC_REQUEST, this._onSyncRequestPacket);
    connection.onPacket(protocol.PacketId.UI_DATA_SEND, this._onUIDataSendPacket);
  }

  /**
   * The current `PlayerInput` of the player.
   *
   * **Category:** Players
   */
  public get input(): PlayerInput { return this._input; }

  /**
   * Whether player click/tap input triggers interactions.
   *
   * @remarks
   * Defaults to `true`.
   *
   * **Category:** Players
   */
  public get isInteractEnabled(): boolean { return this._interactEnabled; }
  
  /**
   * The maximum distance a player can interact with entities or blocks.
   *
   * @remarks
   * Measured in world blocks. Defaults to `20`.
   *
   * **Category:** Players
   */
  public get maxInteractDistance(): number { return this._maxInteractDistance; }

  /** @internal */
  public get lastAppliedInputSequenceNumber(): number | undefined {
    return this._lastAppliedInputSequenceNumber >= 0 ? this._lastAppliedInputSequenceNumber : undefined;
  }

  /**
   * The current `World` the player is in, or undefined if not yet joined.
   *
   * **Category:** Players
   */
  public get world(): World | undefined { return this._world; }

  /**
   * Disconnects the player from the game server.
   *
   * Use for: kicking a player or enforcing a logout.
   * Do NOT use for: switching worlds; use `Player.joinWorld` instead.
   *
   * **Side effects:** Emits `PlayerEvent.LEFT_WORLD` if the player is in a world and closes the connection.
   *
   * **Category:** Players
   */
  public disconnect() {
    this._leaveWorld();
    this.connection.disconnect();
  }

  /**
   * Gets the persisted data for the player, if available.
   *
   * Use for: reading saved progress after the player connects.
   *
   * @remarks
   * Returns `undefined` if data hasn't loaded or no data exists.
   * Returns an empty object when data loads successfully but is empty.
   *
   * @returns The persisted data for the player, or undefined.
   *
   * **Requires:** Player persistence must have been loaded (handled during connect).
   *
   * **Category:** Players
   */
  public getPersistedData(): Record<string, unknown> | undefined {
    if (!this._persistedData) {
      return undefined;
    }

    const keys = Object.keys(this._persistedData);

    if (keys.length === 0 || (keys.length === 1 && keys[0] === '__version')) { // If no keys or only the version key, return undefined (no set data)
      return undefined;
    }

    return this._persistedData;
  }

  /**
   * Assigns the player to a world.
   *
   * Use for: initial placement or moving a player between worlds.
   * Do NOT use for: respawning or teleporting within the same world.
   *
   * @remarks
   * If switching worlds, the player is internally disconnected/reconnected and
   * `JOINED_WORLD` is emitted after reconnection completes.
   *
   * @param world - The world to join the player to.
   *
   * **Side effects:** Emits `PlayerEvent.JOINED_WORLD` and `PlayerEvent.LEFT_WORLD`
   * during world switches.
   *
   * **Category:** Players
   */
  public joinWorld(world: World) {
    if (this._world === world) {
      return;
    }

    if (!this._world) {
      // First time joining any world
      this._world = world;
      this.emitWithWorld(this._world, PlayerEvent.JOINED_WORLD, {
        player: this,
        world: this._world,
      });
    } else {
      // Despawn all player entities for this player
      for (const entity of this._world.entityManager.getPlayerEntitiesByPlayer(this)) {
        if (entity.isSpawned) {
          entity.despawn();
        }
      }

      // Switching worlds - handled by a clean disconnect and reconnect, upon reconnection reconnected() invokes.
      this.disconnect();

      this._world = world;
      this._worldSwitched = true;
    }
  }

  /**
   * Schedules a notification for the player at a future time.
   *
   * Use for: re-engagement or timed reminders.
   * Do NOT use for: immediate in-game messaging; use chat or UI instead.
   *
   * @remarks
   * Automatically prompts for notification permission in-game if needed.
   *
   * @param type - The type of notification to schedule.
   * @param scheduledFor - A future timestamp in milliseconds to schedule the notification for.
   * @returns The ID of the notification if scheduled successfully, undefined otherwise.
   *
   * **Requires:** Player must be in a world to request permission.
   *
   * **Side effects:** Emits `PlayerEvent.REQUEST_NOTIFICATION_PERMISSION`.
   *
   * **Category:** Players
   */
  public async scheduleNotification(type: string, scheduledFor: number): Promise<string | void> {
    if (!this._world) {
      return ErrorHandler.warning('Player.scheduleNotification(): Player must be in a world to schedule a notification.');
    }

    this.emitWithWorld(this._world, PlayerEvent.REQUEST_NOTIFICATION_PERMISSION, { player: this });

    return PlatformGateway.instance.scheduleNotification(this.id, type, scheduledFor);
  }

  /**
   * Unschedules a scheduled notification for the player.
   *
   * @param notificationId - The ID returned from `Player.scheduleNotification`.
   * @returns True if the notification was unscheduled, false otherwise.
   *
   * **Category:** Players
   */
  public async unscheduleNotification(notificationId: string): Promise<boolean> {
    if (!notificationId) {
      return false;
    }

    return PlatformGateway.instance.unscheduleNotification(notificationId);
  }
 
  /** @internal */
  public async loadInitialPersistedData() {
    if (this._persistedData) return;
    
    this._persistedData = await PersistenceManager.instance.getPlayerData(this);
  }

  /** @internal */
  public reconnected() {
    if (!this._world) {
      return;
    }

    this._lastUnreliableInputSequenceNumber = -1;
    this._lastAppliedInputSequenceNumber = -1;
    this._queuedSequencedMovementInputs = [];

    if (!this._worldSwitched) {
      this.emitWithWorld(this._world, PlayerEvent.RECONNECTED_WORLD, {
        player: this,
        world: this._world,
      });
    } else {
      this._worldSwitched = false;
      this.emitWithWorld(this._world, PlayerEvent.JOINED_WORLD, {
        player: this,
        world: this._world,
      });
    }
  }

  /**
   * Resets all cached input keys for the player.
   *
   * Use for: clearing stuck input states (e.g., after disconnect or pause).
   *
   * **Side effects:** Clears the current `PlayerInput` state.
   *
   * **Category:** Players
   */
  public resetInputs() {
    this._input = {};
    this._queuedSequencedMovementInputs = [];
  }

  /**
   * Enables or disables interaction clicks/taps for this player.
   *
   * Use for: cutscenes, menus, or temporary input blocking.
   *
   * @param enabled - True to allow interactions, false to block them.
   *
   * **Category:** Players
   */
  public setInteractEnabled(enabled: boolean) {
    this._interactEnabled = enabled;
  }

  /**
   * Sets the maximum distance a player can interact with entities or blocks.
   *
   * @param distance - The maximum distance in blocks used for the interact raycast.
   *
   * **Category:** Players
   */
  public setMaxInteractDistance(distance: number) {
    this._maxInteractDistance = distance;
  }

  /**
   * Merges data into the player's persisted data cache.
   *
   * Use for: saving progress, inventory, or other player-specific state.
   * Do NOT use for: large binary data or per-tick updates.
   *
   * @remarks
   * Data is merged shallowly into the cached persistence object.
   *
   * @param data - The data to merge into the persisted data.
   *
   * **Requires:** Player persistence must have been loaded before calling.
   *
   * **Side effects:** Mutates the in-memory persistence cache for this player.
   *
   * **Category:** Players
   */
  public setPersistedData(data: Record<string, unknown>): void {
    if (!this._persistedData) {
      ErrorHandler.warning(`Player.setPersistedData(): Persisted data not found for player ${this.id}`);

      return;
    }

    for (const [ key, value ] of Object.entries(data)) {
      this._persistedData[key] = value;
    }
  }

  /** @internal */
  public serialize(): protocol.PlayerSchema {
    return Serializer.serializePlayer(this);
  }

  /** @internal */
  public markInputAppliedForSimulation(): void {
    if (
      this._queuedSequencedMovementInputs.length === 0 &&
      this._lastUnreliableInputSequenceNumber >= 0
    ) {
      this._lastAppliedInputSequenceNumber = this._lastUnreliableInputSequenceNumber;
    }
  }

  /** @internal */
  public applyQueuedInputForSimulation(): void {
    if (this._queuedSequencedMovementInputs.length === 0) {
      this.markInputAppliedForSimulation();
      return;
    }

    let sawJumpPressed = false;
    for (let i = 0; i < this._queuedSequencedMovementInputs.length; i++) {
      if (this._queuedSequencedMovementInputs[i].sp) {
        sawJumpPressed = true;
      }
    }

    const command = this._queuedSequencedMovementInputs[this._queuedSequencedMovementInputs.length - 1];
    this._queuedSequencedMovementInputs.length = 0;

    this._input.w = command.w;
    this._input.a = command.a;
    this._input.s = command.s;
    this._input.d = command.d;
    this._input.sp = command.sp || sawJumpPressed;
    this._input.sh = command.sh;
    this._input.c = command.c;
    if (command.jd === null) {
      delete this._input.jd;
    } else {
      this._input.jd = command.jd;
    }

    if (command.cp !== undefined) {
      this._input.cp = command.cp;
      this.camera.setOrientationPitch(command.cp);
    }

    if (command.cy !== undefined) {
      this._input.cy = command.cy;
      this.camera.setOrientationYaw(command.cy);
    }

    this._lastAppliedInputSequenceNumber = command.sequenceNumber;
  }

  /** @internal */
  private _leaveWorld() {
    if (!this._world) {
      return;
    }

    this.emitWithWorld(this._world, PlayerEvent.LEFT_WORLD, {
      player: this,
      world: this._world,
    });

    this._world = undefined;
  }

  /** @internal */
  private _onChatMessageSendPacket = (packet: protocol.ChatMessageSendPacket) => {
    if (!this._world) {
      return;
    }

    // TODO: Seperate and expand on global server vs worlds/room chat?
    const message = packet[1].m;

    // Try to handle as command first
    if (this._world.chatManager.handleCommand(this, message)) {
      this._world.chatManager.sendPlayerMessage( // Notify player that command was handled
        this,
        `Command Entered: ${message}`,
        'CCCCCC',
      );

      return; // Command was handled, don't emit chat event
    }

    // Regular chat message - emit event for nametag display and broadcasting
    this.emitWithWorld(this._world, PlayerEvent.CHAT_MESSAGE_SEND, {
      player: this,
      message,
    });
  };

  /** @internal */
  private _onDebugConfigPacket = (packet: protocol.DebugConfigPacket) => {
    console.log(packet);
  };

  /** @internal */
  private _onInputPacket = (packet: protocol.InputPacket) => {
    const input = packet[1];

    // If an input packet has a sequence number, meaning it was sent
    // over an unreliable, unordered UDP connection, we need to ensure
    // that the sequence number is greater than the last received.
    // If not, ignore the packet.
    if (input.sq !== undefined) {
      if (input.sq <= this._lastUnreliableInputSequenceNumber) return;
      this._lastUnreliableInputSequenceNumber = input.sq;
    }

    const hasSequencedMovementInput = input.sq !== undefined && this._hasSequencedMovementInput(input);
    if (hasSequencedMovementInput) {
      this._enqueueSequencedMovementInputCommand(input);
    }

    for (const key in input) {
      if (key === 'sq') {
        continue;
      }

      // Sequenced movement state is applied on simulation ticks from the command queue.
      if (hasSequencedMovementInput && SEQUENCED_MOVEMENT_INPUT_SET.has(key)) {
        continue;
      }

      // Camera orientation in sequenced movement packets is applied atomically with movement.
      if (hasSequencedMovementInput && (key === 'cp' || key === 'cy')) {
        continue;
      }

      (this._input as Record<string, unknown>)[key] = input[key as keyof InputSchema] as unknown;
    }

    if (!hasSequencedMovementInput && input.cp !== undefined) this.camera.setOrientationPitch(input.cp);
    if (!hasSequencedMovementInput && input.cy !== undefined) this.camera.setOrientationYaw(input.cy);
    if (this.world && input.ird && input.iro) this.interact();
  };

  /** @internal */
  private _hasSequencedMovementInput(input: InputSchema): boolean {
    for (const key of SEQUENCED_MOVEMENT_INPUTS) {
      if (key in input) {
        return true;
      }
    }

    return false;
  }

  /** @internal */
  private _enqueueSequencedMovementInputCommand(input: InputSchema): void {
    const inputWithNullableJoystick = input as InputSchema & { jd?: number | null };

    const command: SequencedMovementInputCommand = {
      sequenceNumber: input.sq!,
      w: input.w ?? !!this._input.w,
      a: input.a ?? !!this._input.a,
      s: input.s ?? !!this._input.s,
      d: input.d ?? !!this._input.d,
      sp: input.sp ?? !!this._input.sp,
      sh: input.sh ?? !!this._input.sh,
      c: input.c ?? !!this._input.c,
      jd: inputWithNullableJoystick.jd !== undefined ? inputWithNullableJoystick.jd : (this._input.jd ?? null),
      cp: input.cp,
      cy: input.cy,
    };

    if (this._queuedSequencedMovementInputs.length >= MAX_QUEUED_SEQUENCED_MOVEMENT_COMMANDS) {
      this._queuedSequencedMovementInputs.shift();
    }

    this._queuedSequencedMovementInputs.push(command);
  }

  /** @internal */
  private interact = () => {
    if (!this.world || !this._input.ird || !this._input.iro) return;

    if (this._interactEnabled) {
      const interactOrigin = { x: this._input.iro[0], y: this._input.iro[1], z: this._input.iro[2] };
      const interactDirection = { x: this._input.ird[0], y: this._input.ird[1], z: this._input.ird[2] };

      const playerEntity = this.world.entityManager.getPlayerEntitiesByPlayer(this)[0];
      const raycastHit = this.world.simulation.raycast(interactOrigin, interactDirection, this._maxInteractDistance, {
        filterExcludeRigidBody: playerEntity?.rawRigidBody,
        filterFlags: RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      });

      this.emitWithWorld(this.world, PlayerEvent.INTERACT, {
        player: this,
        interactOrigin,
        interactDirection,
        raycastHit,
      });

      if (raycastHit?.hitEntity) {
        raycastHit.hitEntity.interact(this, raycastHit);
      }

      if (raycastHit?.hitBlock) {
        raycastHit.hitBlock.blockType.interact(this, raycastHit);
      }
    }
  };

  /** @internal */
  private _onSyncRequestPacket = () => {
    if (this._world) {
      this.emitWithWorld(this._world, PlayerEvent.REQUEST_SYNC, {
        player: this,
        receivedAt: Date.now(),
        receivedAtMs: performance.now(),
      });
    }
  };

  /** @internal */
  private _onUIDataSendPacket = (packet: protocol.UIDataSendPacket) => {
    this.ui.emit(PlayerUIEvent.DATA, { playerUI: this.ui, data: packet[1] });
  };
}


 
