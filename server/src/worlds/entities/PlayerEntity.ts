import Entity from '@/worlds/entities/Entity';
import ErrorHandler from '@/errors/ErrorHandler';
import { PlayerEvent } from '@/players/Player';
import SceneUI from '@/worlds/ui/SceneUI';
import type Player from '@/players/Player';
import type { EntityOptions } from '@/worlds/entities/Entity';
import type QuaternionLike from '@/shared/types/math/QuaternionLike';
import type Vector3Like from '@/shared/types/math/Vector3Like';
import type World from '@/worlds/World';

/** @internal */
export const PLAYER_POSITION_UPDATE_THRESHOLD_SQ = 0.1 * 0.1;

/** @internal */
export const PLAYER_ROTATION_UPDATE_THRESHOLD = Math.cos(0.052 / 2); // 0.052 radians ~= 3 degrees

/**
 * Options for creating a PlayerEntity instance.
 *
 * Use for: creating a player-bound entity (requires `player`).
 * Do NOT use for: non-player entities; use `EntityOptions`.
 *
 * **Category:** Entities
 * @public
 */
export type PlayerEntityOptions = {
  /** The player the player entity is assigned to. */
  player: Player;
} & EntityOptions;

/**
 * Represents an entity controlled by a player in a world.
 *
 * When to use: custom player avatars that respond to player input.
 * Do NOT use for: non-player NPCs; use `Entity` with a controller instead.
 *
 * @remarks
 * Player entities extend `Entity`. They expect a controller to be set before spawning.
 * Without a controller, player input cannot be processed.
 *
 * @example
 * ```typescript
 * world.onPlayerJoin = player => {
 *   const playerEntity = new PlayerEntity({
 *     player,
 *     name: 'Player',
 *     modelUri: 'models/players/player.gltf',
 *     modelAnimations: [
 *       { name: 'idle-lower', loopMode: EntityModelAnimationLoopMode.LOOP, play: true },
 *       { name: 'idle-upper', loopMode: EntityModelAnimationLoopMode.LOOP, play: true },
 *     ],
 *     modelScale: 0.5,
 *   });
 *
 *   playerEntity.spawn(world, { x: 10, y: 20, z: 15 });
 * };
 * ```
 *
 * **Category:** Entities
 * @public
 */
export default class PlayerEntity extends Entity {
  /**
   * The player this entity is assigned to and controlled by.
   *
   * **Category:** Entities
   */
  public readonly player: Player;

  /**
   * The SceneUI instance for the player entity's nametag.
   *
   * **Category:** Entities
   */
  public readonly nametagSceneUI: SceneUI;

  /** @internal */
  private _tickWithPlayerInputEnabled: boolean = true;

  /**
   * Creates a new PlayerEntity instance.
   * 
   * @remarks
   * **Nametag:** A `nametagSceneUI` is automatically created using the built-in `hytopia:nametag` template
   * with the player's username and profile picture. Access via `nametagSceneUI` property to customize.
   * 
   * @param options - The options for the player entity.
   *
   * **Category:** Entities
   */
  public constructor(options: PlayerEntityOptions) {
    super(options);

    // Player entities need more sensitive thresholds for responsive updates
    this._positionUpdateThresholdSq = PLAYER_POSITION_UPDATE_THRESHOLD_SQ;
    this._rotationUpdateThreshold = PLAYER_ROTATION_UPDATE_THRESHOLD;

    this.player = options.player;
    this.nametagSceneUI = new SceneUI({
      templateId: 'hytopia:nametag',
      attachedToEntity: this,
      offset: { x: 0, y: 1, z: 0 },
      viewDistance: 15,
      state: {
        username: this.player.username,
        profilePictureUrl: this.player.profilePictureUrl,
      },
    });
  }

  /**
   * Whether `tickWithPlayerInput()` is called during the entity's tick.
   *
   * **Category:** Entities
   */
  public get isTickWithPlayerInputEnabled(): boolean { return this._tickWithPlayerInputEnabled; }

  /**
   * Enables or disables `tickWithPlayerInput()` during the entity's tick.
   *
   * Use for: temporarily disabling player control (cutscenes, menus, stuns).
   *
   * @param enabled - Whether `tickWithPlayerInput()` should be called.
   *
   * **Category:** Entities
   */  
  public setTickWithPlayerInputEnabled(enabled: boolean) {
    this._tickWithPlayerInputEnabled = enabled;
  }

  /** @internal */  
  public spawn(world: World, position: Vector3Like, rotation?: QuaternionLike) {
    super.spawn(world, position, rotation);

    this.nametagSceneUI.load(world);

    this.player.on(PlayerEvent.CHAT_MESSAGE_SEND, ({ message }) => {
      this.nametagSceneUI.setState({ chat: message });
    });
  }

  /** @internal */
  public tick(tickDeltaMs: number) {
    if (!this.isSpawned || !this.world) {
      return;
    };

    if (!this.controller) {
      return ErrorHandler.error(`PlayerEntity.tick(): PlayerEntity "${this.name}" must have a controller.`);
    }

    if (this._tickWithPlayerInputEnabled) {
      const { input, camera } = this.player;

      this.controller.tickWithPlayerInput(this, input, camera.orientation, tickDeltaMs);
    }

    this.player.markInputAppliedForSimulation();

    super.tick(tickDeltaMs);
  }
}
