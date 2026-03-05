import {
  AdditiveAnimationBlendMode,
  AnimationClip,
  AnimationMixer,
  AnimationAction,
  AnimationUtils,
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  Frustum,
  Group,
  LoopOnce,
  LoopPingPong,
  LoopRepeat,
  Mesh,
  MeshBasicMaterial,
  NormalAnimationBlendMode,
  Object3D,
  PropertyMixer,
  Quaternion,
  type QuaternionLike,
  Texture,
  Vector2,
  Vector3,
  type Vector3Like,
  WebGLProgramParametersWithUniforms,
} from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js'
import { type EntityId } from './EntityConstants';
import EntityStats from './EntityStats';
import { type BlocksBufferGeometryData, FACE_SHADE_BOTTOM, FACE_SHADE_SIDE, FACE_SHADE_TOP, LIGHT_LEVEL_STRENGTH_MULTIPLIER, MAX_LIGHT_LEVEL } from '../blocks/BlockConstants';
import { textureUriToTextureUris } from '../blocks/utils';
import Chunk from '../chunks/Chunk';
import Game from '../Game';
import EmissiveMeshBasicMaterial from '../gltf/EmissiveMeshBasicMaterial';
import Assets from '../network/Assets';
import { CustomTextureWrapper } from '../textures/CustomTextureManager';
import { lerp, slerp, updateAABB, Vector3LikeMutable } from '../three/utils';
import type { DeserializedModelAnimation, DeserializedModelAnimations, DeserializedModelNodeOverride, DeserializedModelNodeOverrides } from '../network/Deserializer';
import type { ChunkWorkerBlockEntityBuildMessage } from '../workers/ChunkWorkerConstants';

const DEFAULT_ANIMATION_BLEND_TIME_S = 0.1;
const DEFAULT_OPACITY = 1.0;
const SKY_LIGHT_INTERPOLATION_TIME_S = 0.1;
const TRANSFORM_INTERPOLATION_TIME_S = 0.04;
const LOOP_MODE_ONCE = 0;
const LOOP_MODE_LOOP = 1;
const LOOP_MODE_PING_PONG = 2;
const BLEND_MODE_ADDITIVE = 0;

const MAX_UPDATE_SKIP_FRAMES = 4;
const NEAR_DISTANCE_SQUARED = 16 * 16; // 1 Chunk = 16 Blocks

// Working variables
const vec2 = new Vector2();
const corners: Vector3[] = new Array(8).fill(undefined).map(() => new Vector3());
const color = new Color();
const quaternion = new Quaternion();
const positionOffset = new Vector3();
const box3 = new Box3();
const rotationCenterOffset = new Vector3();
const rotatedCenterOffset = new Vector3();
const worldCenter = new Vector3();
const localCenter = new Vector3();
const nextQuaternion = new Quaternion();

// Hack to access a non-public Three.js properties without TypeScript errors.
// TODO: Since the properties are not officially exposed, they could be renamed or made
// inaccessible at any time. We should implement an equivalent mechanism using only
// officially supported APIs to maintain long-term maintainability.
interface AnimationActionEx extends AnimationAction {
  _propertyBindings: PropertyMixer[];
}

interface AnimationMixerEx extends AnimationMixer {
  _actions: AnimationActionEx[];
}

type OriginalMaterialData = {
  alphaTest: number;
  color: Color;
  emissive: Color;
  emissiveIntensity: number;
  opacity: number;
  transparent: boolean;
};

type ModelNodeTransformData = {
  position: Vector3;
  quaternion: Quaternion;
  scale: Vector3;
  rotationCenter?: Vector3;
};

type InterpolatedModelNodeVectorTransformData = {
  current: Vector3;
  interpolationTimeS: number;
  interpolating: boolean;
  target: Vector3;
  targetActive: boolean;
};

type InterpolatedModelNodeQuaternionTransformData = {
  current: Quaternion;
  interpolationTimeS: number;
  interpolating: boolean;
  target: Quaternion;
  targetActive: boolean;
};

type ModelNodeTransformInterpolationData = {
  localPosition?: InterpolatedModelNodeVectorTransformData;
  localRotation?: InterpolatedModelNodeQuaternionTransformData;
  localScale?: InterpolatedModelNodeVectorTransformData;
};

const ORIGINAL_MATERIAL_DATA = 'originalData';

// Store information useful for processing in Object3D.userData.
// TODO: This is not a particularly good design, and it is difficult to leverage
// type checking, so it may be better to consider a more appropriate approach.

// Sometimes we want to find an Entity from an Object3D associated
// with it, so the entityID is stored in Object3D.userData.
const USER_DATA_ENTITY_ID = 'entityId';

// In the Three.js SceneGraph, setting Object3D.visible = false propagates
// to child nodes. To quickly determine the effective visibility of a given
// Object3D, taking parent visibility into account, this information is stored
// in userData.
// Note: This does not take the parent Entity into account, and it also
// does not take the visibility setting of the Entity as a whole into
// account.
const USER_DATA_EFFECTIVELY_VISIBLE = 'effectivelyVisible';

export const UNIFORM_LIGHT_LEVEL = 'lightLevel';
export const UNIFORM_SKY_LIGHT = 'skyLight';
export const UNIFORM_RAW_AMBIENT_LIGHT_COLOR = 'rawAmbientLightColor';
export const UNIFORM_AMBIENT_LIGHT_INTENSITY = 'ambientLightIntensity';

export type LightLevelUniformData = {
  [UNIFORM_LIGHT_LEVEL]: { value: number };
  [UNIFORM_SKY_LIGHT]: { value: number };
  [UNIFORM_RAW_AMBIENT_LIGHT_COLOR]: { value: Color };
  [UNIFORM_AMBIENT_LIGHT_INTENSITY]: { value: number };
};

export interface EntityData {
  id: EntityId;
  blockTextureUri?: string;
  blockHalfExtents?: Vector3Like;
  emissiveColor?: Color | null;
  emissiveIntensity?: number | null;
  isEnvironmental?: boolean;
  modelAnimations?: DeserializedModelAnimations;
  modelNodeOverrides?: DeserializedModelNodeOverrides;
  modelTextureUri?: string;
  modelUri?: string;
  name: string;
  opacity?: number;
  parentEntityId?: number | null;
  parentNodeName?: string | null;
  position: Vector3;
  positionInterpolationMs?: number | null;
  rotation: Quaternion;
  rotationInterpolationMs?: number | null;
  scale?: Vector3Like;
  scaleInterpolationMs?: number | null;
  tintColor?: Color | null;
}

export default class Entity {
  protected _game: Game;
  private _id: EntityId;
  private _animationTargets: Set<Object3D> = new Set();
  private _animationFadeTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private _attached: boolean = false;
  private _blockHalfExtents: Vector3Like | undefined;
  private _blockTextureRequestVersion: number = 0;
  private _blockTextureUri: string | undefined;
  private _currentPosition: Vector3;
  private _currentRotation: Quaternion;
  private _customTexture: CustomTextureWrapper | null = null;
  private _customTextureUri: string | null = null;
  // _entityRoot controls the position, quaternion, and scale of the entire model.
  private _entityRoot: Group = new Group();
  private _emissiveColor: Color | null = null;
  private _emissiveColorsByNode: Map<string, Color> = new Map();
  private _emissiveIntensity: number | null = null;
  private _emissiveIntensitiesByNode: Map<string, number> = new Map();
  // For a glTF Entity, when _glTF is non-null, _glTFAnimationMixer and _model
  // are also expected to be non-null, and _model is expected to reference _glTF.scene.
  private _gltfAnimationMixer: AnimationMixerEx | null = null;
  private _gltf: GLTF | null = null;
  private _interpolatingPosition: boolean = false;
  private _interpolatingRotation: boolean = false;
  private _interpolatingScale: boolean = false;
  private _positionInterpolationTimeS: number = TRANSFORM_INTERPOLATION_TIME_S;
  private _rotationInterpolationTimeS: number = TRANSFORM_INTERPOLATION_TIME_S;
  private _scaleInterpolationTimeS: number = TRANSFORM_INTERPOLATION_TIME_S;
  private _interpolatingSkyLight: boolean = false;
  private _isEnvironmental: boolean = false;
  // Entity position and rotation updates are often sent over the unrelaible/unordered 
  // data channel, so we need to track the server tick of the last applied position
  // and rotation updates in order to determine if a received update is newer and 
  // should be applied.
  private _lastPositionUpdateServerTick: number = 0;
  private _lastRotationUpdateServerTick: number = 0;
  // Represents either a glTF model or a Block model. This model is expected to exist
  // directly under _entityRoot. The root object within the model is assumed to be
  // an inserted Group object, which is used to adjust the offset so that the center
  // of the model's Mesh aligns with the position indicated by `entityRoot`.
  private _model: Group | null = null;
  private _additiveModelAnimationClips: Map<string, AnimationClip> = new Map();
  private _modelAnimations: Map<string, DeserializedModelAnimation> = new Map();
  private _modelHiddenNodesByCamera: string[];

  // Model node overrides are stored by name, and are used to override various
  // properties and behaviors of a node of the model used for this entity, such as
  // emissive color and intensity.
  private _modelNodeOverrides: Map<string, DeserializedModelNodeOverride> = new Map();
  private _modelNodeOverrideTransformInterpolations: WeakMap<DeserializedModelNodeOverride, ModelNodeTransformInterpolationData> = new WeakMap();
  private _modelNodeOverrideBaseTransforms: WeakMap<Object3D, ModelNodeTransformData> = new WeakMap();
  private _modelNodeTransformOverrideTargets: Set<Object3D> = new Set();
  private _modelShownNodesByCamera: string[];
  // A set of callback functions called when `_model` is ready.
  // When attached as a parent entity, child entities set callback functions.
  // If the size is greater than 0, it indicates that this Entity is an attachment target.
  private _modelReadyListeners: {
    withNodeName: Set<((parentEntity: Entity) => void)>,
    withoutNodeName: Set<((parentEntity: Entity) => void)>,
  } = { withNodeName: new Set(), withoutNodeName: new Set() };
  private _modelUri: string | undefined;
  private _name: string;
  private _needsLightLevelUpdate: boolean = true;
  private _needsSkyLightUpdate: boolean = true;
  protected _lightLevel: number = 0;
  protected _skyLight: number = 1.0;
  protected _targetSkyLight: number = 1.0;
  private _lightLevelUniformData: LightLevelUniformData;
  // Variables used to track whether a matrix update is needed, for optimization purposes.
  // This ensures matrices are updated only when necessary.
  private _needsMatrixUpdate: Set<Object3D> = new Set();
  private _needsMatrixWorldUpdate: boolean = false;
  private _needsWorldBoundingBoxUpdate: boolean = false;
  private _opacity: number;
  private _pendingAnimationTimeS: number = 0;
  private _parentEntityId: number | null | undefined;
  private _parentNodeName: string | null | undefined;
  private _pendingCustomTextures: Set<Promise<CustomTextureWrapper>> = new Set();
  private _pendingEffectiveUris: Set<Promise<string>> = new Set();
  private _pendingGltfs: Set<Promise<GLTF>> = new Set();
  private _scale: Vector3;
  private _shouldSuppressAnimations: boolean = false;
  private _targetPosition: Vector3;
  private _targetRotation: Quaternion;
  private _targetScale: Vector3;
  private _tintColor: Color | null;
  private _clientColorCorrection: Color | null = null;
  private _localBoundingBox: Box3 | null = null;
  private _worldBoundingBox: Box3 | null = null;
  protected _globalCoordinate: Vector3LikeMutable;
  private _distanceToCameraSquared: number = 0;
  private _forceAnimationAndLocalMatrixUpdate: boolean = false;

