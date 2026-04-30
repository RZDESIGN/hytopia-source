import {
  AdditiveBlending,
  AmbientLight,
  BackSide,
  BoxGeometry,
  Color,
  CubeCamera,
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
  NeutralToneMapping,
  Object3D,
  OrthographicCamera,
  PCFShadowMap,
  PMREMGenerator,
  PlaneGeometry,
  PerspectiveCamera,
  Plane,
  Raycaster,
  RenderItem,
  Scene,
  ShaderLib,
  ShaderMaterial,
  SRGBColorSpace,
  Texture,
  UniformsUtils,
  Vector2,
  Vector3,
  Vector4,
  VSMShadowMap,
  WebGLCubeRenderTarget,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { LUTPass } from 'three/examples/jsm/postprocessing/LUTPass.js';
import { AnalyticSunHaloPass } from '../three/postprocessing/AnalyticSunHaloPass';
import { AtmosphericScatteringPass } from '../three/postprocessing/AtmosphericScatteringPass';
import { GroundedGTAOPass } from '../three/postprocessing/GroundedGTAOPass';
import { NearContactShadowsPass } from '../three/postprocessing/NearContactShadowsPass';
import { TemporalResolvePass } from '../three/postprocessing/TemporalResolvePass';
import { WhiteCoreBloomPass } from '../three/postprocessing/WhiteCoreBloomPass';
import { SelectiveOutlinePass } from '../three/postprocessing/SelectiveOutlinePass';
import { createCinematicLut } from '../three/postprocessing/createCinematicLut';
import { setDirectionalShadowContrast } from '../three/directionalShadowFade';
import { WATER_SURFACE_Y_OFFSET } from '../blocks/BlockConstants';
import Chunk from '../chunks/Chunk';
import Assets from '../network/Assets';
import EventRouter from '../events/EventRouter';
import Game from '../Game';
import type { NetworkManagerEventPayload } from '../network/NetworkEventPayloads';
import { NetworkManagerEventType } from '../network/NetworkEvents';
import { getTransparentSortKey, lerpColor } from '../three/utils';
import { CSS2DObject, CSS2DRenderer } from '../three/CSS2DRenderer';
import type Entity from '../entities/Entity';
import { type ClientSettingsEventPayload, ClientSettingsEventType } from '../settings/SettingsManager';
import type DebugPanel from './DebugPanel';
import {
  getStormLightningIntensity,
  parseProceduralSkySettings,
  ProceduralSkyMaterial,
  type ProceduralSkyPrecipitation,
  type ProceduralSkySettings,
  SquareSunMaterial,
  WeatherPrecipitationSystem,
  WeatherSurfaceImpactSystem,
} from './ProceduralSky';
import MobileManager from '../mobile/MobileManager';

const MISSING_SKYBOX_TEXTURE_PATH = '/textures/missing-skybox';
// Cap internal render target pixel count to avoid severe fullscreen slowdowns on
// high-DPI displays (e.g. Retina). Mobile devices use a tighter 1080p budget
// since phone screens are small enough that higher resolution is imperceptible,
// and mobile GPUs are heavily fill-rate constrained.
const MAX_RENDER_TARGET_PIXELS = MobileManager.isMobile ? 1920 * 1080 : 2560 * 1440;
const MIN_RENDER_PIXEL_RATIO = 0.5;
const MIN_ADAPTIVE_RESOLUTION_SCALE = MobileManager.isMobile ? 0.5 : 0.67;
const MAX_ADAPTIVE_RESOLUTION_SCALE = 1.0;
const ADAPTIVE_RESOLUTION_DOWN_STEP = MobileManager.isMobile ? 0.12 : 0.08;
const ADAPTIVE_RESOLUTION_UP_STEP = 0.04;
const ADAPTIVE_RESOLUTION_DOWN_THRESHOLD_RATIO = 1.08;
const ADAPTIVE_RESOLUTION_UP_THRESHOLD_RATIO = 0.92;
const ADAPTIVE_RESOLUTION_DOWN_HOLD_S = 0.2;
const ADAPTIVE_RESOLUTION_UP_HOLD_S = 1.5;
const SCENE_UI_LIGHT_LOAD_MAX = 4;
const SCENE_UI_MEDIUM_LOAD_MAX = 12;
const SCENE_UI_LIGHT_RENDER_INTERVAL_S = MobileManager.isMobile ? 1 / 30 : 1 / 60;
const SCENE_UI_MEDIUM_RENDER_INTERVAL_S = MobileManager.isMobile ? 1 / 20 : 1 / 30;
const SCENE_UI_HEAVY_RENDER_INTERVAL_S = MobileManager.isMobile ? 1 / 15 : 1 / 20;
const DIRECTIONAL_LIGHT_SHADOW_BIAS = -0.00012;
const DIRECTIONAL_LIGHT_SHADOW_NORMAL_BIAS = 0.01;
const DIRECTIONAL_LIGHT_SHADOW_HEIGHT_MULTIPLIER = 1.5;
const DIRECTIONAL_LIGHT_MIN_HEIGHT = 24;
const DIRECTIONAL_LIGHT_SHADOW_UPDATE_INTERVAL_S = 1 / 30;
const DIRECTIONAL_LIGHT_SHADOW_IMMEDIATE_UPDATE_DISTANCE_RATIO = 0.5;
const DIRECTIONAL_LIGHT_SHADOW_CAMERA_POSITION_DELTA_SQ_THRESHOLD = 0.025 * 0.025;
const DIRECTIONAL_LIGHT_SHADOW_CONTINUOUS_UPDATE_HOLD_S = 0.12;
const DIRECTIONAL_LIGHT_SHADOW_STABILIZATION_PARALLEL_THRESHOLD = 0.95;
const DIRECTIONAL_LIGHT_SHADOW_STABILIZATION_EPSILON_SQ = 0.000001;
const WATER_REFLECTION_TEXTURE_SIZE_HIGH = MobileManager.isMobile ? 384 : 512;
const WATER_REFLECTION_TEXTURE_SIZE_MEDIUM = MobileManager.isMobile ? 256 : 384;
const WATER_REFLECTION_TEXTURE_SIZE_LOW = MobileManager.isMobile ? 192 : 256;
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
const WATER_REFLECTION_MIN_SCENE_COVERAGE = 0.18;
const WORLD_FOG_VIEW_DISTANCE_BUFFER = 24;
const PROCEDURAL_SKY_SETTINGS_BLEND_SPEED = 2.8;
const WEATHER_SURFACE_IMPACT_JITTER = 0.34;
const WEATHER_SURFACE_IMPACT_SCAN_ABOVE = 4;
const WEATHER_SURFACE_IMPACT_SCAN_BELOW = 18;
const WEATHER_SURFACE_IMPACT_SKY_EXPOSURE_MIN = 0.7;
const WEATHER_SURFACE_IMPACT_SOLID_Y_OFFSET = 0.018;
const WEATHER_SURFACE_IMPACT_LIQUID_Y_OFFSET = 0.01;
const WEATHER_SURFACE_IMPACT_SAMPLE_ATTEMPTS = 4;
const DIRECTIONAL_SHADOW_CASCADE_NEAR_DISTANCE_RATIO = 0.52;
const DIRECTIONAL_SHADOW_CASCADE_FAR_MAP_SIZE_RATIO = 0.75;
const DIRECTIONAL_SHADOW_CASCADE_MIN_MAP_SIZE = 512;
const NEAR_CONTACT_SHADOW_STRENGTH = 0.58;
const DIRECTIONAL_SHADOW_CONTRAST_DEFAULT = 1.45;
const DIRECTIONAL_SHADOW_CONTRAST_HIGH = 2.18;
const PROCEDURAL_SKY_ENVIRONMENT_BASE_UPDATE_INTERVAL_S = MobileManager.isMobile ? 5.0 : 2.5;
const PROCEDURAL_SKY_ENVIRONMENT_TRANSITION_UPDATE_INTERVAL_S = MobileManager.isMobile ? 1.5 : 0.5;
const PROCEDURAL_SKY_ENVIRONMENT_BOX_SIZE = 24;
const PROCEDURAL_SKY_ENVIRONMENT_FAR = 32;
const PROCEDURAL_SKY_ENVIRONMENT_MOON_DISTANCE = 9.5;
const PROCEDURAL_SKY_ENVIRONMENT_MOON_SIZE_RATIO = 120 / 840;
const PROCEDURAL_SKY_ENVIRONMENT_NEAR = 0.1;
const PROCEDURAL_SKY_ENVIRONMENT_SIZE = MobileManager.isMobile ? 64 : 128;
const PROCEDURAL_SKY_ENVIRONMENT_SUN_DISTANCE = 10;
const PROCEDURAL_SKY_ENVIRONMENT_SUN_SIZE_RATIO = 260 / 880;
const LOCAL_REFLECTION_PROBE_FAR = 36;
const LOCAL_REFLECTION_PROBE_NEAR = 0.2;
const TEMPORAL_JITTER_SCALE = 0.7;
const COLOR_PRESERVING_TONE_MAPPING_EXPOSURE = 1.0;

// Working variables
const color = new Color();
const colorb = new Color();
const vec2 = new Vector2();
const vec3 = new Vector3();
const vec3b = new Vector3();
const vec3c = new Vector3();
const vec3d = new Vector3();
const vec3e = new Vector3();
const shadowSnapBasisA = new Vector3();
const shadowSnapBasisB = new Vector3();
const LIGHTNING_FLASH_COLOR = new Color(0.78, 0.84, 1);
const NEUTRAL_LIGHT_COLOR = new Color(1, 1, 1);
const WORLD_ORIGIN = new Vector3();
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
const waterReflectionVisibleObjectSet: Set<Object3D> = new Set();
const waterReflectionTemporarilyHiddenObjects: Object3D[] = [];
const waterReflectionTemporarilyAddedObjects: Array<{ object: Object3D; wasVisible: boolean }> = [];
const waterReflectionTextureMatrixBias = new Matrix4().set(
  0.5, 0.0, 0.0, 0.5,
  0.0, 0.5, 0.0, 0.5,
  0.0, 0.0, 0.5, 0.5,
  0.0, 0.0, 0.0, 1.0,
);

function isApproximatelyEqual(a: number, b: number, epsilon: number = 0.0001): boolean {
  return Math.abs(a - b) <= epsilon;
}

function getColorBrightness(color: Color): number {
  return Math.max(color.r, color.g, color.b);
}

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

export type PostProcessingDebugState = {
  atmosphere: boolean;
  bloom: boolean;
  composer: boolean;
  gtao: boolean;
  lut: boolean;
  nearContactShadows: boolean;
  outline: boolean;
  smaa: boolean;
  temporalResolve: boolean;
};

export type RendererRuntimeTuningState = {
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

type RendererRuntimeTuningOverrides = Partial<RendererRuntimeTuningState>;

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

function isProceduralSkyMaterial(material: unknown): material is ProceduralSkyMaterial {
  return material instanceof ProceduralSkyMaterial;
}

function cloneProceduralSkySettings(settings: ProceduralSkySettings): ProceduralSkySettings {
  return {
    cloudCoverage: settings.cloudCoverage,
    cloudOpacity: settings.cloudOpacity,
    cloudScale: settings.cloudScale,
    cloudSpeed: settings.cloudSpeed,
    precipitation: settings.precipitation,
    precipitationIntensity: settings.precipitationIntensity,
    preset: settings.preset,
    storminess: settings.storminess,
    windDirection: settings.windDirection.clone(),
  };
}

function blendProceduralSkySettings(
  current: ProceduralSkySettings,
  target: ProceduralSkySettings,
  alpha: number,
): void {
  current.preset = target.preset;
  current.cloudCoverage += (target.cloudCoverage - current.cloudCoverage) * alpha;
  current.cloudOpacity += (target.cloudOpacity - current.cloudOpacity) * alpha;
  current.cloudScale += (target.cloudScale - current.cloudScale) * alpha;
  current.cloudSpeed += (target.cloudSpeed - current.cloudSpeed) * alpha;
  current.precipitationIntensity += (target.precipitationIntensity - current.precipitationIntensity) * alpha;
  current.storminess += (target.storminess - current.storminess) * alpha;
  current.windDirection.lerp(target.windDirection, alpha);
  current.precipitation = target.precipitation;
}

function halton(index: number, base: number): number {
  let fraction = 1 / base;
  let result = 0;
  let currentIndex = index;

  while (currentIndex > 0) {
    result += fraction * (currentIndex % base);
    currentIndex = Math.floor(currentIndex / base);
    fraction /= base;
  }

  return result;
}

export default class Renderer {
  private _game: Game;
  private _ambientLight: AmbientLightData;
  private _pmremGenerator: PMREMGenerator;
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
  private _baseAmbientLightColor: Color = new Color(1, 1, 1);
  private _baseAmbientLightIntensity: number = 1;
  private _baseDirectionalLightColor: Color = new Color(1, 1, 1);
  private _baseDirectionalLightIntensity: number = 0;
  private _environmentAmbientLightColor: Color = new Color(1, 1, 1);
  private _environmentDirectionalLightColor: Color = new Color(1, 1, 1);
  private _directionalSceneLight: DirectionalLight;
  private _directionalShadowCascadeNearLight: DirectionalLight;
  private _directionalShadowCascadeFarLight: DirectionalLight;
  private _directionalViewModelLight: DirectionalLight;
  private _sunDirection: Vector3 = new Vector3(0.3, -1, 0.2).normalize();
  private _skySunDirection: Vector3 | null = null;
  private _targetFogColor: Color = new Color();
  private _targetFogFar: number = 100000;
  private _targetFogNear: number = 100000;
  private _targetSkyboxColor: Color = new Color(1, 1, 1);
  private _interpolatingFogColor: boolean;
  private _interpolatingSkyboxColor: boolean;
  private _proceduralSkyColor: Color = new Color(0.7, 0.82, 1);
  private _proceduralSkyEnvironmentMoonMesh: Mesh | null = null;
  private _proceduralSkyEnvironmentRenderTarget: WebGLRenderTarget | null = null;
  private _proceduralSkyEnvironmentScene: Scene | null = null;
  private _proceduralSkyEnvironmentSkyMesh: Mesh | null = null;
  private _proceduralSkyEnvironmentSunMesh: Mesh | null = null;
  private _proceduralSkyEnvironmentUpdateCooldownS: number = 0;
  private _baseEnvironmentTexture: Texture | null = null;
  private _environmentOverrideTexture: Texture | null = null;
  private _proceduralSkySettings: ProceduralSkySettings | null = null;
  private _proceduralSkyTargetSettings: ProceduralSkySettings | null = null;
  private _proceduralMoonMesh: Mesh | null = null;
  private _proceduralSkyWorldSeed: number = 1;
  private _proceduralSkyTimeS: number = 0;
  private _proceduralPrecipitation: WeatherPrecipitationSystem | null = null;
  private _proceduralSurfaceImpacts: WeatherSurfaceImpactSystem | null = null;
  private _proceduralSunMesh: Mesh | null = null;
  private _lightningFlashQuad: Mesh;
  private _underWaterEffectQuad: Mesh;
  private _worldTickTimestepS: number = 1 / 60;
  private _worldId: number | null = null;
  private _skyboxIntensity: number = 1;
  private _skyboxMesh: Mesh | null = null;
  private _waterReflectionRenderTarget: WebGLRenderTarget;
  private _waterReflectionCamera: PerspectiveCamera;
  private _waterReflectionTextureMatrix: Matrix4 = new Matrix4();
  private _waterReflectionUpdateCooldownS: number = 0;
  private _waterReflectionPlaneY: number | null = null;
  private _lastWaterReflectionCameraPosition: Vector3 = new Vector3();
  private _lastWaterReflectionViewDir: Vector3 = new Vector3();
  private _activeSkyboxUri: string | null = null;
  private _pendingSkyboxUri: string | null = null;
  private _pendingSkyboxTexture: Promise<CubeTexture> | null = null;
  private _debugVisible: boolean = false;
  private _debugPanel: DebugPanel | null = null;
  private _debugPanelLoadPromise: Promise<DebugPanel | null> | null = null;
  private _effectComposer: EffectComposer;
  private _particlesScene: Scene;
  private _renderPass: RenderPass;
  private _particlesRenderPass: RenderPass;
  private _viewModelRenderPass: RenderPass;
  private _outlinePass: SelectiveOutlinePass;
  private _smaaPass: SMAAPass;
  private _analyticSunHaloPass: AnalyticSunHaloPass;
  private _atmospherePass: AtmosphericScatteringPass;
  private _bloomPass: WhiteCoreBloomPass;
  private _groundedGtaoPass: GroundedGTAOPass;
  private _lutPass: LUTPass;
  private _nearContactShadowsPass: NearContactShadowsPass;
  private _outputPass: OutputPass;
  private _temporalResolvePass: TemporalResolvePass;
  private _sceneUIRenderCooldownRemainingS: number = 0;
  private _adaptiveResolutionScale: number = 1;
  private _adaptiveResolutionDownHoldS: number = 0;
  private _adaptiveResolutionUpHoldS: number = 0;
  private _smoothedFrameDeltaS: number = 1 / 60;
  private _directionalShadowUpdateCooldownS: number = 0;
  private _directionalShadowNeedsUpdate: boolean = true;
  private _directionalShadowInitialized: boolean = false;
  private _directionalShadowContinuousUpdateRemainingS: number = 0;
  private _lastDirectionalShadowCameraPosition: Vector3 = new Vector3();
  private _lastDirectionalShadowFocusCenter: Vector3 = new Vector3();
  private _lastDirectionalShadowSunDirection: Vector3 = new Vector3();
  private _lastDirectionalShadowViewDir: Vector3 = new Vector3();
  private _lastAppliedPixelRatio: number = 0;
  private _lastAppliedViewportWidth: number = 0;
  private _lastAppliedViewportHeight: number = 0;
  private _localReflectionCubeCamera: CubeCamera;
  private _localReflectionCubeRenderTarget: WebGLCubeRenderTarget;
  private _localReflectionEnvironmentRenderTarget: WebGLRenderTarget | null = null;
  private _localReflectionUpdateCooldownS: number = 0;
  private _lastLocalReflectionProbePosition: Vector3 = new Vector3(Number.NaN, Number.NaN, Number.NaN);
  private _lastPostProcessingState: PostProcessingDebugState = {
    atmosphere: false,
    bloom: false,
    composer: false,
    gtao: false,
    lut: false,
    nearContactShadows: false,
    outline: false,
    smaa: false,
    temporalResolve: false,
  };
  private _runtimeTuningOverrides: RendererRuntimeTuningOverrides = {};
  private _temporalJitterIndex: number = 1;

  public constructor(game: Game) {
    this._game = game;

    this._ambientLight = { color: this._baseAmbientLightColor.clone(), intensity: 1 };
    this._ambientSceneLight = new AmbientLight(0xffffff, 1);
    this._ambientViewModelLight = new AmbientLight(0xffffff, 1);
    this._directionalSceneLight = new DirectionalLight(0xffffff, 0);
    this._directionalShadowCascadeNearLight = new DirectionalLight(0xffffff, 0);
    this._directionalShadowCascadeFarLight = new DirectionalLight(0xffffff, 0);
    this._directionalViewModelLight = new DirectionalLight(0xffffff, 0);
    // Anti-aliasing is handled in post-processing
    this._renderer = new WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this._pmremGenerator = new PMREMGenerator(this._renderer);
    this._sceneUiRenderer = new CSS2DRenderer({ element: document.getElementById('scene-ui-container')! });
    this._scene = new Scene();
    this._viewModelScene = new Scene();
    this._overlayScene = new Scene();
    this._uiScene = new Scene();
    this._localReflectionCubeRenderTarget = new WebGLCubeRenderTarget(128, { type: HalfFloatType });
    this._localReflectionCubeCamera = new CubeCamera(
      LOCAL_REFLECTION_PROBE_NEAR,
      LOCAL_REFLECTION_PROBE_FAR,
      this._localReflectionCubeRenderTarget,
    );
    this._waterReflectionRenderTarget = new WebGLRenderTarget(
      WATER_REFLECTION_TEXTURE_SIZE_HIGH,
      WATER_REFLECTION_TEXTURE_SIZE_HIGH,
      { type: HalfFloatType },
    );
    this._waterReflectionCamera = new PerspectiveCamera();
    this._interpolatingFogColor = false;
    this._interpolatingSkyboxColor = false;
    this._lightningFlashQuad = this._createLightningFlashQuad();
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
    this._particlesScene = new Scene();
    this._renderPass = new RenderPass(this._scene, this._game.camera.activeCamera);
    this._particlesRenderPass = new RenderPass(this._particlesScene, this._game.camera.activeCamera);
    this._particlesRenderPass.clear = false;
    this._viewModelRenderPass = new RenderPass(this._viewModelScene, this._game.camera.activeCamera);
    this._viewModelRenderPass.clear = false;
    this._viewModelRenderPass.clearDepth = true;
    this._outlinePass = new SelectiveOutlinePass(
      this._game.camera.activeCamera as never,
      new Vector2(1, 1),
    );
    // Note: Size for Passes are set appropriately when EffectComposer size is set
    this._smaaPass = new SMAAPass();
    this._analyticSunHaloPass = new AnalyticSunHaloPass();
    this._atmospherePass = new AtmosphericScatteringPass();
    this._groundedGtaoPass = new GroundedGTAOPass();
    this._nearContactShadowsPass = new NearContactShadowsPass();
    // Question: Should parameters be configurable?
    this._bloomPass = new WhiteCoreBloomPass(
      vec2,
      0.14, // strength
      0.2,  // radius
      this._calculateBloomThreshold(), // threshold
    );
    this._temporalResolvePass = new TemporalResolvePass();
    this._outputPass = new OutputPass();
    this._lutPass = new LUTPass({
      intensity: 0,
      lut: createCinematicLut(),
    });
    this._lutPass.material.toneMapped = false;
    this._lutPass.material.needsUpdate = true;

    Assets.ktx2Loader.detectSupport(this._renderer);

    this._clampTargetFogNearAndFar();
    this._updateDirectionalShadowContrast();

    this._setupRenderer();
    this._setupSceneUiRenderer();
    this._setupScene();
    this._setupFog();
    this._setupPostProcessing();
    this._setupEventListeners();

    if (game.inDebugMode) {
      void this.toggleDebug();
    }
  }

  public get ambientLight(): AmbientLightData { return this._ambientLight; }
  public get fogColor(): Color { return this._scene.fog ? (this._scene.fog as Fog).color : this._targetFogColor; }
  public get skyColor(): Color {
    if (this._skyboxMesh && isProceduralSkyMaterial(this._skyboxMesh.material)) {
      return this._proceduralSkyColor;
    }

    return this._skyboxMesh ? (this._skyboxMesh.material as SkyboxMaterial).color : this._targetSkyboxColor;
  }
  public get sunDirection(): Vector3 { return this._sunDirection; }
  public get sunLightColor(): Color { return this._directionalSceneLight.color; }
  public get sunLightIntensity(): number { return this._directionalSceneLight.intensity; }
  public get directionalShadowDistance(): number { return this._game.settingsManager.qualityPerfTradeoff.shadows?.directionalDistance ?? 48; }
  public get directionalShadowFocusCenter(): Vector3 { return this._lastDirectionalShadowFocusCenter; }
  public get viewDistance(): number {
    return Math.min(
      this._game.settingsManager.qualityPerfTradeoff.viewDistance.distance,
      this._fogFar + WORLD_FOG_VIEW_DISTANCE_BUFFER,
    );
  }
  public get webGLRenderer(): WebGLRenderer { return this._renderer; }
  public get adaptiveResolutionScale(): number { return this._adaptiveResolutionScale; }
  public get effectivePixelRatio(): number { return this._lastAppliedPixelRatio || this._renderer.getPixelRatio(); }
  public get postProcessingDebugState(): PostProcessingDebugState { return this._lastPostProcessingState; }
  public get runtimeTuningState(): RendererRuntimeTuningState { return this._resolveRuntimeTuningState(); }

  public setRuntimeTuning(overrides: RendererRuntimeTuningOverrides): void {
    const nextOverrides: RendererRuntimeTuningOverrides = { ...this._runtimeTuningOverrides };
    let refreshLocalProbe = false;
    let resetTemporalHistory = false;

    if (overrides.temporalHistoryWeight !== undefined) {
      nextOverrides.temporalHistoryWeight = Math.min(0.98, Math.max(0.5, overrides.temporalHistoryWeight));
      resetTemporalHistory = true;
    }
    if (overrides.temporalSharpenStrength !== undefined) {
      nextOverrides.temporalSharpenStrength = Math.min(0.35, Math.max(0, overrides.temporalSharpenStrength));
      resetTemporalHistory = true;
    }
    if (overrides.lutIntensity !== undefined) {
      nextOverrides.lutIntensity = Math.min(1.5, Math.max(0, overrides.lutIntensity));
    }
    if (overrides.gtaoStrength !== undefined) {
      nextOverrides.gtaoStrength = Math.min(1.0, Math.max(0, overrides.gtaoStrength));
    }
    if (overrides.gtaoWorldRadius !== undefined) {
      nextOverrides.gtaoWorldRadius = Math.min(12, Math.max(0.5, overrides.gtaoWorldRadius));
    }
    if (overrides.gtaoMaxDistance !== undefined) {
      nextOverrides.gtaoMaxDistance = Math.min(160, Math.max(4, overrides.gtaoMaxDistance));
    }
    if (overrides.localReflectionMaxSkyExposure !== undefined) {
      nextOverrides.localReflectionMaxSkyExposure = Math.min(1, Math.max(0, overrides.localReflectionMaxSkyExposure));
      refreshLocalProbe = true;
    }
    if (overrides.localReflectionPositionDelta !== undefined) {
      nextOverrides.localReflectionPositionDelta = Math.min(12, Math.max(0.25, overrides.localReflectionPositionDelta));
      refreshLocalProbe = true;
    }
    if (overrides.localReflectionUpdateIntervalS !== undefined) {
      nextOverrides.localReflectionUpdateIntervalS = Math.min(12, Math.max(0.1, overrides.localReflectionUpdateIntervalS));
      refreshLocalProbe = true;
    }

    this._runtimeTuningOverrides = nextOverrides;

    if (resetTemporalHistory) {
      this._temporalResolvePass.markHistoryInvalid();
      this._temporalJitterIndex = 1;
    }

    if (refreshLocalProbe) {
      this._localReflectionUpdateCooldownS = 0;
      this._lastLocalReflectionProbePosition.set(Number.NaN, Number.NaN, Number.NaN);
    }
  }

  public resetRuntimeTuning(): void {
    this._runtimeTuningOverrides = {};
    this._temporalResolvePass.markHistoryInvalid();
    this._temporalJitterIndex = 1;
    this._localReflectionUpdateCooldownS = 0;
    this._lastLocalReflectionProbePosition.set(Number.NaN, Number.NaN, Number.NaN);
  }

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
    this._effectComposer.addPass(this._groundedGtaoPass);
    this._effectComposer.addPass(this._nearContactShadowsPass);
    this._effectComposer.addPass(this._atmospherePass);
    this._effectComposer.addPass(this._particlesRenderPass);
    this._effectComposer.addPass(this._outlinePass);
    this._effectComposer.addPass(this._analyticSunHaloPass);
    this._effectComposer.addPass(this._viewModelRenderPass);
    this._effectComposer.addPass(this._bloomPass);
    this._effectComposer.addPass(this._temporalResolvePass);
    this._effectComposer.addPass(this._smaaPass);
    this._effectComposer.addPass(this._lutPass);
    this._effectComposer.addPass(this._outputPass);
    this._resizePostProcessing();
  }

  private _supportsLutPass(): boolean {
    return this._renderer.capabilities.isWebGL2;
  }

  private _resizePostProcessing(): void {
    this._effectComposer.setPixelRatio(1);
    this._renderer.getDrawingBufferSize(vec2);
    this._effectComposer.setSize(vec2.width, vec2.height);
    this._bloomPass.setSize(vec2.width >> 2, vec2.height >> 2);
    this._temporalResolvePass.markHistoryInvalid();
  }

  private _resolveRuntimeTuningState(): RendererRuntimeTuningState {
    const postProcessing = this._game.settingsManager.qualityPerfTradeoff.postProcessing;
    const taa = postProcessing?.taa;
    const lut = postProcessing?.lut;
    const gtao = postProcessing?.gtao;
    const localReflections = this._game.settingsManager.qualityPerfTradeoff.localReflections;

    return {
      gtaoMaxDistance: this._runtimeTuningOverrides.gtaoMaxDistance ?? gtao?.maxDistance ?? 52,
      gtaoStrength: this._runtimeTuningOverrides.gtaoStrength ?? gtao?.strength ?? 0.32,
      gtaoWorldRadius: this._runtimeTuningOverrides.gtaoWorldRadius ?? gtao?.worldRadius ?? 4.1,
      localReflectionMaxSkyExposure: this._runtimeTuningOverrides.localReflectionMaxSkyExposure ?? localReflections?.maxSkyExposure ?? 0.18,
      localReflectionPositionDelta: this._runtimeTuningOverrides.localReflectionPositionDelta ?? localReflections?.positionDelta ?? 2.8,
      localReflectionUpdateIntervalS: this._runtimeTuningOverrides.localReflectionUpdateIntervalS ?? localReflections?.updateIntervalS ?? 2.4,
      lutIntensity: this._runtimeTuningOverrides.lutIntensity ?? lut?.intensity ?? 0,
      temporalHistoryWeight: this._runtimeTuningOverrides.temporalHistoryWeight ?? taa?.historyWeight ?? 0.86,
      temporalSharpenStrength: this._runtimeTuningOverrides.temporalSharpenStrength ?? taa?.sharpenStrength ?? 0.08,
    };
  }

  public addToScene(object: Object3D): void {
    this._scene.add(object);
  }

  public addToParticlesScene(object: Object3D): void {
    this._particlesScene.add(object);
  }

  public removeFromScene(object: Object3D): void {
    this._scene.remove(object);
  }

  public removeFromParticlesScene(object: Object3D): void {
    this._particlesScene.remove(object);
  }

  public purgeEntityObjects(entityId: number): number {
    const purgeRoots: Object3D[] = [];
    const collectPurgeRoots = (scene: Scene): void => {
      scene.traverse(object => {
        if (object.userData?.entityId !== entityId) {
          return;
        }

        if (object.parent?.userData?.entityId === entityId) {
          return;
        }

        purgeRoots.push(object);
      });
    };

    collectPurgeRoots(this._scene);
    collectPurgeRoots(this._viewModelScene);

    if (this._firstPersonViewModelEntity?.id === entityId) {
      this._firstPersonViewModelEntity = undefined;
    }

    for (let i = 0; i < purgeRoots.length; i++) {
      purgeRoots[i].removeFromParent();
    }

    return purgeRoots.length;
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

  public async toggleDebug(): Promise<void> {
    const nextVisible = !this._debugVisible;
    this._debugVisible = nextVisible;

    const debugPanel = await this._ensureDebugPanelLoaded();
    if (!debugPanel) {
      this._debugVisible = false;
      return;
    }

    debugPanel.setVisibility(nextVisible);
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
    const gltfUpdateStartMs = performance.now();
    this._game.gltfManager.update();
    this._game.performanceBaselineManager.recordGLTFUpdate(performance.now() - gltfUpdateStartMs);
    this._updateSkybox(frameDeltaS);
    this._game.blockMaterialManager.update();
    this._game.audioManager.update();
    this._updateSceneUI(frameDeltaS);
    this._updateDirectionalLight(frameDeltaS);
    this._updateWaterReflection(frameDeltaS);
    this._updateLocalReflectionProbe(frameDeltaS);

    const activeCamera = this._game.camera.activeCamera;
    const jitterApplied = this._applyTemporalJitter(activeCamera);
    this._updateNearContactShadows();
    this._updateGroundedGtaoPass();
    this._updateAtmospherePass(frameDeltaS);
    this._updateAnalyticSunHaloPass();
    this._updateTemporalResolvePass();

    this._applyUnderWaterEffect();
    this._syncFirstPersonViewModelEntity();

    this._renderer.info.reset();
    const pp = this._game.settingsManager.qualityPerfTradeoff.postProcessing ?? {};
    const runtimeTuning = this._resolveRuntimeTuningState();
    const hasAtmosphere = this._atmospherePass.enabled;
    const hasGroundedGtao = this._groundedGtaoPass.enabled;
    const hasNearContactShadows = this._nearContactShadowsPass.enabled;
    const hasOutlineTargets = !!pp.outline && this._game.entityManager.hasOutlines;
    const hasAnalyticSunHalo = this._analyticSunHaloPass.enabled;
    const hasTemporalResolve = this._temporalResolvePass.enabled;
    const hasLut = !!pp.lut?.enabled
      && runtimeTuning.lutIntensity > 0.001
      && this._supportsLutPass();
    const shouldUsePostProcessing = hasOutlineTargets
      || !!pp.bloom
      || !!pp.smaa
      || hasNearContactShadows
      || hasGroundedGtao
      || hasAtmosphere
      || hasAnalyticSunHalo
      || hasTemporalResolve
      || hasLut;
    this._lastPostProcessingState.composer = shouldUsePostProcessing;
    this._lastPostProcessingState.atmosphere = hasAtmosphere;
    this._lastPostProcessingState.gtao = hasGroundedGtao;
    this._lastPostProcessingState.nearContactShadows = hasNearContactShadows;
    this._lastPostProcessingState.outline = hasOutlineTargets;
    this._lastPostProcessingState.bloom = !!pp.bloom;
    this._lastPostProcessingState.temporalResolve = hasTemporalResolve;
    this._lastPostProcessingState.smaa = !!pp.smaa && !hasTemporalResolve;
    this._lastPostProcessingState.lut = hasLut;
    if (shouldUsePostProcessing) {
      this._renderPass.camera = activeCamera;
      this._particlesRenderPass.camera = activeCamera;
      // Keep the first-person view model out of the full-screen post stack so
      // weapon/hand motion does not pay for bloom/SMAA passes every frame.
      this._viewModelRenderPass.enabled = false;
      this._groundedGtaoPass.enabled = hasGroundedGtao;
      this._nearContactShadowsPass.enabled = hasNearContactShadows;
      this._atmospherePass.enabled = hasAtmosphere;
      this._particlesRenderPass.enabled = this._particlesScene.children.length > 0;
      this._outlinePass.enabled = hasOutlineTargets;
      this._analyticSunHaloPass.enabled = hasAnalyticSunHalo;
      this._bloomPass.enabled = !!pp.bloom;
      this._temporalResolvePass.enabled = hasTemporalResolve;
      this._smaaPass.enabled = !!pp.smaa && !hasTemporalResolve;
      this._lutPass.enabled = hasLut;
      this._lutPass.intensity = runtimeTuning.lutIntensity;
      if (hasOutlineTargets) {
        this._outlinePass.camera = activeCamera as never;
        this._outlinePass.setOutlineTargets(this._game.entityManager.getOutlineTargets());
      } else {
        this._outlinePass.clearOutlineTargets();
      }
      try {
        this._effectComposer.render();
      } finally {
        if (jitterApplied) {
          this._clearTemporalJitter(activeCamera);
        }
      }
      if (hasOutlineTargets) {
        this._game.entityManager.clearOutlineTargets();
        this._outlinePass.clearOutlineTargets();
      }
      this._renderFirstPersonViewModel();
    } else {
      this._temporalResolvePass.markHistoryInvalid();
      try {
        this._renderer.render(this._scene, activeCamera);
        if (this._particlesScene.children.length > 0) {
          const previousAutoClear = this._renderer.autoClear;
          try {
            this._renderer.autoClear = false;
            this._renderer.render(this._particlesScene, activeCamera);
          } finally {
            this._renderer.autoClear = previousAutoClear;
          }
        }
      } finally {
        if (jitterApplied) {
          this._clearTemporalJitter(activeCamera);
        }
      }
      this._renderFirstPersonViewModel();
    }
    this._renderScreenOverlays();

    this._debugPanel?.update();
  }

  private async _ensureDebugPanelLoaded(): Promise<DebugPanel | null> {
    if (this._debugPanel) {
      return this._debugPanel;
    }

    if (!this._debugPanelLoadPromise) {
      this._debugPanelLoadPromise = import('./DebugPanel')
        .then(({ default: DebugPanel }) => {
          this._debugPanel = new DebugPanel(this._game);
          return this._debugPanel;
        })
        .catch((error) => {
          console.error('Renderer: Failed to load debug panel.', error);
          return null;
        })
        .finally(() => {
          this._debugPanelLoadPromise = null;
        });
    }

    return this._debugPanelLoadPromise;
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

  private _setBaseEnvironmentTexture(texture: Texture | null): void {
    if (this._baseEnvironmentTexture === texture) {
      return;
    }
    this._baseEnvironmentTexture = texture;
    this._temporalResolvePass.markHistoryInvalid();
    this._updateSceneEnvironmentTexture();
  }

  private _setEnvironmentOverrideTexture(texture: Texture | null): void {
    if (this._environmentOverrideTexture === texture) {
      return;
    }
    this._environmentOverrideTexture = texture;
    this._temporalResolvePass.markHistoryInvalid();
    this._updateSceneEnvironmentTexture();
  }

  private _updateSceneEnvironmentTexture(): void {
    const environmentTexture = this._environmentOverrideTexture ?? this._baseEnvironmentTexture;
    this._scene.environment = environmentTexture;
    this._viewModelScene.environment = environmentTexture;
  }

  private _disposeSkyVisuals(): void {
    this._activeSkyboxUri = null;
    this._pendingSkyboxUri = null;
    this._pendingSkyboxTexture = null;
    this._setEnvironmentOverrideTexture(null);
    this._setBaseEnvironmentTexture(null);
    this._disposeProceduralSkyEnvironment();

    if (this._skyboxMesh) {
      this._scene.remove(this._skyboxMesh);
      this._skyboxMesh.geometry.dispose();

      const material = this._skyboxMesh.material as SkyboxMaterial | ProceduralSkyMaterial;
      if (material instanceof SkyboxMaterial) {
        material.map.dispose();
      }
      material.dispose();
      this._skyboxMesh = null;
    }

    if (this._proceduralSunMesh) {
      this._scene.remove(this._proceduralSunMesh);
      this._proceduralSunMesh.geometry.dispose();
      (this._proceduralSunMesh.material as SquareSunMaterial).dispose();
      this._proceduralSunMesh = null;
    }

    if (this._proceduralMoonMesh) {
      this._scene.remove(this._proceduralMoonMesh);
      this._proceduralMoonMesh.geometry.dispose();
      (this._proceduralMoonMesh.material as SquareSunMaterial).dispose();
      this._proceduralMoonMesh = null;
    }

    if (this._proceduralPrecipitation) {
      this._scene.remove(this._proceduralPrecipitation.mesh);
      this._proceduralPrecipitation.dispose();
      this._proceduralPrecipitation = null;
    }

    if (this._proceduralSurfaceImpacts) {
      this._scene.remove(this._proceduralSurfaceImpacts.mesh);
      this._proceduralSurfaceImpacts.dispose();
      this._proceduralSurfaceImpacts = null;
    }

    this._proceduralSkySettings = null;
    this._proceduralSkyTargetSettings = null;
    this._updateLightningFlash(0);
    this._applyDynamicLighting(0);
  }

  private _disposeProceduralSkyEnvironment(): void {
    if (this._proceduralSkyEnvironmentSkyMesh) {
      this._proceduralSkyEnvironmentSkyMesh.geometry.dispose();
      (this._proceduralSkyEnvironmentSkyMesh.material as ProceduralSkyMaterial).dispose();
      this._proceduralSkyEnvironmentSkyMesh = null;
    }

    if (this._proceduralSkyEnvironmentSunMesh) {
      this._proceduralSkyEnvironmentSunMesh.geometry.dispose();
      (this._proceduralSkyEnvironmentSunMesh.material as SquareSunMaterial).dispose();
      this._proceduralSkyEnvironmentSunMesh = null;
    }

    if (this._proceduralSkyEnvironmentMoonMesh) {
      this._proceduralSkyEnvironmentMoonMesh.geometry.dispose();
      (this._proceduralSkyEnvironmentMoonMesh.material as SquareSunMaterial).dispose();
      this._proceduralSkyEnvironmentMoonMesh = null;
    }

    if (this._proceduralSkyEnvironmentRenderTarget) {
      this._proceduralSkyEnvironmentRenderTarget.dispose();
      this._proceduralSkyEnvironmentRenderTarget = null;
    }

    this._proceduralSkyEnvironmentScene = null;
    this._proceduralSkyEnvironmentUpdateCooldownS = 0;
  }

  private _setupProceduralSkyEnvironment(settings: ProceduralSkySettings): void {
    this._disposeProceduralSkyEnvironment();

    // Mobile Safari/WebKit can intermittently black-frame while the procedural
    // sky PMREM capture updates. Keep the visible sky, but skip the dynamic
    // environment capture path on mobile.
    if (MobileManager.isMobile) {
      return;
    }

    this._proceduralSkyEnvironmentScene = new Scene();
    this._proceduralSkyEnvironmentScene.matrixAutoUpdate = false;
    this._proceduralSkyEnvironmentScene.matrixWorldAutoUpdate = false;

    this._proceduralSkyEnvironmentSkyMesh = new Mesh(
      new BoxGeometry(PROCEDURAL_SKY_ENVIRONMENT_BOX_SIZE, PROCEDURAL_SKY_ENVIRONMENT_BOX_SIZE, PROCEDURAL_SKY_ENVIRONMENT_BOX_SIZE),
      new ProceduralSkyMaterial(settings),
    );
    (this._proceduralSkyEnvironmentSkyMesh.material as ProceduralSkyMaterial).worldSeed = this._proceduralSkyWorldSeed;
    this._proceduralSkyEnvironmentSkyMesh.frustumCulled = false;
    this._proceduralSkyEnvironmentSkyMesh.matrixAutoUpdate = false;
    this._proceduralSkyEnvironmentSkyMesh.matrixWorldAutoUpdate = false;
    this._proceduralSkyEnvironmentSkyMesh.updateMatrix();
    this._proceduralSkyEnvironmentSkyMesh.matrixWorld.copy(this._proceduralSkyEnvironmentSkyMesh.matrix);
    this._proceduralSkyEnvironmentScene.add(this._proceduralSkyEnvironmentSkyMesh);

    this._proceduralSkyEnvironmentSunMesh = new Mesh(new PlaneGeometry(1, 1), new SquareSunMaterial());
    this._proceduralSkyEnvironmentSunMesh.frustumCulled = false;
    this._proceduralSkyEnvironmentSunMesh.matrixAutoUpdate = false;
    this._proceduralSkyEnvironmentSunMesh.matrixWorldAutoUpdate = false;
    this._proceduralSkyEnvironmentScene.add(this._proceduralSkyEnvironmentSunMesh);

    this._proceduralSkyEnvironmentMoonMesh = new Mesh(new PlaneGeometry(1, 1), new SquareSunMaterial());
    this._proceduralSkyEnvironmentMoonMesh.frustumCulled = false;
    this._proceduralSkyEnvironmentMoonMesh.matrixAutoUpdate = false;
    this._proceduralSkyEnvironmentMoonMesh.matrixWorldAutoUpdate = false;
    this._proceduralSkyEnvironmentScene.add(this._proceduralSkyEnvironmentMoonMesh);

    this._proceduralSkyEnvironmentUpdateCooldownS = 0;
  }

  private _getProceduralSkyEnvironmentUpdateInterval(): number {
    if (!this._proceduralSkySettings || !this._proceduralSkyTargetSettings) {
      return PROCEDURAL_SKY_ENVIRONMENT_BASE_UPDATE_INTERVAL_S;
    }

    const current = this._proceduralSkySettings;
    const target = this._proceduralSkyTargetSettings;
    const settingsDelta =
      Math.abs(current.cloudCoverage - target.cloudCoverage) +
      Math.abs(current.cloudOpacity - target.cloudOpacity) +
      Math.abs(current.cloudScale - target.cloudScale) +
      Math.abs(current.cloudSpeed - target.cloudSpeed) +
      Math.abs(current.precipitationIntensity - target.precipitationIntensity) +
      Math.abs(current.storminess - target.storminess) +
      current.windDirection.distanceTo(target.windDirection);

    const transitioning = this._interpolatingFogColor
      || current.precipitation !== target.precipitation
      || settingsDelta > 0.02;

    return transitioning
      ? PROCEDURAL_SKY_ENVIRONMENT_TRANSITION_UPDATE_INTERVAL_S
      : PROCEDURAL_SKY_ENVIRONMENT_BASE_UPDATE_INTERVAL_S;
  }

  private _renderProceduralSkyEnvironment(): void {
    if (!this._proceduralSkyEnvironmentScene) {
      return;
    }

    const previousRenderTarget = this._proceduralSkyEnvironmentRenderTarget;
    const nextRenderTarget = this._pmremGenerator.fromScene(
      this._proceduralSkyEnvironmentScene,
      0,
      PROCEDURAL_SKY_ENVIRONMENT_NEAR,
      PROCEDURAL_SKY_ENVIRONMENT_FAR,
      { position: WORLD_ORIGIN, size: PROCEDURAL_SKY_ENVIRONMENT_SIZE },
    );

    this._proceduralSkyEnvironmentRenderTarget = nextRenderTarget;
    this._setBaseEnvironmentTexture(nextRenderTarget.texture);

    if (previousRenderTarget && previousRenderTarget !== nextRenderTarget) {
      previousRenderTarget.dispose();
    }
  }

  private _updateProceduralSkyEnvironment(frameDeltaS: number): void {
    if (
      !this._skyboxMesh
      || !isProceduralSkyMaterial(this._skyboxMesh.material)
      || !this._proceduralSkySettings
      || !this._proceduralSkyEnvironmentSkyMesh
      || !this._proceduralSkyEnvironmentSunMesh
      || !this._proceduralSkyEnvironmentMoonMesh
    ) {
      return;
    }

    this._proceduralSkyEnvironmentUpdateCooldownS = Math.max(0, this._proceduralSkyEnvironmentUpdateCooldownS - frameDeltaS);
    if (this._proceduralSkyEnvironmentUpdateCooldownS > 0) {
      return;
    }

    const sourceMaterial = this._skyboxMesh.material;
    const environmentMaterial = this._proceduralSkyEnvironmentSkyMesh.material as ProceduralSkyMaterial;
    environmentMaterial.time = this._proceduralSkyTimeS;
    environmentMaterial.worldSeed = this._proceduralSkyWorldSeed;
    environmentMaterial.fogColor.copy(sourceMaterial.fogColor).multiplyScalar(0.76);
    environmentMaterial.sunColor.copy(sourceMaterial.sunColor);
    environmentMaterial.sunDirection.copy(sourceMaterial.sunDirection);
    // Keep lightning out of the captured environment to avoid visible reflection popping.
    environmentMaterial.lightning = 0;
    environmentMaterial.skyIntensity = Math.max(0.08, this._skyboxIntensity * 0.62);
    environmentMaterial.cloudCoverage = this._proceduralSkySettings.cloudCoverage;
    environmentMaterial.cloudOpacity = this._proceduralSkySettings.cloudOpacity;
    environmentMaterial.cloudScale = this._proceduralSkySettings.cloudScale;
    environmentMaterial.cloudSpeed = this._proceduralSkySettings.cloudSpeed;
    environmentMaterial.storminess = this._proceduralSkySettings.storminess;
    environmentMaterial.windDirection.copy(this._proceduralSkySettings.windDirection);

    const sunViewDirection = vec3d.copy(sourceMaterial.sunDirection).negate();
    const sunMaterial = this._proceduralSkyEnvironmentSunMesh.material as SquareSunMaterial;
    const dayAmount = Math.max(0, Math.min(1, (sunViewDirection.y + 0.1) / 0.24)) * (1 - this._proceduralSkySettings.storminess * 0.65);
    const sunSize = (260 + (1 - Math.max(0, sunViewDirection.y)) * 60) * PROCEDURAL_SKY_ENVIRONMENT_SUN_SIZE_RATIO;
    sunMaterial.dayAmount = dayAmount;
    sunMaterial.haloAmount = 0.16 - this._proceduralSkySettings.storminess * 0.05;
    sunMaterial.sunColor.setRGB(1.0, 0.97, 0.92);
    sunMaterial.sunIntensity = Math.max(0.56, Math.min(this._directionalSceneLight.intensity * 0.2 + 0.04, 0.84));
    this._proceduralSkyEnvironmentSunMesh.visible = dayAmount > 0.001;
    if (this._proceduralSkyEnvironmentSunMesh.visible) {
      this._proceduralSkyEnvironmentSunMesh.position.copy(sunViewDirection).multiplyScalar(PROCEDURAL_SKY_ENVIRONMENT_SUN_DISTANCE);
      this._proceduralSkyEnvironmentSunMesh.lookAt(WORLD_ORIGIN);
      this._proceduralSkyEnvironmentSunMesh.scale.set(sunSize, sunSize, 1);
      this._proceduralSkyEnvironmentSunMesh.updateMatrix();
      this._proceduralSkyEnvironmentSunMesh.matrixWorld.copy(this._proceduralSkyEnvironmentSunMesh.matrix);
    }

    const moonViewDirection = vec3e.copy(sunViewDirection).negate();
    const moonMaterial = this._proceduralSkyEnvironmentMoonMesh.material as SquareSunMaterial;
    const moonAmount = Math.max(0, Math.min(1, (moonViewDirection.y + 0.1) / 0.32)) * (1 - this._proceduralSkySettings.storminess * 0.5);
    const moonSize = (120 + moonAmount * 24) * PROCEDURAL_SKY_ENVIRONMENT_MOON_SIZE_RATIO;
    moonMaterial.dayAmount = moonAmount;
    moonMaterial.haloAmount = 0.62;
    moonMaterial.sunColor.setRGB(0.86, 0.90, 1.0);
    moonMaterial.sunIntensity = 2.4;
    this._proceduralSkyEnvironmentMoonMesh.visible = moonAmount > 0.001;
    if (this._proceduralSkyEnvironmentMoonMesh.visible) {
      this._proceduralSkyEnvironmentMoonMesh.position.copy(moonViewDirection).multiplyScalar(PROCEDURAL_SKY_ENVIRONMENT_MOON_DISTANCE);
      this._proceduralSkyEnvironmentMoonMesh.lookAt(WORLD_ORIGIN);
      this._proceduralSkyEnvironmentMoonMesh.scale.set(moonSize, moonSize, 1);
      this._proceduralSkyEnvironmentMoonMesh.updateMatrix();
      this._proceduralSkyEnvironmentMoonMesh.matrixWorld.copy(this._proceduralSkyEnvironmentMoonMesh.matrix);
    }

    this._renderProceduralSkyEnvironment();
    this._proceduralSkyEnvironmentUpdateCooldownS = this._getProceduralSkyEnvironmentUpdateInterval();
  }

  private _applyDynamicLighting(lightningIntensity: number): void {
    const flashIntensity = Math.max(0, Math.min(1, lightningIntensity));
    const ambientSourceColor = color.copy(this._baseAmbientLightColor).lerp(LIGHTNING_FLASH_COLOR, flashIntensity * 0.28);
    const directionalSourceColor = colorb.copy(this._baseDirectionalLightColor).lerp(LIGHTNING_FLASH_COLOR, flashIntensity * 0.4);
    const ambientIntensity = (this._baseAmbientLightIntensity + flashIntensity * 0.72) * getColorBrightness(ambientSourceColor);
    const directionalIntensity = (this._baseDirectionalLightIntensity + flashIntensity * 1.1) * getColorBrightness(directionalSourceColor);

    this._environmentAmbientLightColor.copy(ambientSourceColor);
    this._environmentDirectionalLightColor.copy(directionalSourceColor);
    this._ambientLight.color.copy(NEUTRAL_LIGHT_COLOR);
    this._ambientLight.intensity = ambientIntensity;
    this._ambientSceneLight.color.copy(this._ambientLight.color);
    this._ambientViewModelLight.color.copy(this._ambientLight.color);
    this._ambientSceneLight.intensity = this._ambientLight.intensity;
    this._ambientViewModelLight.intensity = this._ambientLight.intensity;

    this._directionalSceneLight.color.copy(NEUTRAL_LIGHT_COLOR);
    this._directionalShadowCascadeNearLight.color.copy(this._directionalSceneLight.color);
    this._directionalShadowCascadeFarLight.color.copy(this._directionalSceneLight.color);
    this._directionalViewModelLight.color.copy(this._directionalSceneLight.color);

    this._directionalSceneLight.intensity = directionalIntensity;
    // Keep cascades shadow-only. The visible sun light remains the single direct
    // lighting source, and the material shader remaps the two shadow maps onto it.
    this._directionalShadowCascadeNearLight.intensity = 0;
    this._directionalShadowCascadeFarLight.intensity = 0;
    this._directionalViewModelLight.intensity = directionalIntensity;

    this._renderer.toneMappingExposure = COLOR_PRESERVING_TONE_MAPPING_EXPOSURE;
  }

  private _updateLightningFlash(lightningIntensity: number): void {
    const flashIntensity = Math.max(0, Math.min(1, lightningIntensity));
    if (flashIntensity <= 0.001) {
      this._lightningFlashQuad.visible = false;
      return;
    }

    const material = this._lightningFlashQuad.material as MeshBasicMaterial;
    const activeCamera = this._game.camera.activeCamera;
    material.color.copy(LIGHTNING_FLASH_COLOR);
    material.opacity = flashIntensity * 0.26;
    this._lightningFlashQuad.matrixWorld.multiplyMatrices(activeCamera.matrixWorld, this._lightningFlashQuad.matrix);
    this._lightningFlashQuad.visible = true;
  }

  private _loadProceduralSky(skyboxUri: string): void {
    if (this._activeSkyboxUri === skyboxUri) {
      this._pendingSkyboxTexture = null;
      this._pendingSkyboxUri = null;
      return;
    }

    const parsedSkySettings = parseProceduralSkySettings(skyboxUri);
    const skySettings = parsedSkySettings ? cloneProceduralSkySettings(parsedSkySettings) : null;
    if (!skySettings) {
      return;
    }

    this._pendingSkyboxTexture = null;
    this._pendingSkyboxUri = null;

    if (
      this._skyboxMesh
      && isProceduralSkyMaterial(this._skyboxMesh.material)
      && this._proceduralSunMesh
      && this._proceduralPrecipitation
      && this._proceduralSurfaceImpacts
      && this._proceduralSkySettings
    ) {
      this._proceduralSkyTargetSettings = skySettings;
      this._activeSkyboxUri = skyboxUri;
      if (!this._proceduralSkyEnvironmentScene) {
        this._setupProceduralSkyEnvironment(this._proceduralSkySettings);
      }
      return;
    }

    this._disposeSkyVisuals();
    this._proceduralSkySettings = cloneProceduralSkySettings(skySettings);
    this._proceduralSkyTargetSettings = skySettings;

    this._skyboxMesh = new Mesh(new BoxGeometry(1, 1, 1), new ProceduralSkyMaterial(skySettings));
    (this._skyboxMesh.material as ProceduralSkyMaterial).worldSeed = this._proceduralSkyWorldSeed;
    this._skyboxMesh.renderOrder = -1000;
    this._skyboxMesh.frustumCulled = false;
    this._skyboxMesh.matrixAutoUpdate = false;
    this._skyboxMesh.matrixWorldAutoUpdate = false;
    this._scene.add(this._skyboxMesh);

    this._proceduralSunMesh = new Mesh(new PlaneGeometry(1, 1), new SquareSunMaterial());
    this._proceduralSunMesh.renderOrder = -999;
    this._proceduralSunMesh.frustumCulled = false;
    this._proceduralSunMesh.matrixAutoUpdate = false;
    this._proceduralSunMesh.matrixWorldAutoUpdate = false;
    this._scene.add(this._proceduralSunMesh);

    this._proceduralMoonMesh = new Mesh(new PlaneGeometry(1, 1), new SquareSunMaterial());
    this._proceduralMoonMesh.renderOrder = -998;
    this._proceduralMoonMesh.frustumCulled = false;
    this._proceduralMoonMesh.matrixAutoUpdate = false;
    this._proceduralMoonMesh.matrixWorldAutoUpdate = false;
    this._scene.add(this._proceduralMoonMesh);

    this._proceduralPrecipitation = new WeatherPrecipitationSystem();
    this._scene.add(this._proceduralPrecipitation.mesh);

    this._proceduralSurfaceImpacts = new WeatherSurfaceImpactSystem();
    this._scene.add(this._proceduralSurfaceImpacts.mesh);

    this._setupProceduralSkyEnvironment(skySettings);
    this._activeSkyboxUri = skyboxUri;
    this._proceduralSkyColor.copy(this._targetSkyboxColor);
    this._interpolatingSkyboxColor = false;
    this._updateProceduralSky(0);
  }

  private async _loadSkybox(skyboxUri: string): Promise<void> {
    if (skyboxUri === this._activeSkyboxUri) {
      this._pendingSkyboxTexture = null;
      this._pendingSkyboxUri = null;
      return;
    }

    if (skyboxUri === this._pendingSkyboxUri) {
      return;
    }

    if (parseProceduralSkySettings(skyboxUri)) {
      this._loadProceduralSky(skyboxUri);
      return;
    }

    const pendingSkyboxTexture = this._loadSkyboxTexture(Assets.toAssetUri(skyboxUri));
    this._pendingSkyboxUri = skyboxUri;
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
    if (this._pendingSkyboxTexture !== pendingSkyboxTexture || this._pendingSkyboxUri !== skyboxUri) {
      return;
    }

    // Question: Should we throw before the check above?
    if (!skyboxTexture) {
      throw new Error(`Failed to load ${skyboxUri} and Missing Skybox texture.`);
    }

    this._pendingSkyboxTexture = null;
    this._pendingSkyboxUri = null;

    this._disposeSkyVisuals();

    // Create skybox mesh
    this._skyboxMesh = new Mesh(new BoxGeometry(1, 1, 1), new SkyboxMaterial(skyboxTexture));
    this._skyboxMesh.renderOrder = -1000;
    this._skyboxMesh.frustumCulled = false;
    this._skyboxMesh.matrixAutoUpdate = false;
    this._skyboxMesh.matrixWorldAutoUpdate = false;

    this._scene.add(this._skyboxMesh);
    this._setBaseEnvironmentTexture(skyboxTexture);
    this._activeSkyboxUri = skyboxUri;

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

    if (this._worldId !== deserializedWorld.id) {
      this._worldId = deserializedWorld.id;
      this._skySunDirection = null;
    }

    if (deserializedWorld.timestep !== undefined) {
      this._worldTickTimestepS = deserializedWorld.timestep;
    }

    this._proceduralSkyWorldSeed = deserializedWorld.id * 0.731 + 1;
    this._proceduralSkyTimeS = payload.serverTick * this._worldTickTimestepS;

    if (this._skyboxMesh && isProceduralSkyMaterial(this._skyboxMesh.material)) {
      this._skyboxMesh.material.worldSeed = this._proceduralSkyWorldSeed;
    }

    if (deserializedWorld.ambientLightColor) {
      // Colors from protocol are authored as sRGB; convert once for correct linear lighting math.
      color.copy(deserializedWorld.ambientLightColor).convertSRGBToLinear();
      if (!this._baseAmbientLightColor.equals(color)) {
        this._baseAmbientLightColor.copy(color);
        needsTargetColorsUpdate = true;
      }
    }

    if (deserializedWorld.ambientLightIntensity !== undefined) {
      if (!isApproximatelyEqual(this._baseAmbientLightIntensity, deserializedWorld.ambientLightIntensity)) {
        this._baseAmbientLightIntensity = deserializedWorld.ambientLightIntensity;
        // Update bloom threshold dynamically based on ambient light intensity
        // Formula: ambientLightIntensity + 0.01 (accounting for smoothWidth=0.01)
        // This ensures white colors lit by ambient light don't trigger bloom
        this._bloomPass.threshold = this._calculateBloomThreshold();
      }
    }

    if (deserializedWorld.directionalLightColor) {
      color.copy(deserializedWorld.directionalLightColor).convertSRGBToLinear();
      if (!this._baseDirectionalLightColor.equals(color)) {
        this._baseDirectionalLightColor.copy(color);
      }
    }

    if (deserializedWorld.directionalLightIntensity !== undefined) {
      if (!isApproximatelyEqual(this._baseDirectionalLightIntensity, deserializedWorld.directionalLightIntensity)) {
        this._baseDirectionalLightIntensity = deserializedWorld.directionalLightIntensity;
        this._bloomPass.threshold = this._calculateBloomThreshold();
      }
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

    if (deserializedWorld.skySunDirection !== undefined) {
      if (deserializedWorld.skySunDirection === null) {
        if (this._skySunDirection !== null) {
          this._skySunDirection = null;
        }
      } else {
        vec3.set(
          deserializedWorld.skySunDirection.x,
          deserializedWorld.skySunDirection.y,
          deserializedWorld.skySunDirection.z,
        );
        if (vec3.lengthSq() > 0.0001) {
          vec3.normalize();
          if (this._skySunDirection === null) {
            this._skySunDirection = new Vector3();
            this._skySunDirection.copy(vec3);
          } else if (this._skySunDirection.distanceToSquared(vec3) > DIRECTIONAL_LIGHT_SHADOW_STABILIZATION_EPSILON_SQ) {
            this._skySunDirection.copy(vec3);
          }
        }
      }
    }

    if (deserializedWorld.fogColor !== undefined) {
      // Ensure fog color is in linear color space for proper rendering
      if (deserializedWorld.fogColor) {
        color.copy(deserializedWorld.fogColor).convertSRGBToLinear();
        if (this._fogColor === null) {
          this._fogColor = new Color().copy(color);
          needsTargetColorsUpdate = true;
        } else if (!this._fogColor.equals(color)) {
          this._fogColor.copy(color);
          needsTargetColorsUpdate = true;
        }
      } else {
        if (this._fogColor !== null) {
          this._fogColor = null;
          needsTargetColorsUpdate = true;
        }
      }
    }

    if (deserializedWorld.fogFar !== undefined) {
      this._fogFar = deserializedWorld.fogFar;
    }

    if (deserializedWorld.fogNear !== undefined) {
      this._fogNear = deserializedWorld.fogNear;
    }

    this._clampTargetFogNearAndFar();

    if (deserializedWorld.skyboxUri) {
      void this._loadSkybox(deserializedWorld.skyboxUri);
    }

    if (deserializedWorld.skyboxIntensity !== undefined) {
      if (!isApproximatelyEqual(this._skyboxIntensity, deserializedWorld.skyboxIntensity)) {
        this._skyboxIntensity = deserializedWorld.skyboxIntensity;
        needsTargetColorsUpdate = true;
      }
    }

    if (needsTargetColorsUpdate) {
      if (this._fogColor === null) {
        // Ambient light color is already stored in linear space.
        this._targetFogColor.copy(this._baseAmbientLightColor);
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

    this._applyDynamicLighting(0);
  }

  private _updateProceduralSky(frameDeltaS: number): void {
    if (
      !this._skyboxMesh
      || !isProceduralSkyMaterial(this._skyboxMesh.material)
      || !this._proceduralSkySettings
      || !this._proceduralSkyTargetSettings
    ) {
      return;
    }

    const material = this._skyboxMesh.material;
    const fogColor = this._scene.fog ? (this._scene.fog as Fog).color : this._targetFogColor;

    this._proceduralSkyTimeS += frameDeltaS;
    const settingsBlendAlpha = frameDeltaS <= 0 ? 1 : 1 - Math.exp(-frameDeltaS * PROCEDURAL_SKY_SETTINGS_BLEND_SPEED);

    blendProceduralSkySettings(this._proceduralSkySettings, this._proceduralSkyTargetSettings, settingsBlendAlpha);

    const lightningIntensity = getStormLightningIntensity(
      this._proceduralSkyTimeS,
      this._proceduralSkyWorldSeed,
      this._proceduralSkySettings.storminess,
    );

    this._applyDynamicLighting(lightningIntensity);
    this._updateLightningFlash(lightningIntensity);

    material.time = this._proceduralSkyTimeS;
    material.fogColor.copy(fogColor);
    material.sunColor.copy(this._environmentDirectionalLightColor);
    const skySunDirection = this._skySunDirection ?? this._sunDirection;
    material.sunDirection.copy(skySunDirection);
    material.lightning = lightningIntensity;
    material.skyIntensity = this._skyboxIntensity;
    material.cloudCoverage = this._proceduralSkySettings.cloudCoverage;
    material.cloudOpacity = this._proceduralSkySettings.cloudOpacity;
    material.cloudScale = this._proceduralSkySettings.cloudScale;
    material.cloudSpeed = this._proceduralSkySettings.cloudSpeed;
    material.storminess = this._proceduralSkySettings.storminess;
    material.windDirection.copy(this._proceduralSkySettings.windDirection);

    color.copy(this._environmentAmbientLightColor).multiplyScalar(this._ambientLight.intensity);
    this._proceduralSkyColor.copy(fogColor).lerp(color, 0.18);
    this._proceduralSkyColor.multiplyScalar(Math.max(0.06, this._skyboxIntensity * 0.72));

    const cameraPosition = vec3.setFromMatrixPosition(this._game.camera.activeCamera.matrixWorld);
    this._skyboxMesh.position.copy(cameraPosition);
    this._skyboxMesh.updateMatrix();
    this._skyboxMesh.matrixWorld.copy(this._skyboxMesh.matrix);

    if (!this._proceduralSunMesh) {
      return;
    }

    const sunViewDirection = vec3b.copy(skySunDirection).negate();
    const sunMaterial = this._proceduralSunMesh.material as SquareSunMaterial;
    const dayAmount = Math.max(0, Math.min(1, (sunViewDirection.y + 0.1) / 0.24)) * (1 - this._proceduralSkySettings.storminess * 0.65);
    const sunDistance = 880;
    const sunSize = 260 + (1 - Math.max(0, sunViewDirection.y)) * 60;

    sunMaterial.dayAmount = dayAmount;
    sunMaterial.haloAmount = 0.3 - this._proceduralSkySettings.storminess * 0.09;
    sunMaterial.sunColor.setRGB(1.0, 0.97, 0.92);
    sunMaterial.sunIntensity = Math.max(1.02, Math.min(this._directionalSceneLight.intensity * 0.4 + 0.18, 1.55));

    this._proceduralSunMesh.visible = dayAmount > 0.001;
    if (this._proceduralSunMesh.visible) {
      this._proceduralSunMesh.position.copy(cameraPosition).addScaledVector(sunViewDirection, sunDistance);
      this._proceduralSunMesh.quaternion.copy(this._game.camera.activeCamera.quaternion);
      this._proceduralSunMesh.scale.set(sunSize, sunSize, 1);
      this._proceduralSunMesh.updateMatrix();
      this._proceduralSunMesh.matrixWorld.copy(this._proceduralSunMesh.matrix);
    }

    if (this._proceduralMoonMesh) {
      const moonViewDirection = vec3c.copy(sunViewDirection).negate();
      const moonMaterial = this._proceduralMoonMesh.material as SquareSunMaterial;
      const moonAmount = Math.max(0, Math.min(1, (moonViewDirection.y + 0.1) / 0.32)) * (1 - this._proceduralSkySettings.storminess * 0.5);
      const moonDistance = 840;
      const moonSize = 120 + moonAmount * 24;

      moonMaterial.dayAmount = moonAmount;
      moonMaterial.haloAmount = 0.62;
      moonMaterial.sunColor.setRGB(0.86, 0.90, 1.0);
      moonMaterial.sunIntensity = 2.4;

      this._proceduralMoonMesh.visible = moonAmount > 0.001;
      if (this._proceduralMoonMesh.visible) {
        this._proceduralMoonMesh.position.copy(cameraPosition).addScaledVector(moonViewDirection, moonDistance);
        this._proceduralMoonMesh.quaternion.copy(this._game.camera.activeCamera.quaternion);
        this._proceduralMoonMesh.scale.set(moonSize, moonSize, 1);
        this._proceduralMoonMesh.updateMatrix();
        this._proceduralMoonMesh.matrixWorld.copy(this._proceduralMoonMesh.matrix);
      }
    }

    this._updateProceduralSkyEnvironment(frameDeltaS);

    if (!this._proceduralPrecipitation || !this._proceduralSurfaceImpacts) {
      return;
    }

    const environmentalAnimationsEnabled = this._game.settingsManager.qualityPerfTradeoff.environmentalAnimations?.enabled !== false;
    const precipitationEnabled = environmentalAnimationsEnabled && this._proceduralSkySettings.precipitation !== 'none';
    let precipitationIntensity = 0;

    if (precipitationEnabled && !this._game.chunkManager.inLiquidBlock(cameraPosition)) {
      vec3d.copy(cameraPosition).addScaledVector(WORLD_UP, 2);
      Chunk.worldPositionToGlobalCoordinate(vec3d, vec3e);
      const openSkyAmount = this._game.skyDistanceVolumeManager.getSkyLightBrightnessByGlobalCoordinate(vec3e);
      const exposedSkyAmount = Math.max(0, Math.min(1, (openSkyAmount - 0.36) / 0.64));
      precipitationIntensity = this._proceduralSkySettings.precipitationIntensity * exposedSkyAmount * (0.45 + this._proceduralSkySettings.storminess * 0.55);
    }

    color.copy(fogColor).lerp(this._environmentAmbientLightColor, 0.48).multiplyScalar(1.08);
    this._proceduralPrecipitation.update(
      cameraPosition,
      this._game.camera.activeCamera.quaternion,
      this._proceduralSkyTimeS,
      this._proceduralSkySettings.windDirection,
      color,
      precipitationIntensity,
      lightningIntensity,
      this._proceduralSkySettings.precipitation,
    );

    this._proceduralSurfaceImpacts.update(
      frameDeltaS,
      this._proceduralSkySettings.precipitation,
      precipitationIntensity,
      (sampleRadius) => this._sampleWeatherSurfaceImpact(cameraPosition, sampleRadius, this._proceduralSkySettings!.precipitation),
    );
  }

  private _sampleWeatherSurfaceImpact(
    cameraPosition: Vector3,
    sampleRadius: number,
    precipitation: ProceduralSkyPrecipitation,
  ): { x: number; y: number; z: number } | null {
    const scanStartY = Math.floor(cameraPosition.y) + WEATHER_SURFACE_IMPACT_SCAN_ABOVE;
    const scanEndY = Math.floor(cameraPosition.y) - WEATHER_SURFACE_IMPACT_SCAN_BELOW;

    for (let attempt = 0; attempt < WEATHER_SURFACE_IMPACT_SAMPLE_ATTEMPTS; attempt++) {
      const sampleX = Math.floor(cameraPosition.x + (Math.random() * 2 - 1) * sampleRadius);
      const sampleZ = Math.floor(cameraPosition.z + (Math.random() * 2 - 1) * sampleRadius);

      for (let sampleY = scanStartY; sampleY >= scanEndY; sampleY--) {
        vec3b.set(sampleX, sampleY, sampleZ);
        const block = this._game.chunkManager.getBlock(vec3b);
        if (!block || block.blockId === 0) {
          continue;
        }

        const blockType = this._game.blockTypeManager.getBlockType(block.blockId);
        if (!blockType) {
          continue;
        }

        vec3c.set(sampleX, sampleY + 1, sampleZ);
        const aboveBlock = this._game.chunkManager.getBlock(vec3c);

        if (blockType.isLiquid) {
          if (aboveBlock?.blockId && aboveBlock.blockId !== 0) {
            continue;
          }
        } else if (aboveBlock?.blockId && aboveBlock.blockId !== 0) {
          continue;
        }

        const exposureY = blockType.isLiquid ? sampleY + 1 : sampleY + 2;
        vec3d.set(sampleX, exposureY, sampleZ);
        const skyExposure = this._game.skyDistanceVolumeManager.getSkyLightBrightnessByGlobalCoordinate(vec3d);
        if (skyExposure < WEATHER_SURFACE_IMPACT_SKY_EXPOSURE_MIN) {
          break;
        }

        const jitterAmount = precipitation === 'snow'
          ? WEATHER_SURFACE_IMPACT_JITTER * 0.6
          : WEATHER_SURFACE_IMPACT_JITTER;
        const surfaceYOffset = blockType.isLiquid
          ? WEATHER_SURFACE_IMPACT_LIQUID_Y_OFFSET + WATER_SURFACE_Y_OFFSET
          : 1 + WEATHER_SURFACE_IMPACT_SOLID_Y_OFFSET;

        return {
          x: sampleX + 0.5 + (Math.random() - 0.5) * jitterAmount,
          y: sampleY + surfaceYOffset,
          z: sampleZ + 0.5 + (Math.random() - 0.5) * jitterAmount,
        };
      }
    }

    return null;
  }

  private _onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === '`' || event.key === 'F3') {
      void this.toggleDebug();
    }
  }

  private _onTouchStart = (event: TouchEvent): void => {
    if (event.touches.length >= 5) {
      void this.toggleDebug();
    }
  }

  private _onClientSettingsUpdate = (_payload: ClientSettingsEventPayload.IUpdate): void => {
    this._adaptiveResolutionScale = 1;
    this._adaptiveResolutionDownHoldS = 0;
    this._adaptiveResolutionUpHoldS = 0;
    this._updateDirectionalShadowContrast();
    this._temporalResolvePass.markHistoryInvalid();
    this._temporalJitterIndex = 1;
    this._setEnvironmentOverrideTexture(null);
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
    this._scene.add(this._directionalShadowCascadeNearLight);
    this._scene.add(this._directionalShadowCascadeNearLight.target);
    this._scene.add(this._directionalShadowCascadeFarLight);
    this._scene.add(this._directionalShadowCascadeFarLight.target);
    this._scene.add(this._directionalSceneLight);
    this._scene.add(this._directionalSceneLight.target);
    this._scene.add(this._localReflectionCubeCamera);

    this._viewModelScene.add(this._ambientViewModelLight);
    this._viewModelScene.add(this._directionalViewModelLight);
    this._viewModelScene.add(this._directionalViewModelLight.target);

    this._directionalSceneLight.castShadow = true;
    this._directionalSceneLight.shadow.bias = DIRECTIONAL_LIGHT_SHADOW_BIAS;
    this._directionalSceneLight.shadow.normalBias = DIRECTIONAL_LIGHT_SHADOW_NORMAL_BIAS;
    this._directionalSceneLight.shadow.autoUpdate = false;
    this._directionalShadowCascadeNearLight.castShadow = true;
    this._directionalShadowCascadeNearLight.shadow.bias = DIRECTIONAL_LIGHT_SHADOW_BIAS;
    this._directionalShadowCascadeNearLight.shadow.normalBias = DIRECTIONAL_LIGHT_SHADOW_NORMAL_BIAS;
    this._directionalShadowCascadeNearLight.shadow.autoUpdate = false;
    this._directionalShadowCascadeFarLight.castShadow = true;
    this._directionalShadowCascadeFarLight.shadow.bias = DIRECTIONAL_LIGHT_SHADOW_BIAS;
    this._directionalShadowCascadeFarLight.shadow.normalBias = DIRECTIONAL_LIGHT_SHADOW_NORMAL_BIAS;
    this._directionalShadowCascadeFarLight.shadow.autoUpdate = false;
    this._directionalViewModelLight.castShadow = false;
    this._applyShadowSettings();
    this._updateDirectionalLight(0, true);
  }

  private _updateDirectionalShadowContrast(): void {
    switch (this._game.settingsManager.qualityPresetLevel) {
      case 'HIGH':
        setDirectionalShadowContrast(DIRECTIONAL_SHADOW_CONTRAST_HIGH);
        break;
      default:
        setDirectionalShadowContrast(DIRECTIONAL_SHADOW_CONTRAST_DEFAULT);
        break;
    }
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
    let shouldUpdatePositions = forceRender;

    if (!forceRender) {
      this._sceneUIRenderCooldownRemainingS = Math.max(0, this._sceneUIRenderCooldownRemainingS - frameDeltaS);
      if (this._sceneUIRenderCooldownRemainingS <= 0) {
        shouldUpdatePositions = true;
      }
    }

    if (shouldUpdatePositions) {
      uiManager.update();
      this._sceneUIRenderCooldownRemainingS = this._getSceneUIRenderInterval(sceneUICount);
    } else {
      // Keep all entity-attached SceneUIs aligned to the render cadence so they track
      // client-side entity interpolation smoothly even when the full SceneUI pass is throttled.
      uiManager.updateAttachedSceneUIs();
    }

    // Always re-project with the current camera so UI tracks smoothly during camera movement
    this._sceneUiRenderer.render(this._uiScene, this._game.camera.activeCamera);
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
    this._renderer.toneMapping = NeutralToneMapping;
    this._renderer.toneMappingExposure = COLOR_PRESERVING_TONE_MAPPING_EXPOSURE;
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
      void import('../ui/Modal')
        .then(({ modalAlert }) => modalAlert('WebGL Context has been lost, this likely means a low memory or excessive GPU usage situation. Please report this error. You may refresh the page or reload the app to continue playing.'))
        .catch((error) => {
          console.error('Renderer: Failed to load modal alert after context loss.', error);
        });
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

  private _hideDistantSceneObjectsForWaterReflection(activeCamera: PerspectiveCamera): void {
    const nearbyChunkMeshes = this._game.chunkMeshManager.getReflectionCandidateMeshesNear(
      activeCamera.position,
      WATER_REFLECTION_MAX_DISTANCE,
    );
    const nearbyEntityObjects = this._game.entityManager.getReflectionCandidateObjectsNear(
      activeCamera.position,
      WATER_REFLECTION_MAX_DISTANCE,
    );

    waterReflectionVisibleObjectSet.clear();
    for (let i = 0; i < nearbyChunkMeshes.length; i++) {
      waterReflectionVisibleObjectSet.add(nearbyChunkMeshes[i]);
    }
    for (let i = 0; i < nearbyEntityObjects.length; i++) {
      waterReflectionVisibleObjectSet.add(nearbyEntityObjects[i]);
    }

    waterReflectionTemporarilyHiddenObjects.length = 0;
    waterReflectionTemporarilyAddedObjects.length = 0;

    const frameCount = this._game.performanceMetricsManager.frameCount;
    for (let i = 0; i < nearbyEntityObjects.length; i++) {
      const object = nearbyEntityObjects[i];
      if (object.parent !== null) {
        continue;
      }

      const wasVisible = object.visible;
      object.visible = true;
      this._scene.add(object);

      const entity = object.userData.entityRef as Entity | undefined;
      if (entity) {
        entity.updateAnimationAndLocalMatrix(0, frameCount);
        entity.updateWorldMatrices(this._game.entityManager.hasLightLevelVolumeUpdatedOnce, false);
        entity.applyShadowCasterLod();
      } else {
        object.updateMatrixWorld(true);
      }

      waterReflectionTemporarilyAddedObjects.push({ object, wasVisible });
    }

    const solidMeshes = this._game.chunkMeshManager.solidMeshesInScene;
    for (let i = 0; i < solidMeshes.length; i++) {
      const mesh = solidMeshes[i];
      if (!waterReflectionVisibleObjectSet.has(mesh) && mesh.visible) {
        mesh.visible = false;
        waterReflectionTemporarilyHiddenObjects.push(mesh);
      }
    }

    const foliageMeshes = this._game.chunkMeshManager.foliageMeshesInScene;
    for (let i = 0; i < foliageMeshes.length; i++) {
      const mesh = foliageMeshes[i];
      if (!waterReflectionVisibleObjectSet.has(mesh) && mesh.visible) {
        mesh.visible = false;
        waterReflectionTemporarilyHiddenObjects.push(mesh);
      }
    }

    const reflectionObjects = this._game.entityManager.reflectionObjectsInScene;
    for (let i = 0; i < reflectionObjects.length; i++) {
      const object = reflectionObjects[i];
      if (!waterReflectionVisibleObjectSet.has(object) && object.visible) {
        object.visible = false;
        waterReflectionTemporarilyHiddenObjects.push(object);
      }
    }
  }

  private _restoreHiddenSceneObjectsForWaterReflection(): void {
    for (let i = 0; i < waterReflectionTemporarilyHiddenObjects.length; i++) {
      waterReflectionTemporarilyHiddenObjects[i].visible = true;
    }

    for (let i = 0; i < waterReflectionTemporarilyAddedObjects.length; i++) {
      const { object, wasVisible } = waterReflectionTemporarilyAddedObjects[i];
      if (object.parent === this._scene) {
        this._scene.remove(object);
      }
      object.visible = wasVisible;
    }

    waterReflectionTemporarilyHiddenObjects.length = 0;
    waterReflectionTemporarilyAddedObjects.length = 0;
    waterReflectionVisibleObjectSet.clear();
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
    this._hideDistantSceneObjectsForWaterReflection(activeCamera);

    for (const liquidMesh of liquidMeshes) {
      liquidMesh.visible = false;
    }

    try {
      this._renderer.shadowMap.autoUpdate = false;
      this._renderer.autoClear = true;
      this._renderer.setRenderTarget(this._waterReflectionRenderTarget);
      this._renderer.clear();
      this._renderer.render(this._scene, this._waterReflectionCamera);
    } finally {
      this._renderer.setRenderTarget(currentRenderTarget);
      this._renderer.shadowMap.autoUpdate = currentShadowAutoUpdate;
      this._renderer.autoClear = currentAutoClear;

      for (const liquidMesh of liquidMeshes) {
        liquidMesh.visible = true;
      }

      this._restoreHiddenSceneObjectsForWaterReflection();
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

    if (!reflectionPlaneInfo.centerHit && reflectionPlaneInfo.coverage < WATER_REFLECTION_MIN_SCENE_COVERAGE) {
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

  private _shouldUseTemporalResolve(): boolean {
    const taa = this._game.settingsManager.qualityPerfTradeoff.postProcessing?.taa;
    return !!taa?.enabled
      && this._game.camera.isGameCameraActive
      && this._game.camera.isFirstPersonGameCameraActive
      && !this._game.camera.isOrthographicGameCameraActive
      && !MobileManager.isMobile;
  }

  private _applyTemporalJitter(camera: PerspectiveCamera | OrthographicCamera): boolean {
    if (!(camera instanceof PerspectiveCamera) || !this._shouldUseTemporalResolve()) {
      return false;
    }

    this._renderer.getDrawingBufferSize(vec2);
    const jitterIndex = this._temporalJitterIndex++;
    const jitterX = (halton(jitterIndex, 2) - 0.5) * TEMPORAL_JITTER_SCALE;
    const jitterY = (halton(jitterIndex, 3) - 0.5) * TEMPORAL_JITTER_SCALE;
    camera.setViewOffset(vec2.width, vec2.height, jitterX, jitterY, vec2.width, vec2.height);
    camera.updateProjectionMatrix();
    return true;
  }

  private _clearTemporalJitter(camera: PerspectiveCamera | OrthographicCamera): void {
    if (!(camera instanceof PerspectiveCamera)) {
      return;
    }

    camera.clearViewOffset();
    camera.updateProjectionMatrix();
  }

  private _updateTemporalResolvePass(): void {
    const runtimeTuning = this._resolveRuntimeTuningState();
    const activeCamera = this._game.camera.activeCamera;
    const enabled = this._shouldUseTemporalResolve()
      && activeCamera instanceof PerspectiveCamera;

    if (!enabled) {
      this._temporalResolvePass.enabled = false;
      this._temporalResolvePass.markHistoryInvalid();
      return;
    }

    this._temporalResolvePass.enabled = true;
    this._temporalResolvePass.setHistoryWeight(runtimeTuning.temporalHistoryWeight);
    this._temporalResolvePass.setSharpenStrength(runtimeTuning.temporalSharpenStrength);
    this._temporalResolvePass.setCamera({
      far: activeCamera.far,
      near: activeCamera.near,
      projectionMatrix: activeCamera.projectionMatrix,
      projectionMatrixInverse: activeCamera.projectionMatrixInverse,
      matrixWorld: activeCamera.matrixWorld,
      matrixWorldInverse: activeCamera.matrixWorldInverse,
      isPerspectiveCamera: true,
    });
  }

  private _shouldUseGroundedGtao(): boolean {
    const gtao = this._game.settingsManager.qualityPerfTradeoff.postProcessing?.gtao;
    return !!gtao?.enabled
      && this._game.camera.isGameCameraActive
      && !this._game.camera.isOrthographicGameCameraActive
      && !MobileManager.isMobile;
  }

  private _updateGroundedGtaoPass(): void {
    const runtimeTuning = this._resolveRuntimeTuningState();
    const activeCamera = this._game.camera.activeCamera;
    const enabled = this._shouldUseGroundedGtao()
      && runtimeTuning.gtaoStrength > 0.001
      && runtimeTuning.gtaoWorldRadius > 0.001
      && runtimeTuning.gtaoMaxDistance > 0.001;

    if (!enabled) {
      this._groundedGtaoPass.enabled = false;
      return;
    }

    this._groundedGtaoPass.enabled = true;
    this._groundedGtaoPass.setStrength(runtimeTuning.gtaoStrength);
    this._groundedGtaoPass.setWorldRadius(runtimeTuning.gtaoWorldRadius, runtimeTuning.gtaoMaxDistance);
    this._groundedGtaoPass.setCamera({
      far: activeCamera.far,
      near: activeCamera.near,
      projectionMatrixInverse: activeCamera.projectionMatrixInverse,
      isPerspectiveCamera: activeCamera instanceof PerspectiveCamera,
    });
  }

  private _shouldUseAtmospherePass(): boolean {
    const atmosphere = this._game.settingsManager.qualityPerfTradeoff.postProcessing?.atmosphere;
    return !!atmosphere?.enabled
      && this._game.camera.isFirstPersonGameCameraActive
      && !this._game.camera.isOrthographicGameCameraActive
      && !MobileManager.isMobile
      && !this._game.chunkManager.inLiquidBlock(this._game.camera.activeCamera.position);
  }

  private _updateAtmospherePass(frameDeltaS: number): void {
    const atmosphere = this._game.settingsManager.qualityPerfTradeoff.postProcessing?.atmosphere;
    const activeCamera = this._game.camera.activeCamera;
    const enabled = this._shouldUseAtmospherePass();

    if (!enabled) {
      this._atmospherePass.enabled = false;
      return;
    }

    this._atmospherePass.enabled = true;
    this._atmospherePass.setCamera({
      far: activeCamera.far,
      near: activeCamera.near,
      projectionMatrixInverse: activeCamera.projectionMatrixInverse,
      matrixWorld: activeCamera.matrixWorld,
      isPerspectiveCamera: activeCamera instanceof PerspectiveCamera,
    });
    this._atmospherePass.setAtmosphere({
      cloudCoverage: this._proceduralSkySettings?.cloudCoverage ?? 0.12,
      cloudOpacity: this._proceduralSkySettings?.cloudOpacity ?? 0.0,
      cloudScale: this._proceduralSkySettings?.cloudScale ?? 0.24,
      cloudShadowStrength: atmosphere?.cloudShadowStrength ?? 0.12,
      cloudSpeed: this._proceduralSkySettings?.cloudSpeed ?? 0.01,
      fogColor: this.fogColor,
      heightFogDensity: atmosphere?.heightFogDensity ?? 0.016,
      heightFogHeightFalloff: atmosphere?.heightFogHeightFalloff ?? 0.062,
      sunColor: this._directionalSceneLight.color,
      sunDirection: this._skySunDirection ?? this._sunDirection,
      sunInscatterStrength: atmosphere?.sunInscatterStrength ?? 0.2,
      sunIntensity: this._directionalSceneLight.intensity,
      time: this._proceduralSkyTimeS + frameDeltaS,
      windDirection: this._proceduralSkySettings?.windDirection ?? vec2.set(1, 0.16),
      worldSeed: this._proceduralSkyWorldSeed,
    });
  }

  private _shouldUseLocalReflectionProbe(): boolean {
    const config = this._game.settingsManager.qualityPerfTradeoff.localReflections;
    return !!config?.enabled
      && this._game.camera.isGameCameraActive
      && !this._game.camera.isOrthographicGameCameraActive
      && !MobileManager.isMobile;
  }

  private _ensureLocalReflectionProbeSize(size: number): void {
    if (this._localReflectionCubeRenderTarget.width === size) {
      return;
    }

    this._localReflectionCubeRenderTarget.setSize(size, size);
    if (this._localReflectionEnvironmentRenderTarget) {
      this._localReflectionEnvironmentRenderTarget.dispose();
      this._localReflectionEnvironmentRenderTarget = null;
    }
  }

  private _updateLocalReflectionProbe(frameDeltaS: number): void {
    const config = this._game.settingsManager.qualityPerfTradeoff.localReflections;
    const runtimeTuning = this._resolveRuntimeTuningState();
    const activeCamera = this._game.camera.activeCamera;
    const enabled = this._shouldUseLocalReflectionProbe()
      && activeCamera instanceof PerspectiveCamera
      && !this._game.chunkManager.inLiquidBlock(activeCamera.position);

    if (!enabled) {
      this._setEnvironmentOverrideTexture(null);
      this._localReflectionUpdateCooldownS = 0;
      return;
    }

    Chunk.worldPositionToGlobalCoordinate(activeCamera.position, vec3e);
    const openSkyAmount = this._game.skyDistanceVolumeManager.getSkyLightBrightnessByGlobalCoordinate(vec3e);
    const maxSkyExposure = Math.min(runtimeTuning.localReflectionMaxSkyExposure, 0.2);
    if (openSkyAmount > maxSkyExposure) {
      this._setEnvironmentOverrideTexture(null);
      this._localReflectionUpdateCooldownS = 0;
      return;
    }

    this._ensureLocalReflectionProbeSize(config?.textureSize ?? 128);
    this._localReflectionUpdateCooldownS = Math.max(0, this._localReflectionUpdateCooldownS - frameDeltaS);

    const positionDelta = runtimeTuning.localReflectionPositionDelta;
    const needsRefresh = !Number.isFinite(this._lastLocalReflectionProbePosition.x)
      || this._lastLocalReflectionProbePosition.distanceToSquared(activeCamera.position) >= positionDelta * positionDelta
      || this._localReflectionUpdateCooldownS <= 0
      || this._localReflectionEnvironmentRenderTarget === null;

    if (!needsRefresh) {
      this._setEnvironmentOverrideTexture(this._localReflectionEnvironmentRenderTarget?.texture ?? null);
      return;
    }

    const previousRenderTarget = this._renderer.getRenderTarget();
    const previousAutoClear = this._renderer.autoClear;
    const previousShadowAutoUpdate = this._renderer.shadowMap.autoUpdate;

    this._setEnvironmentOverrideTexture(null);
    this._localReflectionCubeCamera.position.copy(activeCamera.position);
    this._localReflectionCubeCamera.updateMatrixWorld();

    try {
      this._renderer.autoClear = true;
      this._renderer.shadowMap.autoUpdate = false;
      this._localReflectionCubeCamera.update(this._renderer, this._scene);
    } finally {
      this._renderer.setRenderTarget(previousRenderTarget);
      this._renderer.autoClear = previousAutoClear;
      this._renderer.shadowMap.autoUpdate = previousShadowAutoUpdate;
    }

    const previousEnvironmentRenderTarget = this._localReflectionEnvironmentRenderTarget;
    this._localReflectionEnvironmentRenderTarget = this._pmremGenerator.fromCubemap(this._localReflectionCubeRenderTarget.texture);
    if (previousEnvironmentRenderTarget) {
      previousEnvironmentRenderTarget.dispose();
    }

    this._lastLocalReflectionProbePosition.copy(activeCamera.position);
    this._localReflectionUpdateCooldownS = runtimeTuning.localReflectionUpdateIntervalS;
    this._setEnvironmentOverrideTexture(this._localReflectionEnvironmentRenderTarget.texture);
  }

  private _shouldUseDirectionalShadowCascades(): boolean {
    // The cascade path is currently unstable on desktop quality presets and can
    // result in missing directional cast shadows. Prefer the single directional
    // shadow path until the cascade implementation is rebuilt safely.
    return false;
  }

  private _shouldUseNearContactShadows(): boolean {
    // This screen-space contact shadow pass produces camera-relative ground
    // darkening that can look like real cast shadows sliding as the view
    // rotates. Keep it disabled until the pass is rebuilt with stable world
    // anchoring and proper material integration.
    return false;
  }

  private _updateNearContactShadows(): void {
    const activeCamera = this._game.camera.activeCamera;
    const enabled = this._shouldUseNearContactShadows()
      && this._game.camera.isGameCameraActive
      && !this._game.camera.isOrthographicGameCameraActive;

    if (!enabled) {
      this._nearContactShadowsPass.enabled = false;
      return;
    }

    this._nearContactShadowsPass.enabled = true;
    this._nearContactShadowsPass.setStrength(NEAR_CONTACT_SHADOW_STRENGTH);
    this._nearContactShadowsPass.setCamera({
      far: activeCamera.far,
      near: activeCamera.near,
      projectionMatrixInverse: activeCamera.projectionMatrixInverse,
      isPerspectiveCamera: activeCamera instanceof PerspectiveCamera,
    });
  }

  private _updateAnalyticSunHaloPass(): void {
    const activeCamera = this._game.camera.activeCamera;
    const skySunDirection = this._skySunDirection ?? this._sunDirection;
    const sunViewDirection = vec3.copy(skySunDirection).negate();
    const cameraForward = vec3b.copy(this._game.camera.activeViewDir);

    if (cameraForward.lengthSq() <= DIRECTIONAL_LIGHT_SHADOW_STABILIZATION_EPSILON_SQ) {
      cameraForward.set(0, 0, -1);
    } else {
      cameraForward.normalize();
    }

    if (sunViewDirection.lengthSq() <= DIRECTIONAL_LIGHT_SHADOW_STABILIZATION_EPSILON_SQ) {
      this._analyticSunHaloPass.setSun(vec2.set(0.5, 0.5), this._directionalSceneLight.color, 0);
      return;
    }

    sunViewDirection.normalize();
    const forwardness = Math.max(0, cameraForward.dot(sunViewDirection));
    const dayAmount = Math.max(0, Math.min(1, (sunViewDirection.y + 0.1) / 0.24));
    const storminess = this._proceduralSkySettings?.storminess ?? 0;
    const forwardVisibility = Math.pow(Math.max(0, Math.min(1, (forwardness - 0.18) / 0.72)), 1.6);
    vec3c.copy(activeCamera.position).addScaledVector(sunViewDirection, 1000).project(activeCamera);
    const sunScreenX = vec3c.x * 0.5 + 0.5;
    const sunScreenY = vec3c.y * 0.5 + 0.5;
    const edgeDistance = Math.max(Math.abs(sunScreenX - 0.5) * 2, Math.abs(sunScreenY - 0.5) * 2);
    const edgeVisibility = Math.max(0, Math.min(1, (edgeDistance - 0.82) / 0.22))
      * (1 - Math.max(0, Math.min(1, (edgeDistance - 1.28) / 0.5)));
    const thirdPersonPenalty = this._game.camera.isGameCameraActive && !this._game.camera.isFirstPersonGameCameraActive
      ? 0.22
      : 1;
    const intensity = dayAmount
      * forwardVisibility
      * edgeVisibility
      * thirdPersonPenalty
      * (0.004 + this._directionalSceneLight.intensity * 0.008)
      * (1 - storminess * 0.55);

    this._analyticSunHaloPass.setSun(
      vec2.set(sunScreenX, sunScreenY),
      this._directionalSceneLight.color,
      intensity,
    );
  }

  private _applyShadowSettings(): void {
    const shadows = this._game.settingsManager.qualityPerfTradeoff.shadows;
    this._renderer.shadowMap.enabled = shadows?.enabled ?? false;
    this._renderer.shadowMap.type = shadows?.type === 'pcf' ? PCFShadowMap : VSMShadowMap;

    const directionalMapSize = shadows?.directionalMapSize ?? 1024;
    const useCascades = this._shouldUseDirectionalShadowCascades();
    this._directionalSceneLight.shadow.mapSize.set(directionalMapSize, directionalMapSize);
    this._directionalSceneLight.shadow.autoUpdate = false;
    this._directionalSceneLight.visible = true;
    this._directionalSceneLight.castShadow = (shadows?.enabled ?? false) && !useCascades;
    this._directionalShadowCascadeNearLight.castShadow = (shadows?.enabled ?? false) && useCascades;
    this._directionalShadowCascadeFarLight.castShadow = (shadows?.enabled ?? false) && useCascades;
    this._directionalShadowCascadeNearLight.visible = useCascades;
    this._directionalShadowCascadeFarLight.visible = useCascades;
    this._directionalShadowCascadeNearLight.shadow.mapSize.set(directionalMapSize, directionalMapSize);
    this._directionalShadowCascadeFarLight.shadow.mapSize.set(
      Math.max(DIRECTIONAL_SHADOW_CASCADE_MIN_MAP_SIZE, Math.round(directionalMapSize * DIRECTIONAL_SHADOW_CASCADE_FAR_MAP_SIZE_RATIO)),
      Math.max(DIRECTIONAL_SHADOW_CASCADE_MIN_MAP_SIZE, Math.round(directionalMapSize * DIRECTIONAL_SHADOW_CASCADE_FAR_MAP_SIZE_RATIO)),
    );
    this._markDirectionalShadowDirty();
  }

  private _markDirectionalShadowDirty(): void {
    this._directionalShadowNeedsUpdate = true;
    this._directionalShadowUpdateCooldownS = 0;
    this._renderer.shadowMap.needsUpdate = true;
  }

  private _snapDirectionalShadowFocusCenter(focusCenter: Vector3, directionalDistance: number, directionalMapSize: number): void {
    const texelWorldSize = (directionalDistance * 2) / Math.max(1, directionalMapSize);

    if (texelWorldSize <= 0) {
      return;
    }

    const basisReference = Math.abs(this._sunDirection.dot(WORLD_UP)) < DIRECTIONAL_LIGHT_SHADOW_STABILIZATION_PARALLEL_THRESHOLD
      ? WORLD_UP
      : WORLD_RIGHT;

    shadowSnapBasisA.crossVectors(basisReference, this._sunDirection).normalize();
    shadowSnapBasisB.crossVectors(this._sunDirection, shadowSnapBasisA).normalize();

    const snappedX = Math.round(focusCenter.dot(shadowSnapBasisA) / texelWorldSize) * texelWorldSize;
    const snappedY = Math.round(focusCenter.dot(shadowSnapBasisB) / texelWorldSize) * texelWorldSize;
    const depth = focusCenter.dot(this._sunDirection);

    focusCenter.copy(this._sunDirection).multiplyScalar(depth);
    focusCenter.addScaledVector(shadowSnapBasisA, snappedX);
    focusCenter.addScaledVector(shadowSnapBasisB, snappedY);
  }

  private _applyDirectionalLightToLight(light: DirectionalLight, focusCenter: Vector3, lightHeight: number, directionalDistance: number): void {
    light.target.position.copy(focusCenter);
    light.target.updateMatrixWorld();
    light.position.copy(focusCenter).addScaledVector(this._sunDirection, -lightHeight);
    light.updateMatrixWorld();

    const shadowCamera = light.shadow.camera as OrthographicCamera;
    shadowCamera.left = -directionalDistance;
    shadowCamera.right = directionalDistance;
    shadowCamera.top = directionalDistance;
    shadowCamera.bottom = -directionalDistance;
    shadowCamera.near = 0.5;
    shadowCamera.far = Math.max(directionalDistance * 4, lightHeight * 2);
    shadowCamera.updateProjectionMatrix();
  }

  private _isDirectionalShadowMotionActive(frameDeltaS: number, cameraPosition: Vector3): boolean {
    this._directionalShadowContinuousUpdateRemainingS = Math.max(
      0,
      this._directionalShadowContinuousUpdateRemainingS - frameDeltaS,
    );

    const cameraMoved = this._lastDirectionalShadowCameraPosition.distanceToSquared(cameraPosition)
      >= DIRECTIONAL_LIGHT_SHADOW_CAMERA_POSITION_DELTA_SQ_THRESHOLD;

    this._lastDirectionalShadowCameraPosition.copy(cameraPosition);
    this._lastDirectionalShadowViewDir.set(0, 0, 0);

    if (cameraMoved) {
      this._directionalShadowContinuousUpdateRemainingS = DIRECTIONAL_LIGHT_SHADOW_CONTINUOUS_UPDATE_HOLD_S;
    }

    return this._directionalShadowContinuousUpdateRemainingS > 0;
  }

  private _updateDirectionalLight(frameDeltaS: number = 0, force: boolean = false): void {
    const shadows = this._game.settingsManager.qualityPerfTradeoff.shadows;
    const useCascades = this._shouldUseDirectionalShadowCascades();
    const directionalDistance = shadows?.directionalDistance ?? 48;
    const nearCascadeDistance = directionalDistance * DIRECTIONAL_SHADOW_CASCADE_NEAR_DISTANCE_RATIO;
    const cameraPosition = this._game.camera.activeCamera.position;
    const attachedShadowEntity = this._game.camera.isGameCameraActive
      ? this._game.camera.gameCameraAttachedEntity
      : undefined;
    const shadowAnchorPosition = attachedShadowEntity
      ? attachedShadowEntity.getWorldPosition(vec3e)
      : cameraPosition;
    const lightHeight = Math.max(DIRECTIONAL_LIGHT_MIN_HEIGHT, directionalDistance * DIRECTIONAL_LIGHT_SHADOW_HEIGHT_MULTIPLIER);
    const nearCascadeLightHeight = Math.max(DIRECTIONAL_LIGHT_MIN_HEIGHT, nearCascadeDistance * DIRECTIONAL_LIGHT_SHADOW_HEIGHT_MULTIPLIER);
    const directionalMapSize = this._directionalSceneLight.shadow.mapSize.x || shadows?.directionalMapSize || 1024;
    const farCascadeMapSize = this._directionalShadowCascadeFarLight.shadow.mapSize.x
      || Math.max(DIRECTIONAL_SHADOW_CASCADE_MIN_MAP_SIZE, Math.round(directionalMapSize * DIRECTIONAL_SHADOW_CASCADE_FAR_MAP_SIZE_RATIO));

    this._directionalShadowUpdateCooldownS = Math.max(0, this._directionalShadowUpdateCooldownS - frameDeltaS);

    vec3.copy(shadowAnchorPosition);
    vec3b.copy(shadowAnchorPosition);

    if (shadows?.enabled) {
      this._snapDirectionalShadowFocusCenter(vec3, directionalDistance, useCascades ? farCascadeMapSize : directionalMapSize);
      if (useCascades) {
        this._snapDirectionalShadowFocusCenter(vec3b, nearCascadeDistance, directionalMapSize);
      }
    }

    const shadowMotionActive = shadows?.enabled
      ? this._isDirectionalShadowMotionActive(frameDeltaS, cameraPosition)
      : false;

    this._directionalViewModelLight.target.position.set(0, 0, -1);
    this._directionalViewModelLight.target.updateMatrixWorld();
    this._directionalViewModelLight.position.copy(this._sunDirection).multiplyScalar(-lightHeight * 0.25);
    this._directionalViewModelLight.updateMatrixWorld();

    if (!shadows?.enabled) {
      this._applyDirectionalLightToLight(this._directionalSceneLight, vec3, lightHeight, directionalDistance);
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
      || shadowMotionActive
      || this._directionalShadowNeedsUpdate
      || sunDirectionChanged
      || focusDeltaSq >= immediateUpdateDistance * immediateUpdateDistance
      || (focusCenterChanged && this._directionalShadowUpdateCooldownS <= 0);

    if (!shouldRefreshShadow) {
      return;
    }

    this._applyDirectionalLightToLight(this._directionalSceneLight, vec3, lightHeight, directionalDistance);
    if (useCascades) {
      this._applyDirectionalLightToLight(this._directionalShadowCascadeNearLight, vec3b, nearCascadeLightHeight, nearCascadeDistance);
      this._applyDirectionalLightToLight(this._directionalShadowCascadeFarLight, vec3, lightHeight, directionalDistance);
      this._directionalShadowCascadeNearLight.shadow.needsUpdate = true;
      this._directionalShadowCascadeFarLight.shadow.needsUpdate = true;
    } else {
      this._directionalSceneLight.shadow.needsUpdate = true;
    }
    this._renderer.shadowMap.needsUpdate = true;
    this._directionalShadowNeedsUpdate = false;
    this._directionalShadowInitialized = true;
    this._directionalShadowUpdateCooldownS = shadowMotionActive ? 0 : DIRECTIONAL_LIGHT_SHADOW_UPDATE_INTERVAL_S;
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

  private _createLightningFlashQuad(): Mesh {
    const quad = new Mesh(
      new PlaneGeometry(2, 2),
      new MeshBasicMaterial({
        transparent: true,
        blending: AdditiveBlending,
        depthTest: false,
        depthWrite: false,
        opacity: 0,
      }),
    );
    quad.frustumCulled = false;
    quad.renderOrder = 9998;
    quad.position.z = -0.5;
    quad.visible = false;
    quad.updateMatrix();
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
      // Cap underwater overlay brightness so bright liquid textures cannot wash out the
      // screen while swimming. Keep a slight blue bias so the tint still reads as water.
      (this._underWaterEffectQuad.material as MeshBasicMaterial).color.setRGB(
        Math.min(blockRGB[0] * 0.22, 0.16),
        Math.min(blockRGB[1] * 0.22, 0.18),
        Math.min(blockRGB[2] * 0.22, 0.20),
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
    if (this._skyboxMesh && isProceduralSkyMaterial(this._skyboxMesh.material)) {
      this._updateProceduralSky(frameDeltaS);
      this._interpolatingSkyboxColor = false;
      return;
    }

    this._applyDynamicLighting(0);
    this._updateLightningFlash(0);

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
    // Dynamic bloom threshold based on the authoritative environment lighting.
    // UnrealBloomPass always sets smoothWidth to 0.01 (see UnrealBloomPass.js)
    const smoothWidth = 0.01;

    // Daytime directional light can otherwise cause broad scene bloom. Use only
    // the base world lights so transient lightning flashes still bloom.
    const daytimeGuard = this._baseAmbientLightIntensity + this._baseDirectionalLightIntensity * 0.72;
    return Math.max(daytimeGuard + 0.18 + smoothWidth, 1.42 + smoothWidth);
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
