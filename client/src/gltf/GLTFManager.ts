import Game from '../Game';
import Assets from '../network/Assets';
import {
  Box3,
  BufferGeometry,
  CompressedTexture,
  Color,
  DataArrayTexture,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  NearestFilter,
  NoBlending,
  NoColorSpace,
  Object3D,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  Source,
  Texture,
  Vector3,
  WebGLProgramParametersWithUniforms,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import {
  GLTF,
  GLTFLoaderPlugin,
  GLTFParser,
} from 'three/addons/loaders/GLTFLoader.js';
import EmissiveMeshBasicMaterial, { type ShaderProcessor } from './EmissiveMeshBasicMaterial';
import EmissiveMeshHeroMaterial, { HERO_PHYSICAL_USER_DATA_KEY } from './EmissiveMeshHeroMaterial';
// TODO: Honestly I don't want to have dependency with Entity from GLTFManager...
import Entity from '../entities/Entity';
import { updateAABB } from '../three/utils';
import GLTFStats from './GLTFStats';

// InstancedMesh is not used until the number of cloned meshes reaches a certain threshold,
// due to the following constraints with our current InstancedMesh implementations, for example:
// * Potential incorrect rendering of overlapping transparent objects.
// TODO: Configurable threshold?
const USE_INSTANCED_MESH_THRESHOLD = 8;

// Threshold for transparent meshes. Below this threshold, transparent meshes
// are rendered individually to improve transparency sorting.
// Note: This only affects rendering method selection, not InstancedMesh creation.
// InstancedMesh pairs are still created based on USE_INSTANCED_MESH_THRESHOLD.
const USE_INSTANCED_MESH_THRESHOLD_TRANSPARENT = 4;
const TRANSPARENT_INSTANCED_SORT_INTERVAL_SMALL = 2;
const TRANSPARENT_INSTANCED_SORT_INTERVAL_MEDIUM = 3;
const TRANSPARENT_INSTANCED_SORT_INTERVAL_LARGE = 4;
const TRANSPARENT_SORT_CAMERA_POSITION_DELTA_SQ_THRESHOLD = 0.05 * 0.05;
const TRANSPARENT_SORT_VIEW_ALIGNMENT_DOT_THRESHOLD = 0.9995;

// Creates or deletes an appropriately sized InstancedMesh when the number of Cloned Meshes exceeds the thresholds.
// There is a difference between the thresholds for creating and deleting.
// If both thresholds were the same, frequent adding and removing of cloned meshes near the threshold could cause
// repeated creating and deleting, negatively impacting performance.
// Using different thresholds helps prevent this issue from occurring frequently.
const INSTANCED_MESH_RESIZE_INCREASE_FACTOR = 4;
// Similar to InstancedTexture depth
const INSTANCED_TEXTURE_RESIZE_INCREASE_FACTOR = 4;
const INSTANCED_TEXTURE_RESIZE_DECREASE_FACTOR = 8;

// TODO: Should this variable be defined in a more appropriate location since it can be used more generically?
const DEFAULT_LAYER = 0;
const DEFAULT_LAYER_MASK = 1 << DEFAULT_LAYER;
const USERDATA_TRANSPARENT_SORT_DEPTH = 'gltfTransparentSortDepth';

const USE_INSTANCED_COLOR_DEFINE = 'USE_INSTANCED_COLOR';

const USE_INSTANCED_OPACITY_DEFINE = 'USE_INSTANCED_OPACITY';
const INSTANCE_OPACITY_ATTRIBUTE = 'instanceOpacity';
const INSTANCE_OPACITY_VARYING = 'v' + INSTANCE_OPACITY_ATTRIBUTE[0].toUpperCase() + INSTANCE_OPACITY_ATTRIBUTE.slice(1);

const USE_INSTANCED_MAP_DEFINE = 'USE_INSTANCED_MAP';
const INSTANCE_MAP_INDEX_ATTRIBUTE = 'instanceMapIndex';
const INSTANCE_MAP_INDEX_VARYING = 'v' + INSTANCE_MAP_INDEX_ATTRIBUTE[0].toUpperCase() + INSTANCE_MAP_INDEX_ATTRIBUTE.slice(1);

const USE_INSTANCED_LIGHT_LEVEL_DEFINE = 'USE_INSTANCED_LIGHT_LEVEL';
const INSTANCE_LIGHT_LEVEL_ATTRIBUTE = 'instanceLightLevel';
const INSTANCE_LIGHT_LEVEL_VARYING = 'v' + INSTANCE_LIGHT_LEVEL_ATTRIBUTE[0].toUpperCase() + INSTANCE_LIGHT_LEVEL_ATTRIBUTE.slice(1);
const INSTANCE_SKY_LIGHT_ATTRIBUTE = 'instanceSkyLight';
const INSTANCE_SKY_LIGHT_VARYING = 'v' + INSTANCE_SKY_LIGHT_ATTRIBUTE[0].toUpperCase() + INSTANCE_SKY_LIGHT_ATTRIBUTE.slice(1);

const USE_INSTANCED_EMISSIVE_DEFINE = 'USE_INSTANCED_EMISSIVE';
const INSTANCE_EMISSIVE_ATTRIBUTE = 'instanceEmissive';
const INSTANCE_EMISSIVE_VARYING = 'v' + INSTANCE_EMISSIVE_ATTRIBUTE[0].toUpperCase() + INSTANCE_EMISSIVE_ATTRIBUTE.slice(1);

const WORLD_NORMAL_Y_VARYING = 'vWorldNormalY';

const UNIFORM_RAW_AMBIENT_LIGHT_COLOR = 'rawAmbientLightColor';
const UNIFORM_AMBIENT_LIGHT_INTENSITY = 'ambientLightIntensity';
const MATRIX4_COMPONENT_COUNT = 16;

type ManagedLitMaterial = EmissiveMeshBasicMaterial | EmissiveMeshHeroMaterial;

// Working variables
const opaqueClonedMeshes: Mesh[] = [];
const transparentClonedMeshes: Mesh[] = [];
const usedColorTextureSet: Set<Texture> = new Set();
// TODO: Better name...
const sourceTextureToUsedTexturesMap: Map<Texture /* Source Texture */, Set<Texture /* Texture used by Cloned Mesh of InstancedMesh */ >> = new Map();

const tmpCanvas = document.createElement('canvas');
// Need error check?
const tmp2DContext = tmpCanvas.getContext('2d', { willReadFrequently: true })!;

// We need to make some minor changes to the material for the InstancedMesh while
// keeping it on Three.js's lighting and shadow path.
class InstancedMeshBasicMaterial extends EmissiveMeshBasicMaterial {
  private _game: Game;
  private _instancedTextureEnabled: boolean = false;

  constructor(source: ManagedLitMaterial, game: Game) {
    super();
    this.copy(source);
    this._game = game;
    this.defines = this.defines || {};

    this.setColorTexture(this.map);
    this.addShaderProcessor(this._createShaderProcessor());
    this.addShaderProcessor(this._createEmissiveOverrideProcessor(), true);
  }

  public setColorTexture(texture: Texture | null): void {
    this.map = texture;
    this._enableInstancedTexture(this.map instanceof InstancedTexture);
  }

  private _enableInstancedTexture(enabled: boolean): void {
    if (this._instancedTextureEnabled !== enabled) {
      if (enabled) {
        this.defines![USE_INSTANCED_MAP_DEFINE] = '';
      } else {
        delete this.defines![USE_INSTANCED_MAP_DEFINE];
      }

      this.needsUpdate = true;
    }
    
    this._instancedTextureEnabled = enabled;
  }

  // Since mesh instance-level opacity and texture array is not supported by the InstancedMesh API,
  // hacking the shader to handle it.
  // TODO: Move to Three.js TSL
  // The old approach of modifying shaders using hooks has poor readability and maintainability.
  // Additionally, it can be easily broken due to Three.js upgrades.
  // The worst-case scenario is that a Three.js upgrade slightly changes the shader code,
  // causing string pattern matching to fail. However, since this wouldn't result in a shader
  // compilation error, the issue might go unnoticed.
  private _createShaderProcessor(): (params: WebGLProgramParametersWithUniforms) => void {
    return (params) => {
      const ambientLight = this._game.renderer.ambientLight;
      params.uniforms[UNIFORM_RAW_AMBIENT_LIGHT_COLOR] = { value: ambientLight.color };
      // Note: intensity is a primitive number, so we use a getter to always get the current value
      // The uniform object's value is read on each render by Three.js
      params.uniforms[UNIFORM_AMBIENT_LIGHT_INTENSITY] = { 
        get value() { return ambientLight.intensity; }
      };

      params.vertexShader = params.vertexShader
      .replace(
        'void main() {',
        `
          #ifdef ${USE_INSTANCED_MAP_DEFINE}
            attribute float ${INSTANCE_MAP_INDEX_ATTRIBUTE};
            varying float ${INSTANCE_MAP_INDEX_VARYING};
          #endif

          #ifdef ${USE_INSTANCED_OPACITY_DEFINE}
            attribute float ${INSTANCE_OPACITY_ATTRIBUTE};
            varying float ${INSTANCE_OPACITY_VARYING};
          #endif

          #ifdef ${USE_INSTANCED_LIGHT_LEVEL_DEFINE}
            attribute float ${INSTANCE_LIGHT_LEVEL_ATTRIBUTE};
            varying float ${INSTANCE_LIGHT_LEVEL_VARYING};
          #endif

          #ifdef ${USE_INSTANCED_EMISSIVE_DEFINE}
            attribute vec4 ${INSTANCE_EMISSIVE_ATTRIBUTE};
            varying vec4 ${INSTANCE_EMISSIVE_VARYING};
          #endif

          attribute float ${INSTANCE_SKY_LIGHT_ATTRIBUTE};
          varying float ${INSTANCE_SKY_LIGHT_VARYING};

          varying float ${WORLD_NORMAL_Y_VARYING};

          // Calculate normalized world space normal Y component with non-uniform scaling support
          // Returns Y component of normalize(worldSpaceNormal), handles zero-length normals (returns 0.0)
          float getWorldNormalY(vec3 n, mat4 matrix) {
            mat3 m = mat3(matrix);
            vec3 scale = vec3(dot(m[0], m[0]), dot(m[1], m[1]), dot(m[2], m[2]));
            vec3 s = n / max(scale, vec3(1e-10));  // Prevent division by zero
            vec3 wn = m * s;
            float lenSq = dot(wn, wn);
            return wn.y * inversesqrt(max(lenSq, 1e-10));
          }

          void main() {
            #ifdef ${USE_INSTANCED_MAP_DEFINE}
              ${INSTANCE_MAP_INDEX_VARYING} = ${INSTANCE_MAP_INDEX_ATTRIBUTE};
            #endif

            #ifdef ${USE_INSTANCED_OPACITY_DEFINE}
              ${INSTANCE_OPACITY_VARYING} = ${INSTANCE_OPACITY_ATTRIBUTE};
            #endif

            #ifdef ${USE_INSTANCED_LIGHT_LEVEL_DEFINE}
              ${INSTANCE_LIGHT_LEVEL_VARYING} = ${INSTANCE_LIGHT_LEVEL_ATTRIBUTE};
            #endif

            #ifdef ${USE_INSTANCED_EMISSIVE_DEFINE}
              ${INSTANCE_EMISSIVE_VARYING} = ${INSTANCE_EMISSIVE_ATTRIBUTE};
            #endif

            ${INSTANCE_SKY_LIGHT_VARYING} = ${INSTANCE_SKY_LIGHT_ATTRIBUTE};
            ${WORLD_NORMAL_Y_VARYING} = getWorldNormalY(normal, instanceMatrix);
        `,
      )
      .replace(
        '#include <color_vertex>',
        `
          #include <color_vertex>
          #if defined( USE_INSTANCING_COLOR ) && !defined( ${USE_INSTANCED_COLOR_DEFINE} )
            // When ${USE_INSTANCED_COLOR_DEFINE} is not defined, reset vColor to default white
            // This counteracts Three.js's automatic instanceColor multiplication
            #ifdef USE_COLOR
              vColor.xyz = color;
            #else
              vColor.xyz = vec3( 1.0 );
            #endif
          #endif
        `
      );

      params.fragmentShader = params.fragmentShader
      .replace(
        'void main() {',
        `
          #ifdef ${USE_INSTANCED_MAP_DEFINE}
            varying float ${INSTANCE_MAP_INDEX_VARYING};
          #endif

          #ifdef ${USE_INSTANCED_OPACITY_DEFINE}
            varying float ${INSTANCE_OPACITY_VARYING};
          #endif

          #ifdef ${USE_INSTANCED_LIGHT_LEVEL_DEFINE}
            varying float ${INSTANCE_LIGHT_LEVEL_VARYING};
          #endif

          #ifdef ${USE_INSTANCED_EMISSIVE_DEFINE}
            varying vec4 ${INSTANCE_EMISSIVE_VARYING};
          #endif

          varying float ${INSTANCE_SKY_LIGHT_VARYING};
          uniform vec3 ${UNIFORM_RAW_AMBIENT_LIGHT_COLOR};
          uniform float ${UNIFORM_AMBIENT_LIGHT_INTENSITY};
          varying float ${WORLD_NORMAL_Y_VARYING};

          void main() {
        `,
      )
      .replace(
        '#include <map_pars_fragment>',
        `
          #if defined( USE_MAP ) && defined( ${USE_INSTANCED_MAP_DEFINE} )
            uniform sampler2DArray map;
          #else
            #include <map_pars_fragment>
          #endif
        `,
      )
      .replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        `
          #ifdef ${USE_INSTANCED_OPACITY_DEFINE}
            vec4 diffuseColor = vec4( diffuse, opacity * ${INSTANCE_OPACITY_VARYING} );
          #else
            vec4 diffuseColor = vec4( diffuse, opacity );
          #endif
        `,
      )
      .replace(
        '#include <map_fragment>',
        `
          #if defined( USE_MAP ) && defined( ${USE_INSTANCED_MAP_DEFINE} )
            vec4 sampledDiffuseColor = texture( map, vec3( vMapUv, ${INSTANCE_MAP_INDEX_VARYING} ) );
            #ifdef DECODE_VIDEO_TEXTURE
              sampledDiffuseColor = vec4( mix( pow( sampledDiffuseColor.rgb * 0.9478672986 + vec3( 0.0521327014 ), vec3( 2.4 ) ), sampledDiffuseColor.rgb * 0.0773993808, vec3( lessThanEqual( sampledDiffuseColor.rgb, vec3( 0.04045 ) ) ) ), sampledDiffuseColor.w );
            #endif
            diffuseColor *= sampledDiffuseColor;
          #else
            #include <map_fragment>
          #endif
        `,
      )
      .replace(
        '#include <opaque_fragment>',
        `
          #include <opaque_fragment>
        `,
      );
    };
  };

  private _createEmissiveOverrideProcessor(): ShaderProcessor {
    return (params: WebGLProgramParametersWithUniforms, _renderer: WebGLRenderer) => {
      // Override emissive color calculation to use instance emissive when USE_INSTANCED_EMISSIVE is defined.
      // This runs after EmissiveMeshBasicMaterial's processor, so we can replace its code.
      params.fragmentShader = params.fragmentShader
        .replace(
          'vec3 totalEmissiveRadiance = emissive;',
          `
            #ifdef ${USE_INSTANCED_EMISSIVE_DEFINE}
              vec3 totalEmissiveRadiance = ${INSTANCE_EMISSIVE_VARYING}.rgb * ${INSTANCE_EMISSIVE_VARYING}.a;
            #else
              vec3 totalEmissiveRadiance = emissive;
            #endif
          `,
        );
    };
  };
}

