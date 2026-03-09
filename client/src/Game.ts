import ArrowManager from './arrows/ArrowManager';
import AudioManager from './audio/AudioManager';
import BlockMaterialManager from './blocks/BlockMaterialManager';
import BlockTextureAtlasManager from './blocks/BlockTextureAtlasManager';
import BlockTypeManager from './blocks/BlockTypeManager';
import Camera from './core/Camera';
import ChunkManager from './chunks/ChunkManager';
import ChunkMeshManager from './chunks/ChunkMeshManager';
import LightLevelManager from './chunks/LightLevelManager';
import SkyDistanceVolumeManager from './chunks/SkyDistanceVolumeManager';
import CustomTextureManager from './textures/CustomTextureManager';
import EntityManager from './entities/EntityManager';
import GLTFManager from './gltf/GLTFManager';
import InputManager from './input/InputManager';
import LightManager from './lights/LightManager';
import MobileManager from './mobile/MobileManager';
import NetworkManager from './network/NetworkManager';
import ParticlesManager from './particles/ParticlesManager';
import PerformanceBaselineManager from './core/PerformanceBaselineManager';
import PerformanceMetricsManager from './core/PerformanceMetricsManager';
import PlayerManager from './players/PlayerManager';
import Renderer from './core/Renderer';
import SettingsManager from './settings/SettingsManager';
import UIManager from './ui/UIManager';
import ChunkWorkerClient from './workers/ChunkWorkerClient';
import type DebugRenderer from './core/DebugRenderer';
import type BridgeManager from './bridge/BridgeManager';

const DEBUG_QUERY_STRINGS = 'debug';

export default class Game {
  private static _instance: Game | undefined;
  readonly inDebugMode = new URLSearchParams(window.location.search).has(DEBUG_QUERY_STRINGS);

  private _arrowManager: ArrowManager;
  private _audioManager: AudioManager;
  private _blockMaterialManager: BlockMaterialManager;
  private _blockTextureAtlasManager: BlockTextureAtlasManager;
  private _blockTypeManager: BlockTypeManager;
  private _bridgeManager: Pick<BridgeManager, 'sendGameReady' | 'sendReconnect'> = {
    sendGameReady: () => {},
    sendReconnect: () => {},
  };
  private _camera: Camera;
  private _chunkManager: ChunkManager;
  private _chunkMeshManager: ChunkMeshManager;
  private _chunkWorkerClient: ChunkWorkerClient;
  private _customTextureManager: CustomTextureManager;
  private _debugRenderer: DebugRenderer | null = null;
  private _entityManager: EntityManager;
  private _gltfManager: GLTFManager;
  private _inputManager: InputManager;
  private _lightLevelManager: LightLevelManager;
  private _lightManager: LightManager;
  private _mobileManager: MobileManager;
  private _networkManager: NetworkManager;
  private _performanceBaselineManager: PerformanceBaselineManager;
  private _performanceMetricsManager: PerformanceMetricsManager;
  private _particlesManager: ParticlesManager;
  private _playerManager: PlayerManager;
  private _renderer: Renderer;
  private _settingsManager: SettingsManager;
  private _skyDistanceVolumeManager: SkyDistanceVolumeManager;
  private _uiManager: UIManager;

