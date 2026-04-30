import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  Sphere,
  Vector3,
  WebGLProgramParametersWithUniforms,
} from 'three';
import EmissiveMeshBasicMaterial from '../gltf/EmissiveMeshBasicMaterial';
import { isAngleVisibilityCullingEnabled, isDistanceVisibilityCullingEnabled } from '../core/VisibilityCulling';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import EntityStats from './EntityStats';
import type StaticEntity from './StaticEntity';
import type Game from '../Game';
import Assets from '../network/Assets';
import { updateAABB } from '../three/utils';

type StaticEntityEntry = {
  uri: string;
  gltfPromise: Promise<GLTF>;
  gltf: GLTF | null;
  entities: Set<StaticEntity>;
  entityToInstanceIndex: Map<StaticEntity, number>;
  instanceIndexToEntity: Map<number, StaticEntity>;
  sourceToInstancedMesh: Map<Mesh, StaticEntityInstancedMesh>;
};

const INITIAL_INSTANCE_COUNT = 16;
const INSTANCE_COUNT_INCREASE_FACTOR = 2;

const INSTANCE_LIGHT_LEVEL_ATTRIBUTE = 'instanceLightLevel';
const INSTANCE_LIGHT_LEVEL_VARYING = 'v' + INSTANCE_LIGHT_LEVEL_ATTRIBUTE[0].toUpperCase() + INSTANCE_LIGHT_LEVEL_ATTRIBUTE.slice(1);
const INSTANCE_SKY_LIGHT_ATTRIBUTE = 'instanceSkyLight';
const INSTANCE_SKY_LIGHT_VARYING = 'v' + INSTANCE_SKY_LIGHT_ATTRIBUTE[0].toUpperCase() + INSTANCE_SKY_LIGHT_ATTRIBUTE.slice(1);
const INSTANCE_EMISSIVE_ATTRIBUTE = 'instanceEmissive';
const INSTANCE_EMISSIVE_VARYING = 'v' + INSTANCE_EMISSIVE_ATTRIBUTE[0].toUpperCase() + INSTANCE_EMISSIVE_ATTRIBUTE.slice(1);

const DEFAULT_TINT_COLOR = new Color(1, 1, 1);

const WORLD_NORMAL_Y_VARYING = 'vWorldNormalY';

const UNIFORM_RAW_AMBIENT_LIGHT_COLOR = 'rawAmbientLightColor';
const UNIFORM_AMBIENT_LIGHT_INTENSITY = 'ambientLightIntensity';
const STATIC_INSTANCE_SHADOW_LOD_MAX_CAMERA_DISTANCE_RATIO = 0.75;
const STATIC_INSTANCE_SHADOW_LOD_FOCUS_PADDING_RATIO = 0.3;
const STATIC_INSTANCE_SHADOW_LOD_MIN_PROJECTED_RADIUS = 0.02;
const UNIFORM_DISTANCE_VISIBILITY_ANCHOR = 'distanceVisibilityAnchor';
const UNIFORM_HAS_DISTANCE_VISIBILITY_ANCHOR = 'hasDistanceVisibilityAnchor';

// Working variables
const mat4 = new Matrix4();
const box3 = new Box3();
const vec3 = new Vector3();
const sphere = new Sphere();

const UNIFORM_VIEW_DISTANCE_SQUARED = 'viewDistanceSquared';

const getInstanceCapacityForIndex = (currentCapacity: number, instanceIndex: number): number => {
  let nextCapacity = Math.max(currentCapacity, INITIAL_INSTANCE_COUNT);
  const requiredCapacity = instanceIndex + 1;

  while (nextCapacity < requiredCapacity) {
    nextCapacity *= INSTANCE_COUNT_INCREASE_FACTOR;
  }

  return nextCapacity;
};

type StaticEntityInstancedMaterial = EmissiveMeshBasicMaterial | EmissiveMeshBasicMaterial[];

const getInstancedMaterialList = (material: StaticEntityInstancedMaterial): EmissiveMeshBasicMaterial[] => {
  return Array.isArray(material) ? material : [material];
};

