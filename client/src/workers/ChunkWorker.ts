import type {
  Vector3Like,
  Vector3Tuple,
} from 'three';
import {
  type BlockTextureAtlasManagerBase,
  BlockTextureAtlasManager,
  BlockTextureAtlasManagerLegacy,
} from './BlockTextureAtlasManager';
import type {
  ChunkWorkerBlocksUpdateMessage,
  ChunkWorkerBlockTypeMessage,
  ChunkWorkerChunksUpdateMessage,
  ChunkWorkerChunkUpdateMessage,
  ChunkWorkerChunkRemoveMessage,
  ChunkWorkerChunkBatchBuildMessage,
  ChunkWorkerChunkBatchBuiltMessage,
  ChunkWorkerBlockEntityBuildMessage,
  ChunkWorkerBlockEntityBuiltMessage,
  ChunkWorkerBlockTypeUpdateMessage,
  ChunkWorkerBlockTextureAtlasUpdatedMessage,
  ChunkWorkerBlockTextureAtlasMetadataMessage,
  ChunkWorkerLightLevelVolumeBuiltMessage,
  ChunkWorkerSkyDistanceVolumeBuiltMessage,
  ToChunkWorkerMessage,
} from './ChunkWorkerConstants';
import {
  type BlocksBufferGeometryData,
  type BlockFace,
  type BlockFaceAO,
  type BlockId,
  type BlockTextureUri,
  BLOCK_ROTATION_MATRICES,
  FACE_SHADE_BOTTOM,
  FACE_SHADE_SIDE,
  FACE_SHADE_TOP,
  DEFAULT_BLOCK_COLOR,
  DEFAULT_BLOCK_FACE_GEOMETRIES,
  DEFAULT_BLOCK_FACES,
  MAX_LIGHT_LEVEL,
  SKY_LIGHT_MAX_DISTANCE,
  SKY_LIGHT_BRIGHTNESS_LUT,
} from '../blocks/BlockConstants';
import BlockType from '../blocks/BlockType';
import BlockTypeRegistry from '../blocks/BlockTypeRegistry';
import Chunk from '../chunks/Chunk';
import type { LightSource } from '../chunks/Chunk';
import {
  type BatchId,
  type ChunkId,
  BATCH_SIZE,
  CHUNK_INDEX_RANGE,
  CHUNK_SIZE,
} from '../chunks/ChunkConstants';
import ChunkRegistry from '../chunks/ChunkRegistry';

// To occasionally allow message events to be received, a limit is set to avoid processing
// too synchronously and continuously without yielding.
const MAX_CONSECUTIVE_PROCESS_COUNT = 100;

const SEARCH_RADIUS = Math.ceil((MAX_LIGHT_LEVEL + 1) / CHUNK_SIZE);

const OPPOSITE_FACES: Record<BlockFace, BlockFace> = {
  top: 'bottom',
  bottom: 'top',
  left: 'right',
  right: 'left',
  front: 'back',
  back: 'front',
};

// A vertex on a given block samples SkyLight from four coordinates and applies it to the brightness.
// Weights correspond to skylight samples in this order:
// [0]: The coordinate in front of the block’s face
// [1, 2]: The coordinates adjacent to [0] in the face’s front direction that include the vertex
// [3]: The diagonal coordinate from [0] in the face’s front direction, across the vertex
const SKYLIGHT_WEIGHTS = [0.3, 0.25, 0.25, 0.2];

type TrimeshOcclusionProfile = {
  aoOpacity: number;
  skyOpacityUp: number;
  skyOpacityX: number;
  skyOpacityZ: number;
};

// working variables
const aoNeighborCoord = { x: 0, y: 0, z: 0 };
const globalToLocalResult = { x: 0, y: 0, z: 0 };
const globalToOriginResult = { x: 0, y: 0, z: 0 };
const localCoord = { x: 0, y: 0, z: 0 };
const globalCoord = { x: 0, y: 0, z: 0 };
const nearbyLightSources: LightSource[] = [];
const neighborCoord = { x: 0, y: 0, z: 0 };
const rotatedVertex: Vector3Tuple = [0, 0, 0];
const rotatedNormal: Vector3Tuple = [0, 0, 0];
const rotatedAOCorner: Vector3Tuple = [0, 0, 0];
const rotatedAOSide1: Vector3Tuple = [0, 0, 0];
const rotatedAOSide2: Vector3Tuple = [0, 0, 0];
const trimeshRotateInput: Vector3Tuple = [0, 0, 0];
const rotatedAO: BlockFaceAO = { corner: rotatedAOCorner, side1: rotatedAOSide1, side2: rotatedAOSide2 };
const vertexCoord = { x: 0, y: 0, z: 0 };
const vertexColorResult: [number, number, number, number] = [0, 0, 0, 0];
const faceNeighborCoord = { x: 0, y: 0, z: 0 };
const aoCacheX: number[] = [];
const aoCacheY: number[] = [];
const aoCacheZ: number[] = [];
const aoCacheOpacity: number[] = [];
const skylightCoords: { x: number, y: number, z: number }[] = [
  { x: 0, y: 0, z: 0 },
  { x: 0, y: 0, z: 0 },
  { x: 0, y: 0, z: 0 },
  { x: 0, y: 0, z: 0 },
];
const SURFACE_GRASS_CLUMP_COUNT = 6;
const SURFACE_GRASS_CARDS_PER_CLUMP = 3;
const SURFACE_GRASS_EDGE_OVERDRAW = 0.08;

// Constructing the geometry for chunk blocks is CPU-intensive, so it is offloaded from the
// main thread to WebWorkers. Ideally, only the geometry construction function would be
// offloaded, but since it has strong dependencies on BlockTextureAtlas, BlockType
// information is also required. Additionally, data from neighboring chunks is needed.
// As a result, Chunk, BlockType, and BlockTextureAtlas are also managed within the WebWorker.
// Since these are also required on the main thread, they end up being managed in both
// places. If memory usage, data synchronization, or race conditions become an issue, this
// dual-management approach may need to be reconsidered.
//
// Block Entity geometry also depends on BlockTextureAtlas, so it is constructed in the
// WebWorker as well.

// Boundary volume data for chunk edges only
// Stores sky distance data for coordinates outside the chunk [0,15]×[0,15]×[0,15]
// Vertices near chunk edges need skylight values from neighboring chunks.
// Since neighboring chunks may not be loaded yet, we duplicate and store
// only the necessary boundary data to avoid dependencies on other chunks.
class BoundaryVolume {
  // Note: Uses the key format "x,y,z" for simplicity
  private _data = new Map<`${number},${number},${number}`, number>();

  // TODO: Avoid string creation every time to mitigate GC pressure
  private _key(x: number, y: number, z: number): `${number},${number},${number}` {
    return `${x},${y},${z}`;
  }

  public set(x: number, y: number, z: number, value: number): void {
    this._data.set(this._key(x, y, z), value);
  }

  public get(x: number, y: number, z: number): number {
    const key = this._key(x, y, z);
    if (!this._data.has(key)) {
      console.warn(`BoundaryVolume: Client implementation error! Accessing unset boundary volume coordinate ${key}, returning default value 16.`);
      return 16;
    }
    return this._data.get(key)!;
  }
}

class ChunkWorker {
  private _textureAtlasManager: BlockTextureAtlasManagerBase;
  private _chunkRegistry = new ChunkRegistry();
  private _blockTypeRegistry = new BlockTypeRegistry();
  private _latestChunkBatchBuildRequestVersion: Map<BatchId, number> = new Map();
  private _trimeshOcclusionProfiles: Map<BlockId, TrimeshOcclusionProfile> = new Map();
  private _receiveQueue: MessageEvent[] = [];
  private _processing: boolean = false;
  private _consecutiveProcessingCount: number = 0;
  // Stores the most recent blocks_update message for each chunk.
  // Used to merge multiple blocks_update messages for the same chunk into one,
  // reducing the frequency of geometry rebuilds.
  private _lastBlocksUpdateMessage: Map<ChunkId, MessageEvent> = new Map();

  private constructor(textureAtlasManager: BlockTextureAtlasManagerBase) {
    this._textureAtlasManager = textureAtlasManager;
    void this._calculateSkyLight;
    void this._sampleAOOpacity;
  }

  public static run(): void {
    let initReceived: boolean = false;
    let worker: ChunkWorker | null = null;
    const pendings: MessageEvent[] = [];

    self.addEventListener('message', async (event: MessageEvent) => {
      const data = event.data as ToChunkWorkerMessage;

      if (data.type === 'init') {
        if (initReceived) {
          throw new Error(`ChunkWorker: Fatal Error! received init message multiple times.`)
        }
        initReceived = true;

        if (data.metadataUrl) {
          let json;

          try {
            const res = await fetch(data.metadataUrl, { mode: 'cors' });

            if (!res.ok) {
              throw new Error(`ChunkWorker: Failed to download BlockTextureAtlas Metadata json with ${res.status} ${res.statusText}.`);
            }

            json = await res.json();
          } catch (error) {
            console.error(error);
            throw new Error(`ChunkWorker: Fatal Error! Failed to load BlockTextureAtlas Metadata json ${data.metadataUrl}.`);
          }

          worker = new ChunkWorker(new BlockTextureAtlasManager(json));
        } else {
          // Legacy mode
          worker = new ChunkWorker(await BlockTextureAtlasManagerLegacy.createInstance());
        }

        pendings.forEach(event => worker!._onMessage(event));
        pendings.length = 0;
        return;
      }

      if (worker === null) {
        pendings.push(event);
      } else {
        worker._onMessage(event);
      }
    });
  }

  private _onMessage(event: MessageEvent): void {
    const message = event.data as ToChunkWorkerMessage;

    if (message.type === 'chunk_batch_build') {
      this._latestChunkBatchBuildRequestVersion.set(message.batchId, message.requestVersion);
    }

    // Clear blocks_update references when merging could cause issues
    // (e.g., mixing updates from before and after chunk-level changes)
    switch (message.type) {
      case 'chunk_update':
        this._lastBlocksUpdateMessage.delete(Chunk.originCoordinateToChunkId(message.originCoordinate));
        break;

      case 'chunks_update':
        for (let i = 0; i < message.updates.length; i++) {
          this._lastBlocksUpdateMessage.delete(
            Chunk.originCoordinateToChunkId(message.updates[i].originCoordinate),
          );
        }
        break;

      case 'chunk_remove':
        this._lastBlocksUpdateMessage.delete(message.chunkId);
        break;

      case 'block_type_update':
        this._lastBlocksUpdateMessage.clear();
        break;
    }

    if (message.type === 'blocks_update') {
      // Merge processing for blocks_update messages to allow combining multiple block updates for the same
      // chunk to reduce geometry rebuilds
      const filteredUpdate: Record<ChunkId, Array<{localCoordinate: Vector3Like, blockId: BlockId}>> = {};
      let hasNewChunks = false;

      for (const chunkId in message.update) {
        const lastMessage = this._lastBlocksUpdateMessage.get(chunkId as ChunkId);

        if (lastMessage) {
          // Merge into existing message (simple append)
          // NOTE: Directly modifying MessageEvent.data is technically possible but conceptually wrong.
          // MessageEvent should represent immutable received messages. Consider refactoring to avoid this.
          const lastData = lastMessage.data as ChunkWorkerBlocksUpdateMessage;
          lastData.update[chunkId as ChunkId].push(...message.update[chunkId as ChunkId]);
        } else {
          // New message or already processed case
          filteredUpdate[chunkId as ChunkId] = message.update[chunkId as ChunkId];
          hasNewChunks = true;
        }
      }

      // If all chunks were merged into existing messages, no need to queue anything
      if (!hasNewChunks) {
        return;
      }

      // Create new event only for chunks that weren't merged into existing messages
      const newEvent = { ...event, data: { ...message, update: filteredUpdate } } as MessageEvent;

      // Record new event in _lastBlocksUpdateMessage
      for (const chunkId in filteredUpdate) {
        this._lastBlocksUpdateMessage.set(chunkId as ChunkId, newEvent);
      }

      this._receiveQueue.push(newEvent);
    } else {
      // Add other message types to queue normally
      this._receiveQueue.push(event);
    }

    if (!this._processing) {
      this._trigger();
    }
  }

