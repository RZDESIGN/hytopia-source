import protocol from '@hytopia.com/server-protocol';
import ErrorHandler from '@/errors/ErrorHandler';
import EventRouter from '@/events/EventRouter';
import Serializer from '@/networking/Serializer';
import type Entity from '@/worlds/entities/Entity';
import type Vector3Like from '@/shared/types/math/Vector3Like';
import type World from '@/worlds/World';

const DEFAULT_REFERENCE_DISTANCE = 5;

/**
 * Options for creating an Audio instance.
 *
 * Positional audio can be configured via `AudioOptions.attachedToEntity` or `AudioOptions.position`.
 *
 * Use for: configuring audio before calling `Audio.play`.
 * Do NOT use for: runtime updates after playback starts; use `Audio.set*` methods.
 *
 * **Category:** Audio
 * @public
 */
export interface AudioOptions {
  /** If set, audio playback will follow the entity's position. */
  attachedToEntity?: Entity;

  /** The cutoff distance between the audio source and the listener where the audio will be reduced to 0 volume. Must be greater than reference distance. Defaults to reference distance + 10. */
  cutoffDistance?: number

  /** The duration of the audio in seconds. Defaults to full duration. */
  duration?: number;

  /** The detuning of the audio in cents. */
  detune?: number;

  /** The amount of distortion to apply to the audio. */
  distortion?: number;

  /** Whether the audio should loop when it reaches the end. Defaults to false. */
  loop?: boolean;

  /** The offset time in seconds from which the audio should start playing. */
  offset?: number;

  /** The position in the world where the audio is played. */
  position?: Vector3Like;

  /** The playback speed of the audio. Defaults to 1. */
  playbackRate?: number;

  /** The maximum reference distance between the audio source and the listener where the audio will still be max volume. Defaults to 10. */
  referenceDistance?: number;

  /** The URI or path to the audio asset to be played. */
  uri: string;

  /** The volume level of the audio. Defaults to 0.5. */
  volume?: number;
}

/**
 * Event types an Audio instance can emit.
 *
 * See `AudioEventPayloads` for the payloads.
 *
 * **Category:** Events
 * @public
 */
export enum AudioEvent {
  PAUSE                  = 'AUDIO.PAUSE',
  PLAY                   = 'AUDIO.PLAY',
  PLAY_RESTART           = 'AUDIO.PLAY_RESTART',
  SET_ATTACHED_TO_ENTITY = 'AUDIO.SET_ATTACHED_TO_ENTITY',
  SET_CUTOFF_DISTANCE    = 'AUDIO.SET_CUTOFF_DISTANCE',
  SET_DETUNE             = 'AUDIO.SET_DETUNE',
  SET_DISTORTION         = 'AUDIO.SET_DISTORTION',
  SET_POSITION           = 'AUDIO.SET_POSITION',
  SET_PLAYBACK_RATE      = 'AUDIO.SET_PLAYBACK_RATE',
  SET_REFERENCE_DISTANCE = 'AUDIO.SET_REFERENCE_DISTANCE',
  SET_VOLUME             = 'AUDIO.SET_VOLUME',
  UNLOAD                 = 'AUDIO.UNLOAD',
}

/**
 * Event payloads for Audio emitted events.
 *
 * **Category:** Events
 * @public
 */
export interface AudioEventPayloads {
  /** Emitted when the audio is paused. */
  [AudioEvent.PAUSE]:                  { audio: Audio }

  /** Emitted when the audio is played. */
  [AudioEvent.PLAY]:                   { audio: Audio }

  /** Emitted when the audio is restarted. */
  [AudioEvent.PLAY_RESTART]:           { audio: Audio }

  /** Emitted when the audio is attached to an entity. */
  [AudioEvent.SET_ATTACHED_TO_ENTITY]: { audio: Audio, entity: Entity | undefined }

  /** Emitted when the audio's cutoff distance is set. */
  [AudioEvent.SET_CUTOFF_DISTANCE]:    { audio: Audio, cutoffDistance: number }

  /** Emitted when the audio's detune is set. */
  [AudioEvent.SET_DETUNE]:             { audio: Audio, detune: number }