class InstancedMeshEx extends InstancedMesh {
  public declare material: InstancedMeshBasicMaterial;

  constructor(geometry: BufferGeometry, material: InstancedMeshBasicMaterial, count: number) {
    super(geometry, material, count);
    this._setup();
    this.setColorTexture(material.map);
  }

  private _setup(): void {
    // Performs frustum culling on a per‑original‑mesh basis in Entity, so no additional frustum culling is needed
    // for InstancedMesh. When there is nothing to render, sets it to invisible.
    this.frustumCulled = false;
    this.castShadow = true;
    this.receiveShadow = true;

    // Since InstancedMesh is placed at (0, 0, 0), matrix updates are unnecessary.
    this.matrixAutoUpdate = false;
    this.matrixWorldAutoUpdate = false;

    // Since the instance attributes are updated every animation frame, Dynamic Usage is set as an optimization.
    this.instanceMatrix.setUsage(DynamicDrawUsage);

    // A trick for generating instanceColor. Assumes that count is greater than 0.
    this.setColorAt(0, this.material.color);

    this.instanceColor!.setUsage(DynamicDrawUsage);

    const instanceOpacity = new InstancedBufferAttribute(new Float32Array(this.count), 1);
    instanceOpacity.setUsage(DynamicDrawUsage);
    this.geometry.setAttribute(INSTANCE_OPACITY_ATTRIBUTE, instanceOpacity);

    // If you want to save memory even a little, it might be better to generate it only when it's actually needed.
    const instanceMapIndex = new InstancedBufferAttribute(new Float32Array(this.count), 1);
    instanceMapIndex.setUsage(DynamicDrawUsage);
    this.geometry.setAttribute(INSTANCE_MAP_INDEX_ATTRIBUTE, instanceMapIndex);

    const instanceLightLevel = new InstancedBufferAttribute(new Float32Array(this.count), 1);
    instanceLightLevel.setUsage(DynamicDrawUsage);
    this.geometry.setAttribute(INSTANCE_LIGHT_LEVEL_ATTRIBUTE, instanceLightLevel);

    const instanceSkyLight = new InstancedBufferAttribute(new Float32Array(this.count), 1);
    instanceSkyLight.setUsage(DynamicDrawUsage);
    this.geometry.setAttribute(INSTANCE_SKY_LIGHT_ATTRIBUTE, instanceSkyLight);

    // vec4: rgb = emissive color, a = emissive intensity
    const instanceEmissive = new InstancedBufferAttribute(new Float32Array(this.count * 4), 4);
    instanceEmissive.setUsage(DynamicDrawUsage);
    this.geometry.setAttribute(INSTANCE_EMISSIVE_ATTRIBUTE, instanceEmissive);

    updateAABB(this);
  }

  public setColorTexture(texture: Texture | null): void {
    this.material.setColorTexture(texture);
  }
}

// The glTF 2.0 core specification does not allow using Alpha Blending and
// Alpha mode Mask (Alpha Clipping) together in a single material. However, many
// 3D artists seem to expect to use both. To address this, Hytopia allows their
// combination under specific conditions. This plugin enables that behavior.
// 
// This plugin normalizes loaded glTF materials onto the engine's lit material wrapper
// so imported assets can participate in real lighting and shadow maps.
function shouldUseHeroPhysicalMaterial(sourceMaterial: MeshStandardMaterial | MeshBasicMaterial): boolean {
  if (sourceMaterial.userData?.[HERO_PHYSICAL_USER_DATA_KEY] === true || sourceMaterial.userData?.heroPhysical === true) {
    return true;
  }

  if (!(sourceMaterial instanceof MeshPhysicalMaterial)) {
    return false;
  }

  return sourceMaterial.clearcoat > 0.001
    || sourceMaterial.transmission > 0.001
    || sourceMaterial.iridescence > 0.001
    || sourceMaterial.anisotropy > 0.001
    || sourceMaterial.sheen > 0.001;
}

class GLTFAlphaBlendingAndClippingMaterialPlugin implements GLTFLoaderPlugin {
  private _parser: GLTFParser;
  public name = 'HYTOPIA_ALPHA_BLENDING_AND_CLIPPING';

  constructor(parser: GLTFParser) {
    this._parser = parser;
  }

  async loadMaterial(index: number): Promise<ManagedLitMaterial> {
    // material can be MeshBasicMaterial if the glTF material is with unlit extension.
    const sourceMaterial = await this._parser.loadMaterial(index) as MeshStandardMaterial | MeshBasicMaterial;
    const material = shouldUseHeroPhysicalMaterial(sourceMaterial)
      ? new EmissiveMeshHeroMaterial()
      : new EmissiveMeshBasicMaterial();

    if (sourceMaterial instanceof MeshStandardMaterial) {
      material.copy(sourceMaterial);

      if (material instanceof EmissiveMeshHeroMaterial) {
        material.envMapIntensity = Math.min(material.envMapIntensity, 0.18);
      } else {
        material.envMapIntensity = Math.min(material.envMapIntensity, 0.06);
      }
    } else {
      material.alphaMap = sourceMaterial.alphaMap;
      material.alphaTest = sourceMaterial.alphaTest;
      material.blendDst = sourceMaterial.blendDst;
      material.blendDstAlpha = sourceMaterial.blendDstAlpha;
      material.blendEquation = sourceMaterial.blendEquation;
      material.blendEquationAlpha = sourceMaterial.blendEquationAlpha;
      material.blendSrc = sourceMaterial.blendSrc;
      material.blendSrcAlpha = sourceMaterial.blendSrcAlpha;
      material.blending = sourceMaterial.blending;
      material.color.copy(sourceMaterial.color);
      material.colorWrite = sourceMaterial.colorWrite;
      material.depthTest = sourceMaterial.depthTest;
      material.depthWrite = sourceMaterial.depthWrite;
      material.dithering = sourceMaterial.dithering;
      material.fog = sourceMaterial.fog;
      material.map = sourceMaterial.map;
      material.metalness = 0;
      material.name = sourceMaterial.name;
      material.opacity = sourceMaterial.opacity;
      material.premultipliedAlpha = sourceMaterial.premultipliedAlpha;
      material.roughness = 0.92;
      material.shadowSide = sourceMaterial.shadowSide;
      material.side = sourceMaterial.side;
      material.toneMapped = sourceMaterial.toneMapped;
      material.transparent = Boolean(sourceMaterial.transparent);
      material.userData = sourceMaterial.userData;
      material.vertexColors = sourceMaterial.vertexColors;
      material.visible = sourceMaterial.visible;
      material.wireframe = sourceMaterial.wireframe;
      material.envMapIntensity = 0.04;
    }

    // When Alpha Clipping (Alpha Test) is enabled, the glTF loader follows the
    // glTF spec and does not set transparent = true, meaning Alpha Blending
    // is not enabled. However, if the material's final alpha values (opacity for
    // non-textured materials, or texture alpha * opacity for textured materials)
    // would result in semi-transparent rendering (i.e., values that pass the alpha
    // test but are less than 1.0), we assume the asset author intended semi-transparency,
    // and we enable Alpha Blending by setting transparent = true. Therefore, both
    // Alpha Blending and Alpha Clipping will be enabled.
    //
    // Naturally, this behavior is no longer compliant with the glTF spec, and
    // could result in unintended transparency if the asset author was familiar
    // with the spec and did not intend blending. In such cases, the rendered
    // result may differ from the authors expectation and other standard glTF
    // viewers, violating glTF's goal of visual portability across platforms.
    // If this becomes an issue, the conditions for enabling blending should be
    // revisited.
    
    // Check for transparency metadata embedded by the model optimizer process on the server
    // The GLTFLoader automatically copies material.extras to material.userData during parsing
    const hasTextureTransparency = material.userData?.hasTransparency === true;
    
    if (material.alphaTest > 0 &&
      (
        (!material.map && material.opacity >= material.alphaTest && material.opacity < 1.0) ||
        (material.map && material.opacity > 0 && hasTextureTransparency)
      )
    ) {
      material.transparent = true;
    }

    // Dispose the original source material since we're using the lit engine wrapper instead.
    sourceMaterial.dispose();

    return material;
  }
};

Assets.gltfLoader.register(parser => new GLTFAlphaBlendingAndClippingMaterialPlugin(parser));

const BYTES_PER_PIXEL = 4;

const SOURCE_USER_DATA = 'userData';
const SOURCE_CONTENTS = 'sourceContents';
type SourceContents = {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
};

interface SourceEx extends Source<unknown> {
  [SOURCE_USER_DATA]: {
    [SOURCE_CONTENTS]: SourceContents;
  };
};

// The GLTFManager allows the textures of a cloned glTF model to be switched to custom textures.
// Even when custom textures are used, Texture Array is utilized to enable the use of InstancedMesh
// for high-performance rendering. This allows multiple textures used across different cloned
// meshes/materials to be rendered at once using a single InstancedMesh.
class InstancedTexture extends DataArrayTexture {
  private _indexMap: Map<Source<unknown>, number> = new Map();
  private _usedIndexSet: Set<number> = new Set();

  constructor(texture: Texture, depth: number) {
    const { width, height } = getTextureSize(texture);
    super(new Uint8ClampedArray(width * height * depth * BYTES_PER_PIXEL), width, height, depth);
    this.mapping = texture.mapping;
    this.wrapS = texture.wrapS;
    this.wrapT = texture.wrapT;
    this.magFilter = texture.magFilter;
    this.minFilter = texture.minFilter;
    this.flipY = texture.flipY;
    this.colorSpace = texture.colorSpace;
  }

