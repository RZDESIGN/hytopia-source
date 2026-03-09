import Game from '../Game';
import { Vector3 } from 'three';
import Stats from 'three/examples/jsm/libs/stats.module.js';
import { GUI } from 'three/examples/jsm/libs/lil-gui.module.min.js';
import ArrowStats from '../arrows/ArrowStats';
import AudioStats from '../audio/AudioStats';
import ChunkStats from '../chunks/ChunkStats';
import EntityStats from '../entities/EntityStats';
import GLTFStats from '../gltf/GLTFStats';
import LocalPredictionStats from '../entities/LocalPredictionStats';
import SceneUIStats from '../ui/SceneUIStats';
import type { DetailedPerformanceBaselineSnapshot } from './PerformanceBaselineManager';

const DEBUG_PANEL_Z_INDEX = '100000';

type FrameBudgetThresholds = {
  drawCalls: number;
  sceneUI: number;
  transparentFaces: number;
  triangles: number;
  visibleChunks: number;
};

const DEFAULT_FRAME_BUDGETS: FrameBudgetThresholds = {
  drawCalls: 900,
  sceneUI: 10,
  transparentFaces: 30000,
  triangles: 1800000,
  visibleChunks: 280,
};

const FRAME_BUDGETS_BY_PRESET: Record<string, FrameBudgetThresholds> = {
  HIGH: {
    drawCalls: 1200,
    sceneUI: 12,
    transparentFaces: 50000,
    triangles: 2600000,
    visibleChunks: 360,
  },
  LOW: {
    drawCalls: 650,
    sceneUI: 6,
    transparentFaces: 15000,
    triangles: 950000,
    visibleChunks: 180,
  },
  MEDIUM: DEFAULT_FRAME_BUDGETS,
  POWER_SAVING: {
    drawCalls: 450,
    sceneUI: 4,
    transparentFaces: 10000,
    triangles: 550000,
    visibleChunks: 120,
  },
  ULTRA: {
    drawCalls: 1500,
    sceneUI: 14,
    transparentFaces: 70000,
    triangles: 3600000,
    visibleChunks: 480,
  },
};

// Working variables
const vec3 = new Vector3();

export interface DebugPanelConfig {
  player: {
    position: `${string}, ${string}, ${string}`;
  };
  camera: {
    position: `${string}, ${string}, ${string}`;
  };
  server: {
    sendProtocol: string;
    receiveProtocol: string;
    version: string;
  };
  webgl: {
    drawCalls: number;
    geometries: number;
    programs: number;
    textures: number;
    triangles: number;
  };
  performance: {
    adaptiveResolution: number;
    frameBudgetMs: number;
    frameP95Ms: number;
    fps: number;
    renderResolution: string;
    targetFps: number;
    pressure: string;
    worldPressure: string;
  };
  budget: {
    drawCalls: string;
    frameTime: string;
    postFx: string;
    sceneUI: string;
    triangles: string;
    visibility: string;
  };
  entity: {
    count: number;
    staticEnvironmentCount: number;
    inViewDistanceCount: number;
    frustumCulledCount: number;
    updateSkipCount: number;
    animationPlayCount: number;
    localMatrixUpdateCount: number;
    worldMatrixUpdateCount: number;
    lightLevelUpdateCount: number;
    customTextureCount: number;
  };
  prediction: {
    entityId: number;
    supportsInputAcknowledgements: boolean;
    bufferedCommandCount: number;
    lastAcknowledgedInputSequenceNumber: number;
    lastReplayCommandCount: number;
    lastReplaySubstepCount: number;
    peakReplayCommandCount: number;
    peakReplaySubstepCount: number;
    horizontalError: number;
    verticalError: number;
    rotationErrorDeg: number;
  };
  chunk: {
    count: number;
    visibleCount: number;
    blockCount: number;
    opaqueFaceCount: number;
    transparentFaceCount: number;
    liquidFaceCount: number;
    blockTextureCount: number,
  };
  gltf: {
    fileCount: number;
    sourceMeshCount: number;
    clonedMeshCount: number;
    instancedMeshCount: number;
    drawCallsSaved: number;
    attributeElementsUpdated: number;
    attributeUploadsSkipped: number;
  };
  sceneUI: {
    count: number;
    visibleCount: number;
  };
  arrow: {
    count: number;
    visibleCount: number;
  };
  audio: {
    count: number;
    matrixUpdateCount: number;
    matrixUpdateSkipCount: number;
  };
}

