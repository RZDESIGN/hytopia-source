import {
  AmbientLight,
  BackSide,
  BoxGeometry,
  Color,
  CubeTexture,
  DepthTexture,
  DirectionalLight,
  Fog,
  HalfFloatType,
  Intersection,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MultiplyBlending,
  Object3D,
  OrthographicCamera,
  PCFShadowMap,
  PlaneGeometry,
  PerspectiveCamera,
  Plane,
  Raycaster,
  RenderItem,
  Scene,
  ShaderLib,
  ShaderMaterial,
  SRGBColorSpace,
  UniformsUtils,
  Vector2,
  Vector3,
  Vector4,
  VSMShadowMap,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { GameplayDistanceBlurPass } from '../three/postprocessing/GameplayDistanceBlurPass';
import { WhiteCoreBloomPass } from '../three/postprocessing/WhiteCoreBloomPass';
import { SelectiveOutlinePass } from '../three/postprocessing/SelectiveOutlinePass';
import { WATER_SURFACE_Y_OFFSET } from '../blocks/BlockConstants';
import DebugPanel from './DebugPanel';
import Chunk from '../chunks/Chunk';
import Assets from '../network/Assets';
import EventRouter from '../events/EventRouter';
import Game from '../Game';
import { modalAlert } from '../ui/Modal';
import type { NetworkManagerEventPayload } from '../network/NetworkEventPayloads';
import { NetworkManagerEventType } from '../network/NetworkEvents';
import { getTransparentSortKey, lerpColor } from '../three/utils';
import { CSS2DObject, CSS2DRenderer } from '../three/CSS2DRenderer';
import type Entity from '../entities/Entity';
import { type ClientSettingsEventPayload, ClientSettingsEventType } from '../settings/SettingsManager';

const MISSING_SKYBOX_TEXTURE_PATH = '/textures/missing-skybox';
// Cap internal render target pixel count to avoid severe fullscreen slowdowns on
// high-DPI displays (e.g. Retina). Windowed mode remains sharper because viewport
// area is smaller and usually falls below this budget.
const MAX_RENDER_TARGET_PIXELS = 2560 * 1440;
const MIN_RENDER_PIXEL_RATIO = 0.5;
const MIN_ADAPTIVE_RESOLUTION_SCALE = 0.67;
const MAX_ADAPTIVE_RESOLUTION_SCALE = 1.0;
const ADAPTIVE_RESOLUTION_DOWN_STEP = 0.08;
const ADAPTIVE_RESOLUTION_UP_STEP = 0.04;
const ADAPTIVE_RESOLUTION_DOWN_THRESHOLD_RATIO = 1.08;
const ADAPTIVE_RESOLUTION_UP_THRESHOLD_RATIO = 0.92;
const ADAPTIVE_RESOLUTION_DOWN_HOLD_S = 0.2;
const ADAPTIVE_RESOLUTION_UP_HOLD_S = 1.5;
const SCENE_UI_LIGHT_LOAD_MAX = 4;
const SCENE_UI_MEDIUM_LOAD_MAX = 12;
const SCENE_UI_LIGHT_RENDER_INTERVAL_S = 1 / 60;
const SCENE_UI_MEDIUM_RENDER_INTERVAL_S = 1 / 30;
const SCENE_UI_HEAVY_RENDER_INTERVAL_S = 1 / 20;
const DIRECTIONAL_LIGHT_SHADOW_BIAS = -0.0002;
const DIRECTIONAL_LIGHT_SHADOW_NORMAL_BIAS = 0.02;
const DIRECTIONAL_LIGHT_SHADOW_HEIGHT_MULTIPLIER = 1.5;
const DIRECTIONAL_LIGHT_MIN_HEIGHT = 24;
const DIRECTIONAL_LIGHT_SHADOW_FORWARD_OFFSET_RATIO = 0.35;
const DIRECTIONAL_LIGHT_SHADOW_UPDATE_INTERVAL_S = 1 / 30;
const DIRECTIONAL_LIGHT_SHADOW_IMMEDIATE_UPDATE_DISTANCE_RATIO = 0.5;
const DIRECTIONAL_LIGHT_SHADOW_STABILIZATION_PARALLEL_THRESHOLD = 0.95;
const DIRECTIONAL_LIGHT_SHADOW_STABILIZATION_EPSILON_SQ = 0.000001;
const WATER_REFLECTION_TEXTURE_SIZE_HIGH = 512;
const WATER_REFLECTION_TEXTURE_SIZE_MEDIUM = 384;
const WATER_REFLECTION_TEXTURE_SIZE_LOW = 256;
const WATER_REFLECTION_CLIP_BIAS = 0.01;
const WATER_REFLECTION_UPDATE_INTERVAL_HIGH_S = 1 / 24;
const WATER_REFLECTION_UPDATE_INTERVAL_MEDIUM_S = 1 / 12;
const WATER_REFLECTION_UPDATE_INTERVAL_LOW_S = 1 / 8;
const WATER_REFLECTION_CAMERA_POSITION_DELTA_SQ_HIGH = 0.18 * 0.18;
const WATER_REFLECTION_CAMERA_POSITION_DELTA_SQ_MEDIUM = 0.4 * 0.4;
const WATER_REFLECTION_CAMERA_POSITION_DELTA_SQ_LOW = 0.65 * 0.65;
const WATER_REFLECTION_VIEW_DIR_DOT_THRESHOLD_HIGH = 0.9992;
const WATER_REFLECTION_VIEW_DIR_DOT_THRESHOLD_MEDIUM = 0.9984;
const WATER_REFLECTION_VIEW_DIR_DOT_THRESHOLD_LOW = 0.9972;
const WATER_REFLECTION_MAX_DISTANCE = 84;

// Working variables
const color = new Color();
const vec2 = new Vector2();
const vec3 = new Vector3();
const vec3b = new Vector3();
const vec3c = new Vector3();
const vec3d = new Vector3();
const vec3e = new Vector3();
const WORLD_UP = new Vector3(0, 1, 0);
const WORLD_RIGHT = new Vector3(1, 0, 0);
const waterReflectionRaycaster = new Raycaster();
const waterReflectionIntersections: Intersection<Object3D>[] = [];
const waterReflectionPlane = new Plane();
const waterReflectionClipPlane = new Vector4();
const waterReflectionProjectionQ = new Vector4();
const waterReflectionView = new Vector3();
const waterReflectionTarget = new Vector3();
const waterReflectionLookAtPosition = new Vector3(0, 0, -1);
const waterReflectionRotationMatrix = new Matrix4();
const waterReflectionTextureMatrixBias = new Matrix4().set(
  0.5, 0.0, 0.0, 0.5,
  0.0, 0.5, 0.0, 0.5,
  0.0, 0.0, 0.5, 0.5,
  0.0, 0.0, 0.0, 1.0,
);

// Simple data container for ambient light (replaces Three.js AmbientLight which has no effect on MeshBasicMaterial)
export type AmbientLightData = {
  color: Color;
  intensity: number;
}

type WaterReflectionPlaneInfo = {
  centerHit: boolean;
  coverage: number;
  planeY: number;
};

type WaterReflectionQuality = {
  cameraPositionDeltaSq: number;
  textureSize: number;
  updateIntervalS: number;
  viewDirDotThreshold: number;
};

export enum RendererEventType {
  Animate = 'RENDERER.ANIMATE',
}

export namespace RendererEventPayload {
  export interface IAnimate { frameDeltaS: number; }
}

const SKYBOX_UNIFORM_COLOR = 'color';
const SKYBOX_UNIFORM_MAP = 'tCube';

class SkyboxMaterial extends ShaderMaterial {
  constructor(skyboxTexture: CubeTexture) {
    const uniforms = UniformsUtils.clone(ShaderLib.cube.uniforms);
    uniforms[SKYBOX_UNIFORM_MAP].value = skyboxTexture;
    uniforms[SKYBOX_UNIFORM_COLOR] = { value: new Color() };

    super({
      vertexShader: ShaderLib.cube.vertexShader,
      fragmentShader: ShaderLib.cube.fragmentShader
      .replace(
        `void main() {`,
        `
          uniform vec3 ${SKYBOX_UNIFORM_COLOR};
          void main() {
        `
      )
      .replace(
        `gl_FragColor = texColor;`,
        `
          gl_FragColor = texColor;
          gl_FragColor.rgb *= ${SKYBOX_UNIFORM_COLOR};
        `,
      ),
      uniforms,
      side: BackSide,
      depthWrite: false,
      fog: false,
    });
  }

  public get color(): Color {
    return this.uniforms[SKYBOX_UNIFORM_COLOR].value;
  }

  public get map(): CubeTexture {
    return this.uniforms[SKYBOX_UNIFORM_MAP].value;
  }
}

export default class Renderer {
  private _game: Game;
  private _ambientLight: AmbientLightData;
  private _renderer: WebGLRenderer;
  private _sceneUiRenderer: CSS2DRenderer;
  // Separate 3D Objects and 2D UI Objects into different scenes. Since they are handled by
  // separate renderers, they don't need to exist in the same scene. Some UI 2D Objects may
  // depend on the position of 3D Objects, but this can be handled by explicitly copying the
  // position. Separating the scenes helps prevent the scene graph from becoming too large
  // and reduces the cost of traversing the scene graph.
  private _scene: Scene;
  private _viewModelScene: Scene;
  private _overlayScene: Scene;
  private _uiScene: Scene;
  private _firstPersonViewModelEntity: Entity | undefined;
  private _fogColor: Color | null = null;
  private _fogFar = 100000;
  private _fogNear = 100000;
  private _ambientSceneLight: AmbientLight;
  private _ambientViewModelLight: AmbientLight;
  private _directionalSceneLight: DirectionalLight;
  private _directionalViewModelLight: DirectionalLight;
  private _sunDirection: Vector3 = new Vector3(0.3, -1, 0.2).normalize();
  private _targetFogColor: Color = new Color();
  private _targetFogFar: number = 100000;
  private _targetFogNear: number = 100000;
  private _targetSkyboxColor: Color = new Color(1, 1, 1);
  private _interpolatingFogColor: boolean;
  private _interpolatingSkyboxColor: boolean;
  private _underWaterEffectQuad: Mesh;
  private _skyboxIntensity: number = 1;
  private _skyboxMesh: Mesh | null = null;
  private _waterReflectionRenderTarget: WebGLRenderTarget;
  private _waterReflectionCamera: PerspectiveCamera;
  private _waterReflectionTextureMatrix: Matrix4 = new Matrix4();
  private _waterReflectionUpdateCooldownS: number = 0;
  private _waterReflectionPlaneY: number | null = null;
  private _lastWaterReflectionCameraPosition: Vector3 = new Vector3();
  private _lastWaterReflectionViewDir: Vector3 = new Vector3();
  private _pendingSkyboxTexture: Promise<CubeTexture> | null = null;
  private _debugVisible: boolean = false;
  private _debugPanel: DebugPanel;
  private _effectComposer: EffectComposer;
  private _renderPass: RenderPass;
  private _viewModelRenderPass: RenderPass;
  private _outlinePass: SelectiveOutlinePass;
  private _smaaPass: SMAAPass;
  private _bloomPass: WhiteCoreBloomPass;
  private _gameplayDistanceBlurPass: GameplayDistanceBlurPass;
  private _outputPass: OutputPass;
  private _sceneUIRenderCooldownRemainingS: number = 0;
  private _adaptiveResolutionScale: number = 1;
  private _adaptiveResolutionDownHoldS: number = 0;
  private _adaptiveResolutionUpHoldS: number = 0;
  private _smoothedFrameDeltaS: number = 1 / 60;
  private _directionalShadowUpdateCooldownS: number = 0;
  private _directionalShadowNeedsUpdate: boolean = true;
  private _directionalShadowInitialized: boolean = false;
  private _lastDirectionalShadowFocusCenter: Vector3 = new Vector3();
  private _lastDirectionalShadowSunDirection: Vector3 = new Vector3();
  private _lastAppliedPixelRatio: number = 0;
  private _lastAppliedViewportWidth: number = 0;
  private _lastAppliedViewportHeight: number = 0;

  public constructor(game: Game) {
    this._game = game;

    this._ambientLight = { color: new Color(), intensity: 1 };
    this._ambientSceneLight = new AmbientLight(0xffffff, 1);
    this._ambientViewModelLight = new AmbientLight(0xffffff, 1);
    this._directionalSceneLight = new DirectionalLight(0xffffff, 0);
    this._directionalViewModelLight = new DirectionalLight(0xffffff, 0);
    // Anti-aliasing is handled in post-processing
    this._renderer = new WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this._sceneUiRenderer = new CSS2DRenderer({ element: document.getElementById('scene-ui-container')! });
    this._scene = new Scene();
    this._viewModelScene = new Scene();
    this._overlayScene = new Scene();
    this._uiScene = new Scene();
    this._waterReflectionRenderTarget = new WebGLRenderTarget(
      WATER_REFLECTION_TEXTURE_SIZE_HIGH,
      WATER_REFLECTION_TEXTURE_SIZE_HIGH,
      { type: HalfFloatType },
    );
    this._waterReflectionCamera = new PerspectiveCamera();
    this._interpolatingFogColor = false;
    this._interpolatingSkyboxColor = false;
    this._underWaterEffectQuad = this._createUnderWaterEffectQuad();

    // Create render target with depth texture for outline occlusion testing
    // Size is set later via _resizePostProcessing()
    this._effectComposer = new EffectComposer(this._renderer, new WebGLRenderTarget(1, 1, {
      depthTexture: new DepthTexture(1, 1),
      type: HalfFloatType,
    }));
    // Preserve scene depth across post passes that read it after a color-only
    // pass. Later passes temporarily detach the shared depth attachment if they
    // sample it while writing into the alternate composer target.
    if (this._effectComposer.renderTarget2.depthTexture) {
      this._effectComposer.renderTarget2.depthTexture.dispose();
    }
    this._effectComposer.renderTarget2.depthTexture = this._effectComposer.renderTarget1.depthTexture;
    this._renderPass = new RenderPass(this._scene, this._game.camera.activeCamera);
    this._viewModelRenderPass = new RenderPass(this._viewModelScene, this._game.camera.activeCamera);
    this._viewModelRenderPass.clear = false;
    this._viewModelRenderPass.clearDepth = true;
    this._outlinePass = new SelectiveOutlinePass(
      this._game.camera.activeCamera as never,
      new Vector2(1, 1),
    );
    // Note: Size for Passes are set appropriately when EffectComposer size is set
    this._smaaPass = new SMAAPass();
    this._gameplayDistanceBlurPass = new GameplayDistanceBlurPass();
    // Question: Should parameters be configurable?
    this._bloomPass = new WhiteCoreBloomPass(
      vec2,
      0.5,  // strength
      0.4,  // radius
      this._calculateBloomThreshold(), // threshold
    );
    this._outputPass = new OutputPass();

    Assets.ktx2Loader.detectSupport(this._renderer);

    this._clampTargetFogNearAndFar();

    this._setupRenderer();
    this._setupSceneUiRenderer();
    this._setupScene();
    this._setupFog();
    this._setupPostProcessing();
    this._setupEventListeners();

    this._debugPanel = new DebugPanel(game);

    if (game.inDebugMode) {
      this._debugVisible = true;
      this._debugPanel.setVisibility(true);
    }
  }

  public get ambientLight(): AmbientLightData { return this._ambientLight; }
  public get fogColor(): Color { return this._scene.fog ? (this._scene.fog as Fog).color : this._targetFogColor; }
  public get skyColor(): Color { return this._skyboxMesh ? (this._skyboxMesh.material as SkyboxMaterial).color : this._targetSkyboxColor; }
  public get sunDirection(): Vector3 { return this._sunDirection; }
  public get sunLightColor(): Color { return this._directionalSceneLight.color; }
  public get sunLightIntensity(): number { return this._directionalSceneLight.intensity; }
  public get directionalShadowDistance(): number { return this._game.settingsManager.qualityPerfTradeoff.shadows?.directionalDistance ?? 48; }
  public get directionalShadowFocusCenter(): Vector3 { return this._lastDirectionalShadowFocusCenter; }
  public get viewDistance(): number { return Math.min(this._game.settingsManager.qualityPerfTradeoff.viewDistance.distance, this._fogFar); }
  public get webGLRenderer(): WebGLRenderer { return this._renderer; }

  private _getViewportSize(): { width: number; height: number } {
    return {
      width: Math.max(1, document.documentElement.clientWidth),
      height: Math.max(1, document.documentElement.clientHeight),
    };
  }

  private _calculateEffectivePixelRatio(): number {
    const resolutionMultiplier = this._game.settingsManager.qualityPerfTradeoff.resolution.multiplier;
    const requestedPixelRatio = window.devicePixelRatio * resolutionMultiplier * this._adaptiveResolutionScale;
    const { width, height } = this._getViewportSize();
    const viewportPixelCount = width * height;
    const maxPixelRatioForBudget = Math.sqrt(MAX_RENDER_TARGET_PIXELS / viewportPixelCount);

    return Math.max(
      MIN_RENDER_PIXEL_RATIO,
      Math.min(requestedPixelRatio, maxPixelRatioForBudget),
    );
  }

  private _applyRenderResolution(): void {
    const { width, height } = this._getViewportSize();
    const pixelRatio = this._calculateEffectivePixelRatio();
    const viewportChanged = width !== this._lastAppliedViewportWidth || height !== this._lastAppliedViewportHeight;

    if (!viewportChanged && Math.abs(pixelRatio - this._lastAppliedPixelRatio) < 0.001) {
      return;
    }

    this._renderer.setPixelRatio(pixelRatio);
    this._renderer.setSize(width, height);
    this._sceneUiRenderer.setSize(width, height);
    this._resizePostProcessing();
    this._lastAppliedPixelRatio = pixelRatio;
    this._lastAppliedViewportWidth = width;
    this._lastAppliedViewportHeight = height;
  }

  private _setupPostProcessing(): void {
    this._effectComposer.addPass(this._renderPass);
    this._effectComposer.addPass(this._gameplayDistanceBlurPass);
    this._effectComposer.addPass(this._outlinePass);
    this._effectComposer.addPass(this._viewModelRenderPass);
    this._effectComposer.addPass(this._bloomPass);
    this._effectComposer.addPass(this._smaaPass);
    this._effectComposer.addPass(this._outputPass);
    this._resizePostProcessing();
  }

  private _resizePostProcessing(): void {
    this._effectComposer.setPixelRatio(1);
    this._renderer.getDrawingBufferSize(vec2);
    this._effectComposer.setSize(vec2.width, vec2.height);
    this._bloomPass.setSize(vec2.width >> 2, vec2.height >> 2);
  }

  public addToScene(object: Object3D): void {
    this._scene.add(object);
  }

  public removeFromScene(object: Object3D): void {
    this._scene.remove(object);
  }

  public addToUIScene(object: CSS2DObject): void {
    this._uiScene.add(object);
    this._sceneUiRenderer.domElement.appendChild(object.element);
  }

  public removeFromUIScene(object: CSS2DObject): void {
    this._uiScene.remove(object);
    this._sceneUiRenderer.domElement.removeChild(object.element);
  }

  public start(): void {
    this._animate();
  }

  public toggleDebug(): void {
    this._debugVisible = !this._debugVisible;
    this._debugPanel.setVisibility(this._debugVisible);
  }

  private _animate = (): void => {
    requestAnimationFrame(this._animate);

    this._game.performanceMetricsManager.measureDeltaTime();

    const fpsCap = this._game.settingsManager.qualityPerfTradeoff.fpsCap;

    // FPS cap feature.
    // Control the refresh rate so it stays lower than the specified FPS cap. This
    // is expected to help reduce heat and power consumption.
    // Note: This feature sets the refresh rate to 1/n of the standard refresh rate,
    // not to the exact FPS cap value, and it will never exceed the FPS cap.
    if (fpsCap) {
      const timeSinceLastUpdate = this._game.performanceMetricsManager.elapsedTimeSinceLastUpdate;
      // The actual firing time of requestAnimationFrame varies, and it may be sometimes
      // called earlier than the standard refreshRate. Allow up to 5% earlier than the
      // specified fps cap. Otherwise, the refresh rate may occasionally slow down,
      // causing a stuttering appearance.
      const capTime = 1.0 / (fpsCap * 1.05);
      if (timeSinceLastUpdate < capTime) {
        return;
      }
    }

    this._game.performanceMetricsManager.update();
    this._game.settingsManager.update();

    const frameDeltaS = this._game.performanceMetricsManager.deltaTime;
    this._updateAdaptiveResolution(frameDeltaS);
    this._game.performanceBaselineManager.recordFrame(frameDeltaS * 1000);
    this._game.inputManager.update(frameDeltaS);

    this._updateFog(frameDeltaS);

    EventRouter.instance.emit(RendererEventType.Animate, { frameDeltaS });

    this._game.arrowManager.update(frameDeltaS);
    this._game.blockMaterialManager.update();
    const gltfUpdateStartMs = performance.now();
    this._game.gltfManager.update();
    this._game.performanceBaselineManager.recordGLTFUpdate(performance.now() - gltfUpdateStartMs);
    // Update the camera as late as possible so rendering uses the freshest
    // entity transforms and latest look input for this frame.
    this._game.camera.update(frameDeltaS);
    this._updateSkybox(frameDeltaS);
    this._game.audioManager.update();
    this._updateSceneUI(frameDeltaS);
    this._updateDirectionalLight(frameDeltaS);
    this._updateWaterReflection(frameDeltaS);
    this._updateGameplayDistanceBlur();

    this._applyUnderWaterEffect();
    this._syncFirstPersonViewModelEntity();

    this._renderer.info.reset();
    const pp = this._game.settingsManager.qualityPerfTradeoff.postProcessing ?? {};
    const hasGameplayDistanceBlur = this._gameplayDistanceBlurPass.enabled;
    if (pp?.outline || pp?.bloom || pp?.smaa || hasGameplayDistanceBlur) {
      const hasOutlineTargets = !!pp.outline && this._game.entityManager.hasOutlines;
      this._renderPass.camera = this._game.camera.activeCamera;
      // Keep the first-person view model out of the full-screen post stack so
      // weapon/hand motion does not pay for bloom/SMAA passes every frame.
      this._viewModelRenderPass.enabled = false;
      this._gameplayDistanceBlurPass.enabled = hasGameplayDistanceBlur;
      this._outlinePass.enabled = !!pp.outline;
      this._bloomPass.enabled = !!pp.bloom;
      this._smaaPass.enabled = !!pp.smaa;
      if (hasOutlineTargets) {
        this._outlinePass.camera = this._game.camera.activeCamera as never;
        this._outlinePass.setOutlineTargets(this._game.entityManager.getOutlineTargets());
      } else {
        this._outlinePass.clearOutlineTargets();
      }
      this._effectComposer.render();
      if (hasOutlineTargets) {
        this._game.entityManager.clearOutlineTargets();
        this._outlinePass.clearOutlineTargets();
      }
      this._renderFirstPersonViewModel();
    } else {
      this._renderer.render(this._scene, this._game.camera.activeCamera);
      this._renderFirstPersonViewModel();
    }
    this._renderScreenOverlays();

    this._debugPanel.update();
  }

  private _loadSkyboxTexture(skyboxBaseUrl: string): Promise<CubeTexture> {
    return new Promise((resolve, reject) => {
      const texture = Assets.cubeTextureLoader.load([
        `${skyboxBaseUrl}/+x.png`, `${skyboxBaseUrl}/-x.png`,
        `${skyboxBaseUrl}/+y.png`, `${skyboxBaseUrl}/-y.png`,
        `${skyboxBaseUrl}/+z.png`, `${skyboxBaseUrl}/-z.png`,
      ],
      () => {
        resolve(texture);
      },
      undefined,
      (error) => {
        reject(error);
      });
      texture.colorSpace = SRGBColorSpace;
    });
  }

  private async _loadSkybox(skyboxUri: string): Promise<void> {
    const pendingSkyboxTexture = this._loadSkyboxTexture(Assets.toAssetUri(skyboxUri));
    this._pendingSkyboxTexture = pendingSkyboxTexture;

    let skyboxTexture;

    try {
      skyboxTexture = await pendingSkyboxTexture;
    } catch(error) {
      console.error(error);
      // Lazily load missing skybox texture
      // TODO: Proper error handling when failing to load missing skybox texture
      try {
        skyboxTexture = await this._loadSkyboxTexture(MISSING_SKYBOX_TEXTURE_PATH);
      } catch (error) {
        console.error(error);
      }
    }

    // Looks like a new skybox texture request was issued while awaiting, so do nothing
    if (this._pendingSkyboxTexture !== pendingSkyboxTexture) {
      return;
    }

    // Question: Should we throw before the check above?
    if (!skyboxTexture) {
      throw new Error(`Failed to load ${skyboxUri} and Missing Skybox texture.`);
    }

    this._pendingSkyboxTexture = null;

    // Remove existing skybox mesh
    if (this._skyboxMesh) {
      this._scene.remove(this._skyboxMesh);
      this._skyboxMesh.geometry.dispose();
      const material = this._skyboxMesh.material as SkyboxMaterial;
      material.map.dispose();
      material.dispose();
    }

    // Create skybox mesh
    this._skyboxMesh = new Mesh(new BoxGeometry(1, 1, 1), new SkyboxMaterial(skyboxTexture));
    this._skyboxMesh.renderOrder = -1000;
    this._skyboxMesh.frustumCulled = false;
    this._skyboxMesh.matrixAutoUpdate = false;
    this._skyboxMesh.matrixWorldAutoUpdate = false;

    this._scene.add(this._skyboxMesh);

    // Apply current target color immediately to avoid race condition
    // when skyboxIntensity arrives in same packet as skyboxUri
    (this._skyboxMesh.material as SkyboxMaterial).color.copy(this._targetSkyboxColor);
    this._interpolatingSkyboxColor = false;
  }

  private _onWindowResize = (): void => {
    // On Pixel 7a + Chrome, switching between portrait and landscape mode causes
    // window.innerWidth and window.innerHeight to return incorrect values.
    // As a workaround, document.documentElement.clientWidth and
    // document.documentElement.clientHeight are used instead. However, it needs to be
    // verified whether this solution works correctly on other platforms as well.
    this._game.camera.onWindowResize();
    this._applyRenderResolution();
  }

  private _onWorldPacket = (payload: NetworkManagerEventPayload.IWorldPacket): void => {
    const { deserializedWorld } = payload;

    let needsTargetColorsUpdate = false;

    if (deserializedWorld.ambientLightColor) {
      // Colors from protocol are authored as sRGB; convert once for correct linear lighting math.
      this._ambientLight.color.copy(deserializedWorld.ambientLightColor).convertSRGBToLinear();
      this._ambientSceneLight.color.copy(this._ambientLight.color);
      this._ambientViewModelLight.color.copy(this._ambientLight.color);
      needsTargetColorsUpdate = true;
    }

    if (deserializedWorld.ambientLightIntensity !== undefined) {
      this._ambientLight.intensity = deserializedWorld.ambientLightIntensity;
      this._ambientSceneLight.intensity = deserializedWorld.ambientLightIntensity;
      this._ambientViewModelLight.intensity = deserializedWorld.ambientLightIntensity;
      // Update bloom threshold dynamically based on ambient light intensity
      // Formula: ambientLightIntensity + 0.01 (accounting for smoothWidth=0.01)
      // This ensures white colors lit by ambient light don't trigger bloom
      this._bloomPass.threshold = this._calculateBloomThreshold();
    }

    if (deserializedWorld.directionalLightColor) {
      const directionalColor = color.copy(deserializedWorld.directionalLightColor).convertSRGBToLinear();
      this._directionalSceneLight.color.copy(directionalColor);
      this._directionalViewModelLight.color.copy(directionalColor);
    }

    if (deserializedWorld.directionalLightIntensity !== undefined) {
      this._directionalSceneLight.intensity = deserializedWorld.directionalLightIntensity;
      this._directionalViewModelLight.intensity = deserializedWorld.directionalLightIntensity;
    }

    if (deserializedWorld.directionalLightPosition) {
      vec3.set(
        deserializedWorld.directionalLightPosition.x,
        deserializedWorld.directionalLightPosition.y,
        deserializedWorld.directionalLightPosition.z,
      );
      if (vec3.lengthSq() > 0.0001) {
        vec3.normalize().negate();
        if (this._sunDirection.distanceToSquared(vec3) > DIRECTIONAL_LIGHT_SHADOW_STABILIZATION_EPSILON_SQ) {
          this._sunDirection.copy(vec3);
          this._markDirectionalShadowDirty();
        }
      }
    }

    if (deserializedWorld.fogColor !== undefined) {
      // Ensure fog color is in linear color space for proper rendering
      if (deserializedWorld.fogColor) {
        if (this._fogColor === null) {
          this._fogColor = new Color();
        }
        this._fogColor.copy(deserializedWorld.fogColor).convertSRGBToLinear();
      } else {
        this._fogColor = null;
      }
      needsTargetColorsUpdate = true;
    }

    if (deserializedWorld.fogFar !== undefined) {
      this._fogFar = deserializedWorld.fogFar;
    }

    if (deserializedWorld.fogNear !== undefined) {
      this._fogNear = deserializedWorld.fogNear;
    }

    this._clampTargetFogNearAndFar();

    if (deserializedWorld.skyboxUri) {
      this._loadSkybox(deserializedWorld.skyboxUri);
    }

    if (deserializedWorld.skyboxIntensity !== undefined) {
      this._skyboxIntensity = deserializedWorld.skyboxIntensity;
      needsTargetColorsUpdate = true;
    }

    if (needsTargetColorsUpdate) {
      if (this._fogColor === null) {
        // Ambient light color is already stored in linear space.
        this._targetFogColor.copy(this._ambientLight.color);
      } else {
        this._targetFogColor.copy(this._fogColor);
      }
      this._targetSkyboxColor.copy(this._targetFogColor).multiplyScalar(this._skyboxIntensity);

      if (this._scene.fog !== null) {
        this._interpolatingFogColor = true;
      }
      if (this._skyboxMesh !== null) {
        this._interpolatingSkyboxColor = true;
      }
    }
  }

  private _onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === '`' || event.key === 'F3') {
      this.toggleDebug();
    }
  }

  private _onTouchStart = (event: TouchEvent): void => {
    if (event.touches.length >= 5) {
      this.toggleDebug();
    }
  }

  private _onClientSettingsUpdate = (_payload: ClientSettingsEventPayload.IUpdate): void => {
    this._adaptiveResolutionScale = 1;
    this._adaptiveResolutionDownHoldS = 0;
    this._adaptiveResolutionUpHoldS = 0;
    this._applyRenderResolution();
    this._clampTargetFogNearAndFar();
    this._setupFog();
    this._applyShadowSettings();
    this._updateDirectionalLight(0, true);
  };

  private _setupEventListeners(): void {
    window.addEventListener('resize', this._onWindowResize);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('touchstart', this._onTouchStart);

    EventRouter.instance.on(
      NetworkManagerEventType.WorldPacket,
      this._onWorldPacket,
    );

    EventRouter.instance.on(
      ClientSettingsEventType.Update,
      this._onClientSettingsUpdate,
    );
  }

  private _setupScene(): void {
    // Disable scene-level matrix auto-updates.
    // Note: object membership is still dynamic (e.g. first-person entity re-parenting
    // between _scene and _viewModelScene), but world matrices are updated manually.
    this._scene.matrixAutoUpdate = false;
    this._scene.matrixWorldAutoUpdate = false;
    this._viewModelScene.matrixAutoUpdate = false;
    this._viewModelScene.matrixWorldAutoUpdate = false;
    this._overlayScene.matrixAutoUpdate = false;
    this._overlayScene.matrixWorldAutoUpdate = false;
    this._uiScene.matrixAutoUpdate = false;
    this._uiScene.matrixWorldAutoUpdate = false;

    this._scene.add(this._ambientSceneLight);
    this._scene.add(this._directionalSceneLight);
    this._scene.add(this._directionalSceneLight.target);

    this._viewModelScene.add(this._ambientViewModelLight);
    this._viewModelScene.add(this._directionalViewModelLight);
    this._viewModelScene.add(this._directionalViewModelLight.target);

    this._directionalSceneLight.castShadow = true;
    this._directionalSceneLight.shadow.bias = DIRECTIONAL_LIGHT_SHADOW_BIAS;
    this._directionalSceneLight.shadow.normalBias = DIRECTIONAL_LIGHT_SHADOW_NORMAL_BIAS;
    this._directionalSceneLight.shadow.autoUpdate = false;
    this._directionalViewModelLight.castShadow = false;
    this._applyShadowSettings();
    this._updateDirectionalLight(0, true);
  }

  private _syncFirstPersonViewModelEntity(): void {
    const entityManager = this._game.entityManager;
    const attached = this._game.camera.isFirstPersonGameCameraActive ? this._game.camera.gameCameraAttachedEntity : undefined;
    const nextEntity = attached
      && entityManager.getEntity(attached.id) === attached
      && !attached.attached
      && attached.parentEntityId == null
      ? attached
      : undefined;

    if (this._firstPersonViewModelEntity === nextEntity) {
      // Model rebuilds can re-parent the same entity back to the main scene.
      // Ensure the active first-person view model always stays in the view model scene.
      if (nextEntity && nextEntity.entityRoot.parent !== this._viewModelScene) {
        this._viewModelScene.add(nextEntity.entityRoot);
      }
      return;
    }

    // Move previous view model entity back to main scene if still valid
    const prev = this._firstPersonViewModelEntity;
    if (prev
      && entityManager.getEntity(prev.id) === prev
      && !prev.attached
      && prev.parentEntityId == null
    ) {
      this._scene.add(prev.entityRoot);
    }

    this._firstPersonViewModelEntity = nextEntity;

    if (nextEntity) {
      this._viewModelScene.add(nextEntity.entityRoot);
    }
  }

  private _renderFirstPersonViewModel(): void {
    if (!this._firstPersonViewModelEntity) {
      return;
    }

    const autoClear = this._renderer.autoClear;
    this._renderer.autoClear = false;
    this._renderer.clearDepth();
    this._renderer.render(this._viewModelScene, this._game.camera.activeCamera);
    this._renderer.autoClear = autoClear;
  }

  private _renderScreenOverlays(): void {
    const autoClear = this._renderer.autoClear;
    this._renderer.autoClear = false;
    this._renderer.render(this._overlayScene, this._game.camera.activeCamera);
    this._renderer.autoClear = autoClear;
  }

  private _updateSceneUI(frameDeltaS: number): void {
    const uiManager = this._game.uiManager;
    const sceneUICount = uiManager.sceneUICount;

    if (sceneUICount === 0) {
      this._sceneUIRenderCooldownRemainingS = 0;
      return;
    }

    const forceRender = uiManager.consumeSceneUIRefreshRequest();
    if (!forceRender) {
      this._sceneUIRenderCooldownRemainingS = Math.max(0, this._sceneUIRenderCooldownRemainingS - frameDeltaS);
      if (this._sceneUIRenderCooldownRemainingS > 0) {
        return;
      }
    }

    uiManager.update();
    this._sceneUiRenderer.render(this._uiScene, this._game.camera.activeCamera);
    this._sceneUIRenderCooldownRemainingS = this._getSceneUIRenderInterval(sceneUICount);
  }

  private _getSceneUIRenderInterval(sceneUICount: number): number {
    if (sceneUICount <= SCENE_UI_LIGHT_LOAD_MAX) {
      return SCENE_UI_LIGHT_RENDER_INTERVAL_S;
    }

    if (sceneUICount <= SCENE_UI_MEDIUM_LOAD_MAX) {
      return SCENE_UI_MEDIUM_RENDER_INTERVAL_S;
    }

    return SCENE_UI_HEAVY_RENDER_INTERVAL_S;
  }

  private _updateAdaptiveResolution(frameDeltaS: number): void {
    if (document.visibilityState !== 'visible') {
      this._adaptiveResolutionDownHoldS = 0;
      this._adaptiveResolutionUpHoldS = 0;
      return;
    }

    const fpsCap = this._game.settingsManager.qualityPerfTradeoff.fpsCap;
    const measuredRefreshRate = this._game.performanceMetricsManager.refreshRate;
    const targetFps = fpsCap ?? measuredRefreshRate ?? 60;
    const targetFrameDeltaS = 1 / targetFps;
    const smoothingAlpha = Math.min(1, frameDeltaS * 5);
    this._smoothedFrameDeltaS = this._lerpNumber(this._smoothedFrameDeltaS, frameDeltaS, smoothingAlpha);

    const overloaded = this._smoothedFrameDeltaS > targetFrameDeltaS * ADAPTIVE_RESOLUTION_DOWN_THRESHOLD_RATIO;
    const headroom = this._smoothedFrameDeltaS < targetFrameDeltaS * ADAPTIVE_RESOLUTION_UP_THRESHOLD_RATIO;

    if (overloaded) {
      this._adaptiveResolutionDownHoldS += frameDeltaS;
      this._adaptiveResolutionUpHoldS = 0;
      if (this._adaptiveResolutionDownHoldS >= ADAPTIVE_RESOLUTION_DOWN_HOLD_S) {
        this._setAdaptiveResolutionScale(this._adaptiveResolutionScale - ADAPTIVE_RESOLUTION_DOWN_STEP);
        this._adaptiveResolutionDownHoldS = 0;
      }
      return;
    }

    this._adaptiveResolutionDownHoldS = 0;

    if (headroom) {
      this._adaptiveResolutionUpHoldS += frameDeltaS;
      if (this._adaptiveResolutionUpHoldS >= ADAPTIVE_RESOLUTION_UP_HOLD_S) {
        this._setAdaptiveResolutionScale(this._adaptiveResolutionScale + ADAPTIVE_RESOLUTION_UP_STEP);
        this._adaptiveResolutionUpHoldS = 0;
      }
      return;
    }

    this._adaptiveResolutionUpHoldS = 0;
  }

  private _setAdaptiveResolutionScale(scale: number): void {
    const nextScale = Math.max(
      MIN_ADAPTIVE_RESOLUTION_SCALE,
      Math.min(MAX_ADAPTIVE_RESOLUTION_SCALE, Number(scale.toFixed(2))),
    );

    if (Math.abs(nextScale - this._adaptiveResolutionScale) < 0.001) {
      return;
    }

    this._adaptiveResolutionScale = nextScale;
    this._applyRenderResolution();
  }

  private _setupRenderer(): void {
    this._applyRenderResolution();
    this._renderer.info.autoReset = false;
    this._renderer.localClippingEnabled = false;
    this._renderer.shadowMap.enabled = true;
    // Be explicit about output space; this is cheap and avoids surprises across Three.js versions.
    this._renderer.outputColorSpace = SRGBColorSpace;
    this._applyShadowSettings();

    this._renderer.setTransparentSort((a: RenderItem, b: RenderItem): number => {
      if (a.groupOrder !== b.groupOrder) {
        return a.groupOrder - b.groupOrder;
      } else if (a.renderOrder !== b.renderOrder) {
        return a.renderOrder - b.renderOrder;
      }

      const camera = this._game.camera.activeCamera;
      const viewDir = this._game.camera.activeViewDir;
      const frame = this._renderer.info.render.frame;
      const keyA = getTransparentSortKey(a.object as Mesh, camera.position, viewDir, frame);
      const keyB = getTransparentSortKey(b.object as Mesh, camera.position, viewDir, frame);

      if (keyA !== keyB) {
        return keyB - keyA;
      }

      return a.id - b.id;
    });

    // Handle error throwing for context loss
    this._renderer.domElement.addEventListener('webglcontextlost', e => {
      e.preventDefault();
      modalAlert('WebGL Context has been lost, this likely means a low memory or excessive GPU usage situation. Please report this error. You may refresh the page or reload the app to continue playing.');
      throw new Error('WebGL Context Lost & Caught!');
    }, false);

    document.body.appendChild(this._renderer.domElement);
  }

  private _setupSceneUiRenderer(): void {
    this._sceneUiRenderer.setSize(document.documentElement.clientWidth, document.documentElement.clientHeight);
    document.body.appendChild(this._sceneUiRenderer.domElement);
  }

  private _ensureWaterReflectionRenderTargetSize(textureSize: number): void {
    if (
      this._waterReflectionRenderTarget.width === textureSize
      && this._waterReflectionRenderTarget.height === textureSize
    ) {
      return;
    }

    this._waterReflectionRenderTarget.setSize(textureSize, textureSize);
  }

  private _estimateWaterCoverage(
    activeCamera: PerspectiveCamera,
    planeY: number,
    worldCenter: Vector3 | null,
    radius: number,
    forwardness: number,
    centerHit: boolean,
  ): number {
    const cameraHeightAbovePlane = Math.max(0, activeCamera.position.y - planeY);
    if (centerHit) {
      const heightWeight = 1 - Math.min(1, cameraHeightAbovePlane / 36);
      return 0.56 + heightWeight * 0.32;
    }

    if (worldCenter === null) {
      return 0.12;
    }

    const distance = Math.max(1, worldCenter.distanceTo(activeCamera.position));
    const projectedRadius = radius / (distance * Math.max(0.2, Math.tan(activeCamera.fov * Math.PI / 360)));
    const coverage = Math.min(0.7, Math.max(0.08, projectedRadius * projectedRadius * 2.4));

    return coverage * (0.3 + 0.7 * Math.max(0, forwardness));
  }

  private _resolveWaterReflectionQuality(coverage: number, centerHit: boolean): WaterReflectionQuality {
    const currentTextureSize = this._waterReflectionRenderTarget.width;
    const keepHighQuality = currentTextureSize >= WATER_REFLECTION_TEXTURE_SIZE_HIGH && (centerHit || coverage >= 0.42);
    const keepMediumQuality = currentTextureSize >= WATER_REFLECTION_TEXTURE_SIZE_MEDIUM && coverage >= 0.16;

    if (centerHit || coverage >= 0.55 || keepHighQuality) {
      return {
        cameraPositionDeltaSq: WATER_REFLECTION_CAMERA_POSITION_DELTA_SQ_HIGH,
        textureSize: WATER_REFLECTION_TEXTURE_SIZE_HIGH,
        updateIntervalS: WATER_REFLECTION_UPDATE_INTERVAL_HIGH_S,
        viewDirDotThreshold: WATER_REFLECTION_VIEW_DIR_DOT_THRESHOLD_HIGH,
      };
    }

    if (coverage >= 0.22 || keepMediumQuality) {
      return {
        cameraPositionDeltaSq: WATER_REFLECTION_CAMERA_POSITION_DELTA_SQ_MEDIUM,
        textureSize: WATER_REFLECTION_TEXTURE_SIZE_MEDIUM,
        updateIntervalS: WATER_REFLECTION_UPDATE_INTERVAL_MEDIUM_S,
        viewDirDotThreshold: WATER_REFLECTION_VIEW_DIR_DOT_THRESHOLD_MEDIUM,
      };
    }

    return {
      cameraPositionDeltaSq: WATER_REFLECTION_CAMERA_POSITION_DELTA_SQ_LOW,
      textureSize: WATER_REFLECTION_TEXTURE_SIZE_LOW,
      updateIntervalS: WATER_REFLECTION_UPDATE_INTERVAL_LOW_S,
      viewDirDotThreshold: WATER_REFLECTION_VIEW_DIR_DOT_THRESHOLD_LOW,
    };
  }

  private _resolveWaterReflectionPlaneInfo(activeCamera: PerspectiveCamera): WaterReflectionPlaneInfo | null {
    const liquidMeshes = this._game.chunkMeshManager.liquidMeshesInScene;

    if (liquidMeshes.length === 0) {
      return null;
    }

    waterReflectionIntersections.length = 0;
    waterReflectionRaycaster.setFromCamera(vec2.set(0, 0), activeCamera);
    waterReflectionRaycaster.far = Math.min(this.viewDistance, WATER_REFLECTION_MAX_DISTANCE);
    waterReflectionRaycaster.intersectObjects(liquidMeshes, false, waterReflectionIntersections);

    for (const intersection of waterReflectionIntersections) {
      if (!intersection.face) {
        continue;
      }

      vec3.set(
        intersection.face.normal.x,
        intersection.face.normal.y,
        intersection.face.normal.z,
      ).transformDirection(intersection.object.matrixWorld);

      if (vec3.y <= 0.6) {
        continue;
      }

      const planeY = Math.round(intersection.point.y) + WATER_SURFACE_Y_OFFSET;
      return {
        centerHit: true,
        coverage: this._estimateWaterCoverage(activeCamera, planeY, null, 0, 1, true),
        planeY,
      };
    }

    let nearestPlaneInfo: WaterReflectionPlaneInfo | null = null;
    let nearestScore = Number.POSITIVE_INFINITY;
    const cameraPosition = activeCamera.position;
    const viewDir = vec3d.copy(this._game.camera.activeViewDir).normalize();

    for (const mesh of liquidMeshes) {
      const geometry = mesh.geometry;
      if (!geometry.boundingBox) {
        geometry.computeBoundingBox();
      }
      if (!geometry.boundingSphere) {
        geometry.computeBoundingSphere();
      }
      if (!geometry.boundingBox || !geometry.boundingSphere) {
        continue;
      }

      const worldCenter = vec3.copy(geometry.boundingSphere.center).applyMatrix4(mesh.matrixWorld);
      const toCenter = vec3b.subVectors(worldCenter, cameraPosition);
      const forwardness = toCenter.lengthSq() > 0.0001 ? toCenter.normalize().dot(viewDir) : 1;
      if (forwardness < -0.1) {
        continue;
      }

      const dx = worldCenter.x - cameraPosition.x;
      const dz = worldCenter.z - cameraPosition.z;
      const horizontalDistanceSq = dx * dx + dz * dz;
      if (horizontalDistanceSq > WATER_REFLECTION_MAX_DISTANCE * WATER_REFLECTION_MAX_DISTANCE) {
        continue;
      }

      const worldTopY = vec3e.copy(geometry.boundingBox.max).applyMatrix4(mesh.matrixWorld).y;
      const planeY = Math.round(worldTopY) + WATER_SURFACE_Y_OFFSET;
      const score = horizontalDistanceSq * (1.15 - Math.min(1, Math.max(0, forwardness)));
      const coverage = this._estimateWaterCoverage(
        activeCamera,
        planeY,
        worldCenter,
        geometry.boundingSphere.radius,
        forwardness,
        false,
      );

      if (score < nearestScore) {
        nearestScore = score;
        nearestPlaneInfo = {
          centerHit: false,
          coverage,
          planeY,
        };
      }
    }

    return nearestPlaneInfo;
  }

  private _disableWaterReflection(): void {
    this._waterReflectionPlaneY = null;
    this._game.blockMaterialManager.setLiquidReflection(null, this._waterReflectionTextureMatrix.identity(), false);
  }

  private _renderWaterReflection(
    activeCamera: PerspectiveCamera,
    planeY: number,
    liquidMeshes: Mesh[],
    textureSize: number,
  ): boolean {
    const cameraPosition = activeCamera.position;
    const planePointY = planeY;

    waterReflectionView.set(0, planePointY, 0).sub(cameraPosition);
    if (waterReflectionView.dot(WORLD_UP) > 0) {
      this._disableWaterReflection();
      return false;
    }

    waterReflectionRotationMatrix.extractRotation(activeCamera.matrixWorld);
    waterReflectionLookAtPosition.set(0, 0, -1).applyMatrix4(waterReflectionRotationMatrix).add(cameraPosition);

    waterReflectionView.copy(cameraPosition);
    waterReflectionView.y = planePointY * 2 - cameraPosition.y;
    waterReflectionTarget.copy(waterReflectionLookAtPosition);
    waterReflectionTarget.y = planePointY * 2 - waterReflectionLookAtPosition.y;

    this._waterReflectionCamera.position.copy(waterReflectionView);
    this._waterReflectionCamera.up.set(0, 1, 0).applyMatrix4(waterReflectionRotationMatrix).reflect(WORLD_UP);
    this._waterReflectionCamera.near = activeCamera.near;
    this._waterReflectionCamera.far = activeCamera.far;
    this._waterReflectionCamera.aspect = activeCamera.aspect;
    this._waterReflectionCamera.fov = activeCamera.fov;
    this._waterReflectionCamera.zoom = activeCamera.zoom;
    this._waterReflectionCamera.lookAt(waterReflectionTarget);
    this._waterReflectionCamera.updateMatrixWorld();
    this._waterReflectionCamera.projectionMatrix.copy(activeCamera.projectionMatrix);
    this._waterReflectionCamera.projectionMatrixInverse.copy(activeCamera.projectionMatrixInverse);

    this._waterReflectionTextureMatrix.copy(waterReflectionTextureMatrixBias);
    this._waterReflectionTextureMatrix.multiply(this._waterReflectionCamera.projectionMatrix);
    this._waterReflectionTextureMatrix.multiply(this._waterReflectionCamera.matrixWorldInverse);

    waterReflectionPlane.setFromNormalAndCoplanarPoint(WORLD_UP, vec3e.set(0, planePointY, 0));
    waterReflectionPlane.applyMatrix4(this._waterReflectionCamera.matrixWorldInverse);
    waterReflectionClipPlane.set(
      waterReflectionPlane.normal.x,
      waterReflectionPlane.normal.y,
      waterReflectionPlane.normal.z,
      waterReflectionPlane.constant,
    );

    const projectionMatrix = this._waterReflectionCamera.projectionMatrix;
    waterReflectionProjectionQ.x = (Math.sign(waterReflectionClipPlane.x) + projectionMatrix.elements[8]) / projectionMatrix.elements[0];
    waterReflectionProjectionQ.y = (Math.sign(waterReflectionClipPlane.y) + projectionMatrix.elements[9]) / projectionMatrix.elements[5];
    waterReflectionProjectionQ.z = -1.0;
    waterReflectionProjectionQ.w = (1.0 + projectionMatrix.elements[10]) / projectionMatrix.elements[14];

    waterReflectionClipPlane.multiplyScalar(2.0 / waterReflectionClipPlane.dot(waterReflectionProjectionQ));
    projectionMatrix.elements[2] = waterReflectionClipPlane.x;
    projectionMatrix.elements[6] = waterReflectionClipPlane.y;
    projectionMatrix.elements[10] = waterReflectionClipPlane.z + 1.0 - WATER_REFLECTION_CLIP_BIAS;
    projectionMatrix.elements[14] = waterReflectionClipPlane.w;
    this._waterReflectionCamera.projectionMatrixInverse.copy(projectionMatrix).invert();

    const currentRenderTarget = this._renderer.getRenderTarget();
    const currentShadowAutoUpdate = this._renderer.shadowMap.autoUpdate;
    const currentAutoClear = this._renderer.autoClear;

    this._ensureWaterReflectionRenderTargetSize(textureSize);

    for (const liquidMesh of liquidMeshes) {
      liquidMesh.visible = false;
    }

    this._renderer.shadowMap.autoUpdate = false;
    this._renderer.autoClear = true;
    this._renderer.setRenderTarget(this._waterReflectionRenderTarget);
    this._renderer.clear();
    this._renderer.render(this._scene, this._waterReflectionCamera);
    this._renderer.setRenderTarget(currentRenderTarget);
    this._renderer.shadowMap.autoUpdate = currentShadowAutoUpdate;
    this._renderer.autoClear = currentAutoClear;

    for (const liquidMesh of liquidMeshes) {
      liquidMesh.visible = true;
    }

    this._game.blockMaterialManager.setLiquidReflection(
      this._waterReflectionRenderTarget.texture,
      this._waterReflectionTextureMatrix,
      true,
    );

    return true;
  }

  private _updateWaterReflection(frameDeltaS: number): void {
    const activeCamera = this._game.camera.activeCamera;
    const liquidMeshes = this._game.chunkMeshManager.liquidMeshesInScene;

    if (
      liquidMeshes.length === 0
      || !(activeCamera instanceof PerspectiveCamera)
      || !this._game.camera.isGameCameraActive
      || this._game.camera.isOrthographicGameCameraActive
      || this._game.chunkManager.inLiquidBlock(activeCamera.position)
    ) {
      this._disableWaterReflection();
      return;
    }

    const reflectionPlaneInfo = this._resolveWaterReflectionPlaneInfo(activeCamera);
    if (reflectionPlaneInfo === null || activeCamera.position.y <= reflectionPlaneInfo.planeY + 0.15) {
      this._disableWaterReflection();
      return;
    }

    const reflectionQuality = this._resolveWaterReflectionQuality(
      reflectionPlaneInfo.coverage,
      reflectionPlaneInfo.centerHit,
    );
    this._waterReflectionUpdateCooldownS = Math.max(0, this._waterReflectionUpdateCooldownS - frameDeltaS);
    vec3d.copy(this._game.camera.activeViewDir).normalize();

    const shouldRefresh = this._waterReflectionPlaneY === null
      || Math.abs((this._waterReflectionPlaneY ?? 0) - reflectionPlaneInfo.planeY) > 0.01
      || this._waterReflectionRenderTarget.width !== reflectionQuality.textureSize
      || this._lastWaterReflectionCameraPosition.distanceToSquared(activeCamera.position) > reflectionQuality.cameraPositionDeltaSq
      || this._lastWaterReflectionViewDir.dot(vec3d) < reflectionQuality.viewDirDotThreshold
      || this._waterReflectionUpdateCooldownS <= 0;

    if (!shouldRefresh) {
      this._game.blockMaterialManager.setLiquidReflection(
        this._waterReflectionRenderTarget.texture,
        this._waterReflectionTextureMatrix,
        true,
      );
      return;
    }

    const rendered = this._renderWaterReflection(
      activeCamera,
      reflectionPlaneInfo.planeY,
      liquidMeshes,
      reflectionQuality.textureSize,
    );
    if (!rendered) {
      return;
    }
    this._waterReflectionPlaneY = reflectionPlaneInfo.planeY;
    this._lastWaterReflectionCameraPosition.copy(activeCamera.position);
    this._lastWaterReflectionViewDir.copy(vec3d);
    this._waterReflectionUpdateCooldownS = reflectionQuality.updateIntervalS;
  }

  private _updateGameplayDistanceBlur(): void {
    const blurSettings = this._game.settingsManager.qualityPerfTradeoff.postProcessing?.depthBlur;
    const activeCamera = this._game.camera.activeCamera;

    if (
      !blurSettings?.enabled
      || !this._game.camera.isGameCameraActive
      || this._game.camera.isOrthographicGameCameraActive
    ) {
      this._gameplayDistanceBlurPass.enabled = false;
      return;
    }

    const configuredViewDistance = this._game.settingsManager.qualityPerfTradeoff.viewDistance.distance;
    const fog = this._scene.fog as Fog | null;
    const fogNear = fog?.near ?? configuredViewDistance * blurSettings.focusFarRatio;
    const fogFar = fog?.far ?? configuredViewDistance;
    const nearBlurStart = Math.max(
      activeCamera.near + 1.5,
      Math.min(configuredViewDistance * blurSettings.nearStartRatio, fogNear * 0.7),
    );
    const focusNear = Math.max(
      nearBlurStart + 1,
      Math.min(configuredViewDistance * blurSettings.focusNearRatio, fogNear * 0.8),
    );
    const focusFar = Math.max(
      focusNear + 1,
      Math.min(configuredViewDistance * blurSettings.focusFarRatio, fogNear),
    );
    const farBlurEnd = Math.max(
      focusFar + 1,
      Math.min(configuredViewDistance * blurSettings.farEndRatio, fogFar),
    );

    if (farBlurEnd <= focusFar || focusFar <= focusNear || focusNear <= nearBlurStart) {
      this._gameplayDistanceBlurPass.enabled = false;
      return;
    }

    this._gameplayDistanceBlurPass.enabled = true;
    this._gameplayDistanceBlurPass.setCamera(activeCamera);
    this._gameplayDistanceBlurPass.setFocusBand(nearBlurStart, focusNear, focusFar, farBlurEnd);
    this._gameplayDistanceBlurPass.setMaxBlurRadiiPx(
      blurSettings.maxNearRadiusPx * this._adaptiveResolutionScale,
      blurSettings.maxFarRadiusPx * this._adaptiveResolutionScale,
    );
  }

  private _applyShadowSettings(): void {
    const shadows = this._game.settingsManager.qualityPerfTradeoff.shadows;
    this._renderer.shadowMap.enabled = shadows?.enabled ?? false;
    this._renderer.shadowMap.type = shadows?.type === 'pcf' ? PCFShadowMap : VSMShadowMap;

    const directionalMapSize = shadows?.directionalMapSize ?? 1024;
    this._directionalSceneLight.shadow.mapSize.set(directionalMapSize, directionalMapSize);
    this._directionalSceneLight.shadow.autoUpdate = false;
    this._directionalSceneLight.castShadow = shadows?.enabled ?? false;
    this._markDirectionalShadowDirty();
  }

  private _markDirectionalShadowDirty(): void {
    this._directionalShadowNeedsUpdate = true;
    this._directionalShadowUpdateCooldownS = 0;
  }

  private _snapDirectionalShadowFocusCenter(focusCenter: Vector3, directionalDistance: number, directionalMapSize: number): void {
    const texelWorldSize = (directionalDistance * 2) / Math.max(1, directionalMapSize);

    if (texelWorldSize <= 0) {
      return;
    }

    const basisReference = Math.abs(this._sunDirection.dot(WORLD_UP)) < DIRECTIONAL_LIGHT_SHADOW_STABILIZATION_PARALLEL_THRESHOLD
      ? WORLD_UP
      : WORLD_RIGHT;

    vec3b.crossVectors(basisReference, this._sunDirection).normalize();
    vec3c.crossVectors(this._sunDirection, vec3b).normalize();

    const snappedX = Math.round(focusCenter.dot(vec3b) / texelWorldSize) * texelWorldSize;
    const snappedY = Math.round(focusCenter.dot(vec3c) / texelWorldSize) * texelWorldSize;
    const depth = focusCenter.dot(this._sunDirection);

    focusCenter.copy(this._sunDirection).multiplyScalar(depth);
    focusCenter.addScaledVector(vec3b, snappedX);
    focusCenter.addScaledVector(vec3c, snappedY);
  }

  private _applyDirectionalLightFocusCenter(focusCenter: Vector3, lightHeight: number, directionalDistance: number): void {
    this._directionalSceneLight.target.position.copy(focusCenter);
    this._directionalSceneLight.target.updateMatrixWorld();
    this._directionalSceneLight.position.copy(focusCenter).addScaledVector(this._sunDirection, -lightHeight);
    this._directionalSceneLight.updateMatrixWorld();

    const shadowCamera = this._directionalSceneLight.shadow.camera as OrthographicCamera;
    shadowCamera.left = -directionalDistance;
    shadowCamera.right = directionalDistance;
    shadowCamera.top = directionalDistance;
    shadowCamera.bottom = -directionalDistance;
    shadowCamera.near = 0.5;
    shadowCamera.far = Math.max(directionalDistance * 4, lightHeight * 2);
    shadowCamera.updateProjectionMatrix();
  }

  private _updateDirectionalLight(frameDeltaS: number = 0, force: boolean = false): void {
    const shadows = this._game.settingsManager.qualityPerfTradeoff.shadows;
    const directionalDistance = shadows?.directionalDistance ?? 48;
    const cameraPosition = this._game.camera.activeCamera.position;
    const lightHeight = Math.max(DIRECTIONAL_LIGHT_MIN_HEIGHT, directionalDistance * DIRECTIONAL_LIGHT_SHADOW_HEIGHT_MULTIPLIER);
    const directionalMapSize = this._directionalSceneLight.shadow.mapSize.x || shadows?.directionalMapSize || 1024;

    this._directionalShadowUpdateCooldownS = Math.max(0, this._directionalShadowUpdateCooldownS - frameDeltaS);

    vec3.copy(cameraPosition);
    vec3d.copy(this._game.camera.activeViewDir);
    if (vec3d.lengthSq() > DIRECTIONAL_LIGHT_SHADOW_STABILIZATION_EPSILON_SQ) {
      vec3d.normalize();
      vec3.addScaledVector(vec3d, directionalDistance * DIRECTIONAL_LIGHT_SHADOW_FORWARD_OFFSET_RATIO);
    }

    if (shadows?.enabled) {
      this._snapDirectionalShadowFocusCenter(vec3, directionalDistance, directionalMapSize);
    }

    this._directionalViewModelLight.target.position.set(0, 0, -1);
    this._directionalViewModelLight.target.updateMatrixWorld();
    this._directionalViewModelLight.position.copy(this._sunDirection).multiplyScalar(-lightHeight * 0.25);
    this._directionalViewModelLight.updateMatrixWorld();

    if (!shadows?.enabled) {
      this._applyDirectionalLightFocusCenter(vec3, lightHeight, directionalDistance);
      this._directionalShadowInitialized = true;
      this._directionalShadowNeedsUpdate = false;
      this._lastDirectionalShadowFocusCenter.copy(vec3);
      this._lastDirectionalShadowSunDirection.copy(this._sunDirection);
      return;
    }

    const focusDeltaSq = this._directionalShadowInitialized
      ? this._lastDirectionalShadowFocusCenter.distanceToSquared(vec3)
      : Number.POSITIVE_INFINITY;
    const immediateUpdateDistance = directionalDistance * DIRECTIONAL_LIGHT_SHADOW_IMMEDIATE_UPDATE_DISTANCE_RATIO;
    const sunDirectionChanged = !this._directionalShadowInitialized
      || this._lastDirectionalShadowSunDirection.distanceToSquared(this._sunDirection) > DIRECTIONAL_LIGHT_SHADOW_STABILIZATION_EPSILON_SQ;
    const focusCenterChanged = !this._directionalShadowInitialized
      || focusDeltaSq > DIRECTIONAL_LIGHT_SHADOW_STABILIZATION_EPSILON_SQ;
    const shouldRefreshShadow = force
      || this._directionalShadowNeedsUpdate
      || sunDirectionChanged
      || focusDeltaSq >= immediateUpdateDistance * immediateUpdateDistance
      || (focusCenterChanged && this._directionalShadowUpdateCooldownS <= 0);

    if (!shouldRefreshShadow) {
      return;
    }

    this._applyDirectionalLightFocusCenter(vec3, lightHeight, directionalDistance);
    this._directionalSceneLight.shadow.needsUpdate = true;
    this._directionalShadowNeedsUpdate = false;
    this._directionalShadowInitialized = true;
    this._directionalShadowUpdateCooldownS = DIRECTIONAL_LIGHT_SHADOW_UPDATE_INTERVAL_S;
    this._lastDirectionalShadowFocusCenter.copy(vec3);
    this._lastDirectionalShadowSunDirection.copy(this._sunDirection);
  }

  private _createUnderWaterEffectQuad(): Mesh {
    // Configuration for applying a color overlay to the entire screen.
    // The material is set to transparent with depthTest and depthWrite disabled,
    // and frustumCulling turned off. By placing it directly in front of the camera
    // and rendering it last, the color overlay consistently covers the full screen
    // even if objects come between the camera and the quad.
    const quad = new Mesh(
      new PlaneGeometry(2, 2),
      new MeshBasicMaterial({
        transparent: true,
        blending: MultiplyBlending,
        depthTest: false,
        depthWrite: false,
      }),
    );
    quad.frustumCulled = false;
    quad.renderOrder = 9999;
    quad.position.z = -0.5;
    quad.updateMatrix();
    // Auto matrix update is disabled because it is manually calculated when needed.
    quad.matrixAutoUpdate = false;
    quad.matrixWorldAutoUpdate = false;

    this._overlayScene.add(quad);

    return quad;
  }

  // When the camera is inside a Liquid Block, apply a color tint to the entire screen
  // as an underwater effect, using a color based on the Liquid Block's color.
  private _applyUnderWaterEffect(): void {
    const activeCamera = this._game.camera.activeCamera;

    if (this._game.chunkManager.inLiquidBlock(activeCamera.position)) {
      const cameraGlobalCoordinate = Chunk.worldPositionToGlobalCoordinate(activeCamera.position);
      const chunk = this._game.chunkManager.getChunkByGlobalCoordinate(cameraGlobalCoordinate)!;
      const blockTypeId = chunk.getBlockType(Chunk.globalCoordinateToLocalCoordinate(cameraGlobalCoordinate));
      const blockType = this._game.blockTypeManager.getBlockType(blockTypeId)!;
      const blockRGB = this._game.blockTypeManager.getBlockRGB(blockType);
      // Since less light reaches underwater, using a slightly darker color than the
      // Liquid Block's color creates a more realistic effect. However, this adjustment
      // value is not based on any solid reference and may need further tuning.
      (this._underWaterEffectQuad.material as MeshBasicMaterial).color.setRGB(
        blockRGB[0] * 0.5,
        blockRGB[1] * 0.5,
        blockRGB[2] * 0.5,
      );
      this._underWaterEffectQuad.matrixWorld.multiplyMatrices(activeCamera.matrixWorld, this._underWaterEffectQuad.matrix);
      this._underWaterEffectQuad.visible = true;
    } else {
      this._underWaterEffectQuad.visible = false;
    }
  }

  private _setupFog(): void {
    const config = this._game.settingsManager.qualityPerfTradeoff.viewDistance;

    // Create or destroy fog based on settings
    if (!this._scene.fog && config.fog.enabled) {
      this._scene.fog = new Fog(this._targetFogColor, this._targetFogNear, this._targetFogFar);
      this._interpolatingSkyboxColor = true;
    } else if (this._scene.fog && !config.fog.enabled) {
      this._scene.fog = null;
    }

    this._viewModelScene.fog = this._scene.fog;

    this._interpolatingFogColor = false;
  }

  private _updateFog(frameDeltaS: number): void {
    if (this._scene.fog === null) {
      return;
    }

    const alpha = Math.min(frameDeltaS * 10, 1);
    const fog = this._scene.fog as Fog;

    // Smoothly interpolate fog color towards target
    if (this._interpolatingFogColor) {
      this._interpolatingFogColor = !lerpColor(fog.color, this._targetFogColor, alpha);
    }

    // For near/far interpolation
    if (this._targetFogFar !== fog.far) {
      fog.far = this._lerpNumber(fog.far, this._targetFogFar, alpha);
      // The skybox color is affected by the fog’s near and far values, so it needs to be updated accordingly.
      if (this._skyboxMesh) {
        this._interpolatingSkyboxColor = true;
      }
    }

    if (this._targetFogNear !== fog.near) {
      fog.near = this._lerpNumber(fog.near, this._targetFogNear, alpha);
      if (this._skyboxMesh) {
        this._interpolatingSkyboxColor = true;
      }
    }
  }

  private _updateSkybox(frameDeltaS: number): void {
    const alpha = Math.min(frameDeltaS * 10, 1);

    // Update skybox colors by blending between original skybox color and fog color
    if (this._scene.fog && this._skyboxMesh && this._interpolatingSkyboxColor) {
      const fog = this._scene.fog as Fog;
      const shiftMinDistance = 100;
      const baseFogInfluence = Math.max(0, Math.min(1, 1 - (fog.near / shiftMinDistance)));

      // Amplify fog influence based on fog range (smaller range = more intense color)
      const fogRange = fog.far - fog.near;
      const referenceRange = 100;
      const amplification = Math.max(1, referenceRange / fogRange);
      const intenseFogInfluence = Math.min(1, baseFogInfluence * amplification);

      // Calculate target skybox color
      const foggedColor = color.setRGB(1, 1, 1).lerp(this._targetSkyboxColor, intenseFogInfluence);
      const targetSkyboxColor = foggedColor.multiplyScalar(this._skyboxIntensity);

      // Smoothly interpolate toward target
      this._interpolatingSkyboxColor = !lerpColor((this._skyboxMesh.material as SkyboxMaterial).color, targetSkyboxColor, alpha);
    }

    if (this._skyboxMesh) {
      this._skyboxMesh.position.setFromMatrixPosition(this._game.camera.activeCamera.matrixWorld);
      this._skyboxMesh.updateMatrix();
      this._skyboxMesh.matrixWorld.copy(this._skyboxMesh.matrix);
    }
  }

  private _lerpNumber(n1: number, n2: number, alpha: number): number {
    return (Math.abs(n1 - n2) < 0.01) ? n2 : n1 + (n2 - n1) * alpha;
  }

  private _calculateBloomThreshold(): number {
    // Dynamic bloom threshold based on ambient light intensity
    // UnrealBloomPass always sets smoothWidth to 0.01 (see UnrealBloomPass.js)
    const smoothWidth = 0.01;

    // Formula: ambientLightIntensity + smoothWidth, with minimum threshold
    // This accounts for smoothstep interpolation and ensures ambient-lit white colors don't trigger bloom
    // Minimum threshold to prevent low-luminance bloom
    return Math.max(this._ambientLight.intensity + smoothWidth, 1.0 + smoothWidth);
  }

  private _clampTargetFogNearAndFar(): void {
    const config = this._game.settingsManager.qualityPerfTradeoff.viewDistance;

    // Clamp the fog far to the view distnace config
    // to prevent the fog being set too far away relative to
    // view distance.
    this._targetFogFar = Math.min(config.fog.far, this._fogFar);

    // Since fog was originally introduced to reduce the negative visual effects caused by view distance,
    // _targetFogNear should not be allowed to be greater than config.fog.near
    this._targetFogNear = Math.min(this._targetFogFar, Math.min(config.fog.near, this._fogNear));
  }
}
