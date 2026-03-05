import { Vector2, Vector3, Vector3Like } from 'three';
import Chunk from './Chunk';
import { BATCH_WORLD_SIZE, BatchId, ChunkId } from './ChunkConstants';
import ChunkRegistry from './ChunkRegistry';
import ChunkStats from './ChunkStats';
import { BlockId, WATER_SURFACE_Y_OFFSET } from '../blocks/BlockConstants';
import {
  RendererEventType,
  type RendererEventPayload,
} from '../core/Renderer';
import EventRouter from '../events/EventRouter';
import Game from '../Game';
import type { DeserializedBlock } from '../network/Deserializer';
import {
  NetworkManagerEventType,
  type NetworkManagerEventPayload,
} from '../network/NetworkManager';
import {
  type ChunkWorkerChunkBatchBuildMessage,
  type ChunkWorkerBlocksUpdateMessage,
  type ChunkWorkerChunkRemoveMessage,
  type ChunkWorkerChunkUpdateMessage,
  type WorkerEventPayload,
  WorkerEventType,
} from '../workers/ChunkWorkerConstants';

// Working variables
const fromVec2 = new Vector2();
const toVec2 = new Vector2();
const vec1 = new Vector3();
const vec2 = new Vector3();
const HALF_BATCH_WORLD_SIZE = BATCH_WORLD_SIZE / 2;
const VISIBILITY_CELL_SIZE = BATCH_WORLD_SIZE / 4;
const VIEW_DISTANCE_SQUARED_EPSILON = 0.0001;

export default class ChunkManager {
  private _game: Game;
  private _registry: ChunkRegistry = new ChunkRegistry();
  private _firstChunkBatchBuilt: boolean = false;
  private _visibleBatchIds: Set<BatchId> = new Set();
  private _lastVisibilityCellX: number | null = null;
  private _lastVisibilityCellZ: number | null = null;
  private _lastViewDistanceSquared: number = -1;
  private _wasViewDistanceEnabled: boolean | null = null;

  public constructor(game: Game) {
    this._game = game;
    this._setupEventListeners();
  }

  public get game(): Game {
    return this._game;
  }

  private _setupEventListeners(): void {
    EventRouter.instance.on(
      NetworkManagerEventType.BlocksPacket,
      this._onBlocksPacket,
    );
    
    EventRouter.instance.on(
      NetworkManagerEventType.ChunksPacket,
      this._onChunksPacket,
    );

    EventRouter.instance.on(
      RendererEventType.Animate,
      this._onAnimate,
    );

    EventRouter.instance.on(
      WorkerEventType.ChunkBatchBuilt,
      this._onChunkBatchBuilt,
    );
  }

  private _onAnimate = (_payload: RendererEventPayload.IAnimate): void => {
    ChunkStats.reset();

    const viewDistanceEnabled = this._game.settingsManager.qualityPerfTradeoff.viewDistance.enabled;
    if (!viewDistanceEnabled) {
      if (this._wasViewDistanceEnabled !== false) {
        this._game.chunkMeshManager.addAllBatchMeshesToScene();
        this._visibleBatchIds.clear();
      }
      this._wasViewDistanceEnabled = false;
      ChunkStats.visibleCount = this._game.chunkMeshManager.batchCount;
      return;
    }

    const viewDistance = this._game.renderer.viewDistance;
    const viewDistanceSquared = viewDistance * viewDistance;
    const cameraPos = this._game.camera.activeCamera.position;
    const cellX = this._toVisibilityCellCoordinate(cameraPos.x);
    const cellZ = this._toVisibilityCellCoordinate(cameraPos.z);
    const viewDistanceChanged = Math.abs(this._lastViewDistanceSquared - viewDistanceSquared) > VIEW_DISTANCE_SQUARED_EPSILON;
    const cellChanged = this._lastVisibilityCellX !== cellX || this._lastVisibilityCellZ !== cellZ;
    const modeChanged = this._wasViewDistanceEnabled !== true;

    if (modeChanged || viewDistanceChanged || cellChanged) {
      this._refreshVisibleBatches(fromVec2.set(cameraPos.x, cameraPos.z), viewDistanceSquared, modeChanged);
      this._lastVisibilityCellX = cellX;
      this._lastVisibilityCellZ = cellZ;
      this._lastViewDistanceSquared = viewDistanceSquared;
    }

    this._wasViewDistanceEnabled = true;
    ChunkStats.visibleCount = this._visibleBatchIds.size;
  }

