import { AudioListener } from 'three';
import EventRouter from '../events/EventRouter';
import Game from '../Game';
import Audio from './Audio';
import AudioStats from './AudioStats';
import { NetworkManagerEventType } from '../network/NetworkManager';
import type { DeserializedAudio } from '../network/Deserializer';
import type { NetworkManagerEventPayload } from '../network/NetworkManager';

export default class AudioManager {
  private _game: Game;
  private _listener: AudioListener;
  private _audios: Map<number, Audio> = new Map();
  private _loggedMissingAudioIds: Set<number> = new Set();
  private readonly MAX_ACTIVE_NODES = 64; // Prevent hitting the browser audio node limit, otherwise all audio could completely break.

  constructor(game: Game) {
    this._game = game;
    this._listener = new AudioListener();
    this._setupEventListeners();

    setInterval(() => this._cleanupOrphanedAudio(), 5000);
  }

  public get game(): Game { return this._game; }
  public get listener(): AudioListener { return this._listener; }
  public get audioCount(): number { return this._audios.size; }

  public getAudio(id: number): Audio | undefined {
    return this._audios.get(id);
  }

  public setMasterVolume(volume: number): void {
    this._listener.setMasterVolume(volume);

    console.log('AudioManager: Set master volume to:', volume);
  }

  private _setupEventListeners(): void {
    EventRouter.instance.on(
      NetworkManagerEventType.AudiosPacket,
      this._onAudiosPacket,
    );
  }

  private _onAudiosPacket = (payload: NetworkManagerEventPayload.IAudiosPacket): void => {
    if (payload.deserializedAudios.length > 0) {
      this._cleanupIfNeeded();
    }

    for (const deserializedAudio of payload.deserializedAudios) {
      this._updateAudio(deserializedAudio);
    }

    if (payload.deserializedAudios.length > 0) {
      this._cleanupIfNeeded();
    }
  }

  private _updateAudio(deserializedAudio: DeserializedAudio): void {
    if (deserializedAudio.id === undefined) {
      if (deserializedAudio.pause) {
        return this._pauseAllAudios();
      }

      return console.warn(`AudioManager._updateAudio(): Audio ${deserializedAudio.id} not updated, missing id field.`);
    }

    const audioId = deserializedAudio.id;
    let audio = this._audios.get(audioId);

    if (!audio) {
      if (!deserializedAudio.uri) {
        if (!this._loggedMissingAudioIds.has(audioId)) {
          this._loggedMissingAudioIds.add(audioId);
          console.warn(`AudioManager._updateAudio(): Audio id ${audioId} is not known by this client, ignoring.`);
        }
        return;
      }

      audio = new Audio(this._game, this._listener, {
        id: audioId,
        uri: deserializedAudio.uri,
        loop: deserializedAudio.loop,
      });

      this._loggedMissingAudioIds.delete(audioId);
      this._audios.set(audioId, audio);
    }

    if (deserializedAudio.attachedToEntityId !== undefined) {
      audio.setAttachedToEntityId(deserializedAudio.attachedToEntityId);
    }

    if (deserializedAudio.position !== undefined) {
      audio.setPosition(deserializedAudio.position);
    }

    if (deserializedAudio.volume !== undefined) {
      audio.setVolume(deserializedAudio.volume);
    }

    if (deserializedAudio.playbackRate !== undefined) {
      audio.setPlaybackRate(deserializedAudio.playbackRate);
    }

    if (deserializedAudio.detune !== undefined) {
      audio.setDetune(deserializedAudio.detune);
    }

    if (deserializedAudio.offset !== undefined) {
      audio.setOffset(deserializedAudio.offset);
    }

    if (deserializedAudio.distortion !== undefined) {
      audio.setDistortion(deserializedAudio.distortion);
    }

    if (deserializedAudio.cutoffDistance !== undefined) {
      audio.setCutoffDistance(deserializedAudio.cutoffDistance);
    }

    if (deserializedAudio.referenceDistance !== undefined) {
      audio.setReferenceDistance(deserializedAudio.referenceDistance);
    }

    if (deserializedAudio.startTick !== undefined) {
      audio.setStartTick(deserializedAudio.startTick);
    }

    // Handle playback controls
    if (deserializedAudio.pause) {
      audio.pause();
    } else if (deserializedAudio.restart) {
      audio.restart();
    } else if (deserializedAudio.play) {
      audio.play();
    }
  }

  private _pauseAllAudios(): void {
    this._audios.forEach(audio => {
      audio.pause();
    });
  }

  private _cleanupIfNeeded(): void {
    const activeNodeCount = Array.from(this._audios.values()).filter(audio => audio.hasActiveNode).length;

    if (activeNodeCount >= this.MAX_ACTIVE_NODES) {
      this._cleanupOldestNodes();
    }
  }

  private _cleanupOldestNodes(): void {
    const targetCount = Math.floor(this.MAX_ACTIVE_NODES * 0.8);
    const audiosWithNodes = Array.from(this._audios.values())
      .filter(audio => audio.hasActiveNode && !audio.isPlaying)
      .sort((a, b) => a.createdAt - b.createdAt);

    const excess = audiosWithNodes.length - targetCount;
    if (excess <= 0) return;

    for (let i = 0; i < Math.min(excess, audiosWithNodes.length); i++) {
      audiosWithNodes[i].disposeAudioNode(); // This will dispose the audio node but keep the Audio instance
    }
  }

  private _cleanupOrphanedAudio(): void {
    // handle if attached entity was despawned, don't waste keeping the node alive, if it's used again it will reconnect later from play or restart.
    for (const audio of this._audios.values()) {
      if (audio.attachedToEntityId && !this._game.entityManager.getEntity(audio.attachedToEntityId) && audio.hasActiveNode) {
        audio.disposeAudioNode();
      }
    }
  }

  public update(): void {
    AudioStats.reset();
    AudioStats.count = this._audios.size;
    const frameCount = this._game.performanceMetricsManager.frameCount;

    for (const audio of this._audios.values()) {
      audio.update(frameCount);
    }
  }
}