  public update(textureSet: Set<Texture>, renderer: WebGLRenderer): void {
    const sourceSet = new Set(Array.from(textureSet).map(texture => texture.source));

    Array.from(this._indexMap.keys()).forEach(source => {
      if (!sourceSet.has(source)) {
        this._usedIndexSet.delete(this._indexMap.get(source)!);
        this._indexMap.delete(source);
      }
    });

    let currentIndex = 0;
    textureSet.forEach(texture => {
      const source = texture.source;
      if (!this._indexMap.has(source)) {
        if (!(SOURCE_USER_DATA in source)) {
          const { width, height, pixels } = (texture instanceof CompressedTexture) ? readPixelsFromCompressedTexture(texture, renderer) : readPixelsFromRegularTexture(texture);

          // To reduce the cost of loading image content, content is cached. While directly polluting Three.js
          // objects with non-existent properties is not ideal from a maintainability standpoint, it's probably
          // the simplest approach for now, so this is how it's currently implemented. If a better method comes
          // to mind, it should definitely be switched over.
          (source as SourceEx)[SOURCE_USER_DATA] = {
            [SOURCE_CONTENTS]: { width, height, pixels },
          };
        }

        while (this._usedIndexSet.has(currentIndex)) {
          currentIndex++;
        }

        if (currentIndex >= this.image.depth) {
          // Shouldn't happen but just in case
          throw new Error(`InstancedTexture: Out of depth, InstancedTexture.depth: ${this.image.depth}, index: ${currentIndex}, texture source: ${source.uuid}.`);
        }

        this._indexMap.set(source, currentIndex);
        this._usedIndexSet.add(currentIndex);

        const { width: sourceWidth, height: sourceHeight, pixels } = (source as SourceEx)[SOURCE_USER_DATA][SOURCE_CONTENTS];
        const { width, height, data } = this.image;
        if (data === null) {
          throw new Error(`InstancedTexture: Expected image data buffer for texture source ${source.uuid}.`);
        }
        const offset = width * height * BYTES_PER_PIXEL * currentIndex;

        if (width !== sourceWidth || height !== sourceHeight) {
          // Shouldn't happen but just in case
          throw new Error(`InstancedTexture: Custom Texture size ${sourceWidth}x${sourceHeight} doesn't match the original one ${width}x${height}, texture source ${source.uuid}.`);
        }

        for (let i = 0; i < pixels.length; i++) {
          data[offset + i] = pixels[i];
        }

        this.needsUpdate = true;
      }
    });
  }

  public getIndex(source: Source<unknown>): number {
    if (!this._indexMap.has(source)) {
      throw new Error(`InstancedTexture.getIndex(): Unknown Source ${source.uuid}`);
    }
    return this._indexMap.get(source)!;
  }
}

type InstancedMeshPair = {
  opaque: InstancedMeshEx;
  transparent: InstancedMeshEx;
};

type InstancedMeshUsageState = {
  lastTransparentSortCameraPosX: number;
  lastTransparentSortCameraPosY: number;
  lastTransparentSortCameraPosZ: number;
  lastTransparentSortFrame: number;
  lastTransparentSortCount: number;
  lastTransparentSortViewDirX: number;
  lastTransparentSortViewDirY: number;
  lastTransparentSortViewDirZ: number;
  prevOpaqueIndex: number;
  prevTransparentIndex: number;
};

type SourceMeshAttributeCounters = {
  nonDefaultOpacity: number;
  nonDefaultColor: number;
  nonDefaultEmissive: number;
};

type SourceMeshCloneBuckets = {
  all: Set<Mesh>;
  opaque: Set<Mesh>;
  transparent: Set<Mesh>;
};

type CachedInstanceState = {
  lastIndex: number;
  lastInstancedMesh: InstancedMeshEx | null;
  matrixSnapshot: Float32Array;
  skyLight: number;
  colorR: number;
  colorG: number;
  colorB: number;
  opacity: number;
  lightLevel: number;
  emissiveR: number;
  emissiveG: number;
  emissiveB: number;
  emissiveIntensity: number;
};

// Necessary to keep track of various information for resource management.
// TODO: The current resource management might be more complex than necessary.
// Simplify if possible.
type GLTFEntry = {
  clonedGltfPromiseSet: Set<Promise<GLTF>>;
  clonedGltfSet: Set<GLTF>;
  clonedToSourceMesh: Map<Mesh, Mesh>;
  gltf: GLTF | null,
  gltfPromise: Promise<GLTF>;
  localBoundingBox: Box3 | null;
  modelCenter: Vector3 | null;
  needsInstancedTextureRefresh: boolean;
  sourceMeshSet: Set<Mesh>;
  sourceTextureToCustomTextures: Map<Texture /* source texture */, Map<Texture /* custom texture */, { referenceCount: number, texture: Texture /* cloned custom texture */}>>;
  sourceTextureToInstancedTextures: Map<Texture, InstancedTexture>;
  sourceToCloneBuckets: Map<Mesh, SourceMeshCloneBuckets>;
  sourceToInstancedMeshes: Map<Mesh, InstancedMeshPair[]>;
  sourceToInstancedMeshUsageState: Map<Mesh, InstancedMeshUsageState>;
  sourceToAttributeCounters: Map<Mesh, SourceMeshAttributeCounters>;
  uri: string;
};

// GLTFManager handles the loading and releasing of glTF models. It has the following features:
// * Maintains a cache of GLTF models. If the same model is requested before it is released,
//   it creates a clone from the cache, avoiding unnecessary network access.
// * Applies InstancedMesh for efficient rendering when the number of clones of a GLTF model
//   exceeds a certain threshold, grouping them for batch rendering.
// * Dynamically creates the InstancedMesh to fit the appropriate size.
//
// Overall, GLTFManager assumes that the hierarchy of cloned glTF models will not change,
// nor will Object3D instances within the hierarchy be replaced. Note that this reduces
// flexibility within the client in exchange for simplicity and performance improvements.
export default class GLTFManager {
  private _game: Game;

  private _uriToEntry: Map<string, GLTFEntry> = new Map();
  private _gltfToEntry: Map<Promise<GLTF> | GLTF, GLTFEntry> = new Map();
  private _sourceMeshToEntry: Map<Mesh, GLTFEntry> = new Map();
  private _clonedMeshToSourceMesh: Map<Mesh, Mesh> = new Map();
  private _instanceStateCache: WeakMap<Mesh, CachedInstanceState> = new WeakMap();

  constructor(game: Game) {
    this._game = game;
  }

  private _getOrCreateCloneBuckets(entry: GLTFEntry, sourceMesh: Mesh): SourceMeshCloneBuckets {
    let cloneBuckets = entry.sourceToCloneBuckets.get(sourceMesh);
    if (!cloneBuckets) {
      cloneBuckets = {
        all: new Set(),
        opaque: new Set(),
        transparent: new Set(),
      };
      entry.sourceToCloneBuckets.set(sourceMesh, cloneBuckets);
    }
    return cloneBuckets;
  }

  private _registerClonedMesh(entry: GLTFEntry, sourceMesh: Mesh, clonedMesh: Mesh): SourceMeshCloneBuckets {
    const cloneBuckets = this._getOrCreateCloneBuckets(entry, sourceMesh);
    cloneBuckets.all.add(clonedMesh);
    if (this._isMeshTransparent(clonedMesh)) {
      cloneBuckets.transparent.add(clonedMesh);
    } else {
      cloneBuckets.opaque.add(clonedMesh);
    }
    return cloneBuckets;
  }

  private _moveClonedMeshTransparencyBucket(
    entry: GLTFEntry,
    sourceMesh: Mesh,
    clonedMesh: Mesh,
    transparent: boolean,
  ): SourceMeshCloneBuckets {
    const cloneBuckets = this._getOrCreateCloneBuckets(entry, sourceMesh);
    cloneBuckets.all.add(clonedMesh);
    if (transparent) {
      cloneBuckets.opaque.delete(clonedMesh);
      cloneBuckets.transparent.add(clonedMesh);
    } else {
      cloneBuckets.transparent.delete(clonedMesh);
      cloneBuckets.opaque.add(clonedMesh);
    }
    return cloneBuckets;
  }