// We want to access navigator.userAgentData, but TypeScript currently does not
// provide a default type for it, so we define the type here.
// TODO: A similar type definition exists elsewhere, so consider consolidating them.
type MyNavigator = {
  userAgentData?: {
    // These properties may not actually be optional, but since userAgentData current
    // status is experimental, mark them as optional just in case.
    brands?: { brand: string, version: string }[];
    mobile?: boolean;
    platform?: string;
  };
};

export default class DebugPanel {
  private _game: Game;
  private _config: DebugPanelConfig = {
    player: {
      position: `-, -, -`,
    },
    camera: {
      position: `-, -, -`,
    },
    server: {
      sendProtocol: 'ws',
      receiveProtocol: 'ws',
      version: 'unknown',
    },
    performance: {
      adaptiveResolution: 1,
      frameBudgetMs: 0,
      frameP95Ms: 0,
      fps: 0,
      renderResolution: '-',
      targetFps: 60,
      pressure: 'unknown',
      worldPressure: 'unknown',
    },
    budget: {
      drawCalls: '-',
      frameTime: '-',
      postFx: '-',
      sceneUI: '-',
      triangles: '-',
      visibility: '-',
    },
    webgl: {
      drawCalls: 0,
      geometries: 0,
      programs: 0,
      textures: 0,
      triangles: 0,
    },
    entity: {
      count: 0,
      staticEnvironmentCount: 0,
      inViewDistanceCount: 0,
      frustumCulledCount: 0,
      updateSkipCount: 0,
      animationPlayCount: 0,
      localMatrixUpdateCount: 0,
      worldMatrixUpdateCount: 0,
      lightLevelUpdateCount: 0,
      customTextureCount: 0,
    },
    prediction: {
      entityId: -1,
      supportsInputAcknowledgements: false,
      bufferedCommandCount: 0,
      lastAcknowledgedInputSequenceNumber: -1,
      lastReplayCommandCount: 0,
      lastReplaySubstepCount: 0,
      peakReplayCommandCount: 0,
      peakReplaySubstepCount: 0,
      horizontalError: 0,
      verticalError: 0,
      rotationErrorDeg: 0,
    },
    chunk: {
      count: 0,
      visibleCount: 0,
      blockCount: 0,
      opaqueFaceCount: 0,
      transparentFaceCount: 0,
      liquidFaceCount: 0,
      blockTextureCount: 0,
    },
    gltf: {
      fileCount: 0,
      sourceMeshCount: 0,
      clonedMeshCount: 0,
      instancedMeshCount: 0,
      drawCallsSaved: 0,
      attributeElementsUpdated: 0,
      attributeUploadsSkipped: 0,
    },
    sceneUI: {
      count: 0,
      visibleCount: 0,
    },
    arrow: {
      count: 0,
      visibleCount: 0,
    },
    audio: {
      count: 0,
      matrixUpdateCount: 0,
      matrixUpdateSkipCount: 0,
    },
  };
  private _gui: GUI = new GUI();
  private _stats: Stats = new Stats();
  private _memoryStatsPanel: Stats.Panel = this._stats.addPanel(new Stats.Panel('MB', '#00ff00', '#000000'));
  private _rttStatsPanel: Stats.Panel = this._stats.addPanel(new Stats.Panel('RTT(ms)', '#ff0000', '#000000'));
  private _visible: boolean = false;

  constructor(game: Game) {
    this._game = game;
    this._setup();
    this.setVisibility(false);
  }