  public constructor(game: Game, data: EntityData, shouldSuppressAnimations: boolean = false) {
    if (!data.modelUri && !data.blockTextureUri) {
      throw new Error('Entity.constructor(): Entity must have a model or block texture uri.');
    }

    this._game = game;
    this._id = data.id;
    this._blockTextureUri = data.blockTextureUri ? Assets.toAssetUri(data.blockTextureUri) : undefined;
    this._blockHalfExtents = data.blockHalfExtents;
    this._currentPosition = data.position.clone();
    this._currentRotation = data.rotation.clone();
    this._isEnvironmental = data.isEnvironmental ?? false;
    this._name = data.name;
    this._opacity = data.opacity ?? DEFAULT_OPACITY;
    this._parentEntityId = data.parentEntityId;
    this._parentNodeName = data.parentNodeName;
    this._targetPosition = data.position.clone();
    this._targetRotation = data.rotation.clone();
    this._targetScale = data.scale ? new Vector3().copy(data.scale) : new Vector3(1, 1, 1);
    this._positionInterpolationTimeS = this._resolveInterpolationTimeS(data.positionInterpolationMs);
    this._rotationInterpolationTimeS = this._resolveInterpolationTimeS(data.rotationInterpolationMs);
    this._scaleInterpolationTimeS = this._resolveInterpolationTimeS(data.scaleInterpolationMs);
    this._tintColor = data.tintColor?.clone() || null;

    this._emissiveColor = data.emissiveColor?.clone() ?? null;
    this._emissiveIntensity = data.emissiveIntensity ?? null;

    this._scale = data.scale ? new Vector3().copy(data.scale) : new Vector3(1, 1, 1);
    (data.modelAnimations ?? []).forEach(modelAnimation => {
      this._modelAnimations.set(modelAnimation.name, { ...modelAnimation });
    });
    this._modelHiddenNodesByCamera = [];
    this._modelShownNodesByCamera = [];
    this._modelUri = data.modelUri ? Assets.toAssetUri(data.modelUri) : undefined;

    if (data.modelNodeOverrides && this._isGLTFEntity) {
      this._mergeModelNodeOverridesPatch(data.modelNodeOverrides, false);
    }
    this._lightLevelUniformData = this._createSharedUniformData();

    this._entityRoot.userData[USER_DATA_ENTITY_ID] = this._id;
    this._entityRoot.userData[USER_DATA_EFFECTIVELY_VISIBLE] = true;

    // Local matrix is manually updated only when needed, so its auto-update flag is disabled.
    // World matrix is updated via Object3D.updateMatrixWorld(), so its auto-update flag is left
    // enabled. Unnecessary world matrix updates are skipped within .updateMatrixWorld() by
    // checking the .matrixWorldNeedsUpdate flag. The same applies to child elements as well.
    this._entityRoot.position.copy(this._currentPosition);
    this._entityRoot.quaternion.copy(this._currentRotation);
    this._entityRoot.scale.copy(this._scale);
    this._entityRoot.matrixAutoUpdate = false;
    this._needsMatrixUpdate.add(this._entityRoot);

    // Perform frustum culling manually instead of relying on WebGLRenderer's
    // automatic frustum culling.
    this._entityRoot.frustumCulled = false;

    this._globalCoordinate = Chunk.worldPositionToGlobalCoordinate(this._entityRoot.position);

    // The geometry for Block Entities is generated in the WebWorker.
    // Requests to the WebWorker are made by the EntityManager.
    if (this._isGLTFEntity) {
      this._shouldSuppressAnimations = shouldSuppressAnimations;
      this._buildGLTFModel();

      if (data.modelTextureUri) {
        this.setCustomTexture(data.modelTextureUri);
      }
    }
  }

  public get id(): EntityId {
    return this._id;
  }

  public get attached(): boolean {
    return this._attached;
  }

  public get blockTextureUri(): string | undefined {
    return this._blockTextureUri;
  }

  public get blockTextureRequestVersion(): number {
    return this._blockTextureRequestVersion;
  }
  
  public get blockHalfExtents(): Vector3Like | undefined {
    return this._blockHalfExtents;
  }

  public get blockDimensions(): Vector3Like | undefined {
    if (!this._blockHalfExtents) {
      return undefined;
    }
    return {
      x: Math.ceil(this._blockHalfExtents.x * 2),
      y: Math.ceil(this._blockHalfExtents.y * 2),
      z: Math.ceil(this._blockHalfExtents.z * 2),
    };
  }

  public get entityRoot(): Group {
    return this._entityRoot;
  }

  public get isEnvironmental(): boolean {
    return this._isEnvironmental;
  }

  public get model(): Group | null {
    return this._model;
  }
  
  public get modelUri(): string | undefined {
    return this._modelUri;
  }
  
  public get name(): string {
    return this._name;
  }
  
  public get opacity(): number {
    return this._opacity;
  }

  public get emissiveColor(): Color | null {
    return this._emissiveColor;
  }

  public get emissiveIntensity(): number | null {
    return this._emissiveIntensity;
  }

  public get parent(): Entity | undefined {
    return this._parentEntityId ? this._game.entityManager.getEntity(this._parentEntityId) : undefined;
  }
  
  public get parentEntityId(): number | null | undefined {
    return this._parentEntityId;
  }
  
  public get parentNodeName(): string | null | undefined {
    return this._parentNodeName;
  }
  
  public get position(): Vector3 {
    return this._currentPosition;
  }
  
  public get rotation(): Quaternion {
    return this._currentRotation;
  }
  
  public get scale(): Vector3 {
    return this._scale;
  }
  
  public get tintColor(): Color | null {
    return this._tintColor;
  }

  private _getEffectiveLightLevel(): number {
    return this._attached && this.parent ? this.parent._getEffectiveLightLevel() : this._lightLevel;
  }

  private _getEffectiveSkyLight(): number {
    return this._attached && this.parent ? this.parent._getEffectiveSkyLight() : this._skyLight;
  }
  
  public get game(): Game {
    return this._game;
  }

  // Note: When it is invisible, the animation may be stopped. There might be cases
  // where we need to update the animation to the latest state in order to get the world position.
  public getWorldPosition(target: Vector3): Vector3 {
    if (!this.attached) {
      return target.copy(this._currentPosition);
    }

    // Note: Callers should be aware that retrieving a child entity’s world matrix triggers an
    // update to bring it up to date, and that update can be costly.
    this._ensureMatrixWorldUpdated(this._entityRoot);
    return target.setFromMatrixPosition(this._entityRoot.matrixWorld);
  }

  // TODO: Optimize if possible
  private _ensureMatrixWorldUpdated(obj: Object3D): void {
    // Update because the LocalMatrix may not be up to date.
    // TODO: Skip when unnecessary
    obj.updateMatrix();
    EntityStats.localMatrixUpdateCount++;

    const parent = obj.parent;
    if (parent !== null) {
      this._ensureMatrixWorldUpdated(parent);
      obj.matrixWorld.multiplyMatrices(parent.matrixWorld, obj.matrix);
    } else {
      obj.matrixWorld.copy(obj.matrix);
    }

    EntityStats.worldMatrixUpdateCount++;
  }

  public get visible(): boolean {
    return this._entityRoot.visible;
  }

  // This is currently intended to be used only for view distance and frustum culling processing.
  // If it's used for other purposes in the future, care must be taken to avoid conflicts when setting visibility.
  public set visible(visible: boolean) {
    if (visible && this._entityRoot.parent === null) {
      if (this._attached) {
        console.warn(`Entity set visible: Client implementation error. Under the current client design, a child entity’s visible value should not change after the child entity’s model has been attached.`);
        return;
      }
      this._game.renderer.addToScene(this._entityRoot);
    } else if (!visible && this._entityRoot.parent !== null) {
      if (this._attached) {
        console.warn(`Entity set visible: Client implementation error. Under the current client design, a child entity’s visible value should not change after the child entity’s model has been attached.`);
        return;
      }
      this._entityRoot.removeFromParent();
    }

    this._entityRoot.visible = visible;
  }

  private get isAttachmentTarget(): boolean {
    for (const key in this._modelReadyListeners) {
      if (this._modelReadyListeners[key as keyof typeof this._modelReadyListeners].size > 0) {
        return true;
      }
    }
    return false;
  }

  // TODO: Currently, animation data is re-collected every time the animation state updates.
  // This is likely inefficient when dealing with a large number of animations. It would be
  // more efficient to track only to diffs.
  private _collectAnimationTargets(mixer: AnimationMixerEx): void {
    this._animationTargets.clear();

    mixer._actions.forEach(action => {
      if (action.paused || !action.enabled) {
        return;
      }
      action._propertyBindings.forEach(propertyMixer => {
        const targetObject = propertyMixer.binding.targetObject;
        const property = propertyMixer.binding.resolvedProperty;

        // Only core glTF animations are considered here, where rotation is handled using quaternions,
        // not Euler rotation.
        if (targetObject && property && (targetObject.position === property || targetObject.quaternion === property || targetObject.scale === property)) {
          // Records an Object3D because its matrix update is required when an animation is played.
          this._animationTargets.add(targetObject);
        }
      });
    });
  }

  private get _isGLTFEntity(): boolean {
    return !!this._modelUri;
  }

  public get isBlockEntity(): boolean {
    return !!this._blockTextureUri;
  }

  private _needsNoAnimationsGLTF(): boolean {
    if (this._shouldSuppressAnimations) {
      return true;
    }

    // For now, we only consider use no-animations gltf
    // model for environmental entities to prevent risk of
    // poor performance from models that may frequently switch
    // models types due to animation start/stop, etc.
    // no-animations model is a generated model by gltf-transform
    // that gives us a single mesh model to only require 1 draw call.
    // Note:
    // Do not include animation target checks here. If the no-animation optimized
    // model is currently in use, animation targets are forced to be nonexistent,
    // so they cannot be used to determine whether the no-animation optimized model
    // is needed.
    return this._isEnvironmental &&
      !this._hasActiveModelAnimations();
  }

  private _hasActiveModelAnimations(): boolean {
    for (const modelAnimation of this._modelAnimations.values()) {
      // `pause` is intentionally included: a paused animation still holds the model
      // in a non-default pose (Three.js action.paused keeps property bindings active).
      // Switching to the no-animations optimized model while paused would snap the
      // model to its rest pose and lose the paused animation time position, since
      // the no-animations model has no clips to preserve action state.
      // Only `stop` (which calls action.stop().reset()) means the animation no longer
      // influences the model.
      if (modelAnimation.play || modelAnimation.pause || modelAnimation.restart) {
        return true;
      }
    }

    return false;
  }

  private _needsNamedNodesGLTF(): boolean {
    return this._modelReadyListeners.withNodeName.size > 0 ||
           this._modelHiddenNodesByCamera.length > 0 ||
           this._modelShownNodesByCamera.length > 0 ||
           this._modelNodeOverrides.size > 0 ||
           this._emissiveColorsByNode.size > 0 || this._emissiveIntensitiesByNode.size > 0;
  }

  // Whether a glTF model is optimized has a major impact on client performance.
  // Therefore, Hytopia automatically optimizes glTF models at game startup. Since
  // the required optimization level differs by condition, multiple optimized
  // glTF models are created. The client selects the appropriate optimized model
  // based on those conditions. This method checks whether the optimized model to
  // select changes before and after a given process. Concretely, it checks
  // whether node names are needed and whether animations are needed.
  private _needsGLTFRefresh(func: () => void): boolean {
    const currentNeedsNamedNodesGLTF = this._needsNamedNodesGLTF();
    const currentNeedsNoAnimationsGLTF = this._needsNoAnimationsGLTF();
    func();
    const newNeedsNamedNodesGLTF = this._needsNamedNodesGLTF();
    const newNeedsNoAnimationsGLTF = this._needsNoAnimationsGLTF();

    // If the glTF model is not needed, there is no need to switch.
    if (!this._isGLTFEntity) {
      return false;
    }

    // It remains necessary to use a glTF model that preserves named nodes.
    if (currentNeedsNamedNodesGLTF && newNeedsNamedNodesGLTF) {
      return false;
    }

    // A switch is needed between the model that preserves named nodes and the one
    // that does not.
    if (currentNeedsNamedNodesGLTF !== newNeedsNamedNodesGLTF) {
      return true;
    }

    // At this point, preserving named nodes is unnecessary both before and after
    // the process. Check whether we need to switch between the model with
    // animations removed and the one that still has them.
    return currentNeedsNoAnimationsGLTF !== newNeedsNoAnimationsGLTF;
  }

  public setModelAnimations(modelAnimations: DeserializedModelAnimations): void {
    if (!this._isGLTFEntity) {
      return console.warn('Entity.setModelAnimations(): Entity must be a glTF Entity.');
    }

    const needsGLTFRefresh = this._needsGLTFRefresh(() => {
      for (const modelAnimation of modelAnimations) {
        let target = this._modelAnimations.get(modelAnimation.name);
        if (!target) {
          target = { ...modelAnimation };
          this._modelAnimations.set(modelAnimation.name, target);
        }
        this._mergeModelAnimation(target, modelAnimation);
      }
    });

    if (needsGLTFRefresh) {
      this._buildGLTFModel();
      return;
    }

    if (this._shouldSuppressAnimations) {
      return;
    }

    if (this._model && this._gltfAnimationMixer) {
      this._applyModelAnimations(this._model, this._gltfAnimationMixer, modelAnimations);
    }
  }

  private _mergeModelAnimation(target: DeserializedModelAnimation, source: DeserializedModelAnimation): void {
    if (source.blendMode !== undefined) target.blendMode = source.blendMode;
    if (source.clampWhenFinished !== undefined) target.clampWhenFinished = source.clampWhenFinished;
    if (source.fadesIn !== undefined) target.fadesIn = source.fadesIn;
    if (source.fadesOut !== undefined) target.fadesOut = source.fadesOut;
    if (source.loopMode !== undefined) target.loopMode = source.loopMode;
    if (source.playbackRate !== undefined) target.playbackRate = source.playbackRate;
    if (source.weight !== undefined) target.weight = source.weight;

    // Keep persistent state/settings unless explicitly changed by future packets.
    if (source.restart === true) {
      target.play = true;
      target.pause = false;
      target.restart = true;
      target.stop = false;
      return;
    }

    if (source.play === true) {
      target.play = true;
      target.pause = false;
      target.restart = false;
      target.stop = false;
      return;
    }

    if (source.pause === true) {
      target.play = false;
      target.pause = true;
      target.restart = false;
      target.stop = false;
      return;
    }

    if (source.stop === true) {
      target.play = false;
      target.pause = false;
      target.restart = false;
      target.stop = true;
      return;
    }
  }

