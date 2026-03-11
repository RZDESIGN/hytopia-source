import { Intersection, Object3D, Ray, Raycaster, Vector2, Vector3, Vector3Like } from 'three';
import Chunk from './Chunk';
import { BATCH_WORLD_SIZE, BatchId, ChunkId } from './ChunkConstants';
import ChunkRegistry from './ChunkRegistry';
import ChunkStats from './ChunkStats';
import { BlockId, WATER_SURFACE_Y_OFFSET } from '../blocks/BlockConstants';
import {
  RendererEventType,
  type RendererEventPayload,
} from '../core/Renderer';
import { getDebugFlags } from '../core/RuntimeDebug';
import EventRouter from '../events/EventRouter';
import Game from '../Game';
import type { DeserializedBlock } from '../network/Deserializer';
import type { NetworkManagerEventPayload } from '../network/NetworkEventPayloads';
import { NetworkManagerEventType } from '../network/NetworkEvents';
import { ClientSettingsEventType } from '../settings/SettingsManager';
import {
  type ChunkWorkerBatchPromotionUpdateMessage,
  type ChunkWorkerChunkBatchBuildMessage,
  type ChunkWorkerBlocksUpdateMessage,
  type ChunkWorkerChunkBuildMessage,
  type ChunkWorkerChunkRemoveMessage,
  type ChunkWorkerTerrainMeshingUpdateMessage,
  type ChunkWorkerChunksUpdateMessage,
  type ChunkWorkerChunkUpdateMessage,
  type TerrainMeshingMode,
  type WorkerEventPayload,
  WorkerEventType,
} from '../workers/ChunkWorkerConstants';

// Working variables
const fromVec2 = new Vector2();
const toVec2 = new Vector2();
const blockHitNormalVec3 = new Vector3();
const blockHitPointVec3 = new Vector3();
const rayDirectionVec3 = new Vector3();
const rayOriginVec3 = new Vector3();
const raycaster = new Raycaster();
const blockRaycastIntersections: Intersection<Object3D>[] = [];
const vec1 = new Vector3();
const vec2 = new Vector3();
const BLOCK_PREDICTION_TIMEOUT_MS = 1500;
const BLOCK_RAYCAST_EPSILON = 0.01;
const HALF_BATCH_WORLD_SIZE = BATCH_WORLD_SIZE / 2;
const VISIBILITY_CELL_SIZE = BATCH_WORLD_SIZE / 4;
const VIEW_DISTANCE_SQUARED_EPSILON = 0.0001;

type ChunkBlockUpdate = {
  globalCoordinate: Vector3Like;
  blockId: BlockId;
  blockRotationIndex?: number;
};

type BlockState = {
  blockId: BlockId;
  blockRotationIndex?: number;
};

type PredictedBlockLayer = BlockState & {
  expiresAtMs: number;
  predictionId: string;
};

type PredictedBlockEntry = {
  authoritativeBlockId: BlockId;
  authoritativeBlockRotationIndex?: number;
  globalCoordinate: Vector3Like;
  layers: PredictedBlockLayer[];
};

export type RaycastedBlock = {
  blockId: BlockId;
  blockRotationIndex: number;
  globalCoordinate: Vector3Like;
  neighborGlobalCoordinate: Vector3Like;
  hitPoint: Vector3Like;
  normal: Vector3Like;
};

export type ChunkVisibilityDebugState = {
  cachedVisibilityDisabled: boolean;
  forceFullRefreshEnabled: boolean;
  lastViewDistanceSquared: number;
  pendingFullRefresh: boolean;
  visibleBatchCount: number;
  wasViewDistanceEnabled: boolean | null;
};

export default class ChunkManager {
  private _game: Game;
  private _registry: ChunkRegistry = new ChunkRegistry();
  private _chunkBatchBuildRequestVersions: Map<BatchId, number> = new Map();
  private _firstChunkBatchBuilt: boolean = false;
  private _promotedBatchIds: Set<BatchId> = new Set();
  private _promotingBatchPendingChunkIds: Map<BatchId, Set<ChunkId>> = new Map();
  private _predictedBlocks: Map<string, PredictedBlockEntry> = new Map();
  private _predictionCoordinateKeysById: Map<string, Set<string>> = new Map();
  private _nextPredictionId: number = 1;
  private _visibleBatchIds: Set<BatchId> = new Set();
  private _lastVisibilityCellX: number | null = null;
  private _lastVisibilityCellZ: number | null = null;
  private _lastViewDistanceSquared: number = -1;
  private _wasViewDistanceEnabled: boolean | null = null;
  private _forceFullVisibilityRefresh: boolean = false;
  private _workerTerrainMeshingMode: TerrainMeshingMode | null = null;

