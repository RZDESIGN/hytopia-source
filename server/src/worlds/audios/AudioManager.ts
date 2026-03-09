import ErrorHandler from '@/errors/ErrorHandler';
import { AudioEvent } from '@/worlds/audios/Audio';
import type Audio from '@/worlds/audios/Audio';
import type Entity from '@/worlds/entities/Entity';
import type World from '@/worlds/World';

/**
 * Manages audio instances in a world.
 *
 * When to use: querying or bulk-controlling audio in a specific world.
 * Do NOT use for: individual playback configuration; use `Audio` instances.
 *
 * @remarks
 * The AudioManager is created internally per `World` instance.
 * Audio is loaded on first `Audio.play`; this manager tracks loaded instances.
 * Pattern: call `AudioManager.unregisterEntityAttachedAudios` when despawning entities with positional audio.
 *
 * @example
 * ```typescript
 * // Stop all audio in the world
 * const audioManager = world.audioManager;
 * audioManager.getAllAudios().forEach(audio => audio.pause());
 * ```
 *
 * **Category:** Audio
 * @public
 */
export default class AudioManager {
  /** @internal */
  private _audios: Map<number, Audio> = new Map();

  /** @internal */
  private _nextAudioId: number = 1;

  /** @internal */
  private _world: World;

  /** @internal */
  public constructor(world: World) {
    this._world = world;
  }

  /**
   * The world the audio manager is for.
   *
   * **Category:** Audio
   */
  public get world(): World { return this._world; }

  /**
   * Retrieves all loaded audio instances for the world.
   *
   * @returns An array of audio instances.
   *
   * **Category:** Audio
   */
  public getAllAudios(): Audio[] {
    return Array.from(this._audios.values());
  }

  /**
   * Retrieves all loaded audio instances attached to a specific entity.
   *
   * Use for: cleanup when despawning an entity with positional audio.
   *
   * @param entity - The entity to get attached audio instances for.
   * @returns An array of audio instances.
   *
   * **Requires:** Entity should belong to this world for meaningful results.
   *
   * @see `AudioManager.unregisterEntityAttachedAudios`
   *
   * **Category:** Audio
   */
  public getAllEntityAttachedAudios(entity: Entity): Audio[] {
    return this.getAllAudios().filter(audio => audio.attachedToEntity === entity);
  }

  /**
   * Retrieves all looped audio instances for the world.
   *
   * @returns An array of audio instances.
   *
   * @see `AudioManager.getAllOneshotAudios`
   *
   * **Category:** Audio
   */
  public getAllLoopedAudios(): Audio[] {
    return this.getAllAudios().filter(audio => audio.loop);
  }

  /**
   * Retrieves all oneshot (non-looped) audio instances for the world.
   *
   * @returns An array of audio instances.
   *
   * @see `AudioManager.getAllLoopedAudios`
   *
   * **Category:** Audio
   */
  public getAllOneshotAudios(): Audio[] {
    return this.getAllAudios().filter(audio => !audio.loop);
  }

  /** @internal */
  public registerAudio(audio: Audio): number {
    if (audio.id !== undefined) {
      ErrorHandler.fatalError(`AudioManager.registerAudio(): Provided audio instance with uri ${audio.uri} is already assigned the id ${audio.id}!`);
    }

    const id = this._nextAudioId;
    this._audios.set(id, audio);
    this._nextAudioId++;

    return id;
  }

  /**
   * Unregisters and stops an audio instance from the audio manager.
   *
   * Use for: explicit cleanup of one-shot or temporary sounds.
   * Do NOT use for: pausing/resuming; use `Audio.pause` or `Audio.play` instead.
   *
   * @remarks
   * **Pauses audio:** Calls `audio.pause()` before removing from the manager.
   *
   * @param audio - The audio instance to pause and unregister.
   *
   * **Requires:** Audio must be loaded (have an id) or an error is logged.
   *
   * **Side effects:** Pauses the audio and removes it from manager tracking.
   *
   * @see `AudioManager.unregisterEntityAttachedAudios`
   *
   * **Category:** Audio
   */
  public unregisterAudio(audio: Audio): void {
    if (audio.id === undefined) {
      return ErrorHandler.error(`AudioManager.unregisterAudio(): Provided audio instance with uri ${audio.uri} is not assigned an id!`);
    };

    audio.pause();

    this._audios.delete(audio.id);
    if (audio.world) {
      audio.emitWithWorld(audio.world, AudioEvent.UNLOAD, { audio });
    }
  }

  /**
   * Unregisters and stops all audio instances attached to a specific entity.
   *
   * Use for: entity despawn or cleanup scenarios.
   *
   * @remarks
   * **Pauses all:** Calls `AudioManager.unregisterAudio` for each attached audio, which pauses them.
   *
   * @param entity - The entity to pause and unregister audio instances for.
   *
   * **Requires:** Entity should belong to this world for meaningful results.
   *
   * **Side effects:** Pauses and unregisters any attached audio instances.
   *
   * @see `AudioManager.getAllEntityAttachedAudios`
   *
   * **Category:** Audio
   */
  public unregisterEntityAttachedAudios(entity: Entity): void {
    this.getAllEntityAttachedAudios(entity).forEach(audio => {
      this.unregisterAudio(audio);
    });
  }
}