  private _setup(): void {
    // Lobby panel
    const lobbyFolder = this._gui.addFolder('Lobby').close();
    lobbyFolder.add({ lobbyId: new URLSearchParams(window.location.search).get('lobbyId') || '-' }, 'lobbyId').name('Lobby ID');

    // User Agent panel
    // This is most likely used only for problem reporting, so close by default.
    const userAgentFolder = this._gui.addFolder('User Agent').close();

    // Since navigator.userAgent might be deprecated in the future, added a guard for it.
    if ('userAgent' in navigator) {
      userAgentFolder.add({ value: String(navigator.userAgent)}, 'value').name('User Agent');
    }

    const myNavigator = navigator as MyNavigator;

    if ('userAgentData' in myNavigator) {
      const brandsFolder = userAgentFolder.addFolder('Brands');
      myNavigator.userAgentData!.brands?.forEach(({ brand, version }, index) => {
        brandsFolder.add({ value: `${brand}:${version}`}, 'value').name(`Brand[${index}]`);
      });
      // This String() is for displaying the literal string 'undefined' for unset data.
      userAgentFolder.add({ value: String(myNavigator.userAgentData!.mobile)}, 'value').name('Mobile');
      userAgentFolder.add({ value: String(myNavigator.userAgentData!.platform)}, 'value').name('Platform');
    }

    // Player panel
    const playerFoler = this._gui.addFolder('Player');
    playerFoler.add(this._config.player, 'position').name('Position');

    // Camera panel
    const cameraFolder = this._gui.addFolder('Camera');
    cameraFolder.add(this._config.camera, 'position').name('Position');

    // server panel
    const serverFolder = this._gui.addFolder('Server');
    serverFolder.add(this._config.server, 'sendProtocol').name('Send Protocol');
    serverFolder.add(this._config.server, 'receiveProtocol').name('Receive Protocol');
    serverFolder.add(this._config.server, 'version').name('SDK Version');

    // performance panel
    const performanceFolder = this._gui.addFolder('Performance');
    performanceFolder.add(this._game.settingsManager, 'qualityPresetLevel').name('Quality Preset');
    performanceFolder.add(this._config.performance, 'fps').name('FPS');
    performanceFolder.add(this._config.performance, 'targetFps').name('Target FPS');
    performanceFolder.add(this._config.performance, 'frameBudgetMs').name('Budget (ms)');
    performanceFolder.add(this._config.performance, 'frameP95Ms').name('P95 Frame (ms)');
    performanceFolder.add(this._config.performance, 'adaptiveResolution').name('Adaptive Scale');
    performanceFolder.add(this._config.performance, 'renderResolution').name('Render Res');
    performanceFolder.add(this._config.performance, 'pressure').name('Pressure');
    performanceFolder.add(this._config.performance, 'worldPressure').name('World Load');

    const budgetFolder = this._gui.addFolder('Frame Budget').close();
    budgetFolder.add(this._config.budget, 'frameTime').name('Frame Time');
    budgetFolder.add(this._config.budget, 'drawCalls').name('Draw Calls');
    budgetFolder.add(this._config.budget, 'triangles').name('Triangles');
    budgetFolder.add(this._config.budget, 'visibility').name('Visibility');
    budgetFolder.add(this._config.budget, 'sceneUI').name('Scene UI');
    budgetFolder.add(this._config.budget, 'postFx').name('Post FX');

    // WebGL stats panel
    const webglFolder = this._gui.addFolder('WebGL');
    webglFolder.add(this._config.webgl, 'drawCalls').name('Draw calls');
    webglFolder.add(this._config.webgl, 'geometries').name('Geometries');
    webglFolder.add(this._config.webgl, 'textures').name('Textures');
    webglFolder.add(this._config.webgl, 'triangles').name('Triangles');
    webglFolder.add(this._config.webgl, 'programs').name('Programs');

    // Entity stats panel
    const entityFolder = this._gui.addFolder('Entity');
    entityFolder.add(this._config.entity, 'count').name('Count');
    entityFolder.add(this._config.entity, 'staticEnvironmentCount').name('Static Environment');
    entityFolder.add(this._config.entity, 'inViewDistanceCount').name('In View Distance');
    entityFolder.add(this._config.entity, 'frustumCulledCount').name('Frustum Culled');
    entityFolder.add(this._config.entity, 'updateSkipCount').name('Update Skip');
    entityFolder.add(this._config.entity, 'animationPlayCount').name('Animation Update');
    entityFolder.add(this._config.entity, 'localMatrixUpdateCount').name('L Matrix Update');
    entityFolder.add(this._config.entity, 'worldMatrixUpdateCount').name('W Matrix Update');
    entityFolder.add(this._config.entity, 'lightLevelUpdateCount').name('L Level Update');
    entityFolder.add(this._config.entity, 'customTextureCount').name('Custom textures');

    const predictionFolder = this._gui.addFolder('Prediction').close();
    predictionFolder.add(this._config.prediction, 'entityId').name('Entity ID');
    predictionFolder.add(this._config.prediction, 'supportsInputAcknowledgements').name('Ack Support');
    predictionFolder.add(this._config.prediction, 'bufferedCommandCount').name('Buffered Commands');
    predictionFolder.add(this._config.prediction, 'lastAcknowledgedInputSequenceNumber').name('Last Acked SQ');
    predictionFolder.add(this._config.prediction, 'lastReplayCommandCount').name('Last Replay Cmds');
    predictionFolder.add(this._config.prediction, 'lastReplaySubstepCount').name('Last Replay Steps');
    predictionFolder.add(this._config.prediction, 'peakReplayCommandCount').name('Peak Replay Cmds');
    predictionFolder.add(this._config.prediction, 'peakReplaySubstepCount').name('Peak Replay Steps');
    predictionFolder.add(this._config.prediction, 'horizontalError').name('Horizontal Error');
    predictionFolder.add(this._config.prediction, 'verticalError').name('Vertical Error');
    predictionFolder.add(this._config.prediction, 'rotationErrorDeg').name('Rotation Error');

    // Chunk stats panel
    const chunkFolder = this._gui.addFolder('Chunks');
    chunkFolder.add(this._config.chunk, 'count').name('Count');
    chunkFolder.add(this._config.chunk, 'visibleCount').name('Visibles');
    chunkFolder.add(this._config.chunk, 'blockCount').name('Blocks');
    chunkFolder.add(this._config.chunk, 'opaqueFaceCount').name('Opaque Faces');
    chunkFolder.add(this._config.chunk, 'transparentFaceCount').name('Transparent Faces');
    chunkFolder.add(this._config.chunk, 'liquidFaceCount').name('Liquid Faces');
    chunkFolder.add(this._config.chunk, 'blockTextureCount').name('Textures');

    // glTF stats panel
    const gltfFolder = this._gui.addFolder('glTF');
    gltfFolder.add(this._config.gltf, 'fileCount').name('Files');
    gltfFolder.add(this._config.gltf, 'sourceMeshCount').name('Source Meshes');
    gltfFolder.add(this._config.gltf, 'clonedMeshCount').name('Cloned Meshes');
    gltfFolder.add(this._config.gltf, 'instancedMeshCount').name('Instanced Meshes');
    gltfFolder.add(this._config.gltf, 'drawCallsSaved').name('Draw Calls Saved');
    gltfFolder.add(this._config.gltf, 'attributeElementsUpdated').name('Attr El Update');
    gltfFolder.add(this._config.gltf, 'attributeUploadsSkipped').name('Attr Uploads Skip');

    // Scene UI Stats panel
    const sceneUIFolder = this._gui.addFolder('Scene UI');
    sceneUIFolder.add(this._config.sceneUI, 'count').name('Count');
    sceneUIFolder.add(this._config.sceneUI, 'visibleCount').name('Visibles');

    // Arrow Stats panel
    const arrowFolder = this._gui.addFolder('Arrows');
    arrowFolder.add(this._config.arrow, 'count').name('Count');
    arrowFolder.add(this._config.arrow, 'visibleCount').name('Visibles');

    // Audio Stats panel
    const audioFolder = this._gui.addFolder('Audio');
    audioFolder.add(this._config.audio, 'count').name('Count');
    audioFolder.add(this._config.audio, 'matrixUpdateCount').name('Matrix Updates');
    audioFolder.add(this._config.audio, 'matrixUpdateSkipCount').name('Skip Matrix Updates');

    // Performance/memory stats panels
    this._stats.addPanel(this._memoryStatsPanel);
    this._stats.addPanel(this._rttStatsPanel);

    // Set high z-index to ensure debug panels appear above all other UI elements
    this._stats.dom.style.zIndex = DEBUG_PANEL_Z_INDEX;
    this._gui.domElement.style.zIndex = DEBUG_PANEL_Z_INDEX;
  }