  private _setAnimationActionLoopMode(action: AnimationAction, loopMode: number): void {
    if (loopMode === LOOP_MODE_LOOP) {
      action.setLoop(LoopRepeat, Infinity);
    } else if (loopMode === LOOP_MODE_PING_PONG) {
      action.setLoop(LoopPingPong, Infinity);
    } else {
      action.setLoop(LoopOnce, 1);
    }
  }

  private _applyModelAnimations(model: Object3D, mixer: AnimationMixerEx, modelAnimations: Iterable<DeserializedModelAnimation>): void {
    for (const sourceAnimation of modelAnimations) {
      const modelAnimation = this._modelAnimations.get(sourceAnimation.name) ?? sourceAnimation;
      const clip = this._getModelAnimationClip(model, modelAnimation);

      if (!clip) {
        continue;
      }

      const action = mixer.clipAction(clip);
      const effectiveLoopMode = modelAnimation.loopMode ?? LOOP_MODE_ONCE;

      if (modelAnimation.blendMode !== undefined) {
        action.blendMode = modelAnimation.blendMode === BLEND_MODE_ADDITIVE ? AdditiveAnimationBlendMode : NormalAnimationBlendMode;
      }

      if (modelAnimation.clampWhenFinished !== undefined) {
        action.clampWhenFinished = modelAnimation.clampWhenFinished;
      }

      if (modelAnimation.loopMode !== undefined) {
        this._setAnimationActionLoopMode(action, effectiveLoopMode);
      }

      if (modelAnimation.playbackRate !== undefined) {
        action.setEffectiveTimeScale(modelAnimation.playbackRate);
      }

      if (modelAnimation.weight !== undefined) {
        action.setEffectiveWeight(modelAnimation.weight);
      }

      if (modelAnimation.stop) {
        this._clearAnimationFadeTimeout(modelAnimation.name);
        if (modelAnimation.fadesOut ?? true) {
          action.fadeOut(DEFAULT_ANIMATION_BLEND_TIME_S);
          this._animationFadeTimeouts.set(modelAnimation.name, setTimeout(() => {
            if (this._model) {
              action.stop().reset();
            }
          }, DEFAULT_ANIMATION_BLEND_TIME_S * 1000));
        } else {
          action.stop().reset();
        }
        modelAnimation.stop = false;
        modelAnimation.play = false;
        modelAnimation.pause = false;
        modelAnimation.restart = false;
        continue;
      }

      if (modelAnimation.restart) {
        this._clearAnimationFadeTimeout(modelAnimation.name);
        this._setAnimationActionLoopMode(action, effectiveLoopMode);
        action.enabled = true;
        action.paused = false;
        if (modelAnimation.fadesIn ?? true) {
          action.reset().fadeIn(DEFAULT_ANIMATION_BLEND_TIME_S).play();
        } else {
          action.reset().play();
        }
        modelAnimation.restart = false;
        modelAnimation.play = true;
        modelAnimation.pause = false;
        modelAnimation.stop = false;
        continue;
      }

      if (modelAnimation.pause) {
        action.paused = true;
        continue;
      }

      if (modelAnimation.play) {
        this._clearAnimationFadeTimeout(modelAnimation.name);
        this._setAnimationActionLoopMode(action, effectiveLoopMode);
        action.enabled = true;
        action.paused = false;

        // Reset finished animations so .play() restarts them, matching standard
        // game engine behavior where playing a completed animation replays it.
        if (action.time >= action.getClip().duration) {
          action.reset();
        }

        if (modelAnimation.fadesIn ?? true) {
          action.fadeIn(DEFAULT_ANIMATION_BLEND_TIME_S).play();
        } else {
          action.play();
        }
      }
    }

    this._collectAnimationTargets(mixer);
  }

  private _getModelAnimationClip(model: Object3D, modelAnimation: DeserializedModelAnimation): AnimationClip | undefined {
    const clip = model.animations.find(animation => animation.name === modelAnimation.name);

    if (!clip) {
      return undefined;
    }

    if (modelAnimation.blendMode !== BLEND_MODE_ADDITIVE) {
      return clip;
    }

    let additiveClip = this._additiveModelAnimationClips.get(clip.name);

    if (!additiveClip) {
      additiveClip = clip.clone();
      AnimationUtils.makeClipAdditive(additiveClip);
      this._additiveModelAnimationClips.set(clip.name, additiveClip);
    }

    return additiveClip;
  }

  public setModelHiddenNodes(hiddenNodes: string[]): void {
    const needsGLTFRefresh = this._needsGLTFRefresh(() => {
      this._modelHiddenNodesByCamera.length = 0;
      hiddenNodes.forEach(hiddenNode => this._modelHiddenNodesByCamera.push(hiddenNode));
    });

    if (this._model) {
      this._updateModelNodesVisibility(this._model);
    }

    if (needsGLTFRefresh) {
      this._buildGLTFModel();
    }
  }

  public setModelNodeOverrides(modelNodeOverrides: DeserializedModelNodeOverrides): void {
    if (!this._isGLTFEntity) {
      return console.warn('Entity.setModelNodeOverrides(): Entity must be a glTF Entity.');
    }

    const needsGLTFRefresh = this._needsGLTFRefresh(() => {
      this._mergeModelNodeOverridesPatch(modelNodeOverrides);
    });

    if (needsGLTFRefresh) {
      this._buildGLTFModel();
      return;
    }

    if (this._model) {
      this._refreshModelNodeTransformOverrideTargets(this._model);
      this._applyModelNodeTransformOverrides();
      this._updateModelNodesVisibility(this._model);
      if (this._isGLTFEntity) {
        this._applyEmissive(this._model);
      }
      this._forceAnimationAndLocalMatrixUpdate = true;
    }
  }

  private _mergeModelNodeOverridesPatch(modelNodeOverrides: DeserializedModelNodeOverrides, interpolateTransforms: boolean = true): void {
    for (const modelNodeOverride of modelNodeOverrides) {
      const name = modelNodeOverride.name.toLowerCase();

      if (modelNodeOverride.removed) {
        const existing = this._modelNodeOverrides.get(name);
        if (existing) {
          this._modelNodeOverrideTransformInterpolations.delete(existing);
        }
        this._modelNodeOverrides.delete(name);
        continue;
      }

      let existing = this._modelNodeOverrides.get(name);

      if (!existing) {
        existing = { name };
        this._modelNodeOverrides.set(name, existing);
      }

      this._mergeModelNodeOverride(existing, modelNodeOverride, interpolateTransforms);
    }
  }

  private _getOrCreateModelNodeTransformInterpolation(modelNodeOverride: DeserializedModelNodeOverride): ModelNodeTransformInterpolationData {
    let interpolationData = this._modelNodeOverrideTransformInterpolations.get(modelNodeOverride);

    if (!interpolationData) {
      interpolationData = {};
      this._modelNodeOverrideTransformInterpolations.set(modelNodeOverride, interpolationData);
    }

    return interpolationData;
  }

  private _resolveInterpolationTimeS(interpolationMs?: number | null): number {
    if (interpolationMs === undefined || interpolationMs === null) {
      return TRANSFORM_INTERPOLATION_TIME_S;
    }

    return Math.max(interpolationMs, 0) / 1000;
  }

  private _calculateInterpolationFactor(deltaTimeS: number, interpolationTimeS: number): number {
    if (interpolationTimeS <= 0) {
      return 1;
    }

    return Math.min(deltaTimeS / interpolationTimeS, 1.0);
  }

  private _setInterpolatedModelNodeVectorTransformTarget(
    transformData: InterpolatedModelNodeVectorTransformData,
    target: Vector3Like | null,
    interpolate: boolean,
    interpolationMs: number | null | undefined,
    defaultX: number,
    defaultY: number,
    defaultZ: number,
  ): void {
    transformData.targetActive = target !== null;
    transformData.interpolationTimeS = this._resolveInterpolationTimeS(interpolationMs);

    if (target) {
      transformData.target.set(target.x, target.y, target.z);
    } else {
      transformData.target.set(defaultX, defaultY, defaultZ);
    }

    if (!interpolate || transformData.interpolationTimeS <= 0) {
      transformData.current.copy(transformData.target);
      transformData.interpolating = false;
      return;
    }

    transformData.interpolating = !transformData.current.equals(transformData.target);
  }

  private _setInterpolatedModelNodeQuaternionTransformTarget(
    transformData: InterpolatedModelNodeQuaternionTransformData,
    target: QuaternionLike | null,
    interpolate: boolean,
    interpolationMs: number | null | undefined,
  ): void {
    transformData.targetActive = target !== null;
    transformData.interpolationTimeS = this._resolveInterpolationTimeS(interpolationMs);

    if (target) {
      transformData.target.set(target.x, target.y, target.z, target.w).normalize();
    } else {
      transformData.target.identity();
    }

    if (!interpolate || transformData.interpolationTimeS <= 0) {
      transformData.current.copy(transformData.target);
      transformData.interpolating = false;
      return;
    }

    transformData.interpolating = !transformData.current.equals(transformData.target);
  }

  private _hasActiveModelNodeTransformInterpolation(interpolationData: ModelNodeTransformInterpolationData | undefined): boolean {
    if (!interpolationData) {
      return false;
    }

    const localPosition = interpolationData.localPosition;
    if (localPosition && (localPosition.targetActive || localPosition.interpolating)) {
      return true;
    }

    const localRotation = interpolationData.localRotation;
    if (localRotation && (localRotation.targetActive || localRotation.interpolating)) {
      return true;
    }

    const localScale = interpolationData.localScale;
    if (localScale && (localScale.targetActive || localScale.interpolating)) {
      return true;
    }

    return false;
  }

  private _interpolateModelNodeTransformOverrides(deltaTimeS: number): void {
    if (this._modelNodeOverrides.size === 0 || this._modelNodeTransformOverrideTargets.size === 0) {
      return;
    }

    for (const modelNodeOverride of this._modelNodeOverrides.values()) {
      const interpolationData = this._modelNodeOverrideTransformInterpolations.get(modelNodeOverride);
      if (!interpolationData) {
        continue;
      }

      const localPosition = interpolationData.localPosition;
      if (localPosition?.interpolating) {
        const localPositionT = this._calculateInterpolationFactor(deltaTimeS, localPosition.interpolationTimeS);
        if (lerp(localPosition.current, localPosition.target, localPositionT)) {
          localPosition.interpolating = false;
        }
      }

      const localRotation = interpolationData.localRotation;
      if (localRotation?.interpolating) {
        const localRotationT = this._calculateInterpolationFactor(deltaTimeS, localRotation.interpolationTimeS);
        if (slerp(localRotation.current, localRotation.target, localRotationT)) {
          localRotation.interpolating = false;
        }
      }

      const localScale = interpolationData.localScale;
      if (localScale?.interpolating) {
        const localScaleT = this._calculateInterpolationFactor(deltaTimeS, localScale.interpolationTimeS);
        if (lerp(localScale.current, localScale.target, localScaleT)) {
          localScale.interpolating = false;
        }
      }
    }
  }

  private _mergeModelNodeOverride(target: DeserializedModelNodeOverride, source: DeserializedModelNodeOverride, interpolateTransforms: boolean): void {
    if (source.emissiveColor !== undefined) {
      target.emissiveColor = source.emissiveColor ? source.emissiveColor.clone() : null;
    }

    if (source.emissiveIntensity !== undefined) {
      target.emissiveIntensity = source.emissiveIntensity;
    }

    if (source.hidden !== undefined) {
      target.hidden = source.hidden;
    }

    if (source.localPositionInterpolationMs !== undefined) {
      target.localPositionInterpolationMs = source.localPositionInterpolationMs;
    }

    if (source.localRotationInterpolationMs !== undefined) {
      target.localRotationInterpolationMs = source.localRotationInterpolationMs;
    }

    if (source.localScaleInterpolationMs !== undefined) {
      target.localScaleInterpolationMs = source.localScaleInterpolationMs;
    }

    if (source.localPosition !== undefined) {
      target.localPosition = source.localPosition ? { ...source.localPosition } : null;

      const interpolationData = this._getOrCreateModelNodeTransformInterpolation(target);
      interpolationData.localPosition ??= {
        current: new Vector3(0, 0, 0),
        interpolationTimeS: TRANSFORM_INTERPOLATION_TIME_S,
        interpolating: false,
        target: new Vector3(0, 0, 0),
        targetActive: false,
      };
      this._setInterpolatedModelNodeVectorTransformTarget(
        interpolationData.localPosition,
        target.localPosition,
        interpolateTransforms,
        target.localPositionInterpolationMs,
        0,
        0,
        0,
      );
    }

    if (source.localRotation !== undefined) {
      target.localRotation = source.localRotation ? { ...source.localRotation } : null;

      const interpolationData = this._getOrCreateModelNodeTransformInterpolation(target);
      interpolationData.localRotation ??= {
        current: new Quaternion(),
        interpolationTimeS: TRANSFORM_INTERPOLATION_TIME_S,
        interpolating: false,
        target: new Quaternion(),
        targetActive: false,
      };
      this._setInterpolatedModelNodeQuaternionTransformTarget(
        interpolationData.localRotation,
        target.localRotation,
        interpolateTransforms,
        target.localRotationInterpolationMs,
      );
    }

    if (source.localScale !== undefined) {
      target.localScale = source.localScale ? { ...source.localScale } : null;

      const interpolationData = this._getOrCreateModelNodeTransformInterpolation(target);
      interpolationData.localScale ??= {
        current: new Vector3(1, 1, 1),
        interpolationTimeS: TRANSFORM_INTERPOLATION_TIME_S,
        interpolating: false,
        target: new Vector3(1, 1, 1),
        targetActive: false,
      };
      this._setInterpolatedModelNodeVectorTransformTarget(
        interpolationData.localScale,
        target.localScale,
        interpolateTransforms,
        target.localScaleInterpolationMs,
        1,
        1,
        1,
      );
    }
  }

