import Game from '../Game';
import { Vector3 } from 'three';
import Stats from 'three/examples/jsm/libs/stats.module.js';
import { GUI } from 'three/examples/jsm/libs/lil-gui.module.min.js';
import ArrowStats from '../arrows/ArrowStats';
import AudioStats from '../audio/AudioStats';
import ChunkStats from '../chunks/ChunkStats';
import EntityStats from '../entities/EntityStats';
import GLTFStats from '../gltf/GLTFStats';
import SceneUIStats from '../ui/SceneUIStats';

const DEBUG_PANEL_Z_INDEX = '100000';

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
    this._updateMemoryStats();
    this._updateRttStats();
    this._updateEntityStats();
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
}