  private _onBlocksPacket = (payload: NetworkManagerEventPayload.IBlocksPacket) => {
    const update: Record<ChunkId, { localCoordinate: Vector3Like, blockId: BlockId, blockRotationIndex?: number }[]> = {};

    payload.deserializedBlocks.forEach((deserializedBlock: DeserializedBlock) => {
      const { id: blockId, globalCoordinate, blockRotationIndex } = deserializedBlock;
      const chunkId = Chunk.globalCoordinateToChunkId(globalCoordinate);
      const chunk = this._registry.getChunk(chunkId);

      if (!chunk) {
        return;
      }

      const localCoordinate = Chunk.globalCoordinateToLocalCoordinate(globalCoordinate);
      this._registry.updateBlock(chunkId, localCoordinate, blockId, blockRotationIndex);

      if (update[chunkId] === undefined) {
        update[chunkId] = [];
      }
      update[chunkId].push({ localCoordinate, blockId, blockRotationIndex });
    });

    // Since chunks are also managed within the WebWorker, the information will be sent.
    // The worker will handle determining which batches need rebuilding based on block updates.
    const message: ChunkWorkerBlocksUpdateMessage = {
      type: 'blocks_update',
      update,
    };
    this._game.chunkWorkerClient.postMessage(message);
  }

  private _onChunksPacket = (payload: NetworkManagerEventPayload.IChunksPacket) => {
    const { deserializedChunks } = payload;
    const affectedBatches: Set<BatchId> = new Set();

    deserializedChunks.forEach(deserializedChunk => {
      const { removed, originCoordinate, blocks, blockRotations } = deserializedChunk;

      if (!originCoordinate) {
        return;
      }

      const chunkId = Chunk.originCoordinateToChunkId(originCoordinate);
      const batchId = Chunk.chunkIdToBatchId(chunkId);
      const chunk = this._registry.getChunk(chunkId);

      if (removed && chunk) {
        this._registry.deleteChunk(chunkId);

        const message: ChunkWorkerChunkRemoveMessage = {
          type: 'chunk_remove',
          chunkId,
        };
        this._game.chunkWorkerClient.postMessage(message);

        affectedBatches.add(batchId);
      }

      if (!removed && blocks) {
        this._registry.registerChunk(originCoordinate, blocks, blockRotations);

        // Since blocks are also managed on the main thread, they are not transferred.
        // However, if copying blocks becomes a performance or memory issue, this
        // approach may need to be reconsidered.
        const message: ChunkWorkerChunkUpdateMessage = {
          type: 'chunk_update',
          originCoordinate,
          blocks,
          blockRotations,
        };
        this._game.chunkWorkerClient.postMessage(message);

        affectedBatches.add(batchId);
      }
    });

    // Build affected batches in order of proximity to the player
    const basePosition = this._game.camera.gameCameraAttachedEntity?.position || this._game.camera.activeCamera.position;
    
    // Sort batches by distance to player
    const sortedBatches = Array.from(affectedBatches).sort((batchId1, batchId2) => {
      const origin1 = Chunk.batchIdToBatchOrigin(batchId1);
      const origin2 = Chunk.batchIdToBatchOrigin(batchId2);
      return vec1.copy(origin1).distanceToSquared(basePosition) - vec2.copy(origin2).distanceToSquared(basePosition);
    });

    // Send batch build messages for affected batches
    sortedBatches.forEach(batchId => {
      const chunkIds = this._registry.getBatchChunkIds(batchId);
      
      if (chunkIds.length === 0) {
        // Batch is now empty, remove its meshes
        this._game.chunkMeshManager.removeAllBatchMeshes(batchId);
        this._visibleBatchIds.delete(batchId);
        return;
      }

      const message: ChunkWorkerChunkBatchBuildMessage = {
        type: 'chunk_batch_build',
        batchId,
        chunkIds,
      };
      this._game.chunkWorkerClient.postMessage(message);
    });
  }

  private _onChunkBatchBuilt = (payload: WorkerEventPayload.IChunkBatchBuilt): void => {
    const { batchId, chunkIds, liquidGeometry, opaqueSolidGeometry, transparentSolidGeometry, blockCount } = payload;

    // Verify at least one chunk in the batch still exists
    const validChunkIds = chunkIds.filter(chunkId => this._registry.getChunk(chunkId));
    
    if (validChunkIds.length === 0) {
      // All chunks in batch have been removed, clean up batch meshes
      this._game.chunkMeshManager.removeAllBatchMeshes(batchId);
      this._visibleBatchIds.delete(batchId);
      return;
    }

    if (!this._firstChunkBatchBuilt) {
      this._firstChunkBatchBuilt = true;
      performance.mark('ChunkManager:first-chunk-batch-built');
      performance.measure('ChunkManager:first-chunk-batch-built-time', 'NetworkManager:connected', 'ChunkManager:first-chunk-batch-built');
    }

    // Update batch meshes
    if (liquidGeometry) {
      this._game.chunkMeshManager.createOrUpdateBatchLiquidMesh(batchId, liquidGeometry);
    } else {
      this._game.chunkMeshManager.removeBatchLiquidMesh(batchId);
    }

    if (opaqueSolidGeometry) {
      this._game.chunkMeshManager.createOrUpdateBatchOpaqueSolidMesh(batchId, opaqueSolidGeometry);
    } else {
      this._game.chunkMeshManager.removeBatchOpaqueSolidMesh(batchId);
    }

    if (transparentSolidGeometry) {
      this._game.chunkMeshManager.createOrUpdateBatchTransparentSolidMesh(batchId, transparentSolidGeometry);
    } else {
      this._game.chunkMeshManager.removeBatchTransparentSolidMesh(batchId);
    }

    this._syncBatchVisibility(batchId);

    // Update batch metadata
    this._registry.updateBatchMetadata(batchId, {
      blockCount,
      opaqueFaceCount: (opaqueSolidGeometry?.indices.length || 0) / 3,
      transparentFaceCount: (transparentSolidGeometry?.indices.length || 0) / 3,
      liquidFaceCount: (liquidGeometry?.indices.length || 0) / 3,
    });
  };