  public setVisibility(visible: boolean): void {
    this._visible = visible;

    if (this._visible) {
      this._gui.show();
      document.body.appendChild(this._stats.dom);
    } else {
      this._gui.hide();
      this._stats.dom.parentElement?.removeChild(this._stats.dom);
    }

    (this._gui.children as GUI[]).forEach(gui => {
      gui.controllers.forEach(controller => {
        controller.listen(this._visible);
      });
    });
  }

  public update(): void {
    if (!this._visible) {
      return;
    }

    this._updatePlayerInfo();
    this._updateCameraInfo();
    this._updateServerInfo();
    const perfSnapshot = this._game.performanceBaselineManager.snapshotDetailed();
    this._updatePerformanceStats(perfSnapshot);
    this._updateFrameBudget(perfSnapshot);
    this._updateMemoryStats();
    this._updateRttStats();
    this._updateEntityStats();
    this._updatePredictionStats();
    this._updateChunkStats();
    this._updateGltfStats();
    this._updateSceneUIStats();
    this._updateArrowStats();
    this._updateAudioStats();
    this._updateWebGLStats();

    this._stats.update();
  }

  private _updatePlayerInfo(): void {
    if (this._game.camera.gameCameraAttachedEntity) {
      this._game.camera.gameCameraAttachedEntity.getWorldPosition(vec3);
      this._config.player.position = `${vec3.x.toFixed(2)}, ${vec3.y.toFixed(2)}, ${vec3.z.toFixed(2)}`;
    } else {
      this._config.player.position = `-, -, -`;
    }
  }