  public setModelShownNodes(shownNodes: string[]): void {
    const needsGLTFRefresh = this._needsGLTFRefresh(() => {
      this._modelShownNodesByCamera.length = 0;
      shownNodes.forEach(shownNode => this._modelShownNodesByCamera.push(shownNode));
    });

    if (this._model) {
      this._updateModelNodesVisibility(this._model);
    }

    if (needsGLTFRefresh) {
      this._buildGLTFModel();
    }
  }

  // Since this traverses the Model's Object3D, it is a somewhat heavy process.
  // It assumes this will not be called very frequently.
  private _updateModelNodesVisibility(model: Object3D): void {
    model.traverse(child => {
      if (child.userData[USER_DATA_ENTITY_ID] !== this._id) {
        return;
      }

      const name = child.name.toLowerCase();
      const isCameraHidden = this._modelHiddenNodesByCamera.some(node => name.includes(node));
      const isCameraShown = this._modelShownNodesByCamera.some(node => name.includes(node));
      const modelNodeOverride = this._getModelNodeOverride(name);
      const isModelNodeOverrideHidden = modelNodeOverride?.hidden === true;
      
      child.visible = isCameraShown || (!isCameraHidden && !isModelNodeOverrideHidden);
    });

    const traverse = (obj: Object3D, isParentEffectivelyVisible: boolean): void => {
      if (this._id !== obj.userData[USER_DATA_ENTITY_ID]) {
        // Do not update the Model information for child Entities.
        return;
      }
      const effectivelyVisible = isParentEffectivelyVisible && obj.visible;
      obj.userData[USER_DATA_EFFECTIVELY_VISIBLE] = effectivelyVisible;
      for (const child of obj.children) {
        traverse(child, effectivelyVisible);
      }
    };
    traverse(model, true);
  }

  // From a maintainability perspective, processing that depends on Object3D
  // userData should not be written in external classes.
  // To hide this dependency, static methods are used/exposed instead.
  private static _getAssociatedEntity(game: Game, obj: Object3D): Entity | null {
    const entityId = obj.userData[USER_DATA_ENTITY_ID];

    // userData makes it hard for type checking to work properly, so bugs
    // tend to slip in more easily.
    // We do not want a minor client-side implementation error to crash the
    // client, so for now we log a console.warn and fix the bug as soon as
    // possible. The same approach is used in other places as well.
    if (entityId === undefined) {
      console.warn(`Entity._getAssociatedEntity(): Client implementation error. entityId is not found in Object3D.userData ${obj.uuid}.`);
      return null;
    }

    const entity = game.entityManager.getEntity(entityId);

    if (!entity) {
      console.warn(`Entity._getAssociatedEntity(): Client implementation error. Entity ${entityId} is not found in EntityManager.`);
      return null;
    }

    return entity;
  }

  public static isNodeEffectivelyVisible(game: Game, obj: Object3D): boolean {
    const entity = Entity._getAssociatedEntity(game, obj);
    return entity !== null ? entity._isEffectivelyVisible(obj) : true;
  }

  public static getEffectiveLightLevel(game: Game, obj: Object3D): number {
    const entity = Entity._getAssociatedEntity(game, obj);
    return entity !== null ? entity._getEffectiveLightLevel() : 1.0;
  }

  public static getEffectiveSkyLight(game: Game, obj: Object3D): number {
    const entity = Entity._getAssociatedEntity(game, obj);
    return entity !== null ? entity._getEffectiveSkyLight() : 1.0;
  }

  private _isEffectivelyVisible(obj: Object3D): boolean {
    if (this.visible === false) {
      return false;
    }

    const effectivelyVisible = obj.userData[USER_DATA_EFFECTIVELY_VISIBLE];

    if (effectivelyVisible === undefined) {
      console.warn(`Entity._isEffectivelyVisible(): Client implementation error. effectivelyVisible is not found in Object3D.userData ${obj.uuid}.`);
      return obj.visible;
    }

    // Return early in cases where traversing parent nodes is not necessary as an optimization.
    if (effectivelyVisible === false || this._attached === false) {
      return effectivelyVisible;
    }

    const parentEntity = this.parent;

    if (parentEntity === undefined) {
      console.warn(`Entity._isEffectivelyVisible(): Client implementation error. Parent Entity ${this._parentEntityId} is not found for Entity ${this._id}.`);
      return obj.visible;
    }

    const parentNode = this._entityRoot.parent;

    if (parentNode === null) {
      console.warn(`Entity._isEffectivelyVisible(): Client implementation error. Entity ${this._id} is not attached to Parent Entity Model.`);
      return obj.visible;
    }

    return parentEntity._isEffectivelyVisible(parentNode);
  }

  public setModelUri(modelUri: string | undefined) {
    if (!this._isGLTFEntity) {
      throw new Error(`Entity.setModelUri(): Only the modelUri of a glTF Entity can be updated.`);
    }

    if (!modelUri) {
      throw new Error(`Entity.setModelUri(): modelUri must be specified.`);
    }

    const nextModelUri = Assets.toAssetUri(modelUri);

    if (this._modelUri === nextModelUri) {
      return;
    }

    this._clearOneShotAnimationStateForModelSwitch();
    this._modelUri = nextModelUri;
    this._buildGLTFModel();
  }

  private _clearOneShotAnimationStateForModelSwitch(): void {
    for (const modelAnimation of this._modelAnimations.values()) {
      if ((modelAnimation.loopMode ?? LOOP_MODE_ONCE) !== LOOP_MODE_ONCE) {
        continue;
      }

      this._clearAnimationFadeTimeout(modelAnimation.name);
      modelAnimation.play = false;
      modelAnimation.pause = false;
      modelAnimation.restart = false;
      modelAnimation.stop = false;
    }
  }

  public setName(name: string) {
    this._name = name;
  }

  public setOpacity(opacity: number) {
    this._opacity = opacity;

    if (this._model) {
      this._applyOpacity(this._model);
    }
  }

  private _applyOpacity(model: Object3D): void {
    model.traverse((child) => {
      if (child instanceof Mesh) {
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        materials.forEach(material => {
          const oldOpacity = material.opacity;

          // TODO: What should we do if a user wants to make a transparent material which originally
          // defined with opacity less than 1 fully opaque? Should we ask users to set a large opacity value
          // via the SDK API? Add a separate API to control the transparent flag directly?
          // Or ignore this use case entirely since it's likely rare?
          let opacityFactor = this.opacity;

          const originalData = this._getOriginalMaterialData(material);
          material.opacity = opacityFactor * originalData.opacity;

          // Specifying opacity to a value less than 1 likely means the user expects the object to become
          // transparent. Therefore, in that case, we force transparent = true.
          const oldTransparent = material.transparent;
          material.transparent = opacityFactor === DEFAULT_OPACITY ? originalData.transparent : true;
          if (oldTransparent !== material.transparent) {
            // Opaque and transparent materials use different WebGL programs, but due to what appears
            // to be a bug(?) in Three.js's WebGLRenderer, toggling the transparent property does not
            // automatically trigger a WebGL program switch internally. As a workaround, we must manually
            // set material.needsUpdate = true to force the switch.
            // TODO: Consider submitting a bug report to Three.js.
            material.needsUpdate = true;
          }

          // The user likely does not want to change which pixels pass or fail the alphaTest,
          // so we also apply a correction to the alphaTest threshold accordingly.
          //
          // In Three.js, pixels below the alpha test threshold when alphaTest is enabled (alphaTest > 0.0)
          // would behave differently from pixels rendered with alpha = 0 using blending and no alpha test.
          // The former are likely discarded and not written to the depth buffer, while the latter are
          // still written to the depth buffer. As a result, overlapping behavior may differ between
          // the two approaches.
          // If a material originally had alphaTest enabled and opacity is set to 0 here, the user
          // likely expects all pixels to behave as if they failed the alpha test. To achieve this,
          // we force alphaTest to a very small non-zero value, keeping alpha testing active.
          // However, since this is a hacky workaround, it should be reconsidered if issues arise.
          material.alphaTest = opacityFactor === 0.0 && originalData.alphaTest > 0 ? 0.0001 : opacityFactor * originalData.alphaTest;

          if (this._isGLTFEntity) {
            this._game.gltfManager.onMeshOpacityChanged(child, oldOpacity, material.opacity);
          }
        });
      }
    });
  }

  public setParentEntityId(parentEntityId: number | null | undefined) {
    if (this._parentEntityId === parentEntityId) {
      return;
    }
    this._detach();
    this._parentEntityId = parentEntityId;
    this.addToScene();
  }

  public setParentNodeName(parentNodeName: string | null) {
    if (this._parentNodeName === parentNodeName) {
      return;
    }
    this._detach();
    this._parentNodeName = parentNodeName;
    this.addToScene();
  }

  public setPosition(position: Vector3Like, interpolate: boolean = true, serverTick: number) {
    if (serverTick <= this._lastPositionUpdateServerTick) {
      return;
    }

    this._lastPositionUpdateServerTick = serverTick;

    this._targetPosition.copy(position);
    if (!interpolate || this._positionInterpolationTimeS <= 0) {
      this._currentPosition.copy(position);
      this._entityRoot.position.copy(this._currentPosition);
      this._needsMatrixUpdate.add(this._entityRoot);
      this._interpolatingPosition = false;
      this._needsWorldBoundingBoxUpdate = true;
      return;
    }

    this._interpolatingPosition = !this._currentPosition.equals(this._targetPosition);
  }

  public setPositionInterpolationMs(interpolationMs: number | null): void {
    this._positionInterpolationTimeS = this._resolveInterpolationTimeS(interpolationMs);
  }

  public setRotation(rotation: QuaternionLike, interpolate: boolean = true, serverTick: number) {
    if (serverTick <= this._lastRotationUpdateServerTick) {
      return;
    }

    this._lastRotationUpdateServerTick = serverTick;

    this._targetRotation.copy(rotation);
    if (!interpolate || this._rotationInterpolationTimeS <= 0) {
      this._currentRotation.copy(rotation);
      this._entityRoot.quaternion.copy(this._currentRotation);
      this._needsMatrixUpdate.add(this._entityRoot);
      this._interpolatingRotation = false;
      this._needsWorldBoundingBoxUpdate = true;
      return;
    }

    this._interpolatingRotation = !this._currentRotation.equals(this._targetRotation);
  }

  // Applies a client-side predicted transform without touching authoritative server tick tracking.
  public applyClientPredictedTransform(position: Vector3Like, rotation?: QuaternionLike): void {
    this._currentPosition.copy(position);
    this._targetPosition.copy(position);
    this._entityRoot.position.copy(this._currentPosition);
    this._interpolatingPosition = false;

    if (rotation) {
      this._currentRotation.copy(rotation);
      this._targetRotation.copy(rotation);
      this._entityRoot.quaternion.copy(this._currentRotation);
      this._interpolatingRotation = false;
    }

    this._needsMatrixUpdate.add(this._entityRoot);
    this._needsWorldBoundingBoxUpdate = true;
  }
  
  public setRotationInterpolationMs(interpolationMs: number | null): void {
    this._rotationInterpolationTimeS = this._resolveInterpolationTimeS(interpolationMs);
  }
  
  public setScale(scale: Vector3Like, interpolate: boolean = true) {
    this._targetScale.set(scale.x, scale.y, scale.z);
    if (!interpolate || this._scaleInterpolationTimeS <= 0) {
      this._scale.copy(this._targetScale);
      this._applyScale();
      this._interpolatingScale = false;
      this._needsWorldBoundingBoxUpdate = true;
      return;
    }

    this._interpolatingScale = !this._scale.equals(this._targetScale);
  }

  public setScaleInterpolationMs(interpolationMs: number | null): void {
    this._scaleInterpolationTimeS = this._resolveInterpolationTimeS(interpolationMs);
  }

  private _applyScale(): void {
    this._entityRoot.scale.copy(this._scale);
    this._needsMatrixUpdate.add(this._entityRoot);
  }

  public setTintColor(tintColor: Color | null | undefined) {
    if (tintColor) {
      if (this._tintColor === null) {
        this._tintColor = new Color();
      }
      this._tintColor.copy(tintColor);
    } else {
      this._tintColor = null;
    }

    if (this._model) {
      this._applyColorCorrections(this._model);
    }
  }