const cloneInstancedMaterial = (material: Mesh['material']): StaticEntityInstancedMaterial => {
  const clonedMaterials = (Array.isArray(material) ? material : [material]).map(sourceMaterial => {
    return (sourceMaterial as EmissiveMeshBasicMaterial).clone();
  });

  return Array.isArray(material) ? clonedMaterials : clonedMaterials[0];
};

const createReusableInstancedGeometry = (sourceGeometry: BufferGeometry): BufferGeometry => {
  if (Object.keys(sourceGeometry.morphAttributes).length > 0) {
    return sourceGeometry.clone();
  }

  const geometry = new BufferGeometry();

  for (const name in sourceGeometry.attributes) {
    const attribute = sourceGeometry.attributes[name];
    if (!(attribute instanceof BufferAttribute)) {
      return sourceGeometry.clone();
    }

    geometry.setAttribute(name, new BufferAttribute(attribute.array, attribute.itemSize, attribute.normalized));
  }

  const index = sourceGeometry.getIndex();
  if (index) {
    if (!(index instanceof BufferAttribute)) {
      return sourceGeometry.clone();
    }

    geometry.setIndex(new BufferAttribute(index.array, index.itemSize, index.normalized));
  }

  geometry.groups = sourceGeometry.groups.map(group => ({ ...group }));
  geometry.drawRange.start = sourceGeometry.drawRange.start;
  geometry.drawRange.count = sourceGeometry.drawRange.count;
  geometry.boundingBox = sourceGeometry.boundingBox?.clone() ?? null;
  geometry.boundingSphere = sourceGeometry.boundingSphere?.clone() ?? null;

  return geometry;
};

// There is a lot of duplicated code for shader hacks across other modules, so I
// want to consolidate it and manage it in one place.
class StaticEntityInstancedMesh extends InstancedMesh<BufferGeometry, StaticEntityInstancedMaterial> {
  private _game: Game;
  private _uniforms: Record<string, { value: number | Color | Vector3 }>;

  constructor(
    game: Game,
    geometry: BufferGeometry,
    material: StaticEntityInstancedMaterial,
    count: number,
    materialInitialized: boolean = false,
  ) {
    super(geometry, material, count);

    this._game = game;
    this._uniforms = {
      [UNIFORM_VIEW_DISTANCE_SQUARED]: {
        get value(): number {
          return isDistanceVisibilityCullingEnabled(game.settingsManager.qualityPerfTradeoff.viewDistance.enabled)
            ? Math.pow(game.renderer.viewDistance, 2)
            : Number.MAX_SAFE_INTEGER;
        },
      },
      [UNIFORM_DISTANCE_VISIBILITY_ANCHOR]: {
        get value(): Vector3 {
          return game.camera.distanceVisibilityAnchor ?? game.camera.activeCamera.position;
        },
      },
      [UNIFORM_HAS_DISTANCE_VISIBILITY_ANCHOR]: {
        get value(): number {
          return game.camera.distanceVisibilityAnchor ? 1 : 0;
        },
      },
      [UNIFORM_RAW_AMBIENT_LIGHT_COLOR]: { value: game.renderer.ambientLight.color },
      [UNIFORM_AMBIENT_LIGHT_INTENSITY]: {
        get value(): number { return game.renderer.ambientLight.intensity; },
      },
    };

    this._setupGeometry();
    if (!materialInitialized) {
      this._installShaderProcessors();
    }
  }

  private _getMaterials(): EmissiveMeshBasicMaterial[] {
    return getInstancedMaterialList(this.material);
  }

  public get referenceMaterial(): EmissiveMeshBasicMaterial {
    return this._getMaterials()[0];
  }

  private _setupGeometry(): void {
    this.matrixAutoUpdate = false;
    this.matrixWorldAutoUpdate = false;
    this.frustumCulled = isAngleVisibilityCullingEnabled();
    this.castShadow = true;
    this.receiveShadow = true;
    updateAABB(this);

    const instanceLightLevel = new InstancedBufferAttribute(new Float32Array(this.count), 1);
    instanceLightLevel.setUsage(DynamicDrawUsage);
    this.geometry.setAttribute(INSTANCE_LIGHT_LEVEL_ATTRIBUTE, instanceLightLevel);

    const instanceSkyLight = new InstancedBufferAttribute(new Float32Array(this.count), 1);
    instanceSkyLight.setUsage(DynamicDrawUsage);
    this.geometry.setAttribute(INSTANCE_SKY_LIGHT_ATTRIBUTE, instanceSkyLight);

    const instanceEmissive = new InstancedBufferAttribute(new Float32Array(this.count * 4), 4);
    instanceEmissive.setUsage(DynamicDrawUsage);
    this.geometry.setAttribute(INSTANCE_EMISSIVE_ATTRIBUTE, instanceEmissive);

    // Initialize instanceColor using Three.js built-in support
    this.setColorAt(0, this.referenceMaterial.color);
    this.instanceColor!.setUsage(DynamicDrawUsage);
  }