  private _updateCameraInfo(): void {
    const pos = this._game.camera.activeCamera.position;
    this._config.camera.position = `${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)}`;
  }

  private _updateServerInfo(): void {
    this._config.server.sendProtocol = this._game.networkManager.lastSendProtocol;
    this._config.server.receiveProtocol = this._game.networkManager.lastReceiveProtocol;
    this._config.server.version = this._game.networkManager.serverVersion ?? 'unknown';
  }

  private _updatePerformanceStats(snapshot: DetailedPerformanceBaselineSnapshot): void {
    const renderer = this._game.renderer;
    const targetFps = this._resolveTargetFps();
    const frameBudgetMs = 1000 / targetFps;

    this._config.performance.fps = snapshot.frame.currentFps;
    this._config.performance.targetFps = targetFps;
    this._config.performance.frameBudgetMs = Number(frameBudgetMs.toFixed(2));
    this._config.performance.frameP95Ms = Number(snapshot.frame.timings.p95.toFixed(2));
    this._config.performance.adaptiveResolution = Number(renderer.adaptiveResolutionScale.toFixed(2));
    this._config.performance.renderResolution = `${snapshot.renderer.canvasWidth}x${snapshot.renderer.canvasHeight} @ ${snapshot.renderer.pixelRatio.toFixed(2)}x`;
    this._config.performance.pressure = this._resolvePressureSummary(snapshot, frameBudgetMs);
    this._config.performance.worldPressure = this._resolveWorldPressureSummary(snapshot);
  }

  private _updateFrameBudget(snapshot: DetailedPerformanceBaselineSnapshot): void {
    const budgets = this._resolveFrameBudgets();
    const frameBudgetMs = 1000 / this._resolveTargetFps();
    const postFx = this._game.renderer.postProcessingDebugState;
    const postFxCount = Number(postFx.bloom) + Number(postFx.depthBlur) + Number(postFx.outline) + Number(postFx.smaa);

    this._config.budget.frameTime = this._formatBudgetStatus(snapshot.frame.timings.p95, frameBudgetMs, 'ms');
    this._config.budget.drawCalls = this._formatBudgetStatus(snapshot.renderer.calls, budgets.drawCalls);
    this._config.budget.triangles = this._formatBudgetStatus(snapshot.renderer.triangles, budgets.triangles);
    this._config.budget.visibility = this._formatBudgetStatus(
      Math.max(snapshot.chunks.visibleCount, snapshot.chunkVisibility.visibleBatchCount),
      budgets.visibleChunks,
    );
    this._config.budget.sceneUI = this._formatBudgetStatus(snapshot.sceneUI.visibleCount, budgets.sceneUI);
    this._config.budget.postFx = `${postFxCount}/4 ${this._formatBudgetLabel(postFxCount <= 2 ? 'ok' : postFxCount === 3 ? 'tight' : 'over')}`;
  }