  public constructor(game: Game) {
    this._game = game;
    this._setupEventListeners();
    this._syncChunkWorkerTerrainMeshingMode(false);
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
      NetworkManagerEventType.BlockEditPredictionResultsPacket,
      this._onBlockEditPredictionResultsPacket,
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

    EventRouter.instance.on(
      WorkerEventType.ChunkBuilt,
      this._onChunkBuilt,
    );

    EventRouter.instance.on(
      ClientSettingsEventType.Update,
      this._onClientSettingsUpdate,
    );
  }

  private _onAnimate = (_payload: RendererEventPayload.IAnimate): void => {
    ChunkStats.reset();
    this._expirePredictedBlocks(performance.now());

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
    const debugFlags = getDebugFlags();
    const fullRefreshRequested = this._forceFullVisibilityRefresh ||
      debugFlags.disableCachedChunkVisibility ||
      debugFlags.forceChunkVisibilityFullRefresh;

    if (modeChanged || viewDistanceChanged || cellChanged || fullRefreshRequested) {
      this._refreshVisibleBatches(
        fromVec2.set(cameraPos.x, cameraPos.z),
        viewDistanceSquared,
        modeChanged || fullRefreshRequested,
      );
      this._lastVisibilityCellX = cellX;
      this._lastVisibilityCellZ = cellZ;
      this._lastViewDistanceSquared = viewDistanceSquared;
      this._forceFullVisibilityRefresh = false;
    }

    this._wasViewDistanceEnabled = true;
    ChunkStats.visibleCount = this._visibleBatchIds.size;
  }

  private _onBlocksPacket = (payload: NetworkManagerEventPayload.IBlocksPacket) => {
    const updates: ChunkBlockUpdate[] = [];
    const { deserializedBlocks } = payload;

    for (let i = 0; i < deserializedBlocks.length; i++) {
      const deserializedBlock: DeserializedBlock = deserializedBlocks[i];
      const { id: blockId, globalCoordinate, blockRotationIndex } = deserializedBlock;
      const key = this._blockCoordinateKey(globalCoordinate);
      const prediction = this._predictedBlocks.get(key);

      if (!prediction) {
        updates.push({
          globalCoordinate,
          blockId,
          blockRotationIndex,
        });
        continue;
      }

      prediction.authoritativeBlockId = blockId;
      prediction.authoritativeBlockRotationIndex = this._normalizeBlockRotationIndex(blockRotationIndex);

      const effectiveState = this._getEffectivePredictedState(prediction);
      if (
        effectiveState &&
        this._blockStatesEqual(effectiveState, {
          blockId,
          blockRotationIndex,
        })
      ) {
        this._clearPredictionEntry(key, prediction);
        updates.push({
          globalCoordinate,
          blockId,
          blockRotationIndex,
        });
      }
    }

    this._applyBlockUpdates(updates);
  }

  private _onBlockEditPredictionResultsPacket = (
    payload: NetworkManagerEventPayload.IBlockEditPredictionResultsPacket,
  ) => {
    const { deserializedBlockEditPredictionResults } = payload;

    for (let i = 0; i < deserializedBlockEditPredictionResults.length; i++) {
      const result = deserializedBlockEditPredictionResults[i];
      if (result.action === 'confirm') {
        this.confirmPredictedBlocks(result.predictionId);
      } else {
        this.rollbackPredictedBlocks(result.predictionId);
      }
    }
  };

