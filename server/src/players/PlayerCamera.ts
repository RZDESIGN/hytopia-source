import protocol from '@hytopia.com/server-protocol';
import ErrorHandler from '@/errors/ErrorHandler';
import EventRouter from '@/events/EventRouter';
import Serializer from '@/networking/Serializer';
import type Entity from '@/worlds/entities/Entity';
import type Player from '@/players/Player';
import type QuaternionLike from '@/shared/types/math/QuaternionLike';
import type Vector3Like from '@/shared/types/math/Vector3Like';
import { WorldLoopEvent } from '@/worlds/WorldLoop';
import type World from '@/worlds/World';

/**
 * The mode of the camera.
 *
 * **Category:** Players
 * @public
 */
export enum PlayerCameraMode {
  FIRST_PERSON = 0,
  THIRD_PERSON = 1,
  SPECTATOR = 2,
}

/**
 * The camera orientation state of a Player.
 *
 * **Category:** Players
 * @public
 */
export type PlayerCameraOrientation = { pitch: number, yaw: number };

/**
 * Common high-level camera presets.
 *
 * **Category:** Players
 * @public
 */
export enum PlayerCameraPreset {
  FIRST_PERSON = 'first_person',
  THIRD_PERSON = 'third_person',
  ISOMETRIC = 'isometric',
  SIDE_VIEW = 'side_view',
  SIDE_VIEW_2D = 'side_view_2d',
  FIXED_FOLLOW_THIRD_PERSON = 'fixed_follow_third_person',
}

/**
 * How a fixed-follow preset interprets its follow offset.
 *
 * **Category:** Players
 * @public
 */
export enum PlayerCameraPresetOffsetSpace {
  WORLD = 'world',
  ENTITY = 'entity',
}

/**
 * Options for applying a camera preset.
 *
 * **Category:** Players
 * @public
 */
export interface PlayerCameraPresetOptions {
  /**
   * The entity the preset should follow.
   *
   * @remarks
   * Defaults to the currently attached entity, or the player's first spawned player entity.
   */
  followEntity?: Entity;

  /**
   * Additional low-level camera offset for attached first/third-person presets.
   *
   * @remarks
   * This maps to `PlayerCamera.offset`. Fixed-angle presets use `followOffset` instead.
   */
  cameraOffset?: Vector3Like;

  /**
   * World or entity-relative offset used by fixed-angle follow presets.
   */
  followOffset?: Vector3Like;

  /**
   * Whether `followOffset` is interpreted in world space or entity-local space.
   */
  followOffsetSpace?: PlayerCameraPresetOffsetSpace;

  /**
   * Focus point offset relative to the followed entity.
   */
  focusOffset?: Vector3Like;

  /**
   * Whether the camera collides with blocks.
   */
  collidesWithBlocks?: boolean;

  /**
   * Film offset applied after the preset.
   */
  filmOffset?: number;

  /**
   * Forward offset applied after the preset.
   */
  forwardOffset?: number;

  /**
   * Field of view applied after the preset.
   */
  fov?: number;

  /**
   * Shoulder angle applied after the preset.
   */
  shoulderAngle?: number;

  /**
   * Zoom applied after the preset.
   */
  zoom?: number;
}

type DynamicCameraPresetState = {
  followEntity: Entity;
  followOffset: Vector3Like;
  followOffsetSpace: PlayerCameraPresetOffsetSpace;
  focusOffset: Vector3Like;
};

const CAMERA_PRESET_EPSILON = 0.0001;
const ZERO_VECTOR: Vector3Like = { x: 0, y: 0, z: 0 };
const DEFAULT_FIRST_PERSON_CAMERA_OFFSET: Vector3Like = { x: 0, y: 0.5, z: 0 };
const DEFAULT_THIRD_PERSON_CAMERA_OFFSET: Vector3Like = { x: 0, y: 0, z: 0 };
const DEFAULT_FOCUS_OFFSET: Vector3Like = { x: 0, y: 1.2, z: 0 };
const DEFAULT_ISOMETRIC_FOLLOW_OFFSET: Vector3Like = { x: 8, y: 8, z: 8 };
const DEFAULT_SIDE_VIEW_FOLLOW_OFFSET: Vector3Like = { x: 12, y: 3, z: 0 };
const DEFAULT_SIDE_VIEW_2D_FOLLOW_OFFSET: Vector3Like = { x: 22, y: 2.5, z: 0 };
const DEFAULT_FIXED_FOLLOW_THIRD_PERSON_OFFSET: Vector3Like = { x: 0, y: 3.25, z: 6.5 };

const cloneVector3Like = (vector: Vector3Like): Vector3Like => ({
  x: vector.x,
  y: vector.y,
  z: vector.z,
});

const addVector3Like = (a: Vector3Like, b: Vector3Like): Vector3Like => ({
  x: a.x + b.x,
  y: a.y + b.y,
  z: a.z + b.z,
});

const vector3LikeEquals = (
  a: Vector3Like | undefined,
  b: Vector3Like | undefined,
  epsilon: number = CAMERA_PRESET_EPSILON,
): boolean => {
  if (!a || !b) {
    return a === b;
  }

  return Math.abs(a.x - b.x) <= epsilon &&
    Math.abs(a.y - b.y) <= epsilon &&
    Math.abs(a.z - b.z) <= epsilon;
};

const rotateVector3LikeByQuaternion = (
  vector: Vector3Like,
  quaternion: QuaternionLike,
): Vector3Like => {
  const { x, y, z, w } = quaternion;
  const uvx = y * vector.z - z * vector.y;
  const uvy = z * vector.x - x * vector.z;
  const uvz = x * vector.y - y * vector.x;

  const uuvx = y * uvz - z * uvy;
  const uuvy = z * uvx - x * uvz;
  const uuvz = x * uvy - y * uvx;

  return {
    x: vector.x + ((uvx * w) + uuvx) * 2,
    y: vector.y + ((uvy * w) + uuvy) * 2,
    z: vector.z + ((uvz * w) + uuvz) * 2,
  };
};

/**
 * Event types a PlayerCamera can emit.
 *
 * See `PlayerCameraEventPayloads` for the payloads.
 *
 * **Category:** Events
 * @public
 */
