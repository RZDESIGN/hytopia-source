import protocol from '@hytopia.com/server-protocol';
import RAPIER from '@dimforge/rapier3d-simd-compat';
import ErrorHandler from '@/errors/ErrorHandler';
import EventRouter from '@/events/EventRouter';
import PersistenceManager from '@/persistence/PersistenceManager';
import PlatformGateway from '@/networking/PlatformGateway';
import PlayerCamera from '@/players/PlayerCamera';
import PlayerUI from '@/players/PlayerUI';
import Serializer from '@/networking/Serializer';
import type { HostedPlayerPacketEnvelope } from '@/worlds/hosting/WorldHostProtocol';
import {
  DEFAULT_ROLLBACK_PREDICTED_INPUTS,
  createRollbackPredictedInputSet,
  encodeRollbackPredictedInputMask,
  isRollbackPredictableInput,
  normalizeRollbackPredictedInputs,
  replaceRollbackPredictedInputSnapshot,
  type RollbackPredictedInputSnapshot,
  type RollbackPredictableInput,
  SUPPORTED_INPUTS as SHARED_SUPPORTED_INPUTS,
} from '@gameplay-shared/InputContract';
import type Connection from '@/networking/Connection';
import { PlayerUIEvent } from '@/players/PlayerUI';
import {
  createDefaultBlockEditPredictionConfig,
  type DefaultBlockEditPredictionConfig,
} from '@engine-shared/network/ConnectionFeatureFlags';
import type Vector3Like from '@/shared/types/math/Vector3Like';
import type World from '@/worlds/World';
import type { InputSchema, PredictedBlockEditsSendSchema } from '@hytopia.com/server-protocol';
import type { PlayerCosmetics, Session } from '@/networking/PlatformGateway';
import type { RaycastHit } from '@/worlds/physics/Simulation';

/**
 * The inputs that are included in `PlayerInput`.
 *
 * **Category:** Players
 * @public
 */
export const SUPPORTED_INPUTS = SHARED_SUPPORTED_INPUTS;

const MAX_QUEUED_SEQUENCED_MOVEMENT_COMMANDS = 64;
const MAX_PREDICTED_BLOCK_EDITS_PER_BATCH = 64;
const MAX_QUEUED_PREDICTED_BLOCK_EDIT_BATCHES = 64;
const MAX_QUEUED_PREDICTED_BLOCK_EDITS = 256;

type SequencedMovementInputCommand = {
  sequenceNumber: number;
  input: Omit<Partial<InputSchema>, 'jd'> & {
    jd?: number | null;
  };
};

/**
 * The input state of a `Player`.
 *
 * **Category:** Players
 * @public
 */
export type PlayerInput = InputSchema;

/**
 * A client-submitted speculative block edit intent.
 *
 * **Category:** Players
 * @public
 */
export type PredictedBlockEditAttempt = {
  globalCoordinate: Vector3Like;
  blockTypeId: number;
  blockRotationIndex?: number;
};

/**
 * A speculative block edit batch grouped by a client prediction id.
 *
 * **Category:** Players
 * @public
 */
export type PredictedBlockEditBatch = {
  predictionId: string;
  edits: PredictedBlockEditAttempt[];
};

/**
 * Event types a Player can emit.
 *
 * See `PlayerEventPayloads` for the payloads.
 *
 * **Category:** Events
 * @public
 */
export enum PlayerEvent {
  BLOCK_EDIT_PREDICTION          = 'PLAYER.BLOCK_EDIT_PREDICTION',
  CHAT_MESSAGE_SEND               = 'PLAYER.CHAT_MESSAGE_SEND',
  CONFIRM_BLOCK_EDIT_PREDICTION   = 'PLAYER.CONFIRM_BLOCK_EDIT_PREDICTION',
  DEFAULT_BLOCK_EDIT_PREDICTION_CONFIG_UPDATE = 'PLAYER.DEFAULT_BLOCK_EDIT_PREDICTION_CONFIG_UPDATE',
  INTERACT                        = 'PLAYER.INTERACT',
  JOINED_WORLD                    = 'PLAYER.JOINED_WORLD',
  LEFT_WORLD                      = 'PLAYER.LEFT_WORLD',
  RECONNECTED_WORLD               = 'PLAYER.RECONNECTED_WORLD',
  REQUEST_NOTIFICATION_PERMISSION = 'PLAYER.REQUEST_NOTIFICATION_PERMISSION',
  REQUEST_SYNC                    = 'PLAYER.REQUEST_SYNC',
  ROLLBACK_BLOCK_EDIT_PREDICTION  = 'PLAYER.ROLLBACK_BLOCK_EDIT_PREDICTION',
}