  private _installShaderProcessors(): void {
    const lightingProcessor = (params: WebGLProgramParametersWithUniforms) => {
      for (const key in this._uniforms) {
        params.uniforms[key] = this._uniforms[key as keyof typeof this._uniforms];
      }

      params.vertexShader = params.vertexShader
        .replace(
          'void main() {',
          `
            uniform float ${UNIFORM_VIEW_DISTANCE_SQUARED};
            uniform vec3 ${UNIFORM_DISTANCE_VISIBILITY_ANCHOR};
            uniform float ${UNIFORM_HAS_DISTANCE_VISIBILITY_ANCHOR};

            attribute float ${INSTANCE_LIGHT_LEVEL_ATTRIBUTE};
            varying float ${INSTANCE_LIGHT_LEVEL_VARYING};

            attribute float ${INSTANCE_SKY_LIGHT_ATTRIBUTE};
            varying float ${INSTANCE_SKY_LIGHT_VARYING};

            attribute vec4 ${INSTANCE_EMISSIVE_ATTRIBUTE};
            varying vec4 ${INSTANCE_EMISSIVE_VARYING};

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
              ${INSTANCE_LIGHT_LEVEL_VARYING} = ${INSTANCE_LIGHT_LEVEL_ATTRIBUTE};
              ${INSTANCE_SKY_LIGHT_VARYING} = ${INSTANCE_SKY_LIGHT_ATTRIBUTE};
              ${INSTANCE_EMISSIVE_VARYING} = ${INSTANCE_EMISSIVE_ATTRIBUTE};
              ${WORLD_NORMAL_Y_VARYING} = getWorldNormalY(normal, instanceMatrix);

              // Early View Distance check
              vec2 instanceXZ = instanceMatrix[3].xz;
              vec2 closestVisibilityPoint = cameraPosition.xz;
              if (${UNIFORM_HAS_DISTANCE_VISIBILITY_ANCHOR} > 0.5) {
                vec2 segment = ${UNIFORM_DISTANCE_VISIBILITY_ANCHOR}.xz - cameraPosition.xz;
                float segmentLengthSquared = dot(segment, segment);
                if (segmentLengthSquared > 0.000001) {
                  float segmentT = clamp(dot(instanceXZ - cameraPosition.xz, segment) / segmentLengthSquared, 0.0, 1.0);
                  closestVisibilityPoint = cameraPosition.xz + segment * segmentT;
                }
              }

              vec2 toVisibilitySegment = instanceXZ - closestVisibilityPoint;
              float distanceSquared = dot(toVisibilitySegment, toVisibilitySegment);

              if (distanceSquared > ${UNIFORM_VIEW_DISTANCE_SQUARED}) {
                gl_Position = vec4(9999.0, 9999.0, 9999.0, 1.0);
                return;
              }

              // Question: Also Early Frustum Culling in Shader could reduce the GPU cost?
            `,
        );

      params.fragmentShader = params.fragmentShader
        .replace(
          'void main() {',
          `
            varying float ${INSTANCE_LIGHT_LEVEL_VARYING};
            varying float ${INSTANCE_SKY_LIGHT_VARYING};
            varying vec4 ${INSTANCE_EMISSIVE_VARYING};
            uniform vec3 ${UNIFORM_RAW_AMBIENT_LIGHT_COLOR};
            uniform float ${UNIFORM_AMBIENT_LIGHT_INTENSITY};

            varying float ${WORLD_NORMAL_Y_VARYING};

            void main() {
          `
        )
        .replace(
          '#include <opaque_fragment>',
          `
            #include <opaque_fragment>
          `,
        );
    };

    const emissiveProcessor = (params: WebGLProgramParametersWithUniforms) => {
      params.fragmentShader = params.fragmentShader
        .replace(
          'vec3 totalEmissiveRadiance = emissive;',
          `vec3 totalEmissiveRadiance = ${INSTANCE_EMISSIVE_VARYING}.rgb * ${INSTANCE_EMISSIVE_VARYING}.a;`,
        );
    };

    for (const material of this._getMaterials()) {
      material.addShaderProcessor(lightingProcessor);
      material.addShaderProcessor(emissiveProcessor, true);
    }
  }