export enum PlayerCameraEvent {
  FACE_ENTITY                        = 'PLAYER_CAMERA.FACE_ENTITY',
  FACE_POSITION                      = 'PLAYER_CAMERA.FACE_POSITION',
  SET_ATTACHED_TO_ENTITY             = 'PLAYER_CAMERA.SET_ATTACHED_TO_ENTITY',
  SET_ATTACHED_TO_POSITION           = 'PLAYER_CAMERA.SET_ATTACHED_TO_POSITION',
  SET_COLLIDES_WITH_BLOCKS           = 'PLAYER_CAMERA.SET_COLLIDES_WITH_BLOCKS',
  SET_FILM_OFFSET                    = 'PLAYER_CAMERA.SET_FILM_OFFSET',
  SET_FORWARD_OFFSET                 = 'PLAYER_CAMERA.SET_FORWARD_OFFSET',
  SET_FOV                            = 'PLAYER_CAMERA.SET_FOV',
  SET_MODE                           = 'PLAYER_CAMERA.SET_MODE',
  SET_OFFSET                         = 'PLAYER_CAMERA.SET_OFFSET',
  SET_SHOULDER_ANGLE                 = 'PLAYER_CAMERA.SET_SHOULDER_ANGLE',
  SET_TARGET_ENTITY                  = 'PLAYER_CAMERA.SET_TARGET_ENTITY',
  SET_TARGET_POSITION                = 'PLAYER_CAMERA.SET_TARGET_POSITION',
  SET_VIEW_MODEL                     = 'PLAYER_CAMERA.SET_VIEW_MODEL',
  SET_VIEW_MODEL_HIDDEN_NODES        = 'PLAYER_CAMERA.SET_VIEW_MODEL_HIDDEN_NODES',
  SET_VIEW_MODEL_PITCHES_WITH_CAMERA = 'PLAYER_CAMERA.SET_VIEW_MODEL_PITCHES_WITH_CAMERA',
  SET_VIEW_MODEL_SHOWN_NODES         = 'PLAYER_CAMERA.SET_VIEW_MODEL_SHOWN_NODES',
  SET_VIEW_MODEL_YAWS_WITH_CAMERA    = 'PLAYER_CAMERA.SET_VIEW_MODEL_YAWS_WITH_CAMERA',
  SET_ZOOM                           = 'PLAYER_CAMERA.SET_ZOOM',
}

/**
 * Event payloads for PlayerCamera emitted events.
 *
 * **Category:** Events
 * @public
 */
export interface PlayerCameraEventPayloads {
  /** Emitted when the camera faces an entity (one-time rotation). */
  [PlayerCameraEvent.FACE_ENTITY]:                        { playerCamera: PlayerCamera, entity: Entity }

  /** Emitted when the camera faces a position (one-time rotation). */
  [PlayerCameraEvent.FACE_POSITION]:                      { playerCamera: PlayerCamera, position: Vector3Like }

  /** Emitted when the camera attachment entity is set. */
  [PlayerCameraEvent.SET_ATTACHED_TO_ENTITY]:             { playerCamera: PlayerCamera, entity: Entity }

  /** Emitted when the camera attachment position is set. */
  [PlayerCameraEvent.SET_ATTACHED_TO_POSITION]:           { playerCamera: PlayerCamera, position: Vector3Like }

  /** Emitted when collides with blocks is set. */
  [PlayerCameraEvent.SET_COLLIDES_WITH_BLOCKS]:           { playerCamera: PlayerCamera, collidesWithBlocks: boolean }

  /** Emitted when the film offset of the camera is set. */
  [PlayerCameraEvent.SET_FILM_OFFSET]:                    { playerCamera: PlayerCamera, filmOffset: number }

  /** Emitted when the forward offset of the camera is set. */
  [PlayerCameraEvent.SET_FORWARD_OFFSET]:                 { playerCamera: PlayerCamera, forwardOffset: number }

  /** Emitted when the field of view of the camera is set. */
  [PlayerCameraEvent.SET_FOV]:                            { playerCamera: PlayerCamera, fov: number }

  /** Emitted when the mode of the camera is set. */
  [PlayerCameraEvent.SET_MODE]:                           { playerCamera: PlayerCamera, mode: PlayerCameraMode }

  /** Emitted when the offset of the camera is set. */
  [PlayerCameraEvent.SET_OFFSET]:                         { playerCamera: PlayerCamera, offset: Vector3Like }

  /** Emitted when the shoulder angle of the camera is set. */
  [PlayerCameraEvent.SET_SHOULDER_ANGLE]:                 { playerCamera: PlayerCamera, shoulderAngle: number }

  /** Emitted when the target entity of the camera is set. */
  [PlayerCameraEvent.SET_TARGET_ENTITY]:                  { playerCamera: PlayerCamera, entity: Entity | undefined }

  /** Emitted when the target position of the camera is set. */
  [PlayerCameraEvent.SET_TARGET_POSITION]:                { playerCamera: PlayerCamera, position: Vector3Like | undefined }

  /** Emitted when the view model is set. */
  [PlayerCameraEvent.SET_VIEW_MODEL]:                     { playerCamera: PlayerCamera, viewModelUri: string | undefined }

  /** Emitted when the nodes of the view model are set to be hidden. */
  [PlayerCameraEvent.SET_VIEW_MODEL_HIDDEN_NODES]:        { playerCamera: PlayerCamera, viewModelHiddenNodes: Set<string> }

  /** Emitted when view model pitches with camera is set. */
  [PlayerCameraEvent.SET_VIEW_MODEL_PITCHES_WITH_CAMERA]: { playerCamera: PlayerCamera, viewModelPitchesWithCamera: boolean }
  
  /** Emitted when the nodes of the view model are set to be shown. */
  [PlayerCameraEvent.SET_VIEW_MODEL_SHOWN_NODES]:         { playerCamera: PlayerCamera, viewModelShownNodes: Set<string> }

  /** Emitted when view model yaws with camera is set. */
  [PlayerCameraEvent.SET_VIEW_MODEL_YAWS_WITH_CAMERA]:    { playerCamera: PlayerCamera, viewModelYawsWithCamera: boolean }

  /** Emitted when the zoom of the camera is set. */
  [PlayerCameraEvent.SET_ZOOM]:                           { playerCamera: PlayerCamera, zoom: number }
}

