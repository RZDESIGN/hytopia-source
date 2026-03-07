import ChunkStats from '../chunks/ChunkStats';
import EntityStats from '../entities/EntityStats';
import GLTFStats from '../gltf/GLTFStats';
import SceneUIStats from '../ui/SceneUIStats';
import SampleWindow, { type SampleWindowSnapshot } from './SampleWindow';

import type Game from '../Game';

declare global {
  interface Window {
    __HYTOPIA_PERF__?: {
      reset: () => void;
      snapshot: () => PerformanceBaselineSnapshot;
    };
  }
}

export type PerformanceBaselineSnapshot = {
  chunkWorker: {
    buildCompletions: number;
    buildRequests: number;
    currentBacklog: number;
    peakBacklog: number;
    staleBuildResults: number;
  };
  frame: {
    currentFps: number;
    currentFrameMs: number;
    longFrameCount: number;
    longestFrameMs: number;
    timings: SampleWindowSnapshot;
  };
  generatedAt: string;
  gltf: {
    clonedMeshCount: number;
    drawCallsSaved: number;
    instancedMeshCount: number;
    updateTimings: SampleWindowSnapshot;
  };
  memory: {
    refreshRate: number;
    totalHeapMb: number;
    usedHeapMb: number;
  };
  network: {
    connectedToFirstPacketMs: number | null;
    firstChunkBatchBuiltMs: number | null;
    inboundApplyTimings: SampleWindowSnapshot;
    inboundMessages: number;
    inboundPackets: number;
    inboundWireBytes: number;
  };
  sceneUI: {
    count: number;
    visibleCount: number;
  };
  world: {
    chunkCount: number;
    entityCount: number;
  };
};

const LONG_FRAME_THRESHOLD_MS = 50;

export default class PerformanceBaselineManager {
  private _chunkBuildCompletions: number = 0;
  private _chunkBuildRequests: number = 0;
  private _connectedToFirstPacketMs: number | null = null;
  private _currentChunkBuildBacklog: number = 0;
  private _frameTimes = new SampleWindow();
  private _game: Game;
  private _gltfUpdateTimes = new SampleWindow();
  private _inboundApplyTimes = new SampleWindow();
  private _inboundMessages: number = 0;
  private _inboundPackets: number = 0;
  private _inboundWireBytes: number = 0;
  private _longFrameCount: number = 0;
  private _longestFrameMs: number = 0;
  private _peakChunkBuildBacklog: number = 0;
  private _staleChunkBuildResults: number = 0;
  private _firstChunkBatchBuiltMs: number | null = null;

  public constructor(game: Game) {
    this._game = game;

    window.__HYTOPIA_PERF__ = {
      reset: () => this.reset(),
      snapshot: () => this.snapshot(),
    };
  }

  public get currentChunkBuildBacklog(): number {
    return this._currentChunkBuildBacklog;
  }

  public get peakChunkBuildBacklog(): number {
    return this._peakChunkBuildBacklog;
  }

  public get staleChunkBuildResults(): number {
    return this._staleChunkBuildResults;
  }

  public markChunkBatchBuildCompleted(stale: boolean = false): void {
    this._chunkBuildCompletions++;
    this._currentChunkBuildBacklog = Math.max(0, this._currentChunkBuildBacklog - 1);

    if (stale) {
      this._staleChunkBuildResults++;
    }
  }

  public markChunkBatchBuildRequested(): void {
    this._chunkBuildRequests++;
    this._currentChunkBuildBacklog++;
    this._peakChunkBuildBacklog = Math.max(this._peakChunkBuildBacklog, this._currentChunkBuildBacklog);
  }

  public recordConnectedToFirstPacket(durationMs: number): void {
    this._connectedToFirstPacketMs = durationMs;
  }

  public recordFirstChunkBatchBuilt(durationMs: number): void {
    if (this._firstChunkBatchBuiltMs === null) {
      this._firstChunkBatchBuiltMs = durationMs;
    }
  }

  public recordFrame(frameDeltaMs: number): void {
    this._frameTimes.record(frameDeltaMs);
    this._longestFrameMs = Math.max(this._longestFrameMs, frameDeltaMs);

    if (frameDeltaMs >= LONG_FRAME_THRESHOLD_MS) {
      this._longFrameCount++;
    }
  }

  public recordGLTFUpdate(durationMs: number): void {
    this._gltfUpdateTimes.record(durationMs);
  }

  public recordInboundMessage(wireBytes: number, packetCount: number, applyDurationMs: number): void {
    this._inboundMessages++;
    this._inboundPackets += packetCount;
    this._inboundWireBytes += wireBytes;
    this._inboundApplyTimes.record(applyDurationMs);
  }

  public reset(): void {
    this._chunkBuildCompletions = 0;
    this._chunkBuildRequests = 0;
    this._connectedToFirstPacketMs = null;
    this._currentChunkBuildBacklog = 0;
    this._frameTimes.clear();
    this._gltfUpdateTimes.clear();
    this._inboundApplyTimes.clear();
    this._inboundMessages = 0;
    this._inboundPackets = 0;
    this._inboundWireBytes = 0;
    this._longFrameCount = 0;
    this._longestFrameMs = 0;
    this._peakChunkBuildBacklog = 0;
    this._staleChunkBuildResults = 0;
    this._firstChunkBatchBuiltMs = null;
  }

  public snapshot(): PerformanceBaselineSnapshot {
    const performanceMetrics = this._game.performanceMetricsManager;

    return {
      chunkWorker: {
        buildCompletions: this._chunkBuildCompletions,
        buildRequests: this._chunkBuildRequests,
        currentBacklog: this._currentChunkBuildBacklog,
        peakBacklog: this._peakChunkBuildBacklog,
        staleBuildResults: this._staleChunkBuildResults,
      },
      frame: {
        currentFps: performanceMetrics.fps,
        currentFrameMs: performanceMetrics.deltaTime * 1000,
        longFrameCount: this._longFrameCount,
        longestFrameMs: this._longestFrameMs,
        timings: this._frameTimes.snapshot(),
      },
      generatedAt: new Date().toISOString(),
      gltf: {
        clonedMeshCount: GLTFStats.clonedMeshCount,
        drawCallsSaved: GLTFStats.drawCallsSaved,
        instancedMeshCount: GLTFStats.instancedMeshCount,
        updateTimings: this._gltfUpdateTimes.snapshot(),
      },
      memory: {
        refreshRate: performanceMetrics.refreshRate,
        totalHeapMb: performanceMetrics.totalMemory / 1048576,
        usedHeapMb: performanceMetrics.usedMemory / 1048576,
      },
      network: {
        connectedToFirstPacketMs: this._connectedToFirstPacketMs,
        firstChunkBatchBuiltMs: this._firstChunkBatchBuiltMs,
        inboundApplyTimings: this._inboundApplyTimes.snapshot(),
        inboundMessages: this._inboundMessages,
        inboundPackets: this._inboundPackets,
        inboundWireBytes: this._inboundWireBytes,
      },
      sceneUI: {
        count: SceneUIStats.count,
        visibleCount: SceneUIStats.visibleCount,
      },
      world: {
        chunkCount: ChunkStats.count,
        entityCount: EntityStats.count,
      },
    };
  }
}
