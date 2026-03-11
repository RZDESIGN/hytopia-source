import type {
  ChunkWorkerBlockEntityBuiltMessage,
  ChunkWorkerBlockTextureAtlasMetadataMessage,
  ChunkWorkerBlockTextureAtlasUpdatedMessage,
  ChunkWorkerChunkBatchBuiltMessage,
  ChunkWorkerChunkBuiltMessage,
  ChunkWorkerLightLevelVolumeBuiltMessage,
  ChunkWorkerSkyDistanceVolumeBuiltMessage,
  FromChunkWorkerMessage,
  ToChunkWorkerMessage,
} from './ChunkWorkerConstants';
import EventRouter from '../events/EventRouter';
import { WorkerEventType } from './ChunkWorkerConstants';

export default class ChunkWorkerClient {
  // We must use the URL as a string literal for vite static analysis for 
  // production builds and proper working bundling to work correctly. 
  // NEVER CHANGE './ChunkWorker.ts' TO A CONST OR VARIABLE IT MUST BE A STRING LITERAL!!
  private _worker: Worker = new Worker(new URL('./ChunkWorker.ts', import.meta.url), { type: 'module' });

  constructor() {
    this._setupListeners();
  }

  public postMessage(message: ToChunkWorkerMessage, transferables: Transferable[] = []): void {
    this._worker.postMessage(message, transferables);
  }

  private _setupListeners(): void {
    this._worker.onmessage = (event: MessageEvent) => {
      const data = event.data as FromChunkWorkerMessage;
      switch (data.type) {
        case 'chunk_batch_built':
          return this._onChunkBatchBuilt(data);
        case 'chunk_built':
          return this._onChunkBuilt(data);
        case 'block_entity_built':
          return this._onBlockEntityBuilt(data);
        case 'block_texture_atlas_updated':
          return this._onBlockTextureAtlasUpdated(data);
        case 'block_texture_atlas_metadata':
          return this._onBlockTextureAtlasMetadata(data);
        case 'light_level_volume_built':
          return this._onLightLevelVolumeBuilt(data);
        case 'sky_distance_volume_built':
          return this._onSkyDistanceVolumeBuilt(data);
        default:
          throw new Error(`ChunkWorkerClient: Unknown Message type: ${(data as any).type}`)
      }
    };
  }

  private _onChunkBatchBuilt = (message: ChunkWorkerChunkBatchBuiltMessage): void => {
    EventRouter.instance.emit(WorkerEventType.ChunkBatchBuilt, {
      batchId: message.batchId,
      chunkIds: message.chunkIds,
      foliageGeometry: message.foliageGeometry,
      liquidGeometry: message.liquidGeometry,
      opaqueSolidGeometry: message.opaqueSolidGeometry,
      requestVersion: message.requestVersion,
      transparentSolidGeometry: message.transparentSolidGeometry,
      blockCount: message.blockCount,
    });
  };

  private _onChunkBuilt = (message: ChunkWorkerChunkBuiltMessage): void => {
    EventRouter.instance.emit(WorkerEventType.ChunkBuilt, {
      batchId: message.batchId,
      chunkId: message.chunkId,
      foliageGeometry: message.foliageGeometry,
      liquidGeometry: message.liquidGeometry,
      opaqueSolidGeometry: message.opaqueSolidGeometry,
      transparentSolidGeometry: message.transparentSolidGeometry,
      blockCount: message.blockCount,
    });
  };

  private _onBlockEntityBuilt = (message: ChunkWorkerBlockEntityBuiltMessage): void => {
    EventRouter.instance.emit(WorkerEventType.BlockEntityBuilt, {
      entityId: message.entityId,
      requestVersion: message.requestVersion,
      dimensions: message.dimensions,
      geometry: message.geometry,
      transparent: message.transparent,
    });
  };

  private _onBlockTextureAtlasUpdated = (message: ChunkWorkerBlockTextureAtlasUpdatedMessage): void => {
    EventRouter.instance.emit(WorkerEventType.BlockTextureAtlasUpdated, { bitmap: message.bitmap });
  };

  private _onBlockTextureAtlasMetadata = (message: ChunkWorkerBlockTextureAtlasMetadataMessage): void => {
    EventRouter.instance.emit(WorkerEventType.BlockTextureAtlasMetadata, {
      textureUri: message.textureUri,
      metadata: message.metadata,
    });
  };

  private _onLightLevelVolumeBuilt = (message: ChunkWorkerLightLevelVolumeBuiltMessage): void => {
    EventRouter.instance.emit(WorkerEventType.LightLevelVolumeBuilt, {
      chunkId: message.chunkId,
      lightLevelVolume: message.lightLevelVolume,
    });
  };

  private _onSkyDistanceVolumeBuilt = (message: ChunkWorkerSkyDistanceVolumeBuiltMessage): void => {
    EventRouter.instance.emit(WorkerEventType.SkyDistanceVolumeBuilt, {
      chunkId: message.chunkId,
      skyDistanceVolume: message.skyDistanceVolume,
    });
  };
}