/**
 * The camera for a Player.
 *
 * When to use: controlling a player's view, mode, and camera offsets.
 * Do NOT use for: moving the player or entities; use entity movement APIs.
 *
 * @remarks
 * Access via `Player.camera`. Most operations require the player to be in a world.
 *
 * <h2>Events</h2>
 *
 * This class is an EventRouter, and instances of it emit events with payloads listed under
 * `PlayerCameraEventPayloads`.
 *
 * @example
 * ```typescript
 * // Camera follows player, continuously looks at enemy
 * player.camera.setAttachedToEntity(playerEntity);
 * player.camera.setTargetEntity(enemyEntity);
 * 
 * // Camera at fixed position, continuously looks at player
 * player.camera.setAttachedToPosition({ x: 0, y: 10, z: 0 });
 * player.camera.setTargetEntity(playerEntity);
 * 
 * // Stop targeting, restore manual camera control
 * player.camera.setTargetEntity(undefined);
 * ```
 *
 * **Category:** Players
 * @public
 */
export default class PlayerCamera extends EventRouter implements protocol.Serializable {
  /**
   * The player that the camera belongs to.
   *
   * **Category:** Players
   */
  public readonly player: Player;

  /** @internal */
  private _attachedToEntity: Entity | undefined;

  /** @internal */
  private _attachedToPosition: Vector3Like | undefined;

  /** @internal */
  private _collidesWithBlocks: boolean = true;

  /** @internal */
  private _filmOffset: number = 0;

  /** @internal */
  private _forwardOffset: number = 0;

  /** @internal */
  private _fov: number = 75;

  /** @internal */
  private _mode: PlayerCameraMode = PlayerCameraMode.THIRD_PERSON;

  /** @internal */
  private _offset: Vector3Like = { x: 0, y: 0, z: 0 };

  /** @internal */
  private _orientation: PlayerCameraOrientation = { pitch: 0, yaw: 0 };

  /** @internal */
  private _preset: PlayerCameraPreset | undefined;

  /** @internal */
  private _dynamicPreset: DynamicCameraPresetState | undefined;

  /** @internal */
  private _dynamicPresetLastAttachedPosition: Vector3Like | undefined;

  /** @internal */
  private _dynamicPresetLastTargetPosition: Vector3Like | undefined;

  /** @internal */
  private _presetTickWorld: World | undefined;

  /** @internal */
  private _shoulderAngle: number = 0;

  /** @internal */
  private _targetEntity: Entity | undefined;

  /** @internal */
  private _targetPosition: Vector3Like | undefined;

  /** @internal */
  private _viewModelUri: string | undefined;

  /** @internal */
  private _viewModelHiddenNodes: Set<string> = new Set();

  /** @internal */
  private _viewModelPitchesWithCamera: boolean = false;

  /** @internal */
  private _viewModelShownNodes: Set<string> = new Set();
  
  /** @internal */
  private _viewModelYawsWithCamera: boolean = false;

  /** @internal */
  private _zoom: number = 1;

  /** @internal */
  private readonly _presetTickHandler = () => {
    if (!this._dynamicPreset) {
      this._detachPresetTickListener();
      return;
    }

    if (!this.player.world) {
      this._detachPresetTickListener();
      return;
    }

    if (this._presetTickWorld && this._presetTickWorld !== this.player.world) {
      this._detachPresetTickListener();
    }

    this._ensurePresetTickListener();
    this._syncDynamicPresetCamera();
  };

  /** @internal */
  public constructor(player: Player) {
    super();

    this.player = player;
  }

  /**
   * The entity the camera is attached to.
   *
   * **Category:** Players
   */
  public get attachedToEntity(): Entity | undefined {
    return this._attachedToEntity;
  }

  /**
   * The position the camera is attached to.
   *
   * **Category:** Players
   */
  public get attachedToPosition(): Vector3Like | undefined {
    return this._attachedToPosition;
  }

  /**
   * Whether the camera collides with blocks instead of clipping through them.
   *
   * **Category:** Players
   */
  public get collidesWithBlocks(): boolean {
    return this._collidesWithBlocks;
  }

  /**
   * The facing direction vector of the camera based on its current orientation.
   *
   * **Category:** Players
   */
  public get facingDirection(): Vector3Like {
    return {
      x: -Math.sin(this._orientation.yaw) * Math.cos(this._orientation.pitch),
      y: Math.sin(this._orientation.pitch),
      z: -Math.cos(this._orientation.yaw) * Math.cos(this._orientation.pitch),
    };
  }

  /**
   * The quaternion representing the camera's facing direction.
   *
   * **Category:** Players
   */
  public get facingQuaternion(): QuaternionLike {
    const hp = this._orientation.pitch * 0.5;
    const hy = this._orientation.yaw * 0.5;
    const cp = Math.cos(hp), sp = Math.sin(hp);
    const cy = Math.cos(hy), sy = Math.sin(hy);
    
    return {
      x: sp * cy,
      y: cp * sy,
      z: -sp * sy,
      w: cp * cy,
    };
  }

  /**
   * The film offset of the camera.
   *
   * @remarks
   * Positive shifts right, negative shifts left.
   *
   * **Category:** Players
   */
  public get filmOffset(): number {
    return this._filmOffset;
  }

  /**
   * The forward offset of the camera (first-person mode only).
   *
   * @remarks
   * Positive shifts forward, negative shifts backward.
   *
   * **Category:** Players
   */
  public get forwardOffset(): number {
    return this._forwardOffset;
  }

  /**
   * The field of view of the camera.
   *
   * **Category:** Players
   */
  public get fov(): number {
    return this._fov;
  }

  /**
   * Model nodes that will not be rendered for this player.
   *
   * @remarks
   * Uses case-insensitive substring matching.
   *
   * **Category:** Players
   */
  public get modelHiddenNodes(): Set<string> {
    return this._viewModelHiddenNodes;
  }

  /**
   * Model nodes that will be rendered for this player, overriding hidden nodes.
   *
   * @remarks
   * Uses case-insensitive substring matching.
   *
   * **Category:** Players
   */
  public get modelShownNodes(): Set<string> {
    return this._viewModelShownNodes;
  }

  /**
   * The mode of the camera.
   *
   * **Category:** Players
   */
  public get mode(): PlayerCameraMode {
    return this._mode;
  }