  public setEmissiveColor(emissiveColor: Color | null | undefined, nodeNames?: string[]): void {
    const needsGLTFRefresh = this._needsGLTFRefresh(() => {
      if (nodeNames === undefined) {
        // Entity-wide: set entity-wide color (per-node settings take priority when applied)
        if (emissiveColor) {
          if (this._emissiveColor === null) {
            this._emissiveColor = new Color();
          }
          this._emissiveColor.copy(emissiveColor);
        } else {
          this._emissiveColor = null;
        }
      } else {
        // Per-node: accumulate settings (entity-wide remains unchanged)
        for (let nodeName of nodeNames) {
          nodeName = nodeName.toLowerCase();
          if (emissiveColor) {
            if (!this._emissiveColorsByNode.has(nodeName)) {
              this._emissiveColorsByNode.set(nodeName, new Color());
            }
            this._emissiveColorsByNode.get(nodeName)!.copy(emissiveColor);
          } else {
            this._emissiveColorsByNode.delete(nodeName);
          }
        }
      }
    });

    if (needsGLTFRefresh) {
      this._buildGLTFModel();
    } else if (this._model) {
      this._applyEmissive(this._model);
    }
  }

  public setEmissiveIntensity(emissiveIntensity: number | null | undefined, nodeNames?: string[]): void {
    const needsGLTFRefresh = this._needsGLTFRefresh(() => {
      if (nodeNames === undefined) {
        // Entity-wide: set entity-wide intensity (per-node settings take priority when applied)
        this._emissiveIntensity = emissiveIntensity ?? null;
      } else {
        // Per-node: accumulate settings (entity-wide remains unchanged)
        for (let nodeName of nodeNames) {
          nodeName = nodeName.toLowerCase();
          if (emissiveIntensity !== undefined && emissiveIntensity !== null) {
            this._emissiveIntensitiesByNode.set(nodeName, emissiveIntensity);
          } else {
            this._emissiveIntensitiesByNode.delete(nodeName);
          }
        }
      }
    });

    if (needsGLTFRefresh) {
      this._buildGLTFModel();
    } else if (this._model) {
      this._applyEmissive(this._model);
    }
  }

  // Since distant entities draw less attention, reduce the frequency of
  // animation playback, local matrix updates, and the resulting world matrix
  // and related updates as optimization. This method controls that frequency.
  private _shouldUpdateAnimationAndLocalMatrix(frameCount: number): boolean {
    if (this._forceAnimationAndLocalMatrixUpdate) {
      this._forceAnimationAndLocalMatrixUpdate = false;
      return true;
    }

    // Child entities have no easy way to measure their distance from the camera or
    // to reliably access the latest information of their parent entities, so for
    // now they are updated every time. Ideally, we would like to control them similarly.
    //
    // Entities attached to the camera are likely player entities and highly
    // noticeable, so update them every frame.
    if (this._attached || this._game.camera.gameCameraAttachedEntity?.id === this.id) {
      return true;
    }

    // Entities within the defined sufficiently close range are updated every frame.
    if (this._distanceToCameraSquared < NEAR_DISTANCE_SQUARED) {
      return true;
    }

    // Compute the update frequency based on distance from the camera. Use simple
    // criteria to keep the calculation fast.
    //
    // It might be a good idea to also take distance from an entity attached to the camera
    // into account, since the area around it is likely to draw more attention.

    // Use view distance as the basis and compute the ratio of how far the entity
    // is from the camera.
    const viewDistance = this._game.renderer.viewDistance || 1000;
    // To slow the update frequency only for entities that are far away, and also for calculation optimization,
    // use the squared distance.
    const distanceRatio = this._distanceToCameraSquared / (viewDistance * viewDistance);
    const skipFrames = Math.min(MAX_UPDATE_SKIP_FRAMES, Math.floor(distanceRatio * MAX_UPDATE_SKIP_FRAMES));

    // To distribute which frames perform updates, add the id and then apply a modulo calculation.
    if ((frameCount + this.id) % (skipFrames + 1) === 0) {
      return true;
    }

    EntityStats.updateSkipCount++;

    return false;
  }

  public setClientColorCorrection(clientColorCorrection: {r: number, g: number, b: number} | undefined) {
    if (clientColorCorrection) {
      if (this._clientColorCorrection === null) {
        this._clientColorCorrection = new Color();
      }
      this._clientColorCorrection.setRGB(clientColorCorrection.r, clientColorCorrection.g, clientColorCorrection.b);
    } else {
      this._clientColorCorrection = null;
    }

    if (this._model) {
      this._applyColorCorrections(this._model);
    }
  }

  // By suppressing animation playback, we can use the no-animation optimized
  // glTF model and avoid both animation processing and the associated matrix
  // updates. This method provides such optimization.
  public suppressAnimations(shouldSuppressAnimations: boolean): void {
    if (!this._isGLTFEntity) {
      return;
    }

    if (this._shouldSuppressAnimations === shouldSuppressAnimations) {
      return;
    }

    const needsGLTFRefresh = this._needsGLTFRefresh(() => {
      this._shouldSuppressAnimations = shouldSuppressAnimations;

      // Immediately stop all animation playback.
      if (this._shouldSuppressAnimations && this._gltfAnimationMixer && this._model) {
        for (const action of this._gltfAnimationMixer._actions) {
          if (action.paused || !action.enabled) {
            continue;
          }
          this._clearAnimationFadeTimeout(action.getClip().name);
          action.stop().reset();
        }
        this._collectAnimationTargets(this._gltfAnimationMixer);
      }
    });

    if (needsGLTFRefresh) {
      // When animation playback is needed, it will be played inside _buildGLTFModel().
      this._buildGLTFModel();
    } else if (!this._shouldSuppressAnimations && this._gltfAnimationMixer && this._model && this._modelAnimations.size > 0) {
      // When no model switch is required, apply current protocol animation state explicitly.
      this._applyModelAnimations(this._model, this._gltfAnimationMixer, this._modelAnimations.values());
    }
  }

  private _applyColorCorrections(model: Object3D): void {
    model.traverse((child) => {
      if (child instanceof Mesh) {
        const materials: MeshBasicMaterial[] = Array.isArray(child.material) ? child.material : [child.material];
        materials.forEach(material => {
          color.copy(material.color);

          const originalData = this._getOriginalMaterialData(material);
          material.color.copy(originalData.color);

          if (this._tintColor) {
            material.color.multiply(this._tintColor);
          }

          if (this._clientColorCorrection) {
            material.color.multiply(this._clientColorCorrection);
          }

          if (this._isGLTFEntity) {
            this._game.gltfManager.onMeshColorChanged(child, color, material.color);
          }
        });
      }
    });
  }

  private _hasEmissiveSettings(): boolean {
    return this._emissiveColor !== null ||
           this._emissiveIntensity !== null ||
           this._emissiveColorsByNode.size > 0 ||
           this._emissiveIntensitiesByNode.size > 0 ||
           this._hasModelNodeOverrideEmissiveSettings();
  }

  private _hasModelNodeOverrideEmissiveSettings(): boolean {
    for (const modelNodeOverride of this._modelNodeOverrides.values()) {
      if (modelNodeOverride.emissiveColor !== undefined || modelNodeOverride.emissiveIntensity !== undefined) {
        return true;
      }
    }

    return false;
  }

  /** Gets a value from a node map, prioritizing exact match then falling back to longest substring match. */
  private _getNodeMapValue<T>(map: Map<string, T>, nodeName: string): T | undefined {
    if (map.size === 0) return undefined;
    
    const exact = map.get(nodeName);
    if (exact !== undefined) return exact;
    
    // Find longest matching key in single pass
    let longestKeyLength = 0;
    let result: T | undefined;

    for (const [key, value] of map) {
      if (key.length > longestKeyLength && nodeName.includes(key)) {
        longestKeyLength = key.length;
        result = value;
      }
    }

    return result;
  }

  /** Matches model node override selectors (`head`, `head*`, `*head`, `*head*`). */
  private _matchesModelNodeNameMatch(nameMatch: string, nodeName: string): boolean {
    const startsWithWildcard = nameMatch.startsWith('*');
    const endsWithWildcard = nameMatch.endsWith('*');

    if (!startsWithWildcard && !endsWithWildcard) {
      return nameMatch === nodeName;
    }

    const target = nameMatch.slice(
      startsWithWildcard ? 1 : 0,
      endsWithWildcard ? -1 : undefined,
    );

    // Only leading and/or trailing wildcard is supported.
    if (target.includes('*')) {
      return false;
    }

    if (startsWithWildcard && endsWithWildcard) {
      return nodeName.includes(target);
    }

    if (startsWithWildcard) {
      return nodeName.endsWith(target);
    }

    return nodeName.startsWith(target);
  }

  private _getModelNodeOverride(nodeName: string): DeserializedModelNodeOverride | undefined {
    if (this._modelNodeOverrides.size === 0) {
      return undefined;
    }

    const exact = this._modelNodeOverrides.get(nodeName);
    if (exact !== undefined) {
      return exact;
    }

    let bestMatch: DeserializedModelNodeOverride | undefined;
    let bestSpecificity = -1;
    let bestWildcardRank = -1;

    for (const [nameMatch, modelNodeOverride] of this._modelNodeOverrides) {
      if (!nameMatch.includes('*') || !this._matchesModelNodeNameMatch(nameMatch, nodeName)) {
        continue;
      }

      const startsWithWildcard = nameMatch.startsWith('*');
      const endsWithWildcard = nameMatch.endsWith('*');
      const target = nameMatch.slice(startsWithWildcard ? 1 : 0, endsWithWildcard ? -1 : undefined);
      const specificity = target.length;
      const wildcardRank = startsWithWildcard === endsWithWildcard ? 0 : 1;

      if (specificity > bestSpecificity || (specificity === bestSpecificity && wildcardRank > bestWildcardRank)) {
        bestSpecificity = specificity;
        bestWildcardRank = wildcardRank;
        bestMatch = modelNodeOverride;
      }
    }

    return bestMatch;
  }

  private _storeModelNodeOverrideBaseTransform(node: Object3D): void {
    if (this._modelNodeOverrideBaseTransforms.has(node)) {
      return;
    }

    this._modelNodeOverrideBaseTransforms.set(node, {
      position: node.position.clone(),
      quaternion: node.quaternion.clone(),
      scale: node.scale.clone(),
    });
  }

  private _getModelNodeRotationCenter(node: Object3D, baseTransform: ModelNodeTransformData): Vector3 {
    if (baseTransform.rotationCenter) {
      return baseTransform.rotationCenter;
    }

    node.updateWorldMatrix(true, false);
    box3.setFromObject(node, true);

    if (box3.isEmpty()) {
      baseTransform.rotationCenter = new Vector3(0, 0, 0);
      return baseTransform.rotationCenter;
    }

    box3.getCenter(worldCenter);
    baseTransform.rotationCenter = node.worldToLocal(localCenter.copy(worldCenter)).clone();

    return baseTransform.rotationCenter;
  }

  private _restoreModelNodeTransformOverrideTargetsToBase(markNeedsMatrixUpdate: boolean = false): void {
    for (const node of this._modelNodeTransformOverrideTargets) {
      const baseTransform = this._modelNodeOverrideBaseTransforms.get(node);

      if (!baseTransform) {
        continue;
      }

      node.position.copy(baseTransform.position);
      node.quaternion.copy(baseTransform.quaternion);
      node.scale.copy(baseTransform.scale);

      if (markNeedsMatrixUpdate && !this._animationTargets.has(node)) {
        this._needsMatrixUpdate.add(node);
      }
    }
  }

  private _refreshModelNodeTransformOverrideTargets(model: Object3D): void {
    this._restoreModelNodeTransformOverrideTargetsToBase(true);
    this._modelNodeTransformOverrideTargets.clear();

    if (this._modelNodeOverrides.size === 0) {
      return;
    }

    model.traverse((node) => {
      if (node.userData[USER_DATA_ENTITY_ID] !== this._id) {
        return;
      }

      const modelNodeOverride = this._getModelNodeOverride(node.name.toLowerCase());

      if (!modelNodeOverride) {
        return;
      }

      const hasLocalPositionOverride = modelNodeOverride.localPosition !== null && modelNodeOverride.localPosition !== undefined;
      const hasLocalRotationOverride = modelNodeOverride.localRotation !== null && modelNodeOverride.localRotation !== undefined;
      const hasLocalScaleOverride = modelNodeOverride.localScale !== null && modelNodeOverride.localScale !== undefined;
      const hasTransformOverride = hasLocalPositionOverride || hasLocalRotationOverride || hasLocalScaleOverride ||
        this._hasActiveModelNodeTransformInterpolation(this._modelNodeOverrideTransformInterpolations.get(modelNodeOverride));

      if (!hasTransformOverride) {
        return;
      }

      this._storeModelNodeOverrideBaseTransform(node);
      this._modelNodeTransformOverrideTargets.add(node);
    });
  }

  private _clearModelNodeTransformOverrides(): void {
    this._modelNodeTransformOverrideTargets.clear();
    this._modelNodeOverrideBaseTransforms = new WeakMap();
  }

