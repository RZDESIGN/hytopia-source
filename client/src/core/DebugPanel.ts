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
  renderTuning: {
    gtaoMaxDistance: number;
    gtaoStrength: number;
    gtaoWorldRadius: number;
    localReflectionMaxSkyExposure: number;
    localReflectionPositionDelta: number;
    localReflectionUpdateIntervalS: number;
    lutIntensity: number;
    temporalHistoryWeight: number;
    temporalSharpenStrength: number;
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
    lastReconcileMode: string;
    softReconcileCount: number;
    snapReconcileCount: number;
    forcedActiveReconcileCount: number;
    deferredActiveReconcileCount: number;
    motionBasisHorizontalSpeed: number;
    motionBasisVertical: number;
    authoritativeGrounded: boolean;
    predictedGrounded: boolean;
    groundedMismatch: boolean;
    authoritativeGroundedTransitionCount: number;
    predictedGroundedTransitionCount: number;
    authoritativeGroundFootOffset: number;
    predictedGroundFootOffset: number;
    traceEntryCount: number;
    latestTraceLine: string;
    exportStatus: string;
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
  private _predictionActions = {
    clearTrace: (): void => {
      LocalPredictionStats.clearTrace();
      this._config.prediction.exportStatus = 'trace cleared';
      this._updatePredictionStats();
    },
    copyTrace: (): void => {
      void this._copyPredictionTraceToClipboard();
    },
    downloadTrace: (): void => {
      this._downloadPredictionTrace();
    },
  };
  private _renderTuningActions = {
    reset: (): void => {
      this._game.renderer.resetRuntimeTuning();
      this._updateRenderTuning();
    },
  };
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
    renderTuning: {
      gtaoMaxDistance: 0,
      gtaoStrength: 0,
      gtaoWorldRadius: 0,
      localReflectionMaxSkyExposure: 0,
      localReflectionPositionDelta: 0,
      localReflectionUpdateIntervalS: 0,
      lutIntensity: 0,
      temporalHistoryWeight: 0,
      temporalSharpenStrength: 0,
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
      lastReconcileMode: 'none',
      softReconcileCount: 0,
      snapReconcileCount: 0,
      forcedActiveReconcileCount: 0,
      deferredActiveReconcileCount: 0,
      motionBasisHorizontalSpeed: 0,
      motionBasisVertical: 0,
      authoritativeGrounded: false,
      predictedGrounded: false,
      groundedMismatch: false,
      authoritativeGroundedTransitionCount: 0,
      predictedGroundedTransitionCount: 0,
      authoritativeGroundFootOffset: 0,
      predictedGroundFootOffset: 0,
      traceEntryCount: 0,
      latestTraceLine: '-',
      exportStatus: '-',
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

    const renderTuningFolder = this._gui.addFolder('Render Tuning').close();
    renderTuningFolder.add(this._config.renderTuning, 'temporalHistoryWeight', 0.5, 0.98, 0.005)
      .name('TAA History')
      .onChange((value: number) => this._game.renderer.setRuntimeTuning({ temporalHistoryWeight: value }));
    renderTuningFolder.add(this._config.renderTuning, 'temporalSharpenStrength', 0, 0.35, 0.005)
      .name('TAA Sharpen')
      .onChange((value: number) => this._game.renderer.setRuntimeTuning({ temporalSharpenStrength: value }));
    renderTuningFolder.add(this._config.renderTuning, 'lutIntensity', 0, 1.5, 0.01)
      .name('LUT Intensity')
      .onChange((value: number) => this._game.renderer.setRuntimeTuning({ lutIntensity: value }));
    renderTuningFolder.add(this._config.renderTuning, 'gtaoStrength', 0, 1, 0.01)
      .name('GTAO Strength')
      .onChange((value: number) => this._game.renderer.setRuntimeTuning({ gtaoStrength: value }));
    renderTuningFolder.add(this._config.renderTuning, 'gtaoWorldRadius', 0.5, 12, 0.1)
      .name('GTAO Radius')
      .onChange((value: number) => this._game.renderer.setRuntimeTuning({ gtaoWorldRadius: value }));
    renderTuningFolder.add(this._config.renderTuning, 'gtaoMaxDistance', 4, 160, 1)
      .name('GTAO Distance')
      .onChange((value: number) => this._game.renderer.setRuntimeTuning({ gtaoMaxDistance: value }));
    renderTuningFolder.add(this._config.renderTuning, 'localReflectionMaxSkyExposure', 0, 1, 0.01)
      .name('Probe Sky Cutoff')
      .onChange((value: number) => this._game.renderer.setRuntimeTuning({ localReflectionMaxSkyExposure: value }));
    renderTuningFolder.add(this._config.renderTuning, 'localReflectionPositionDelta', 0.25, 12, 0.05)
      .name('Probe Move Delta')
      .onChange((value: number) => this._game.renderer.setRuntimeTuning({ localReflectionPositionDelta: value }));
    renderTuningFolder.add(this._config.renderTuning, 'localReflectionUpdateIntervalS', 0.1, 12, 0.1)
      .name('Probe Interval')
      .onChange((value: number) => this._game.renderer.setRuntimeTuning({ localReflectionUpdateIntervalS: value }));
    renderTuningFolder.add(this._renderTuningActions, 'reset').name('Reset Overrides');

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
    predictionFolder.add(this._config.prediction, 'lastReconcileMode').name('Reconcile Mode');
    predictionFolder.add(this._config.prediction, 'softReconcileCount').name('Soft Reconciles');
    predictionFolder.add(this._config.prediction, 'snapReconcileCount').name('Snap Reconciles');
    predictionFolder.add(this._config.prediction, 'forcedActiveReconcileCount').name('Forced Active Rec');
    predictionFolder.add(this._config.prediction, 'deferredActiveReconcileCount').name('Deferred Active Rec');
    predictionFolder.add(this._config.prediction, 'motionBasisHorizontalSpeed').name('Motion Basis H');
    predictionFolder.add(this._config.prediction, 'motionBasisVertical').name('Motion Basis Y');
    predictionFolder.add(this._config.prediction, 'authoritativeGrounded').name('Auth Grounded');
    predictionFolder.add(this._config.prediction, 'predictedGrounded').name('Pred Grounded');
    predictionFolder.add(this._config.prediction, 'groundedMismatch').name('Grounded Mismatch');
    predictionFolder.add(this._config.prediction, 'authoritativeGroundedTransitionCount').name('Auth Ground Trans');
    predictionFolder.add(this._config.prediction, 'predictedGroundedTransitionCount').name('Pred Ground Trans');
    predictionFolder.add(this._config.prediction, 'authoritativeGroundFootOffset').name('Auth Foot Offset');
    predictionFolder.add(this._config.prediction, 'predictedGroundFootOffset').name('Pred Foot Offset');
    predictionFolder.add(this._config.prediction, 'traceEntryCount').name('Trace Entries');
    predictionFolder.add(this._config.prediction, 'latestTraceLine').name('Last Trace');
    predictionFolder.add(this._config.prediction, 'exportStatus').name('Export Status');
    predictionFolder.add(this._predictionActions, 'copyTrace').name('Copy Trace');
    predictionFolder.add(this._predictionActions, 'downloadTrace').name('Download Trace');
    predictionFolder.add(this._predictionActions, 'clearTrace').name('Clear Trace');

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
    this._updateRenderTuning();
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
    const postFxCount = Number(postFx.atmosphere)
      + Number(postFx.bloom)
      + Number(postFx.gtao)
      + Number(postFx.lut)
      + Number(postFx.nearContactShadows)
      + Number(postFx.outline)
      + Number(postFx.smaa)
      + Number(postFx.temporalResolve);

    this._config.budget.frameTime = this._formatBudgetStatus(snapshot.frame.timings.p95, frameBudgetMs, 'ms');
    this._config.budget.drawCalls = this._formatBudgetStatus(snapshot.renderer.calls, budgets.drawCalls);
    this._config.budget.triangles = this._formatBudgetStatus(snapshot.renderer.triangles, budgets.triangles);
    this._config.budget.visibility = this._formatBudgetStatus(
      Math.max(snapshot.chunks.visibleCount, snapshot.chunkVisibility.visibleBatchCount),
      budgets.visibleChunks,
    );
    this._config.budget.sceneUI = this._formatBudgetStatus(snapshot.sceneUI.visibleCount, budgets.sceneUI);
    this._config.budget.postFx = `${postFxCount}/8 ${this._formatBudgetLabel(postFxCount <= 4 ? 'ok' : postFxCount <= 6 ? 'tight' : 'over')}`;
  }

  private _updateRenderTuning(): void {
    const tuning = this._game.renderer.runtimeTuningState;
    this._config.renderTuning.temporalHistoryWeight = Number(tuning.temporalHistoryWeight.toFixed(3));
    this._config.renderTuning.temporalSharpenStrength = Number(tuning.temporalSharpenStrength.toFixed(3));
    this._config.renderTuning.lutIntensity = Number(tuning.lutIntensity.toFixed(3));
    this._config.renderTuning.gtaoStrength = Number(tuning.gtaoStrength.toFixed(3));
    this._config.renderTuning.gtaoWorldRadius = Number(tuning.gtaoWorldRadius.toFixed(2));
    this._config.renderTuning.gtaoMaxDistance = Number(tuning.gtaoMaxDistance.toFixed(1));
    this._config.renderTuning.localReflectionMaxSkyExposure = Number(tuning.localReflectionMaxSkyExposure.toFixed(3));
    this._config.renderTuning.localReflectionPositionDelta = Number(tuning.localReflectionPositionDelta.toFixed(2));
    this._config.renderTuning.localReflectionUpdateIntervalS = Number(tuning.localReflectionUpdateIntervalS.toFixed(2));
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
    this._config.prediction.lastReconcileMode = LocalPredictionStats.lastReconcileMode;
    this._config.prediction.softReconcileCount = LocalPredictionStats.softReconcileCount;
    this._config.prediction.snapReconcileCount = LocalPredictionStats.snapReconcileCount;
    this._config.prediction.forcedActiveReconcileCount = LocalPredictionStats.forcedActiveReconcileCount;
    this._config.prediction.deferredActiveReconcileCount = LocalPredictionStats.deferredActiveReconcileCount;
    this._config.prediction.motionBasisHorizontalSpeed = Number(LocalPredictionStats.motionBasisHorizontalSpeed.toFixed(3));
    this._config.prediction.motionBasisVertical = Number(LocalPredictionStats.motionBasisVertical.toFixed(3));
    this._config.prediction.authoritativeGrounded = LocalPredictionStats.authoritativeGrounded;
    this._config.prediction.predictedGrounded = LocalPredictionStats.predictedGrounded;
    this._config.prediction.groundedMismatch = LocalPredictionStats.groundedMismatch;
    this._config.prediction.authoritativeGroundedTransitionCount = LocalPredictionStats.authoritativeGroundedTransitionCount;
    this._config.prediction.predictedGroundedTransitionCount = LocalPredictionStats.predictedGroundedTransitionCount;
    this._config.prediction.authoritativeGroundFootOffset = Number(LocalPredictionStats.authoritativeGroundFootOffset.toFixed(3));
    this._config.prediction.predictedGroundFootOffset = Number(LocalPredictionStats.predictedGroundFootOffset.toFixed(3));
    this._config.prediction.traceEntryCount = LocalPredictionStats.traceEntryCount;
    this._config.prediction.latestTraceLine = LocalPredictionStats.latestTraceLine;
  }

  private _buildPredictionTraceReport(): string {
    this._updatePlayerInfo();
    this._updateCameraInfo();
    this._updateServerInfo();
    this._updatePredictionStats();

    const nowIso = new Date().toISOString();
    const playerPosition = this._config.player.position;
    const cameraPosition = this._config.camera.position;
    const traceBody = LocalPredictionStats.dumpTrace();

    const summaryLines = [
      '# HYTOPIA Local Prediction Trace',
      `captured_at=${nowIso}`,
      `server_version=${this._config.server.version}`,
      `send_protocol=${this._config.server.sendProtocol}`,
      `receive_protocol=${this._config.server.receiveProtocol}`,
      `fps=${this._config.performance.fps}`,
      `target_fps=${this._config.performance.targetFps}`,
      `frame_p95_ms=${this._config.performance.frameP95Ms}`,
      `rtt_ms=${(this._game.networkManager.roundTripTimeS * 1000).toFixed(2)}`,
      `player_position=${playerPosition}`,
      `camera_position=${cameraPosition}`,
      `prediction_entity_id=${this._config.prediction.entityId}`,
      `ack_support=${this._config.prediction.supportsInputAcknowledgements ? 1 : 0}`,
      `buffered_commands=${this._config.prediction.bufferedCommandCount}`,
      `last_acked_sq=${this._config.prediction.lastAcknowledgedInputSequenceNumber}`,
      `last_replay=${this._config.prediction.lastReplayCommandCount}/${this._config.prediction.lastReplaySubstepCount}`,
      `peak_replay=${this._config.prediction.peakReplayCommandCount}/${this._config.prediction.peakReplaySubstepCount}`,
      `error=${this._config.prediction.horizontalError.toFixed(3)},${this._config.prediction.verticalError.toFixed(3)},${this._config.prediction.rotationErrorDeg.toFixed(2)}`,
      `reconcile=${this._config.prediction.lastReconcileMode}`,
      `soft_reconciles=${this._config.prediction.softReconcileCount}`,
      `snap_reconciles=${this._config.prediction.snapReconcileCount}`,
      `forced_active_reconciles=${this._config.prediction.forcedActiveReconcileCount}`,
      `deferred_active_reconciles=${this._config.prediction.deferredActiveReconcileCount}`,
      `motion_basis=${this._config.prediction.motionBasisHorizontalSpeed.toFixed(3)},${this._config.prediction.motionBasisVertical.toFixed(3)}`,
      `grounded=${this._config.prediction.authoritativeGrounded ? 1 : 0}/${this._config.prediction.predictedGrounded ? 1 : 0}/${this._config.prediction.groundedMismatch ? 1 : 0}`,
      `ground_transitions=${this._config.prediction.authoritativeGroundedTransitionCount}/${this._config.prediction.predictedGroundedTransitionCount}`,
      `foot_offset=${this._config.prediction.authoritativeGroundFootOffset.toFixed(3)}/${this._config.prediction.predictedGroundFootOffset.toFixed(3)}`,
      `trace_entries=${this._config.prediction.traceEntryCount}`,
      '',
      '# Trace',
    ];

    return `${summaryLines.join('\n')}\n${traceBody || '(no trace entries recorded)'}`;
  }

  private async _copyPredictionTraceToClipboard(): Promise<void> {
    const report = this._buildPredictionTraceReport();

    try {
      await navigator.clipboard.writeText(report);
      this._config.prediction.exportStatus = `copied ${LocalPredictionStats.traceEntryCount} lines`;
    } catch {
      this._config.prediction.exportStatus = 'clipboard copy failed';
    }
  }

  private _downloadPredictionTrace(): void {
    const report = this._buildPredictionTraceReport();
    const blob = new Blob([report], { type: 'text/plain;charset=utf-8' });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    anchor.href = objectUrl;
    anchor.download = `hytopia-local-prediction-trace-${timestamp}.txt`;
    anchor.click();
    URL.revokeObjectURL(objectUrl);
    this._config.prediction.exportStatus = `downloaded ${LocalPredictionStats.traceEntryCount} lines`;
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