  /**
   * The relative offset of the camera from its attachment target.
   *
   * **Category:** Players
   */
  public get offset(): Vector3Like {
    return this._offset;
  }

  /**
   * The current orientation of the camera.
   *
   * @remarks
   * Updated by client input; there is no public setter.
   *
   * **Category:** Players
   */
  public get orientation(): PlayerCameraOrientation {
    return this._orientation;
  }

  /**
   * The currently active high-level preset, if any.
   *
   * **Category:** Players
   */
  public get preset(): PlayerCameraPreset | undefined {
    return this._preset;
  }

  /** @internal */
  public get dynamicPresetState(): DynamicCameraPresetState | undefined {
    return this._dynamicPreset;
  }

  /**
   * The shoulder angle of the camera in degrees.
   *
   * **Category:** Players
   */
  public get shoulderAngle(): number {
    return this._shoulderAngle;
  }

  /**
   * The entity the camera continuously rotates to face.
   *
   * **Category:** Players
   */
  public get targetEntity(): Entity | undefined {
    return this._targetEntity;
  }

  /**
   * The position the camera continuously rotates to face.
   *
   * **Category:** Players
   */
  public get targetPosition(): Vector3Like | undefined {
    return this._targetPosition;
  }

  /**
   * The URI of the view model.
   *
   * @remarks
   * If not set, defaults to using attached entity's model uri.
   * If no entity is attached, returns `undefined`.
   *
   * **Category:** Players
   */
  public get viewModelUri(): string | undefined {
    return this._viewModelUri ?? this._attachedToEntity?.modelUri;
  }

  /**
   * Node substrings to hide on the view model (or attached entity's model).
   *
   * **Category:** Players
   */
  public get viewModelHiddenNodes(): Set<string> {
    return this._viewModelHiddenNodes;
  }

  /**
   * Whether the view model pitches up/down with the camera orientation.
   *
   * **Category:** Players
   */
  public get viewModelPitchesWithCamera(): boolean {
    return this._viewModelPitchesWithCamera;
  }

  /**
   * Node substrings to show on the view model (or attached entity's model).
   *
   * **Category:** Players
   */
  public get viewModelShownNodes(): Set<string> {
    return this._viewModelShownNodes;
  }
  
  /**
   * Whether the view model yaws left/right with the camera orientation.
   *
   * **Category:** Players
   */
  public get viewModelYawsWithCamera(): boolean {
    return this._viewModelYawsWithCamera;
  }

  /**
   * The zoom of the camera.
   *
   * **Category:** Players
   */
  public get zoom(): number {
    return this._zoom;
  }

  /**
   * Clears the active preset and stops any automatic fixed-follow updates.
   *
   * **Category:** Players
   */
  public clearPreset() {
    this._preset = undefined;
    this._dynamicPreset = undefined;
    this._dynamicPresetLastAttachedPosition = undefined;
    this._dynamicPresetLastTargetPosition = undefined;
    this._detachPresetTickListener();
  }

  /**
   * Applies a high-level camera preset.
   *
   * @remarks
   * Fixed-angle presets are implemented on the server by continuously updating
   * `attachedToPosition` and `targetPosition`, so they work with the current client
   * protocol without requiring a separate camera runtime mode.
   *
   * `SIDE_VIEW_2D` requests the client orthographic renderer preset by sending a
   * non-positive FOV. Pair it with custom movement and art rules if you want a
   * fully 2D game feel.
   *
   * **Category:** Players
   */
  public setPreset(preset: PlayerCameraPreset, options: PlayerCameraPresetOptions = {}) {
    if (!this._requirePlayerWorld('setPreset')) { return; }

    this.clearPreset();

    let applied = false;

    switch (preset) {
      case PlayerCameraPreset.FIRST_PERSON:
        applied = this._applyAttachedEntityPreset(PlayerCameraMode.FIRST_PERSON, {
          ...options,
          cameraOffset: options.cameraOffset ?? DEFAULT_FIRST_PERSON_CAMERA_OFFSET,
          collidesWithBlocks: options.collidesWithBlocks ?? true,
          filmOffset: options.filmOffset ?? 0,
          forwardOffset: options.forwardOffset ?? 0,
          fov: options.fov ?? 75,
          shoulderAngle: options.shoulderAngle ?? 0,
          zoom: options.zoom ?? 1,
        });
        break;
      case PlayerCameraPreset.THIRD_PERSON:
        applied = this._applyAttachedEntityPreset(PlayerCameraMode.THIRD_PERSON, {
          ...options,
          cameraOffset: options.cameraOffset ?? DEFAULT_THIRD_PERSON_CAMERA_OFFSET,
          collidesWithBlocks: options.collidesWithBlocks ?? true,
          filmOffset: options.filmOffset ?? 0,
          forwardOffset: options.forwardOffset ?? 0,
          fov: options.fov ?? 75,
          shoulderAngle: options.shoulderAngle ?? 0,
          zoom: options.zoom ?? 1,
        });
        break;
      case PlayerCameraPreset.ISOMETRIC:
        applied = this._applyDynamicPreset({
          ...options,
          collidesWithBlocks: options.collidesWithBlocks ?? false,
          filmOffset: options.filmOffset ?? 0,
          focusOffset: options.focusOffset ?? DEFAULT_FOCUS_OFFSET,
          followOffset: options.followOffset ?? DEFAULT_ISOMETRIC_FOLLOW_OFFSET,
          followOffsetSpace: options.followOffsetSpace ?? PlayerCameraPresetOffsetSpace.WORLD,
          forwardOffset: options.forwardOffset ?? 0,
          fov: options.fov ?? 35,
          shoulderAngle: options.shoulderAngle ?? 0,
          zoom: options.zoom ?? 1,
        });
        break;
      case PlayerCameraPreset.SIDE_VIEW:
        applied = this._applyDynamicPreset({
          ...options,
          collidesWithBlocks: options.collidesWithBlocks ?? false,
          filmOffset: options.filmOffset ?? 0,
          focusOffset: options.focusOffset ?? DEFAULT_FOCUS_OFFSET,
          followOffset: options.followOffset ?? DEFAULT_SIDE_VIEW_FOLLOW_OFFSET,
          followOffsetSpace: options.followOffsetSpace ?? PlayerCameraPresetOffsetSpace.WORLD,
          forwardOffset: options.forwardOffset ?? 0,
          fov: options.fov ?? 30,
          shoulderAngle: options.shoulderAngle ?? 0,
          zoom: options.zoom ?? 1,
        });
        break;
      case PlayerCameraPreset.SIDE_VIEW_2D:
        applied = this._applyDynamicPreset({
          ...options,
          collidesWithBlocks: options.collidesWithBlocks ?? false,
          filmOffset: options.filmOffset ?? 0,
          focusOffset: options.focusOffset ?? DEFAULT_FOCUS_OFFSET,
          followOffset: options.followOffset ?? DEFAULT_SIDE_VIEW_2D_FOLLOW_OFFSET,
          followOffsetSpace: options.followOffsetSpace ?? PlayerCameraPresetOffsetSpace.WORLD,
          forwardOffset: options.forwardOffset ?? 0,
          fov: options.fov ?? 0,
          shoulderAngle: options.shoulderAngle ?? 0,
          zoom: options.zoom ?? 1.4,
        });
        break;
      case PlayerCameraPreset.FIXED_FOLLOW_THIRD_PERSON:
        applied = this._applyDynamicPreset({
          ...options,
          collidesWithBlocks: options.collidesWithBlocks ?? false,
          filmOffset: options.filmOffset ?? 0,
          focusOffset: options.focusOffset ?? DEFAULT_FOCUS_OFFSET,
          followOffset: options.followOffset ?? DEFAULT_FIXED_FOLLOW_THIRD_PERSON_OFFSET,
          followOffsetSpace: options.followOffsetSpace ?? PlayerCameraPresetOffsetSpace.ENTITY,
          forwardOffset: options.forwardOffset ?? 0,
          fov: options.fov ?? 55,
          shoulderAngle: options.shoulderAngle ?? 0,
          zoom: options.zoom ?? 1,
        });
        break;
      default:
        applied = false;
        break;
    }

    if (applied) {
      this._preset = preset;
    }
  }