  private _applyModelNodeTransformOverrides(): void {
    for (const node of this._modelNodeTransformOverrideTargets) {
      if (node.userData[USER_DATA_ENTITY_ID] !== this._id) {
        continue;
      }

      const modelNodeOverride = this._getModelNodeOverride(node.name.toLowerCase());

      if (!modelNodeOverride) {
        continue;
      }

      const baseTransform = this._modelNodeOverrideBaseTransforms.get(node);
      if (!baseTransform) {
        continue;
      }

      const interpolationData = this._modelNodeOverrideTransformInterpolations.get(modelNodeOverride);
      const hasPersistentLocalPositionOverride = modelNodeOverride.localPosition !== null && modelNodeOverride.localPosition !== undefined;
      const hasPersistentLocalRotationOverride = modelNodeOverride.localRotation !== null && modelNodeOverride.localRotation !== undefined;
      const hasPersistentLocalScaleOverride = modelNodeOverride.localScale !== null && modelNodeOverride.localScale !== undefined;
      const localPosition = interpolationData?.localPosition && (interpolationData.localPosition.targetActive || interpolationData.localPosition.interpolating)
        ? interpolationData.localPosition.current
        : modelNodeOverride.localPosition ?? undefined;
      const localRotation = interpolationData?.localRotation && (interpolationData.localRotation.targetActive || interpolationData.localRotation.interpolating)
        ? interpolationData.localRotation.current
        : modelNodeOverride.localRotation ?? undefined;
      const localScale = interpolationData?.localScale && (interpolationData.localScale.targetActive || interpolationData.localScale.interpolating)
        ? interpolationData.localScale.current
        : modelNodeOverride.localScale ?? undefined;

      if (!localPosition && !localRotation && !localScale) {
        if (!hasPersistentLocalPositionOverride && !hasPersistentLocalRotationOverride && !hasPersistentLocalScaleOverride) {
          this._modelNodeTransformOverrideTargets.delete(node);
        }
        continue;
      }

      if (localPosition) {
        positionOffset.set(
          localPosition.x / (this._scale.x !== 0 ? this._scale.x : 1),
          localPosition.y / (this._scale.y !== 0 ? this._scale.y : 1),
          localPosition.z / (this._scale.z !== 0 ? this._scale.z : 1),
        );
        node.position.add(positionOffset);
      }

      if (localRotation) {
        quaternion
          .set(localRotation.x, localRotation.y, localRotation.z, localRotation.w)
          .normalize();

        const rotationCenter = this._getModelNodeRotationCenter(node, baseTransform);
        nextQuaternion.copy(quaternion).multiply(node.quaternion).normalize();

        rotationCenterOffset.copy(rotationCenter).multiply(node.scale).applyQuaternion(node.quaternion);
        rotatedCenterOffset.copy(rotationCenter).multiply(node.scale).applyQuaternion(nextQuaternion);

        node.position.add(rotationCenterOffset.sub(rotatedCenterOffset));
        node.quaternion.copy(nextQuaternion);
      }

      if (localScale) {
        node.scale.set(
          node.scale.x * localScale.x,
          node.scale.y * localScale.y,
          node.scale.z * localScale.z,
        );
      }

      if (!this._animationTargets.has(node)) {
        this._needsMatrixUpdate.add(node);
      }
    }
  }

  private _applyEmissive(model: Object3D): void {
    // TODO: Block entities don't support emissive yet - their material lacks customEmissive properties
    if (this.isBlockEntity) {
      return console.warn('Entity._applyEmissive(): Block entities do not currently support emissive features.');
    }

    model.traverse((child) => {
      if (child instanceof Mesh) {
        const materials: EmissiveMeshBasicMaterial[] = Array.isArray(child.material) ? child.material : [child.material];
        materials.forEach(material => {
          color.copy(material.customEmissive);
          const oldIntensity = material.customEmissiveIntensity;

          const originalData = this._getOriginalMaterialData(material);
          const nodeName = child.name.toLowerCase();
          const modelNodeOverride = this._getModelNodeOverride(nodeName);

          if (modelNodeOverride?.emissiveColor !== undefined) {
            if (modelNodeOverride.emissiveColor) {
              material.customEmissive.copy(modelNodeOverride.emissiveColor);
            } else {
              material.customEmissive.copy(originalData.emissive);
            }
          } else {
            const emissiveColor = this._getNodeMapValue(this._emissiveColorsByNode, nodeName);

            if (emissiveColor) {
              material.customEmissive.copy(emissiveColor);
            } else if (this._emissiveColor !== null) {
              material.customEmissive.copy(this._emissiveColor);
            } else {
              material.customEmissive.copy(originalData.emissive);
            }
          }

          if (modelNodeOverride?.emissiveIntensity !== undefined) {
            if (modelNodeOverride.emissiveIntensity !== null) {
              material.customEmissiveIntensity = modelNodeOverride.emissiveIntensity;
            } else {
              material.customEmissiveIntensity = originalData.emissiveIntensity;
            }
          } else {
            const emissiveIntensity = this._getNodeMapValue(this._emissiveIntensitiesByNode, nodeName);

            if (emissiveIntensity !== undefined) {
              material.customEmissiveIntensity = emissiveIntensity;
            } else if (this._emissiveIntensity !== null) {
              material.customEmissiveIntensity = this._emissiveIntensity;
            } else {
              material.customEmissiveIntensity = originalData.emissiveIntensity;
            }
          }

          if (this._isGLTFEntity) {
            this._game.gltfManager.onMeshEmissiveChanged(child, color, material.customEmissive, oldIntensity, material.customEmissiveIntensity);
          }
        });
      }
    });
  }

  public setCustomTexture(textureUri: string | null): void {
    if (this.isBlockEntity) {
      if (!textureUri) {
        return;
      }

      const nextTextureUri = Assets.toAssetUri(textureUri);
      if (nextTextureUri === this._blockTextureUri && this._model) {
        return;
      }

      this._blockTextureUri = nextTextureUri;
      const requestVersion = ++this._blockTextureRequestVersion;
      this._requestBlockModelBuild(nextTextureUri, requestVersion);
      return;
    }

    if (!this._isGLTFEntity) {
      throw new Error(`Entity.setCustomTexture(): Custom texture is supported only for glTF entity.`);
    }

    if (textureUri === this._customTextureUri) {
      return;
    }

    this._updateCustomTexture(textureUri);
  }

  private _requestBlockModelBuild(textureUri: string, requestVersion: number): void {
    const dimensions = this.blockDimensions;
    if (!dimensions) {
      throw new Error('Entity._requestBlockModelBuild(): Block entity must have blockHalfExtents to build with texture.');
    }

    const message: ChunkWorkerBlockEntityBuildMessage = {
      type: 'block_entity_build',
      entityId: this._id,
      requestVersion,
      dimensions,
      textureUris: textureUriToTextureUris(textureUri),
    };
    this._game.chunkWorkerClient.postMessage(message);
  }

  private async _updateCustomTexture(textureUri: string | null): Promise<void> {
    // Cancel all custom textures currently loading, as only the most recently requested one will be used.
    this._pendingCustomTextures.forEach(pendingCustomTexture => {
      this._game.customTextureManager.cancel(pendingCustomTexture, true);
    });
    this._pendingCustomTextures.clear();

    this._customTextureUri = textureUri ? Assets.toAssetUri(textureUri) : textureUri;

    if (this._customTextureUri) {
      EntityStats.customTextureCount++;
    } else {
      EntityStats.customTextureCount--;
    }

    let customTexture: CustomTextureWrapper | null = null;

    if (this._customTextureUri) {
      const pendingCustomTexture = this._game.customTextureManager.load(this._customTextureUri);
      this._pendingCustomTextures.add(pendingCustomTexture);

      // TODO: Error handling. What should we do if failing to load the texture?
      //       Use Missing Texture as fallback?
      customTexture = await pendingCustomTexture;

      // If the loading was canceled while waiting for completion, release the resources and do nothing.
      if (!this._pendingCustomTextures.has(pendingCustomTexture)) {
        this._game.customTextureManager.release(customTexture)
        return;
      }

      this._pendingCustomTextures.delete(pendingCustomTexture);
    }

    if (this._customTexture) {
      this._game.customTextureManager.release(this._customTexture);
      if (this._model) {
        this._game.gltfManager.detachCustomTexture(this._gltf!, this._customTexture.texture);
      }
    }

    this._customTexture = customTexture;

    if (this._gltf && this._customTexture) {
      this._game.gltfManager.attachCustomTexture(this._gltf, this._customTexture.texture);
    }
  }

  public addToScene(): void {
    if (this.parentEntityId) {
      this._attach();
    } else {
      this._detach();
    }
  }

  private _adjustModelOffset(model: Object3D): void {
    if (this._attached) {
      // Reset root position to 0,0,0 so that when attached to parent, the pivot point is correct.
      model.position.set(0, 0, 0);
    } else {
      // TODO: Allow static type checking
      const modelCenter = model.userData.modelCenter as Vector3;
      // Offset root position to center the model to its world physics position when not attached to parent
      model.position.set(-modelCenter.x, -modelCenter.y, -modelCenter.z);
    }
    this._needsMatrixUpdate.add(model);
  }

  private _parentModelReadyCallback = (parentEntity: Entity): void => {
    const parentModel = parentEntity.entityRoot;

    const target = this._parentNodeName ? parentModel.getObjectByName(this._parentNodeName) : parentModel;

    if (!target) {
      return console.warn(`Entity._parentModelReadyCallback(): Parent node ${this._parentNodeName} not found in parent entity ${parentEntity.id}.`);
    }

    this._attached = true;

    if (this._model) {
      this._adjustModelOffset(this._model);
    }

    target.add(this._entityRoot);

    // The parent can be changed, so a world matrix update is required.
    this._entityRoot.matrixWorldNeedsUpdate = true;
  };

  private _attach(): void {
    const parentEntity = this.parent;

    if (!parentEntity) {
      return console.warn(`Entity._attach(): Parent entity ${this._parentEntityId} not found.`);
    }

    this.removeFromScene();

    parentEntity.addModelReadyListener(this._parentModelReadyCallback, !!this._parentNodeName);
  }

  private _detach(): void {
    const parentEntity = this.parent;

    if (parentEntity) {
      parentEntity.removeModelReadyListener(this._parentModelReadyCallback);
    }

    this._attached = false;

    if (this._model) {
      this._adjustModelOffset(this._model);
    }

    this._game.renderer.addToScene(this._entityRoot);

    // The parent can be changed, so a world matrix update is required.
    this._entityRoot.matrixWorldNeedsUpdate = true;
  }

  public removeFromScene(): void {
    this._entityRoot.removeFromParent();
  }

  public release(): void {
    this.parent?.removeModelReadyListener(this._parentModelReadyCallback);
    this.removeFromScene();
    this._dispose();
  }

  public addModelReadyListener(callback: (parentEntity: Entity) => void, withNodeName: boolean): void {
    const needsGLTFRefresh = this._needsGLTFRefresh(() => {
      (withNodeName ? this._modelReadyListeners.withNodeName : this._modelReadyListeners.withoutNodeName).add(callback);
    });

    if (needsGLTFRefresh) {
      this._buildGLTFModel();
    } else {
      if (this._model) {
        callback(this);
      }
    }
  }

  public removeModelReadyListener(callback: (parentEntity: Entity) => void): void {
    const needsGLTFRefresh = this._needsGLTFRefresh(() => {
      // Since Set.delete() doesn’t incur any penalty even if the value doesn’t exist in the set,
      // we simply call both .delete() operations.
      this._modelReadyListeners.withNodeName.delete(callback);
      this._modelReadyListeners.withoutNodeName.delete(callback);
    });

    if (needsGLTFRefresh) {
      this._buildGLTFModel();
    }
  }

  // First update pass: Update local position and rotation
  public update(deltaTimeS: number): void {
    this._interpolate(deltaTimeS);
  }

  // Second update pass: Apply ViewDistance with updated local position
  public applyViewDistance(viewDistanceSquared: number, fromVec2: Vector2): boolean {
    if (this.attached) {
      // Keep child entities always visible, and make their visibility depend on the parent entity.
      this.visible = true;
      // Note: Ignores child entities for EntityStats.visibleCount so far because of no easy solution.
      // TODO: Count visible child entities properly
    } else {
      // TODO: It would probably make more sense for entities to track which chunk they belong to and
      // sync their visibility with the chunk. Otherwise, there could be cases where a chunk is invisible
      // but the entity remains visible, which could make the entity appear to be floating in mid-air.
      const coord = this.position;
      this._distanceToCameraSquared = fromVec2.distanceToSquared(vec2.set(coord.x, coord.z));
      this.visible = this._distanceToCameraSquared <= viewDistanceSquared;
      if (this.visible) {
        EntityStats.inViewDistanceCount++;
      }
    }

    return this.visible;
  }

