import Chunk from './Chunk';
import { BatchId, ChunkId } from './ChunkConstants';
import ChunkStats from './ChunkStats';
import { BlockId } from '../blocks/BlockConstants';
import { Vector3Like } from 'three';

type BatchMetadata = {
  blockCount: number,
  opaqueFaceCount: number,
  transparentFaceCount: number,
  liquidFaceCount: number,
};

export default class ChunkRegistry {
  protected _chunks: Map<ChunkId, Chunk> = new Map();
  protected _batches: Map<BatchId, {
    chunkIds: Set<ChunkId>,
    meta: BatchMetadata,
  }> = new Map();

  public hasChunk(chunkId: ChunkId): boolean {
    return this._chunks.has(chunkId);
  }

  public getChunk(chunkId: ChunkId): Chunk | undefined {
    return this._chunks.get(chunkId);
  }

  public updateBlock(chunkId: ChunkId, localCoordinate: Vector3Like, blockId: BlockId, blockRotationIndex?: number): void {
    const chunk = this._chunks.get(chunkId);

    if (!chunk) {
      return;
    }

    chunk.setBlock(localCoordinate, blockId, blockRotationIndex);
  }

  public registerChunk(originCoordinate: Vector3Like, blocks: Uint8Array, blockRotations?: number[]): void {
    const chunk = new Chunk(originCoordinate, blocks, blockRotations);
    const chunkId = chunk.chunkId;
    
    this._chunks.set(chunkId, chunk);
    ChunkStats.count = this._chunks.size;

    // Add chunk to its batch
    const batchId = Chunk.chunkIdToBatchId(chunkId);
    let batch = this._batches.get(batchId);
    
    if (!batch) {
      batch = {
        chunkIds: new Set(),
        meta: {
          blockCount: 0,
          opaqueFaceCount: 0,
          transparentFaceCount: 0,
          liquidFaceCount: 0,
        },
      };
      this._batches.set(batchId, batch);
    }
    
    batch.chunkIds.add(chunkId);
  }

  public deleteChunk(chunkId: ChunkId): void {
    if (!this._chunks.has(chunkId)) {
      return;
    }

    this._chunks.delete(chunkId);
    ChunkStats.count = this._chunks.size;

    // Remove chunk from its batch
    const batchId = Chunk.chunkIdToBatchId(chunkId);
    const batch = this._batches.get(batchId);
    
    if (batch) {
      batch.chunkIds.delete(chunkId);
      
      // If batch is empty, remove it and subtract its stats
      if (batch.chunkIds.size === 0) {
        ChunkStats.blockCount -= batch.meta.blockCount;
        ChunkStats.opaqueFaceCount -= batch.meta.opaqueFaceCount;
        ChunkStats.transparentFaceCount -= batch.meta.transparentFaceCount;
        ChunkStats.liquidFaceCount -= batch.meta.liquidFaceCount;
        this._batches.delete(batchId);
      }
    }
  }

  public getBatchChunkIds(batchId: BatchId): ChunkId[] {
    const batch = this._batches.get(batchId);
    return batch ? Array.from(batch.chunkIds) : [];
  }

  public getBatchIds(): BatchId[] {
    return Array.from(this._batches.keys());
  }

  public updateBatchMetadata(batchId: BatchId, meta: BatchMetadata): void {
    const batch = this._batches.get(batchId);

    if (!batch) {
      return;
    }

    // Update global stats by subtracting old values and adding new ones
    ChunkStats.blockCount -= batch.meta.blockCount;
    ChunkStats.opaqueFaceCount -= batch.meta.opaqueFaceCount;
    ChunkStats.transparentFaceCount -= batch.meta.transparentFaceCount;
    ChunkStats.liquidFaceCount -= batch.meta.liquidFaceCount;

    batch.meta.blockCount = meta.blockCount;
    batch.meta.opaqueFaceCount = meta.opaqueFaceCount;
    batch.meta.transparentFaceCount = meta.transparentFaceCount;
    batch.meta.liquidFaceCount = meta.liquidFaceCount;

    ChunkStats.blockCount += batch.meta.blockCount;
    ChunkStats.opaqueFaceCount += batch.meta.opaqueFaceCount;
    ChunkStats.transparentFaceCount += batch.meta.transparentFaceCount;
    ChunkStats.liquidFaceCount += batch.meta.liquidFaceCount;
  }
}