  public updateShadowCasterLod(): void {
    if (this.count <= 0 || this.boundingSphere === null) {
      this.castShadow = false;
      return;
    }

    const shadows = this._game.settingsManager.qualityPerfTradeoff.shadows;
    if (!shadows?.enabled) {
      this.castShadow = false;
      return;
    }

    const cameraPosition = this._game.camera.activeCamera.position;
    const shadowFocusCenter = this._game.renderer.directionalShadowFocusCenter;
    const directionalShadowDistance = this._game.renderer.directionalShadowDistance;
    const distanceToCamera = this.boundingSphere.center.distanceTo(cameraPosition);
    const maxCasterDistance = Math.min(
      this._game.renderer.viewDistance * STATIC_INSTANCE_SHADOW_LOD_MAX_CAMERA_DISTANCE_RATIO,
      directionalShadowDistance * 1.9 + this.boundingSphere.radius * 1.5,
    );
    const focusRadius = directionalShadowDistance * (1 + STATIC_INSTANCE_SHADOW_LOD_FOCUS_PADDING_RATIO) + this.boundingSphere.radius;
    const dxFocus = this.boundingSphere.center.x - shadowFocusCenter.x;
    const dzFocus = this.boundingSphere.center.z - shadowFocusCenter.z;
    const projectedRadius = this.boundingSphere.radius / Math.max(distanceToCamera, 1);

    this.castShadow = distanceToCamera <= maxCasterDistance
      && (dxFocus * dxFocus + dzFocus * dzFocus) <= focusRadius * focusRadius
      && (
        projectedRadius >= STATIC_INSTANCE_SHADOW_LOD_MIN_PROJECTED_RADIUS
        || distanceToCamera <= directionalShadowDistance
      );
  }

  public dispose(disposeMaterial: boolean = true): this {
    this.geometry.dispose();
    if (disposeMaterial) {
      for (const material of this._getMaterials()) {
        material.dispose();
      }
    }
    return this;
  }
}

export default class StaticEntityManager {
  private _game: Game;
  private _uriToEntry: Map<string, StaticEntityEntry> = new Map();
  private _instancedMeshesInScene: StaticEntityInstancedMesh[] = [];
  private _nearbyReflectionMeshes: StaticEntityInstancedMesh[] = [];

  constructor(game: Game) {
    this._game = game;
  }

  private _createEntry(uri: string): StaticEntityEntry {
    const gltfPromise: Promise<GLTF> = Assets.getEffectiveGLTFlUri(uri, false, true)
      .then(effectiveUri => Assets.gltfLoader.loadAsync(effectiveUri))
      .then(gltf => {
        gltf.scene.position.sub(box3.setFromObject(gltf.scene, true).getCenter(vec3));
        gltf.scene.updateMatrixWorld();

        gltf.scene.traverse(obj => {
          obj.matrixAutoUpdate = false;
          obj.matrixWorldAutoUpdate = false;
        });

        return gltf;
      }).catch(error => {
        // TODO: Proper error handling
        console.error(error);
        throw error;
      });

    return {
      uri,
      gltfPromise,
      gltf: null,
      entities: new Set(),
      entityToInstanceIndex: new Map(),
      instanceIndexToEntity: new Map(),
      sourceToInstancedMesh: new Map(),
    };
  }