  private async _trigger(): Promise<void> {
    this._processing = true;
    if (this._consecutiveProcessingCount >= MAX_CONSECUTIVE_PROCESS_COUNT) {
      this._consecutiveProcessingCount = 0;
      setTimeout(() => this._dequeue(), 0);
    } else {
      this._consecutiveProcessingCount++;
      this._dequeue();
    }
  }

  // To avoid complications, messages are processed in the order they are received.
  // Even if asynchronous operations are involved, the next message will not be processed
  // until the current one is completed. If this becomes a performance issue, optimizations
  // may be needed — such as processing unrelated messages while waiting for async operations
  // to finish, or discarding outdated messages that become unnecessary due to newer ones.
  private async _dequeue(): Promise<void> {
    const event = this._receiveQueue.shift()!;
    const data = event.data as ToChunkWorkerMessage;

    // For blocks_update messages, clear reference if this was the last queued message for the chunk
    if (data.type === 'blocks_update') {
      for (const chunkId in data.update) {
        if (this._lastBlocksUpdateMessage.get(chunkId as ChunkId) === event) {
          this._lastBlocksUpdateMessage.delete(chunkId as ChunkId);
        }
      }
    }

    const maybePromise = this._process(data);

    if (maybePromise instanceof Promise) {
      const pending = [maybePromise];

      // Special fast path
      // Downloading each BlockTexture individually can take a significant amount of
      // time. To improve efficiency, batch consecutive BlockType initialization
      // requests (which trigger BlockTexture loading) and perform downloads in
      // parallel.
      if (data.type === 'block_type') {
        while (true) {
          if (this._receiveQueue.length === 0) {
            break;
          }

          const data = this._receiveQueue[0].data as ToChunkWorkerMessage;

          if (data.type !== 'block_type') {
            break;
          }

          this._receiveQueue.shift();
          pending.push(this._process(data) as Promise<void>);
        }
      }

      this._consecutiveProcessingCount = 0;
      await Promise.all(pending);
    }

    if (this._receiveQueue.length > 0) {
      this._trigger();
    } else {
      this._consecutiveProcessingCount = 0;
      this._processing = false;
    }
  }

  private _process(message: ToChunkWorkerMessage): void | Promise<void> {
    // TODO: Proper Error handling. If an error occurs within the WebWorker,
    // it must be reported to the main thread so that proper error handling
    // can be performed there. Otherwise, the main thread may never be notified
    // of the error and end up waiting indefinitely for a response.
    switch (message.type) {
      case 'block_type':
        return this._onBlockType(message);
      case 'block_type_update':
        return this._onBlockTypeUpdate(message);
      case 'blocks_update':
        return this._onBlocksUpdate(message);
      case 'chunk_batch_build':
        return this._onChunkBatchBuild(message);
      case 'chunks_update':
        return this._onChunksUpdate(message);
      case 'chunk_update':
        return this._onChunkUpdate(message);
      case 'chunk_remove':
        return this._onChunkRemove(message);
      case 'block_entity_build':
        return this._onBlockEntityBuild(message);
      default:
        throw new Error(`ChunkWorker: Unknown Message type: ${(message as any).type}`);
    }
  }

  private _onBlockType = async (message: ChunkWorkerBlockTypeMessage): Promise<void> => {
    const { data: blockTypeData } = message;
    blockTypeData.transparencyRatio = this._calculateBlockTransparencyRatio(blockTypeData.textureUris);
    const blockType = new BlockType(blockTypeData);
    this._blockTypeRegistry.registerBlockType(blockType);

    if (blockType.isTrimesh) {
      this._trimeshOcclusionProfiles.set(blockType.id, this._buildTrimeshOcclusionProfile(blockType));
    } else {
      this._trimeshOcclusionProfiles.delete(blockType.id);
    }

    await this._loadBlockTextures(blockTypeData.textureUris);
  };

  private _onBlockTypeUpdate = async (message: ChunkWorkerBlockTypeUpdateMessage): Promise<void> => {
    const { blockId, name, surfaceGrass, textureUris } = message;
    const blockType = this._blockTypeRegistry.getBlockType(blockId);

    if (!blockType) {
      return;
    }

    if (name) {
      blockType.setName(name);
    }

    if (surfaceGrass !== undefined) {
      blockType.setSurfaceGrass(surfaceGrass);
    }

    if (textureUris) {
      blockType.setTextureUris(textureUris);
      await this._loadBlockTextures(textureUris);
      blockType.setTransparencyRatio(this._calculateBlockTransparencyRatio(textureUris));
    }
  };

  private _onBlocksUpdate = async (message: ChunkWorkerBlocksUpdateMessage): Promise<void> => {
    const affectedChunkIds = this._updateBlocks(message.update);
    
    // Group affected chunks by batch and rebuild batches
    const affectedBatches: Map<BatchId, ChunkId[]> = new Map();
    
    for (const chunkId of affectedChunkIds) {
      const batchId = Chunk.chunkIdToBatchId(chunkId);
      if (!affectedBatches.has(batchId)) {
        // Get all chunks currently in this batch (not just affected ones)
        const allBatchChunkIds = Chunk.getChunkIdsInBatch(batchId).filter(
          cid => this._chunkRegistry.hasChunk(cid)
        );
        affectedBatches.set(batchId, allBatchChunkIds);
      }
    }

    // Rebuild each affected batch
    for (const [ batchId, chunkIds ] of affectedBatches) {
      if (chunkIds.length > 0) {
        this._buildChunkBatchGeometries(batchId, chunkIds, this._latestChunkBatchBuildRequestVersion.get(batchId) ?? 0);
      }
    }

    // Yield control to process accumulated messages and allow blocks_update merging
    // after potentially long-running geometry build operations
    return new Promise(resolve => setTimeout(resolve, 0));
  };

  private _onChunkBatchBuild = (message: ChunkWorkerChunkBatchBuildMessage): Promise<void> => {
    if (this._latestChunkBatchBuildRequestVersion.get(message.batchId) !== message.requestVersion) {
      const staleMessage: ChunkWorkerChunkBatchBuiltMessage = {
        type: 'chunk_batch_built',
        batchId: message.batchId,
        chunkIds: message.chunkIds,
        requestVersion: message.requestVersion,
        blockCount: 0,
      };
      self.postMessage(staleMessage);
      return Promise.resolve();
    }

    this._buildChunkBatchGeometries(message.batchId, message.chunkIds, message.requestVersion);
    // Yield control to process accumulated messages and allow blocks_update merging
    // after potentially long-running geometry build operations
    return new Promise(resolve => setTimeout(resolve, 0));
  };

  private _buildChunkBatchGeometries(batchId: BatchId, chunkIds: ChunkId[], requestVersion: number): void {
    const { foliageGeometry, liquidGeometry, opaqueSolidGeometry, transparentSolidGeometry, blockCount, lightLevelVolumes, skyDistanceVolumes } =
      this._createChunkBatchGeometries(batchId, chunkIds);

    const geometries: BlocksBufferGeometryData[] = [];
    if (foliageGeometry) {
      geometries.push(foliageGeometry);
    }
    if (liquidGeometry) {
      geometries.push(liquidGeometry);
    }
    if (opaqueSolidGeometry) {
      geometries.push(opaqueSolidGeometry);
    }
    if (transparentSolidGeometry) {
      geometries.push(transparentSolidGeometry);
    }

    // Always send the chunk_batch_built message, even if empty (to handle removal case)
    const sendMessage: ChunkWorkerChunkBatchBuiltMessage = {
      type: 'chunk_batch_built',
      batchId,
      chunkIds,
      foliageGeometry,
      liquidGeometry,
      opaqueSolidGeometry,
      requestVersion,
      transparentSolidGeometry,
      blockCount,
    };
    self.postMessage(sendMessage, this._collectTransferableObjectsFromGeometryDataArray(geometries));

    // Send light level volumes for each chunk in the batch
    for (const chunkId of chunkIds) {
      const lightLevelVolume = lightLevelVolumes.get(chunkId);
      const volumeMessage: ChunkWorkerLightLevelVolumeBuiltMessage = {
        type: 'light_level_volume_built',
        chunkId,
        lightLevelVolume,
      };
      self.postMessage(volumeMessage, lightLevelVolume ? [lightLevelVolume.buffer] : []);
    }

    // Send skyDistanceVolumes for each chunk
    for (const chunkId of chunkIds) {
      const skyDistanceVolume = skyDistanceVolumes.get(chunkId);
      const volumeMessage: ChunkWorkerSkyDistanceVolumeBuiltMessage = {
        type: 'sky_distance_volume_built',
        chunkId,
        skyDistanceVolume,
      };
      self.postMessage(volumeMessage, skyDistanceVolume ? [skyDistanceVolume.buffer] : []);
    }
  }

  private _collectTransferableObjectsFromGeometryDataArray(array: BlocksBufferGeometryData[]): Transferable[] {
    const transferables: Transferable[] = [];
    for (let i = 0; i < array.length; i++) {
      const data = array[i];
      transferables.push(data.colors.buffer);
      transferables.push(data.indices.buffer);
      if (data.normals) {
        transferables.push(data.normals.buffer);
      }
      transferables.push(data.positions.buffer);
      transferables.push(data.uvs.buffer);
      if (data.lightLevels) {
        transferables.push(data.lightLevels.buffer);
      }
      if (data.foamLevels) {
        transferables.push(data.foamLevels.buffer);
      }
      if (data.foamLevelsDiag) {
        transferables.push(data.foamLevelsDiag.buffer);
      }
      if (data.surfaceFlags) {
        transferables.push(data.surfaceFlags.buffer);
      }
      if (data.windData) {
        transferables.push(data.windData.buffer);
      }
    }
    return transferables;
  }

  private _onChunkUpdate = (message: ChunkWorkerChunkUpdateMessage): void => {
    this._chunkRegistry.registerChunk(message.originCoordinate, message.blocks, message.blockRotations);

    const chunkId = Chunk.originCoordinateToChunkId(message.originCoordinate);
    this._clearNearbyLightSourceCache(chunkId);
  };

