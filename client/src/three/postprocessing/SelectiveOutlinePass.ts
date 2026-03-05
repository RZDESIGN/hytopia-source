import {
  Color,
  DepthTexture,
  Mesh,
  NoBlending,
  Object3D,
  PerspectiveCamera,
  Scene,
  ShaderMaterial,
  UniformsUtils,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { MAX_OUTLINES } from '../../entities/EntityConstants';
import type { OutlineTarget } from '../../entities/EntityManager';

// Maximum outline thickness in pixels (GLSL loop bounds must be constant)
const MAX_THICKNESS = 16;

const USERDATA_OUTLINE_TARGET_INDEX = 'outlineTargetIndex';
const USERDATA_OUTLINE_MAP = 'outlineMap';
const USERDATA_OUTLINE_ALPHA_MAP = 'outlineAlphaMap';
const USERDATA_OUTLINE_ALPHA_TEST = 'outlineAlphaTest';
const USERDATA_OUTLINE_OPACITY = 'outlineOpacity';
const USERDATA_OUTLINE_SIDE = 'outlineSide';

// Shader define names
const DEFINE_USE_MAP = 'USE_MAP';
const DEFINE_USE_ALPHA_MAP = 'USE_ALPHA_MAP';

// Working variables
const worldPosition = new Vector3();
const originalClearColor = new Color();
const originalParents = new Map<Object3D, Object3D | null>();
const originalMaterials = new Map<Mesh, any>();
const originalOnBeforeRenders = new Map<Mesh, typeof Mesh.prototype.onBeforeRender>();

const UNIFORM_T_DEPTH = 'tDepth';
const UNIFORM_CAMERA_NEAR = 'cameraNear';
const UNIFORM_CAMERA_FAR = 'cameraFar';
const UNIFORM_TARGET_INDEX = 'targetIndex';
const UNIFORM_T_MAP = 'tMap';
const UNIFORM_T_ALPHA_MAP = 'tAlphaMap';
const UNIFORM_ALPHA_TEST = 'alphaTest';
const UNIFORM_OPACITY = 'opacity';

const UNIFORM_T_MASK = 'tMask';
const UNIFORM_T_MASK_DEPTH = 'tMaskDepth';
const UNIFORM_T_MASK_2 = 'tMask2';
const UNIFORM_T_MASK_DEPTH_2 = 'tMaskDepth2';
const UNIFORM_RESOLUTION = 'resolution';
const UNIFORM_OUTLINE_COLORS = 'outlineColors';
const UNIFORM_OUTLINE_OPACITIES = 'outlineOpacities';
const UNIFORM_OUTLINE_THICKNESSES = 'outlineThicknesses';
const UNIFORM_MAX_THICKNESS = 'maxThickness';

const UNIFORM_T_SCENE_DEPTH = 'tSceneDepth';
const UNIFORM_T_DIFFUSE = 'tDiffuse';

// Shader for rendering mask with outline target index and depth comparison
const MaskShader = {
  uniforms: {
    [UNIFORM_T_DEPTH]: { value: null },
    [UNIFORM_CAMERA_NEAR]: { value: 0.1 },
    [UNIFORM_CAMERA_FAR]: { value: 1000.0 },
    [UNIFORM_TARGET_INDEX]: { value: 0.0 },
    [UNIFORM_T_MAP]: { value: null },
    [UNIFORM_T_ALPHA_MAP]: { value: null },
    [UNIFORM_ALPHA_TEST]: { value: 0.0 },
    [UNIFORM_OPACITY]: { value: 1.0 },
  },
  vertexShader: `
    varying float vDepth;
    varying vec2 vUv;
    void main() {
      vUv = uv;
      vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
      vDepth = -mvPosition.z;
      gl_Position = projectionMatrix * mvPosition;
    }
  `,
  fragmentShader: `
    uniform sampler2D ${UNIFORM_T_DEPTH};
    uniform float ${UNIFORM_CAMERA_NEAR};
    uniform float ${UNIFORM_CAMERA_FAR};
    uniform float ${UNIFORM_TARGET_INDEX};
    #ifdef ${DEFINE_USE_MAP}
      uniform sampler2D ${UNIFORM_T_MAP};
    #endif
    #ifdef ${DEFINE_USE_ALPHA_MAP}
      uniform sampler2D ${UNIFORM_T_ALPHA_MAP};
    #endif
    uniform float ${UNIFORM_ALPHA_TEST};
    uniform float ${UNIFORM_OPACITY};
    varying float vDepth;
    varying vec2 vUv;

    float perspectiveDepthToViewZ(float invClipZ, float near, float far) {
      return (near * far) / ((far - near) * invClipZ - far);
    }

    float readDepth(sampler2D depthSampler, vec2 coord) {
      float fragCoordZ = texture2D(depthSampler, coord).x;
      float viewZ = perspectiveDepthToViewZ(fragCoordZ, ${UNIFORM_CAMERA_NEAR}, ${UNIFORM_CAMERA_FAR});
      return -viewZ;
    }

    void main() {
      if (${UNIFORM_ALPHA_TEST} > 0.0) {
        float a = ${UNIFORM_OPACITY};
        #ifdef ${DEFINE_USE_MAP}
          a *= texture2D(${UNIFORM_T_MAP}, vUv).a;
        #endif
        #ifdef ${DEFINE_USE_ALPHA_MAP}
          a *= texture2D(${UNIFORM_T_ALPHA_MAP}, vUv).g;
        #endif
        if (a < ${UNIFORM_ALPHA_TEST}) discard;
      }

      vec2 screenUv = gl_FragCoord.xy / vec2(textureSize(${UNIFORM_T_DEPTH}, 0));
      float sceneDepth = readDepth(${UNIFORM_T_DEPTH}, screenUv);

      if (vDepth > sceneDepth + 0.01) {
        discard;
      }

      // Output target index in red channel (1-based, normalized)
      gl_FragColor = vec4(${UNIFORM_TARGET_INDEX} / 255.0, 0.0, 0.0, 1.0);
    }
  `,
};

// Shader for rendering mask without depth comparison
const MaskNoDepthShader = {
  uniforms: {
    [UNIFORM_TARGET_INDEX]: { value: 0.0 },
    [UNIFORM_T_MAP]: { value: null },
    [UNIFORM_T_ALPHA_MAP]: { value: null },
    [UNIFORM_ALPHA_TEST]: { value: 0.0 },
    [UNIFORM_OPACITY]: { value: 1.0 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform float ${UNIFORM_TARGET_INDEX};
    #ifdef ${DEFINE_USE_MAP}
      uniform sampler2D ${UNIFORM_T_MAP};
    #endif
    #ifdef ${DEFINE_USE_ALPHA_MAP}
      uniform sampler2D ${UNIFORM_T_ALPHA_MAP};
    #endif
    uniform float ${UNIFORM_ALPHA_TEST};
    uniform float ${UNIFORM_OPACITY};
    varying vec2 vUv;
    void main() {
      if (${UNIFORM_ALPHA_TEST} > 0.0) {
        float a = ${UNIFORM_OPACITY};
        #ifdef ${DEFINE_USE_MAP}
          a *= texture2D(${UNIFORM_T_MAP}, vUv).a;
        #endif
        #ifdef ${DEFINE_USE_ALPHA_MAP}
          a *= texture2D(${UNIFORM_T_ALPHA_MAP}, vUv).g;
        #endif
        if (a < ${UNIFORM_ALPHA_TEST}) discard;
      }
      gl_FragColor = vec4(${UNIFORM_TARGET_INDEX} / 255.0, 0.0, 0.0, 1.0);
    }
  `,
};

// Shader for edge detection and compositing (combined)
const OutlineShader = {
  uniforms: {
    [UNIFORM_T_DIFFUSE]: { value: null },
    [UNIFORM_T_SCENE_DEPTH]: { value: null },
    [UNIFORM_T_MASK]: { value: null },
    [UNIFORM_T_MASK_DEPTH]: { value: null },
    [UNIFORM_T_MASK_2]: { value: null },
    [UNIFORM_T_MASK_DEPTH_2]: { value: null },
    [UNIFORM_CAMERA_NEAR]: { value: 0.1 },
    [UNIFORM_CAMERA_FAR]: { value: 1000.0 },
    [UNIFORM_RESOLUTION]: { value: new Vector2() },
    [UNIFORM_OUTLINE_COLORS]: { value: new Array(MAX_OUTLINES).fill(undefined).map(() => new Color()) },
    [UNIFORM_OUTLINE_OPACITIES]: { value: new Array(MAX_OUTLINES).fill(0) },
    [UNIFORM_OUTLINE_THICKNESSES]: { value: new Array(MAX_OUTLINES).fill(0) },
    [UNIFORM_MAX_THICKNESS]: { value: 0 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    #define MAX_OUTLINES ${MAX_OUTLINES}
    #define MAX_THICKNESS ${MAX_THICKNESS}

    uniform sampler2D ${UNIFORM_T_DIFFUSE};
    uniform sampler2D ${UNIFORM_T_SCENE_DEPTH};
    uniform sampler2D ${UNIFORM_T_MASK};
    uniform sampler2D ${UNIFORM_T_MASK_DEPTH};
    uniform sampler2D ${UNIFORM_T_MASK_2};
    uniform sampler2D ${UNIFORM_T_MASK_DEPTH_2};
    uniform float ${UNIFORM_CAMERA_NEAR};
    uniform float ${UNIFORM_CAMERA_FAR};
    uniform vec2 ${UNIFORM_RESOLUTION};
    uniform vec3 ${UNIFORM_OUTLINE_COLORS}[MAX_OUTLINES];
    uniform float ${UNIFORM_OUTLINE_OPACITIES}[MAX_OUTLINES];
    uniform float ${UNIFORM_OUTLINE_THICKNESSES}[MAX_OUTLINES];
    uniform float ${UNIFORM_MAX_THICKNESS};
    varying vec2 vUv;

    float readLinearDepth(sampler2D depthSampler, vec2 coord) {
      float fragCoordZ = texture2D(depthSampler, coord).x;
      float viewZ = (${UNIFORM_CAMERA_NEAR} * ${UNIFORM_CAMERA_FAR}) / ((${UNIFORM_CAMERA_FAR} - ${UNIFORM_CAMERA_NEAR}) * fragCoordZ - ${UNIFORM_CAMERA_FAR});
      return -viewZ;
    }

    void main() {
      vec4 base = texture2D(${UNIFORM_T_DIFFUSE}, vUv);

      // Determine effective center from both masks (closer entity wins)
      float centerId = 0.0;
      float centerDepth = 1.0e10;
      bool centerIsOccluded = false;

      float occCenterId = texture2D(${UNIFORM_T_MASK}, vUv).r * 255.0;
      if (occCenterId > 0.5) {
        float d = readLinearDepth(${UNIFORM_T_MASK_DEPTH}, vUv);
        if (d < centerDepth) { centerId = occCenterId; centerDepth = d; centerIsOccluded = true; }
      }
      float nonOccCenterId = texture2D(${UNIFORM_T_MASK_2}, vUv).r * 255.0;
      if (nonOccCenterId > 0.5) {
        float d = readLinearDepth(${UNIFORM_T_MASK_DEPTH_2}, vUv);
        if (d <= centerDepth) { centerId = nonOccCenterId; centerDepth = d; centerIsOccluded = false; }
      }

      vec2 texel = vec2(1.0 / ${UNIFORM_RESOLUTION}.x, 1.0 / ${UNIFORM_RESOLUTION}.y);

      vec2 offsets[8];
      offsets[0] = vec2(-1.0, 0.0);
      offsets[1] = vec2(1.0, 0.0);
      offsets[2] = vec2(0.0, 1.0);
      offsets[3] = vec2(0.0, -1.0);
      offsets[4] = vec2(-1.0, 1.0);
      offsets[5] = vec2(1.0, 1.0);
      offsets[6] = vec2(-1.0, -1.0);
      offsets[7] = vec2(1.0, -1.0);

      // Pre-check: sample 8 directions at maxThickness distance.
      // If all boundary samples match the center, there is no edge within the
      // search radius so the expensive loop can be skipped entirely.
      // This can miss entities smaller than the gap between sample points,
      // causing minor outline gaps on very small screen-space objects.
      bool needsSearch = false;
      for (int i = 0; i < 8; i++) {
        vec2 sampleUv = vUv + offsets[i] * texel * ${UNIFORM_MAX_THICKNESS};
        float s1 = texture2D(${UNIFORM_T_MASK}, sampleUv).r * 255.0;
        float s2 = texture2D(${UNIFORM_T_MASK_2}, sampleUv).r * 255.0;
        if (abs(s1 - occCenterId) > 0.5 || abs(s2 - nonOccCenterId) > 0.5) {
          needsSearch = true;
          break;
        }
      }

      // Search both masks separately in all directions and distances up to maxThickness.
      // Track occluded and non-occluded closest entities separately so we can
      // prioritize non-occluded outlines (they should always be visible).
      float closestOccId = 0.0;
      float closestOccDepth = 1.0e10;
      float closestNonOccId = 0.0;
      float closestNonOccDepth = 1.0e10;

      if (needsSearch) {
        for (int t = 1; t <= MAX_THICKNESS; t++) {
          float thickness = float(t);
          if (thickness > ${UNIFORM_MAX_THICKNESS}) {
            break;
          }
          for (int i = 0; i < 8; i++) {
            vec2 sampleUv = vUv + offsets[i] * texel * thickness;

            // Occluded mask (edge = differs from occluded center)
            float sId1 = texture2D(${UNIFORM_T_MASK}, sampleUv).r * 255.0;
            if (sId1 > 0.5 && abs(sId1 - occCenterId) > 0.5) {
              int idx = int(sId1 + 0.5) - 1;
              if (idx >= 0 && idx < MAX_OUTLINES) {
                if (thickness <= ${UNIFORM_OUTLINE_THICKNESSES}[idx]) {
                  float nd = readLinearDepth(${UNIFORM_T_MASK_DEPTH}, sampleUv);
                  if (nd < closestOccDepth) { closestOccId = sId1; closestOccDepth = nd; }
                }
              }
            }

            // Non-occluded mask
            float sId2 = texture2D(${UNIFORM_T_MASK_2}, sampleUv).r * 255.0;
            if (sId2 > 0.5 && abs(sId2 - nonOccCenterId) > 0.5) {
              int idx = int(sId2 + 0.5) - 1;
              if (idx >= 0 && idx < MAX_OUTLINES) {
                if (thickness <= ${UNIFORM_OUTLINE_THICKNESSES}[idx]) {
                  float nd = readLinearDepth(${UNIFORM_T_MASK_DEPTH_2}, sampleUv);
                  if (nd < closestNonOccDepth) { closestNonOccId = sId2; closestNonOccDepth = nd; }
                }
              }
            }
          }
        }
      }

      // Determine which outline to draw, prioritizing non-occluded (always visible)
      float drawId = 0.0;
      bool drawIsOccluded = false;

      // First, try non-occluded outline (occluded:false = always visible)
      if (closestNonOccId > 0.5) {
        bool draw = false;
        if (centerId < 0.5) {
          // Background pixel: always draw
          draw = true;
        } else if (centerIsOccluded) {
          // Non-occluded outline over occluded entity: draw at actual edge
          draw = abs(closestNonOccId - nonOccCenterId) > 0.5;
        } else {
          // Both non-occluded: only draw if neighbor is clearly in front
          draw = closestNonOccDepth < centerDepth - 0.1;
        }
        if (draw) {
          drawId = closestNonOccId;
          drawIsOccluded = false;
        }
      }

      // If no non-occluded outline, try occluded outline
      if (drawId < 0.5 && closestOccId > 0.5) {
        bool draw = false;
        if (centerId < 0.5) {
          // Background pixel: always draw
          draw = true;
        } else if (!centerIsOccluded) {
          // Occluded outline over non-occluded entity: only if clearly in front
          draw = closestOccDepth < centerDepth - 0.1;
        } else {
          // Both occluded: only draw if neighbor is clearly in front
          draw = closestOccDepth < centerDepth - 0.1;
        }
        // Suppress if scene object is in front
        if (draw) {
          float sceneDepth = readLinearDepth(${UNIFORM_T_SCENE_DEPTH}, vUv);
          if (sceneDepth < closestOccDepth - 0.1) {
            draw = false;
          }
        }
        if (draw) {
          drawId = closestOccId;
          drawIsOccluded = true;
        }
      }

      if (drawId > 0.5) {
        int idx = int(drawId + 0.5) - 1;
        vec4 outline = vec4(${UNIFORM_OUTLINE_COLORS}[idx], ${UNIFORM_OUTLINE_OPACITIES}[idx]);
        gl_FragColor = mix(base, outline, outline.a);
      } else {
        gl_FragColor = base;
      }
    }
  `,
};

interface TargetEntry {
  object3d: Object3D;
  targetIndex: number;
}

type MaskMaterialVariants = {
  none: ShaderMaterial;
  map: ShaderMaterial;
  alphaMap: ShaderMaterial;
  mapAndAlphaMap: ShaderMaterial;
};

export class SelectiveOutlinePass extends Pass {
  private _camera: PerspectiveCamera;
  private _fsQuad: FullScreenQuad;
  private _occludedMaskMaterials: MaskMaterialVariants;
  private _nonOccludedMaskMaterials: MaskMaterialVariants;
  private _occludedMaskRenderTarget: WebGLRenderTarget;
  private _nonOccludedMaskRenderTarget: WebGLRenderTarget;
  private _outlineMaterial: ShaderMaterial;
  private _outlineScene: Scene = new Scene();
  private _outlineTargets: OutlineTarget[] | null = null;
  private _resolution: Vector2;
  private _occludedTargets: TargetEntry[] = [];
  private _nonOccludedTargets: TargetEntry[] = [];

  constructor(
    camera: PerspectiveCamera,
    resolution: Vector2,
  ) {
    super();

    this._camera = camera;
    this._resolution = resolution.clone();

    this._outlineScene.matrixAutoUpdate = false;
    this._outlineScene.matrixWorldNeedsUpdate = false;

    this._occludedMaskRenderTarget = new WebGLRenderTarget(
      resolution.x,
      resolution.y,
      {
        depthTexture: new DepthTexture(resolution.x, resolution.y),
      },
    );

    this._nonOccludedMaskRenderTarget = new WebGLRenderTarget(
      resolution.x,
      resolution.y,
      {
        depthTexture: new DepthTexture(resolution.x, resolution.y),
      },
    );

    this._occludedMaskMaterials = this._createMaskMaterialVariants(MaskShader, true);
    this._nonOccludedMaskMaterials = this._createMaskMaterialVariants(MaskNoDepthShader, true);

    this._outlineMaterial = new ShaderMaterial({
      uniforms: UniformsUtils.clone(OutlineShader.uniforms),
      vertexShader: OutlineShader.vertexShader,
      fragmentShader: OutlineShader.fragmentShader,
      blending: NoBlending,
    });

    this._fsQuad = new FullScreenQuad(this._outlineMaterial);
  }

  public set camera(camera: PerspectiveCamera) {
    this._camera = camera;
  }

  public setSize(width: number, height: number): void {
    this._resolution.set(width, height);
    this._occludedMaskRenderTarget.setSize(width, height);
    this._occludedMaskRenderTarget.depthTexture!.image.width = width;
    this._occludedMaskRenderTarget.depthTexture!.image.height = height;
    this._occludedMaskRenderTarget.depthTexture!.needsUpdate = true;
    this._nonOccludedMaskRenderTarget.setSize(width, height);
    this._nonOccludedMaskRenderTarget.depthTexture!.image.width = width;
    this._nonOccludedMaskRenderTarget.depthTexture!.image.height = height;
    this._nonOccludedMaskRenderTarget.depthTexture!.needsUpdate = true;
  }

  public setOutlineTargets(targets: OutlineTarget[]): void {
    this._outlineTargets = targets;
    // Disable pass if no valid targets
    this.enabled = targets.length > 0 && targets[0].object3d !== null && targets[0].options !== null;
  }

  public clearOutlineTargets(): void {
    this._outlineTargets = null;
    this.enabled = false;
  }

  private _createMaskMaterialVariants(shader: typeof MaskShader | typeof MaskNoDepthShader, depthTest: boolean): MaskMaterialVariants {
    const create = (useMap: boolean, useAlphaMap: boolean): ShaderMaterial => {
      const defines: Record<string, string> = {};

      if (useMap) {
        defines[DEFINE_USE_MAP] = '';
      }

      if (useAlphaMap) {
        defines[DEFINE_USE_ALPHA_MAP] = '';
      }

      return new ShaderMaterial({
        uniforms: UniformsUtils.clone(shader.uniforms),
        vertexShader: shader.vertexShader,
        fragmentShader: shader.fragmentShader,
        defines,
        depthTest,
      });
    };

    return {
      none: create(false, false),
      map: create(true, false),
      alphaMap: create(false, true),
      mapAndAlphaMap: create(true, true),
    };
  }

  private _setMaskMaterialUniforms(maskMaterials: MaskMaterialVariants, depthTexture: DepthTexture | null): void {
    const materials = [
      maskMaterials.none,
      maskMaterials.map,
      maskMaterials.alphaMap,
      maskMaterials.mapAndAlphaMap,
    ];

    for (const material of materials) {
      if (UNIFORM_T_DEPTH in material.uniforms) {
        material.uniforms[UNIFORM_T_DEPTH].value = depthTexture;
      }
      if (UNIFORM_CAMERA_NEAR in material.uniforms) {
        material.uniforms[UNIFORM_CAMERA_NEAR].value = this._camera.near;
      }
      if (UNIFORM_CAMERA_FAR in material.uniforms) {
        material.uniforms[UNIFORM_CAMERA_FAR].value = this._camera.far;
      }
    }
  }

  private _selectMaskMaterial(maskMaterials: MaskMaterialVariants, useMap: boolean, useAlphaMap: boolean): ShaderMaterial {
    if (useMap && useAlphaMap) {
      return maskMaterials.mapAndAlphaMap;
    }
    if (useMap) {
      return maskMaterials.map;
    }
    if (useAlphaMap) {
      return maskMaterials.alphaMap;
    }
    return maskMaterials.none;
  }

  private _onBeforeRender = function(
    this: Mesh,
    _renderer: never,
    _scene: never,
    _camera: never,
    _geometry: never,
    material: ShaderMaterial,
  ): void {
    material.uniforms[UNIFORM_TARGET_INDEX].value = this.userData[USERDATA_OUTLINE_TARGET_INDEX] + 1;
    material.uniforms[UNIFORM_T_MAP].value = this.userData[USERDATA_OUTLINE_MAP] ?? null;
    material.uniforms[UNIFORM_T_ALPHA_MAP].value = this.userData[USERDATA_OUTLINE_ALPHA_MAP] ?? null;
    material.uniforms[UNIFORM_ALPHA_TEST].value = this.userData[USERDATA_OUTLINE_ALPHA_TEST] ?? 0.0;
    material.uniforms[UNIFORM_OPACITY].value = this.userData[USERDATA_OUTLINE_OPACITY] ?? 1.0;
    material.side = this.userData[USERDATA_OUTLINE_SIDE];
    material.uniformsNeedUpdate = true;
  };

  private _traverseAndSetupMaterials = (obj: Object3D, maskMaterials: MaskMaterialVariants, targetIndex: number): void => {
    if (obj instanceof Mesh) {
      originalMaterials.set(obj, obj.material);
      originalOnBeforeRenders.set(obj, obj.onBeforeRender);

      // Carry over alpha test, map, alphaMap, opacity, and side from original material
      const origMat = obj.material as any;
      const alphaTest = origMat.alphaTest ?? 0.0;
      if (alphaTest > 0) {
        // Only set textures/opacity if alphaTest is enabled (matches Three.js behavior)
        obj.userData[USERDATA_OUTLINE_MAP] = origMat.map ?? null;
        obj.userData[USERDATA_OUTLINE_ALPHA_MAP] = origMat.alphaMap ?? null;
        obj.userData[USERDATA_OUTLINE_ALPHA_TEST] = alphaTest;
        obj.userData[USERDATA_OUTLINE_OPACITY] = origMat.opacity ?? 1.0;
      } else {
        obj.userData[USERDATA_OUTLINE_MAP] = null;
        obj.userData[USERDATA_OUTLINE_ALPHA_MAP] = null;
        obj.userData[USERDATA_OUTLINE_ALPHA_TEST] = 0.0;
        obj.userData[USERDATA_OUTLINE_OPACITY] = 1.0;
      }
      obj.userData[USERDATA_OUTLINE_SIDE] = origMat.side;

      const maskMaterial = this._selectMaskMaterial(
        maskMaterials,
        !!obj.userData[USERDATA_OUTLINE_MAP],
        !!obj.userData[USERDATA_OUTLINE_ALPHA_MAP],
      );
      obj.material = maskMaterial;
      obj.onBeforeRender = this._onBeforeRender;
      obj.userData[USERDATA_OUTLINE_TARGET_INDEX] = targetIndex;
    }
    for (const child of obj.children) {
      this._traverseAndSetupMaterials(child, maskMaterials, targetIndex);
    }
  }

  /** Render entities to the given mask RT, then restore materials and parents. */
  private _renderMask(
    renderer: WebGLRenderer,
    targets: TargetEntry[],
    maskMaterials: MaskMaterialVariants,
    renderTarget: WebGLRenderTarget,
  ): void {
    for (const { object3d, targetIndex } of targets) {
      originalParents.set(object3d, object3d.parent);
      if (object3d.parent) {
        object3d.parent.remove(object3d);
      }
      this._outlineScene.add(object3d);
      this._traverseAndSetupMaterials(object3d, maskMaterials, targetIndex);
    }

    renderer.setRenderTarget(renderTarget);
    renderer.render(this._outlineScene, this._camera);

    // Restore
    for (const [mesh, originalMaterial] of originalMaterials) {
      mesh.material = originalMaterial;
      delete mesh.userData[USERDATA_OUTLINE_TARGET_INDEX];
      delete mesh.userData[USERDATA_OUTLINE_MAP];
      delete mesh.userData[USERDATA_OUTLINE_ALPHA_MAP];
      delete mesh.userData[USERDATA_OUTLINE_ALPHA_TEST];
      delete mesh.userData[USERDATA_OUTLINE_OPACITY];
      delete mesh.userData[USERDATA_OUTLINE_SIDE];
    }
    for (const [mesh, originalOnBeforeRender] of originalOnBeforeRenders) {
      mesh.onBeforeRender = originalOnBeforeRender;
    }
    for (const [object3d, originalParent] of originalParents) {
      this._outlineScene.remove(object3d);
      if (originalParent) {
        originalParent.add(object3d);
      }
    }
    originalParents.clear();
    originalMaterials.clear();
    originalOnBeforeRenders.clear();
  }

  /** Composite outlines from both masks onto target, reading base from source. */
  private _compositeOutline(
    renderer: WebGLRenderer,
    source: WebGLRenderTarget,
    target: WebGLRenderTarget | null,
  ): void {
    renderer.setRenderTarget(target);
    this._outlineMaterial.uniforms[UNIFORM_T_DIFFUSE].value = source.texture;
    this._outlineMaterial.uniforms[UNIFORM_T_MASK].value = this._occludedMaskRenderTarget.texture;
    this._outlineMaterial.uniforms[UNIFORM_T_MASK_DEPTH].value = this._occludedMaskRenderTarget.depthTexture;
    this._outlineMaterial.uniforms[UNIFORM_T_MASK_2].value = this._nonOccludedMaskRenderTarget.texture;
    this._outlineMaterial.uniforms[UNIFORM_T_MASK_DEPTH_2].value = this._nonOccludedMaskRenderTarget.depthTexture;
    this._fsQuad.render(renderer);
  }

  public render(
    renderer: WebGLRenderer,
    writeBuffer: WebGLRenderTarget,
    readBuffer: WebGLRenderTarget,
  ): void {
    if (this._outlineTargets === null) {
      return;
    }

    const originalAutoClear = renderer.autoClear;
    renderer.getClearColor(originalClearColor);
    const originalClearAlpha = renderer.getClearAlpha();
    renderer.autoClear = false;
    renderer.setClearColor(0x000000, 0);

    // Collect and categorize targets, setup outline uniforms
    this._occludedTargets.length = 0;
    this._nonOccludedTargets.length = 0;
    let maxThickness = 0;

    for (let targetIndex = 0; targetIndex < this._outlineTargets.length; targetIndex++) {
      const { object3d, options } = this._outlineTargets[targetIndex];

      if (object3d === null || options === null) {
        break;
      }

      this._outlineMaterial.uniforms[UNIFORM_OUTLINE_COLORS].value[targetIndex].copy(options.color).multiplyScalar(options.colorIntensity);
      this._outlineMaterial.uniforms[UNIFORM_OUTLINE_OPACITIES].value[targetIndex] = options.opacity;

      // Convert world-unit thickness to pixel thickness
      const distance = worldPosition.setFromMatrixPosition(object3d.matrixWorld).distanceTo(this._camera.position);
      const fovRad = this._camera.fov * Math.PI / 180;
      const pixelThickness = Math.min(MAX_THICKNESS, Math.max(1, options.thickness * this._resolution.y / (2 * distance * Math.tan(fovRad / 2))));
      this._outlineMaterial.uniforms[UNIFORM_OUTLINE_THICKNESSES].value[targetIndex] = pixelThickness;
      maxThickness = Math.max(maxThickness, pixelThickness);

      if (options.occluded) {
        this._occludedTargets.push({ object3d, targetIndex });
      } else {
        this._nonOccludedTargets.push({ object3d, targetIndex });
      }
    }

    this._outlineMaterial.uniforms[UNIFORM_RESOLUTION].value.copy(this._resolution);
    this._outlineMaterial.uniforms[UNIFORM_MAX_THICKNESS].value = maxThickness;
    this._outlineMaterial.uniforms[UNIFORM_CAMERA_NEAR].value = this._camera.near;
    this._outlineMaterial.uniforms[UNIFORM_CAMERA_FAR].value = this._camera.far;
    this._outlineMaterial.uniforms[UNIFORM_T_SCENE_DEPTH].value = readBuffer.depthTexture;

    // Clear both mask render targets
    renderer.setRenderTarget(this._occludedMaskRenderTarget);
    renderer.clear(true, true, true);
    renderer.setRenderTarget(this._nonOccludedMaskRenderTarget);
    renderer.clear(true, true, true);

    // Render occluded mask (depth-tested against scene)
    if (this._occludedTargets.length > 0) {
      this._setMaskMaterialUniforms(this._occludedMaskMaterials, readBuffer.depthTexture);
      this._renderMask(renderer, this._occludedTargets, this._occludedMaskMaterials, this._occludedMaskRenderTarget);
    }

    // Render non-occluded mask (depth-tested against each other only)
    if (this._nonOccludedTargets.length > 0) {
      this._setMaskMaterialUniforms(this._nonOccludedMaskMaterials, null);
      this._renderMask(renderer, this._nonOccludedTargets, this._nonOccludedMaskMaterials, this._nonOccludedMaskRenderTarget);
    }

    // HACK: Detach writeBuffer's depth attachment during composite to avoid a WebGL
    // feedback loop (readBuffer and writeBuffer may share the same underlying depth
    // texture due to EffectComposer's clone). The composite doesn't need depth
    // testing so this is safe. If a Three.js update breaks this, use a depth-copy
    // pass instead. Note: This assumes DEPTH_ATTACHMENT, not DEPTH_STENCIL_ATTACHMENT.
    const compositeTarget = this.renderToScreen ? null : writeBuffer;

    if (compositeTarget !== null && compositeTarget.depthTexture) {
      const gl = renderer.getContext();
      renderer.setRenderTarget(compositeTarget);
      const savedDepthAttachment = gl.getFramebufferAttachmentParameter(
        gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME,
      );
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, null, 0);

      this._compositeOutline(renderer, readBuffer, compositeTarget);

      renderer.setRenderTarget(compositeTarget);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, savedDepthAttachment, 0);
    } else {
      this._compositeOutline(renderer, readBuffer, compositeTarget);
    }

    // Restore renderer state
    renderer.autoClear = originalAutoClear;
    renderer.setClearColor(originalClearColor, originalClearAlpha);
  }

  public dispose(): void {
    this._occludedMaskRenderTarget.dispose();
    this._nonOccludedMaskRenderTarget.dispose();
    this._occludedMaskMaterials.none.dispose();
    this._occludedMaskMaterials.map.dispose();
    this._occludedMaskMaterials.alphaMap.dispose();
    this._occludedMaskMaterials.mapAndAlphaMap.dispose();
    this._nonOccludedMaskMaterials.none.dispose();
    this._nonOccludedMaskMaterials.map.dispose();
    this._nonOccludedMaskMaterials.alphaMap.dispose();
    this._nonOccludedMaskMaterials.mapAndAlphaMap.dispose();
    this._outlineMaterial.dispose();
    this._fsQuad.dispose();
  }
}