  /**
   * Makes the camera look at an entity once.
   *
   * Use for: one-off focus moments (e.g., cutscene beats).
   * Do NOT use for: continuous tracking; use `PlayerCamera.setTrackedEntity`.
   *
   * @param entity - The entity to look at.
   *
   * **Requires:** Player must be in a world.
   *
   * **Side effects:** Emits `PlayerCameraEvent.LOOK_AT_ENTITY`.
   *
   * **Category:** Players
   */
  public faceEntity(entity: Entity) {
    if (!this._requirePlayerWorld('faceEntity')) { return; }

    this._targetEntity = undefined;
    this._targetPosition = undefined;

    this.emitWithWorld(this.player.world!, PlayerCameraEvent.FACE_ENTITY, {
      playerCamera: this,
      entity,
    });
  }

  /**
   * Makes the camera look at a position once.
   *
   * Use for: one-off focus moments (e.g., points of interest).
   * Do NOT use for: continuous tracking; use `PlayerCamera.setTrackedPosition`.
   *
   * @param position - The position to look at.
   *
   * **Requires:** Player must be in a world.
   *
   * **Side effects:** Emits `PlayerCameraEvent.LOOK_AT_POSITION`.
   *
   * **Category:** Players
   */
  public facePosition(position: Vector3Like) {
    if (!this._requirePlayerWorld('facePosition')) { return; }

    this._targetEntity = undefined;
    this._targetPosition = undefined;

    this.emitWithWorld(this.player.world!, PlayerCameraEvent.FACE_POSITION, {
      playerCamera: this,
      position,
    });
  }

  /**
   * Resets the camera state on the server.
   *
   * Use for: clearing camera state on disconnect or reconnect.
   *
   * @remarks
   * Clears `attachedToEntity`, `attachedToPosition`, `orientation`, `trackedEntity`, and `trackedPosition`.
   * This does not emit a camera event; it only resets server-side state.
   *
   * **Category:** Players
   */
  public reset() {
    this.clearPreset();
    this._attachedToEntity = undefined;
    this._attachedToPosition = undefined;
    this._orientation = { pitch: 0, yaw: 0 };
    this._targetEntity = undefined;
    this._targetPosition = undefined;
  }

  /**
   * Attaches the camera to an entity.
   *
   * Use for: third-person follow cameras or entity-bound views.
   * Do NOT use for: tracking an entity without attachment; use `PlayerCamera.setTrackedEntity`.
   *
   * @param entity - The entity to attach the camera to (must be spawned).
   *
   * **Requires:** Player must be in a world.
   *
   * **Side effects:** Emits `PlayerCameraEvent.SET_ATTACHED_TO_ENTITY`.
   *
   * **Category:** Players
   */
  public setAttachedToEntity(entity: Entity) {
    if (!this._requirePlayerWorld('setAttachedToEntity')) { return; }
    
    if (!entity.isSpawned) {
      return ErrorHandler.error(`PlayerCamera.setAttachedToEntity(): Entity ${entity.id} is not spawned!`);
    }

    if (this._targetEntity === entity) {
      return ErrorHandler.error(`PlayerCamera.setAttachedToEntity(): Entity ${entity.id} is already set as the target. Attachment and target cannot be the same!`);
    }

    this._attachedToEntity = entity;
    this._attachedToPosition = undefined;

    this.emitWithWorld(this.player.world!, PlayerCameraEvent.SET_ATTACHED_TO_ENTITY, {
      playerCamera: this,
      entity,
    });
  }

  /**
   * Attaches the camera to a world position.
   *
   * Use for: fixed cameras or cinematic shots.
   * Do NOT use for: tracking a moving target; use `PlayerCamera.setTrackedPosition`.
   *
   * @param position - The position to attach the camera to.
   *
   * **Requires:** Player must be in a world.
   *
   * **Side effects:** Emits `PlayerCameraEvent.SET_ATTACHED_TO_POSITION`.
   *
   * **Category:** Players
   */
  public setAttachedToPosition(position: Vector3Like) {
    if (!this._requirePlayerWorld('setAttachedToPosition')) { return; }

    if (position && this._targetPosition?.x === position.x && this._targetPosition?.y === position.y && this._targetPosition?.z === position.z) {
      return ErrorHandler.error(`PlayerCamera.setAttachedToPosition(): Position ${position.x}, ${position.y}, ${position.z} is already set as the target. Attachment and target cannot be the same!`);
    }

    this._attachedToPosition = position;
    this._attachedToEntity = undefined;

    this.emitWithWorld(this.player.world!, PlayerCameraEvent.SET_ATTACHED_TO_POSITION, {
      playerCamera: this,
      position,
    });
  }