  private _onChunksUpdate = (message: ChunkWorkerChunksUpdateMessage): void => {
    for (let i = 0; i < message.updates.length; i++) {
      const update = message.updates[i];
      this._chunkRegistry.registerChunk(update.originCoordinate, update.blocks, update.blockRotations);

      const chunkId = Chunk.originCoordinateToChunkId(update.originCoordinate);
      this._clearNearbyLightSourceCache(chunkId);
    }
  };

  private _onChunkRemove = (message: ChunkWorkerChunkRemoveMessage): void => {
    this._chunkRegistry.deleteChunk(message.chunkId);

    this._clearNearbyLightSourceCache(message.chunkId);
  };

  // Clear light source cache for a chunk and its neighbors that might be affected.
  // Called when chunks are updated or removed
  private _clearNearbyLightSourceCache(chunkId: ChunkId): void {
    const chunk = this._chunkRegistry.getChunk(chunkId);

    if (!chunk) {
      return;
    }

    const coord = chunk.originCoordinate;
    const searchRadius = Math.ceil((MAX_LIGHT_LEVEL + 1) / CHUNK_SIZE);

    for (let dx = -searchRadius; dx <= searchRadius; dx++) {
      for (let dy = -searchRadius; dy <= searchRadius; dy++) {
        for (let dz = -searchRadius; dz <= searchRadius; dz++) {
          const chunkCoord = {
            x: coord.x + dx * CHUNK_SIZE,
            y: coord.y + dy * CHUNK_SIZE,
            z: coord.z + dz * CHUNK_SIZE,
          };
          this._chunkRegistry.getChunk(Chunk.originCoordinateToChunkId(chunkCoord))?.clearLightSourceCache();
        }
      }
    }
  };

  private _onBlockEntityBuild = async (message: ChunkWorkerBlockEntityBuildMessage): Promise<void> => {
    const { entityId, requestVersion, dimensions, textureUris } = message;
    await this._loadBlockTextures(textureUris);
    const { geometry, transparent } = this._createBlockEntityGeometry(dimensions, textureUris);
    const sendMessage: ChunkWorkerBlockEntityBuiltMessage = {
      type: 'block_entity_built',
      entityId,
      requestVersion,
      dimensions,
      geometry,
      transparent,
    };
    self.postMessage(sendMessage, this._collectTransferableObjectsFromGeometryDataArray([geometry]));
  };

  private _getBlockTypeByChunk(chunk: Chunk, localCoordinate: Vector3Like): BlockType | undefined {
    const blockId = chunk.getBlockType(localCoordinate);

    if (blockId === 0) {
      return undefined;
    }

    return this._blockTypeRegistry.getBlockType(blockId);
  }

  private _getGlobalBlockType(globalCoordinate: Vector3Like): BlockType | undefined {
    // Pass reusable objects to avoid allocations
    Chunk.globalCoordinateToOriginCoordinate(globalCoordinate, globalToOriginResult);
    const chunkId = Chunk.originCoordinateToChunkId(globalToOriginResult);
    
    const chunk = this._chunkRegistry.getChunk(chunkId)!;

    if (!chunk) {
      return undefined;
    }

    Chunk.globalCoordinateToLocalCoordinate(globalCoordinate, globalToLocalResult);
    return this._getBlockTypeByChunk(chunk, globalToLocalResult);
  }

  private async _sendBlockTextureAtlasUpdatedMessage(bitmap: ImageBitmap): Promise<void> {
    const message: ChunkWorkerBlockTextureAtlasUpdatedMessage = {
      type: 'block_texture_atlas_updated',
      bitmap,
    };
    self.postMessage(message, [bitmap]);
  }

  private _updateBlocks(update: Record<ChunkId, { localCoordinate: Vector3Like; blockId: BlockId; blockRotationIndex?: number }[]>): Set<ChunkId> {
    // TODO: As an optimization, it might be a good idea to check whether a remesh is actually necessary.
    const needsRemesh: Set<ChunkId> = new Set();

    for (const key in update) {
      const chunkId = key as ChunkId;

      if (!this._chunkRegistry.hasChunk(chunkId)) {
        continue;
      }

      const chunk = this._chunkRegistry.getChunk(chunkId)!;

      const blocks = update[chunkId];
      for (let i = 0; i < blocks.length; i++) {
        const { localCoordinate, blockId, blockRotationIndex } = blocks[i];
        const globalCoordinate = chunk.getGlobalCoordinate(localCoordinate);

        // When the LightLevel changes, also rebuild the Geometry Data of chunks within the affected area.
        const currentBlockType = this._getBlockTypeByChunk(chunk, localCoordinate);
        const newBlockType = this._blockTypeRegistry.getBlockType(blockId);

        if (currentBlockType?.lightLevel !== newBlockType?.lightLevel) {
          const maxLightLevel = Math.max(currentBlockType?.lightLevel || 0, newBlockType?.lightLevel || 0);
          for (let dx = -SEARCH_RADIUS; dx <= SEARCH_RADIUS; dx++) {
            for (let dy = -SEARCH_RADIUS; dy <= SEARCH_RADIUS; dy++) {
              for (let dz = -SEARCH_RADIUS; dz <= SEARCH_RADIUS; dz++) {
                // TODO: Adjust distance based on direction
                const distance = Math.min(maxLightLevel, CHUNK_SIZE);
                const adjacentChunkId = Chunk.globalCoordinateToChunkId({
                  x: globalCoordinate.x + dx * distance,
                  y: globalCoordinate.y + dy * distance,
                  z: globalCoordinate.z + dz * distance,
                });

                needsRemesh.add(adjacentChunkId)
              }
            }
          }
        }

        /**
         * If the updated block is on a chunk boundary, remesh neighboring chunk(s) that share
         * that boundary. This includes edge/corner diagonal neighbors, because AO sampling
         * can reference them even when no directly opposite face block exists.
         */
        const chunkOffsetX = [0];
        const chunkOffsetY = [0];
        const chunkOffsetZ = [0];

        if (localCoordinate.x === 0) chunkOffsetX.push(-1);
        else if (localCoordinate.x === CHUNK_INDEX_RANGE) chunkOffsetX.push(1);
        if (localCoordinate.y === 0) chunkOffsetY.push(-1);
        else if (localCoordinate.y === CHUNK_INDEX_RANGE) chunkOffsetY.push(1);
        if (localCoordinate.z === 0) chunkOffsetZ.push(-1);
        else if (localCoordinate.z === CHUNK_INDEX_RANGE) chunkOffsetZ.push(1);

        for (const dx of chunkOffsetX) {
          for (const dy of chunkOffsetY) {
            for (const dz of chunkOffsetZ) {
              if (dx === 0 && dy === 0 && dz === 0) {
                continue;
              }

              const adjacentChunkId = Chunk.globalCoordinateToChunkId({
                x: globalCoordinate.x + dx,
                y: globalCoordinate.y + dy,
                z: globalCoordinate.z + dz,
              });

              if (this._chunkRegistry.hasChunk(adjacentChunkId)) {
                needsRemesh.add(adjacentChunkId);
              }
            }
          }
        }

        this._chunkRegistry.updateBlock(chunkId, localCoordinate, blockId, blockRotationIndex);
        needsRemesh.add(chunkId);
      }
    }

    return needsRemesh;
  }