  private _onChunksPacket = (payload: NetworkManagerEventPayload.IChunksPacket) => {
    const { deserializedChunks } = payload;
    const affectedBatches: Set<BatchId> = new Set();
    const promotedAffectedBatches: Set<BatchId> = new Set();
    const workerChunkUpdates: ChunkWorkerChunksUpdateMessage['updates'] = [];

    for (let i = 0; i < deserializedChunks.length; i++) {
      const deserializedChunk = deserializedChunks[i];
      const { removed, originCoordinate, blocks, blockRotations } = deserializedChunk;

      if (!originCoordinate) {
        continue;
      }

      const chunkId = Chunk.originCoordinateToChunkId(originCoordinate);
      const batchId = Chunk.chunkIdToBatchId(chunkId);
      const chunk = this._registry.getChunk(chunkId);

      if (removed) {
        this._discardPredictedBlocksForChunk(chunkId);
      }

      if (removed && chunk) {
        this._registry.deleteChunk(chunkId);
        this._game.chunkMeshManager.removePromotedChunkMeshes(chunkId);
        this._promotingBatchPendingChunkIds.get(batchId)?.delete(chunkId);

        const message: ChunkWorkerChunkRemoveMessage = {
          type: 'chunk_remove',
          chunkId,
        };
        this._game.chunkWorkerClient.postMessage(message);

        if (this._promotedBatchIds.has(batchId)) {
          promotedAffectedBatches.add(batchId);
        } else {
          affectedBatches.add(batchId);
        }
      }

      if (!removed && blocks) {
        this._registry.registerChunk(originCoordinate, blocks, blockRotations);
        workerChunkUpdates.push({
          originCoordinate,
          blocks,
          blockRotations,
        });

        const predictedChunkUpdates = this._getPredictedBlockUpdatesForChunk(chunkId);
        if (predictedChunkUpdates.length > 0) {
          this._applyBlockUpdates(predictedChunkUpdates);
        }

        if (this._promotedBatchIds.has(batchId)) {
          promotedAffectedBatches.add(batchId);
        } else {
          affectedBatches.add(batchId);
        }
      }
    }

    if (workerChunkUpdates.length === 1) {
      const [ update ] = workerChunkUpdates;
      const message: ChunkWorkerChunkUpdateMessage = {
        type: 'chunk_update',
        originCoordinate: update.originCoordinate,
        blocks: update.blocks,
        blockRotations: update.blockRotations,
      };
      this._game.chunkWorkerClient.postMessage(message);
    } else if (workerChunkUpdates.length > 1) {
      // Keep the existing main-thread registry ownership, but batch worker ingress to
      // cut postMessage overhead when many chunks stream in together.
      const message: ChunkWorkerChunksUpdateMessage = {
        type: 'chunks_update',
        updates: workerChunkUpdates,
      };
      this._game.chunkWorkerClient.postMessage(message);
    }

    if (affectedBatches.size > 0 || promotedAffectedBatches.size > 0) {
      // World streaming is where cached visibility state is most likely to drift.
      // Schedule a one-shot full refresh on the next frame as a safety net.
      this._forceFullVisibilityRefresh = true;
    }

    for (const batchId of promotedAffectedBatches) {
      const chunkIds = this._registry.getBatchChunkIds(batchId);

      if (chunkIds.length === 0) {
        this._game.chunkMeshManager.removeAllBatchMeshes(batchId);
        this._cleanupPromotedBatch(batchId);
        continue;
      }

      this._queuePromotedBatchChunkBuilds(batchId);
    }

    // Build affected batches in order of proximity to the player
    const basePosition = this._game.camera.gameCameraAttachedEntity?.position || this._game.camera.activeCamera.position;
    
    // Sort batches by distance to player
    const sortedBatches = Array.from(affectedBatches).sort((batchId1, batchId2) => {
      const origin1 = Chunk.batchIdToBatchOrigin(batchId1);
      const origin2 = Chunk.batchIdToBatchOrigin(batchId2);
      return vec1.copy(origin1).distanceToSquared(basePosition) - vec2.copy(origin2).distanceToSquared(basePosition);
    });

    // Send batch build messages for affected batches
    for (let i = 0; i < sortedBatches.length; i++) {
      const batchId = sortedBatches[i];
      const chunkIds = this._registry.getBatchChunkIds(batchId);
      
      if (chunkIds.length === 0) {
        // Batch is now empty, remove its meshes
        this._game.chunkMeshManager.removeAllBatchMeshes(batchId);
        this._visibleBatchIds.delete(batchId);
        continue;
      }

      this._queueBatchBuild(batchId, chunkIds, true);
    }
  }

  private _sendBatchPromotionUpdate(batchId: BatchId, promoted: boolean): void {
    const message: ChunkWorkerBatchPromotionUpdateMessage = {
      type: 'batch_promotion_update',
      batchId,
      promoted,
    };
    this._game.chunkWorkerClient.postMessage(message);
  }

  private _queueBatchBuild(batchId: BatchId, chunkIds: ChunkId[], markPerformanceBaseline: boolean): void {
    const requestVersion = (this._chunkBatchBuildRequestVersions.get(batchId) ?? 0) + 1;
    this._chunkBatchBuildRequestVersions.set(batchId, requestVersion);

    const message: ChunkWorkerChunkBatchBuildMessage = {
      type: 'chunk_batch_build',
      batchId,
      chunkIds,
      requestVersion,
    };

    if (markPerformanceBaseline) {
      this._game.performanceBaselineManager.markChunkBatchBuildRequested();
    }

    this._game.chunkWorkerClient.postMessage(message);
  }

  private _startBatchPromotion(batchId: BatchId): void {
    if (this._promotedBatchIds.has(batchId)) {
      return;
    }

    const chunkIds = this._registry.getBatchChunkIds(batchId);
    if (chunkIds.length === 0) {
      return;
    }

    this._promotedBatchIds.add(batchId);
    this._promotingBatchPendingChunkIds.set(batchId, new Set(chunkIds));
    this._sendBatchPromotionUpdate(batchId, true);
  }

  private _queueChunkBuild(chunkId: ChunkId): void {
    const message: ChunkWorkerChunkBuildMessage = {
      type: 'chunk_build',
      chunkId,
    };
    this._game.chunkWorkerClient.postMessage(message);
  }

