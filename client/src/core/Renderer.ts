import {
  BackSide,
  BoxGeometry,
  Color,
  CubeTexture,
  DepthTexture,
  Fog,
  HalfFloatType,
  Mesh,
  MeshBasicMaterial,
  MultiplyBlending,
  Object3D,
  PlaneGeometry,
  RenderItem,
  Scene,
  ShaderLib,
  ShaderMaterial,
  SRGBColorSpace,
  UniformsUtils,
  Vector2,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { WhiteCoreBloomPass } from '../three/postprocessing/WhiteCoreBloomPass';
import { SelectiveOutlinePass } from '../three/postprocessing/SelectiveOutlinePass';
import DebugPanel from './DebugPanel';
import Chunk from '../chunks/Chunk';
import Assets from '../network/Assets';
import EventRouter from '../events/EventRouter';
import Game from '../Game';
import { modalAlert } from '../ui/Modal';
import { NetworkManagerEventType } from '../network/NetworkManager';
import { getTransparentSortKey, lerpColor } from '../three/utils';
import { CSS2DObject, CSS2DRenderer } from '../three/CSS2DRenderer';
import type Entity from '../entities/Entity';
import type { NetworkManagerEventPayload } from '../network/NetworkManager';
import { type ClientSettingsEventPayload, ClientSettingsEventType } from '../settings/SettingsManager';

const MISSING_SKYBOX_TEXTURE_PATH = '/textures/missing-skybox';
// Cap internal render target pixel count to avoid severe fullscreen slowdowns on
// high-DPI displays (e.g. Retina). Windowed mode remains sharper because viewport
// area is smaller and usually falls below this budget.
const MAX_RENDER_TARGET_PIXELS = 2560 * 1440;
const MIN_RENDER_PIXEL_RATIO = 0.5;
const SCENE_UI_LIGHT_LOAD_MAX = 4;
const SCENE_UI_MEDIUM_LOAD_MAX = 12;
const SCENE_UI_LIGHT_RENDER_INTERVAL_S = 1 / 60;
const SCENE_UI_MEDIUM_RENDER_INTERVAL_S = 1 / 30;
const SCENE_UI_HEAVY_RENDER_INTERVAL_S = 1 / 20;

// Working variables
const color = new Color();
const vec2 = new Vector2();

// Simple data container for ambient light (replaces Three.js AmbientLight which has no effect on MeshBasicMaterial)
export type AmbientLightData = {
  color: Color;
  intensity: number;
}

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
  private _targetFogColor: Color = new Color();
  private _targetFogFar: number = 100000;
  private _targetFogNear: number = 100000;
  private _targetSkyboxColor: Color = new Color(1, 1, 1);
  private _interpolatingFogColor: boolean;
  private _interpolatingSkyboxColor: boolean;
  private _underWaterEffectQuad: Mesh;
  private _skyboxIntensity: number = 1;
  private _skyboxMesh: Mesh | null = null;
  private _pendingSkyboxTexture: Promise<CubeTexture> | null = null;
  private _debugVisible: boolean = false;
  private _debugPanel: DebugPanel;
  private _effectComposer: EffectComposer;
  private _renderPass: RenderPass;
  private _viewModelRenderPass: RenderPass;
  private _outlinePass: SelectiveOutlinePass;
  private _smaaPass: SMAAPass;
  private _bloomPass: WhiteCoreBloomPass;
  private _outputPass: OutputPass;
  private _sceneUIRenderCooldownRemainingS: number = 0;

  public constructor(game: Game) {
    this._game = game;

    this._ambientLight = { color: new Color(), intensity: 1 };
    // Anti-aliasing is handled in post-processing
    this._renderer = new WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this._sceneUiRenderer = new CSS2DRenderer({ element: document.getElementById('scene-ui-container')! });
    this._scene = new Scene();
    this._viewModelScene = new Scene();
    this._overlayScene = new Scene();
    this._uiScene = new Scene();
    this._interpolatingFogColor = false;
    this._interpolatingSkyboxColor = false;
    this._underWaterEffectQuad = this._createUnderWaterEffectQuad();

    // Create render target with depth texture for outline occlusion testing
    // Size is set later via _resizePostProcessing()
    this._effectComposer = new EffectComposer(this._renderer, new WebGLRenderTarget(1, 1, {
      depthTexture: new DepthTexture(1, 1),
      type: HalfFloatType,
    }));
    this._renderPass = new RenderPass(this._scene, this._game.camera.activeCamera);
    this._viewModelRenderPass = new RenderPass(this._viewModelScene, this._game.camera.activeCamera);
    this._viewModelRenderPass.clear = false;
    this._viewModelRenderPass.clearDepth = true;
    this._outlinePass = new SelectiveOutlinePass(
      this._game.camera.activeCamera,
      new Vector2(1, 1),
    );
    // Note: Size for Passes are set appropriately when EffectComposer size is set
    this._smaaPass = new SMAAPass();
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
    const requestedPixelRatio = window.devicePixelRatio * resolutionMultiplier;
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
    this._renderer.setPixelRatio(this._calculateEffectivePixelRatio());
    this._renderer.setSize(width, height);
    this._sceneUiRenderer.setSize(width, height);
    this._resizePostProcessing();
  }

  private _setupPostProcessing(): void {
    this._effectComposer.addPass(this._renderPass);
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
    this._game.inputManager.update(frameDeltaS);

    this._updateFog(frameDeltaS);

    EventRouter.instance.emit(RendererEventType.Animate, { frameDeltaS });

    this._game.arrowManager.update(frameDeltaS);
    this._game.blockMaterialManager.update();
    this._game.camera.update(frameDeltaS);
    this._game.audioManager.update();
    this._updateSkybox(frameDeltaS);

    this._game.gltfManager.update();
    this._updateSceneUI(frameDeltaS);

    this._applyUnderWaterEffect();
    this._syncFirstPersonViewModelEntity();

    this._renderer.info.reset();
    const pp = this._game.settingsManager.qualityPerfTradeoff.postProcessing;
    if (pp?.outline || pp?.bloom || pp?.smaa) {
      const hasOutlineTargets = !!pp.outline && this._game.entityManager.hasOutlines;
      this._renderPass.camera = this._game.camera.activeCamera;
      // Keep the first-person view model out of the full-screen post stack so
      // weapon/hand motion does not pay for bloom/SMAA passes every frame.
      this._viewModelRenderPass.enabled = false;
      this._outlinePass.enabled = !!pp.outline;
      this._bloomPass.enabled = !!pp.bloom;
      this._smaaPass.enabled = !!pp.smaa;
      if (hasOutlineTargets) {
        this._outlinePass.camera = this._game.camera.activeCamera;
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
      needsTargetColorsUpdate = true;
    }

    if (deserializedWorld.ambientLightIntensity !== undefined) {
      this._ambientLight.intensity = deserializedWorld.ambientLightIntensity;
      // Update bloom threshold dynamically based on ambient light intensity
      // Formula: ambientLightIntensity + 0.01 (accounting for smoothWidth=0.01)
      // This ensures white colors lit by ambient light don't trigger bloom
      this._bloomPass.threshold = this._calculateBloomThreshold();
    }

    // Note: directionalLight properties from server are ignored since we no longer use
    // DirectionalLight (MeshBasicMaterial doesn't respond to Three.js lights)

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
    this._applyRenderResolution();
    this._clampTargetFogNearAndFar();
    this._setupFog();
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

  // Note: No Three.js lights are added to the scene because MeshBasicMaterial doesn't
  // respond to them. _ambientLight stores color and intensity values that are passed
  // to custom shader uniforms manually.

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

  private _setupRenderer(): void {
    this._applyRenderResolution();
    this._renderer.info.autoReset = false;
    this._renderer.localClippingEnabled = false;
    // Be explicit about output space; this is cheap and avoids surprises across Three.js versions.
    this._renderer.outputColorSpace = SRGBColorSpace;

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
