import type { Vector3Like } from 'three';
import Chunk from './Chunk';
import { ChunkId } from './ChunkConstants';
import SkyDistanceVolume from './SkyDistanceVolume';
import EventRouter from '../events/EventRouter';
import { NetworkManagerEventType, type NetworkManagerEventPayload } from '../network/NetworkManager';
import type { Vector3LikeMutable } from '../three/utils';
import { WorkerEventType, type WorkerEventPayload } from '../workers/ChunkWorkerConstants';

// Working variables
const localCoordinate: Vector3LikeMutable = { x: 0, y: 0, z: 0 };

export default class SkyDistanceVolumeManager {
  private _volumes: Map<ChunkId, SkyDistanceVolume> = new Map();

  constructor() {
    this._setupEventListeners();
  }

  private _setupEventListeners(): void {
    EventRouter.instance.on(
      WorkerEventType.SkyDistanceVolumeBuilt,
      this._onSkyDistanceVolumeBuilt,
    );

    EventRouter.instance.on(
      NetworkManagerEventType.ChunksPacket,
      this._onChunksPacket,
    );
  }

  private _onSkyDistanceVolumeBuilt = (payload: WorkerEventPayload.ISkyDistanceVolumeBuilt): void => {
    const { chunkId, skyDistanceVolume } = payload;
    if (skyDistanceVolume) {
      this._volumes.set(chunkId, new SkyDistanceVolume(Chunk.chunkIdToOriginCoordinate(chunkId), skyDistanceVolume));
    } else {
      // If no sky light distance volume (all values are 16), delete any existing one
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

  public getSkyLightBrightnessByGlobalCoordinate(globalCoordinate: Vector3Like): number {
    const chunkId = Chunk.globalCoordinateToChunkId(globalCoordinate);
    Chunk.globalCoordinateToLocalCoordinate(globalCoordinate, localCoordinate);

    // Returns full brightness (1.0) if the volume doesn't exist.
    return this._volumes.has(chunkId) ? this._volumes.get(chunkId)!.getSkyLightBrightness(localCoordinate) : 1.0;
  }

  private _deleteVolume(chunkId: ChunkId): void {
    this._volumes.delete(chunkId);
  }
}