  /** Emitted when the audio's distortion is set. */
  [AudioEvent.SET_DISTORTION]:         { audio: Audio, distortion: number }

  /** Emitted when the audio's position is set. */
  [AudioEvent.SET_POSITION]:           { audio: Audio, position: Vector3Like }

  /** Emitted when the audio's playback rate is set. */
  [AudioEvent.SET_PLAYBACK_RATE]:      { audio: Audio, playbackRate: number }

  /** Emitted when the audio's reference distance is set. */
  [AudioEvent.SET_REFERENCE_DISTANCE]: { audio: Audio, referenceDistance: number }

  /** Emitted when the audio's volume is set. */
  [AudioEvent.SET_VOLUME]:             { audio: Audio, volume: number }

  /** Emitted when the audio is removed from the world audio manager. */
  [AudioEvent.UNLOAD]:                 { audio: Audio }
}

/**
 * Represents a audio playback in a world.
 * 
 * @remarks
 * Audio instances are created directly as instances.
 * They support a variety of configuration options through
 * the `AudioOptions` constructor argument.
 * 
 * <h2>Events</h2>
 * 
 * This class is an EventRouter, and instances of it emit
 * events with payloads listed under `AudioEventPayloads`
 * 
 * @example
 * ```typescript
 * (new Audio({
 *   uri: 'music/song.mp3', // relative to the server's assets directory in the project root, resolves to assets/music/song.mp3
 *   loop: true,
 *   volume: 0.5,
 * })).play(world);
 * ```
 * 
 * @eventProperty
 * 
 * **Category:** Audio
 * @public
 */
export default class Audio extends EventRouter implements protocol.Serializable {
  /** @internal */
  private _id: number | undefined;

  /** @internal */
  private _attachedToEntity: Entity | undefined;

  /** @internal */
  private _cutoffDistance: number;

  /** @internal */
  private _duration: number | undefined;

  /** @internal */
  private _detune: number;

  /** @internal */
  private _distortion: number;

  /** @internal */
  private _loop: boolean;

  /** @internal */
  private _offset: number;

  /** @internal */
  private _position: Vector3Like | undefined;

  /** @internal */
  private _playbackRate: number;

  /** @internal */
  private _playing: boolean;

  /** @internal */
  private _referenceDistance: number;

  /** @internal */
  private _startTick: number | undefined;

  /** @internal */
  private _uri: string;

  /** @internal */
  private _volume: number;

  /** @internal */
  private _world: World | undefined;

  /**
   * @param options - The options for the Audio instance.
   */
  public constructor(options: AudioOptions) {
    super();

    this._attachedToEntity = options.attachedToEntity;
    this._cutoffDistance = options.cutoffDistance ?? (this.isPositional ? (options.referenceDistance ?? DEFAULT_REFERENCE_DISTANCE) + 10 : 0);
    this._duration = options.duration;
    this._detune = options.detune ?? 0;
    this._distortion = options.distortion ?? 0;
    this._loop = options.loop ?? false;
    this._offset = options.offset ?? 0;
    this._position = options.position;
    this._playing = false;
    this._playbackRate = options.playbackRate ?? 1;
    this._referenceDistance = options.referenceDistance ?? (this.isPositional ? DEFAULT_REFERENCE_DISTANCE : 0);
    this._uri = options.uri;
    this._volume = options.volume ?? 0.5;
  }

  /** The unique identifier for the audio. */
  public get id(): number | undefined { return this._id; }

  /** The entity to which the audio is attached if explicitly set. */
  public get attachedToEntity(): Entity | undefined { return this._attachedToEntity; }

  /** The cutoff distance where the audio will be reduced to 0 volume. */
  public get cutoffDistance(): number { return this._cutoffDistance; }

  /** The duration of the audio in seconds if explicitly set. */
  public get duration(): number | undefined { return this._duration; }

  /** The detune of the audio in cents if explicitly set. */
  public get detune(): number | undefined { return this._detune; }

  /** The amount of distortion to apply to the audio if explicitly set. */
  public get distortion(): number | undefined { return this._distortion; }

  /** Whether the audio is looped. */
  public get loop(): boolean { return this._loop; }