  /**
   * Sets whether the camera collides with blocks instead of clipping through them.
   *
   * @param collidesWithBlocks - Whether the camera should collide with blocks.
   *
   * **Category:** Players
   */
  public setCollidesWithBlocks(collidesWithBlocks: boolean) {
    if (!this._requirePlayerWorld('setCollidesWithBlocks')) { return; }

    this._collidesWithBlocks = collidesWithBlocks;

    this.emitWithWorld(this.player.world!, PlayerCameraEvent.SET_COLLIDES_WITH_BLOCKS, {
      playerCamera: this,
      collidesWithBlocks,
    });
  }

  /**
   * Sets the film offset of the camera. A positive value 
   * shifts the camera right, a negative value shifts it left.
   * @param filmOffset - The film offset to set.
   *
   * **Requires:** Player must be in a world.
   *
   * **Side effects:** Emits `PlayerCameraEvent.SET_FILM_OFFSET`.
   *
   * **Category:** Players
   */
  public setFilmOffset(filmOffset: number) {
    if (!this._requirePlayerWorld('setFilmOffset')) { return; }

    this._filmOffset = filmOffset;

    this.emitWithWorld(this.player.world!, PlayerCameraEvent.SET_FILM_OFFSET, {
      playerCamera: this,
      filmOffset,
    });
  }

  /**
   * Sets the forward offset of the camera (first-person mode only).
   *
   * @remarks
   * Positive shifts forward, negative shifts backward.
   *
   * @param forwardOffset - The forward offset to set.
   *
   * **Requires:** Player must be in a world.
   *
   * **Side effects:** Emits `PlayerCameraEvent.SET_FORWARD_OFFSET`.
   *
   * **Category:** Players
   */
  public setForwardOffset(forwardOffset: number) {
    if (!this._requirePlayerWorld('setForwardOffset')) { return; }

    this._forwardOffset = forwardOffset;

    this.emitWithWorld(this.player.world!, PlayerCameraEvent.SET_FORWARD_OFFSET, {
      playerCamera: this,
      forwardOffset,
    });
  }

  /**
   * Sets the field of view of the camera.
   *
   * @param fov - The field of view to set.
   *
   * **Requires:** Player must be in a world.
   *
   * **Side effects:** Emits `PlayerCameraEvent.SET_FOV`.
   *
   * **Category:** Players
   */
  public setFov(fov: number) {
    if (!this._requirePlayerWorld('setFov')) { return; }

    this._fov = fov;

    this.emitWithWorld(this.player.world!, PlayerCameraEvent.SET_FOV, {
      playerCamera: this,
      fov,
    });
  }

  /**
   * Sets the mode of the camera.
   *
   * @param mode - The mode to set.
   *
   * **Requires:** Player must be in a world.
   *
   * **Side effects:** Emits `PlayerCameraEvent.SET_MODE`.
   *
   * **Category:** Players
   */
  public setMode(mode: PlayerCameraMode) {
    if (!this._requirePlayerWorld('setMode')) { return; }

    this._mode = mode;

    this.emitWithWorld(this.player.world!, PlayerCameraEvent.SET_MODE, {
      playerCamera: this,
      mode,
    });
  }

  /**
   * Sets the relative offset of the camera from its attachment target.
   *
   * @param offset - The offset to set.
   *
   * **Requires:** Player must be in a world.
   *
   * **Side effects:** Emits `PlayerCameraEvent.SET_OFFSET`.
   *
   * **Category:** Players
   */
  public setOffset(offset: Vector3Like) {
    if (!this._requirePlayerWorld('setOffset')) { return; }

    this._offset = offset;

    this.emitWithWorld(this.player.world!, PlayerCameraEvent.SET_OFFSET, {
      playerCamera: this,
      offset,
    });
  }

  /** @internal */
  public setOrientationPitch(pitch: number) {
    this._orientation.pitch = pitch;
  }

  /** @internal */
  public setOrientationYaw(yaw: number) {
    this._orientation.yaw = yaw;
  }

  /**
   * Sets the shoulder angle of the camera in degrees (third-person mode only).
   *
   * @remarks
   * Positive shifts right, negative shifts left.
   *
   * @param shoulderAngle - The shoulder angle to set in degrees.
   *
   * **Requires:** Player must be in a world.
   *
   * **Side effects:** Emits `PlayerCameraEvent.SET_SHOULDER_ANGLE`.
   *
   * **Category:** Players
   */
  public setShoulderAngle(shoulderAngle: number) {
    if (!this._requirePlayerWorld('setShoulderAngle')) { return; }

    this._shoulderAngle = shoulderAngle;

    this.emitWithWorld(this.player.world!, PlayerCameraEvent.SET_SHOULDER_ANGLE, {
      playerCamera: this,
      shoulderAngle,
    });
  }
  
  /**
   * Sets the entity the camera will continuously look at.
   *
   * Use for: keeping the camera focused on a moving entity.
   *
   * @param entity - The entity to track, or undefined to stop tracking.
   *
   * **Requires:** Player must be in a world.
   *
   * **Side effects:** Emits `PlayerCameraEvent.SET_TRACKED_ENTITY`.
   *
   * **Category:** Players
   */
  public setTargetEntity(entity: Entity | undefined) {
    if (!this._requirePlayerWorld('setTargetEntity')) { return; }

    if (entity && this._attachedToEntity === entity) {
      return ErrorHandler.error(`PlayerCamera.setTargetEntity(): Entity ${entity.id} is already set as the attachment. Attachment and target cannot be the same!`);
    }

    this._targetEntity = entity;
    if (entity) {
      this._targetPosition = undefined;
    }

    this.emitWithWorld(this.player.world!, PlayerCameraEvent.SET_TARGET_ENTITY, {
      playerCamera: this,
      entity,
    });
  }