  constructor() {
    // Init network manager, settings, metrics manager, renderer, input manager, camera, and chunk worker client first...
    this._networkManager = new NetworkManager(this);
    this._settingsManager = new SettingsManager(this);
    this._performanceMetricsManager = new PerformanceMetricsManager();
    this._performanceBaselineManager = new PerformanceBaselineManager(this);
    this._inputManager = new InputManager(this);
    this._camera = new Camera(this);
    this._renderer = new Renderer(this);
    this._chunkWorkerClient = new ChunkWorkerClient();

    this._arrowManager = new ArrowManager(this);
    this._audioManager = new AudioManager(this);
    this._blockTextureAtlasManager = new BlockTextureAtlasManager(this);
    this._blockMaterialManager = new BlockMaterialManager(this);
    this._blockTypeManager = new BlockTypeManager(this);
    this._chunkManager = new ChunkManager(this);
    this._chunkMeshManager = new ChunkMeshManager(this);
    this._customTextureManager = new CustomTextureManager();
    this._entityManager = new EntityManager(this);    
    this._lightManager = new LightManager(this);
    this._gltfManager = new GLTFManager(this);
    this._lightLevelManager = new LightLevelManager();
    this._mobileManager = new MobileManager(this);
    this._particlesManager = new ParticlesManager(this);
    this._playerManager = new PlayerManager(this);
    this._skyDistanceVolumeManager = new SkyDistanceVolumeManager();
    this._uiManager = new UIManager(this);
  }

  public static get instance(): Game {
    if (!Game._instance) {
      Game._instance = new Game();
    }

    return Game._instance;
  }

  public get arrowManager(): ArrowManager { return this._arrowManager; }
  public get audioManager(): AudioManager { return this._audioManager; }
  public get blockMaterialManager(): BlockMaterialManager { return this._blockMaterialManager; }
  public get blockTextureAtlasManager(): BlockTextureAtlasManager { return this._blockTextureAtlasManager; }
  public get blockTypeManager(): BlockTypeManager { return this._blockTypeManager; }
  public get bridgeManager(): Pick<BridgeManager, 'sendGameReady' | 'sendReconnect'> { return this._bridgeManager; }
  public get camera(): Camera { return this._camera; }
  public get chunkManager(): ChunkManager { return this._chunkManager; }
  public get chunkMeshManager(): ChunkMeshManager { return this._chunkMeshManager; }
  public get chunkWorkerClient(): ChunkWorkerClient { return this._chunkWorkerClient; }
  public get customTextureManager(): CustomTextureManager { return this._customTextureManager; }
  public get debugRenderer(): DebugRenderer | null { return this._debugRenderer; }
  public get entityManager(): EntityManager { return this._entityManager; }
  public get gltfManager(): GLTFManager { return this._gltfManager; }
  public get inputManager(): InputManager { return this._inputManager; }
  public get lightLevelManager(): LightLevelManager { return this._lightLevelManager; }
  public get lightManager(): LightManager { return this._lightManager; }
  public get mobileManager(): MobileManager { return this._mobileManager; }
  public get networkManager(): NetworkManager { return this._networkManager; }
  public get particlesManager(): ParticlesManager { return this._particlesManager; }
  public get performanceBaselineManager(): PerformanceBaselineManager { return this._performanceBaselineManager; }
  public get performanceMetricsManager(): PerformanceMetricsManager { return this._performanceMetricsManager; }
  public get playerManager(): PlayerManager { return this._playerManager; }
  public get renderer(): Renderer { return this._renderer; }
  public get settingsManager(): SettingsManager { return this._settingsManager; }
  public get skyDistanceVolumeManager(): SkyDistanceVolumeManager { return this._skyDistanceVolumeManager; }
  public get uiManager(): UIManager { return this._uiManager; }

  public async start(): Promise<void> {
    let bridgeLoadPromise: Promise<void> | undefined;

    if (window.self !== window.top) {
      bridgeLoadPromise = import('./bridge/BridgeManager')
        .then(({ default: BridgeManager }) => {
          this._bridgeManager = new BridgeManager(this);
        })
        .catch((error) => {
          console.error('Game: Failed to load bridge manager.', error);
        });
    }

    if (this.inDebugMode) {
      void import('./core/DebugRenderer')
        .then(({ default: DebugRenderer }) => {
          this._debugRenderer = new DebugRenderer(this);
        })
        .catch((error) => {
          console.error('Game: Failed to load debug renderer.', error);
        });
    }

    this._renderer.start();
    await bridgeLoadPromise;
    await this._networkManager.connect();
    this._blockTextureAtlasManager.init();
  }
}