  /** The offset time in seconds from which the audio should start playing if explicitly set. */
  public get offset(): number | undefined { return this._offset; }

  /** Whether the audio has loaded into the world. Audio is loaded the first time play() is called. */
  public get isLoaded(): boolean { return this._id !== undefined; }

  /** Whether the audio is currently playing. */
  public get isPlaying(): boolean { return this._playing; }

  /** Whether the audio is positional (Entity or position attached). */
  public get isPositional(): boolean { return this._attachedToEntity !== undefined || this._position !== undefined; }

  /** The position of the audio in the world if explicitly set. */
  public get position(): Vector3Like | undefined { return this._position; }

  /** The playback rate of the audio if explicitly set. */
  public get playbackRate(): number | undefined { return this._playbackRate; }

  /** The reference distance of the audio if explicitly set. */
  public get referenceDistance(): number { return this._referenceDistance; }

  /** The server tick at which the audio started playing. */
  public get startTick(): number | undefined { return this._startTick; }

  /** The URI of the audio asset. */
  public get uri(): string { return this._uri; }

  /** The volume of the audio if explicitly set. */
  public get volume(): number | undefined { return this._volume; }

  /** The world the audio is in if already loaded. */
  public get world(): World | undefined { return this._world; }

  /**
   * Plays or resumes the audio.
   * 
   * @param world - The world to play the audio in.
   * @param restart - If true, the audio will restart from the beginning if it is already playing.
   */
  public play(world: World, restart: boolean = false) {
    if (this.isPlaying && !restart) return;

    if (this._attachedToEntity && !this._attachedToEntity.isSpawned) {
      return ErrorHandler.error(`Audio.play(): Attached entity ${this._attachedToEntity.id} is not spawned!`);
    }

    const eventType = restart && this._id !== undefined
      ? AudioEvent.PLAY_RESTART
      : AudioEvent.PLAY;

    this._id ??= world.audioManager.registerAudio(this);
    this._playing = true;
    this._startTick = world.loop.currentTick;
    this._world = this._world ?? world;

    this.emitWithWorld(world, eventType, { audio: this });
  }

  /**
   * Pauses the audio.
   */
  public pause() {
    if (!this.isPlaying || !this._world) {
      return;
    }

    this._playing = false;

    this.emitWithWorld(this._world, AudioEvent.PAUSE, { audio: this });
  }

  /**
   * Sets the entity to which the audio is attached, following its position.
   * 
   * @remarks
   * **Clears position:** Setting an attached entity clears any previously set `position`.
   * Audio can be entity-attached or position-based, not both.
   * 
   * @param entity - The entity to attach the Audio to.
   */
  public setAttachedToEntity(entity: Entity) {
    if (!this._requirePositional()) { return; }

    if (!entity.isSpawned) {
      return ErrorHandler.error(`Audio.setAttachedToEntity(): Entity ${entity.id} is not spawned!`);
    }

    if (this._attachedToEntity === entity) { return; }

    this._attachedToEntity = entity;
    this._position = undefined;

    if (this.isLoaded && this._world) {
      this.emitWithWorld(this._world, AudioEvent.SET_ATTACHED_TO_ENTITY, {
        audio: this,
        entity,
      });
    }
  }

  /**
   * Sets the cutoff distance of the audio.
   * 
   * @remarks
   * The cutoff distance defines the maximum range at which the audio can be heard.
   * Beyond this distance, the audio volume becomes zero. As the listener moves
   * from the reference distance toward the cutoff distance, the volume decreases
   * linearly, providing a natural spatial audio experience with smooth volume
   * falloff based on distance.
   * 
   * @param cutoffDistance - The cutoff distance.
   */
  public setCutoffDistance(cutoffDistance: number) {
    if (!this._requirePositional()) { return; }

    if (cutoffDistance <= 0 || cutoffDistance < this._referenceDistance) {
      return ErrorHandler.error('Audio.setCutoffDistance(): Cutoff distance cannot be less than or equal to 0 or less than reference distance!');
    }

    if (this._cutoffDistance === cutoffDistance) { return; }

    this._cutoffDistance = cutoffDistance;

    if (this.isLoaded && this._world) {
      this.emitWithWorld(this._world, AudioEvent.SET_CUTOFF_DISTANCE, {
        audio: this,
        cutoffDistance,
      });
    }
  }