  private _queuePromotedBatchChunkBuilds(batchId: BatchId, skipChunkIds?: ReadonlySet<ChunkId>): void {
    const chunkIds = this._registry.getBatchChunkIds(batchId);
    if (chunkIds.length === 0) {
      return;
    }

    const pendingChunkIds = this._promotingBatchPendingChunkIds.get(batchId);
    if (pendingChunkIds) {
      pendingChunkIds.clear();
      for (let i = 0; i < chunkIds.length; i++) {
        pendingChunkIds.add(chunkIds[i]);
      }
    }

    for (let i = 0; i < chunkIds.length; i++) {
      const chunkId = chunkIds[i];

      if (skipChunkIds?.has(chunkId)) {
        continue;
      }

      this._queueChunkBuild(chunkId);
    }
  }

  private _cleanupPromotedBatch(batchId: BatchId): void {
    this._promotedBatchIds.delete(batchId);
    this._promotingBatchPendingChunkIds.delete(batchId);
    this._sendBatchPromotionUpdate(batchId, false);
    this._visibleBatchIds.delete(batchId);
  }

  private _onChunkBatchBuilt = (payload: WorkerEventPayload.IChunkBatchBuilt): void => {
    const {
      batchId,
      chunkIds,
      foliageGeometry,
      liquidGeometry,
      opaqueSolidGeometry,
      requestVersion,
      transparentSolidGeometry,
      blockCount,
    } = payload;

    if ((this._chunkBatchBuildRequestVersions.get(batchId) ?? 0) !== requestVersion) {
      this._game.performanceBaselineManager.markChunkBatchBuildCompleted(true);
      return;
    }

    if (this._promotedBatchIds.has(batchId)) {
      this._game.performanceBaselineManager.markChunkBatchBuildCompleted(true);
      return;
    }

    this._game.performanceBaselineManager.markChunkBatchBuildCompleted(false);

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
      const entries = performance.getEntriesByName('ChunkManager:first-chunk-batch-built-time', 'measure');
      this._game.performanceBaselineManager.recordFirstChunkBatchBuilt(
        entries.length > 0 ? entries[entries.length - 1].duration : 0,
      );
      performance.clearMeasures('ChunkManager:first-chunk-batch-built-time');
    }