  private _updateMemoryStats(): void {
    const usedHeapSize = this._game.performanceMetricsManager.usedMemory / 1048576; // Convert to MB
    const totalHeapSize = this._game.performanceMetricsManager.totalMemory / 1048576; // Convert to MB
    this._memoryStatsPanel.update(usedHeapSize, totalHeapSize);
  }
  
  private _updateRttStats(): void {
    const networkManager = this._game.networkManager;
    
    if (!networkManager) {
      return;
    }

    this._rttStatsPanel.update(networkManager.roundTripTimeS * 1000, networkManager.roundTripTimeMaxS * 1000);
  }

  private _updateEntityStats(): void {
    this._config.entity.count = EntityStats.count;
    this._config.entity.staticEnvironmentCount = EntityStats.staticEnvironmentCount;
    this._config.entity.inViewDistanceCount = EntityStats.inViewDistanceCount;
    this._config.entity.frustumCulledCount = EntityStats.frustumCulledCount;
    this._config.entity.updateSkipCount = EntityStats.updateSkipCount;
    this._config.entity.animationPlayCount = EntityStats.animationPlayCount;
    this._config.entity.localMatrixUpdateCount = EntityStats.localMatrixUpdateCount;
    this._config.entity.worldMatrixUpdateCount = EntityStats.worldMatrixUpdateCount;
    this._config.entity.lightLevelUpdateCount = EntityStats.lightLevelUpdateCount;
    this._config.entity.customTextureCount = EntityStats.customTextureCount;
  }

  private _updatePredictionStats(): void {
    this._config.prediction.entityId = LocalPredictionStats.entityId;
    this._config.prediction.supportsInputAcknowledgements = LocalPredictionStats.supportsInputAcknowledgements;
    this._config.prediction.bufferedCommandCount = LocalPredictionStats.bufferedCommandCount;
    this._config.prediction.lastAcknowledgedInputSequenceNumber = LocalPredictionStats.lastAcknowledgedInputSequenceNumber;
    this._config.prediction.lastReplayCommandCount = LocalPredictionStats.lastReplayCommandCount;
    this._config.prediction.lastReplaySubstepCount = LocalPredictionStats.lastReplaySubstepCount;
    this._config.prediction.peakReplayCommandCount = LocalPredictionStats.peakReplayCommandCount;
    this._config.prediction.peakReplaySubstepCount = LocalPredictionStats.peakReplaySubstepCount;
    this._config.prediction.horizontalError = Number(LocalPredictionStats.horizontalError.toFixed(3));
    this._config.prediction.verticalError = Number(LocalPredictionStats.verticalError.toFixed(3));
    this._config.prediction.rotationErrorDeg = Number(LocalPredictionStats.rotationErrorDeg.toFixed(2));
  }

  private _updateChunkStats(): void {
    this._config.chunk.count = ChunkStats.count;
    this._config.chunk.visibleCount = ChunkStats.visibleCount;
    this._config.chunk.blockCount = ChunkStats.blockCount;
    this._config.chunk.opaqueFaceCount = ChunkStats.opaqueFaceCount;
    this._config.chunk.transparentFaceCount = ChunkStats.transparentFaceCount;
    this._config.chunk.liquidFaceCount = ChunkStats.liquidFaceCount;
    this._config.chunk.blockTextureCount = ChunkStats.blockTextureCount;
  }

  private _updateGltfStats(): void {
    this._config.gltf.fileCount = GLTFStats.fileCount;
    this._config.gltf.sourceMeshCount = GLTFStats.sourceMeshCount;
    this._config.gltf.clonedMeshCount = GLTFStats.clonedMeshCount;
    this._config.gltf.instancedMeshCount = GLTFStats.instancedMeshCount;
    this._config.gltf.drawCallsSaved = GLTFStats.drawCallsSaved;
    this._config.gltf.attributeElementsUpdated = GLTFStats.attributeElementsUpdated;
    this._config.gltf.attributeUploadsSkipped = GLTFStats.attributeUploadsSkipped;
  }