/**
 * Event payloads for Player emitted events.
 *
 * **Category:** Events
 * @public
 */
export interface PlayerEventPayloads {
  /** Emitted when a player submits a speculative block edit intent. */
  [PlayerEvent.BLOCK_EDIT_PREDICTION]:          { player: Player, predictionId: string, edits: PredictedBlockEditAttempt[] }

  /** Emitted when a player sends a chat message. */
  [PlayerEvent.CHAT_MESSAGE_SEND]:               { player: Player, message: string }

  /** Emitted when server gameplay confirms a speculative block edit prediction. */
  [PlayerEvent.CONFIRM_BLOCK_EDIT_PREDICTION]:   { player: Player, predictionId: string }

  /** Emitted when owner-only default block edit prediction settings change. */
  [PlayerEvent.DEFAULT_BLOCK_EDIT_PREDICTION_CONFIG_UPDATE]: { player: Player, config: DefaultBlockEditPredictionConfig }

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

  /** Emitted when server gameplay rejects a speculative block edit prediction. */
  [PlayerEvent.ROLLBACK_BLOCK_EDIT_PREDICTION]:  { player: Player, predictionId: string }
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
  private _rollbackPredictedInputs: RollbackPredictableInput[] = [ ...DEFAULT_ROLLBACK_PREDICTED_INPUTS ];

  /** @internal */
  private _rollbackPredictedInputSet: ReadonlySet<RollbackPredictableInput> = createRollbackPredictedInputSet(
    DEFAULT_ROLLBACK_PREDICTED_INPUTS,
  );

  /** @internal */
  private _rollbackPredictedInputMaskLow: number = encodeRollbackPredictedInputMask(
    DEFAULT_ROLLBACK_PREDICTED_INPUTS,
  )[0];

  /** @internal */
  private _rollbackPredictedInputMaskHigh: number = encodeRollbackPredictedInputMask(
    DEFAULT_ROLLBACK_PREDICTED_INPUTS,
  )[1];

  /** @internal */
  private _rollbackPredictedInputSnapshot: RollbackPredictedInputSnapshot = {};

  /** @internal */
  private _previousRollbackPredictedInputSnapshot: RollbackPredictedInputSnapshot = {};

  /** @internal */
  private _currentRollbackPredictedInputSequenceNumber: number | undefined;

  /** @internal */
  private _defaultBlockEditPredictionConfig: DefaultBlockEditPredictionConfig = createDefaultBlockEditPredictionConfig();

  /** @internal */
  private _predictedBlockEditBatches: PredictedBlockEditBatch[] = [];

  /** @internal */
  private _queuedPredictedBlockEditBatches: PredictedBlockEditBatch[] = [];

