import type { Vector3Like } from 'three';
import type {
  BlockFace,
  BlockId,
  BlocksBufferGeometryData,
  BlockTextureAtlasMetadata,
  BlockTextureUri,
} from '../blocks/BlockConstants';
import type { BlockTypeData } from '../blocks/BlockType';
import type { BatchId, ChunkId } from '../chunks/ChunkConstants';
import type { EntityId } from '../entities/EntityConstants';

export enum WorkerEventType {
  BlockEntityBuilt = 'WORKER.BLOCK_ENTITY_BUILT',
  BlockTextureAtlasUpdated = 'WORKER.TEXTURE_ATLAS_UPDATED',
  BlockTextureAtlasMetadata = 'WORKER.TEXTURE_ATLAS_METADATA',
  ChunkBatchBuilt = 'WORKER.CHUNK_BATCH_BUILT',
  LightLevelVolumeBuilt = 'WORKER.LIGHT_LEVEL_VOLUME_BUILT',
  SkyDistanceVolumeBuilt = 'WORKER.SKY_DISTANCE_VOLUME_BUILT',
}

export namespace WorkerEventPayload {
  export interface IBlockEntityBuilt {
    entityId: EntityId;
    requestVersion: number;
    dimensions: Vector3Like;
    geometry: BlocksBufferGeometryData;
    transparent: boolean;
  }

  export interface IBlockTextureAtlasUpdated {
    bitmap: ImageBitmap;
  }

  export interface IBlockTextureAtlasMetadata {
    textureUri: BlockTextureUri;
    metadata: BlockTextureAtlasMetadata;
  }

  export interface IChunkBatchBuilt {
    batchId: BatchId;
    chunkIds: ChunkId[];
    liquidGeometry?: BlocksBufferGeometryData;
    opaqueSolidGeometry?: BlocksBufferGeometryData;
    requestVersion: number;
    transparentSolidGeometry?: BlocksBufferGeometryData;
    blockCount: number;
  }

  export interface ILightLevelVolumeBuilt {
    chunkId: ChunkId;
    lightLevelVolume?: Uint8Array;
  }

  export interface ISkyDistanceVolumeBuilt {
    chunkId: ChunkId;
    skyDistanceVolume?: Uint8Array;
  }
}

export type ToChunkWorkerMessageCore = {
  type:
    'block_entity_build' |
    'block_type' |
    'block_type_update' |
    'blocks_update' |
    'chunk_batch_build' |
    'chunks_update' |
    'chunk_update' |
    'chunk_remove' |
    'init'
};

export type ChunkWorkerBlockTypeMessage = ToChunkWorkerMessageCore & {
  type: 'block_type';
  data: BlockTypeData;
};

export type ChunkWorkerBlockTypeUpdateMessage = ToChunkWorkerMessageCore & {
  type: 'block_type_update';
  blockId: BlockId;
  name?: string;
  textureUris?: Record<BlockFace, BlockTextureUri>;
};

export type ChunkWorkerBlocksUpdateMessage = ToChunkWorkerMessageCore & {
  type: 'blocks_update';
  update: Record<ChunkId, {
    localCoordinate: Vector3Like;
    blockId: BlockId;
    blockRotationIndex?: number;
  }[]>;
};

export type ChunkWorkerChunkBatchBuildMessage = ToChunkWorkerMessageCore & {
  type: 'chunk_batch_build';
  batchId: BatchId;
  chunkIds: ChunkId[];
  requestVersion: number;
};

export type ChunkWorkerChunkUpdateMessage = ToChunkWorkerMessageCore & {
  type: 'chunk_update';
  originCoordinate: Vector3Like;
  blocks: Uint8Array;
  blockRotations?: number[];
};

export type ChunkWorkerChunksUpdateMessage = ToChunkWorkerMessageCore & {
  type: 'chunks_update';
  updates: {
    originCoordinate: Vector3Like;
    blocks: Uint8Array;
    blockRotations?: number[];
  }[];
};

export type ChunkWorkerChunkRemoveMessage = ToChunkWorkerMessageCore & {
  type: 'chunk_remove';
  chunkId: ChunkId;
};

export type ChunkWorkerBlockEntityBuildMessage = ToChunkWorkerMessageCore & {
  type: 'block_entity_build';
  entityId: EntityId;
  requestVersion: number;
  dimensions: Vector3Like;
  textureUris: Record<BlockFace, BlockTextureUri>;
};

export type ChunkWorkerInitMessage = ToChunkWorkerMessageCore & {
  type: 'init';
  metadataUrl: string; // empty strings implies legacy mode
};

export type ToChunkWorkerMessage =
  ChunkWorkerBlockTypeMessage |
  ChunkWorkerBlockTypeUpdateMessage |
  ChunkWorkerBlocksUpdateMessage |
  ChunkWorkerChunkBatchBuildMessage |
  ChunkWorkerChunksUpdateMessage |
  ChunkWorkerChunkUpdateMessage |
  ChunkWorkerChunkRemoveMessage |
  ChunkWorkerBlockEntityBuildMessage |
  ChunkWorkerInitMessage;

export type FromChunkWorkerMessageCore = {
  type:
  'block_entity_built' |
  'block_texture_atlas_updated' |
  'block_texture_atlas_metadata' |
  'chunk_batch_built' |
  'light_level_volume_built' |
  'sky_distance_volume_built';
};

export type ChunkWorkerChunkBatchBuiltMessage = FromChunkWorkerMessageCore & {
  type: 'chunk_batch_built';
  batchId: BatchId;
  chunkIds: ChunkId[];
  liquidGeometry?: BlocksBufferGeometryData;
  opaqueSolidGeometry?: BlocksBufferGeometryData;
  requestVersion: number;
  transparentSolidGeometry?: BlocksBufferGeometryData;
  blockCount: number;
};

export type ChunkWorkerLightLevelVolumeBuiltMessage = FromChunkWorkerMessageCore & {
  type: 'light_level_volume_built';
  chunkId: ChunkId;
  lightLevelVolume?: Uint8Array;
};

export type ChunkWorkerSkyDistanceVolumeBuiltMessage = FromChunkWorkerMessageCore & {
  type: 'sky_distance_volume_built';
  chunkId: ChunkId;
  skyDistanceVolume?: Uint8Array;
};

export type ChunkWorkerBlockEntityBuiltMessage = FromChunkWorkerMessageCore & {
  type: 'block_entity_built';
  entityId: EntityId;
  requestVersion: number;
  dimensions: Vector3Like;
  geometry: BlocksBufferGeometryData;
  transparent: boolean;
};

export type ChunkWorkerBlockTextureAtlasUpdatedMessage = FromChunkWorkerMessageCore & {
  type: 'block_texture_atlas_updated';
  bitmap: ImageBitmap;
};

export type ChunkWorkerBlockTextureAtlasMetadataMessage = FromChunkWorkerMessageCore & {
  type: 'block_texture_atlas_metadata';
  textureUri: BlockTextureUri,
  metadata: BlockTextureAtlasMetadata,
};

export type FromChunkWorkerMessage =
  ChunkWorkerChunkBatchBuiltMessage |
  ChunkWorkerBlockEntityBuiltMessage |
  ChunkWorkerBlockTextureAtlasUpdatedMessage |
  ChunkWorkerBlockTextureAtlasMetadataMessage |
  ChunkWorkerLightLevelVolumeBuiltMessage |
  ChunkWorkerSkyDistanceVolumeBuiltMessage;