  public async add(entity: StaticEntity): Promise<void> {
    if (!entity.modelUri) {
      throw new Error(`StaticEntityManager: Entity ${entity.id} has no modelUri`);
    }

    if (!this._uriToEntry.has(entity.modelUri)) {
      this._uriToEntry.set(entity.modelUri, this._createEntry(entity.modelUri));
    }

    const entry = this._uriToEntry.get(entity.modelUri)!;
    const initialInstanceIndex = entry.entities.size;
    entry.entityToInstanceIndex.set(entity, initialInstanceIndex);
    entry.instanceIndexToEntity.set(initialInstanceIndex, entity);
    entry.entities.add(entity);

    EntityStats.staticEnvironmentCount++;

    try {
      entry.gltf = await entry.gltfPromise;
    } catch (error) {
      console.error(error);
      throw new Error(`StaticEntity: Failed to load GLTF: ${entry.uri}`);
    }

    // The entity may have been removed or compacted into a different slot while
    // the GLTF was loading, so resolve its current slot after the await.
    const instanceIndex = entry.entityToInstanceIndex.get(entity);
    if (instanceIndex === undefined || !entry.entities.has(entity) || !this._uriToEntry.has(entry.uri)) {
      return;
    }

    entry.gltf!.scene.traverse((sourceMesh) => {
      if (!(sourceMesh instanceof Mesh)) {
        return;
      }

      let instancedMesh = entry.sourceToInstancedMesh.get(sourceMesh);

      if (!instancedMesh || instanceIndex >= instancedMesh.instanceMatrix.count) {
        // GLTF load callbacks can resolve out of order, so the next slot may be
        // far beyond a single growth step when many map entities share a model.
        const currentInstanceCount = instancedMesh?.instanceMatrix.count ?? 0;
        const newInstanceCount = getInstanceCapacityForIndex(currentInstanceCount, instanceIndex);
        const material = instancedMesh
          ? instancedMesh.material
          : cloneInstancedMaterial(sourceMesh.material);
        const newInstancedMesh = new StaticEntityInstancedMesh(
          this._game,
          createReusableInstancedGeometry(sourceMesh.geometry),
          material,
          newInstanceCount,
          !!instancedMesh,
        );

        if (instancedMesh) {
          (newInstancedMesh.instanceMatrix.array as Float32Array).set(instancedMesh.instanceMatrix.array as Float32Array);

          const oldLightLevelAttribute = instancedMesh.geometry.getAttribute(INSTANCE_LIGHT_LEVEL_ATTRIBUTE)!;
          const newLightLevelAttribute = newInstancedMesh.geometry.getAttribute(INSTANCE_LIGHT_LEVEL_ATTRIBUTE)!;
          (newLightLevelAttribute.array as Float32Array).set(oldLightLevelAttribute.array as Float32Array);

          const oldSkyLightAttribute = instancedMesh.geometry.getAttribute(INSTANCE_SKY_LIGHT_ATTRIBUTE)!;
          const newSkyLightAttribute = newInstancedMesh.geometry.getAttribute(INSTANCE_SKY_LIGHT_ATTRIBUTE)!;
          (newSkyLightAttribute.array as Float32Array).set(oldSkyLightAttribute.array as Float32Array);

          const oldEmissiveAttribute = instancedMesh.geometry.getAttribute(INSTANCE_EMISSIVE_ATTRIBUTE)!;
          const newEmissiveAttribute = newInstancedMesh.geometry.getAttribute(INSTANCE_EMISSIVE_ATTRIBUTE)!;
          (newEmissiveAttribute.array as Float32Array).set(oldEmissiveAttribute.array as Float32Array);

          (newInstancedMesh.instanceColor!.array as Float32Array).set(instancedMesh.instanceColor!.array as Float32Array);
          newInstancedMesh.count = instancedMesh.count;

          // Preserve incremental frustum culling bounds across reallocation.
          if (instancedMesh.boundingSphere) {
            newInstancedMesh.boundingSphere = instancedMesh.boundingSphere.clone();
          }

          instancedMesh.dispose(false);
          this._game.renderer.removeFromScene(instancedMesh);
          entry.sourceToInstancedMesh.delete(sourceMesh);
        }

        this._game.renderer.addToScene(newInstancedMesh);
        entry.sourceToInstancedMesh.set(sourceMesh, newInstancedMesh);

        instancedMesh = newInstancedMesh;
      }

      instancedMesh.setMatrixAt(instanceIndex, mat4.copy(entity.entityRoot.matrixWorld).multiply(sourceMesh.matrixWorld));
      // TODO: Range update?
      instancedMesh.instanceMatrix.needsUpdate = true;

      instancedMesh.setColorAt(instanceIndex, entity.tintColor ?? DEFAULT_TINT_COLOR);
      instancedMesh.instanceColor!.needsUpdate = true;

      const lightLevelAttribute = instancedMesh.geometry.getAttribute(INSTANCE_LIGHT_LEVEL_ATTRIBUTE)!;
      lightLevelAttribute.setX(instanceIndex, entity.lightLevel);
      lightLevelAttribute.needsUpdate = true;

      const skyLightAttribute = instancedMesh.geometry.getAttribute(INSTANCE_SKY_LIGHT_ATTRIBUTE)!;
      skyLightAttribute.setX(instanceIndex, entity.skyLight);
      skyLightAttribute.needsUpdate = true;

      const emissiveAttribute = instancedMesh.geometry.getAttribute(INSTANCE_EMISSIVE_ATTRIBUTE)!;
      const emissiveColor = entity.emissiveColor ?? instancedMesh.referenceMaterial.customEmissive;
      const emissiveIntensity = entity.emissiveIntensity ?? instancedMesh.referenceMaterial.customEmissiveIntensity;
      emissiveAttribute.setXYZW(
        instanceIndex,
        emissiveColor.r,
        emissiveColor.g,
        emissiveColor.b,
        emissiveIntensity,
      );
      emissiveAttribute.needsUpdate = true;

      instancedMesh.count = instanceIndex + 1;

      if (instancedMesh.geometry.boundingSphere === null) {
        instancedMesh.geometry.computeBoundingSphere();
      }

      sphere.copy(instancedMesh.geometry.boundingSphere!).applyMatrix4(mat4);

      if (instancedMesh.boundingSphere === null) {
        instancedMesh.boundingSphere = sphere.clone();
      } else {
        instancedMesh.boundingSphere.union(sphere);
      }

      instancedMesh.updateShadowCasterLod();
    });
  }