  /**
   * Sets the detune of the audio.
   * 
   * @param detune - The detune in cents.
   */
  public setDetune(detune: number) {
    if (this._detune === detune) { return; }

    this._detune = detune;

    if (this.isLoaded && this._world) {
      this.emitWithWorld(this._world, AudioEvent.SET_DETUNE, {
        audio: this,
        detune,
      });
    }
  }

  /**
   * Sets the distortion of the audio.
   * 
   * @param distortion - The distortion amount.
   */
  public setDistortion(distortion: number) {
    if (distortion < 0) {
      return ErrorHandler.error('Distortion cannot be less than 0');
    }

    if (this._distortion === distortion) { return; }

    this._distortion = distortion;

    if (this.isLoaded && this._world) {
      this.emitWithWorld(this._world, AudioEvent.SET_DISTORTION, {
        audio: this,
        distortion,
      });
    }
  }

  /**
   * Sets the position of the audio.
   * 
   * @remarks
   * **Detaches from entity:** Setting a position clears any `attachedToEntity`.
   * Audio can be position-based or entity-attached, not both.
   * 
   * @param position - The position in the world.
   */
  public setPosition(position: Vector3Like) {
    if (!this._requirePositional()) { return; }

    if (this._position === position) { return; }

    this._attachedToEntity = undefined;
    this._position = position;

    if (this.isLoaded && this._world) {
      this.emitWithWorld(this._world, AudioEvent.SET_POSITION, {
        audio: this,
        position,
      });
    }
  }

  /**
   * Sets the playback rate of the audio.
   * 
   * @param playbackRate - The playback rate.
   */
  public setPlaybackRate(playbackRate: number) {
    if (playbackRate <= 0) {
      return ErrorHandler.error('Playback rate cannot be less than or equal to 0');
    }

    if (this._playbackRate === playbackRate) { return; }

    this._playbackRate = playbackRate;

    if (this.isLoaded && this._world) {
      this.emitWithWorld(this._world, AudioEvent.SET_PLAYBACK_RATE, {
        audio: this,
        playbackRate,
      });
    }
  }

  /**
   * Sets the reference distance of the audio.
   * 
   * @remarks
   * The reference distance defines the range within which the audio plays at
   * full volume. When a listener is within this distance from the audio source,
   * they will hear the sound at its maximum volume. Beyond this distance, the
   * volume decreases linearly until reaching the cutoff distance, where the
   * sound becomes inaudible. This creates a natural spatial audio experience
   * with smooth volume falloff based on distance.
   * 
   * @param referenceDistance - The reference distance.
   */
  public setReferenceDistance(referenceDistance: number) {
    if (!this._requirePositional()) { return; }

    if (referenceDistance <= 0) {
      return ErrorHandler.error('Reference distance cannot be less than or equal to 0');
    }

    if (this._referenceDistance === referenceDistance) { return; }

    this._referenceDistance = referenceDistance;

    if (this.isLoaded && this._world) {
      this.emitWithWorld(this._world, AudioEvent.SET_REFERENCE_DISTANCE, {
        audio: this,
        referenceDistance,
      });
    }
  }

  /**
   * Sets the volume of the audio.
   * 
   * @param volume - The volume level.
   */
  public setVolume(volume: number) {
    if (volume < 0 || volume > 1) {
      return ErrorHandler.error('Volume must be between 0 and 1');
    }

    if (this._volume === volume) { return; }

    this._volume = volume;

    if (this.isLoaded && this._world) {
      this.emitWithWorld(this._world, AudioEvent.SET_VOLUME, {
        audio: this,
        volume,
      });
    }
  }

  /** @internal */
  public serialize(): protocol.AudioSchema {
    return Serializer.serializeAudio(this);
  }

  /** @internal */
  private _requirePositional() {
    if (!this.isPositional) {
      ErrorHandler.error('Audio._requirePositional(): Audio is not positional. and therefor does not support the invoked method.');
    }

    return this.isPositional;
  }
}