    // Update batch meshes
    if (foliageGeometry) {
      this._game.chunkMeshManager.createOrUpdateBatchFoliageMesh(batchId, foliageGeometry);
    } else {
      this._game.chunkMeshManager.removeBatchFoliageMesh(batchId);
    }

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
      transparentFaceCount: ((transparentSolidGeometry?.indices.length || 0) + (foliageGeometry?.indices.length || 0)) / 3,
      liquidFaceCount: (liquidGeometry?.indices.length || 0) / 3,
    });
  };

  private _onChunkBuilt = (payload: WorkerEventPayload.IChunkBuilt): void => {
    const {
      batchId,
      chunkId,
      foliageGeometry,
      liquidGeometry,
      opaqueSolidGeometry,
      transparentSolidGeometry,
    } = payload;

    if (!this._promotedBatchIds.has(batchId)) {
      return;
    }

    if (!this._registry.getChunk(chunkId)) {
      this._game.chunkMeshManager.removePromotedChunkMeshes(chunkId);
      this._promotingBatchPendingChunkIds.get(batchId)?.delete(chunkId);
      return;
    }

    this._game.chunkMeshManager.applyPromotedChunkBuild(chunkId, {
      foliageGeometry,
      liquidGeometry,
      opaqueSolidGeometry,
      transparentSolidGeometry,
    });

    const pendingChunkIds = this._promotingBatchPendingChunkIds.get(batchId);
    if (pendingChunkIds) {
      pendingChunkIds.delete(chunkId);
      this._game.chunkMeshManager.removeAllBatchMeshes(batchId);

      if (pendingChunkIds.size === 0) {
        this._promotingBatchPendingChunkIds.delete(batchId);
      }
    }

    this._syncBatchVisibility(batchId);
  };

  private _onClientSettingsUpdate = (): void => {
    this._syncChunkWorkerTerrainMeshingMode(true);
  };

  private _syncChunkWorkerTerrainMeshingMode(remeshVisibleBatches: boolean): void {
    const nextMode = this._game.settingsManager.terrainMeshingMode;

    if (this._workerTerrainMeshingMode === nextMode) {
      return;
    }

    this._workerTerrainMeshingMode = nextMode;

    const message: ChunkWorkerTerrainMeshingUpdateMessage = {
      type: 'terrain_meshing_update',
      mode: nextMode,
    };
    this._game.chunkWorkerClient.postMessage(message);

    if (remeshVisibleBatches) {
      this._queueTerrainMeshingRemeshes();
    }
  }

  private _queueTerrainMeshingRemeshes(): void {
    const batchIds = this._game.settingsManager.qualityPerfTradeoff.viewDistance.enabled
      ? Array.from(this._visibleBatchIds)
      : this._registry.getBatchIds();

    for (let i = 0; i < batchIds.length; i++) {
      const batchId = batchIds[i];
      const chunkIds = this._registry.getBatchChunkIds(batchId);

      if (chunkIds.length === 0) {
        continue;
      }

      if (this._promotedBatchIds.has(batchId)) {
        this._queuePromotedBatchChunkBuilds(batchId);
        continue;
      }

      this._queueBatchBuild(batchId, chunkIds, false);
    }
  }

  public getChunk(chunkId: ChunkId): Chunk | undefined {
    return this._registry.getChunk(chunkId);
  }

  public getChunkByGlobalCoordinate(globalCoordinate: Vector3Like): Chunk | undefined {
    return this.getChunk(Chunk.globalCoordinateToChunkId(globalCoordinate));
  }

  public getVisibilityDebugState(): ChunkVisibilityDebugState {
    const debugFlags = getDebugFlags();

    return {
      cachedVisibilityDisabled: debugFlags.disableCachedChunkVisibility,
      forceFullRefreshEnabled: debugFlags.forceChunkVisibilityFullRefresh,
      lastViewDistanceSquared: this._lastViewDistanceSquared,
      pendingFullRefresh: this._forceFullVisibilityRefresh,
      visibleBatchCount: this._visibleBatchIds.size,
      wasViewDistanceEnabled: this._wasViewDistanceEnabled,
    };
  }

  public getBlock(globalCoordinate: Vector3Like): { blockId: BlockId, blockRotationIndex: number } | undefined {
    const chunk = this.getChunkByGlobalCoordinate(globalCoordinate);

    if (!chunk) {
      return undefined;
    }

    const localCoordinate = Chunk.globalCoordinateToLocalCoordinate(globalCoordinate);

    return {
      blockId: chunk.getBlockType(localCoordinate),
      blockRotationIndex: chunk.getBlockRotation(localCoordinate),
    };
  }

  public predictBlock(
    globalCoordinate: Vector3Like,
    blockId: BlockId,
    blockRotationIndex?: number,
    timeoutMs: number = BLOCK_PREDICTION_TIMEOUT_MS,
  ): boolean {
    return this.predictBlocks([
      {
        globalCoordinate,
        blockId,
        blockRotationIndex,
      },
    ], timeoutMs) !== undefined;
  }

  public predictBlocks(
    updates: ChunkBlockUpdate[],
    timeoutMs: number = BLOCK_PREDICTION_TIMEOUT_MS,
  ): string | undefined {
    const predictionId = this._createPredictionId();
    const updatesToApply: ChunkBlockUpdate[] = [];
    let didApplyPrediction = false;

    for (let i = 0; i < updates.length; i++) {
      const update = updates[i];
      const key = this._blockCoordinateKey(update.globalCoordinate);
      const existing = this._predictedBlocks.get(key);
      const baseline = existing ?? this._createPredictionEntry(update.globalCoordinate);

      if (!baseline) {
        continue;
      }

      const layer: PredictedBlockLayer = {
        predictionId,
        blockId: update.blockId,
        blockRotationIndex: this._normalizeBlockRotationIndex(update.blockRotationIndex),
        expiresAtMs: performance.now() + Math.max(0, timeoutMs),
      };

      baseline.layers.push(layer);
      this._predictedBlocks.set(key, baseline);
      this._linkPredictionIdToCoordinate(predictionId, key);
      didApplyPrediction = true;

      const effectiveState = this._getEffectivePredictedState(baseline);
      if (!effectiveState) {
        continue;
      }

      updatesToApply.push({
        globalCoordinate: baseline.globalCoordinate,
        blockId: effectiveState.blockId,
        blockRotationIndex: effectiveState.blockRotationIndex,
      });
    }

    if (!didApplyPrediction) {
      return undefined;
    }

    this._applyBlockUpdates(updatesToApply);
    return predictionId;
  }

  public submitPredictedBlocks(
    updates: ChunkBlockUpdate[],
    timeoutMs: number = BLOCK_PREDICTION_TIMEOUT_MS,
  ): string | undefined {
    const predictionId = this.predictBlocks(updates, timeoutMs);
    if (!predictionId) {
      return undefined;
    }

    this._game.networkManager.sendPredictedBlockEditsPacket(
      predictionId,
      updates.map(update => ({
        globalCoordinate: {
          x: update.globalCoordinate.x,
          y: update.globalCoordinate.y,
          z: update.globalCoordinate.z,
        },
        blockTypeId: update.blockId,
        blockRotationIndex: update.blockRotationIndex,
      })),
    );

    return predictionId;
  }

  public confirmPredictedBlocks(predictionId: string): boolean {
    const coordinateKeys = this._predictionCoordinateKeysById.get(predictionId);

    if (!coordinateKeys || coordinateKeys.size === 0) {
      return false;
    }

    const updates: ChunkBlockUpdate[] = [];
    let didConfirm = false;

    for (const key of Array.from(coordinateKeys)) {
      const prediction = this._predictedBlocks.get(key);
      if (!prediction) {
        this._unlinkPredictionIdFromCoordinate(predictionId, key);
        continue;
      }

      const confirmedLayer = prediction.layers.find(layer => layer.predictionId === predictionId);
      if (!confirmedLayer) {
        this._unlinkPredictionIdFromCoordinate(predictionId, key);
        continue;
      }

      prediction.authoritativeBlockId = confirmedLayer.blockId;
      prediction.authoritativeBlockRotationIndex = confirmedLayer.blockRotationIndex;
      this._removePredictionLayers(prediction, key, predictionId);
      didConfirm = true;

      const nextState = this._getEffectivePredictedState(prediction) ?? this._getAuthoritativeState(prediction);
      if (!this._isDisplayedBlockState(prediction.globalCoordinate, nextState)) {
        updates.push({
          globalCoordinate: prediction.globalCoordinate,
          blockId: nextState.blockId,
          blockRotationIndex: nextState.blockRotationIndex,
        });
      }

      if (prediction.layers.length === 0) {
        this._predictedBlocks.delete(key);
      }
    }

    if (updates.length > 0) {
      this._applyBlockUpdates(updates);
    }

    return didConfirm;
  }

  public rollbackPredictedBlocks(predictionId: string): boolean {
    const coordinateKeys = this._predictionCoordinateKeysById.get(predictionId);

    if (!coordinateKeys || coordinateKeys.size === 0) {
      return false;
    }

    const updates: ChunkBlockUpdate[] = [];
    let didRollback = false;

    for (const key of Array.from(coordinateKeys)) {
      const prediction = this._predictedBlocks.get(key);
      if (!prediction) {
        this._unlinkPredictionIdFromCoordinate(predictionId, key);
        continue;
      }

      const removed = this._removePredictionLayers(prediction, key, predictionId);
      if (!removed) {
        continue;
      }

      didRollback = true;
      const nextState = this._getEffectivePredictedState(prediction) ?? this._getAuthoritativeState(prediction);
      if (!this._isDisplayedBlockState(prediction.globalCoordinate, nextState)) {
        updates.push({
          globalCoordinate: prediction.globalCoordinate,
          blockId: nextState.blockId,
          blockRotationIndex: nextState.blockRotationIndex,
        });
      }

      if (prediction.layers.length === 0) {
        this._predictedBlocks.delete(key);
      }
    }

    if (updates.length > 0) {
      this._applyBlockUpdates(updates);
    }

    return didRollback;
  }

  public rollbackPredictedBlock(globalCoordinate: Vector3Like): boolean {
    const key = this._blockCoordinateKey(globalCoordinate);
    const prediction = this._predictedBlocks.get(key);

    if (!prediction) {
      return false;
    }

    const predictionIds = prediction.layers.map(layer => layer.predictionId);
    let didRollback = false;

    for (let i = 0; i < predictionIds.length; i++) {
      didRollback = this.rollbackPredictedBlocks(predictionIds[i]) || didRollback;
    }

    return didRollback;
  }

  public raycastBlock(ray: Ray, maxDistance: number): RaycastedBlock | undefined {
    rayOriginVec3.copy(ray.origin);
    rayDirectionVec3.copy(ray.direction).normalize();

    raycaster.near = 0;
    raycaster.far = maxDistance;
    raycaster.set(rayOriginVec3, rayDirectionVec3);

    blockRaycastIntersections.length = 0;
    const nearbyBlockMeshes = this._game.chunkMeshManager.getBlockRaycastMeshesNear(rayOriginVec3, maxDistance);
    raycaster.intersectObjects(nearbyBlockMeshes, false, blockRaycastIntersections);
    const intersection = blockRaycastIntersections[0];

    if (!intersection?.face) {
      return undefined;
    }

    blockHitNormalVec3
      .copy(intersection.face.normal)
      .transformDirection(intersection.object.matrixWorld)
      .normalize();
    blockHitPointVec3.copy(intersection.point);

    const globalCoordinate = {
      x: Math.floor(blockHitPointVec3.x - blockHitNormalVec3.x * BLOCK_RAYCAST_EPSILON),
      y: Math.floor(blockHitPointVec3.y - blockHitNormalVec3.y * BLOCK_RAYCAST_EPSILON),
      z: Math.floor(blockHitPointVec3.z - blockHitNormalVec3.z * BLOCK_RAYCAST_EPSILON),
    };
    const block = this.getBlock(globalCoordinate);

    if (!block || block.blockId === 0) {
      return undefined;
    }

    return {
      blockId: block.blockId,
      blockRotationIndex: block.blockRotationIndex,
      globalCoordinate,
      neighborGlobalCoordinate: {
        x: Math.floor(blockHitPointVec3.x + blockHitNormalVec3.x * BLOCK_RAYCAST_EPSILON),
        y: Math.floor(blockHitPointVec3.y + blockHitNormalVec3.y * BLOCK_RAYCAST_EPSILON),
        z: Math.floor(blockHitPointVec3.z + blockHitNormalVec3.z * BLOCK_RAYCAST_EPSILON),
      },
      hitPoint: {
        x: blockHitPointVec3.x,
        y: blockHitPointVec3.y,
        z: blockHitPointVec3.z,
      },
      normal: {
        x: blockHitNormalVec3.x,
        y: blockHitNormalVec3.y,
        z: blockHitNormalVec3.z,
      },
    };
  }

  public raycastBlockFromCamera(
    screenX: number = window.innerWidth / 2,
    screenY: number = window.innerHeight / 2,
    maxDistance: number = 8,
  ): RaycastedBlock | undefined {
    return this.raycastBlock(this._game.camera.rayForInteract(screenX, screenY), maxDistance);
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
  private _applyBlockUpdates(updates: ChunkBlockUpdate[]): boolean {
    const workerUpdate: Record<ChunkId, { localCoordinate: Vector3Like, blockId: BlockId, blockRotationIndex?: number }[]> = {};
    const newlyPromotedBatches: Set<BatchId> = new Set();
    const updatedChunkIdsByBatch: Map<BatchId, Set<ChunkId>> = new Map();

    for (const { globalCoordinate, blockId, blockRotationIndex } of updates) {
      const chunkId = Chunk.globalCoordinateToChunkId(globalCoordinate);
      const chunk = this._registry.getChunk(chunkId);

      if (!chunk) {
        continue;
      }

      const localCoordinate = Chunk.globalCoordinateToLocalCoordinate(globalCoordinate);
      const nextBlockRotationIndex = this._normalizeBlockRotationIndex(blockRotationIndex);
      if (
        chunk.getBlockType(localCoordinate) === blockId &&
        this._normalizeBlockRotationIndex(chunk.getBlockRotation(localCoordinate)) === nextBlockRotationIndex
      ) {
        continue;
      }

      this._registry.updateBlock(chunkId, localCoordinate, blockId, nextBlockRotationIndex);

      const batchId = Chunk.chunkIdToBatchId(chunkId);
      if (!this._promotedBatchIds.has(batchId)) {
        this._startBatchPromotion(batchId);
        if (this._promotedBatchIds.has(batchId)) {
          newlyPromotedBatches.add(batchId);
        }
      }

      let updatedChunkIds = updatedChunkIdsByBatch.get(batchId);
      if (!updatedChunkIds) {
        updatedChunkIds = new Set();
        updatedChunkIdsByBatch.set(batchId, updatedChunkIds);
      }
      updatedChunkIds.add(chunkId);

      if (workerUpdate[chunkId] === undefined) {
        workerUpdate[chunkId] = [];
      }

      workerUpdate[chunkId].push({
        localCoordinate: {
          x: localCoordinate.x,
          y: localCoordinate.y,
          z: localCoordinate.z,
        },
        blockId,
        blockRotationIndex: nextBlockRotationIndex,
      });
    }

    if (Object.keys(workerUpdate).length === 0) {
      return false;
    }

    const message: ChunkWorkerBlocksUpdateMessage = {
      type: 'blocks_update',
      update: workerUpdate,
    };
    this._game.chunkWorkerClient.postMessage(message);

    for (const batchId of newlyPromotedBatches) {
      this._queuePromotedBatchChunkBuilds(batchId, updatedChunkIdsByBatch.get(batchId));
    }

    return true;
  }

  private _blockCoordinateKey(globalCoordinate: Vector3Like): string {
    return `${globalCoordinate.x},${globalCoordinate.y},${globalCoordinate.z}`;
  }

  private _discardPredictedBlocksForChunk(chunkId: ChunkId): void {
    for (const [key, prediction] of this._predictedBlocks) {
      if (Chunk.globalCoordinateToChunkId(prediction.globalCoordinate) !== chunkId) {
        continue;
      }

      this._clearPredictionEntry(key, prediction);
    }
  }

  private _expirePredictedBlocks(nowMs: number): void {
    const expiredPredictionIds: Set<string> = new Set();

    for (const prediction of this._predictedBlocks.values()) {
      for (let i = 0; i < prediction.layers.length; i++) {
        if (nowMs >= prediction.layers[i].expiresAtMs) {
          expiredPredictionIds.add(prediction.layers[i].predictionId);
        }
      }
    }

    for (const predictionId of expiredPredictionIds) {
      this.rollbackPredictedBlocks(predictionId);
    }
  }

  private _getPredictedBlockUpdatesForChunk(chunkId: ChunkId): ChunkBlockUpdate[] {
    const updates: ChunkBlockUpdate[] = [];

    for (const prediction of this._predictedBlocks.values()) {
      if (Chunk.globalCoordinateToChunkId(prediction.globalCoordinate) !== chunkId) {
        continue;
      }

      const authoritativeState = this.getBlock(prediction.globalCoordinate);
      if (authoritativeState) {
        prediction.authoritativeBlockId = authoritativeState.blockId;
        prediction.authoritativeBlockRotationIndex = this._normalizeBlockRotationIndex(authoritativeState.blockRotationIndex);
      }

      const effectiveState = this._getEffectivePredictedState(prediction);
      if (!effectiveState) {
        continue;
      }

      updates.push({
        globalCoordinate: prediction.globalCoordinate,
        blockId: effectiveState.blockId,
        blockRotationIndex: effectiveState.blockRotationIndex,
      });
    }

    return updates;
  }

  private _clearPredictionEntry(key: string, prediction: PredictedBlockEntry): void {
    for (let i = 0; i < prediction.layers.length; i++) {
      this._unlinkPredictionIdFromCoordinate(prediction.layers[i].predictionId, key);
    }

    this._predictedBlocks.delete(key);
  }

  private _createPredictionEntry(globalCoordinate: Vector3Like): PredictedBlockEntry | undefined {
    const baseline = this.getBlock(globalCoordinate);

    if (!baseline) {
      return undefined;
    }

    return {
      authoritativeBlockId: baseline.blockId,
      authoritativeBlockRotationIndex: this._normalizeBlockRotationIndex(baseline.blockRotationIndex),
      globalCoordinate: {
        x: globalCoordinate.x,
        y: globalCoordinate.y,
        z: globalCoordinate.z,
      },
      layers: [],
    };
  }

  private _createPredictionId(): string {
    return `block-prediction-${this._nextPredictionId++}`;
  }

  private _getAuthoritativeState(prediction: PredictedBlockEntry): BlockState {
    return {
      blockId: prediction.authoritativeBlockId,
      blockRotationIndex: prediction.authoritativeBlockRotationIndex,
    };
  }

  private _getEffectivePredictedState(prediction: PredictedBlockEntry): BlockState | undefined {
    const layer = prediction.layers[prediction.layers.length - 1];
    return layer ? {
      blockId: layer.blockId,
      blockRotationIndex: layer.blockRotationIndex,
    } : undefined;
  }

  private _blockStatesEqual(left: BlockState, right: BlockState): boolean {
    return left.blockId === right.blockId &&
      this._normalizeBlockRotationIndex(left.blockRotationIndex) === this._normalizeBlockRotationIndex(right.blockRotationIndex);
  }

  private _isDisplayedBlockState(globalCoordinate: Vector3Like, nextState: BlockState): boolean {
    const displayed = this.getBlock(globalCoordinate);

    if (!displayed) {
      return false;
    }

    return this._blockStatesEqual(displayed, nextState);
  }

  private _linkPredictionIdToCoordinate(predictionId: string, coordinateKey: string): void {
    let coordinateKeys = this._predictionCoordinateKeysById.get(predictionId);

    if (!coordinateKeys) {
      coordinateKeys = new Set();
      this._predictionCoordinateKeysById.set(predictionId, coordinateKeys);
    }

    coordinateKeys.add(coordinateKey);
  }

  private _unlinkPredictionIdFromCoordinate(predictionId: string, coordinateKey: string): void {
    const coordinateKeys = this._predictionCoordinateKeysById.get(predictionId);
    if (!coordinateKeys) {
      return;
    }

    coordinateKeys.delete(coordinateKey);
    if (coordinateKeys.size === 0) {
      this._predictionCoordinateKeysById.delete(predictionId);
    }
  }

  private _removePredictionLayers(prediction: PredictedBlockEntry, coordinateKey: string, predictionId: string): boolean {
    const nextLayers = prediction.layers.filter(layer => layer.predictionId !== predictionId);
    if (nextLayers.length === prediction.layers.length) {
      this._unlinkPredictionIdFromCoordinate(predictionId, coordinateKey);
      return false;
    }

    prediction.layers = nextLayers;
    this._unlinkPredictionIdFromCoordinate(predictionId, coordinateKey);
    return true;
  }

  private _normalizeBlockRotationIndex(blockRotationIndex?: number): number | undefined {
    return blockRotationIndex === undefined || blockRotationIndex === 0 ? undefined : blockRotationIndex;
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
