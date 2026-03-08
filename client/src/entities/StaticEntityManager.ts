import {
  Box3,
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

// Working variables
const mat4 = new Matrix4();
const box3 = new Box3();
const vec3 = new Vector3();
const sphere = new Sphere();

const UNIFORM_VIEW_DISTANCE_SQUARED = 'viewDistanceSquared';

// There is a lot of duplicated code for shader hacks across other modules, so I
// want to consolidate it and manage it in one place.
class StaticEntityInstancedMesh extends InstancedMesh<BufferGeometry, EmissiveMeshBasicMaterial> {
  private _uniforms: Record<string, { value: number | Color }>;

  constructor(game: Game, geometry: BufferGeometry, material: EmissiveMeshBasicMaterial, count: number) {
    super(geometry, material, count);

    this._uniforms = {
      [UNIFORM_VIEW_DISTANCE_SQUARED]: {
        get value(): number { return Math.pow(game.renderer.viewDistance, 2); },
      },
      [UNIFORM_RAW_AMBIENT_LIGHT_COLOR]: { value: game.renderer.ambientLight.color },
      [UNIFORM_AMBIENT_LIGHT_INTENSITY]: {
        get value(): number { return game.renderer.ambientLight.intensity; },
      },
    };

    this._setup();
  }

  private _setup(): void {
    this.matrixAutoUpdate = false;
    this.matrixWorldAutoUpdate = false;
    this.frustumCulled = true;
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
    this.setColorAt(0, this.material.color);
    this.instanceColor!.setUsage(DynamicDrawUsage);

    this.material.addShaderProcessor((params: WebGLProgramParametersWithUniforms) => {
      for (const key in this._uniforms) {
        params.uniforms[key] = this._uniforms[key as keyof typeof this._uniforms];
      }

      params.vertexShader = params.vertexShader
        .replace(
          'void main() {',
          `
            uniform float ${UNIFORM_VIEW_DISTANCE_SQUARED};

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
              vec3 toCamera = instanceMatrix[3].xyz - cameraPosition;
              float distanceSquared = toCamera.x * toCamera.x + toCamera.z * toCamera.z;
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
    });

    this.material.addShaderProcessor((params: WebGLProgramParametersWithUniforms) => {
      params.fragmentShader = params.fragmentShader
        .replace(
          'vec3 totalEmissiveRadiance = emissive;',
          `vec3 totalEmissiveRadiance = ${INSTANCE_EMISSIVE_VARYING}.rgb * ${INSTANCE_EMISSIVE_VARYING}.a;`,
        );
    }, true);
  }

  public dispose(): this {
    this.geometry.dispose();
    this.material.dispose();
    return this;
  }
}

export default class StaticEntityManager {
  private _game: Game;
  private _uriToEntry: Map<string, StaticEntityEntry> = new Map();

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
    const instanceIndex = entry.entities.size;
    entry.entityToInstanceIndex.set(entity, instanceIndex);
    entry.instanceIndexToEntity.set(instanceIndex, entity);
    entry.entities.add(entity);

    EntityStats.staticEnvironmentCount++;

    try {
      entry.gltf = await entry.gltfPromise;
    } catch (error) {
      console.error(error);
      throw new Error(`StaticEntity: Failed to load GLTF: ${entry.uri}`);
    }

    entry.gltf!.scene.traverse((sourceMesh) => {
      if (!(sourceMesh instanceof Mesh)) {
        return;
      }

      let instancedMesh = entry.sourceToInstancedMesh.get(sourceMesh);

      if (!instancedMesh || instanceIndex >= instancedMesh.instanceMatrix.count) {
        const newInstanceCount = instancedMesh ? instancedMesh.instanceMatrix.count * INSTANCE_COUNT_INCREASE_FACTOR : INITIAL_INSTANCE_COUNT;
        const newInstancedMesh = new StaticEntityInstancedMesh(this._game, sourceMesh.geometry.clone(), sourceMesh.material.clone(), newInstanceCount);

        if (instancedMesh) {
          for (let i = 0; i < instancedMesh.instanceMatrix.array.length; i++) {
            newInstancedMesh.instanceMatrix.array[i] = instancedMesh.instanceMatrix.array[i];
          }

          const oldLightLevelAttribute = instancedMesh.geometry.getAttribute(INSTANCE_LIGHT_LEVEL_ATTRIBUTE)!;
          const newLightLevelAttribute = newInstancedMesh.geometry.getAttribute(INSTANCE_LIGHT_LEVEL_ATTRIBUTE)!;
          for (let i = 0; i < oldLightLevelAttribute.count; i++) {
            newLightLevelAttribute.setX(i, oldLightLevelAttribute.getX(i));
          }

          const oldSkyLightAttribute = instancedMesh.geometry.getAttribute(INSTANCE_SKY_LIGHT_ATTRIBUTE)!;
          const newSkyLightAttribute = newInstancedMesh.geometry.getAttribute(INSTANCE_SKY_LIGHT_ATTRIBUTE)!;
          for (let i = 0; i < oldSkyLightAttribute.count; i++) {
            newSkyLightAttribute.setX(i, oldSkyLightAttribute.getX(i));
          }

          const oldEmissiveAttribute = instancedMesh.geometry.getAttribute(INSTANCE_EMISSIVE_ATTRIBUTE)!;
          const newEmissiveAttribute = newInstancedMesh.geometry.getAttribute(INSTANCE_EMISSIVE_ATTRIBUTE)!;
          for (let i = 0; i < oldEmissiveAttribute.count; i++) {
            newEmissiveAttribute.setXYZW(i, oldEmissiveAttribute.getX(i), oldEmissiveAttribute.getY(i), oldEmissiveAttribute.getZ(i), oldEmissiveAttribute.getW(i));
          }

          for (let i = 0; i < instancedMesh.instanceColor!.count; i++) {
            newInstancedMesh.instanceColor!.setXYZ(i, instancedMesh.instanceColor!.getX(i), instancedMesh.instanceColor!.getY(i), instancedMesh.instanceColor!.getZ(i));
          }

          // Preserve incremental frustum culling bounds across reallocation.
          if (instancedMesh.boundingSphere) {
            newInstancedMesh.boundingSphere = instancedMesh.boundingSphere.clone();
          }

          instancedMesh.dispose();
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
      const emissiveColor = entity.emissiveColor ?? instancedMesh.material.customEmissive;
      const emissiveIntensity = entity.emissiveIntensity ?? instancedMesh.material.customEmissiveIntensity;
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
    });
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
}
