import type { Vector3Like } from 'three';
import Chunk from './Chunk';
import { ChunkId } from './ChunkConstants';
import LightLevelVolume from './LightLevelVolume';
import EventRouter from '../events/EventRouter';
import { NetworkManagerEventType, type NetworkManagerEventPayload } from '../network/NetworkManager';
import { WorkerEventType, type WorkerEventPayload } from '../workers/ChunkWorkerConstants';

export default class LightLevelManager {
  private _volumes: Map<ChunkId, LightLevelVolume> = new Map();

  constructor() {
    this._setupEventListeners();
  }

  private _setupEventListeners(): void {
    EventRouter.instance.on(
      WorkerEventType.LightLevelVolumeBuilt,
      this._onLightLevelVolumeBuilt,
    );
    
    EventRouter.instance.on(
      NetworkManagerEventType.ChunksPacket,
      this._onChunksPacket,
    );
  }

  private _onLightLevelVolumeBuilt = (payload: WorkerEventPayload.ILightLevelVolumeBuilt): void => {
    const { chunkId, lightLevelVolume } = payload;
    if (lightLevelVolume) {
      this._volumes.set(chunkId, new LightLevelVolume(Chunk.chunkIdToOriginCoordinate(chunkId), lightLevelVolume));
    } else {
      // If no light level volume (all zeros), delete any existing one
      this._deleteVolume(chunkId);
    }
  };

  private _onChunksPacket = (payload: NetworkManagerEventPayload.IChunksPacket): void => {
    const { deserializedChunks } = payload;

    for (let i = 0; i < deserializedChunks.length; i++) {
      const { originCoordinate, removed } = deserializedChunks[i];
      if (removed) {
        const chunkId = Chunk.originCoordinateToChunkId(originCoordinate);
        this._deleteVolume(chunkId);
      }
    }
  };

  public getLightLevel(chunkId: ChunkId, localCoordinate: Vector3Like): number {
    const volume = this._volumes.get(chunkId);
    // Returns 0 if the volume doesn't exist.
    return volume ? volume.getLightLevel(localCoordinate) : 0;
  }

  public getLightLevelByGlobalCoordinate(globalCoordinate: Vector3Like): number {
    const chunkId = Chunk.globalCoordinateToChunkId(globalCoordinate);
    const localCoordinate = Chunk.globalCoordinateToLocalCoordinate(globalCoordinate);
    return this.getLightLevel(chunkId, localCoordinate);
  }

  private _deleteVolume(chunkId: ChunkId): void {
    this._volumes.delete(chunkId);
  }
}