  /**
   * Sets the position the camera will continuously look at.
   *
   * Use for: fixed focal points in the scene.
   *
   * @param position - The position to track, or undefined to stop tracking.
   *
   * **Requires:** Player must be in a world.
   *
   * **Side effects:** Emits `PlayerCameraEvent.SET_TRACKED_POSITION`.
   *
   * **Category:** Players
   */
  public setTargetPosition(position: Vector3Like | undefined) {
    if (!this._requirePlayerWorld('setTargetPosition')) { return; }

    if (position && this._attachedToPosition?.x === position.x && this._attachedToPosition?.y === position.y && this._attachedToPosition?.z === position.z) {
      return ErrorHandler.error(`PlayerCamera.setTargetPosition(): Position ${position.x}, ${position.y}, ${position.z} is already set as the attachment. Attachment and target cannot be the same!`);
    }

    this._targetPosition = position;
    if (position) {
      this._targetEntity = undefined;
    }

    this.emitWithWorld(this.player.world!, PlayerCameraEvent.SET_TARGET_POSITION, {
      playerCamera: this,
      position,
    });
  }

  /**
   * Sets a view model for first-person rendering.
   *
   * @remarks
   * The view model is only visible to this camera's player and renders in place of
   * the attached entity's model (e.g., first-person arms/weapon).
   * Animations played on the attached entity automatically sync to
   * this model if animation names match.
   *
   * @param viewModelUri - The model URI, or `undefined` to clear.
   *
   * **Category:** Players
   */
  public setViewModel(viewModelUri: string | undefined) {
    if (!this._requirePlayerWorld('setViewModel')) { return; }

    if (!this._attachedToEntity) {
      return ErrorHandler.error('PlayerCamera.setViewModel(): Camera is not attached to an entity, cannot set view model! Use camera.setAttachedToEntity() first.');
    }

    this._viewModelUri = viewModelUri;

    this.emitWithWorld(this.player.world!, PlayerCameraEvent.SET_VIEW_MODEL, {
      playerCamera: this,
      viewModelUri,
    });
  }

  /**
   * Hides nodes on the view model (or attached entity's model if no view model is set).
   *
   * @remarks
   * Compatibility alias for `setViewModelHiddenNodes`.
   *
   * @param modelHiddenNodes - Node name substrings to hide.
   *
   * **Category:** Players
   */
  public setModelHiddenNodes(modelHiddenNodes: string[]) {
    this.setViewModelHiddenNodes(modelHiddenNodes);
  }

  /**
   * Shows nodes on the view model (or attached entity's model if no view model is set),
   * overriding hidden nodes.
   *
   * @remarks
   * Compatibility alias for `setViewModelShownNodes`.
   *
   * @param modelShownNodes - Node name substrings to show.
   *
   * **Category:** Players
   */
  public setModelShownNodes(modelShownNodes: string[]) {
    this.setViewModelShownNodes(modelShownNodes);
  }

  /**
   * Hides nodes on the view model (or attached entity's model if no view model is set).
   *
   * @remarks
   * Only affects this camera's player. Uses case-insensitive substring matching.
   * Replaces the current set (not a merge).
   *
   * @param viewModelHiddenNodes - Node name substrings to hide.
   *
   * **Category:** Players
   */
  public setViewModelHiddenNodes(viewModelHiddenNodes: string[]) {
    if (!this._requirePlayerWorld('setViewModelHiddenNodes')) { return; }

    this._viewModelHiddenNodes = new Set(viewModelHiddenNodes.map(node => node.toLowerCase()));

    this.emitWithWorld(this.player.world!, PlayerCameraEvent.SET_VIEW_MODEL_HIDDEN_NODES, {
      playerCamera: this,
      viewModelHiddenNodes: this._viewModelHiddenNodes,
    });
  }

  /**
   * Sets whether the view model pitches up/down with the camera orientation.
   *
   * @remarks
   * Useful for first-person view models to tilt when looking up/down.
   *
   * @param viewModelPitchesWithCamera - Whether the view model should pitch with the camera.
   *
   * **Category:** Players
   */
  public setViewModelPitchesWithCamera(viewModelPitchesWithCamera: boolean) {
    if (!this._requirePlayerWorld('setViewModelPitchesWithCamera')) { return; }

    this._viewModelPitchesWithCamera = viewModelPitchesWithCamera;

    this.emitWithWorld(this.player.world!, PlayerCameraEvent.SET_VIEW_MODEL_PITCHES_WITH_CAMERA, {
      playerCamera: this,
      viewModelPitchesWithCamera,
    });
  }

  /**
   * Shows nodes on the view model (or attached entity's model if no view model is set),
   * overriding hidden nodes.
   *
   * @remarks
   * Only affects this camera's player. Uses case-insensitive substring matching.
   * Replaces the current set (not a merge).
   *
   * @param viewModelShownNodes - Node name substrings to show.
   *
   * **Category:** Players
   */
  public setViewModelShownNodes(viewModelShownNodes: string[]) {
    if (!this._requirePlayerWorld('setViewModelShownNodes')) { return; }

    this._viewModelShownNodes = new Set(viewModelShownNodes.map(node => node.toLowerCase()));

    this.emitWithWorld(this.player.world!, PlayerCameraEvent.SET_VIEW_MODEL_SHOWN_NODES, {
      playerCamera: this,
      viewModelShownNodes: this._viewModelShownNodes,
    });
  }

  /**
   * Sets whether the view model yaws left/right with the camera orientation.
   *
   * @remarks
   * Useful for first-person view models to rotate when looking left/right.
   *
   * @param viewModelYawsWithCamera - Whether the view model should yaw with the camera.
   *
   * **Category:** Players
   */
  public setViewModelYawsWithCamera(viewModelYawsWithCamera: boolean) {
    if (!this._requirePlayerWorld('setViewModelYawsWithCamera')) { return; }

    this._viewModelYawsWithCamera = viewModelYawsWithCamera;

    this.emitWithWorld(this.player.world!, PlayerCameraEvent.SET_VIEW_MODEL_YAWS_WITH_CAMERA, {
      playerCamera: this,
      viewModelYawsWithCamera,
    });
  }

  /**
   * Sets the zoom of the camera.
   *
   * @param zoom - The zoom to set, 0 to infinity.
   *
   * **Requires:** Player must be in a world.
   *
   * **Side effects:** Emits `PlayerCameraEvent.SET_ZOOM`.
   *
   * **Category:** Players
   */
  public setZoom(zoom: number) {
    if (!this._requirePlayerWorld('setZoom')) { return; }

    this._zoom = zoom;

    this.emitWithWorld(this.player.world!, PlayerCameraEvent.SET_ZOOM, {
      playerCamera: this,
      zoom,
    });
  }