  /** @internal */
  private _queuedPredictedBlockEditCount: number = 0;

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
    this.cosmetics = session?.user.id
      ? PlatformGateway.instance.getPlayerCosmetics(session.user.id)
      : Promise.resolve(undefined);
    this.ui = new PlayerUI(this);
  }

  /**
   * The current `PlayerInput` of the player.
   *
   * **Category:** Players
   */
  public get input(): PlayerInput { return this._input; }

  /**
   * The owner player's speculative block edit batches available for the current simulation tick.
   *
   * **Category:** Players
   */
  public get predictedBlockEditBatches(): readonly PredictedBlockEditBatch[] { return this._predictedBlockEditBatches; }

  /**
   * The owner-only stock block edit prediction settings used by the fixed client helpers.
   *
   * **Category:** Players
   */
  public get defaultBlockEditPredictionConfig(): DefaultBlockEditPredictionConfig {
    return this._defaultBlockEditPredictionConfig;
  }

  /**
   * The raw input keys that should be sequenced with rollback prediction.
   *
   * @remarks
   * Inputs outside this list keep their existing reliable/immediate behavior.
   * Defaults to the stock locomotion set (`w`, `a`, `s`, `d`, `sp`, `sh`, `c`, `jd`).
   *
   * **Category:** Players
   */
  public get rollbackPredictedInputs(): readonly RollbackPredictableInput[] {
    return this._rollbackPredictedInputs;
  }

  /** @internal */
  public get rollbackPredictedInputSnapshot(): Readonly<RollbackPredictedInputSnapshot> {
    return this._rollbackPredictedInputSnapshot;
  }

  /** @internal */
  public get previousRollbackPredictedInputSnapshot(): Readonly<RollbackPredictedInputSnapshot> {
    return this._previousRollbackPredictedInputSnapshot;
  }

  /** @internal */
  public get currentRollbackPredictedInputSequenceNumber(): number | undefined {
    return this._currentRollbackPredictedInputSequenceNumber;
  }

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

  /** @internal */
  public get rollbackPredictedInputMaskHigh(): number {
    return this._rollbackPredictedInputMaskHigh;
  }

  /** @internal */
  public get rollbackPredictedInputMaskLow(): number {
    return this._rollbackPredictedInputMaskLow;
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
    replaceRollbackPredictedInputSnapshot(this._rollbackPredictedInputSnapshot, {});
    replaceRollbackPredictedInputSnapshot(this._previousRollbackPredictedInputSnapshot, {});
    this._currentRollbackPredictedInputSequenceNumber = undefined;
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
   * Sets the raw input keys that should be sequenced with rollback prediction.
   *
   * @remarks
   * This preserves the existing game-facing input API. Games can keep reading
   * `player.input.q`, `player.input.e`, etc. and only opt specific keys into
   * rollback sequencing when they affect deterministic character state.
   *
   * **Category:** Players
   */
  public setRollbackPredictedInputs(inputs?: readonly (keyof InputSchema)[]): void {
    const normalizedInputs = normalizeRollbackPredictedInputs(inputs);
    const [ lowMask, highMask ] = encodeRollbackPredictedInputMask(normalizedInputs);

    if (
      lowMask === this._rollbackPredictedInputMaskLow &&
      highMask === this._rollbackPredictedInputMaskHigh
    ) {
      return;
    }

    this._rollbackPredictedInputs = normalizedInputs;
    this._rollbackPredictedInputSet = createRollbackPredictedInputSet(normalizedInputs);
    this._rollbackPredictedInputMaskLow = lowMask;
    this._rollbackPredictedInputMaskHigh = highMask;
    const currentSnapshot = this._createRollbackPredictedInputSnapshotFromCurrentInput();
    replaceRollbackPredictedInputSnapshot(this._rollbackPredictedInputSnapshot, currentSnapshot);
    replaceRollbackPredictedInputSnapshot(this._previousRollbackPredictedInputSnapshot, currentSnapshot);
    this._currentRollbackPredictedInputSequenceNumber = undefined;
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
   * Confirms a speculative client block edit batch by prediction id.
   *
   * **Category:** Players
   */
  public confirmPredictedBlockEdit(predictionId: string): void {
    if (!this._world) {
      return;
    }

    this.emitWithWorld(this._world, PlayerEvent.CONFIRM_BLOCK_EDIT_PREDICTION, {
      player: this,
      predictionId,
    });
  }

  /**
   * Rejects and rolls back a speculative client block edit batch by prediction id.
   *
   * **Category:** Players
   */
  public rollbackPredictedBlockEdit(predictionId: string): void {
    if (!this._world) {
      return;
    }

    this.emitWithWorld(this._world, PlayerEvent.ROLLBACK_BLOCK_EDIT_PREDICTION, {
      player: this,
      predictionId,
    });
  }

  /**
   * Updates the stock owner-only block edit prediction settings for this player.
   *
   * **Category:** Players
   */
  public setDefaultBlockEditPredictionConfig(
    config: Partial<DefaultBlockEditPredictionConfig>,
  ): void {
    const nextConfig: DefaultBlockEditPredictionConfig = {
      maxDistance: Number.isFinite(config.maxDistance)
        ? Math.max(0, config.maxDistance as number)
        : this._defaultBlockEditPredictionConfig.maxDistance,
      placeBlockTypeId: typeof config.placeBlockTypeId !== 'number'
        ? this._defaultBlockEditPredictionConfig.placeBlockTypeId
        : Math.max(0, Math.floor(config.placeBlockTypeId)),
      placeBlockRotationIndex: config.placeBlockRotationIndex === undefined || config.placeBlockRotationIndex === null
        ? undefined
        : Math.max(0, Math.floor(config.placeBlockRotationIndex)),
    };

    if (
      nextConfig.maxDistance === this._defaultBlockEditPredictionConfig.maxDistance &&
      nextConfig.placeBlockTypeId === this._defaultBlockEditPredictionConfig.placeBlockTypeId &&
      nextConfig.placeBlockRotationIndex === this._defaultBlockEditPredictionConfig.placeBlockRotationIndex
    ) {
      return;
    }

    this._defaultBlockEditPredictionConfig = nextConfig;

    if (!this._world) {
      return;
    }

    this.emitWithWorld(this._world, PlayerEvent.DEFAULT_BLOCK_EDIT_PREDICTION_CONFIG_UPDATE, {
      player: this,
      config: nextConfig,
    });
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
  public handleHostedPacket(envelope: HostedPlayerPacketEnvelope): void {
    const { packet, receivedAtMonotonicMs, receivedAtUnixMs } = envelope;

    switch (packet[0]) {
      case protocol.PacketId.CHAT_MESSAGE_SEND:
        this._onChatMessageSendPacket(packet as protocol.ChatMessageSendPacket);
        break;
      case protocol.PacketId.DEBUG_CONFIG:
        this._onDebugConfigPacket(packet as protocol.DebugConfigPacket);
        break;
      case protocol.PacketId.INPUT:
        this._onInputPacket(packet as protocol.InputPacket);
        break;
      case protocol.PacketId.PREDICTED_BLOCK_EDITS_SEND:
        this._onPredictedBlockEditsSendPacket(packet as protocol.PredictedBlockEditsSendPacket);
        break;
      case protocol.PacketId.SYNC_REQUEST:
        this._onSyncRequestPacket(receivedAtUnixMs, receivedAtMonotonicMs);
        break;
      case protocol.PacketId.UI_DATA_SEND:
        this._onUIDataSendPacket(packet as protocol.UIDataSendPacket);
        break;
      default:
        break;
    }
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
  public discardInputForSimulation(): void {
    this._input = {};
    replaceRollbackPredictedInputSnapshot(this._rollbackPredictedInputSnapshot, {});
    replaceRollbackPredictedInputSnapshot(this._previousRollbackPredictedInputSnapshot, {});
    this._currentRollbackPredictedInputSequenceNumber = undefined;
    this._rollbackPendingPredictedBlockEditBatches(this._queuedPredictedBlockEditBatches);
    this._predictedBlockEditBatches = [];
    this._queuedPredictedBlockEditBatches.length = 0;
    this._queuedPredictedBlockEditCount = 0;

    if (this._queuedSequencedMovementInputs.length > 0) {
      const lastQueuedCommand = this._queuedSequencedMovementInputs[this._queuedSequencedMovementInputs.length - 1];
      this._lastAppliedInputSequenceNumber = Math.max(
        this._lastAppliedInputSequenceNumber,
        lastQueuedCommand.sequenceNumber,
      );
      this._queuedSequencedMovementInputs.length = 0;
    }

    if (this._lastUnreliableInputSequenceNumber >= 0) {
      this._lastAppliedInputSequenceNumber = Math.max(
        this._lastAppliedInputSequenceNumber,
        this._lastUnreliableInputSequenceNumber,
      );
    }
  }

  /** @internal */
  public applyQueuedInputForSimulation(): void {
    this._predictedBlockEditBatches = this._queuedPredictedBlockEditBatches.splice(0);
    this._queuedPredictedBlockEditCount = 0;

    if (this._queuedSequencedMovementInputs.length === 0) {
      this._advanceRollbackPredictedInputSnapshots(
        this._createRollbackPredictedInputSnapshotFromCurrentInput(),
      );
      this.markInputAppliedForSimulation();
      return;
    }

    // Drain up to MAX_INPUT_DRAIN_PER_TICK queued commands so the server
    // catches up faster after a brief hitch.  Only the last command's
    // input state is applied – intermediate frames are skipped since the
    // server physics doesn't simulate each client input tick individually.
    const MAX_INPUT_DRAIN_PER_TICK = 3;
    const commandsToDrain = Math.min(
      this._queuedSequencedMovementInputs.length,
      MAX_INPUT_DRAIN_PER_TICK,
    );

    let command!: SequencedMovementInputCommand;
    for (let ci = 0; ci < commandsToDrain; ci++) {
      command = this._queuedSequencedMovementInputs.shift()!;
    }

    for (const inputKey of this._rollbackPredictedInputs) {
      if (inputKey === 'jd') {
        if (command.input.jd === null) {
          delete this._input.jd;
        } else if (command.input.jd !== undefined) {
          this._input.jd = command.input.jd;
        }

        continue;
      }

      if (command.input[inputKey]) {
        (this._input as Record<string, unknown>)[inputKey] = true;
      } else {
        delete (this._input as Record<string, unknown>)[inputKey];
      }
    }

    if (command.input.cp !== undefined) {
      this._input.cp = command.input.cp;
      this.camera.setOrientationPitch(command.input.cp);
    }

    if (command.input.cy !== undefined) {
      this._input.cy = command.input.cy;
      this.camera.setOrientationYaw(command.input.cy);
    }

    this._advanceRollbackPredictedInputSnapshots(
      this._createRollbackPredictedInputSnapshotFromQueuedCommand(command.input),
      command.sequenceNumber,
    );
    this._lastAppliedInputSequenceNumber = command.sequenceNumber;
  }

  /** @internal */
  public clearPredictedBlockEditBatchesForSimulation(): void {
    this._predictedBlockEditBatches = [];
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
      if (
        hasSequencedMovementInput &&
        isRollbackPredictableInput(key as keyof InputSchema) &&
        this._rollbackPredictedInputSet.has(key as RollbackPredictableInput)
      ) {
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
  private _onPredictedBlockEditsSendPacket = (packet: protocol.PredictedBlockEditsSendPacket) => {
    if (!this._world) {
      return;
    }

    const data: PredictedBlockEditsSendSchema = packet[1];
    if (data.e.length === 0) {
      return;
    }

    if (data.e.length > MAX_PREDICTED_BLOCK_EDITS_PER_BATCH) {
      this.rollbackPredictedBlockEdit(data.p);
      return;
    }

    const edits: PredictedBlockEditAttempt[] = new Array(data.e.length);

    for (let i = 0; i < data.e.length; i++) {
      const edit = data.e[i];
      edits[i] = {
        globalCoordinate: {
          x: edit.c[0],
          y: edit.c[1],
          z: edit.c[2],
        },
        blockTypeId: edit.i,
        blockRotationIndex: edit.r,
      };
    }

    while (
      this._queuedPredictedBlockEditBatches.length >= MAX_QUEUED_PREDICTED_BLOCK_EDIT_BATCHES ||
      this._queuedPredictedBlockEditCount + edits.length > MAX_QUEUED_PREDICTED_BLOCK_EDITS
    ) {
      const droppedBatch = this._dequeueQueuedPredictedBlockEditBatch();
      if (!droppedBatch) {
        break;
      }

      this.rollbackPredictedBlockEdit(droppedBatch.predictionId);
    }

    this._queuedPredictedBlockEditBatches.push({
      predictionId: data.p,
      edits,
    });
    this._queuedPredictedBlockEditCount += edits.length;

    this.emitWithWorld(this._world, PlayerEvent.BLOCK_EDIT_PREDICTION, {
      player: this,
      predictionId: data.p,
      edits,
    });
  };

  /** @internal */
  private _hasSequencedMovementInput(input: InputSchema): boolean {
    for (const key in input) {
      if (
        key !== 'sq' &&
        isRollbackPredictableInput(key as keyof InputSchema) &&
        this._rollbackPredictedInputSet.has(key as RollbackPredictableInput)
      ) {
        return true;
      }
    }

    return false;
  }

  /** @internal */
  private _advanceRollbackPredictedInputSnapshots(
    nextSnapshot: Readonly<RollbackPredictedInputSnapshot>,
    sequenceNumber?: number,
  ): void {
    replaceRollbackPredictedInputSnapshot(
      this._previousRollbackPredictedInputSnapshot,
      this._rollbackPredictedInputSnapshot,
    );
    replaceRollbackPredictedInputSnapshot(this._rollbackPredictedInputSnapshot, nextSnapshot);
    this._currentRollbackPredictedInputSequenceNumber = sequenceNumber;
  }

  /** @internal */
  private _createRollbackPredictedInputSnapshotFromCurrentInput(): RollbackPredictedInputSnapshot {
    const snapshot: RollbackPredictedInputSnapshot = {};

    for (const inputKey of this._rollbackPredictedInputs) {
      if (inputKey === 'jd') {
        snapshot.jd = this._input.jd ?? null;
        continue;
      }

      snapshot[inputKey] = !!this._input[inputKey];
    }

    return snapshot;
  }

  /** @internal */
  private _createRollbackPredictedInputSnapshotFromQueuedCommand(
    input: SequencedMovementInputCommand['input'],
  ): RollbackPredictedInputSnapshot {
    const snapshot: RollbackPredictedInputSnapshot = {};

    for (const inputKey of this._rollbackPredictedInputs) {
      if (inputKey === 'jd') {
        snapshot.jd = input.jd ?? null;
        continue;
      }

      snapshot[inputKey] = !!input[inputKey];
    }

    return snapshot;
  }

  /** @internal */
  private _enqueueSequencedMovementInputCommand(input: InputSchema): void {
    const inputWithNullableJoystick = input as InputSchema & { jd?: number | null };
    const queuedInput: SequencedMovementInputCommand['input'] = {};

    for (const inputKey of this._rollbackPredictedInputs) {
      if (inputKey === 'jd') {
        queuedInput.jd = inputWithNullableJoystick.jd !== undefined
          ? inputWithNullableJoystick.jd
          : (this._input.jd ?? null);
        continue;
      }

      queuedInput[inputKey] = input[inputKey] ?? !!this._input[inputKey];
    }

    if (input.cp !== undefined) {
      queuedInput.cp = input.cp;
    }

    if (input.cy !== undefined) {
      queuedInput.cy = input.cy;
    }

    const command: SequencedMovementInputCommand = {
      sequenceNumber: input.sq!,
      input: queuedInput,
    };

    if (this._queuedSequencedMovementInputs.length >= MAX_QUEUED_SEQUENCED_MOVEMENT_COMMANDS) {
      this._queuedSequencedMovementInputs.shift();
    }

    this._queuedSequencedMovementInputs.push(command);
  }

  /** @internal */
  private _dequeueQueuedPredictedBlockEditBatch(): PredictedBlockEditBatch | undefined {
    const batch = this._queuedPredictedBlockEditBatches.shift();

    if (!batch) {
      return undefined;
    }

    this._queuedPredictedBlockEditCount = Math.max(
      0,
      this._queuedPredictedBlockEditCount - batch.edits.length,
    );

    return batch;
  }

  /** @internal */
  private _rollbackPendingPredictedBlockEditBatches(
    batches: readonly PredictedBlockEditBatch[],
  ): void {
    if (!this._world || batches.length === 0) {
      return;
    }

    const predictionIdsToRollback = new Set<string>();

    for (let i = 0; i < batches.length; i++) {
      const predictionId = batches[i].predictionId;

      if (predictionIdsToRollback.has(predictionId)) {
        continue;
      }

      predictionIdsToRollback.add(predictionId);
      this.rollbackPredictedBlockEdit(predictionId);
    }
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
  private _onSyncRequestPacket = (receivedAtUnixMs: number, receivedAtMonotonicMs: number) => {
    if (this._world) {
      this.emitWithWorld(this._world, PlayerEvent.REQUEST_SYNC, {
        player: this,
        receivedAt: receivedAtUnixMs,
        receivedAtMs: receivedAtMonotonicMs,
      });
    }
  };

  /** @internal */
  private _onUIDataSendPacket = (packet: protocol.UIDataSendPacket) => {
    this.ui.emit(PlayerUIEvent.DATA, { playerUI: this.ui, data: packet[1] });
  };
}


 