  public remove(entity: StaticEntity): boolean {
    const uri = entity.modelUri;
    if (!uri) {
      return false;
    }

    const entry = this._uriToEntry.get(uri);
    const removedIndex = entry?.entityToInstanceIndex.get(entity);
    if (!entry || removedIndex === undefined) {
      return false;
    }

    const lastIndex = entry.entities.size - 1;
    const movedEntity = removedIndex !== lastIndex ? entry.instanceIndexToEntity.get(lastIndex) : undefined;

    if (movedEntity) {
      entry.entityToInstanceIndex.set(movedEntity, removedIndex);
      entry.instanceIndexToEntity.set(removedIndex, movedEntity);
    }

    entry.entityToInstanceIndex.delete(entity);
    entry.instanceIndexToEntity.delete(lastIndex);
    entry.entities.delete(entity);
    EntityStats.staticEnvironmentCount = Math.max(0, EntityStats.staticEnvironmentCount - 1);

    for (const instancedMesh of entry.sourceToInstancedMesh.values()) {
      if (movedEntity) {
        const matrixArray = instancedMesh.instanceMatrix.array as Float32Array;
        matrixArray.copyWithin(removedIndex * 16, lastIndex * 16, (lastIndex + 1) * 16);
        instancedMesh.instanceMatrix.needsUpdate = true;

        const colorAttribute = instancedMesh.instanceColor;
        if (colorAttribute) {
          const { itemSize } = colorAttribute;
          (colorAttribute.array as Float32Array).copyWithin(
            removedIndex * itemSize,
            lastIndex * itemSize,
            (lastIndex + 1) * itemSize,
          );
          colorAttribute.needsUpdate = true;
        }

        const lightLevelAttribute = instancedMesh.geometry.getAttribute(INSTANCE_LIGHT_LEVEL_ATTRIBUTE);
        lightLevelAttribute.array.copyWithin(removedIndex, lastIndex, lastIndex + 1);
        lightLevelAttribute.needsUpdate = true;

        const skyLightAttribute = instancedMesh.geometry.getAttribute(INSTANCE_SKY_LIGHT_ATTRIBUTE);
        skyLightAttribute.array.copyWithin(removedIndex, lastIndex, lastIndex + 1);
        skyLightAttribute.needsUpdate = true;

        const emissiveAttribute = instancedMesh.geometry.getAttribute(INSTANCE_EMISSIVE_ATTRIBUTE);
        const emissiveItemSize = emissiveAttribute.itemSize;
        emissiveAttribute.array.copyWithin(
          removedIndex * emissiveItemSize,
          lastIndex * emissiveItemSize,
          (lastIndex + 1) * emissiveItemSize,
        );
        emissiveAttribute.needsUpdate = true;
      }

      instancedMesh.count = lastIndex;
      instancedMesh.updateShadowCasterLod();
    }

    if (entry.entities.size === 0) {
      for (const instancedMesh of entry.sourceToInstancedMesh.values()) {
        this._game.renderer.removeFromScene(instancedMesh);
        instancedMesh.dispose();
      }

      entry.sourceToInstancedMesh.clear();
      this._uriToEntry.delete(uri);
    }

    return true;
  }

