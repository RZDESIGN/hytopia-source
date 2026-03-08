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
import {
  type ChunkWorkerChunkBatchBuildMessage,
  type ChunkWorkerBlocksUpdateMessage,
  type ChunkWorkerChunkRemoveMessage,
  type ChunkWorkerChunksUpdateMessage,
  type ChunkWorkerChunkUpdateMessage,
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
const VISIBILITY_FULL_RESYNC_INTERVAL_FRAMES = 60;

type ChunkBlockUpdate = {
  globalCoordinate: Vector3Like;
  blockId: BlockId;
  blockRotationIndex?: number;
};

type PredictedBlockEntry = {
  baselineBlockId: BlockId;
  baselineBlockRotationIndex?: number;
  blockId: BlockId;
  blockRotationIndex?: number;
  expiresAtMs: number;
  globalCoordinate: Vector3Like;
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
  fullResyncIntervalFrames: number;
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
  private _predictedBlocks: Map<string, PredictedBlockEntry> = new Map();
  private _visibleBatchIds: Set<BatchId> = new Set();
  private _lastVisibilityCellX: number | null = null;
  private _lastVisibilityCellZ: number | null = null;
  private _lastViewDistanceSquared: number = -1;
  private _wasViewDistanceEnabled: boolean | null = null;
  private _forceFullVisibilityRefresh: boolean = false;

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
      debugFlags.forceChunkVisibilityFullRefresh ||
      (this._game.performanceMetricsManager.frameCount % VISIBILITY_FULL_RESYNC_INTERVAL_FRAMES) === 0;

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
      this._predictedBlocks.delete(this._blockCoordinateKey(globalCoordinate));
      updates.push({
        globalCoordinate,
        blockId,
        blockRotationIndex,
      });
    }

    this._applyBlockUpdates(updates);
  }

  private _onChunksPacket = (payload: NetworkManagerEventPayload.IChunksPacket) => {
    const { deserializedChunks } = payload;
    const affectedBatches: Set<BatchId> = new Set();
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

        const message: ChunkWorkerChunkRemoveMessage = {
          type: 'chunk_remove',
          chunkId,
        };
        this._game.chunkWorkerClient.postMessage(message);

        affectedBatches.add(batchId);
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

        affectedBatches.add(batchId);
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

    if (affectedBatches.size > 0) {
      // World streaming is where cached visibility state is most likely to drift.
      // Schedule a one-shot full refresh on the next frame as a safety net.
      this._forceFullVisibilityRefresh = true;
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

      const requestVersion = (this._chunkBatchBuildRequestVersions.get(batchId) ?? 0) + 1;
      this._chunkBatchBuildRequestVersions.set(batchId, requestVersion);
      const message: ChunkWorkerChunkBatchBuildMessage = {
        type: 'chunk_batch_build',
        batchId,
        chunkIds,
        requestVersion,
      };
      this._game.performanceBaselineManager.markChunkBatchBuildRequested();
      this._game.chunkWorkerClient.postMessage(message);
    }
  }

  private _onChunkBatchBuilt = (payload: WorkerEventPayload.IChunkBatchBuilt): void => {
    const {
      batchId,
      chunkIds,
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

  public getVisibilityDebugState(): ChunkVisibilityDebugState {
    const debugFlags = getDebugFlags();

    return {
      cachedVisibilityDisabled: debugFlags.disableCachedChunkVisibility,
      forceFullRefreshEnabled: debugFlags.forceChunkVisibilityFullRefresh,
      fullResyncIntervalFrames: VISIBILITY_FULL_RESYNC_INTERVAL_FRAMES,
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
    const baseline = this.getBlock(globalCoordinate);

    if (!baseline) {
      return false;
    }

    const key = this._blockCoordinateKey(globalCoordinate);
    const existing = this._predictedBlocks.get(key);

    this._predictedBlocks.set(key, {
      baselineBlockId: existing?.baselineBlockId ?? baseline.blockId,
      baselineBlockRotationIndex: existing?.baselineBlockRotationIndex ?? this._normalizeBlockRotationIndex(baseline.blockRotationIndex),
      blockId,
      blockRotationIndex: this._normalizeBlockRotationIndex(blockRotationIndex),
      expiresAtMs: performance.now() + Math.max(0, timeoutMs),
      globalCoordinate: {
        x: globalCoordinate.x,
        y: globalCoordinate.y,
        z: globalCoordinate.z,
      },
    });

    return this._applyBlockUpdates([
      {
        globalCoordinate,
        blockId,
        blockRotationIndex,
      },
    ]);
  }

  public rollbackPredictedBlock(globalCoordinate: Vector3Like): boolean {
    const key = this._blockCoordinateKey(globalCoordinate);
    const entry = this._predictedBlocks.get(key);

    if (!entry) {
      return false;
    }

    this._predictedBlocks.delete(key);

    return this._applyBlockUpdates([
      {
        globalCoordinate: entry.globalCoordinate,
        blockId: entry.baselineBlockId,
        blockRotationIndex: entry.baselineBlockRotationIndex,
      },
    ]);
  }

  public raycastBlock(ray: Ray, maxDistance: number): RaycastedBlock | undefined {
    rayOriginVec3.copy(ray.origin);
    rayDirectionVec3.copy(ray.direction).normalize();

    raycaster.near = 0;
    raycaster.far = maxDistance;
    raycaster.set(rayOriginVec3, rayDirectionVec3);

    blockRaycastIntersections.length = 0;
    const nearbySolidMeshes = this._game.chunkMeshManager.getSolidMeshesNear(rayOriginVec3, maxDistance);
    raycaster.intersectObjects(nearbySolidMeshes, false, blockRaycastIntersections);
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

    for (const { globalCoordinate, blockId, blockRotationIndex } of updates) {
      const chunkId = Chunk.globalCoordinateToChunkId(globalCoordinate);
      const chunk = this._registry.getChunk(chunkId);

      if (!chunk) {
        continue;
      }

      const localCoordinate = Chunk.globalCoordinateToLocalCoordinate(globalCoordinate);
      this._registry.updateBlock(chunkId, localCoordinate, blockId, blockRotationIndex);

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
        blockRotationIndex,
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

      this._predictedBlocks.delete(key);
    }
  }

  private _expirePredictedBlocks(nowMs: number): void {
    const expiredCoordinates: Vector3Like[] = [];

    for (const prediction of this._predictedBlocks.values()) {
      if (nowMs >= prediction.expiresAtMs) {
        expiredCoordinates.push(prediction.globalCoordinate);
      }
    }

    for (const globalCoordinate of expiredCoordinates) {
      this.rollbackPredictedBlock(globalCoordinate);
    }
  }

  private _getPredictedBlockUpdatesForChunk(chunkId: ChunkId): ChunkBlockUpdate[] {
    const updates: ChunkBlockUpdate[] = [];

    for (const prediction of this._predictedBlocks.values()) {
      if (Chunk.globalCoordinateToChunkId(prediction.globalCoordinate) !== chunkId) {
        continue;
      }

      updates.push({
        globalCoordinate: prediction.globalCoordinate,
        blockId: prediction.blockId,
        blockRotationIndex: prediction.blockRotationIndex,
      });
    }

    return updates;
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