  private _createChunkBatchGeometries(batchId: BatchId, chunkIds: ChunkId[]): {
    foliageGeometry?: BlocksBufferGeometryData,
    liquidGeometry?: BlocksBufferGeometryData,
    opaqueSolidGeometry?: BlocksBufferGeometryData,
    transparentSolidGeometry?: BlocksBufferGeometryData,
    lightLevelVolumes: Map<ChunkId, Uint8Array | undefined>,
    skyDistanceVolumes: Map<ChunkId, Uint8Array>,
    blockCount: number,
  } {
    const batchOrigin = Chunk.batchIdToBatchOrigin(batchId);
    const { x: batchOriginX, y: batchOriginY, z: batchOriginZ } = batchOrigin;

    // Clear working array before populating
    nearbyLightSources.length = 0;

    // Collect all light sources for the batch's chunks, plus neighboring chunks for proper lighting.
    // Search range is in chunk offsets relative to batch origin, extending SEARCH_RADIUS chunks
    // beyond the batch's chunk indices [0, BATCH_SIZE-1] in each dimension.
    const searchExtent = SEARCH_RADIUS + BATCH_SIZE - 1;
    for (let dx = -SEARCH_RADIUS; dx <= searchExtent; dx++) {
      for (let dy = -SEARCH_RADIUS; dy <= searchExtent; dy++) {
        for (let dz = -SEARCH_RADIUS; dz <= searchExtent; dz++) {
          const neighborOrigin = {
            x: batchOriginX + dx * CHUNK_SIZE,
            y: batchOriginY + dy * CHUNK_SIZE,
            z: batchOriginZ + dz * CHUNK_SIZE,
          };

          const neighborChunk = this._chunkRegistry.getChunk(Chunk.originCoordinateToChunkId(neighborOrigin));

          if (neighborChunk) {
            nearbyLightSources.push(...neighborChunk.getLightSources(this._blockTypeRegistry));
          }
        }
      }
    }

    let totalBlockCount = 0;
    const lightLevelVolumes: Map<ChunkId, Uint8Array | undefined> = new Map();
    const skyDistanceVolumes: Map<ChunkId, Uint8Array> = new Map();

    // Batch mesh arrays (combined for all chunks in batch)
    const foliageMeshColors: number[] = [];
    const foliageMeshIndices: number[] = [];
    const foliageMeshPositions: number[] = [];
    const foliageMeshUvs: number[] = [];
    const foliageMeshWindData: number[] = [];

    const liquidMeshColors: number[] = [];
    const liquidMeshIndices: number[] = [];
    const liquidMeshNormals: number[] = [];
    const liquidMeshPositions: number[] = [];
    const liquidMeshUvs: number[] = [];
    const liquidMeshLightLevels: number[] = [];
    const liquidMeshFoamLevels: number[] = [];
    const liquidMeshFoamLevelsDiag: number[] = [];
    const liquidMeshSurfaceFlags: number[] = [];
    let liquidMeshHasLightLevel = false;

    const opaqueSolidMeshColors: number[] = [];
    const opaqueSolidMeshIndices: number[] = [];
    const opaqueSolidMeshNormals: number[] = [];
    const opaqueSolidMeshPositions: number[] = [];
    const opaqueSolidMeshUvs: number[] = [];
    const opaqueSolidMeshLightLevels: number[] = [];
    let opaqueSolidMeshHasLightLevel = false;

    const transparentSolidMeshColors: number[] = [];
    const transparentSolidMeshIndices: number[] = [];
    const transparentSolidMeshNormals: number[] = [];
    const transparentSolidMeshPositions: number[] = [];
    const transparentSolidMeshUvs: number[] = [];
    const transparentSolidMeshLightLevels: number[] = [];
    let transparentSolidMeshHasLightLevel = false;

    // Process each chunk in the batch
    for (const chunkId of chunkIds) {
      const chunk = this._chunkRegistry.getChunk(chunkId);

      if (!chunk) {
        lightLevelVolumes.set(chunkId, undefined);
        continue;
      }

      const { x: originX, y: originY, z: originZ } = chunk.originCoordinate;
      let lightLevelVolume: Uint8Array | undefined = undefined;

      // Build SkyDistanceVolume for this chunk
      const { skyDistanceVolume, skyBoundaryVolume } = this._buildSkyDistanceVolume(chunk);

      for (let y = 0; y < CHUNK_SIZE; y++) {
        const globalY = originY + y;
        for (let z = 0; z < CHUNK_SIZE; z++) {
          const globalZ = originZ + z;
          for (let x = 0; x < CHUNK_SIZE; x++) {
            const globalX = originX + x;

            const lightLevel = this._calculateLightLevel(globalX, globalY, globalZ, nearbyLightSources) & 0xF;

            const blockIndex = x + CHUNK_SIZE * (y + CHUNK_SIZE * z);
            const packedIndex = Math.floor(blockIndex / 2);

            if (lightLevel > 0) {
              if (lightLevelVolume === undefined) {
                lightLevelVolume = new Uint8Array((CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE) / 2);
              }

              if (blockIndex % 2 === 0) {
                lightLevelVolume[packedIndex] = (lightLevelVolume[packedIndex] & 0x0F) | (lightLevel << 4);
              } else {
                lightLevelVolume[packedIndex] = (lightLevelVolume[packedIndex] & 0xF0) | lightLevel;
              }
            }

            // Reuse working object to avoid allocation
            localCoord.x = x;
            localCoord.y = y;
            localCoord.z = z;
            const blockType = this._getBlockTypeByChunk(chunk, localCoord);

            if (!blockType) {
              continue;
            }

            let liquidSurfaceFlag = 0;
            if (blockType.isLiquid) {
              neighborCoord.x = globalX;
              neighborCoord.y = globalY + 1;
              neighborCoord.z = globalZ;
              const liquidAbove = this._getGlobalBlockType(neighborCoord);
              liquidSurfaceFlag = Number(!liquidAbove || !liquidAbove.isLiquid);
            }

            totalBlockCount++;

            // Get block rotation (0 = identity, no rotation)
            const blockRotation = chunk.getBlockRotation(localCoord);

            if (blockType.surfaceGrass) {
              neighborCoord.x = globalX;
              neighborCoord.y = globalY + 1;
              neighborCoord.z = globalZ;

              if (!this._getGlobalBlockType(neighborCoord)) {
                this._appendSurfaceGrassGeometry(
                  globalX,
                  globalY,
                  globalZ,
                  blockType,
                  foliageMeshColors,
                  foliageMeshIndices,
                  foliageMeshPositions,
                  foliageMeshUvs,
                  foliageMeshWindData,
                );
              }
            }

            // Render trimesh block types. Uses precomputed per-triangle data (normals, vertices, UVs)
            // cached in BlockType to avoid redundant calculations across chunks and instances.
            // Trimesh shapes are expected to be simple geometry (stairs, ramps, slabs, etc.)
            // with typically <100 triangles. Complex meshes may impact chunk build performance.
            if (blockType.isTrimesh) {
              const triangleData = blockType.trimeshTriangleData!;
              const normalizedLight = lightLevel / MAX_LIGHT_LEVEL;

              for (let t = 0; t < triangleData.length; t++) {
                const tri = triangleData[t];

                // Select texture based on ORIGINAL normal (texture stays with geometry)
                const blockFace = this._normalToBlockFace(tri.normalX, tri.normalY, tri.normalZ);
                const textureUri = blockType.textureUris[blockFace];
                const isTransparent = this._textureAtlasManager.isTextureTransparent(textureUri);

                const meshPositions = isTransparent ? transparentSolidMeshPositions : opaqueSolidMeshPositions;
                const meshNormals = isTransparent ? transparentSolidMeshNormals : opaqueSolidMeshNormals;
                const meshUvs = isTransparent ? transparentSolidMeshUvs : opaqueSolidMeshUvs;
                const meshColors = isTransparent ? transparentSolidMeshColors : opaqueSolidMeshColors;
                const meshIndices = isTransparent ? transparentSolidMeshIndices : opaqueSolidMeshIndices;
                const meshLightLevels = isTransparent ? transparentSolidMeshLightLevels : opaqueSolidMeshLightLevels;
                const ndx = meshPositions.length / 3;

                // Apply rotation to vertices and normal for rendering
                let v0x = tri.v0x, v0y = tri.v0y, v0z = tri.v0z;
                let v1x = tri.v1x, v1y = tri.v1y, v1z = tri.v1z;
                let v2x = tri.v2x, v2y = tri.v2y, v2z = tri.v2z;
                let nx = tri.normalX, ny = tri.normalY, nz = tri.normalZ;

                if (blockRotation !== 0) {
                  trimeshRotateInput[0] = tri.v0x; trimeshRotateInput[1] = tri.v0y; trimeshRotateInput[2] = tri.v0z;
                  this._rotateAroundBlockCenter(trimeshRotateInput, blockRotation, rotatedVertex);
                  v0x = rotatedVertex[0]; v0y = rotatedVertex[1]; v0z = rotatedVertex[2];
                  trimeshRotateInput[0] = tri.v1x; trimeshRotateInput[1] = tri.v1y; trimeshRotateInput[2] = tri.v1z;
                  this._rotateAroundBlockCenter(trimeshRotateInput, blockRotation, rotatedVertex);
                  v1x = rotatedVertex[0]; v1y = rotatedVertex[1]; v1z = rotatedVertex[2];
                  trimeshRotateInput[0] = tri.v2x; trimeshRotateInput[1] = tri.v2y; trimeshRotateInput[2] = tri.v2z;
                  this._rotateAroundBlockCenter(trimeshRotateInput, blockRotation, rotatedVertex);
                  v2x = rotatedVertex[0]; v2y = rotatedVertex[1]; v2z = rotatedVertex[2];
                  trimeshRotateInput[0] = tri.normalX; trimeshRotateInput[1] = tri.normalY; trimeshRotateInput[2] = tri.normalZ;
                  this._rotateDirection(trimeshRotateInput, blockRotation, rotatedNormal);
                  nx = rotatedNormal[0]; ny = rotatedNormal[1]; nz = rotatedNormal[2];
                }

                let aoFaceVertices: typeof DEFAULT_BLOCK_FACE_GEOMETRIES[BlockFace]['vertices'] | undefined;
                let faceContactAOOpacity = 0;
                aoCacheX.length = 0;
                aoCacheY.length = 0;
                aoCacheZ.length = 0;
                aoCacheOpacity.length = 0;
                this._setDominantAxisNormal(nx, ny, nz, rotatedNormal);
                const aoFace = this._normalToBlockFace(rotatedNormal[0], rotatedNormal[1], rotatedNormal[2]);
                aoFaceVertices = DEFAULT_BLOCK_FACE_GEOMETRIES[aoFace].vertices;
                faceContactAOOpacity = this._getFaceContactAOOpacity(globalX, globalY, globalZ, rotatedNormal);

                meshPositions.push(v0x + globalX, v0y + globalY, v0z + globalZ);
                meshNormals.push(nx, ny, nz);
                let uv = this._textureAtlasManager.getTextureUVCoordinate(textureUri, [tri.v0u, tri.v0v]);
                meshUvs.push(uv[0], uv[1]);
                let aoTemplate = this._pickClosestFaceVertexAO(v0x, v0y, v0z, aoFaceVertices!);
                vertexCoord.x = v0x + globalX;
                vertexCoord.y = v0y + globalY;
                vertexCoord.z = v0z + globalZ;
                let color = this._calculateVertexColor(
                  vertexCoord,
                  globalX,
                  globalY,
                  globalZ,
                  blockType,
                  aoTemplate,
                  rotatedNormal,
                  chunk,
                  skyDistanceVolume,
                  skyBoundaryVolume,
                  faceContactAOOpacity,
                );
                meshColors.push(color[0], color[1], color[2], color[3]);
                meshLightLevels.push(normalizedLight);

                meshPositions.push(v1x + globalX, v1y + globalY, v1z + globalZ);
                meshNormals.push(nx, ny, nz);
                uv = this._textureAtlasManager.getTextureUVCoordinate(textureUri, [tri.v1u, tri.v1v]);
                meshUvs.push(uv[0], uv[1]);
                aoTemplate = this._pickClosestFaceVertexAO(v1x, v1y, v1z, aoFaceVertices!);
                vertexCoord.x = v1x + globalX;
                vertexCoord.y = v1y + globalY;
                vertexCoord.z = v1z + globalZ;
                color = this._calculateVertexColor(
                  vertexCoord,
                  globalX,
                  globalY,
                  globalZ,
                  blockType,
                  aoTemplate,
                  rotatedNormal,
                  chunk,
                  skyDistanceVolume,
                  skyBoundaryVolume,
                  faceContactAOOpacity,
                );
                meshColors.push(color[0], color[1], color[2], color[3]);
                meshLightLevels.push(normalizedLight);

                meshPositions.push(v2x + globalX, v2y + globalY, v2z + globalZ);
                meshNormals.push(nx, ny, nz);
                uv = this._textureAtlasManager.getTextureUVCoordinate(textureUri, [tri.v2u, tri.v2v]);
                meshUvs.push(uv[0], uv[1]);
                aoTemplate = this._pickClosestFaceVertexAO(v2x, v2y, v2z, aoFaceVertices!);
                vertexCoord.x = v2x + globalX;
                vertexCoord.y = v2y + globalY;
                vertexCoord.z = v2z + globalZ;
                color = this._calculateVertexColor(
                  vertexCoord,
                  globalX,
                  globalY,
                  globalZ,
                  blockType,
                  aoTemplate,
                  rotatedNormal,
                  chunk,
                  skyDistanceVolume,
                  skyBoundaryVolume,
                  faceContactAOOpacity,
                );
                meshColors.push(color[0], color[1], color[2], color[3]);
                meshLightLevels.push(normalizedLight);

                meshIndices.push(ndx, ndx + 1, ndx + 2);

                if (lightLevel > 0) {
                  if (isTransparent) transparentSolidMeshHasLightLevel = true;
                  else opaqueSolidMeshHasLightLevel = true;
                }
              }

              continue;
            }

            for (const blockFace of blockType.faces) {
              const { normal: faceDir, vertices } = blockType.faceGeometries[blockFace];
              
              // Get rotated normal for neighbor culling and rendering
              let normalX = faceDir[0], normalY = faceDir[1], normalZ = faceDir[2];
              if (blockRotation !== 0) {
                this._rotateDirection(faceDir, blockRotation, rotatedNormal);
                normalX = Math.round(rotatedNormal[0]);
                normalY = Math.round(rotatedNormal[1]);
                normalZ = Math.round(rotatedNormal[2]);
              }
              
              // Check neighbor for face culling
              neighborCoord.x = globalX + normalX;
              neighborCoord.y = globalY + normalY;
              neighborCoord.z = globalZ + normalZ;

              const neighborBlockType = this._getGlobalBlockType(neighborCoord);

              // cull face when possible for optimization
              if (neighborBlockType) {
                if (neighborBlockType.isLiquid) {
                  // Treat adjacent liquid variants as a continuous volume so
                  // differently tinted water blocks do not render fighting
                  // internal faces or duplicate surface layers.
                  if (blockType.isLiquid) {
                    continue;
                  }
                } else if (neighborBlockType.isTrimesh) {
                  if (neighborBlockType.id === blockType.id) {
                    continue;
                  }
                } else {
                  const oppositeFace = OPPOSITE_FACES[blockFace];
                  if (
                    !this._textureAtlasManager.isTextureTransparent(neighborBlockType.getTextureUri(oppositeFace)) &&
                    !this._textureAtlasManager.textureNeedsAlphaTest(neighborBlockType.getTextureUri(oppositeFace))
                  ) {
                    continue;
                  }
                }
              }

              const faceContactAOOpacity =
                neighborBlockType && !neighborBlockType.isLiquid && neighborBlockType.isTrimesh
                  ? this._getBlockAOOpacity(neighborBlockType)
                  : 0;

              aoCacheX.length = 0;
              aoCacheY.length = 0;
              aoCacheZ.length = 0;
              aoCacheOpacity.length = 0;

              const isTransparentTexture = this._textureAtlasManager.isTextureTransparent(blockType.getTextureUri(blockFace));

              let meshColors: number[];
              let meshIndices: number[];
              let meshNormals: number[];
              let meshPositions: number[];
              let meshUvs: number[];
              let meshLightLevels: number[];

              // Calculate foam levels for liquid top faces
              let foamPosX = 0;
              let foamNegX = 0;
              let foamPosZ = 0;
              let foamNegZ = 0;
              // Diagonal foam: +X+Z, +X-Z, -X+Z, -X-Z
              let foamPosXPosZ = 0;
              let foamPosXNegZ = 0;
              let foamNegXPosZ = 0;
              let foamNegXNegZ = 0;

              if (blockType.isLiquid && normalY > 0) {
                // Check +X direction
                neighborCoord.x = globalX + 1;
                neighborCoord.y = globalY;
                neighborCoord.z = globalZ;
                const neighborPosX = this._getGlobalBlockType(neighborCoord);
                if (neighborPosX && !neighborPosX.isLiquid) {
                  foamPosX = 1;
                }

                // Check -X direction
                neighborCoord.x = globalX - 1;
                neighborCoord.y = globalY;
                neighborCoord.z = globalZ;
                const neighborNegX = this._getGlobalBlockType(neighborCoord);
                if (neighborNegX && !neighborNegX.isLiquid) {
                  foamNegX = 1;
                }

                // Check +Z direction
                neighborCoord.x = globalX;
                neighborCoord.y = globalY;
                neighborCoord.z = globalZ + 1;
                const neighborPosZ = this._getGlobalBlockType(neighborCoord);
                if (neighborPosZ && !neighborPosZ.isLiquid) {
                  foamPosZ = 1;
                }

                // Check -Z direction
                neighborCoord.x = globalX;
                neighborCoord.y = globalY;
                neighborCoord.z = globalZ - 1;
                const neighborNegZ = this._getGlobalBlockType(neighborCoord);
                if (neighborNegZ && !neighborNegZ.isLiquid) {
                  foamNegZ = 1;
                }

                // Check diagonal directions
                // +X+Z
                neighborCoord.x = globalX + 1;
                neighborCoord.y = globalY;
                neighborCoord.z = globalZ + 1;
                const neighborPosXPosZ = this._getGlobalBlockType(neighborCoord);
                if (neighborPosXPosZ && !neighborPosXPosZ.isLiquid) {
                  foamPosXPosZ = 1;
                }

                // +X-Z
                neighborCoord.x = globalX + 1;
                neighborCoord.y = globalY;
                neighborCoord.z = globalZ - 1;
                const neighborPosXNegZ = this._getGlobalBlockType(neighborCoord);
                if (neighborPosXNegZ && !neighborPosXNegZ.isLiquid) {
                  foamPosXNegZ = 1;
                }

                // -X+Z
                neighborCoord.x = globalX - 1;
                neighborCoord.y = globalY;
                neighborCoord.z = globalZ + 1;
                const neighborNegXPosZ = this._getGlobalBlockType(neighborCoord);
                if (neighborNegXPosZ && !neighborNegXPosZ.isLiquid) {
                  foamNegXPosZ = 1;
                }

                // -X-Z
                neighborCoord.x = globalX - 1;
                neighborCoord.y = globalY;
                neighborCoord.z = globalZ - 1;
                const neighborNegXNegZ = this._getGlobalBlockType(neighborCoord);
                if (neighborNegXNegZ && !neighborNegXNegZ.isLiquid) {
                  foamNegXNegZ = 1;
                }
              }

              if (blockType.isLiquid) {
                meshColors = liquidMeshColors;
                meshIndices = liquidMeshIndices;
                meshNormals = liquidMeshNormals;
                meshPositions = liquidMeshPositions;
                meshUvs = liquidMeshUvs;
                meshLightLevels = liquidMeshLightLevels;
              } else if (isTransparentTexture) {
                meshColors = transparentSolidMeshColors;
                meshIndices = transparentSolidMeshIndices;
                meshNormals = transparentSolidMeshNormals;
                meshPositions = transparentSolidMeshPositions;
                meshUvs = transparentSolidMeshUvs;
                meshLightLevels = transparentSolidMeshLightLevels;
              } else {
                meshColors = opaqueSolidMeshColors;
                meshIndices = opaqueSolidMeshIndices;
                meshNormals = opaqueSolidMeshNormals;
                meshPositions = opaqueSolidMeshPositions;
                meshUvs = opaqueSolidMeshUvs;
                meshLightLevels = opaqueSolidMeshLightLevels;
              }

              const ndx = meshPositions.length / 3;
              const textureUri = blockType.textureUris[blockFace];
              const normalizedLightLevel = lightLevel / MAX_LIGHT_LEVEL;

              // Reuse for face normal tuple
              rotatedNormal[0] = normalX;
              rotatedNormal[1] = normalY;
              rotatedNormal[2] = normalZ;

              for (const { pos, uv, ao } of vertices) {
                // Apply rotation to vertex position
                let vx = pos[0], vy = pos[1], vz = pos[2];
                let vertexAO: BlockFaceAO = ao;

                if (blockRotation !== 0) {
                  this._rotateAroundBlockCenter(pos, blockRotation, rotatedVertex);
                  vx = rotatedVertex[0]; vy = rotatedVertex[1]; vz = rotatedVertex[2];

                  // AO offsets are direction vectors - rotate them to match the block rotation
                  this._rotateDirection(ao.corner, blockRotation, rotatedAOCorner);
                  this._rotateDirection(ao.side1, blockRotation, rotatedAOSide1);
                  this._rotateDirection(ao.side2, blockRotation, rotatedAOSide2);
                  vertexAO = rotatedAO;
                }

                const vertexX = globalX + vx;
                const vertexY = globalY + vy;
                const vertexZ = globalZ + vz;

                meshPositions.push(vertexX, vertexY, vertexZ);
                meshNormals.push(normalX, normalY, normalZ);

                const uvCoord = this._textureAtlasManager.getTextureUVCoordinate(textureUri, uv);
                meshUvs.push(uvCoord[0], uvCoord[1]);

                vertexCoord.x = vertexX;
                vertexCoord.y = vertexY;
                vertexCoord.z = vertexZ;
                const color = this._calculateVertexColor(vertexCoord, globalX, globalY, globalZ, blockType, vertexAO, rotatedNormal, chunk, skyDistanceVolume, skyBoundaryVolume, faceContactAOOpacity);
                meshColors.push(color[0], color[1], color[2], color[3]);

                meshLightLevels.push(normalizedLightLevel);

                // Push foam levels for liquid meshes
                if (blockType.isLiquid) {
                  if (normalY > 0) {
                    // Top face - use calculated foam values
                    liquidMeshFoamLevels.push(foamPosX, foamNegX, foamPosZ, foamNegZ);
                    liquidMeshFoamLevelsDiag.push(foamPosXPosZ, foamPosXNegZ, foamNegXPosZ, foamNegXNegZ);
                  } else {
                    // Side/bottom faces - no foam needed
                    liquidMeshFoamLevels.push(0, 0, 0, 0);
                    liquidMeshFoamLevelsDiag.push(0, 0, 0, 0);
                  }
                  liquidMeshSurfaceFlags.push(liquidSurfaceFlag);
                }
              }

              if (lightLevel > 0) {
                if (blockType.isLiquid) {
                  liquidMeshHasLightLevel = true;
                } else if (isTransparentTexture) {
                  transparentSolidMeshHasLightLevel = true;
                } else {
                  opaqueSolidMeshHasLightLevel = true;
                }
              }

              meshIndices.push(ndx, ndx + 1, ndx + 2, ndx + 2, ndx + 1, ndx + 3);
            }
          }
        }
      }

      lightLevelVolumes.set(chunkId, lightLevelVolume);
      skyDistanceVolumes.set(chunkId, skyDistanceVolume);
    }

    return {
      foliageGeometry: foliageMeshPositions.length > 0 ? {
        colors: new Float32Array(foliageMeshColors),
        indices: this._createIndicesTypedArray(foliageMeshIndices, foliageMeshIndices[foliageMeshIndices.length - 1]),
        positions: new Float32Array(foliageMeshPositions),
        uvs: new Float32Array(foliageMeshUvs),
        windData: new Float32Array(foliageMeshWindData),
      } : undefined,
      liquidGeometry: liquidMeshPositions.length > 0 ? {
        colors: new Float32Array(liquidMeshColors),
        indices: this._createIndicesTypedArray(liquidMeshIndices, liquidMeshIndices[liquidMeshIndices.length - 1]),
        normals: new Float32Array(liquidMeshNormals),
        positions: new Float32Array(liquidMeshPositions),
        uvs: new Float32Array(liquidMeshUvs),
        lightLevels: liquidMeshHasLightLevel ? new Float32Array(liquidMeshLightLevels) : undefined,
        foamLevels: new Float32Array(liquidMeshFoamLevels),
        foamLevelsDiag: new Float32Array(liquidMeshFoamLevelsDiag),
        surfaceFlags: new Float32Array(liquidMeshSurfaceFlags),
      } : undefined,
      opaqueSolidGeometry: opaqueSolidMeshPositions.length > 0 ? {
        colors: new Float32Array(opaqueSolidMeshColors),
        indices: this._createIndicesTypedArray(opaqueSolidMeshIndices, opaqueSolidMeshIndices[opaqueSolidMeshIndices.length - 1]),
        normals: new Float32Array(opaqueSolidMeshNormals),
        positions: new Float32Array(opaqueSolidMeshPositions),
        uvs: new Float32Array(opaqueSolidMeshUvs),
        lightLevels: opaqueSolidMeshHasLightLevel ? new Float32Array(opaqueSolidMeshLightLevels) : undefined,
      } : undefined,
      transparentSolidGeometry: transparentSolidMeshPositions.length > 0 ? {
        colors: new Float32Array(transparentSolidMeshColors),
        indices: this._createIndicesTypedArray(transparentSolidMeshIndices, transparentSolidMeshIndices[transparentSolidMeshIndices.length - 1]),
        normals: new Float32Array(transparentSolidMeshNormals),
        positions: new Float32Array(transparentSolidMeshPositions),
        uvs: new Float32Array(transparentSolidMeshUvs),
        lightLevels: transparentSolidMeshHasLightLevel ? new Float32Array(transparentSolidMeshLightLevels) : undefined,
      } : undefined,
      lightLevelVolumes,
      skyDistanceVolumes,
      blockCount: totalBlockCount,
    };
  }