  public getChunk(chunkId: ChunkId): Chunk | undefined {
    return this._registry.getChunk(chunkId);
  }

  public getChunkByGlobalCoordinate(globalCoordinate: Vector3Like): Chunk | undefined {
    return this.getChunk(Chunk.globalCoordinateToChunkId(globalCoordinate));
  }

  public inLiquidBlock(worldPosition: Vector3Like): boolean {
    const globalCoordinate = Chunk.worldPositionToGlobalCoordinate(worldPosition);
    const chunk = this.getChunkByGlobalCoordinate(globalCoordinate);

    if (!chunk) {
      return false;
    }

    const blockTypeId = chunk.getBlockType(Chunk.globalCoordinateToLocalCoordinate(globalCoordinate));

    if (blockTypeId === 0) {
      return false;
    }

    const blockType = this._game.blockTypeManager.getBlockType(blockTypeId)!;

    if (!blockType.isLiquid) {
      return false;
    }

    // The water surface is slightly below the edge of the local coordinate space,
    // so this needs to be taken into account. See BlockMaterial for more details.
    // TODO: For more accurate results, the water surface wave effect should also be considered.
    const globalCoordinateAbove = { ...globalCoordinate, y: globalCoordinate.y + 1 };
    const aboveBlockTypeId = chunk.getBlockType(Chunk.globalCoordinateToLocalCoordinate(globalCoordinateAbove));

    if (blockTypeId === aboveBlockTypeId) {
      return true;
    }

    const absWorldPositionY = Math.abs(worldPosition.y);
    return absWorldPositionY - Math.floor(absWorldPositionY) < 1.0 + WATER_SURFACE_Y_OFFSET;
  }

  private _toVisibilityCellCoordinate(value: number): number {
    return Math.floor(value / VISIBILITY_CELL_SIZE);
  }

  // Distance is calculated ignoring the Y-axis (Up direction) to process distant batches
  // without regard to elevation, aiming for a more natural appearance.
  private _isBatchInRange(batchId: BatchId, fromVec2: Vector2, viewDistanceSquared: number): boolean {
    const batchOrigin = Chunk.batchIdToBatchOrigin(batchId);
    return fromVec2.distanceToSquared(
      toVec2.set(
        batchOrigin.x + HALF_BATCH_WORLD_SIZE,
        batchOrigin.z + HALF_BATCH_WORLD_SIZE,
      ),
    ) <= viewDistanceSquared;
  }

  private _refreshVisibleBatches(fromVec2: Vector2, viewDistanceSquared: number, forceApplyAll: boolean): void {
    const nextVisibleBatchIds: Set<BatchId> = new Set();

    for (const batchId of this._game.chunkMeshManager.batchIds) {
      const inRange = this._isBatchInRange(batchId, fromVec2, viewDistanceSquared);
      if (inRange) {
        nextVisibleBatchIds.add(batchId);
      }

      if (forceApplyAll) {
        this._game.chunkMeshManager.setBatchInScene(batchId, inRange);
      }
    }

    if (!forceApplyAll) {
      for (const batchId of this._visibleBatchIds) {
        if (!nextVisibleBatchIds.has(batchId)) {
          this._game.chunkMeshManager.setBatchInScene(batchId, false);
        }
      }

      for (const batchId of nextVisibleBatchIds) {
        if (!this._visibleBatchIds.has(batchId)) {
          this._game.chunkMeshManager.setBatchInScene(batchId, true);
        }
      }
    }

    this._visibleBatchIds = nextVisibleBatchIds;
  }

  // Newly built batches should be immediately synchronized so they don't wait for the
  // next visibility cell transition.
  private _syncBatchVisibility(batchId: BatchId): void {
    if (!this._game.chunkMeshManager.hasBatch(batchId)) {
      this._visibleBatchIds.delete(batchId);
      return;
    }

    if (!this._game.settingsManager.qualityPerfTradeoff.viewDistance.enabled) {
      this._game.chunkMeshManager.setBatchInScene(batchId, true);
      this._visibleBatchIds.delete(batchId);
      return;
    }

    const cameraPos = this._game.camera.activeCamera.position;
    const viewDistance = this._game.renderer.viewDistance;
    const inRange = this._isBatchInRange(batchId, fromVec2.set(cameraPos.x, cameraPos.z), viewDistance * viewDistance);

    this._game.chunkMeshManager.setBatchInScene(batchId, inRange);
    if (inRange) {
      this._visibleBatchIds.add(batchId);
    } else {
      this._visibleBatchIds.delete(batchId);
    }
  }
}