  // Third update pass: Apply Frustum culling
  public applyFrustumCulling(frustum: Frustum): boolean {
    // If the entity is already invisible due to view distance or not ready for
    // frustum culling, return early.
    // As for child entities, computing their world position is costly, so for now we are avoiding processing them.
    if (!this.visible || this.attached || this._localBoundingBox === null || this._worldBoundingBox === null) {
      return this.visible;
    }

    // Keep the camera-attached entity visible to avoid view model culling.
    if (this._game.camera.gameCameraAttachedEntity?.id === this.id) {
      this.visible = true;
      return this.visible;
    }

    if (this._needsWorldBoundingBoxUpdate) {
      const min = this._localBoundingBox.min;
      const max = this._localBoundingBox.max;

      corners[0].set(min.x, min.y, min.z);
      corners[1].set(max.x, min.y, min.z);
      corners[2].set(min.x, max.y, min.z);
      corners[3].set(max.x, max.y, min.z);
      corners[4].set(min.x, min.y, max.z);
      corners[5].set(max.x, min.y, max.z);
      corners[6].set(min.x, max.y, max.z);
      corners[7].set(max.x, max.y, max.z);

      for (let i = 0; i < corners.length; i++) {
        corners[i]
          .sub(this._model!.userData.modelCenter as Vector3)
          .multiply(this._scale)
          .applyQuaternion(this._currentRotation)
          .add(this._currentPosition);
      }

      this._worldBoundingBox!.setFromPoints(corners);
      this._needsWorldBoundingBoxUpdate = false;
    }

    if (!frustum.intersectsBox(this._worldBoundingBox)) {
      // Limitation: Frustum culling is performed using only the parent entity's bounding box,
      // and if it becomes invisible, child entities are also affected. Therefore,
      // even when a child entity is within the view while the parent is outside,
      // the child will still become invisible.
      // TODO: When the bounding box crosses the view boundary, enable mesh-level frustum
      // culling for optimization.
      this.visible = false;
      EntityStats.frustumCulledCount++;
    }

    return this.visible;
  }

  // Fourth update pass: Update Local matrix and animation
  public updateAnimationAndLocalMatrix(deltaTimeS: number, frameCount: number): void {
    // Even when invisible, the animation elapsed time should continue, so record it.
    this._pendingAnimationTimeS += deltaTimeS;

    // Do not update since it will not be visible anyway.
    // TODO: Also Skip updates when the entity is invisible due to the influence of its parent entity.
    if (!this.visible) {
      return;
    }

    // Lower the update frequency for distant entities.
    if (!this._shouldUpdateAnimationAndLocalMatrix(frameCount)) {
      return;
    }

    // Note: Assuming entity's glTF animations are self-animations only,
    // such as walking, running, or other body motions, and do not make large
    // changes to Position. If this assumption ever changes, we will need to
    // update Animation before applying ViewDistance.

    if (this._modelNodeTransformOverrideTargets.size > 0) {
      this._restoreModelNodeTransformOverrideTargetsToBase();
    }

    // Note: Assumes that the same object is not included in both this._animationTargets and
    // this._needsMatrixUpdate. If this assumption turns out to be incorrect, we will need to
    // add a check to ensure no duplicate objects are present for efficiency.
    if (this._gltfAnimationMixer && !this._shouldSuppressAnimations) {
      this._gltfAnimationMixer.update(this._pendingAnimationTimeS);
      EntityStats.animationPlayCount++;
    }

    if (this._modelNodeTransformOverrideTargets.size > 0) {
      this._interpolateModelNodeTransformOverrides(deltaTimeS);
      this._applyModelNodeTransformOverrides();
    }

    if (this._gltfAnimationMixer && !this._shouldSuppressAnimations) {
      for (const obj of this._animationTargets) {
        obj.updateMatrix();
        this._needsMatrixWorldUpdate = true;
        EntityStats.localMatrixUpdateCount++;
      };
    }

    this._pendingAnimationTimeS = 0;

    for (const obj of this._needsMatrixUpdate) {
      obj.updateMatrix();
      this._needsMatrixWorldUpdate = true;
      EntityStats.localMatrixUpdateCount++;
    };

    this._needsMatrixUpdate.clear();
  }

  // Fifth update Pass: Update world matrices
  public updateWorldMatrices(needsLightLevelUpdateDetection: boolean): void {
    if (!this.visible) {
      // Do not update since it will not be visible anyway.
      return;
    }

    // Child entities are not processed further here. Their world matrices are updated within the
    // parent Entity's Object3D.updateMatrixWorld(). This is necessary because a child Entity's
    // world matrix cannot be accurately updated unless its parent’s world matrix is already up
    // to date. As a result, if child entities exist, .updateMatrixWorld() must always be called
    // regardless of the _needsMatrixWorldUpdate flag. Currently, there is no way to efficiently check
    // whether any of the child entities require a world matrix update. Although .updateMatrixWorld()
    // internally checks .matrixWorldNeedsUpdate to determine whether to actually update each object's
    // world matrix, traversing the tree still incurs a cost. If this becomes a performance issue, we
    // may need to introduce a mechanism to detect whether child world matrices require updates.
    if (!this._attached && (this._needsMatrixWorldUpdate || this.isAttachmentTarget)) {
      const updateCount = this._traverseAndUpdateWorldMatrices(this._entityRoot, false);

      if (updateCount > 0) {
        const { x: gx, y: gy, z: gz } = this._globalCoordinate;
        Chunk.worldPositionToGlobalCoordinate(this._entityRoot.position, this._globalCoordinate);

        if (
          this._globalCoordinate.x !== gx ||
          this._globalCoordinate.y !== gy ||
          this._globalCoordinate.z !== gz
        ) {
          if (needsLightLevelUpdateDetection) {
            this._needsLightLevelUpdate = true;
          }
          this._needsSkyLightUpdate = true;
        }
      }

      EntityStats.worldMatrixUpdateCount += updateCount;
    }
    this._needsMatrixWorldUpdate = false;
  }

  // Sixth update pass: Update light level
  public updateLightLevel(force: boolean): void {
    if (!this.visible) {
      // When invisible, there is no need to update the light level, so skip the
      // update. However, if an update is required, record that state for later.
      this._needsLightLevelUpdate ||= force;
      return;
    }

    // Light level only needs recalculation when entity moves to a new block position.
    // Ambient light intensity uses a getter pattern in the shader uniforms, so it
    // updates automatically without explicit traversal.
    const needsLightLevelRecalc = !this._attached && (this._needsLightLevelUpdate || force);
    if (!needsLightLevelRecalc) {
      return;
    }

    // Get the LightLevel from LightVolume based on the position of the top-level Entity.
    // Note: If you want to apply appropriate LightLevels to each part of a large
    //       Entity model spanning multiple blocks, you'll need to fetch light level
    //       based on world vertex position in the shader.
    const lightLevel = this._game.lightLevelManager.getLightLevelByGlobalCoordinate(this._entityRoot.position) / MAX_LIGHT_LEVEL;

    this._lightLevel = lightLevel;
    EntityStats.lightLevelUpdateCount++;

    this._needsLightLevelUpdate = false;
  }

  // Seventh update pass: Update sky light
  public updateSkyLight(force: boolean, deltaTimeS: number): void {
    if (!this.visible) {
      // When invisible, there is no need to update the sky light, so skip the
      // update. However, if an update is required, record that state for later.
      this._needsSkyLightUpdate ||= force;
      return;
    }

    // Sky light target only needs recalculation when entity moves to a new block position.
    const needsSkyLightTargetUpdate = !this._attached && (this._needsSkyLightUpdate || force);
    if (needsSkyLightTargetUpdate) {
      this._targetSkyLight = this._game.skyDistanceVolumeManager.getSkyLightBrightnessByGlobalCoordinate(this._globalCoordinate);
      if (this._targetSkyLight !== this._skyLight) {
        this._interpolatingSkyLight = true;
      }
      this._needsSkyLightUpdate = false;
    }

    // Skip if already at target
    if (!this._interpolatingSkyLight) {
      return;
    }

    // Interpolate toward target for smooth transitions (frame-rate independent)
    // Shader uniforms use a getter to read _skyLight directly, so no traversal needed.
    const t = Math.min(deltaTimeS / SKY_LIGHT_INTERPOLATION_TIME_S, 1.0);
    const skyLight = this._skyLight + (this._targetSkyLight - this._skyLight) * t;
    this._skyLight = Math.abs(skyLight - this._targetSkyLight) < 0.0001 ? this._targetSkyLight : skyLight;

    if (this._skyLight === this._targetSkyLight) {
      this._interpolatingSkyLight = false;
    }
  }

  private _clearAnimationFadeTimeout(animation: string): void {
    if (this._animationFadeTimeouts.has(animation)) {
      clearTimeout(this._animationFadeTimeouts.get(animation));
      this._animationFadeTimeouts.delete(animation);
    }
  }

  // Note: Side effects that occur inside Three.js updateMatrixWorld()
  // will not happen here. For example, Audio, Camera, SkinnedMesh, Helper,
  // and similar objects cause side effects.
  // If such Three.js objects could be added to the Entity's Object3D graph
  // in the future, this logic will need to be reconsidered.
  private _traverseAndUpdateWorldMatrices(obj: Object3D, force: boolean): number {
    // Since invisible, do not update its matrices and stop traversal.
    // Note: Carefully verify that this behavior does not cause any issues.
    if (obj.visible === false) {
      return 0;
    }

    let count = 0;

    if (obj.matrixWorldNeedsUpdate || force) {
      // If we assume EntityRoot is visible and has been added to the Scene, we
      // can remove this if statement. However, if a client implementation bug
      // causes this method to be called when EntityRoot.parent is null, the
      // client would crash.
      // To avoid a crash, keep this if statement as a precaution. If further
      // optimization becomes necessary, revisit this decision.
      if (obj.parent !== null) {
        obj.matrixWorld.multiplyMatrices(obj.parent.matrixWorld, obj.matrix);
      } else {
        obj.matrixWorld.copy(obj.matrix);
      }

      if (obj instanceof Mesh) {
        updateAABB(obj);
      }

      obj.matrixWorldNeedsUpdate = false;
      count++;
      force = true;
    }

    for (const child of obj.children) {
      count += this._traverseAndUpdateWorldMatrices(child, force);
    }

    return count;
  }

  // Calculate and set bounding box and model center
  private _storeModelCenter(model: Object3D, precise: boolean): void {
    // TODO: Since dynamically computing the bounding box can be slow depending on the model and device,
    // it is probably more efficient to precompute it on the server and send it to the client. Also, because
    // this bounding box is used for frustum culling, if we compute the maximum bounding box that takes
    // animation into account, we can expect improved accuracy.
    this._localBoundingBox = new Box3().setFromObject(model, precise);
    model.userData.modelCenter = this._localBoundingBox.getCenter(new Vector3());
    this._worldBoundingBox = this._localBoundingBox.clone();
    this._needsWorldBoundingBoxUpdate = true;
  }

  private _storeOriginalMaterialData(material: MeshBasicMaterial | EmissiveMeshBasicMaterial): void {
    // Materials may be shared across multiple meshes, and the original data might already
    // be stored at this point.
    if (!(ORIGINAL_MATERIAL_DATA in material.userData)) {
      const emissiveMaterial = material as EmissiveMeshBasicMaterial;
      const originalData: OriginalMaterialData = {
        alphaTest: material.alphaTest,
        color: material.color.clone(),
        emissive: emissiveMaterial.customEmissive?.clone() ?? new Color(0x000000),
        emissiveIntensity: emissiveMaterial.customEmissiveIntensity ?? 1.0,
        opacity: material.opacity,
        transparent: material.transparent,
      };
      material.userData[ORIGINAL_MATERIAL_DATA] = originalData;
    }
  }

  private _getOriginalMaterialData(material: MeshBasicMaterial): OriginalMaterialData {
    if (!(ORIGINAL_MATERIAL_DATA in material.userData)) {
      throw new Error(`Missing original material data in Material: ${material.uuid}`);
    }
    return material.userData[ORIGINAL_MATERIAL_DATA] as OriginalMaterialData;
  }

  private _createSharedUniformData(): LightLevelUniformData {
    const ambientLight = this._game.renderer.ambientLight;
    const entity = this;

    return {
      [UNIFORM_LIGHT_LEVEL]: { get value() { return entity._getEffectiveLightLevel(); } },
      // Use getter to always read current sky light value (avoids traversal on update)
      // For attached entities, this recursively gets the parent's skyLight via _getEffectiveSkyLight().
      [UNIFORM_SKY_LIGHT]: { get value() { return entity._getEffectiveSkyLight(); } },
      [UNIFORM_RAW_AMBIENT_LIGHT_COLOR]: { value: ambientLight.color },
      // Use getter to always read current intensity value (intensity is a primitive, not an object)
      [UNIFORM_AMBIENT_LIGHT_INTENSITY]: { get value() { return ambientLight.intensity; } },
    };
  }