  /** @internal */
  public serialize(): protocol.CameraSchema {
    return Serializer.serializePlayerCamera(this);
  }

  /** @internal */
  private _requirePlayerWorld(methodName: string): boolean {
    if (!this.player.world) {
      ErrorHandler.error(`PlayerCamera._requirePlayerWorld(): Player ${this.player.id} is not in a world, invoked method: ${methodName}()`);
    }

    return !!this.player.world;
  }

  /** @internal */
  private _applyAttachedEntityPreset(mode: PlayerCameraMode, options: PlayerCameraPresetOptions): boolean {
    const followEntity = this._resolvePresetFollowEntity(options.followEntity);

    if (!followEntity) {
      ErrorHandler.error(`PlayerCamera.setPreset(): No entity is available for preset "${this._presetLabel(mode)}".`);
      return false;
    }

    if (!followEntity.isSpawned) {
      ErrorHandler.error(`PlayerCamera.setPreset(): Entity ${followEntity.id} is not spawned, cannot apply preset "${this._presetLabel(mode)}".`);
      return false;
    }

    this.setTargetEntity(undefined);
    this.setTargetPosition(undefined);
    this.setMode(mode);
    this.setAttachedToEntity(followEntity);
    this.setCollidesWithBlocks(options.collidesWithBlocks ?? this._collidesWithBlocks);
    this.setFilmOffset(options.filmOffset ?? this._filmOffset);
    this.setForwardOffset(options.forwardOffset ?? this._forwardOffset);
    this.setFov(options.fov ?? this._fov);
    this.setOffset(cloneVector3Like(options.cameraOffset ?? this._offset));
    this.setShoulderAngle(options.shoulderAngle ?? this._shoulderAngle);
    this.setZoom(options.zoom ?? this._zoom);

    return true;
  }

  /** @internal */
  private _applyDynamicPreset(options: PlayerCameraPresetOptions): boolean {
    const followEntity = this._resolvePresetFollowEntity(options.followEntity);

    if (!followEntity) {
      ErrorHandler.error('PlayerCamera.setPreset(): No entity is available for the requested fixed-angle preset.');
      return false;
    }

    this.setTargetEntity(undefined);
    this.setTargetPosition(undefined);
    this.setMode(PlayerCameraMode.FIRST_PERSON);
    this.setCollidesWithBlocks(options.collidesWithBlocks ?? false);
    this.setFilmOffset(options.filmOffset ?? 0);
    this.setForwardOffset(options.forwardOffset ?? 0);
    this.setFov(options.fov ?? 75);
    this.setOffset(cloneVector3Like(ZERO_VECTOR));
    this.setShoulderAngle(options.shoulderAngle ?? 0);
    this.setZoom(options.zoom ?? 1);

    this._dynamicPreset = {
      followEntity,
      followOffset: cloneVector3Like(options.followOffset ?? DEFAULT_ISOMETRIC_FOLLOW_OFFSET),
      followOffsetSpace: options.followOffsetSpace ?? PlayerCameraPresetOffsetSpace.WORLD,
      focusOffset: cloneVector3Like(options.focusOffset ?? DEFAULT_FOCUS_OFFSET),
    };

    this._ensurePresetTickListener();
    this._syncDynamicPresetCamera();

    return true;
  }

  /** @internal */
  private _resolvePresetFollowEntity(candidate: Entity | undefined): Entity | undefined {
    if (candidate) {
      return candidate;
    }

    if (this._attachedToEntity) {
      return this._attachedToEntity;
    }

    return this.player.world?.entityManager.getPlayerEntitiesByPlayer(this.player)[0];
  }

  /** @internal */
  private _ensurePresetTickListener(): void {
    const world = this.player.world;

    if (!world) {
      this._detachPresetTickListener();
      return;
    }

    if (this._presetTickWorld === world) {
      return;
    }

    this._detachPresetTickListener();
    world.loop.on(WorldLoopEvent.TICK_START, this._presetTickHandler);
    this._presetTickWorld = world;
  }

  /** @internal */
  private _detachPresetTickListener(): void {
    if (!this._presetTickWorld) {
      return;
    }

    this._presetTickWorld.loop.off(WorldLoopEvent.TICK_START, this._presetTickHandler);
    this._presetTickWorld = undefined;
  }

  /** @internal */
  private _syncDynamicPresetCamera(): void {
    const dynamicPreset = this._dynamicPreset;

    if (!dynamicPreset) {
      return;
    }

    const basePosition = dynamicPreset.followEntity.position;
    const followOffset = dynamicPreset.followOffsetSpace === PlayerCameraPresetOffsetSpace.ENTITY
      ? rotateVector3LikeByQuaternion(dynamicPreset.followOffset, dynamicPreset.followEntity.rotation)
      : dynamicPreset.followOffset;
    const attachedPosition = addVector3Like(basePosition, followOffset);
    const targetPosition = addVector3Like(basePosition, dynamicPreset.focusOffset);

    if (vector3LikeEquals(attachedPosition, targetPosition)) {
      ErrorHandler.error('PlayerCamera._syncDynamicPresetCamera(): Fixed-angle presets require distinct camera and target positions.');
      return;
    }

    if (!vector3LikeEquals(this._dynamicPresetLastAttachedPosition, attachedPosition)) {
      this.setAttachedToPosition(attachedPosition);
      this._dynamicPresetLastAttachedPosition = cloneVector3Like(attachedPosition);
    }

    if (!vector3LikeEquals(this._dynamicPresetLastTargetPosition, targetPosition)) {
      this.setTargetPosition(targetPosition);
      this._dynamicPresetLastTargetPosition = cloneVector3Like(targetPosition);
    }
  }

  /** @internal */
  private _presetLabel(mode: PlayerCameraMode): string {
    switch (mode) {
      case PlayerCameraMode.FIRST_PERSON:
        return PlayerCameraPreset.FIRST_PERSON;
      case PlayerCameraMode.THIRD_PERSON:
        return PlayerCameraPreset.THIRD_PERSON;
      case PlayerCameraMode.SPECTATOR:
      default:
        return 'spectator';
    }
  }
}