  public removeByEntityId(entityId: number): boolean {
    for (const entry of this._uriToEntry.values()) {
      for (const entity of entry.entities) {
        if (entity.id === entityId) {
          return this.remove(entity);
        }
      }
    }

    return false;
  }

  public get instancedMeshesInScene(): StaticEntityInstancedMesh[] {
    this._instancedMeshesInScene.length = 0;

    for (const entry of this._uriToEntry.values()) {
      for (const instancedMesh of entry.sourceToInstancedMesh.values()) {
        if (instancedMesh.parent !== null && instancedMesh.visible && instancedMesh.count > 0) {
          this._instancedMeshesInScene.push(instancedMesh);
        }
      }
    }

    return this._instancedMeshesInScene;
  }

  public getReflectionCandidateMeshesNear(
    worldPosition: { x: number; y: number; z: number },
    maxDistance: number,
  ): StaticEntityInstancedMesh[] {
    const nearbyMeshes = this._nearbyReflectionMeshes;
    nearbyMeshes.length = 0;

    for (const instancedMesh of this.instancedMeshesInScene) {
      if (instancedMesh.boundingSphere === null) {
        continue;
      }

      const limit = maxDistance + instancedMesh.boundingSphere.radius;
      const dx = instancedMesh.boundingSphere.center.x - worldPosition.x;
      const dy = instancedMesh.boundingSphere.center.y - worldPosition.y;
      const dz = instancedMesh.boundingSphere.center.z - worldPosition.z;
      if (dx * dx + dy * dy + dz * dz <= limit * limit) {
        nearbyMeshes.push(instancedMesh);
      }
    }

    return nearbyMeshes;
  }

  public updateLightLevel(): void {
    for (const entry of this._uriToEntry.values()) {
      for (const entity of entry.entities) {
        entity.updateLightLevel();
        const index = entry.entityToInstanceIndex.get(entity)!;
        for (const instancedMesh of entry.sourceToInstancedMesh.values()) {
          instancedMesh.geometry.getAttribute(INSTANCE_LIGHT_LEVEL_ATTRIBUTE)!.setX(index, entity.lightLevel);
        }
      }
      for (const instancedMesh of entry.sourceToInstancedMesh.values()) {
        instancedMesh.geometry.getAttribute(INSTANCE_LIGHT_LEVEL_ATTRIBUTE)!.needsUpdate = true;
      }
    }
  }

  public updateSkyLight(): void {
    for (const entry of this._uriToEntry.values()) {
      for (const entity of entry.entities) {
        entity.updateSkyLight();
        const index = entry.entityToInstanceIndex.get(entity)!;
        for (const instancedMesh of entry.sourceToInstancedMesh.values()) {
          instancedMesh.geometry.getAttribute(INSTANCE_SKY_LIGHT_ATTRIBUTE)!.setX(index, entity.skyLight);
        }
      }
      for (const instancedMesh of entry.sourceToInstancedMesh.values()) {
        instancedMesh.geometry.getAttribute(INSTANCE_SKY_LIGHT_ATTRIBUTE)!.needsUpdate = true;
      }
    }
  }

  public updateShadowCasterLod(): void {
    for (const entry of this._uriToEntry.values()) {
      for (const instancedMesh of entry.sourceToInstancedMesh.values()) {
        instancedMesh.updateShadowCasterLod();
      }
    }
  }
}