  private _createLightingProcessor(): (params: WebGLProgramParametersWithUniforms) => void {
    return (params) => {
      for (const key in this._lightLevelUniformData) {
        params.uniforms[key] = this._lightLevelUniformData[key as keyof typeof this._lightLevelUniformData];
      }

      params.vertexShader = params.vertexShader
        .replace(
          'void main() {',
          `
            varying float vWorldNormalY;

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
              vWorldNormalY = getWorldNormalY(normal, modelMatrix);
          `,
        );

      params.fragmentShader = params.fragmentShader
        .replace(
          'void main() {',
          `
            uniform float ${UNIFORM_LIGHT_LEVEL};
            uniform float ${UNIFORM_SKY_LIGHT};
            uniform vec3 ${UNIFORM_RAW_AMBIENT_LIGHT_COLOR};
            uniform float ${UNIFORM_AMBIENT_LIGHT_INTENSITY};

            varying float vWorldNormalY;

            void main() {
          `,
        )
        // For MeshBasicMaterial, apply ambient lighting and block light levels manually
        // since there's no lighting system.
        .replace(
          '#include <opaque_fragment>',
          `
            // Base ambient lighting (replaces Three.js AmbientLight which doesn't affect MeshBasicMaterial)
            vec3 ambientLight = ${UNIFORM_RAW_AMBIENT_LIGHT_COLOR} * ${UNIFORM_AMBIENT_LIGHT_INTENSITY};
            // Block light contribution from emissive blocks
            vec3 blockLight = ${UNIFORM_RAW_AMBIENT_LIGHT_COLOR} * ${UNIFORM_LIGHT_LEVEL} * ${LIGHT_LEVEL_STRENGTH_MULTIPLIER};
            // Take the brighter of ambient or block light
            outgoingLight *= max(ambientLight, blockLight);

            // Face-based shading using polynomial approximation of Block values
            // Polynomial coefficients derived from the three shading values
            // Solves: f(1) = TOP, f(0) = SIDE, f(-1) = BOTTOM
            float normalY = gl_FrontFacing ? vWorldNormalY : -vWorldNormalY;
            float faceShade = ${FACE_SHADE_SIDE.toFixed(2)}
                  + (${FACE_SHADE_TOP.toFixed(2)} - ${FACE_SHADE_BOTTOM.toFixed(2)}) * 0.5 * normalY
                  + ((${FACE_SHADE_TOP.toFixed(2)} + ${FACE_SHADE_BOTTOM.toFixed(2)}) * 0.5 - ${FACE_SHADE_SIDE.toFixed(2)}) * normalY * normalY;

            // Apply sky light (multiply like in chunks)
            outgoingLight *= ${UNIFORM_SKY_LIGHT} * faceShade;
            #include <opaque_fragment>
          `,
        );
    };
  }

  public buildBlockModel(data: BlocksBufferGeometryData, dimensions: Vector3Like, transparent: boolean): void {
    const { colors, indices, normals, positions, uvs } = data;

    if (!this._blockHalfExtents) {
      throw new Error('Entity.buildBlockModel(): Block entity must have blockHalfExtents to build a block model.');
    }

    this._clearBlockModelResources();

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
    geometry.setAttribute('color', new BufferAttribute(colors, 4));
    geometry.setIndex(new BufferAttribute(indices, 1));

    const model = new Group();
    // Since the SDK API allows each Block Entity to have different material parameters, the
    // material is cloned. To save memory and reduce material switching costs in the WebGLRenderer,
    // it would be better to clone only when material parameters differ from the default.
    // However, this approach increases complexity in resource management.
    const mesh = new Mesh(geometry, this._game.blockMaterialManager.cloneTransparentNonLitMaterial());
    mesh.material.transparent = transparent;
    model.add(mesh);

    this._storeModelCenter(model, false);
    this._storeOriginalMaterialData(mesh.material);
    mesh.material.onBeforeCompile = this._createLightingProcessor();

    model.scale.set(
      this._blockHalfExtents.x * 2 / dimensions.x,
      this._blockHalfExtents.y * 2 / dimensions.y,
      this._blockHalfExtents.z * 2 / dimensions.z
    );

    if (this._opacity !== DEFAULT_OPACITY) {
      this._applyOpacity(model);
    }

    if (this._tintColor || this._clientColorCorrection) {
      this._applyColorCorrections(model);
    }

    if (this._hasEmissiveSettings()) {
      this._applyEmissive(model);
    }

    this._adjustModelOffset(model);

    model.traverse(obj => {
      obj.matrixAutoUpdate = false;
      obj.frustumCulled = false;
      obj.userData[USER_DATA_ENTITY_ID] = this._id;
      obj.userData[USER_DATA_EFFECTIVELY_VISIBLE] = true;
    });

    this._model = model;
    this._entityRoot.add(model);
    this._forceAnimationAndLocalMatrixUpdate = true;

    this._modelReadyListeners.withNodeName.forEach(callback => callback(this));
    this._modelReadyListeners.withoutNodeName.forEach(callback => callback(this));

    this.addToScene();
  }

  private _clearBlockModelResources(): void {
    if (!this._model) {
      this._clearModelNodeTransformOverrides();
      return;
    }

    this._model.traverse(obj => {
      if (obj instanceof Mesh) {
        // Dispose geometry
        if (obj.geometry) {
          obj.geometry.dispose();
        }

        const materials: MeshBasicMaterial[] = Array.isArray(obj.material) ? obj.material : [obj.material];

        // Dispose textures & materials
        materials.forEach(material => {
          for (const key in material) {
            const value = (material as any)[key];
            if (value instanceof Texture && value !== Game.instance.blockTextureAtlasManager.texture) {
              value.dispose();
            }
          }
          material.dispose();
        });
      }
    });

    this._entityRoot.remove(this._model);
    this._model = null;
    this._clearModelNodeTransformOverrides();
  }

  private _setupGLTFModel(gltf: GLTF): AnimationMixerEx {
    const model = gltf.scene;
    this._additiveModelAnimationClips.clear();

    gltf.animations.forEach(animation => {
      model.animations.push(animation);
    });

    // Update the mixer on each frame
    const mixer = new AnimationMixer(model) as AnimationMixerEx;

    // Necessary to detect the completion of a one-shot animation.
    mixer.addEventListener('finished', () => {
      const needsGLTFRefresh = this._needsGLTFRefresh(() => {
        this._collectAnimationTargets(mixer);
      });

      if (needsGLTFRefresh) {
        this._buildGLTFModel();
      }
    });

    // Calculate bounding box and set model center.
    // It seems that the center calculation sometimes may not be accurate for glTF models
    // optimized with glTF-Transform. Setting the second argument "precise = true" in
    // "setFromObject()", which enables high-precision mode, seems to resolve this issue.
    // This increases computation cost, but since it only occurs when loading a glTF model,
    // we don't think it's a concern for now.
    // If a large number of glTF entities reference the same glTF model and this becomes a
    // performance issue, we can move the center calculation to GLTFManager to compute it
    // only once per glTF model.
    // TODO: Allow static type checks
    this._storeModelCenter(model, true);

    model.traverse((node) => {
      this._storeModelNodeOverrideBaseTransform(node);
      node.userData[USER_DATA_ENTITY_ID] = this._id;
      node.userData[USER_DATA_EFFECTIVELY_VISIBLE] = true;
      if (node instanceof Mesh && node.material) {
        const material = node.material as EmissiveMeshBasicMaterial;

        // For performance reasons, two-pass rendering is disabled for DoubleSide materials.
        // It might be worth allowing this to be enabled via a quality-performance tradeoff setting.
        material.forceSinglePass = true;

        this._storeOriginalMaterialData(material);
        material.addShaderProcessor(this._createLightingProcessor());
      }
    });

    if (this._modelAnimations.size > 0) {
      this._applyModelAnimations(model, mixer, this._modelAnimations.values());
    }

    if (this._modelHiddenNodesByCamera.length > 0 || this._modelShownNodesByCamera.length > 0 || this._modelNodeOverrides.size > 0) {
      this._updateModelNodesVisibility(model);
    }

    if (this._opacity !== DEFAULT_OPACITY) {
      this._applyOpacity(model);
    }

    if (this._tintColor || this._clientColorCorrection) {
      this._applyColorCorrections(model);
    }

    if (this._hasEmissiveSettings()) {
      this._applyEmissive(model);
    }

    this._refreshModelNodeTransformOverrideTargets(model);
    this._applyModelNodeTransformOverrides();

    if (this._customTexture) {
      this._game.gltfManager.attachCustomTexture(gltf, this._customTexture.texture);
    }

    return mixer;
  }

  protected async _buildGLTFModel(): Promise<void> {
    if (!this._modelUri) {
      throw new Error('Entity._buildGLTFModel(): Model uri is required to build a gltf model.');
    }

    // Cancel all ongoing glTF loading processes and effecitive uri requests to ensure to use
    // only the latest request.
    this._pendingGltfs.forEach(pendingGltf => {
      // The request may have already been resolved, but there could still be code that
      // is awaiting it and has not yet executed. To suppress error console logs,
      // the `quiet` flag (second argument) is set. However, this might delay bug detection.
      this._game.gltfManager.cancel(pendingGltf, true);
    });
    this._pendingGltfs.clear();
    this._pendingEffectiveUris.clear();

    const pendingEffectiveUri = Assets.getEffectiveGLTFlUri(this._modelUri, this._needsNamedNodesGLTF(), this._needsNoAnimationsGLTF());
    this._pendingEffectiveUris.add(pendingEffectiveUri);
    const effectiveUri = await pendingEffectiveUri;

    // The effective uri request may have already been canceled while awaiting.
    // In that case, do nothing.
    if (!this._pendingEffectiveUris.has(pendingEffectiveUri)) {
      return;
    }

    this._pendingEffectiveUris.delete(pendingEffectiveUri);

    const pendingGltf = this._game.gltfManager.load(effectiveUri);
    this._pendingGltfs.add(pendingGltf);
    const gltf = await pendingGltf;

    // The request may have already been canceled while awaiting.
    // In that case, release resources and do nothing.
    if (!this._pendingGltfs.has(pendingGltf)) {
      this._game.gltfManager.release(gltf)
      return;
    }

    this._pendingGltfs.delete(pendingGltf);

    // To maintain smooth animation even when the model switches, record the current
    // animation time and apply it to the new mixer's animation.
    // TODO: Are there any other values that should be copied?
    const actionTimes: Record<string, number> = {};
    if (this._gltfAnimationMixer && this._model) {
      this._model.animations.forEach(clip => {
        const action = this._gltfAnimationMixer!.existingAction(clip);
        if (action) {
          actionTimes[clip.name] = action.time;
        }
      });
    }

    this._clearGLTFResources();

    gltf.scene.traverse(obj => {
      obj.matrixAutoUpdate = false;
      obj.frustumCulled = false;
    });

    this._gltf = gltf;
    this._gltfAnimationMixer = this._setupGLTFModel(gltf);
    this._model = gltf.scene;
    this._adjustModelOffset(this._model);
    this._entityRoot.add(this._model);

    this._model.animations.forEach(clip => {
      const action = this._gltfAnimationMixer!.existingAction(clip);
      if (action && actionTimes[clip.name]) {
        action.time = actionTimes[clip.name];
      }
    });

    // Entity has a mechanism that reduces the frequency of animation and matrices updates
    // for distant entities.
    // Force animation and matrix updates in the frame when the model is added to
    // the scene. Otherwise, until the next update, it may be rendered at (0, 0, 0)
    // in a default pose. This would stand out even for a few frames, so avoid it.
    this._forceAnimationAndLocalMatrixUpdate = true;

    this._modelReadyListeners.withNodeName.forEach(callback => callback(this));
    this._modelReadyListeners.withoutNodeName.forEach(callback => callback(this));

    this.addToScene();
  }

  private _clearGLTFResources(): void {
    this._pendingGltfs.forEach(pendingGltf => {
      // Refer to the comment above for the second argument true.
      this._game.gltfManager.cancel(pendingGltf, true);
    });
    this._pendingGltfs.clear();
    this._pendingEffectiveUris.clear();
    this._clearModelNodeTransformOverrides();

    if (this._gltf) {
      if (this._customTexture) {
        this._game.gltfManager.detachCustomTexture(this._gltf, this._customTexture.texture);
      }
      this._game.gltfManager.release(this._gltf);
      this._entityRoot.remove(this._model!);
      this._gltfAnimationMixer!.uncacheRoot(this._model!);
      this._model = null;
    }

    this._gltf = null;
    this._gltfAnimationMixer = null;
  }

  private _dispose(): void {
    this._clearGLTFResources();

    this._pendingCustomTextures.forEach(pendingCustomTexture => {
      this._game.customTextureManager.cancel(pendingCustomTexture, true);
    });
    this._pendingCustomTextures.clear();

    if (this._customTexture) {
      this._game.customTextureManager.release(this._customTexture);
      EntityStats.customTextureCount--;
    }

    // Note that Entity should be Block Entity here
    this._clearBlockModelResources();
  }

  public _interpolate(deltaTimeS: number) {
    if (this._interpolatingPosition || this._interpolatingRotation || this._interpolatingScale) {
      // Default interpolation is tuned for 30Hz server updates (~33ms between packets).
      // Interpolation settings are stateful and persist until explicitly changed.

      if (this._interpolatingPosition) {
        const positionT = this._calculateInterpolationFactor(deltaTimeS, this._positionInterpolationTimeS);
        if (lerp(this._currentPosition, this._targetPosition, positionT)) {
          this._interpolatingPosition = false;
        }
        this._entityRoot.position.copy(this._currentPosition);
      }

      if (this._interpolatingRotation) {
        const rotationT = this._calculateInterpolationFactor(deltaTimeS, this._rotationInterpolationTimeS);
        if (slerp(this._currentRotation, this._targetRotation, rotationT)) {
          this._interpolatingRotation = false;
        }
        this._entityRoot.quaternion.copy(this._currentRotation);
      }

      if (this._interpolatingScale) {
        const scaleT = this._calculateInterpolationFactor(deltaTimeS, this._scaleInterpolationTimeS);
        if (lerp(this._scale, this._targetScale, scaleT)) {
          this._interpolatingScale = false;
        }        
        this._entityRoot.scale.copy(this._scale);
      }

      this._needsMatrixUpdate.add(this._entityRoot);
      this._needsWorldBoundingBoxUpdate = true;
    }
  }
}