  private _updateSceneUIStats(): void {
    this._config.sceneUI.count = SceneUIStats.count;
    this._config.sceneUI.visibleCount = SceneUIStats.visibleCount;
  }

  private _updateArrowStats(): void {
    this._config.arrow.count = ArrowStats.count;
    this._config.arrow.visibleCount = ArrowStats.visibleCount;
  }

  private _updateAudioStats(): void {
    this._config.audio.count = AudioStats.count;
    this._config.audio.matrixUpdateCount = AudioStats.matrixUpdateCount;
    this._config.audio.matrixUpdateSkipCount = AudioStats.matrixUpdateSkipCount;
  }

  private _updateWebGLStats(): void {
    const info = this._game.renderer.webGLRenderer.info;
    this._config.webgl.drawCalls = info.render.calls;
    this._config.webgl.geometries = info.memory.geometries;
    this._config.webgl.programs = info.programs?.length || 0;
    this._config.webgl.triangles = info.render.triangles;
    this._config.webgl.textures = info.memory.textures;
  }

  private _resolveTargetFps(): number {
    return this._game.settingsManager.qualityPerfTradeoff.fpsCap
      ?? this._game.performanceMetricsManager.refreshRate
      ?? 60;
  }

  private _resolveFrameBudgets(): FrameBudgetThresholds {
    return FRAME_BUDGETS_BY_PRESET[this._game.settingsManager.qualityPresetLevel] ?? DEFAULT_FRAME_BUDGETS;
  }

  private _resolvePressureSummary(snapshot: DetailedPerformanceBaselineSnapshot, frameBudgetMs: number): string {
    const frameP95Ms = snapshot.frame.timings.p95;
    const renderer = this._game.renderer;

    if (frameP95Ms <= frameBudgetMs * 0.9 && renderer.adaptiveResolutionScale >= 0.98) {
      return 'healthy';
    }

    if (renderer.adaptiveResolutionScale < 0.9 || snapshot.renderer.triangles > this._resolveFrameBudgets().triangles) {
      return 'gpu-bound';
    }

    if (snapshot.chunkVisibility.pendingFullRefresh || snapshot.chunkWorker.currentBacklog > 0) {
      return 'streaming';
    }

    if (snapshot.renderer.calls > this._resolveFrameBudgets().drawCalls || snapshot.sceneUI.visibleCount > this._resolveFrameBudgets().sceneUI) {
      return 'scene-heavy';
    }

    return 'tight';
  }

  private _resolveWorldPressureSummary(snapshot: DetailedPerformanceBaselineSnapshot): string {
    const budgets = this._resolveFrameBudgets();
    const visibleCount = Math.max(snapshot.chunks.visibleCount, snapshot.chunkVisibility.visibleBatchCount);

    if (snapshot.chunkWorker.currentBacklog > 0) {
      return `chunk backlog ${snapshot.chunkWorker.currentBacklog}`;
    }

    if (visibleCount > budgets.visibleChunks) {
      return `visibility ${visibleCount}/${budgets.visibleChunks}`;
    }

    if (snapshot.chunks.transparentFaceCount > budgets.transparentFaces) {
      return `alpha ${snapshot.chunks.transparentFaceCount}/${budgets.transparentFaces}`;
    }

    return `steady ${visibleCount}/${budgets.visibleChunks}`;
  }

  private _formatBudgetStatus(current: number, budget: number, suffix: string = ''): string {
    const currentLabel = suffix ? `${current.toFixed(1)}${suffix}` : `${Math.round(current)}`;
    const budgetLabel = suffix ? `${budget.toFixed(1)}${suffix}` : `${Math.round(budget)}`;
    const ratio = budget > 0 ? current / budget : 0;
    const status = ratio > 1 ? 'over' : ratio > 0.85 ? 'tight' : 'ok';

    return `${currentLabel}/${budgetLabel} ${this._formatBudgetLabel(status)}`;
  }

  private _formatBudgetLabel(status: 'ok' | 'tight' | 'over'): string {
    if (status === 'ok') {
      return 'OK';
    }

    if (status === 'tight') {
      return 'TIGHT';
    }

    return 'OVER';
  }
}