  private _getMeshMaterials(mesh: Mesh): ManagedLitMaterial[] {
    return (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as ManagedLitMaterial[];
  }

  private _isMeshTransparent(mesh: Mesh): boolean {
    const materials = this._getMeshMaterials(mesh);
    for (let i = 0; i < materials.length; i++) {
      if (materials[i].transparent) {
        return true;
      }
    }

    return false;
  }

  private _getMaterialPair(
    clonedMesh: Mesh,
    materialIndex: number,
  ): {
    sourceMesh: Mesh;
    sourceMaterial: ManagedLitMaterial;
    clonedMaterial: ManagedLitMaterial;
  } {
    const sourceMesh = this._clonedMeshToSourceMesh.get(clonedMesh);
    if (!sourceMesh) {
      throw new Error(`GLTFManager: Unknown cloned mesh ${clonedMesh.uuid}.`);
    }

    const sourceMaterials = this._getMeshMaterials(sourceMesh);
    const clonedMaterials = this._getMeshMaterials(clonedMesh);
    const sourceMaterial = sourceMaterials[materialIndex];
    const clonedMaterial = clonedMaterials[materialIndex];

    if (!sourceMaterial || !clonedMaterial) {
      throw new Error(
        `GLTFManager: Material index ${materialIndex} is out of range for cloned mesh ${clonedMesh.uuid}.`,
      );
    }

    return { sourceMesh, sourceMaterial, clonedMaterial };
  }

  private _replaceClonedMaterialAt(
    clonedMesh: Mesh,
    materialIndex: number,
    material: ManagedLitMaterial,
  ): void {
    if (!Array.isArray(clonedMesh.material)) {
      clonedMesh.material = material;
      return;
    }

    const nextMaterials = clonedMesh.material.slice() as ManagedLitMaterial[];
    nextMaterials[materialIndex] = material;
    clonedMesh.material = nextMaterials;
  }

  private _createInstancedMeshUsageState(): InstancedMeshUsageState {
    return {
      lastTransparentSortCameraPosX: Number.NaN,
      lastTransparentSortCameraPosY: Number.NaN,
      lastTransparentSortCameraPosZ: Number.NaN,
      prevOpaqueIndex: -1,
      prevTransparentIndex: -1,
      lastTransparentSortFrame: -1,
      lastTransparentSortCount: -1,
      lastTransparentSortViewDirX: Number.NaN,
      lastTransparentSortViewDirY: Number.NaN,
      lastTransparentSortViewDirZ: Number.NaN,
    };
  }

  private _getInstancedMeshCapacity(cloneCount: number): number {
    if (cloneCount <= USE_INSTANCED_MESH_THRESHOLD) {
      return 0;
    }

    let capacity = USE_INSTANCED_MESH_THRESHOLD * INSTANCED_MESH_RESIZE_INCREASE_FACTOR;
    while (cloneCount > capacity) {
      capacity *= INSTANCED_MESH_RESIZE_INCREASE_FACTOR;
    }

    return capacity;
  }

  private _createInstancedMeshPair(
    sourceMesh: Mesh,
    opaqueMaterial: InstancedMeshBasicMaterial,
    transparentMaterial: InstancedMeshBasicMaterial,
    count: number,
  ): InstancedMeshPair {
    return {
      opaque: new InstancedMeshEx(sourceMesh.geometry.clone(), opaqueMaterial, count),
      transparent: new InstancedMeshEx(sourceMesh.geometry.clone(), transparentMaterial, count),
    };
  }

  private _disposeInstancedMeshPair(pair: InstancedMeshPair, disposeMaterials: boolean): void {
    this._game.renderer.removeFromScene(pair.opaque);
    this._game.renderer.removeFromScene(pair.transparent);
    pair.opaque.dispose();
    pair.opaque.geometry.dispose();
    pair.transparent.dispose();
    pair.transparent.geometry.dispose();

    if (disposeMaterials) {
      pair.opaque.material.dispose();
      pair.transparent.material.dispose();
    }
  }

  private _replaceInstancedMeshPair(
    entry: GLTFEntry,
    sourceMesh: Mesh,
    count: number,
    opaqueMaterial: InstancedMeshBasicMaterial,
    transparentMaterial: InstancedMeshBasicMaterial,
  ): void {
    const existingPairs = entry.sourceToInstancedMeshes.get(sourceMesh) ?? [];
    for (let i = 0; i < existingPairs.length; i++) {
      this._disposeInstancedMeshPair(existingPairs[i], false);
    }

    existingPairs.length = 0;
    existingPairs.push(this._createInstancedMeshPair(sourceMesh, opaqueMaterial, transparentMaterial, count));
    entry.sourceToInstancedMeshes.set(sourceMesh, existingPairs);

    const usage = entry.sourceToInstancedMeshUsageState.get(sourceMesh);
    if (usage) {
      usage.prevOpaqueIndex = -1;
      usage.prevTransparentIndex = -1;
      usage.lastTransparentSortFrame = -1;
      usage.lastTransparentSortCount = -1;
    }
  }

  private _materialMatchesSource(
    clonedMaterial: ManagedLitMaterial,
    sourceMaterial: ManagedLitMaterial,
  ): boolean {
    return clonedMaterial.transparent === sourceMaterial.transparent
      && clonedMaterial.opacity === sourceMaterial.opacity
      && clonedMaterial.alphaTest === sourceMaterial.alphaTest
      && clonedMaterial.color.equals(sourceMaterial.color)
      && clonedMaterial.customEmissive.equals(sourceMaterial.customEmissive)
      && clonedMaterial.customEmissiveIntensity === sourceMaterial.customEmissiveIntensity
      && clonedMaterial.map === sourceMaterial.map;
  }

  private _tryRestoreSharedMaterial(clonedMesh: Mesh, materialIndex: number = 0): boolean {
    const { sourceMesh, sourceMaterial, clonedMaterial } = this._getMaterialPair(clonedMesh, materialIndex);

    if (clonedMaterial === sourceMaterial) {
      return false;
    }

    if (!this._materialMatchesSource(clonedMaterial, sourceMaterial)) {
      return false;
    }

    if (!Array.isArray(clonedMesh.material) || !Array.isArray(sourceMesh.material)) {
      clonedMesh.material = sourceMesh.material;
      clonedMaterial.dispose();
      return true;
    }

    const nextMaterials = clonedMesh.material.slice() as ManagedLitMaterial[];
    nextMaterials[materialIndex] = sourceMaterial;
    const sourceMaterials = sourceMesh.material as ManagedLitMaterial[];
    const allShared = nextMaterials.length === sourceMaterials.length
      && nextMaterials.every((material, index) => material === sourceMaterials[index]);

    clonedMesh.material = allShared ? sourceMesh.material : nextMaterials;
    clonedMaterial.dispose();
    return true;
  }

  public ensureOwnMaterial(clonedMesh: Mesh, materialIndex: number = 0): ManagedLitMaterial {
    const { sourceMaterial, clonedMaterial } = this._getMaterialPair(clonedMesh, materialIndex);

    if (clonedMaterial !== sourceMaterial) {
      return clonedMaterial;
    }

    const uniqueMaterial = sourceMaterial.clone();

    // Preserve non-serializable default material metadata for copy-on-write clones.
    uniqueMaterial.userData = {
      ...sourceMaterial.userData,
    };

    this._replaceClonedMaterialAt(clonedMesh, materialIndex, uniqueMaterial);
    return uniqueMaterial;
  }

  private _createEntry(uri: string): void {
    const gltfPromise = Assets.gltfLoader.loadAsync(uri);

    const entry: GLTFEntry = {
      clonedGltfPromiseSet: new Set(),
      clonedGltfSet: new Set(),
      clonedToSourceMesh: new Map(),
      gltf: null,
      gltfPromise,
      localBoundingBox: null,
      modelCenter: null,
      needsInstancedTextureRefresh: false,
      sourceMeshSet: new Set(),
      sourceTextureToCustomTextures: new Map(),
      sourceTextureToInstancedTextures: new Map(),
      sourceToCloneBuckets: new Map(),
      sourceToInstancedMeshes: new Map(),
      sourceToInstancedMeshUsageState: new Map(),
      sourceToAttributeCounters: new Map(),
      uri,
    };

    gltfPromise.then(gltf => {
      const localBoundingBox = new Box3().setFromObject(gltf.scene, true);
      entry.localBoundingBox = localBoundingBox;
      entry.modelCenter = localBoundingBox.getCenter(new Vector3());

      if (!this._game.inDebugMode) {
        return;
      }

      let nodeCount = 0;
      let meshCount = 0;
      const materials = new Set();

      gltf.scene.traverse(obj => {
        nodeCount++;
        if (obj instanceof Mesh) {
          meshCount++;
          materials.add(obj.material);
        }
      });

      console.log(`glTF model analysis: URL=${uri}, NodeCount=${nodeCount}, MeshCount=${meshCount}, MaterialCount=${materials.size}.`);
    }).catch(() => undefined);

    this._uriToEntry.set(uri, entry);

    GLTFStats.fileCount = this._uriToEntry.size;
  }

  private _releaseEntry(entry: GLTFEntry): void {
    if (entry.gltf) {
      this._disposeGltf(entry.gltf);
    }
    this._uriToEntry.delete(entry.uri);

    GLTFStats.fileCount = this._uriToEntry.size;

    // To prevent memory leaks caused by circular references.
    entry.clonedGltfPromiseSet.clear();
    entry.clonedGltfSet.clear();

    for (const clonedMesh of entry.clonedToSourceMesh.keys()) {
      this._clonedMeshToSourceMesh.delete(clonedMesh);
    }

    for (const sourceMesh of entry.sourceMeshSet) {
      this._sourceMeshToEntry.delete(sourceMesh);
    }

    entry.clonedToSourceMesh.clear();
    entry.gltf = null;
    entry.localBoundingBox = null;
    entry.modelCenter = null;

    entry.sourceMeshSet.clear();
    entry.sourceToCloneBuckets.clear();
    entry.sourceToInstancedMeshes.clear();
    entry.sourceToInstancedMeshUsageState.clear();
    entry.sourceToAttributeCounters.clear();

    entry.sourceTextureToInstancedTextures.forEach(texture => texture.dispose());
    entry.sourceTextureToInstancedTextures.clear();
  }

  private _disposeGltf(gltf: GLTF): void {
    gltf.scene.traverse(obj => {
      if (obj instanceof Mesh) {
        obj.geometry.dispose();
        const materials = Array.isArray(obj.material) ? obj.material : [obj.material];

        for (let i = 0; i < materials.length; i++) {
          const material = materials[i];
          material.dispose();

          for (const key in material) {
            const value = material[key];
            if (value instanceof Texture) {
              value.dispose();
            }
          }
        }
      }
    });
  }

  // Apply InstancedMesh when the number of cloned meshes exceeds a threshold. Additionally,
  // if the number of cloned Meshes exceeds the threshold, create a larger InstancedMesh.
  private _applyInstancedMesh(entry: GLTFEntry, clonedGltf: GLTF): void {
    const sourceGltf = entry.gltf!

    // TODO: Needs to take GLTF extensions into account. For example, with the
    // EXT_mesh_gpu_instancing extension the glTF scene may include InstancedMesh and
    // it needs to be handled appropriately.
    const traverse = (sourceObj: Object3D, clonedObj: Object3D): void => {
      if (sourceObj instanceof Mesh) {
        const sourceMesh = sourceObj as Mesh;
        const clonedMesh = clonedObj as Mesh;

        entry.sourceMeshSet.add(sourceMesh);
        entry.clonedToSourceMesh.set(clonedMesh, sourceMesh);

        this._sourceMeshToEntry.set(sourceMesh, entry);
        this._clonedMeshToSourceMesh.set(clonedMesh, sourceMesh);

        if (!entry.sourceToAttributeCounters.has(sourceMesh)) {
          entry.sourceToAttributeCounters.set(sourceMesh, {
            nonDefaultOpacity: 0,
            nonDefaultColor: 0,
            nonDefaultEmissive: 0,
          });
        }

        const cloneBuckets = this._getOrCreateCloneBuckets(entry, sourceMesh);

        const skipInstancing = Array.isArray(sourceMesh.material)
          || Array.isArray(clonedMesh.material)
          || this._getMeshMaterials(sourceMesh).some(material => material instanceof EmissiveMeshHeroMaterial);

        if (!skipInstancing) {
          const desiredCapacity = this._getInstancedMeshCapacity(cloneBuckets.all.size + 1);
          const instancedMeshPairs = entry.sourceToInstancedMeshes.get(sourceMesh);
          const currentCapacity = instancedMeshPairs?.[0]?.opaque.instanceMatrix.count ?? 0;

          if (desiredCapacity > 0 && desiredCapacity !== currentCapacity) {
            let opaqueMaterial: InstancedMeshBasicMaterial;
            let transparentMaterial: InstancedMeshBasicMaterial;
            const createdInstancedMeshes = !instancedMeshPairs;

            if (createdInstancedMeshes) {
              opaqueMaterial = new InstancedMeshBasicMaterial(sourceMesh.material as ManagedLitMaterial, this._game);
              opaqueMaterial.transparent = false;
              transparentMaterial = new InstancedMeshBasicMaterial(sourceMesh.material as ManagedLitMaterial, this._game);
              transparentMaterial.transparent = true;
              entry.sourceToInstancedMeshUsageState.set(sourceMesh, this._createInstancedMeshUsageState());
              GLTFStats.instancedMeshCount++;
            } else {
              opaqueMaterial = instancedMeshPairs[0].opaque.material;
              transparentMaterial = instancedMeshPairs[0].transparent.material;
            }

            this._replaceInstancedMeshPair(entry, sourceMesh, desiredCapacity, opaqueMaterial, transparentMaterial);
            this._updateShaderDefines(entry, sourceMesh);

            if (createdInstancedMeshes) {
              cloneBuckets.opaque.forEach(existingClonedMesh => {
                this._setClonedMeshDefaultLayerEnabled(existingClonedMesh, false);
              });
            }
          }
        }

        this._registerClonedMesh(entry, sourceMesh, clonedMesh);

        if (!skipInstancing && entry.sourceToInstancedMeshes.has(sourceMesh) && !(clonedMesh.material as ManagedLitMaterial).transparent) {
          this._setClonedMeshDefaultLayerEnabled(clonedMesh, false);
        }
      }

      for (let i = 0; i < sourceObj.children.length; i++) {
        traverse(sourceObj.children[i], clonedObj.children[i]);
      }      
    };

    traverse(sourceGltf.scene, clonedGltf.scene);
  }

  // Replaces the textures of the cloned glTF model with custom textures. Assumes
  // that all meshes/materials within the model use the same texture.
  public attachCustomTexture(clonedGltf: GLTF, texture: Texture): void {
    if (!this._gltfToEntry.has(clonedGltf)) {
      throw new Error(`GLTFManager.attachCustomTexture(): Unknown glTF ${clonedGltf.scene.uuid}`);
    }
    const entry = this._gltfToEntry.get(clonedGltf)!;

    clonedGltf.scene.traverse(obj => {
      if (!(obj instanceof Mesh)) {
        return;
      }

      const clonedMesh = obj as Mesh;
      const sourceMesh = entry.clonedToSourceMesh.get(clonedMesh);

      if (!sourceMesh) {
        return;
      }

      const sourceMaterials = this._getMeshMaterials(sourceMesh);
      for (let materialIndex = 0; materialIndex < sourceMaterials.length; materialIndex++) {
        const sourceMaterial = sourceMaterials[materialIndex];

        if (!sourceMaterial.map) {
          continue;
        }

        if (sourceMaterial.map.image === null || texture.image === null) {
          throw new Error(`GLTFManager: Source texture ${sourceMaterial.map.uuid} or Custom texture ${texture.uuid} is not ready yet.`);
        }

        const sourceSize = getTextureSize(sourceMaterial.map);
        const customSize = getTextureSize(texture);

        if (sourceSize.width !== customSize.width || sourceSize.height !== customSize.height) {
          throw new Error(`GLTFManager: Custom texture size ${customSize.width}x${customSize.height} doesn't match the original one ${sourceSize.width}x${sourceSize.height}, Custom texture: ${texture.uuid}.`);
        }

        if (!entry.sourceTextureToCustomTextures.has(sourceMaterial.map)) {
          entry.sourceTextureToCustomTextures.set(sourceMaterial.map, new Map());
        }
        const clonedCustomTextures = entry.sourceTextureToCustomTextures.get(sourceMaterial.map)!;

        if (!clonedCustomTextures.has(texture)) {
          const clonedTexture = texture.clone();
          clonedTexture.mapping = sourceMaterial.map.mapping;
          clonedTexture.wrapS = sourceMaterial.map.wrapS;
          clonedTexture.wrapT = sourceMaterial.map.wrapT;
          clonedTexture.magFilter = sourceMaterial.map.magFilter;
          clonedTexture.minFilter = sourceMaterial.map.minFilter;
          clonedTexture.flipY = sourceMaterial.map.flipY;
          clonedTexture.colorSpace = sourceMaterial.map.colorSpace;
          clonedCustomTextures.set(texture, { referenceCount: 0, texture: clonedTexture });
        }

        const clonedCustomTextureEntry = clonedCustomTextures.get(texture)!;
        const clonedMaterial = this.ensureOwnMaterial(clonedMesh, materialIndex);
        clonedMaterial.map = clonedCustomTextureEntry.texture;
        clonedCustomTextureEntry.referenceCount++;
      }
    });

    entry.needsInstancedTextureRefresh = true;
  }

  public detachCustomTexture(clonedGltf: GLTF, texture: Texture): void {
    if (!this._gltfToEntry.has(clonedGltf)) {
      throw new Error(`GLTFManager.detachCustomTexture(): Unknown glTF ${clonedGltf.scene.uuid}`);
    }
    const entry = this._gltfToEntry.get(clonedGltf)!;

    clonedGltf.scene.traverse(obj => {
      if (!(obj instanceof Mesh)) {
        return;
      }

      const clonedMesh = obj as Mesh;
      const sourceMesh = entry.clonedToSourceMesh.get(clonedMesh);

      if (!sourceMesh) {
        return;
      }

      const sourceMaterials = this._getMeshMaterials(sourceMesh);
      for (let materialIndex = 0; materialIndex < sourceMaterials.length; materialIndex++) {
        const sourceMaterial = sourceMaterials[materialIndex];

        if (!sourceMaterial.map) {
          continue;
        }

        const clonedCustomTextures = entry.sourceTextureToCustomTextures.get(sourceMaterial.map);

        if (!clonedCustomTextures) {
          throw new Error(`GLTFManager.detachCustomTexture(): Source Texture ${sourceMaterial.map.uuid} has no custom textures.`);
        }

        const clonedCustomTextureEntry = clonedCustomTextures.get(texture);

        if (!clonedCustomTextureEntry) {
          throw new Error(`GLTFManager.detachCustomTexture(): Custom Texture ${texture.uuid} is not found for Source Texture ${sourceMaterial.map.uuid}.`);
        }

        clonedCustomTextureEntry.referenceCount--;

        if (clonedCustomTextureEntry.referenceCount === 0) {
          clonedCustomTextureEntry.texture.dispose();
          clonedCustomTextures.delete(texture);

          if (clonedCustomTextures.size === 0) {
            entry.sourceTextureToCustomTextures.delete(sourceMaterial.map);
          }
        }

        const clonedMaterial = this.ensureOwnMaterial(clonedMesh, materialIndex);
        clonedMaterial.map = sourceMaterial.map;
        this._tryRestoreSharedMaterial(clonedMesh, materialIndex);
      }
    });

    entry.needsInstancedTextureRefresh = true;
  }

  public async load(uri: string): Promise<GLTF> {
    if (!this._uriToEntry.has(uri)) {
      this._createEntry(uri);
    }

    const entry = this._uriToEntry.get(uri)!;
    const gltfPromise = entry.gltfPromise;

    const clonedGltfPromise = new Promise<GLTF>((resolve, reject) => {
      gltfPromise.then(gltf => {
        this._gltfToEntry.delete(clonedGltfPromise);

        // If this request has already been canceled, nothing to do.
        if (!entry.clonedGltfPromiseSet.has(clonedGltfPromise)) {
          return;
        }

        entry.gltf = gltf;
        entry.clonedGltfPromiseSet.delete(clonedGltfPromise);

        const clonedGltf = Object.assign({}, gltf);
        clonedGltf.scene = gltf.scene.clone();

        let meshCount = 0;

        clonedGltf.scene.traverse(obj => {
          if (obj instanceof Mesh) {
            meshCount++;
          }
        });

        if (entry.clonedGltfSet.size === 0) {
          GLTFStats.sourceMeshCount += meshCount;
        }
        GLTFStats.clonedMeshCount += meshCount;

        entry.clonedGltfSet.add(clonedGltf);

        this._gltfToEntry.set(clonedGltf, entry);

        this._applyInstancedMesh(entry, clonedGltf);

        // The model's default texture contents may not be included in the
        // InstancedTexture, so set needsInstancedTextureRefresh = true.
        // TODO: Can we set it to true only when necessary?
        entry.needsInstancedTextureRefresh = true;

        resolve(clonedGltf);
      }).catch(error => {
        this._gltfToEntry.delete(clonedGltfPromise);

        const wasPending = entry.clonedGltfPromiseSet.has(clonedGltfPromise);
        entry.clonedGltfPromiseSet.delete(clonedGltfPromise);

        if (!wasPending) {
          return;
        }

        if (!entry.gltf && entry.clonedGltfSet.size === 0 && entry.clonedGltfPromiseSet.size === 0) {
          this._uriToEntry.delete(entry.uri);
          GLTFStats.fileCount = this._uriToEntry.size;
        }

        reject(error);
      });
    });

    entry.clonedGltfPromiseSet.add(clonedGltfPromise);
    this._gltfToEntry.set(clonedGltfPromise, entry);

    return clonedGltfPromise;
  }

  public getModelBounds(gltf: GLTF): { localBoundingBox: Box3; modelCenter: Vector3 } | undefined {
    const entry = this._gltfToEntry.get(gltf);
    if (!entry?.localBoundingBox || !entry.modelCenter) {
      return undefined;
    }

    return {
      localBoundingBox: entry.localBoundingBox.clone(),
      modelCenter: entry.modelCenter.clone(),
    };
  }

  // A method to cancel the loading of a glTF model before it completes
  public cancel(clonedGltfPromise: Promise<GLTF>, quiet?: boolean): boolean {
    if (!this._gltfToEntry.has(clonedGltfPromise)) {
      // TODO: Better error handling?
      if (quiet !== true) {
        console.warn(`Already resolved or Unknown glTF Promise.`, clonedGltfPromise);
      }
      return false;
    }

    const entry = this._gltfToEntry.get(clonedGltfPromise)!;
    entry.clonedGltfPromiseSet.delete(clonedGltfPromise);

    if (entry.clonedGltfSet.size === 0 && entry.clonedGltfPromiseSet.size === 0 && entry.gltf) {
      this._releaseEntry(entry);
    }

    return true;
  }

  // A method to release cloned glTF models. If the number of cloned meshes drops below a
  // certain threshold, replace the InstancedMesh with a new instance to resize its count,
  // or stop using InstancedMesh. If all cloned glTFs are released, the cache is also cleared.
  public release(clonedGltf: GLTF): boolean {
    if (!this._gltfToEntry.has(clonedGltf)) {
      // TODO: Better error handling?
      console.warn(`Unknown glTF.`, clonedGltf);
      return false;
    }

    const entry = this._gltfToEntry.get(clonedGltf)!;
    let meshCount = 0;

    clonedGltf.scene.traverse(clonedObj => {
      if (clonedObj instanceof Mesh) {
        meshCount++;

        const clonedMesh = clonedObj as Mesh;
        const sourceMesh = entry.clonedToSourceMesh.get(clonedMesh);

        // Just in case
        if (!sourceMesh) {
          return;
        }

        const counters = entry.sourceToAttributeCounters.get(sourceMesh);

        if (!counters) {
          console.warn(`GLTFManager.release(): Client implementation error. counters not found for sourceMesh.`);
        } else {
          const sourceMaterials = this._getMeshMaterials(sourceMesh);
          const clonedMaterials = this._getMeshMaterials(clonedMesh);

          for (let materialIndex = 0; materialIndex < clonedMaterials.length; materialIndex++) {
            const clonedMaterial = clonedMaterials[materialIndex];
            const sourceMaterial = sourceMaterials[materialIndex];
            if (!sourceMaterial || clonedMaterial === sourceMaterial) {
              continue;
            }

            if (clonedMaterial.opacity !== sourceMaterial.opacity) {
              if (counters.nonDefaultOpacity > 0) {
                counters.nonDefaultOpacity--;
                if (counters.nonDefaultOpacity === 0) {
                  this._updateShaderDefines(entry, sourceMesh);
                }
              } else {
                console.warn(`GLTFManager.release(): Client implementation error. nonDefaultOpacity counter is already 0.`);
              }
            }

            if (!clonedMaterial.color.equals(sourceMaterial.color)) {
              if (counters.nonDefaultColor > 0) {
                counters.nonDefaultColor--;
                if (counters.nonDefaultColor === 0) {
                  this._updateShaderDefines(entry, sourceMesh);
                }
              } else {
                console.warn(`GLTFManager.release(): Client implementation error. nonDefaultColor counter is already 0.`);
              }
            }

            const emissiveColorDiffers = !clonedMaterial.customEmissive.equals(sourceMaterial.customEmissive);
            const emissiveIntensityDiffers = clonedMaterial.customEmissiveIntensity !== sourceMaterial.customEmissiveIntensity;
            if (emissiveColorDiffers || emissiveIntensityDiffers) {
              if (counters.nonDefaultEmissive > 0) {
                counters.nonDefaultEmissive--;
                if (counters.nonDefaultEmissive === 0) {
                  this._updateShaderDefines(entry, sourceMesh);
                }
              } else {
                console.warn(`GLTFManager.release(): Client implementation error. nonDefaultEmissive counter is already 0.`);
              }
            }

            clonedMaterial.dispose();
          }
        }

        const cloneBuckets = entry.sourceToCloneBuckets.get(sourceMesh)!;
        cloneBuckets.all.delete(clonedMesh);
        cloneBuckets.opaque.delete(clonedMesh);
        cloneBuckets.transparent.delete(clonedMesh);
        this._clonedMeshToSourceMesh.delete(clonedMesh);

        if (entry.sourceToInstancedMeshes.has(sourceMesh)) {
          const instancedMeshPairs = entry.sourceToInstancedMeshes.get(sourceMesh)!;
          const currentPair = instancedMeshPairs[0];
          const desiredCapacity = this._getInstancedMeshCapacity(cloneBuckets.all.size);

          if (desiredCapacity === 0) {
            this._disposeInstancedMeshPair(currentPair, true);
            entry.sourceToInstancedMeshes.delete(sourceMesh);
            const usage = entry.sourceToInstancedMeshUsageState.get(sourceMesh);
            if (usage) {
              usage.prevOpaqueIndex = -1;
              usage.prevTransparentIndex = -1;
            }
            cloneBuckets.all.forEach((remainingClonedMesh) => {
              this._setClonedMeshDefaultLayerEnabled(remainingClonedMesh, true);
            });
            entry.needsInstancedTextureRefresh = true;
            GLTFStats.instancedMeshCount--;
          } else if (desiredCapacity !== currentPair.opaque.instanceMatrix.count) {
            this._replaceInstancedMeshPair(
              entry,
              sourceMesh,
              desiredCapacity,
              currentPair.opaque.material,
              currentPair.transparent.material,
            );
            this._updateShaderDefines(entry, sourceMesh);
          }
        }
      }
    });

    entry.clonedGltfSet.delete(clonedGltf);

    if (entry.clonedGltfSet.size === 0 && entry.clonedGltfPromiseSet.size === 0) {
      this._releaseEntry(entry);
      GLTFStats.sourceMeshCount -= meshCount;
    }

    GLTFStats.clonedMeshCount -= meshCount;

    return true;
  }

  // GLTFManager provides the ability to switch the textures of a cloned glTF model to custom texture.
  // Even when using custom textures, we continue to use InstancedMesh by utilizing Texture Array called
  // InstancedTexture and specifying the index of the texture array via instance attributes. The function
  // searches through the cloned meshes within the cloned glTF model to collect the currently used textures,
  // and then registers the contents of the InstancedTexture.
  private _refreshInstancedTextures(entry: GLTFEntry): void {
    // First pass: For each source color texture, collect the currently used color textures
    // corresponding to the source color textures in ClonedMeshes.
    // Since a texture can be referenced by multiple meshes/materials, InstancedTextures need to be managed
    // at the glTF model level. If they are managed per mesh, different meshes could end up with separate
    // InstancedTextures, leading to duplicated content and increased memory usage.
    entry.sourceMeshSet.forEach(sourceMesh => {
      // InstancedTextures are only used with InstancedMeshes, so nothing is done
      // for meshes where InstancedMesh is not used.
      if (!entry.sourceToInstancedMeshes.has(sourceMesh)) {
        return;
      }

      const sourceMaterial = sourceMesh.material as EmissiveMeshBasicMaterial;

      // Assumes that if a color texture is not used in the Source Material,
      // it is also not used in the Cloned Material.
      if (!sourceMaterial.map) {
        return;
      }

      if (!sourceTextureToUsedTexturesMap.has(sourceMaterial.map)) {
        sourceTextureToUsedTexturesMap.set(sourceMaterial.map, new Set());
      }
      const sourceSet = sourceTextureToUsedTexturesMap.get(sourceMaterial.map)!;

      const cloneBuckets = entry.sourceToCloneBuckets.get(sourceMesh)!;
      cloneBuckets.all.forEach(clonedMesh => {
        const clonedMaterial = clonedMesh.material as EmissiveMeshBasicMaterial;
        sourceSet.add(clonedMaterial.map!);
      });
    });

    // Second pass: Based on the collected texture information, it releases any unnecessary
    // InstancedTextures, creates or resizes those that are needed, and registers content into
    // the InstancedTextures.
    sourceTextureToUsedTexturesMap.forEach((textureSet, sourceTexture) => {
      if (textureSet.size <= 1) {
        entry.sourceTextureToInstancedTextures.get(sourceTexture)?.dispose();
        entry.sourceTextureToInstancedTextures.delete(sourceTexture);
      } else {
        let instancedTexture = entry.sourceTextureToInstancedTextures.get(sourceTexture);

        if (
          instancedTexture === undefined ||
          (textureSet.size > instancedTexture.image.depth) ||
          (textureSet.size < instancedTexture.image.depth / INSTANCED_TEXTURE_RESIZE_DECREASE_FACTOR)
        ) {
          let depth = 1;
          // Currently, we don't set limit on the depth size. However, if issues arise with
          // fetch performance of large texture arrays, memory usage, or platform constraints,
          // we may need to set a maximum value and reduce the depth size accordingly.
          while (depth < textureSet.size) {
            depth *= INSTANCED_TEXTURE_RESIZE_INCREASE_FACTOR;
          }
          instancedTexture?.dispose();
          instancedTexture = new InstancedTexture(sourceTexture, depth);
          entry.sourceTextureToInstancedTextures.set(sourceTexture, instancedTexture);
        }

        instancedTexture!.update(textureSet, this._game.renderer.webGLRenderer);
      }

      textureSet.clear();
    });

    // Final pass: Release the InstancedTextures that are not referenced by any source texture.
    entry.sourceTextureToInstancedTextures.forEach((instancedTexture, sourceTexture) => {
      if (!sourceTextureToUsedTexturesMap.has(sourceTexture)) {
        instancedTexture.dispose();
        entry.sourceTextureToInstancedTextures.delete(sourceTexture);
      }
    });

    sourceTextureToUsedTexturesMap.clear();
  }

  private _processClonedMeshes(
    clonedMeshes: Mesh[],
    instancedMeshPairs: InstancedMeshPair[],
    isTransparent: boolean,
    entry: GLTFEntry,
    sourceMesh: Mesh,
  ): number {
    if (clonedMeshes.length === 0) return -1;

    const sourceMaterial = sourceMesh.material as MeshBasicMaterial;
    const counters = entry.sourceToAttributeCounters.get(sourceMesh);

    if (!counters) {
      console.warn(`GLTFManager._processClonedMeshes(): Client implementation error. counters not found for sourceMesh.`);
    }

    const needsColorAttribute = counters ? counters.nonDefaultColor > 0 : true;
    const needsOpacityAttribute = counters ? counters.nonDefaultOpacity > 0 : true;
    const needsLightLevelAttribute = this._game.entityManager.hasLightLevelVolumeUpdatedOnce;
    const needsEmissiveAttribute = counters ? counters.nonDefaultEmissive > 0 : true;

    let instancedMeshIndex = 0;
    while (clonedMeshes.length > instancedMeshPairs[instancedMeshIndex].opaque.instanceMatrix.count) {
      instancedMeshIndex++;
    }
    const targetPair = instancedMeshPairs[instancedMeshIndex];
    const instancedMesh = isTransparent ? targetPair.transparent : targetPair.opaque;
    const instanceMatrixAttribute = instancedMesh.instanceMatrix;
    const instanceMatrixArray = instanceMatrixAttribute.array as Float32Array;
    const instanceSkyLightAttribute = instancedMesh.geometry.getAttribute(INSTANCE_SKY_LIGHT_ATTRIBUTE)! as InstancedBufferAttribute;
    const instanceSkyLightArray = instanceSkyLightAttribute.array as Float32Array;
    const instanceColorArray = needsColorAttribute ? instancedMesh.instanceColor!.array as Float32Array : null;
    const opacityArray = needsOpacityAttribute
      ? (instancedMesh.geometry.getAttribute(INSTANCE_OPACITY_ATTRIBUTE)! as InstancedBufferAttribute).array as Float32Array
      : null;
    const lightLevelArray = needsLightLevelAttribute
      ? (instancedMesh.geometry.getAttribute(INSTANCE_LIGHT_LEVEL_ATTRIBUTE)! as InstancedBufferAttribute).array as Float32Array
      : null;
    const emissiveArray = needsEmissiveAttribute
      ? (instancedMesh.geometry.getAttribute(INSTANCE_EMISSIVE_ATTRIBUTE)! as InstancedBufferAttribute).array as Float32Array
      : null;
    const oldCount = instancedMesh.count;

    let anyMatrixDirty = false;
    let anySkyLightDirty = false;
    let anyColorDirty = false;
    let anyOpacityDirty = false;
    let anyLightLevelDirty = false;
    let anyEmissiveDirty = false;

    let index = 0;
    type DirtyRange = [number, number];
    const createDirtyRange = (): DirtyRange => [Number.POSITIVE_INFINITY, -1];
    const markDirty = (instanceIndex: number, dirtyRange: DirtyRange): void => {
      if (instanceIndex < dirtyRange[0]) dirtyRange[0] = instanceIndex;
      if (instanceIndex > dirtyRange[1]) dirtyRange[1] = instanceIndex;
    };
    const extendDirty = (dirtyRange: DirtyRange, startIndex: number, endIndex: number): void => {
      if (endIndex < startIndex) return;
      if (startIndex < dirtyRange[0]) dirtyRange[0] = startIndex;
      if (endIndex > dirtyRange[1]) dirtyRange[1] = endIndex;
    };
    const matrixDirtyRange = createDirtyRange();
    const skyLightDirtyRange = createDirtyRange();
    const colorDirtyRange = createDirtyRange();
    const opacityDirtyRange = createDirtyRange();
    const lightLevelDirtyRange = createDirtyRange();
    const emissiveDirtyRange = createDirtyRange();
    const mapIndexDirtyRange = createDirtyRange();

    for (const clonedMesh of clonedMeshes) {
      const material = clonedMesh.material as EmissiveMeshBasicMaterial;

      if (material.map) {
        usedColorTextureSet.add(material.map);
      }

      let cached = this._instanceStateCache.get(clonedMesh);
      const isNew = !cached;

      if (!cached) {
        cached = {
          lastIndex: -1,
          lastInstancedMesh: null,
          matrixSnapshot: new Float32Array(16),
          skyLight: NaN,
          colorR: NaN, colorG: NaN, colorB: NaN,
          opacity: NaN,
          lightLevel: NaN,
          emissiveR: NaN, emissiveG: NaN, emissiveB: NaN, emissiveIntensity: NaN,
        };
        this._instanceStateCache.set(clonedMesh, cached);
      }

      // Force full write when this mesh is new, moved to a different instance
      // slot, or targets a different InstancedMesh (e.g. after a resize).
      const forceUpdate = isNew || cached.lastIndex !== index || cached.lastInstancedMesh !== instancedMesh;

      // Assumes that the InstancedMesh is directly under the Scene and
      // its World Matrix is an Identity Matrix.
      const matrixElements = clonedMesh.matrixWorld.elements;
      const matrixArrayOffset = index * MATRIX4_COMPONENT_COUNT;
      let matrixChanged = forceUpdate;
      if (!matrixChanged) {
        const snap = cached.matrixSnapshot;
        for (let i = 0; i < MATRIX4_COMPONENT_COUNT; i++) {
          if (matrixElements[i] !== snap[i]) {
            matrixChanged = true;
            break;
          }
        }
      }
      if (matrixChanged) {
        for (let i = 0; i < MATRIX4_COMPONENT_COUNT; i++) {
          instanceMatrixArray[matrixArrayOffset + i] = matrixElements[i];
        }
        cached.matrixSnapshot.set(matrixElements);
        anyMatrixDirty = true;
        markDirty(index, matrixDirtyRange);
      }

      const skyLight = Entity.getEffectiveSkyLight(this._game, clonedMesh);
      if (forceUpdate || skyLight !== cached.skyLight) {
        instanceSkyLightArray[index] = skyLight;
        cached.skyLight = skyLight;
        anySkyLightDirty = true;
        markDirty(index, skyLightDirtyRange);
      }

      if (instanceColorArray) {
        const { r, g, b } = material.color;
        if (forceUpdate || r !== cached.colorR || g !== cached.colorG || b !== cached.colorB) {
          const colorArrayOffset = index * 3;
          instanceColorArray[colorArrayOffset] = r;
          instanceColorArray[colorArrayOffset + 1] = g;
          instanceColorArray[colorArrayOffset + 2] = b;
          cached.colorR = r;
          cached.colorG = g;
          cached.colorB = b;
          anyColorDirty = true;
          markDirty(index, colorDirtyRange);
        }
      }

      if (opacityArray) {
        if (forceUpdate || material.opacity !== cached.opacity) {
          opacityArray[index] = material.opacity;
          cached.opacity = material.opacity;
          anyOpacityDirty = true;
          markDirty(index, opacityDirtyRange);
        }
      }

      if (lightLevelArray) {
        const lightLevel = Entity.getEffectiveLightLevel(this._game, clonedMesh);
        if (forceUpdate || lightLevel !== cached.lightLevel) {
          lightLevelArray[index] = lightLevel;
          cached.lightLevel = lightLevel;
          anyLightLevelDirty = true;
          markDirty(index, lightLevelDirtyRange);
        }
      }

      if (emissiveArray) {
        const { r: er, g: eg, b: eb } = material.customEmissive;
        const ei = material.customEmissiveIntensity;
        if (forceUpdate || er !== cached.emissiveR || eg !== cached.emissiveG || eb !== cached.emissiveB || ei !== cached.emissiveIntensity) {
          const emissiveArrayOffset = index * 4;
          emissiveArray[emissiveArrayOffset] = er;
          emissiveArray[emissiveArrayOffset + 1] = eg;
          emissiveArray[emissiveArrayOffset + 2] = eb;
          emissiveArray[emissiveArrayOffset + 3] = ei;
          cached.emissiveR = er;
          cached.emissiveG = eg;
          cached.emissiveB = eb;
          cached.emissiveIntensity = ei;
          anyEmissiveDirty = true;
          markDirty(index, emissiveDirtyRange);
        }
      }

      cached.lastIndex = index;
      cached.lastInstancedMesh = instancedMesh;
      index++;
    }

    instancedMesh.count = index;

    if (index > 0) {
      let useInstancedTexture = false;
      let nextColorTexture: Texture | null = null;

      if (usedColorTextureSet.size === 0) {
        nextColorTexture = null;
      } else if (usedColorTextureSet.size === 1) {
        nextColorTexture = usedColorTextureSet.values().next().value!;
      } else {
        const instancedTexture = entry.sourceTextureToInstancedTextures.get(sourceMaterial.map!)!;
        const mapIndexAttribute = instancedMesh.geometry.getAttribute(INSTANCE_MAP_INDEX_ATTRIBUTE)! as InstancedBufferAttribute;
        const mapIndexArray = mapIndexAttribute.array as Float32Array;

        for (let meshIndex = 0; meshIndex < clonedMeshes.length; meshIndex++) {
          const clonedMesh = clonedMeshes[meshIndex];
          const material = clonedMesh.material as EmissiveMeshBasicMaterial;
          const mapIndex = instancedTexture.getIndex(material.map!.source);
          if (mapIndexArray[meshIndex] !== mapIndex) {
            mapIndexArray[meshIndex] = mapIndex;
            markDirty(meshIndex, mapIndexDirtyRange);
          }
        }

        nextColorTexture = instancedTexture;
        useInstancedTexture = true;
      }

      if (instancedMesh.material.map !== nextColorTexture) {
        instancedMesh.setColorTexture(nextColorTexture);
      }

      const markAttributeNeedsUpdate = (
        attribute: InstancedBufferAttribute,
        dirtyRange: DirtyRange,
      ): void => {
        if (dirtyRange[1] < dirtyRange[0]) {
          return;
        }

        attribute.clearUpdateRanges();
        attribute.addUpdateRange(
          dirtyRange[0] * attribute.itemSize,
          (dirtyRange[1] - dirtyRange[0] + 1) * attribute.itemSize,
        );
        attribute.needsUpdate = true;
        GLTFStats.attributeElementsUpdated += (dirtyRange[1] - dirtyRange[0] + 1) * attribute.itemSize;
      };

      // When instance count increases, initialize values for newly visible tail entries.
      if (index > oldCount) {
        const tailStart = oldCount;
        const tailEnd = index - 1;
        extendDirty(matrixDirtyRange, tailStart, tailEnd);
        extendDirty(skyLightDirtyRange, tailStart, tailEnd);
        if (needsColorAttribute) {
          extendDirty(colorDirtyRange, tailStart, tailEnd);
        }
        if (needsOpacityAttribute) {
          extendDirty(opacityDirtyRange, tailStart, tailEnd);
        }
        if (needsLightLevelAttribute) {
          extendDirty(lightLevelDirtyRange, tailStart, tailEnd);
        }
        if (needsEmissiveAttribute) {
          extendDirty(emissiveDirtyRange, tailStart, tailEnd);
        }
        if (useInstancedTexture) {
          extendDirty(mapIndexDirtyRange, tailStart, tailEnd);
        }
      }

      markAttributeNeedsUpdate(instanceMatrixAttribute, matrixDirtyRange);
      markAttributeNeedsUpdate(instanceSkyLightAttribute, skyLightDirtyRange);

      if (needsColorAttribute) {
        markAttributeNeedsUpdate(instancedMesh.instanceColor!, colorDirtyRange);
      }

      if (needsOpacityAttribute) {
        markAttributeNeedsUpdate(
          instancedMesh.geometry.getAttribute(INSTANCE_OPACITY_ATTRIBUTE)! as InstancedBufferAttribute,
          opacityDirtyRange,
        );
      }

      if (needsLightLevelAttribute) {
        markAttributeNeedsUpdate(
          instancedMesh.geometry.getAttribute(INSTANCE_LIGHT_LEVEL_ATTRIBUTE)! as InstancedBufferAttribute,
          lightLevelDirtyRange,
        );
      }

      if (needsEmissiveAttribute) {
        markAttributeNeedsUpdate(
          instancedMesh.geometry.getAttribute(INSTANCE_EMISSIVE_ATTRIBUTE)! as InstancedBufferAttribute,
          emissiveDirtyRange,
        );
      }

      if (useInstancedTexture) {
        markAttributeNeedsUpdate(
          instancedMesh.geometry.getAttribute(INSTANCE_MAP_INDEX_ATTRIBUTE)! as InstancedBufferAttribute,
          mapIndexDirtyRange,
        );
      }

      if (!anyMatrixDirty) GLTFStats.attributeUploadsSkipped++;
      if (!anySkyLightDirty) GLTFStats.attributeUploadsSkipped++;
      if (needsColorAttribute && !anyColorDirty) GLTFStats.attributeUploadsSkipped++;
      if (needsOpacityAttribute && !anyOpacityDirty) GLTFStats.attributeUploadsSkipped++;
      if (needsLightLevelAttribute && !anyLightLevelDirty) GLTFStats.attributeUploadsSkipped++;
      if (needsEmissiveAttribute && !anyEmissiveDirty) GLTFStats.attributeUploadsSkipped++;

      // Since the Frustum is slightly enlarged, this measurement is not
      // entirely accurate, but it should be taken only as a rough reference.
      GLTFStats.drawCallsSaved += index - 1;
    }
    usedColorTextureSet.clear();
    return index > 0 ? instancedMeshIndex : -1;
  }

  private _setInstancedMeshInScene(instancedMesh: InstancedMeshEx, inScene: boolean): void {
    if (inScene) {
      if (instancedMesh.parent === null) {
        this._game.renderer.addToScene(instancedMesh);
      }
      return;
    }

    if (instancedMesh.parent !== null) {
      this._game.renderer.removeFromScene(instancedMesh);
    }
  }

  private _setClonedMeshDefaultLayerEnabled(clonedMesh: Mesh, enabled: boolean): void {
    const isEnabled = (clonedMesh.layers.mask & DEFAULT_LAYER_MASK) !== 0;

    if (isEnabled === enabled) {
      return;
    }

    if (enabled) {
      clonedMesh.layers.enable(DEFAULT_LAYER);
    } else {
      clonedMesh.layers.disable(DEFAULT_LAYER);
    }
  }

  private _getTransparentSortInterval(visibleTransparentCount: number): number {
    if (visibleTransparentCount >= 256) {
      return TRANSPARENT_INSTANCED_SORT_INTERVAL_LARGE;
    }
    if (visibleTransparentCount >= 96) {
      return TRANSPARENT_INSTANCED_SORT_INTERVAL_MEDIUM;
    }
    return TRANSPARENT_INSTANCED_SORT_INTERVAL_SMALL;
  }

  private _hasTransparentSortViewChanged(usage: InstancedMeshUsageState): boolean {
    const cameraPos = this._game.camera.activeCamera.position;
    const viewDir = this._game.camera.activeViewDir;

    if (!Number.isFinite(usage.lastTransparentSortCameraPosX)) {
      return true;
    }

    const deltaX = cameraPos.x - usage.lastTransparentSortCameraPosX;
    const deltaY = cameraPos.y - usage.lastTransparentSortCameraPosY;
    const deltaZ = cameraPos.z - usage.lastTransparentSortCameraPosZ;
    const positionDeltaSq = deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ;
    if (positionDeltaSq > TRANSPARENT_SORT_CAMERA_POSITION_DELTA_SQ_THRESHOLD) {
      return true;
    }

    const viewAlignment =
      usage.lastTransparentSortViewDirX * viewDir.x +
      usage.lastTransparentSortViewDirY * viewDir.y +
      usage.lastTransparentSortViewDirZ * viewDir.z;

    return viewAlignment < TRANSPARENT_SORT_VIEW_ALIGNMENT_DOT_THRESHOLD;
  }

  private _storeTransparentSortView(usage: InstancedMeshUsageState): void {
    const cameraPos = this._game.camera.activeCamera.position;
    const viewDir = this._game.camera.activeViewDir;

    usage.lastTransparentSortCameraPosX = cameraPos.x;
    usage.lastTransparentSortCameraPosY = cameraPos.y;
    usage.lastTransparentSortCameraPosZ = cameraPos.z;
    usage.lastTransparentSortViewDirX = viewDir.x;
    usage.lastTransparentSortViewDirY = viewDir.y;
    usage.lastTransparentSortViewDirZ = viewDir.z;
  }

  private _sortTransparentClonedMeshesByDepth(clonedMeshes: Mesh[]): void {
    const cameraPos = this._game.camera.activeCamera.position;
    const viewDir = this._game.camera.activeViewDir;

    for (let i = 0; i < clonedMeshes.length; i++) {
      const mesh = clonedMeshes[i];
      const e = mesh.matrixWorld.elements;
      // Project world position to camera forward direction (farther first for alpha blending).
      const depth =
        (e[12] - cameraPos.x) * viewDir.x +
        (e[13] - cameraPos.y) * viewDir.y +
        (e[14] - cameraPos.z) * viewDir.z;
      mesh.userData[USERDATA_TRANSPARENT_SORT_DEPTH] = depth;
    }

    clonedMeshes.sort((a, b) => b.userData[USERDATA_TRANSPARENT_SORT_DEPTH] - a.userData[USERDATA_TRANSPARENT_SORT_DEPTH]);
  }

  // Reflect the world matrices, color, and opacity of the cloned Meshes onto the InstancedMesh.
  // Assumes that the world matrix of the entire scene is up-to-date and called before
  // the render call.
  public update(): void {
    GLTFStats.reset();

    for (const entry of this._uriToEntry.values()) {
      // Pre-pass: Refresh Instanced textures.
      // Since it's a heavy process to run every animation frame, it is performed only when necessary.
      if (entry.needsInstancedTextureRefresh) {
        this._refreshInstancedTextures(entry);
        entry.needsInstancedTextureRefresh = false;
      }

      // Main-pass
      for (const sourceMesh of entry.sourceMeshSet) {
        if (!entry.sourceToInstancedMeshes.has(sourceMesh)) {
          continue;
        }

        const instancedMeshPairs = entry.sourceToInstancedMeshes.get(sourceMesh)!;
        const cloneBuckets = entry.sourceToCloneBuckets.get(sourceMesh)!;

        const usage = entry.sourceToInstancedMeshUsageState.get(sourceMesh)!;
        const prevOpaqueIndex = usage.prevOpaqueIndex;
        const prevTransparentIndex = usage.prevTransparentIndex;

        for (const clonedMesh of cloneBuckets.opaque) {
          if (!Entity.isNodeEffectivelyVisible(this._game, clonedMesh)) {
            continue;
          }

          opaqueClonedMeshes.push(clonedMesh);
        }

        // Process opaque meshes
        const nextOpaqueIndex = this._processClonedMeshes(
          opaqueClonedMeshes,
          instancedMeshPairs,
          false,
          entry,
          sourceMesh
        );

        // Process transparent meshes

        // NOTE: When the visible transparent mesh count hovers around the threshold,
        // rendering may flicker due to frequent switching between individual mesh
        // rendering (better transparency sorting) and InstancedMesh rendering
        // (different transparency handling). Consider solution if this becomes
        // problematic in practice.

        for (const clonedMesh of cloneBuckets.transparent) {
          if (!Entity.isNodeEffectivelyVisible(this._game, clonedMesh)) {
            continue;
          }

          transparentClonedMeshes.push(clonedMesh);
        }

        if (transparentClonedMeshes.length <= USE_INSTANCED_MESH_THRESHOLD_TRANSPARENT) {
          // Use regular mesh rendering for better transparency sorting
          // Re-enable layers for visible transparent meshes
          for (const clonedMesh of transparentClonedMeshes) {
            this._setClonedMeshDefaultLayerEnabled(clonedMesh, true);
          }
          // Force a fresh sort if we switch back to instanced transparent rendering later.
          usage.lastTransparentSortFrame = -1;
          usage.lastTransparentSortCount = -1;
          // Transparent InstancedMesh will remain invisible
        } else {
          // Use InstancedMesh for better performance
          for (const clonedMesh of transparentClonedMeshes) {
            this._setClonedMeshDefaultLayerEnabled(clonedMesh, false);
          }

          // Sort periodically by projected depth to improve overlapping transparency quality.
          const frameCount = this._game.performanceMetricsManager.frameCount;
          const sortInterval = this._getTransparentSortInterval(transparentClonedMeshes.length);
          const shouldRefreshSortWindow =
            usage.lastTransparentSortFrame < 0 ||
            usage.lastTransparentSortCount !== transparentClonedMeshes.length;
          if (
            shouldRefreshSortWindow ||
            (
              frameCount - usage.lastTransparentSortFrame >= sortInterval &&
              this._hasTransparentSortViewChanged(usage)
            )
          ) {
            this._sortTransparentClonedMeshesByDepth(transparentClonedMeshes);
            this._storeTransparentSortView(usage);
          }

          if (
            usage.lastTransparentSortFrame < 0 ||
            usage.lastTransparentSortCount !== transparentClonedMeshes.length ||
            frameCount - usage.lastTransparentSortFrame >= sortInterval
          ) {
            usage.lastTransparentSortFrame = frameCount;
            usage.lastTransparentSortCount = transparentClonedMeshes.length;
          }

          const nextTransparentIndex = this._processClonedMeshes(
            transparentClonedMeshes,
            instancedMeshPairs,
            true,
            entry,
            sourceMesh
          );

          if (prevTransparentIndex >= 0 && prevTransparentIndex < instancedMeshPairs.length && prevTransparentIndex !== nextTransparentIndex) {
            this._setInstancedMeshInScene(instancedMeshPairs[prevTransparentIndex].transparent, false);
          }
          if (nextTransparentIndex >= 0 && nextTransparentIndex < instancedMeshPairs.length) {
            this._setInstancedMeshInScene(instancedMeshPairs[nextTransparentIndex].transparent, true);
          }
          usage.prevTransparentIndex = nextTransparentIndex;
        }

        if (transparentClonedMeshes.length <= USE_INSTANCED_MESH_THRESHOLD_TRANSPARENT) {
          if (prevTransparentIndex >= 0 && prevTransparentIndex < instancedMeshPairs.length) {
            this._setInstancedMeshInScene(instancedMeshPairs[prevTransparentIndex].transparent, false);
          }
          usage.prevTransparentIndex = -1;
        }

        if (prevOpaqueIndex >= 0 && prevOpaqueIndex < instancedMeshPairs.length && prevOpaqueIndex !== nextOpaqueIndex) {
          this._setInstancedMeshInScene(instancedMeshPairs[prevOpaqueIndex].opaque, false);
        }
        if (nextOpaqueIndex >= 0 && nextOpaqueIndex < instancedMeshPairs.length) {
          this._setInstancedMeshInScene(instancedMeshPairs[nextOpaqueIndex].opaque, true);
        }
        usage.prevOpaqueIndex = nextOpaqueIndex;

        opaqueClonedMeshes.length = 0;
        transparentClonedMeshes.length = 0;
      }
    }
  }

  public onMeshOpacityChanged(
    clonedMesh: Mesh,
    oldValue: number,
    newValue: number,
    oldTransparent: boolean,
    newTransparent: boolean,
    materialIndex: number = 0,
  ): void {
    const sourceMesh = this._clonedMeshToSourceMesh.get(clonedMesh);
    if (!sourceMesh) {
      console.warn(`GLTFManager.onMeshOpacityChanged(): Client implementation error. sourceMesh not found for clonedMesh.`);
      return;
    }

    const entry = this._sourceMeshToEntry.get(sourceMesh);
    if (!entry) {
      console.warn(`GLTFManager.onMeshOpacityChanged(): Client implementation error. entry not found for sourceMesh.`);
      return;
    }

    const counters = entry.sourceToAttributeCounters.get(sourceMesh);
    if (!counters) {
      console.warn(`GLTFManager.onMeshOpacityChanged(): Client implementation error. counters not found for sourceMesh.`);
      return;
    }

    const sourceMaterial = this._getMeshMaterials(sourceMesh)[materialIndex];
    if (!sourceMaterial) {
      console.warn(`GLTFManager.onMeshOpacityChanged(): Client implementation error. source material not found for materialIndex ${materialIndex}.`);
      return;
    }
    const wasDefault = oldValue === sourceMaterial.opacity;
    const isDefault = newValue === sourceMaterial.opacity;

    if (!Array.isArray(sourceMesh.material) && !Array.isArray(clonedMesh.material) && oldTransparent !== newTransparent) {
      this._moveClonedMeshTransparencyBucket(entry, sourceMesh, clonedMesh, newTransparent);
      if (entry.sourceToInstancedMeshes.has(sourceMesh)) {
        this._setClonedMeshDefaultLayerEnabled(clonedMesh, newTransparent);
      }
    }

    if (wasDefault && !isDefault) {
      counters.nonDefaultOpacity++;
      if (counters.nonDefaultOpacity === 1) {
        this._updateShaderDefines(entry, sourceMesh);
      }
    } else if (!wasDefault && isDefault) {
      if (counters.nonDefaultOpacity > 0) {
        counters.nonDefaultOpacity--;
        if (counters.nonDefaultOpacity === 0) {
          this._updateShaderDefines(entry, sourceMesh);
        }
      } else {
        console.warn(`GLTFManager.onMeshOpacityChanged(): Client implementation error. nonDefaultOpacity counter is already 0.`);
      }
    }

    if (isDefault && newTransparent === sourceMaterial.transparent) {
      this._tryRestoreSharedMaterial(clonedMesh, materialIndex);
    }
  }

  public onMeshColorChanged(clonedMesh: Mesh, oldColor: Color, newColor: Color, materialIndex: number = 0): void {
    const sourceMesh = this._clonedMeshToSourceMesh.get(clonedMesh);
    if (!sourceMesh) {
      console.warn(`GLTFManager.onMeshColorChanged(): Client implementation error. sourceMesh not found for clonedMesh.`);
      return;
    }

    const entry = this._sourceMeshToEntry.get(sourceMesh);
    if (!entry) {
      console.warn(`GLTFManager.onMeshColorChanged(): Client implementation error. entry not found for sourceMesh.`);
      return;
    }

    const counters = entry.sourceToAttributeCounters.get(sourceMesh);
    if (!counters) {
      console.warn(`GLTFManager.onMeshColorChanged(): Client implementation error. counters not found for sourceMesh.`);
      return;
    }

    const sourceMaterial = this._getMeshMaterials(sourceMesh)[materialIndex];
    if (!sourceMaterial) {
      console.warn(`GLTFManager.onMeshColorChanged(): Client implementation error. source material not found for materialIndex ${materialIndex}.`);
      return;
    }
    const wasDefault = oldColor.equals(sourceMaterial.color);
    const isDefault = newColor.equals(sourceMaterial.color);

    if (wasDefault && !isDefault) {
      counters.nonDefaultColor++;
      if (counters.nonDefaultColor === 1) {
        this._updateShaderDefines(entry, sourceMesh);
      }
    } else if (!wasDefault && isDefault) {
      if (counters.nonDefaultColor > 0) {
        counters.nonDefaultColor--;
        if (counters.nonDefaultColor === 0) {
          this._updateShaderDefines(entry, sourceMesh);
        }
      } else {
        console.warn(`GLTFManager.onMeshColorChanged(): Client implementation error. nonDefaultColor counter is already 0.`);
      }
    }

    if (isDefault) {
      this._tryRestoreSharedMaterial(clonedMesh, materialIndex);
    }
  }

  public onMeshEmissiveChanged(
    clonedMesh: Mesh,
    oldColor: Color, newColor: Color,
    oldIntensity: number, newIntensity: number,
    materialIndex: number = 0,
  ): void {
    const sourceMesh = this._clonedMeshToSourceMesh.get(clonedMesh);
    if (!sourceMesh) {
      console.warn(`GLTFManager.onMeshEmissiveChanged(): Client implementation error. sourceMesh not found for clonedMesh.`);
      return;
    }

    const entry = this._sourceMeshToEntry.get(sourceMesh);
    if (!entry) {
      console.warn(`GLTFManager.onMeshEmissiveChanged(): Client implementation error. entry not found for sourceMesh.`);
      return;
    }

    const counters = entry.sourceToAttributeCounters.get(sourceMesh);
    if (!counters) {
      console.warn(`GLTFManager.onMeshEmissiveChanged(): Client implementation error. counters not found for sourceMesh.`);
      return;
    }

    const sourceMaterial = this._getMeshMaterials(sourceMesh)[materialIndex];
    if (!sourceMaterial) {
      console.warn(`GLTFManager.onMeshEmissiveChanged(): Client implementation error. source material not found for materialIndex ${materialIndex}.`);
      return;
    }
    const wasDefault = oldColor.equals(sourceMaterial.customEmissive) &&
                       oldIntensity === sourceMaterial.customEmissiveIntensity;
    const isDefault = newColor.equals(sourceMaterial.customEmissive) &&
                      newIntensity === sourceMaterial.customEmissiveIntensity;

    if (wasDefault && !isDefault) {
      counters.nonDefaultEmissive++;
      if (counters.nonDefaultEmissive === 1) {
        this._updateShaderDefines(entry, sourceMesh);
      }
    } else if (!wasDefault && isDefault) {
      if (counters.nonDefaultEmissive > 0) {
        counters.nonDefaultEmissive--;
        if (counters.nonDefaultEmissive === 0) {
          this._updateShaderDefines(entry, sourceMesh);
        }
      } else {
        console.warn(`GLTFManager.onMeshEmissiveChanged(): Client implementation error. nonDefaultEmissive counter is already 0.`);
      }
    }

    if (isDefault) {
      this._tryRestoreSharedMaterial(clonedMesh, materialIndex);
    }
  }

  private _updateShaderDefines(entry: GLTFEntry, sourceMesh: Mesh): void {
    const instancedMeshPairs = entry.sourceToInstancedMeshes.get(sourceMesh);
    if (!instancedMeshPairs) {
      // InstancedMesh not created yet, skip shader defines update
      return;
    }

    const counters = entry.sourceToAttributeCounters.get(sourceMesh);
    if (!counters) {
      console.warn(`GLTFManager._updateShaderDefines(): Client implementation error. counters not found for sourceMesh.`);
    }

    // If counters not found, use true (no optimization but renders correctly)
    const needsOpacity = counters ? counters.nonDefaultOpacity > 0 : true;
    const needsColor = counters ? counters.nonDefaultColor > 0 : true;
    const needsEmissive = counters ? counters.nonDefaultEmissive > 0 : true;

    const sourceMaterial = sourceMesh.material as EmissiveMeshBasicMaterial;

    instancedMeshPairs.forEach(pair => {
      // Ensure defines object exists
      if (!pair.opaque.material.defines) pair.opaque.material.defines = {};
      if (!pair.transparent.material.defines) pair.transparent.material.defines = {};

      if (needsOpacity) {
        pair.opaque.material.defines[USE_INSTANCED_OPACITY_DEFINE] = '';
        pair.transparent.material.defines[USE_INSTANCED_OPACITY_DEFINE] = '';
        pair.opaque.material.opacity = 1.0;
        pair.transparent.material.opacity = 1.0;
      } else {
        delete pair.opaque.material.defines[USE_INSTANCED_OPACITY_DEFINE];
        delete pair.transparent.material.defines[USE_INSTANCED_OPACITY_DEFINE];
        pair.opaque.material.opacity = sourceMaterial.opacity;
        pair.transparent.material.opacity = sourceMaterial.opacity;
      }

      if (this._game.entityManager.hasLightLevelVolumeUpdatedOnce) {
        pair.opaque.material.defines[USE_INSTANCED_LIGHT_LEVEL_DEFINE] = '';
        pair.transparent.material.defines[USE_INSTANCED_LIGHT_LEVEL_DEFINE] = '';
      } else {
        delete pair.opaque.material.defines[USE_INSTANCED_LIGHT_LEVEL_DEFINE];
        delete pair.transparent.material.defines[USE_INSTANCED_LIGHT_LEVEL_DEFINE];
      }

      if (needsColor) {
        pair.opaque.material.defines[USE_INSTANCED_COLOR_DEFINE] = '';
        pair.transparent.material.defines[USE_INSTANCED_COLOR_DEFINE] = '';
        pair.opaque.material.color.setRGB(1.0, 1.0, 1.0);
        pair.transparent.material.color.setRGB(1.0, 1.0, 1.0);
      } else {
        delete pair.opaque.material.defines[USE_INSTANCED_COLOR_DEFINE];
        delete pair.transparent.material.defines[USE_INSTANCED_COLOR_DEFINE];
        pair.opaque.material.color.copy(sourceMaterial.color);
        pair.transparent.material.color.copy(sourceMaterial.color);
      }

      if (needsEmissive) {
        pair.opaque.material.defines[USE_INSTANCED_EMISSIVE_DEFINE] = '';
        pair.transparent.material.defines[USE_INSTANCED_EMISSIVE_DEFINE] = '';
        pair.opaque.material.customEmissive.setRGB(0, 0, 0);
        pair.transparent.material.customEmissive.setRGB(0, 0, 0);
        pair.opaque.material.customEmissiveIntensity = 1;
        pair.transparent.material.customEmissiveIntensity = 1;
      } else {
        delete pair.opaque.material.defines[USE_INSTANCED_EMISSIVE_DEFINE];
        delete pair.transparent.material.defines[USE_INSTANCED_EMISSIVE_DEFINE];
        pair.opaque.material.customEmissive.copy(sourceMaterial.customEmissive);
        pair.transparent.material.customEmissive.copy(sourceMaterial.customEmissive);
        pair.opaque.material.customEmissiveIntensity = sourceMaterial.customEmissiveIntensity;
        pair.transparent.material.customEmissiveIntensity = sourceMaterial.customEmissiveIntensity;
      }

      pair.opaque.material.needsUpdate = true;
      pair.transparent.material.needsUpdate = true;
    });
  }

  public onLightLevelVolumeUpdated(): void {
    for (const entry of this._uriToEntry.values()) {
      for (const sourceMesh of entry.sourceMeshSet) {
        this._updateShaderDefines(entry, sourceMesh);
      }
    }
  }
}

const getTextureSize = (texture: Texture): { width: number, height: number } => {
  const data = texture.source.data;
  if (
    data === null ||
    typeof data !== 'object' ||
    !('width' in data) ||
    !('height' in data) ||
    typeof data.width !== 'number' ||
    typeof data.height !== 'number'
  ) {
    throw new Error(`GLTFManager: Texture ${texture.uuid} has no readable width/height.`);
  }
  return {
    width: data.width,
    height: data.height,
  };
};

const getCanvasImageSource = (texture: Texture): CanvasImageSource => {
  const data = texture.source.data;
  if (data === null) {
    throw new Error(`GLTFManager: Texture ${texture.uuid} has no source data.`);
  }
  // CanvasImageSource is a DOM union type; runtime checks are sufficient before drawImage().
  return data as CanvasImageSource;
};

const readPixelsFromRegularTexture = (texture: Texture): { width: number, height: number, pixels: Uint8ClampedArray } => {
  const { width, height } = getTextureSize(texture);
  const pixels = new Uint8ClampedArray(width * height * BYTES_PER_PIXEL);
  tmpCanvas.width = width;
  tmpCanvas.height = height;
  tmp2DContext.drawImage(getCanvasImageSource(texture), 0, 0);
  const imageData = tmp2DContext.getImageData(0, 0, width, height);
  for (let i = 0; i < pixels.length; i++) {
    pixels[i] = imageData.data[i];
  }
  return { width, height, pixels };
};

// For CompressedTexture, we cannot read the decompressed pixels directly, so
// we render using that texture and read pixels from the result.
// TODO: This may reduce the benefits of using CompressedTexture. Consider
// using CompressedArrayTexture instead.
//
// Note: Creating a dedicated WebGLRenderer for this process instead of using
// the game's WebGLRenderer might simplify the code. However, creating multiple
// WebGLRenderers could potentially cause crashes on low-end devices, so we
// reuse the existing one. The concern about crashes is only a suspicion and
// not based on strong evidence tho. Using raw WebGL would be another option.
const readPixelsFromCompressedTexture = (texture: CompressedTexture, renderer: WebGLRenderer): { width: number, height: number, pixels: Uint8ClampedArray } => {
  const width = texture.source.data.width;
  const height = texture.source.data.height;

  const currentMinFilter = texture.minFilter;
  const currentMagFilter = texture.magFilter;
  const currentColorSpace = texture.colorSpace;

  const needsTextureUpdate = currentMinFilter !== NearestFilter || currentMagFilter !== NearestFilter;

  if (needsTextureUpdate) {
    texture.minFilter = NearestFilter;
    texture.magFilter = NearestFilter;
    texture.needsUpdate = true;
  }

  texture.colorSpace = NoColorSpace;

  // TODO: We may also need to ensure that the WebGLRenderer parameters are configured appropriately.

  const renderTarget = new WebGLRenderTarget(width, height, {
    depthBuffer: false,
    stencilBuffer: false,
  });

  const scene = new Scene();
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new Mesh(
    new PlaneGeometry(2, 2),
    new MeshBasicMaterial({
      map: texture,
      transparent: true,
      blending: NoBlending,
      toneMapped: false,
    }),
  );
  quad.frustumCulled = false;
  scene.add(quad);

  const pixels = new Uint8ClampedArray(width * height * BYTES_PER_PIXEL);
  const currentRenderTarget = renderer.getRenderTarget();

  try {
    renderer.setRenderTarget(renderTarget);
    renderer.render(scene, camera);

    renderer.readRenderTargetPixels(renderTarget, 0, 0, width, height, pixels);

    if (texture.flipY) {
      const row = width * 4;
      const tmp = new Uint8ClampedArray(row);
      for (let y = 0; y < (height >> 1); y++) {
        const top = y * row;
        const bottom = (height - 1 - y) * row;
        tmp.set(pixels.subarray(top, top + row));
        pixels.copyWithin(top, bottom, bottom + row);
        pixels.set(tmp, bottom);
      }
    }
  } finally {
    // Even if an exception occurs, reset the settings in finally to ensure they
    // are restored correctly.
    renderTarget.dispose();
    quad.geometry.dispose();
    quad.material.dispose();

    if (needsTextureUpdate) {
      texture.minFilter = currentMinFilter;
      texture.magFilter = currentMagFilter;
      texture.needsUpdate = true;
    }

    texture.colorSpace = currentColorSpace;

    renderer.setRenderTarget(currentRenderTarget);
  }

  return { width, height, pixels };
};