  private _createIndicesTypedArray(indices: number[], max: number): Uint32Array | Uint16Array {
    return new (max > 65535 ? Uint32Array : Uint16Array)(indices);
  }

  private _hashToUnit(x: number, y: number, z: number, salt: number): number {
    let hash = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647) ^ Math.imul(salt, 1597334677);
    hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
    return ((hash ^ (hash >>> 16)) >>> 0) / 4294967295;
  }

  private _fract(value: number): number {
    return value - Math.floor(value);
  }

  private _appendSurfaceGrassGeometry(
    globalX: number,
    globalY: number,
    globalZ: number,
    blockType: BlockType,
    colors: number[],
    indices: number[],
    positions: number[],
    uvs: number[],
    windData: number[],
  ): void {
    const textureUri = blockType.textureUris.top;
    const baseY = globalY + 1.001;
    const blockSeedX = this._hashToUnit(globalX, globalY, globalZ, 91);
    const blockSeedZ = this._hashToUnit(globalX, globalY, globalZ, 137);
    const spread = 1 + SURFACE_GRASS_EDGE_OVERDRAW * 2;
    const rootLeftUv = this._textureAtlasManager.getTextureUVCoordinate(textureUri, [0.47, 0.0]);
    const rootRightUv = this._textureAtlasManager.getTextureUVCoordinate(textureUri, [0.53, 0.0]);
    const tipLeftUv = this._textureAtlasManager.getTextureUVCoordinate(textureUri, [0.48, 1.0]);
    const tipRightUv = this._textureAtlasManager.getTextureUVCoordinate(textureUri, [0.52, 1.0]);

    for (let clumpIndex = 0; clumpIndex < SURFACE_GRASS_CLUMP_COUNT; clumpIndex++) {
      const sampleX = this._fract(blockSeedX + clumpIndex * 0.6180339887498949);
      const sampleZ = this._fract(blockSeedZ + clumpIndex * 0.41421356237309503);
      const orientationBase = this._hashToUnit(globalX, globalY, globalZ, clumpIndex * 17 + 1) * Math.PI;
      const placementJitterAngle = this._hashToUnit(globalX, globalY, globalZ, clumpIndex * 17 + 2) * Math.PI * 2;
      const placementJitterRadius = this._hashToUnit(globalX, globalY, globalZ, clumpIndex * 17 + 3) * 0.055;
      const baseWidth = 0.075 + this._hashToUnit(globalX, globalY, globalZ, clumpIndex * 17 + 4) * 0.04;
      const height = 0.34 + this._hashToUnit(globalX, globalY, globalZ, clumpIndex * 17 + 5) * 0.14;
      const lean = 0.06 + this._hashToUnit(globalX, globalY, globalZ, clumpIndex * 17 + 6) * 0.08;
      const swayStrength = 0.9 + this._hashToUnit(globalX, globalY, globalZ, clumpIndex * 17 + 7) * 0.55;
      const swayPhaseBase = this._hashToUnit(globalX, globalY, globalZ, clumpIndex * 17 + 8) * Math.PI * 2;
      const centerX =
        globalX
        + sampleX * spread
        - SURFACE_GRASS_EDGE_OVERDRAW
        + Math.cos(placementJitterAngle) * placementJitterRadius;
      const centerZ =
        globalZ
        + sampleZ * spread
        - SURFACE_GRASS_EDGE_OVERDRAW
        + Math.sin(placementJitterAngle) * placementJitterRadius;
      const rootShade = 0.64 + this._hashToUnit(globalX, globalY, globalZ, clumpIndex * 17 + 9) * 0.08;

      for (let cardIndex = 0; cardIndex < SURFACE_GRASS_CARDS_PER_CLUMP; cardIndex++) {
        const orientation = orientationBase + (cardIndex * Math.PI) / SURFACE_GRASS_CARDS_PER_CLUMP;
        const width = baseWidth * (0.88 + this._hashToUnit(globalX, globalY, globalZ, clumpIndex * 31 + cardIndex * 5 + 10) * 0.24);
        const halfWidthX = Math.cos(orientation) * width * 0.5;
        const halfWidthZ = Math.sin(orientation) * width * 0.5;
        const halfTopWidthX = halfWidthX * 0.28;
        const halfTopWidthZ = halfWidthZ * 0.28;
        const tipOrientation = orientation + 0.7 + this._hashToUnit(globalX, globalY, globalZ, clumpIndex * 31 + cardIndex * 5 + 11) * 0.45;
        const tipX = centerX + Math.cos(tipOrientation) * lean;
        const tipZ = centerZ + Math.sin(tipOrientation) * lean;
        const swayPhase = swayPhaseBase + cardIndex * 1.173;
        const vertexOffset = positions.length / 3;

        positions.push(
          centerX - halfWidthX, baseY, centerZ - halfWidthZ,
          centerX + halfWidthX, baseY, centerZ + halfWidthZ,
          tipX - halfTopWidthX, baseY + height, tipZ - halfTopWidthZ,
          tipX + halfTopWidthX, baseY + height, tipZ + halfTopWidthZ,
        );

        uvs.push(
          rootLeftUv[0], rootLeftUv[1],
          rootRightUv[0], rootRightUv[1],
          tipLeftUv[0], tipLeftUv[1],
          tipRightUv[0], tipRightUv[1],
        );

        colors.push(
          rootShade, rootShade, rootShade, 0,
          rootShade + 0.03, rootShade + 0.03, rootShade + 0.03, 0,
          1, 1, 1, 1,
          1, 1, 1, 1,
        );

        windData.push(
          swayStrength, swayPhase,
          swayStrength, swayPhase,
          swayStrength, swayPhase,
          swayStrength, swayPhase,
        );

        indices.push(
          vertexOffset, vertexOffset + 1, vertexOffset + 2,
          vertexOffset + 2, vertexOffset + 1, vertexOffset + 3,
        );
      }
    }
  }

  // Calculate light level at a specific vertex position from pre-collected light sources
  // TODO: Stop light propagation if (opaque) block between the block and light emission block
  private _calculateLightLevel(x: number, y: number, z: number, lightSources: LightSource[]): number {
    let maxLightLevel = 0;

    // Loop through pre-collected light sources
    for (let i = 0, len = lightSources.length; i < len; i++) {
      const source = lightSources[i];
      const level = source.level;
      
      const dx = x - source.position.x + 0.5;
      const dy = y - source.position.y + 0.5;
      const dz = z - source.position.z + 0.5;

      // Quick rejection using absolute values (avoid sqrt)
      if (dx > level || dx < -level || dy > level || dy < -level || dz > level || dz < -level) {
        continue;
      }

      // Use squared distance comparison to avoid expensive sqrt
      const distanceSquared = dx * dx + dy * dy + dz * dz;
      const levelSquared = level * level;

      if (distanceSquared >= levelSquared) {
        continue;
      }

      // Only compute sqrt when we know this light source contributes
      const distance = Math.sqrt(distanceSquared);
      const contribution = level - distance;
      
      if (contribution > maxLightLevel) {
        maxLightLevel = contribution;
      }
    }

    return maxLightLevel;
  }

  /**
   * Calculates sky light exposure for a given surface position using precomputed volume data.
   * Uses the face normal to offset the check position so side faces check from
   * the correct perspective (the air in front of them, not inside the block).
   * Returns a brightness multiplier (MIN_BRIGHTNESS to 1.0).
   */
  private _calculateSkyLight(
    vertexX: number, vertexY: number, vertexZ: number,
    blockX: number, blockY: number, blockZ: number,
    faceNormal: Vector3Tuple,
    chunk: Chunk,
    skyDistanceVolume: Uint8Array,
    skyBoundaryVolume: BoundaryVolume
  ): number {
    // Calculate the position in front of the block face
    // faceNormal is always a unit vector along an axis (-1, 0, or 1 for each component)
    const faceX = blockX + faceNormal[0];
    const faceY = blockY + faceNormal[1];
    const faceZ = blockZ + faceNormal[2];

    // Calculate diagonal coordinate
    // For cube corners: vertexX - (blockX + 0.5) is -0.5 or 0.5, so this becomes -1 or 1.
    // For TriMesh vertices this may be fractional.
    const diagX = blockX + (vertexX - blockX - 0.5) * 2;
    const diagY = blockY + (vertexY - blockY - 0.5) * 2;
    const diagZ = blockZ + (vertexZ - blockZ - 0.5) * 2;

    // Quantize offsets to discrete voxel steps to avoid sampling fractional coordinates.
    // This keeps the sky lookup stable for TriMesh vertices that are not on block corners.
    const rawDiffX = diagX - faceX;
    const rawDiffY = diagY - faceY;
    const rawDiffZ = diagZ - faceZ;
    let diffX = rawDiffX > 0 ? 1 : rawDiffX < 0 ? -1 : 0;
    let diffY = rawDiffY > 0 ? 1 : rawDiffY < 0 ? -1 : 0;
    let diffZ = rawDiffZ > 0 ? 1 : rawDiffZ < 0 ? -1 : 0;

    // Keep skylight sampling on the face plane: ignore offset on the face-normal axis.
    if (faceNormal[0] !== 0) diffX = 0;
    if (faceNormal[1] !== 0) diffY = 0;
    if (faceNormal[2] !== 0) diffZ = 0;

    // Set the 4 sampling coordinates

    // Start with face coordinate (base point)
    // Add adjacent coordinates for each non-zero difference
    for (let i = 0; i < 3; i++) {
      skylightCoords[i].x = faceX;
      skylightCoords[i].y = faceY;
      skylightCoords[i].z = faceZ;
    }

    // By adding one of the non-zero diffX, diffY, or diffZ values, get the coordinate adjacent to the base point.
    let index = 1;
    if (diffX !== 0) {
      skylightCoords[index++].x += diffX;
    }
    if (diffY !== 0) {
      skylightCoords[index++].y += diffY;
    }
    if (diffZ !== 0) {
      skylightCoords[index++].z += diffZ;
    }
    
    // Set diagonal coordinate as the last one
    skylightCoords[3].x = faceX + diffX;
    skylightCoords[3].y = faceY + diffY;
    skylightCoords[3].z = faceZ + diffZ;

    let totalWeightedBrightness = 0;

    for (let i = 0; i < 4; i++) {
      const coord = skylightCoords[i];
      const weight = SKYLIGHT_WEIGHTS[i];
      // Convert to local coordinates
      const localX = coord.x - chunk.originCoordinate.x;
      const localY = coord.y - chunk.originCoordinate.y;
      const localZ = coord.z - chunk.originCoordinate.z;

      let distance: number;

      // Get skylight distance from appropriate volume
      if (localX >= 0 && localX < CHUNK_SIZE && localY >= 0 && localY < CHUNK_SIZE && localZ >= 0 && localZ < CHUNK_SIZE) {
        // Read from 4-bit packed storage
        const blockIndex = localX + CHUNK_SIZE * (localY + CHUNK_SIZE * localZ);
        const byteIndex = Math.floor(blockIndex / 2);
        const isLowNibble = blockIndex % 2 === 0;
        const packedValue = (isLowNibble ? skyDistanceVolume[byteIndex] : (skyDistanceVolume[byteIndex] >> 4)) & 0x0F;

        // Convert back: 0 ~ 15 to 1 ~ 16
        distance = packedValue + 1;
      } else {
        distance = skyBoundaryVolume.get(localX, localY, localZ);
      }

      totalWeightedBrightness += SKY_LIGHT_BRIGHTNESS_LUT[distance] * weight;
    }

    return totalWeightedBrightness;
  }

  private _calculateVertexColor(
    vertexCoordinate: Vector3Like,
    blockX: number,
    blockY: number,
    blockZ: number,
    blockType: BlockType,
    blockFaceAO: BlockFaceAO,
    faceNormal: Vector3Tuple,
    chunk: Chunk,
    skyDistanceVolume: Uint8Array,
    skyBoundaryVolume: BoundaryVolume,
    faceContactAOOpacity: number,
  ): [number, number, number, number] {
    const vx = vertexCoordinate.x;
    const vy = vertexCoordinate.y;
    const vz = vertexCoordinate.z;
    const baseColor = blockType.color;

    const ny = faceNormal[1];
    const faceShade = ny > 0 ? FACE_SHADE_TOP : ny < 0 ? FACE_SHADE_BOTTOM : FACE_SHADE_SIDE;
    const skyLight = this._calculateSkyLight(vx, vy, vz, blockX, blockY, blockZ, faceNormal, chunk, skyDistanceVolume, skyBoundaryVolume);

    let aoIntensityLevel = faceContactAOOpacity;

    aoNeighborCoord.x = Math.floor(vx + blockFaceAO.corner[0]);
    aoNeighborCoord.y = Math.floor(vy + blockFaceAO.corner[1]);
    aoNeighborCoord.z = Math.floor(vz + blockFaceAO.corner[2]);
    aoIntensityLevel += this._sampleAOOpacity(aoNeighborCoord.x, aoNeighborCoord.y, aoNeighborCoord.z);

    aoNeighborCoord.x = Math.floor(vx + blockFaceAO.side1[0]);
    aoNeighborCoord.y = Math.floor(vy + blockFaceAO.side1[1]);
    aoNeighborCoord.z = Math.floor(vz + blockFaceAO.side1[2]);
    aoIntensityLevel += this._sampleAOOpacity(aoNeighborCoord.x, aoNeighborCoord.y, aoNeighborCoord.z);

    aoNeighborCoord.x = Math.floor(vx + blockFaceAO.side2[0]);
    aoNeighborCoord.y = Math.floor(vy + blockFaceAO.side2[1]);
    aoNeighborCoord.z = Math.floor(vz + blockFaceAO.side2[2]);
    aoIntensityLevel += this._sampleAOOpacity(aoNeighborCoord.x, aoNeighborCoord.y, aoNeighborCoord.z);

    const clampedAo = Math.min(3, aoIntensityLevel);
    const aoFloor = Math.floor(clampedAo);
    const ao = blockType.aoIntensity[aoFloor]
      + (blockType.aoIntensity[Math.min(3, aoFloor + 1)] - blockType.aoIntensity[aoFloor]) * (clampedAo - aoFloor);

    vertexColorResult[0] = (baseColor[0] - ao) * faceShade * skyLight;
    vertexColorResult[1] = (baseColor[1] - ao) * faceShade * skyLight;
    vertexColorResult[2] = (baseColor[2] - ao) * faceShade * skyLight;
    vertexColorResult[3] = baseColor[3];

    return vertexColorResult;
  }

  private _calculateBlockTransparencyRatio(textureUris: Record<BlockFace, BlockTextureUri>): number {
    let sum = 0;
    for (const face of DEFAULT_BLOCK_FACES) {
      sum += this._textureAtlasManager.getTransparencyRatio(textureUris[face]);
    }
    return sum / DEFAULT_BLOCK_FACES.length;
  }

  private async _loadBlockTextures(textureUris: Record<BlockFace, BlockTextureUri>): Promise<void> {
    const uniqueUris: Set<BlockTextureUri> = new Set();
    Object.values(textureUris).forEach(uri => uniqueUris.add(uri));
    const uniqueUriArray = Array.from(uniqueUris);
    const maybeMetadatas = await Promise.all(uniqueUriArray.map(uri => this._textureAtlasManager.loadTexture(uri)));

    let textureAtlasUpdated = false;

    for (let i = 0; i < uniqueUriArray.length; i++) {
      const metadata = maybeMetadatas[i];

      if (!metadata) {
        continue;
      }

      textureAtlasUpdated = true;
      const message: ChunkWorkerBlockTextureAtlasMetadataMessage = {
        type: 'block_texture_atlas_metadata',
        textureUri: uniqueUriArray[i],
        metadata,
      };
      self.postMessage(message);
    }

    if (textureAtlasUpdated) {
      // Since bitmaps need to be sent only in legacy mode, this results in an awkward
      // mechanism that checks whether the bitmap is null.
      const bitmap = await this._textureAtlasManager.getImageBitmap();
      if (bitmap !== null) {
        this._sendBlockTextureAtlasUpdatedMessage(bitmap);
      }
    }
  }

  private _createBlockEntityGeometry(dimensions: Vector3Like, textureUris: Record<BlockFace, BlockTextureUri>): { geometry: BlocksBufferGeometryData, transparent: boolean } {
    const colors: number[] = [];
    const indices: number[] = [];
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    let transparent = false;

    // Optimization: could add internal face culling, but super low priority for now.
    for (let y = 0; y < dimensions.y; y++) {
      for (let z = 0; z < dimensions.z; z++) {
        for (let x = 0; x < dimensions.x; x++) {
          const blockPos = {
            x: x - dimensions.x / 2,
            y: y - dimensions.y / 2,
            z: z - dimensions.z / 2,
          };

          for (const face of DEFAULT_BLOCK_FACES) {
            const { normal, vertices } = DEFAULT_BLOCK_FACE_GEOMETRIES[face];
            const vertexOffset = positions.length / 3;

            for (const { pos, uv } of vertices) {
              positions.push(
                pos[0] + blockPos.x,
                pos[1] + blockPos.y,
                pos[2] + blockPos.z,
              );
              normals.push(...normal);

              transparent ||= this._textureAtlasManager.isTextureTransparent(textureUris[face]);

              const uvCoord = this._textureAtlasManager.getTextureUVCoordinate(textureUris[face], uv);
              uvs.push(...uvCoord);
              colors.push(...DEFAULT_BLOCK_COLOR);
            }

            indices.push(
              vertexOffset, vertexOffset + 1, vertexOffset + 2,
              vertexOffset + 1, vertexOffset + 3, vertexOffset + 2
            );
          }
        }
      }
    }

    return {
      geometry: {
        colors: new Float32Array(colors),
        indices: this._createIndicesTypedArray(indices, indices[indices.length - 2]),
        normals: new Float32Array(normals),
        positions: new Float32Array(positions),
        uvs: new Float32Array(uvs),
      },
      transparent,
    };
  }

  private _normalToBlockFace(nx: number, ny: number, nz: number): BlockFace {
    const ax = Math.abs(nx);
    const ay = Math.abs(ny);
    const az = Math.abs(nz);

    if (ay >= ax && ay >= az) {
      return ny >= 0 ? 'top' : 'bottom';
    }

    if (ax >= az) {
      return nx >= 0 ? 'right' : 'left';
    }

    return nz >= 0 ? 'front' : 'back';
  }

  private _setDominantAxisNormal(nx: number, ny: number, nz: number, out: Vector3Tuple): void {
    const ax = Math.abs(nx);
    const ay = Math.abs(ny);
    const az = Math.abs(nz);

    out[0] = 0;
    out[1] = 0;
    out[2] = 0;

    if (ay >= ax && ay >= az) {
      out[1] = ny >= 0 ? 1 : -1;
      return;
    }

    if (ax >= az) {
      out[0] = nx >= 0 ? 1 : -1;
      return;
    }

    out[2] = nz >= 0 ? 1 : -1;
  }

  private _pickClosestFaceVertexAO(
    x: number,
    y: number,
    z: number,
    faceVertices: typeof DEFAULT_BLOCK_FACE_GEOMETRIES[BlockFace]['vertices'],
  ): BlockFaceAO {
    let minDistanceSq = Number.POSITIVE_INFINITY;
    let closestAO = faceVertices[0].ao;

    for (let i = 0; i < faceVertices.length; i++) {
      const vertexPos = faceVertices[i].pos;
      const dx = x - vertexPos[0];
      const dy = y - vertexPos[1];
      const dz = z - vertexPos[2];
      const distanceSq = dx * dx + dy * dy + dz * dz;

      if (distanceSq < minDistanceSq) {
        minDistanceSq = distanceSq;
        closestAO = faceVertices[i].ao;
      }
    }

    return closestAO;
  }

  private _getBlockAOOpacity(blockType: BlockType): number {
    const materialOpacity = 1 - blockType.transparencyRatio;
    if (!blockType.isTrimesh) {
      return materialOpacity;
    }

    const profile = this._trimeshOcclusionProfiles.get(blockType.id);
    const shapeOpacity = profile ? profile.aoOpacity : 1.0;
    return shapeOpacity * materialOpacity;
  }

  private _getFaceContactAOOpacity(
    blockX: number,
    blockY: number,
    blockZ: number,
    faceNormal: Vector3Tuple,
  ): number {
    faceNeighborCoord.x = blockX + faceNormal[0];
    faceNeighborCoord.y = blockY + faceNormal[1];
    faceNeighborCoord.z = blockZ + faceNormal[2];
    const faceNeighborBlockType = this._getGlobalBlockType(faceNeighborCoord);
    if (!faceNeighborBlockType || faceNeighborBlockType.isLiquid || !faceNeighborBlockType.isTrimesh) {
      return 0;
    }

    return this._getBlockAOOpacity(faceNeighborBlockType);
  }

  private _sampleAOOpacity(
    x: number,
    y: number,
    z: number,
  ): number {
    for (let i = 0; i < aoCacheOpacity.length; i++) {
      if (aoCacheX[i] === x && aoCacheY[i] === y && aoCacheZ[i] === z) {
        return aoCacheOpacity[i];
      }
    }

    faceNeighborCoord.x = x;
    faceNeighborCoord.y = y;
    faceNeighborCoord.z = z;
    const neighborBlockType = this._getGlobalBlockType(faceNeighborCoord);
    const opacity = (neighborBlockType && !neighborBlockType.isLiquid)
      ? this._getBlockAOOpacity(neighborBlockType)
      : 0;
    aoCacheX.push(x);
    aoCacheY.push(y);
    aoCacheZ.push(z);
    aoCacheOpacity.push(opacity);
    return opacity;
  }

  private _getBlockSkyOpacityUpWithRotation(blockType: BlockType, rotationIndex: number): number {
    const materialOpacity = 1 - blockType.transparencyRatio;
    if (!blockType.isTrimesh) {
      return materialOpacity;
    }

    const profile = this._trimeshOcclusionProfiles.get(blockType.id);
    const shapeOpacity = profile ? this._getTrimeshSkyOpacityForRotation(profile, rotationIndex) : 1.0;
    return shapeOpacity * materialOpacity;
  }

  private _getTrimeshSkyOpacityForRotation(
    profile: TrimeshOcclusionProfile,
    rotationIndex: number,
  ): number {
    const m = BLOCK_ROTATION_MATRICES[rotationIndex] ?? BLOCK_ROTATION_MATRICES[0];
    // Convert world +Y to local axis using inverse rotation (transpose for orthonormal matrix).
    const localUpX = m[3];
    const localUpZ = m[5];

    if (Math.abs(localUpX) > 0.5) {
      return profile.skyOpacityX;
    }
    if (Math.abs(localUpZ) > 0.5) {
      return profile.skyOpacityZ;
    }
    return profile.skyOpacityUp;
  }

  private _getGlobalBlockSkyOpacityUp(globalCoordinate: Vector3Like): number | undefined {
    Chunk.globalCoordinateToOriginCoordinate(globalCoordinate, globalToOriginResult);
    const chunkId = Chunk.originCoordinateToChunkId(globalToOriginResult);
    const chunk = this._chunkRegistry.getChunk(chunkId);
    if (!chunk) {
      return undefined;
    }

    Chunk.globalCoordinateToLocalCoordinate(globalCoordinate, globalToLocalResult);
    const blockType = this._getBlockTypeByChunk(chunk, globalToLocalResult);
    if (!blockType || blockType.isLiquid) {
      return undefined;
    }

    const blockRotation = chunk.getBlockRotation(globalToLocalResult);
    return this._getBlockSkyOpacityUpWithRotation(blockType, blockRotation);
  }

  private _buildTrimeshOcclusionProfile(blockType: BlockType): TrimeshOcclusionProfile {
    const triangles = blockType.trimeshTriangleData;
    if (!triangles || triangles.length === 0) {
      return {
        aoOpacity: 1.0,
        skyOpacityUp: 1.0,
        skyOpacityX: 1.0,
        skyOpacityZ: 1.0,
      };
    }

    const n = 4;
    const occupancy = new Uint8Array(n * n * n);

    for (let t = 0; t < triangles.length; t++) {
      const tri = triangles[t];
      const minX = Math.max(0, Math.min(1, Math.min(tri.v0x, tri.v1x, tri.v2x)));
      const minY = Math.max(0, Math.min(1, Math.min(tri.v0y, tri.v1y, tri.v2y)));
      const minZ = Math.max(0, Math.min(1, Math.min(tri.v0z, tri.v1z, tri.v2z)));
      const maxX = Math.max(0, Math.min(1, Math.max(tri.v0x, tri.v1x, tri.v2x)));
      const maxY = Math.max(0, Math.min(1, Math.max(tri.v0y, tri.v1y, tri.v2y)));
      const maxZ = Math.max(0, Math.min(1, Math.max(tri.v0z, tri.v1z, tri.v2z)));

      const x0 = Math.max(0, Math.min(n - 1, Math.floor(minX * n)));
      const y0 = Math.max(0, Math.min(n - 1, Math.floor(minY * n)));
      const z0 = Math.max(0, Math.min(n - 1, Math.floor(minZ * n)));
      const x1 = Math.max(x0, Math.max(0, Math.min(n - 1, Math.ceil(maxX * n) - 1)));
      const y1 = Math.max(y0, Math.max(0, Math.min(n - 1, Math.ceil(maxY * n) - 1)));
      const z1 = Math.max(z0, Math.max(0, Math.min(n - 1, Math.ceil(maxZ * n) - 1)));

      for (let z = z0; z <= z1; z++) {
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            const index = x + n * (y + n * z);
            occupancy[index] = 1;
          }
        }
      }
    }

    let occupiedCellCount = 0;
    for (let i = 0; i < occupancy.length; i++) {
      occupiedCellCount += occupancy[i];
    }

    let coveredColumns = 0;
    for (let z = 0; z < n; z++) {
      for (let x = 0; x < n; x++) {
        let covered = false;
        for (let y = 0; y < n; y++) {
          const index = x + n * (y + n * z);
          if (occupancy[index] !== 0) {
            covered = true;
            break;
          }
        }
        if (covered) {
          coveredColumns++;
        }
      }
    }

    let coveredColumnsX = 0;
    for (let z = 0; z < n; z++) {
      for (let y = 0; y < n; y++) {
        let covered = false;
        for (let x = 0; x < n; x++) {
          const index = x + n * (y + n * z);
          if (occupancy[index] !== 0) {
            covered = true;
            break;
          }
        }
        if (covered) {
          coveredColumnsX++;
        }
      }
    }

    let coveredColumnsZ = 0;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        let covered = false;
        for (let z = 0; z < n; z++) {
          const index = x + n * (y + n * z);
          if (occupancy[index] !== 0) {
            covered = true;
            break;
          }
        }
        if (covered) {
          coveredColumnsZ++;
        }
      }
    }

    return {
      aoOpacity: occupiedCellCount / (n * n * n),
      skyOpacityUp: coveredColumns / (n * n),
      skyOpacityX: coveredColumnsX / (n * n),
      skyOpacityZ: coveredColumnsZ / (n * n),
    };
  }

  /**
   * Builds sky distance data for a chunk using O(n) algorithm.
   * Processes each XZ column from top to bottom to calculate distances efficiently.
   */
  private _buildSkyDistanceVolume(chunk: Chunk): {
    skyDistanceVolume: Uint8Array,
    skyBoundaryVolume: BoundaryVolume
  } {
    // O(n) calculation for all coordinates including boundary
    // Initialize volumes - 4-bit packed storage (50% memory savings)
    const standardVolume = new Uint8Array(Math.ceil(CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE / 2));
    const boundaryVolume = new BoundaryVolume();

    // Extended loop: x=-1 to CHUNK_SIZE, z=-1 to CHUNK_SIZE
    for (let x = -1; x <= CHUNK_SIZE; x++) {
      for (let z = -1; z <= CHUNK_SIZE; z++) {
        // Find first obstacle above this XZ column
        // obstacleDistance: distance from chunk top to first obstacle above (1-16)
        // - Values 1-16: blocks above chunk top where obstacle is found
        // - Value 16: no obstacle within 16 blocks above chunk (sky is open)
        let obstacleDistance = SKY_LIGHT_MAX_DISTANCE;

        // Perform upper chunk search for all coordinates including boundary
        globalCoord.x = chunk.originCoordinate.x + x;
        globalCoord.y = chunk.originCoordinate.y + CHUNK_SIZE;
        globalCoord.z = chunk.originCoordinate.z + z;
        const upperChunkId = Chunk.globalCoordinateToChunkId(globalCoord);
        const upperChunk = this._chunkRegistry.getChunk(upperChunkId);
        if (upperChunk) {
          const chunkTopY = chunk.originCoordinate.y + CHUNK_SIZE - 1;
          let upperCurrentDistance = SKY_LIGHT_MAX_DISTANCE;
          for (let dy = SKY_LIGHT_MAX_DISTANCE; dy >= 1; dy--) {
            globalCoord.x = chunk.originCoordinate.x + x;
            globalCoord.y = chunkTopY + dy;
            globalCoord.z = chunk.originCoordinate.z + z;
            const skyOpacity = this._getGlobalBlockSkyOpacityUp(globalCoord);
            if (skyOpacity !== undefined) {
              upperCurrentDistance = skyOpacity + upperCurrentDistance * (1 - skyOpacity);
            } else {
              upperCurrentDistance = Math.min(SKY_LIGHT_MAX_DISTANCE, upperCurrentDistance + 1);
            }
          }
          obstacleDistance = upperCurrentDistance;
        }

        // Process column from top to bottom (including Y=16 for topFace)
        // Current distance starts from the distance to obstacle above chunk
        let currentDistance = obstacleDistance;

        for (let y = CHUNK_SIZE; y >= -1; y--) {
          // Check for blocks using global coordinates (includes adjacent chunks)
          globalCoord.x = chunk.originCoordinate.x + x;
          globalCoord.y = chunk.originCoordinate.y + y;
          globalCoord.z = chunk.originCoordinate.z + z;
          const skyOpacity = this._getGlobalBlockSkyOpacityUp(globalCoord);

          if (skyOpacity !== undefined) {
            currentDistance = skyOpacity + currentDistance * (1 - skyOpacity);
          } else {
            currentDistance = Math.min(SKY_LIGHT_MAX_DISTANCE, currentDistance + 1);
          }

          const distance = Math.max(1, Math.min(16, Math.round(currentDistance)));

          // Store in appropriate volume
          if (x >= 0 && x < CHUNK_SIZE && y >= 0 && y < CHUNK_SIZE && z >= 0 && z < CHUNK_SIZE) {
            // Standard volume - 4-bit packed storage
            const linearIndex = x + CHUNK_SIZE * (y + CHUNK_SIZE * z);
            const byteIndex = Math.floor(linearIndex / 2);
            const isLowNibble = linearIndex % 2 === 0;
            // Map 1-16 to 0-15 for 4-bit storage
            const clampedDistance = Math.min(Math.max(distance, 1), 16) - 1;

            if (isLowNibble) {
              standardVolume[byteIndex] = (standardVolume[byteIndex] & 0xF0) | clampedDistance;
            } else {
              standardVolume[byteIndex] = (standardVolume[byteIndex] & 0x0F) | (clampedDistance << 4);
            }
          } else {
            boundaryVolume.set(x, y, z, distance);
          }
        }
      }
    }

    return { skyDistanceVolume: standardVolume, skyBoundaryVolume: boundaryVolume };
  }

  /** Apply rotation matrix to a position around block center (0.5, 0.5, 0.5) */
  private _rotateAroundBlockCenter(pos: Vector3Tuple, rotationIndex: number, out: Vector3Tuple): void {
    const m = BLOCK_ROTATION_MATRICES[rotationIndex];
    const px = pos[0] - 0.5, py = pos[1] - 0.5, pz = pos[2] - 0.5;
    out[0] = m[0] * px + m[1] * py + m[2] * pz + 0.5;
    out[1] = m[3] * px + m[4] * py + m[5] * pz + 0.5;
    out[2] = m[6] * px + m[7] * py + m[8] * pz + 0.5;
  }

  /** Apply rotation matrix to a direction/normal vector */
  private _rotateDirection(dir: Vector3Tuple, rotationIndex: number, out: Vector3Tuple): void {
    const m = BLOCK_ROTATION_MATRICES[rotationIndex];
    out[0] = m[0] * dir[0] + m[1] * dir[1] + m[2] * dir[2];
    out[1] = m[3] * dir[0] + m[4] * dir[1] + m[5] * dir[2];
    out[2] = m[6] * dir[0] + m[7] * dir[1] + m[8] * dir[2];
  }

}

ChunkWorker.run();
