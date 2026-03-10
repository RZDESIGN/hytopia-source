import { Color, Frustum, MathUtils, Matrix4, Object3D, Vector2, Vector3, Quaternion } from 'three';
import Entity from './Entity';
import { type EntityId, MAX_OUTLINES } from './EntityConstants';
import EntityStats from './EntityStats';
import LocalPredictionStats from './LocalPredictionStats';
import StaticEntity from './StaticEntity';
import StaticEntityManager from './StaticEntityManager';
import { type RendererEventPayload, RendererEventType } from '../core/Renderer';
import EventRouter from '../events/EventRouter';
import type Game from '../Game';
import type { DeserializedEntity } from '../network/Deserializer';
import type { NetworkManagerEventPayload } from '../network/NetworkEventPayloads';
import { NetworkManagerEventType } from '../network/NetworkEvents';
import { ClientSettingsEventType } from '../settings/SettingsManager';
import {
  type WorkerEventPayload,
  WorkerEventType,
} from '../workers/ChunkWorkerConstants';
import {
  resolveDeterministicMovementDirection,
  resolveDeterministicMovementYaw,
} from '@gameplay-shared/DeterministicMovementCore';

// Working variables
const fromVec2 = new Vector2();
const frustum = new Frustum();
const projScreenMatrix = new Matrix4();

export interface OutlineOptions {
  color: Color;
  colorIntensity: number;
  thickness: number;
  opacity: number;
  occluded: boolean;
}

export interface OutlineTarget {
  object3d: Object3D | null;
  options: OutlineOptions | null;
}

const DEFAULT_OUTLINE_OPTIONS: OutlineOptions = {
  color: new Color(0, 0, 0),
  colorIntensity: 1.0,
  thickness: 0.03,
  opacity: 1.0,
  occluded: true,
};

const LOCAL_PREDICTION_DEFAULT_WALK_SPEED = 4;
const LOCAL_PREDICTION_DEFAULT_RUN_SPEED = 8;
const LOCAL_PREDICTION_DEFAULT_JUMP_VELOCITY = 10;
const LOCAL_PREDICTION_DEFAULT_SWIM_FAST_SPEED = 5;
const LOCAL_PREDICTION_DEFAULT_SWIM_SLOW_SPEED = 3;
const LOCAL_PREDICTION_DEFAULT_SWIM_UPWARD_VELOCITY = 2;
const LOCAL_PREDICTION_MIN_SPEED = 0.2;
const LOCAL_PREDICTION_MAX_SPEED = 20;
const LOCAL_PREDICTION_SPEED_REJECT_THRESHOLD = 30;
const LOCAL_PREDICTION_SPEED_UPWARD_ADAPT_RATE = 0.2;
const LOCAL_PREDICTION_SPEED_DOWNWARD_ADAPT_RATE = 0.05;
const LOCAL_PREDICTION_SPEED_DIRECTION_ALIGNMENT_MIN_DOT = 0.85;
const LOCAL_PREDICTION_SPEED_VERTICAL_REJECT_THRESHOLD = 1.5;
const LOCAL_PREDICTION_MAX_FRAME_DELTA_S = 1 / 10;
const LOCAL_PREDICTION_SUBSTEP_DELTA_S = 1 / 60;
const LOCAL_PREDICTION_MAX_SUBSTEPS = 6;
const LOCAL_PREDICTION_REPLAY_COMMAND_MAX_DELTA_S = 1 / 8;
const LOCAL_PREDICTION_REPLAY_MAX_SUBSTEPS_PER_COMMAND = 12;
const LOCAL_PREDICTION_MOVING_HORIZONTAL_ERROR_DEAD_ZONE_SQ = 0.18 * 0.18;
const LOCAL_PREDICTION_IDLE_HORIZONTAL_ERROR_DEAD_ZONE_SQ = 0.08 * 0.08;
const LOCAL_PREDICTION_ACTIVE_INPUT_HORIZONTAL_RECONCILE_TOLERANCE_SQ = 0.55 * 0.55;
const LOCAL_PREDICTION_HORIZONTAL_SNAP_DISTANCE_SQ = 2.5 * 2.5;
const LOCAL_PREDICTION_MOVING_HORIZONTAL_CORRECTION_RATE = 10;
const LOCAL_PREDICTION_IDLE_HORIZONTAL_CORRECTION_RATE = 16;
const LOCAL_PREDICTION_MOVING_VERTICAL_ERROR_DEAD_ZONE = 0.03;
const LOCAL_PREDICTION_IDLE_VERTICAL_ERROR_DEAD_ZONE = 0.01;
const LOCAL_PREDICTION_ACTIVE_INPUT_VERTICAL_RECONCILE_TOLERANCE = 0.35;
const LOCAL_PREDICTION_VERTICAL_SNAP_DISTANCE = 2.5;
const LOCAL_PREDICTION_MOVING_VERTICAL_CORRECTION_RATE = 18;
const LOCAL_PREDICTION_IDLE_VERTICAL_CORRECTION_RATE = 26;
const LOCAL_PREDICTION_VERTICAL_VELOCITY_ADAPT_RATE = 0.35;
const LOCAL_PREDICTION_VERTICAL_VELOCITY_REJECT_THRESHOLD = 80;
const LOCAL_PREDICTION_MOVING_ROTATION_ERROR_DEAD_ZONE = 0.5;
const LOCAL_PREDICTION_IDLE_ROTATION_ERROR_DEAD_ZONE = 0.05;
const LOCAL_PREDICTION_ACTIVE_INPUT_ROTATION_RECONCILE_TOLERANCE = 0.9;
const LOCAL_PREDICTION_ROTATION_SNAP_ANGLE = 1.2;
const LOCAL_PREDICTION_MOVING_ROTATION_CORRECTION_RATE = 4;
const LOCAL_PREDICTION_IDLE_ROTATION_CORRECTION_RATE = 12;
const LOCAL_PREDICTION_SWIMMING_DRAG_FACTOR = 0.05;
const LOCAL_PREDICTION_WATER_ENTRY_SINKING_FACTOR = 0.8;
const LOCAL_PREDICTION_COMMAND_BUFFER_SIZE = 96;
const LOCAL_PREDICTION_PRE_ACK_RECONCILE_GRACE_S = 0.2;
const LOCAL_PREDICTION_ACK_SUPPORT_DETECTION_TIMEOUT_S = 2.0;
const INPUT_MANAGER_MOVEMENT_PACKET_SENT_EVENT = 'INPUT_MANAGER.MOVEMENT_PACKET_SENT';
const LOCAL_PREDICTION_FLAG_GROUNDED = 1 << 0;
const LOCAL_PREDICTION_FLAG_SWIMMING = 1 << 1;
const LOCAL_PREDICTION_COLLIDER_RADIUS = 0.4;
const LOCAL_PREDICTION_FOOT_OFFSET = 0.75;
const LOCAL_PREDICTION_TOP_OFFSET = 0.75;
const LOCAL_PREDICTION_GROUND_SNAP_DISTANCE = 0.18;
const LOCAL_PREDICTION_COLLISION_EPSILON = 0.001;
const LOCAL_PREDICTION_SAMPLE_INSET = LOCAL_PREDICTION_COLLIDER_RADIUS * 0.8;
const LOCAL_PREDICTION_FOOTPRINT_SAMPLES = [
  [0, 0],
  [LOCAL_PREDICTION_SAMPLE_INSET, 0],
  [-LOCAL_PREDICTION_SAMPLE_INSET, 0],
  [0, LOCAL_PREDICTION_SAMPLE_INSET],
  [0, -LOCAL_PREDICTION_SAMPLE_INSET],
  [LOCAL_PREDICTION_SAMPLE_INSET, LOCAL_PREDICTION_SAMPLE_INSET],
  [LOCAL_PREDICTION_SAMPLE_INSET, -LOCAL_PREDICTION_SAMPLE_INSET],
  [-LOCAL_PREDICTION_SAMPLE_INSET, LOCAL_PREDICTION_SAMPLE_INSET],
  [-LOCAL_PREDICTION_SAMPLE_INSET, -LOCAL_PREDICTION_SAMPLE_INSET],
] as const;

type LocalPredictionCommand = {
  sequenceNumber: number;
  deltaTimeS: number;
  yaw: number;
  joystickDirection: number | null;
  w: boolean;
  a: boolean;
  s: boolean;
  d: boolean;
  sp: boolean;
  sh: boolean;
  c: boolean;
};

type MovementPacketSentPayload = {
  sequenceNumber: number;
  deltaTimeS: number;
  yaw: number;
  joystickDirection: number | null;
  w: boolean;
  a: boolean;
  s: boolean;
  d: boolean;
  sp: boolean;
  sh: boolean;
  c: boolean;
};

type LocalPredictionControllerState = {
  authoritativeMotionBasisVelocity: Vector3;
  predictedMotionBasisVelocity: Vector3;
  authoritativeFastMovementByDefault: boolean;
  predictedFastMovementByDefault: boolean;
  authoritativeGrounded: boolean;
  predictedGrounded: boolean;
  authoritativeMovementReferenceYaw?: number;
  predictedMovementReferenceYaw?: number;
  authoritativeSwimming: boolean;
  predictedSwimming: boolean;
  authoritativeJustSubmergedRemainingS: number;
  predictedJustSubmergedRemainingS: number;
  authoritativeSwimUpwardCooldownRemainingS: number;
  predictedSwimUpwardCooldownRemainingS: number;
};

type LocalPredictionState = {
  entityId?: number;
  predictedPosition: Vector3;
  predictedRotation: Quaternion;
  authoritativePosition: Vector3;
  authoritativeRotation: Quaternion;
  estimatedVerticalVelocity: number;
  estimatedWalkSpeed: number;
  estimatedRunSpeed: number;
  worldTimestepS: number;
  supportsInputAcknowledgements: boolean;
  lastAcknowledgedHadMovementInput?: boolean;
  lastAcknowledgedMovementRunning?: boolean;
  lastAcknowledgedMovementDirectionX?: number;
  lastAcknowledgedMovementDirectionZ?: number;
  pendingSpeedCalibrationAcknowledgedInputSequenceNumber?: number;
  hasPredictedTransform: boolean;
  hasAuthoritativePosition: boolean;
  hasAuthoritativeRotation: boolean;
  lastAuthoritativePositionServerTick: number;
  lastAuthoritativeRotationServerTick: number;
  controllerState: LocalPredictionControllerState;
  commandBuffer: LocalPredictionCommand[];
  commandBufferHead: number;
  commandBufferCount: number;
  lastAcknowledgedInputSequenceNumber: number;
  preAckReconcileGraceRemainingS: number;
  ackSupportDetectionElapsedS: number;
  shouldBufferCommandsBeforeAck: boolean;
};

export default class EntityManager {
  private _game: Game;
  private _entities: Map<EntityId, Entity | StaticEntity> = new Map();
  private _dynamicEntities: Set<Entity> = new Set();
  private _dynamicEntityList: Entity[] = [];
  private _dynamicEntityListDirty: boolean = false;
  private _inViewDistanceDynamicEntityList: Entity[] = [];
  private _visibleDynamicEntityList: Entity[] = [];
  private _reflectionObjectsInScene: Object3D[] = [];
  private _nearbyReflectionObjects: Object3D[] = [];
  private _outlines: Map<EntityId, OutlineOptions> = new Map();
  private _outlineTargets: OutlineTarget[] = new Array(MAX_OUTLINES).fill(undefined).map(() => { return { object3d: null, options: null }; });
  private _staticEnvironmentEntityManager: StaticEntityManager;
  private _needsLightLevelRefresh: boolean = false;
  private _hasLightLevelVolumeUpdatedOnce: boolean = false;
  private _needsSkyLightRefresh: boolean = false;
  private _localPredictionState: LocalPredictionState = {
    predictedPosition: new Vector3(),
    predictedRotation: new Quaternion(),
    authoritativePosition: new Vector3(),
    authoritativeRotation: new Quaternion(),
    controllerState: {
      authoritativeMotionBasisVelocity: new Vector3(),
      predictedMotionBasisVelocity: new Vector3(),
      authoritativeFastMovementByDefault: false,
      predictedFastMovementByDefault: false,
      authoritativeGrounded: false,
      predictedGrounded: false,
      authoritativeMovementReferenceYaw: undefined,
      predictedMovementReferenceYaw: undefined,
      authoritativeSwimming: false,
      predictedSwimming: false,
      authoritativeJustSubmergedRemainingS: 0,
      predictedJustSubmergedRemainingS: 0,
      authoritativeSwimUpwardCooldownRemainingS: 0,
      predictedSwimUpwardCooldownRemainingS: 0,
    },
    estimatedVerticalVelocity: 0,
    estimatedWalkSpeed: LOCAL_PREDICTION_DEFAULT_WALK_SPEED,
    estimatedRunSpeed: LOCAL_PREDICTION_DEFAULT_RUN_SPEED,
    worldTimestepS: 1 / 60,
    supportsInputAcknowledgements: false,
    lastAcknowledgedHadMovementInput: undefined,
    lastAcknowledgedMovementRunning: undefined,
    lastAcknowledgedMovementDirectionX: undefined,
    lastAcknowledgedMovementDirectionZ: undefined,
    pendingSpeedCalibrationAcknowledgedInputSequenceNumber: undefined,
    hasPredictedTransform: false,
    hasAuthoritativePosition: false,
    hasAuthoritativeRotation: false,
    lastAuthoritativePositionServerTick: 0,
    lastAuthoritativeRotationServerTick: 0,
    commandBuffer: new Array(LOCAL_PREDICTION_COMMAND_BUFFER_SIZE).fill(undefined).map(() => ({
      sequenceNumber: -1,
      deltaTimeS: 0,
      yaw: 0,
      joystickDirection: null,
      w: false,
      a: false,
      s: false,
      d: false,
      sp: false,
      sh: false,
      c: false,
    })),
    commandBufferHead: 0,
    commandBufferCount: 0,
    lastAcknowledgedInputSequenceNumber: -1,
    preAckReconcileGraceRemainingS: 0,
    ackSupportDetectionElapsedS: 0,
    shouldBufferCommandsBeforeAck: true,
  };
  private _shouldSuppressEnvironmentAnimations: boolean;

  public constructor(game: Game) {
    this._game = game;
    this._staticEnvironmentEntityManager = new StaticEntityManager(game);
    this._setupEventListeners();
    this._shouldSuppressEnvironmentAnimations = this._isEnvironmentalAnimationsSuppressed();
  }

  public get game(): Game { return this._game; }
  public get count(): number { return this._entities.size; }
  public get hasOutlines(): boolean { return this._outlines.size > 0; }
  public get hasLightLevelVolumeUpdatedOnce(): boolean { return this._hasLightLevelVolumeUpdatedOnce; }
  public get reflectionObjectsInScene(): Object3D[] {
    const reflectionObjects = this._reflectionObjectsInScene;
    reflectionObjects.length = 0;

    for (let i = 0; i < this._inViewDistanceDynamicEntityList.length; i++) {
      const entity = this._inViewDistanceDynamicEntityList[i];
      if (!entity.attached && entity.entityRoot.parent !== null && entity.entityRoot.visible) {
        reflectionObjects.push(entity.entityRoot);
      }
    }

    const staticMeshes = this._staticEnvironmentEntityManager.instancedMeshesInScene;
    for (let i = 0; i < staticMeshes.length; i++) {
      reflectionObjects.push(staticMeshes[i]);
    }

    return reflectionObjects;
  }

  public getEntity(id: number): Entity | StaticEntity | undefined {
    return this._entities.get(id);
  }

  public getReflectionCandidateObjectsNear(
    worldPosition: { x: number; y: number; z: number },
    maxDistance: number,
  ): Object3D[] {
    const nearbyObjects = this._nearbyReflectionObjects;
    nearbyObjects.length = 0;

    for (let i = 0; i < this._inViewDistanceDynamicEntityList.length; i++) {
      const entity = this._inViewDistanceDynamicEntityList[i];
      if (entity.attached) {
        continue;
      }

      const limit = maxDistance + entity.approximateRadius;
      const dx = entity.position.x - worldPosition.x;
      const dy = entity.position.y - worldPosition.y;
      const dz = entity.position.z - worldPosition.z;
      if (dx * dx + dy * dy + dz * dz <= limit * limit) {
        nearbyObjects.push(entity.entityRoot);
      }
    }

    const staticMeshes = this._staticEnvironmentEntityManager.getReflectionCandidateMeshesNear(worldPosition, maxDistance);
    for (let i = 0; i < staticMeshes.length; i++) {
      nearbyObjects.push(staticMeshes[i]);
    }

    return nearbyObjects;
  }

  // TODO: O(1) operation
  public findEntityByName(name: string): Entity | StaticEntity | undefined {
    for (const entity of this._entities.values()) {
      if (entity.name === name) {
        return entity;
      }
    }
    return undefined;
  }

  public setOutline(entityId: EntityId, options: Partial<OutlineOptions>): void {
    const entity = this._entities.get(entityId);
    if (!entity) {
      console.warn(`EntityManager.setOutline(): Entity ${entityId} not found.`);
      return;
    }
    this._outlines.set(entityId, {
      color: options.color?.clone() ?? DEFAULT_OUTLINE_OPTIONS.color.clone(),
      colorIntensity: options.colorIntensity ?? DEFAULT_OUTLINE_OPTIONS.colorIntensity,
      thickness: options.thickness ?? DEFAULT_OUTLINE_OPTIONS.thickness,
      opacity: options.opacity ?? DEFAULT_OUTLINE_OPTIONS.opacity,
      occluded: options.occluded ?? DEFAULT_OUTLINE_OPTIONS.occluded,
    });
  }

  public removeOutline(entityId: EntityId): void {
    this._outlines.delete(entityId);
  }

  public getOutlineTargets(): OutlineTarget[] {
    let index = 0;

    for (const [entityId, options] of this._outlines) {
      if (index >= MAX_OUTLINES) {
        console.warn(`EntityManager.getOutlineTargets(): Maximum outline count (${MAX_OUTLINES}) exceeded`);
        break;
      }

      const entity = this._entities.get(entityId);
      if (!entity || !entity.visible) continue;

      const target = this._outlineTargets[index];
      target.object3d = entity.entityRoot;
      target.options = options;
      index++;
    }

    return this._outlineTargets;
  }

  public clearOutlineTargets(): void {
    for (let i = 0; i < MAX_OUTLINES; i++) {
      this._outlineTargets[i].object3d = null;
      this._outlineTargets[i].options = null;
    }
  }

  private _setupEventListeners(): void {
    EventRouter.instance.on(
      RendererEventType.Animate,
      this._onAnimate,
    );

    EventRouter.instance.on(
      NetworkManagerEventType.EntitiesPacket,
      this._onEntitiesPacket,
    );

    EventRouter.instance.on(
      INPUT_MANAGER_MOVEMENT_PACKET_SENT_EVENT,
      this._onMovementPacketSent as unknown as () => void,
    );

    EventRouter.instance.on(
      NetworkManagerEventType.WorldPacket,
      this._onWorldPacket,
    );

    EventRouter.instance.on(
      WorkerEventType.BlockEntityBuilt,
      this._onBlockEntityBuilt,
    );

    EventRouter.instance.on(
      WorkerEventType.LightLevelVolumeBuilt,
      this._onLightLevelVolumeBuilt,
    );

    EventRouter.instance.on(
      WorkerEventType.SkyDistanceVolumeBuilt,
      this._onSkyDistanceVolumeBuilt,
    );

    EventRouter.instance.on(
      ClientSettingsEventType.Update,
      this._onQualitySettingsUpdate,
    );
  }

  private _getDynamicEntityList(): Entity[] {
    if (!this._dynamicEntityListDirty) {
      return this._dynamicEntityList;
    }

    this._dynamicEntityList.length = 0;
    for (const entity of this._dynamicEntities) {
      this._dynamicEntityList.push(entity);
    }
    this._dynamicEntityListDirty = false;

    return this._dynamicEntityList;
  }

  private _onAnimate = (payload: RendererEventPayload.IAnimate): void => {
    EntityStats.reset();
    EntityStats.count = this._entities.size;
    this._updateLocalPredictionEntityBinding();
    const dynamicEntities = this._getDynamicEntityList();
    const inViewDistanceDynamicEntities = this._inViewDistanceDynamicEntityList;
    const visibleDynamicEntities = this._visibleDynamicEntityList;
    inViewDistanceDynamicEntities.length = 0;
    visibleDynamicEntities.length = 0;

    // Entities are updated using a multi-pass approach.

    // First pass: Update local position and rotation
    for (let i = 0; i < dynamicEntities.length; i++) {
      const entity = dynamicEntities[i];
      entity.update(payload.frameDeltaS);
      entity.accumulateAnimationTime(payload.frameDeltaS);

      if (this._localPredictionState.entityId === entity.id) {
        this._applyLocalPrediction(entity, payload.frameDeltaS);
      }
    }

    // Second pass: Apply view distance. 
    // To avoid subsequent updates for invisible entities, perform an early check
    // using the updated local position.
    if (this._game.settingsManager.qualityPerfTradeoff.viewDistance.enabled) {
      // View Distance handling. Also refer to the comment in ChunkManager
      const viewDistance = this._game.renderer.viewDistance;
      const viewDistanceSquared = viewDistance * viewDistance;
      const cameraPos = this._game.camera.activeCamera.position;

      fromVec2.set(cameraPos.x, cameraPos.z);
      for (let i = 0; i < dynamicEntities.length; i++) {
        const entity = dynamicEntities[i];
        if (entity.applyViewDistance(viewDistanceSquared, fromVec2)) {
          inViewDistanceDynamicEntities.push(entity);
        }
      }
    } else {
      // If ViewDistance can be toggled dynamically in the future, we need to
      // make everything visible at the moment it switches to enabled.
      EntityStats.inViewDistanceCount = this._entities.size;
      for (let i = 0; i < dynamicEntities.length; i++) {
        inViewDistanceDynamicEntities.push(dynamicEntities[i]);
      }
    }

    // Third pass: Apply frustum culling
    const camera = this._game.camera.activeCamera;
    frustum.setFromProjectionMatrix(projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));

    for (let i = 0; i < inViewDistanceDynamicEntities.length; i++) {
      const entity = inViewDistanceDynamicEntities[i];
      if (entity.applyFrustumCulling(frustum)) {
        entity.applyShadowCasterLod();
        visibleDynamicEntities.push(entity);
      }
    }

    // Forth pass: Update Animation and Local matrix
    const frameCount = this._game.performanceMetricsManager.frameCount;
    for (let i = 0; i < visibleDynamicEntities.length; i++) {
      visibleDynamicEntities[i].updateAnimationAndLocalMatrix(payload.frameDeltaS, frameCount);
    }

    // Fifth pass: World matrices update.
    // Considering parent-child relationships, the WorldMatrix must be updated only
    // after the LocalMatrix of all entities has been updated.
    for (let i = 0; i < visibleDynamicEntities.length; i++) {
      visibleDynamicEntities[i].updateWorldMatrices(this._hasLightLevelVolumeUpdatedOnce);
    }

    this._staticEnvironmentEntityManager.updateShadowCasterLod();

    // Sixth pass: Light level update
    // LightLevel is only needed when a Light Emission Block is placed. However, in most maps, Light Emission
    // Blocks are probably not placed at all. Therefore, detects whether a Light Level Volume has ever been
    // generated by a Light Emission Block is placed, and only then perform Light Level update processing.
    if (this._hasLightLevelVolumeUpdatedOnce) {
      const lightLevelEntities = this._needsLightLevelRefresh ? dynamicEntities : visibleDynamicEntities;
      for (let i = 0; i < lightLevelEntities.length; i++) {
        lightLevelEntities[i].updateLightLevel(this._needsLightLevelRefresh);
      }
      if (this._needsLightLevelRefresh) {
        this._staticEnvironmentEntityManager.updateLightLevel();
      }
      this._needsLightLevelRefresh = false;
    }

    // Seventh pass: Sky light update
    // Sky light is always available and doesn't depend on light emission blocks
    const skyLightEntities = this._needsSkyLightRefresh ? dynamicEntities : visibleDynamicEntities;
    for (let i = 0; i < skyLightEntities.length; i++) {
      skyLightEntities[i].updateSkyLight(this._needsSkyLightRefresh, payload.frameDeltaS);
    }
    if (this._needsSkyLightRefresh) {
      this._staticEnvironmentEntityManager.updateSkyLight();
    }
    this._needsSkyLightRefresh = false;

    this._syncLocalPredictionStats();
  }

  private _onEntitiesPacket = (payload: NetworkManagerEventPayload.IEntitiesPacket): void => {
    for (const deserializedEntity of payload.deserializedEntities) {
      this._updateEntity(deserializedEntity, payload.serverTick);
    }
  }

  private _onWorldPacket = (payload: NetworkManagerEventPayload.IWorldPacket): void => {
    const timestep = payload.deserializedWorld.timestep;
    if (typeof timestep !== 'number' || !Number.isFinite(timestep) || timestep <= 0) {
      return;
    }

    this._localPredictionState.worldTimestepS = Math.min(Math.max(timestep, 1 / 240), 1);
  }

  private _updateEntity = (deserializedEntity: DeserializedEntity, serverTick: number): void => {
    let entity = this._entities.get(deserializedEntity.id);
    if (!entity) {
      if (
        deserializedEntity.id === undefined ||
        deserializedEntity.position === undefined ||
        deserializedEntity.rotation === undefined ||
        (!deserializedEntity.blockTextureUri && !deserializedEntity.modelUri)
      ) {
        return console.info(`EntityManager._onEntityCreateUpdate(): Entity ${deserializedEntity.id} not yet created, this can be safely ignored if no gameplay bugs are experienced.`, deserializedEntity);
      }

      const entityData = {
        id: deserializedEntity.id,
        blockTextureUri: deserializedEntity.blockTextureUri,
        blockHalfExtents: deserializedEntity.blockHalfExtents,
        emissiveColor: deserializedEntity.emissiveColor,
        emissiveIntensity: deserializedEntity.emissiveIntensity,
        isEnvironmental: deserializedEntity.isEnvironmental,
        modelAnimations: deserializedEntity.modelAnimations,
        modelNodeOverrides: deserializedEntity.modelNodeOverrides,
        modelTextureUri: deserializedEntity.modelTextureUri,
        modelUri: deserializedEntity.modelUri,
        name: deserializedEntity.name || '',
        opacity: deserializedEntity.opacity,
        parentEntityId: deserializedEntity.parentEntityId,
        parentNodeName: deserializedEntity.parentNodeName,
        position: new Vector3(deserializedEntity.position.x, deserializedEntity.position.y, deserializedEntity.position.z),
        positionInterpolationMs: deserializedEntity.positionInterpolationMs,
        rotation: new Quaternion(deserializedEntity.rotation.x, deserializedEntity.rotation.y, deserializedEntity.rotation.z, deserializedEntity.rotation.w),
        rotationInterpolationMs: deserializedEntity.rotationInterpolationMs,
        scale: deserializedEntity.scale,
        scaleInterpolationMs: deserializedEntity.scaleInterpolationMs,
        tintColor: deserializedEntity.tintColor,
      };

      // Check if this should be a Static Environment Entity.
      // Static Environment Entities are processed through a special path with lower CPU cost.
      // TODO: Under the current specification, game creators have no way to directly access or
      // manipulate EnvironmentEntity, so it seems safe to check from the entity creation data
      // whether it can become a Static Environment Entity. However, in the future, there
      // may be a way to access Environment Entities, and in that case, it will likely be
      // necessary to introduce an explicit flag indicating whether it is static.
      if (deserializedEntity.isEnvironmental === true
        && deserializedEntity.modelUri !== undefined
        && !deserializedEntity.blockTextureUri
        && !deserializedEntity.parentEntityId
        && !deserializedEntity.parentNodeName
        && !deserializedEntity.modelAnimations?.length
        && !deserializedEntity.modelNodeOverrides?.length
        && !deserializedEntity.modelTextureUri
        && (deserializedEntity.opacity === undefined || deserializedEntity.opacity === 1.0)
      ) {
        entity = new StaticEntity(this._game, entityData);
        this._staticEnvironmentEntityManager.add(entity as StaticEntity);
      } else {
        const shouldSuppressAnimations = deserializedEntity.isEnvironmental ? this._shouldSuppressEnvironmentAnimations : false;
        entity = new Entity(this._game, entityData, shouldSuppressAnimations);
        this._dynamicEntities.add(entity);
        this._dynamicEntityListDirty = true;
      }

      this._entities.set(entity.id, entity);

      // Since the geometry for Block Entities depends on the Block Texture Atlas and other factors,
      // it needs to be constructed in the WebWorker just like Chunk Blocks Mesh. Therefore, a request
      // is sent to the WebWorker.
      if (entity.isBlockEntity) {
        entity.setCustomTexture(entity.blockTextureUri!);
      }

      // Apply initial outline if present at spawn
      if (deserializedEntity.outline) {
        this.setOutline(deserializedEntity.id, deserializedEntity.outline);
      }
    } else {
      if (deserializedEntity.removed) {
        if ((entity instanceof StaticEntity)) {
          throw new Error(`EntityManager: Static Environment Entity must not be removed. ${entity.id}`);
        }

        if (this._localPredictionState.entityId === entity.id) {
          this._resetLocalPredictionState();
        }

        entity.release();
        this._entities.delete(entity.id);
        if (entity instanceof Entity && this._dynamicEntities.delete(entity)) {
          this._dynamicEntityListDirty = true;
        }
        this._outlines.delete(entity.id);
        return;
      }

      if (entity.isBlockEntity && deserializedEntity.blockTextureUri !== undefined) {
        entity.setCustomTexture(deserializedEntity.blockTextureUri);
      }

      if (deserializedEntity.emissiveColor !== undefined) {
        entity.setEmissiveColor(deserializedEntity.emissiveColor);
      }

      if (deserializedEntity.emissiveIntensity !== undefined) {
        entity.setEmissiveIntensity(deserializedEntity.emissiveIntensity);
      }

      if (deserializedEntity.modelAnimations) {
        entity.setModelAnimations(deserializedEntity.modelAnimations);
      }

      if (deserializedEntity.modelNodeOverrides) {
        entity.setModelNodeOverrides(deserializedEntity.modelNodeOverrides);
      }

      if (!entity.isBlockEntity && deserializedEntity.modelTextureUri) {
        entity.setCustomTexture(deserializedEntity.modelTextureUri);
      }

      if (deserializedEntity.modelUri) {
        entity.setModelUri(deserializedEntity.modelUri);
      }

      if (deserializedEntity.name) {
        entity.setName(deserializedEntity.name);
      }

      if (typeof deserializedEntity.opacity === 'number') {
        entity.setOpacity(deserializedEntity.opacity);
      }

      if (deserializedEntity.parentEntityId !== undefined) {
        entity.setParentEntityId(deserializedEntity.parentEntityId);
      }

      if (deserializedEntity.parentNodeName !== undefined) {
        entity.setParentNodeName(deserializedEntity.parentNodeName);
      }

      if (deserializedEntity.positionInterpolationMs !== undefined) {
        entity.setPositionInterpolationMs(deserializedEntity.positionInterpolationMs);
      }

      if (deserializedEntity.rotationInterpolationMs !== undefined) {
        entity.setRotationInterpolationMs(deserializedEntity.rotationInterpolationMs);
      }

      if (deserializedEntity.scaleInterpolationMs !== undefined) {
        entity.setScaleInterpolationMs(deserializedEntity.scaleInterpolationMs);
      }

      const shouldInterpolateTransform =
        deserializedEntity.parentEntityId === undefined &&
        deserializedEntity.parentNodeName === undefined;
      const hasLocalPredictionSupport = this._hasLocalPredictionSupport(deserializedEntity);

      if (entity instanceof Entity && hasLocalPredictionSupport) {
        this._bindLocalPredictionToEntity(entity);
      } else if (
        entity instanceof Entity &&
        this._localPredictionState.entityId === entity.id &&
        deserializedEntity.acknowledgedInputSequenceNumber !== undefined
      ) {
        this._resetLocalPredictionState();
      }

      const shouldUseLocalPrediction =
        entity instanceof Entity &&
        this._localPredictionState.entityId === entity.id &&
        !entity.attached &&
        entity.parentEntityId == null &&
        entity.parentNodeName == null;
      let receivedAuthoritativePredictedTransformUpdate = false;
      let acknowledgedLocalPredictionInput = false;

      if (shouldUseLocalPrediction && hasLocalPredictionSupport) {
        this._setLocalAuthoritativeControllerState(deserializedEntity);
      }

      if (deserializedEntity.position) {
        if (shouldUseLocalPrediction) {
          this._setLocalAuthoritativePosition(deserializedEntity.position, serverTick);
          receivedAuthoritativePredictedTransformUpdate = true;
        } else {
          // do not interpolate if we are also attaching or detaching to/from a parent
          entity.setPosition(
            deserializedEntity.position,
            shouldInterpolateTransform,
            serverTick,
          );
        }
      }

      if (deserializedEntity.rotation) {
        if (shouldUseLocalPrediction) {
          this._setLocalAuthoritativeRotation(deserializedEntity.rotation, serverTick);
          receivedAuthoritativePredictedTransformUpdate = true;
        } else {
          // do not interpolate if we are also attaching or detaching to/from a parent
          entity.setRotation(
            deserializedEntity.rotation,
            shouldInterpolateTransform,
            serverTick,
          );
        }
      }

      if (shouldUseLocalPrediction && deserializedEntity.acknowledgedInputSequenceNumber !== undefined) {
        const previousAcknowledgedInputSequenceNumber = this._localPredictionState.lastAcknowledgedInputSequenceNumber;
        const previousSupportsInputAcknowledgements = this._localPredictionState.supportsInputAcknowledgements;
        this._setLocalAcknowledgedInputSequenceNumber(deserializedEntity.acknowledgedInputSequenceNumber);
        acknowledgedLocalPredictionInput =
          this._localPredictionState.supportsInputAcknowledgements && (
            !previousSupportsInputAcknowledgements ||
            this._localPredictionState.lastAcknowledgedInputSequenceNumber !== previousAcknowledgedInputSequenceNumber
          );
      }

      if (
        shouldUseLocalPrediction &&
        this._shouldRebuildPredictedStateAfterServerUpdate(
          receivedAuthoritativePredictedTransformUpdate,
          acknowledgedLocalPredictionInput,
        )
      ) {
        this._rebuildPredictedStateFromAuthoritativeAndReplay();
      }

      if (deserializedEntity.scale) {
        entity.setScale(deserializedEntity.scale);
      }

      if (deserializedEntity.tintColor !== undefined) {
        entity.setTintColor(deserializedEntity.tintColor);
      }

      if (deserializedEntity.outline !== undefined) {
        if (deserializedEntity.outline) {
          this.setOutline(deserializedEntity.id, deserializedEntity.outline);
        } else {
          this.removeOutline(deserializedEntity.id);
        }
      }
    }
  }

  private _updateLocalPredictionEntityBinding(): void {
    const entityId = this._localPredictionState.entityId;

    if (entityId === undefined) {
      return;
    }

    const entity = this._entities.get(entityId);
    if (
      !entity ||
      entity instanceof StaticEntity ||
      entity.attached ||
      entity.parentEntityId != null ||
      entity.parentNodeName != null
    ) {
      this._resetLocalPredictionState();
    }
  }

  private _resetLocalPredictionState(nextEntityId?: number): void {
    LocalPredictionStats.reset();
    this._localPredictionState.entityId = nextEntityId;
    this._localPredictionState.estimatedVerticalVelocity = 0;
    this._localPredictionState.estimatedWalkSpeed = LOCAL_PREDICTION_DEFAULT_WALK_SPEED;
    this._localPredictionState.estimatedRunSpeed = LOCAL_PREDICTION_DEFAULT_RUN_SPEED;
    this._localPredictionState.supportsInputAcknowledgements = false;
    this._localPredictionState.lastAcknowledgedHadMovementInput = undefined;
    this._localPredictionState.lastAcknowledgedMovementRunning = undefined;
    this._localPredictionState.lastAcknowledgedMovementDirectionX = undefined;
    this._localPredictionState.lastAcknowledgedMovementDirectionZ = undefined;
    this._localPredictionState.pendingSpeedCalibrationAcknowledgedInputSequenceNumber = undefined;
    this._localPredictionState.hasPredictedTransform = false;
    this._localPredictionState.hasAuthoritativePosition = false;
    this._localPredictionState.hasAuthoritativeRotation = false;
    this._localPredictionState.lastAuthoritativePositionServerTick = 0;
    this._localPredictionState.lastAuthoritativeRotationServerTick = 0;
    this._localPredictionState.controllerState.authoritativeMotionBasisVelocity.set(0, 0, 0);
    this._localPredictionState.controllerState.predictedMotionBasisVelocity.set(0, 0, 0);
    this._localPredictionState.controllerState.authoritativeFastMovementByDefault = false;
    this._localPredictionState.controllerState.predictedFastMovementByDefault = false;
    this._localPredictionState.controllerState.authoritativeGrounded = false;
    this._localPredictionState.controllerState.predictedGrounded = false;
    this._localPredictionState.controllerState.authoritativeMovementReferenceYaw = undefined;
    this._localPredictionState.controllerState.predictedMovementReferenceYaw = undefined;
    this._localPredictionState.controllerState.authoritativeSwimming = false;
    this._localPredictionState.controllerState.predictedSwimming = false;
    this._localPredictionState.controllerState.authoritativeJustSubmergedRemainingS = 0;
    this._localPredictionState.controllerState.predictedJustSubmergedRemainingS = 0;
    this._localPredictionState.controllerState.authoritativeSwimUpwardCooldownRemainingS = 0;
    this._localPredictionState.controllerState.predictedSwimUpwardCooldownRemainingS = 0;
    this._localPredictionState.commandBufferHead = 0;
    this._localPredictionState.commandBufferCount = 0;
    this._localPredictionState.lastAcknowledgedInputSequenceNumber = -1;
    this._localPredictionState.preAckReconcileGraceRemainingS = 0;
    this._localPredictionState.ackSupportDetectionElapsedS = 0;
    this._localPredictionState.shouldBufferCommandsBeforeAck = true;
    this._syncLocalPredictionStats();
  }

  private _bindLocalPredictionToEntity(entity: Entity): void {
    const isFirstOwnedBinding = this._localPredictionState.entityId === undefined;
    let bindingChanged = false;

    if (this._localPredictionState.entityId !== entity.id) {
      if (!isFirstOwnedBinding) {
        this._resetLocalPredictionState(entity.id);
      } else {
        this._localPredictionState.entityId = entity.id;
        this._localPredictionState.hasPredictedTransform = false;
        this._localPredictionState.hasAuthoritativePosition = false;
        this._localPredictionState.hasAuthoritativeRotation = false;
        this._localPredictionState.lastAuthoritativePositionServerTick = 0;
        this._localPredictionState.lastAuthoritativeRotationServerTick = 0;
      }

      bindingChanged = true;
    }

    if (
      !bindingChanged &&
      this._localPredictionState.hasPredictedTransform &&
      this._localPredictionState.hasAuthoritativePosition &&
      this._localPredictionState.hasAuthoritativeRotation
    ) {
      return;
    }

    this._localPredictionState.predictedPosition.copy(entity.position);
    this._localPredictionState.predictedRotation.copy(entity.rotation);
    this._localPredictionState.authoritativePosition.copy(entity.position);
    this._localPredictionState.authoritativeRotation.copy(entity.rotation);
    this._localPredictionState.hasPredictedTransform = true;
    this._localPredictionState.hasAuthoritativePosition = true;
    this._localPredictionState.hasAuthoritativeRotation = true;
    this._syncLocalPredictionStats();
  }

  private _hasLocalPredictionSupport(deserializedEntity: DeserializedEntity): boolean {
    return (
      deserializedEntity.localPredictionFastMovementByDefault !== undefined ||
      deserializedEntity.localPredictionFlags !== undefined ||
      deserializedEntity.localPredictionMotionBasisVelocity !== undefined ||
      deserializedEntity.localPredictionJustSubmergedRemainingMs !== undefined ||
      deserializedEntity.localPredictionMovementReferenceYaw !== undefined ||
      deserializedEntity.localPredictionSwimUpwardCooldownRemainingMs !== undefined
    );
  }

  private _setLocalAuthoritativeControllerState(deserializedEntity: DeserializedEntity): void {
    const controllerState = this._localPredictionState.controllerState;
    const predictionFlags = deserializedEntity.localPredictionFlags ?? 0;
    controllerState.authoritativeFastMovementByDefault = !!deserializedEntity.localPredictionFastMovementByDefault;
    controllerState.authoritativeGrounded = (predictionFlags & LOCAL_PREDICTION_FLAG_GROUNDED) !== 0;
    controllerState.authoritativeMovementReferenceYaw =
      Number.isFinite(deserializedEntity.localPredictionMovementReferenceYaw)
        ? Number(deserializedEntity.localPredictionMovementReferenceYaw)
        : undefined;
    controllerState.authoritativeSwimming = (predictionFlags & LOCAL_PREDICTION_FLAG_SWIMMING) !== 0;
    controllerState.authoritativeMotionBasisVelocity.set(
      deserializedEntity.localPredictionMotionBasisVelocity?.x ?? 0,
      deserializedEntity.localPredictionMotionBasisVelocity?.y ?? 0,
      deserializedEntity.localPredictionMotionBasisVelocity?.z ?? 0,
    );
    controllerState.authoritativeJustSubmergedRemainingS = Math.max(
      0,
      (deserializedEntity.localPredictionJustSubmergedRemainingMs ?? 0) / 1000,
    );
    controllerState.authoritativeSwimUpwardCooldownRemainingS = Math.max(
      0,
      (deserializedEntity.localPredictionSwimUpwardCooldownRemainingMs ?? 0) / 1000,
    );
  }

  private _setLocalAuthoritativePosition(position: { x: number; y: number; z: number }, serverTick: number): void {
    if (serverTick <= this._localPredictionState.lastAuthoritativePositionServerTick) {
      return;
    }

    const previousPositionServerTick = this._localPredictionState.lastAuthoritativePositionServerTick;
    const previousAuthoritativePositionX = this._localPredictionState.authoritativePosition.x;
    const previousAuthoritativePositionY = this._localPredictionState.authoritativePosition.y;
    const previousAuthoritativePositionZ = this._localPredictionState.authoritativePosition.z;
    const hadPreviousAuthoritativePosition = this._localPredictionState.hasAuthoritativePosition;

    this._localPredictionState.lastAuthoritativePositionServerTick = serverTick;
    this._localPredictionState.authoritativePosition.copy(position);
    this._localPredictionState.hasAuthoritativePosition = true;

    if (hadPreviousAuthoritativePosition) {
      const sampledTickDelta = serverTick - previousPositionServerTick;
      const sampledDeltaTimeS = sampledTickDelta * this._localPredictionState.worldTimestepS;

      if (sampledDeltaTimeS > 0) {
        const dx = position.x - previousAuthoritativePositionX;
        const dy = position.y - previousAuthoritativePositionY;
        const dz = position.z - previousAuthoritativePositionZ;
        const sampledHorizontalSpeed = Math.sqrt((dx * dx) + (dz * dz)) / sampledDeltaTimeS;
        const sampledVerticalVelocity = dy / sampledDeltaTimeS;
        // Only let walk/run speed adapt from the first position delta after a newly
        // acknowledged movement command. This avoids learning platform/impulse motion.
        const calibrationAcknowledgedInputSequenceNumber =
          this._localPredictionState.pendingSpeedCalibrationAcknowledgedInputSequenceNumber;
        this._localPredictionState.pendingSpeedCalibrationAcknowledgedInputSequenceNumber = undefined;

        this._updateLocalPredictionVerticalVelocityEstimate(sampledVerticalVelocity);

        this._updateLocalPredictionSpeedEstimate(
          sampledHorizontalSpeed,
          dx,
          dy,
          dz,
          calibrationAcknowledgedInputSequenceNumber,
        );
      }
    }

    if (!this._localPredictionState.hasPredictedTransform) {
      this._localPredictionState.predictedPosition.copy(position);
      this._localPredictionState.hasPredictedTransform = true;
    }
  }

  private _setLocalAuthoritativeRotation(rotation: { x: number; y: number; z: number; w: number }, serverTick: number): void {
    if (serverTick <= this._localPredictionState.lastAuthoritativeRotationServerTick) {
      return;
    }

    this._localPredictionState.lastAuthoritativeRotationServerTick = serverTick;
    this._localPredictionState.authoritativeRotation.copy(rotation);
    this._localPredictionState.hasAuthoritativeRotation = true;

    if (!this._localPredictionState.hasPredictedTransform) {
      this._localPredictionState.predictedRotation.copy(rotation);
      this._localPredictionState.hasPredictedTransform = true;
    }
  }

  private _setLocalAcknowledgedInputSequenceNumber(acknowledgedInputSequenceNumber: number): void {
    this._localPredictionState.supportsInputAcknowledgements = true;
    this._localPredictionState.shouldBufferCommandsBeforeAck = true;
    this._localPredictionState.ackSupportDetectionElapsedS = 0;
    this._localPredictionState.preAckReconcileGraceRemainingS = 0;

    if (acknowledgedInputSequenceNumber <= this._localPredictionState.lastAcknowledgedInputSequenceNumber) {
      return;
    }

    this._localPredictionState.lastAcknowledgedInputSequenceNumber = acknowledgedInputSequenceNumber;
    const lastAcknowledgedCommand = this._dropAcknowledgedPredictionCommands(acknowledgedInputSequenceNumber);
    this._localPredictionState.lastAcknowledgedHadMovementInput =
      !!lastAcknowledgedCommand && (
        lastAcknowledgedCommand.w ||
        lastAcknowledgedCommand.a ||
        lastAcknowledgedCommand.s ||
        lastAcknowledgedCommand.d ||
        typeof lastAcknowledgedCommand.joystickDirection === 'number'
      );
    this._localPredictionState.lastAcknowledgedMovementRunning = lastAcknowledgedCommand?.sh;
    this._setLastAcknowledgedMovementDirection(lastAcknowledgedCommand);
    const hasAcknowledgedMovementDirection =
      this._localPredictionState.lastAcknowledgedMovementDirectionX !== undefined &&
      this._localPredictionState.lastAcknowledgedMovementDirectionZ !== undefined;
    this._localPredictionState.pendingSpeedCalibrationAcknowledgedInputSequenceNumber =
      this._localPredictionState.lastAcknowledgedHadMovementInput && hasAcknowledgedMovementDirection
        ? acknowledgedInputSequenceNumber
        : undefined;
  }

  private _shouldRebuildPredictedStateAfterServerUpdate(
    receivedAuthoritativeTransformUpdate: boolean,
    acknowledgedInputUpdate: boolean,
  ): boolean {
    if (!receivedAuthoritativeTransformUpdate && !acknowledgedInputUpdate) {
      return false;
    }

    if (acknowledgedInputUpdate) {
      return this._localPredictionState.hasAuthoritativePosition || this._localPredictionState.hasAuthoritativeRotation;
    }

    return (
      this._localPredictionState.supportsInputAcknowledgements &&
      this._localPredictionState.commandBufferCount > 0
    );
  }

  private _dropAcknowledgedPredictionCommands(acknowledgedInputSequenceNumber: number): LocalPredictionCommand | undefined {
    let lastDroppedCommand: LocalPredictionCommand | undefined;

    while (this._localPredictionState.commandBufferCount > 0) {
      const command = this._localPredictionState.commandBuffer[this._localPredictionState.commandBufferHead];
      if (command.sequenceNumber > acknowledgedInputSequenceNumber) {
        break;
      }

      this._localPredictionState.commandBufferHead =
        (this._localPredictionState.commandBufferHead + 1) % LOCAL_PREDICTION_COMMAND_BUFFER_SIZE;
      this._localPredictionState.commandBufferCount--;
      lastDroppedCommand = command;
    }

    return lastDroppedCommand;
  }

  private _rebuildPredictedStateFromAuthoritativeAndReplay(): void {
    if (!this._localPredictionState.hasAuthoritativePosition && !this._localPredictionState.hasAuthoritativeRotation) {
      return;
    }

    if (this._localPredictionState.hasAuthoritativePosition) {
      this._localPredictionState.predictedPosition.copy(this._localPredictionState.authoritativePosition);
    }

    if (this._localPredictionState.hasAuthoritativeRotation) {
      this._localPredictionState.predictedRotation.copy(this._localPredictionState.authoritativeRotation);
    }

    this._localPredictionState.controllerState.predictedMotionBasisVelocity.copy(
      this._localPredictionState.controllerState.authoritativeMotionBasisVelocity,
    );
    this._localPredictionState.controllerState.predictedFastMovementByDefault =
      this._localPredictionState.controllerState.authoritativeFastMovementByDefault;
    this._localPredictionState.controllerState.predictedGrounded =
      this._localPredictionState.controllerState.authoritativeGrounded;
    this._localPredictionState.controllerState.predictedMovementReferenceYaw =
      this._localPredictionState.controllerState.authoritativeMovementReferenceYaw;
    this._localPredictionState.controllerState.predictedSwimming =
      this._localPredictionState.controllerState.authoritativeSwimming;
    this._localPredictionState.controllerState.predictedJustSubmergedRemainingS =
      this._localPredictionState.controllerState.authoritativeJustSubmergedRemainingS;
    this._localPredictionState.controllerState.predictedSwimUpwardCooldownRemainingS =
      this._localPredictionState.controllerState.authoritativeSwimUpwardCooldownRemainingS;

    let replayedCommandCount = 0;
    let replayedSubstepCount = 0;

    for (let i = 0; i < this._localPredictionState.commandBufferCount; i++) {
      const command = this._localPredictionState.commandBuffer[
        (this._localPredictionState.commandBufferHead + i) % LOCAL_PREDICTION_COMMAND_BUFFER_SIZE
      ];

      replayedSubstepCount += this._replayPredictedCommand(command);
      replayedCommandCount++;
    }

    this._syncLocalPredictionStats(replayedCommandCount, replayedSubstepCount);
  }

  private _replayPredictedCommand(command: LocalPredictionCommand): number {
    let remainingDeltaS = Math.min(
      Math.max(command.deltaTimeS, 0),
      LOCAL_PREDICTION_REPLAY_COMMAND_MAX_DELTA_S,
    );
    let substeps = 0;

    while (remainingDeltaS > 0 && substeps < LOCAL_PREDICTION_REPLAY_MAX_SUBSTEPS_PER_COMMAND) {
      const stepDeltaS = Math.min(LOCAL_PREDICTION_SUBSTEP_DELTA_S, remainingDeltaS);

      this._stepPredictedMovement(
        stepDeltaS,
        command.yaw,
        command.joystickDirection,
        command.w,
        command.a,
        command.s,
        command.d,
        command.sp,
        command.sh,
        command.c,
      );

      remainingDeltaS -= stepDeltaS;
      substeps++;
    }

    return substeps;
  }

  private _onMovementPacketSent = (payload: MovementPacketSentPayload): void => {
    if (
      !this._localPredictionState.supportsInputAcknowledgements &&
      !this._localPredictionState.shouldBufferCommandsBeforeAck
    ) {
      return;
    }

    if (payload.sequenceNumber <= this._localPredictionState.lastAcknowledgedInputSequenceNumber) {
      return;
    }

    const bufferWriteIndex =
      (this._localPredictionState.commandBufferHead + this._localPredictionState.commandBufferCount)
      % LOCAL_PREDICTION_COMMAND_BUFFER_SIZE;

    if (this._localPredictionState.commandBufferCount === LOCAL_PREDICTION_COMMAND_BUFFER_SIZE) {
      this._localPredictionState.commandBufferHead =
        (this._localPredictionState.commandBufferHead + 1) % LOCAL_PREDICTION_COMMAND_BUFFER_SIZE;
      this._localPredictionState.commandBufferCount--;
    }

    const command = this._localPredictionState.commandBuffer[bufferWriteIndex];
    command.sequenceNumber = payload.sequenceNumber;
    command.deltaTimeS = payload.deltaTimeS;
    command.yaw = payload.yaw;
    command.joystickDirection = payload.joystickDirection;
    command.w = payload.w;
    command.a = payload.a;
    command.s = payload.s;
    command.d = payload.d;
    command.sp = payload.sp;
    command.sh = payload.sh;
    command.c = payload.c;

    this._localPredictionState.commandBufferCount++;

    if (!this._localPredictionState.supportsInputAcknowledgements) {
      this._localPredictionState.preAckReconcileGraceRemainingS = LOCAL_PREDICTION_PRE_ACK_RECONCILE_GRACE_S;
      this._localPredictionState.ackSupportDetectionElapsedS += payload.deltaTimeS;

      if (this._localPredictionState.ackSupportDetectionElapsedS >= LOCAL_PREDICTION_ACK_SUPPORT_DETECTION_TIMEOUT_S) {
        this._localPredictionState.shouldBufferCommandsBeforeAck = false;
        this._localPredictionState.commandBufferHead = 0;
        this._localPredictionState.commandBufferCount = 0;
        this._localPredictionState.preAckReconcileGraceRemainingS = 0;
      }
    }
  }

  private _applyLocalPrediction(entity: Entity, deltaTimeS: number): void {
    if (
      entity.attached ||
      entity.parentEntityId != null ||
      entity.parentNodeName != null
    ) {
      return;
    }

    if (!this._localPredictionState.hasPredictedTransform) {
      this._localPredictionState.predictedPosition.copy(entity.position);
      this._localPredictionState.predictedRotation.copy(entity.rotation);
      this._localPredictionState.hasPredictedTransform = true;
    }

    const clampedDeltaS = Math.min(deltaTimeS, LOCAL_PREDICTION_MAX_FRAME_DELTA_S);
    const inputState = this._game.inputManager.inputState;
    const hasLocalMovementIntent =
      !!inputState.w ||
      !!inputState.a ||
      !!inputState.s ||
      !!inputState.d ||
      !!inputState.sp ||
      !!inputState.c ||
      this._game.inputManager.joystickDirection !== null;
    let isActivelyMoving = false;
    let remainingDeltaS = clampedDeltaS;
    let substeps = 0;

    while (remainingDeltaS > 0 && substeps < LOCAL_PREDICTION_MAX_SUBSTEPS) {
      const stepDeltaS = Math.min(LOCAL_PREDICTION_SUBSTEP_DELTA_S, remainingDeltaS);

      isActivelyMoving = this._stepPredictedMovement(
        stepDeltaS,
        this._game.camera.gameCameraYaw,
        this._game.inputManager.joystickDirection,
        !!inputState.w,
        !!inputState.a,
        !!inputState.s,
        !!inputState.d,
        !!inputState.sp,
        !!inputState.sh,
        !!inputState.c,
      ) || isActivelyMoving;

      remainingDeltaS -= stepDeltaS;
      substeps++;
    }

    if (
      !this._localPredictionState.supportsInputAcknowledgements &&
      this._localPredictionState.preAckReconcileGraceRemainingS > 0
    ) {
      this._localPredictionState.preAckReconcileGraceRemainingS = Math.max(
        0,
        this._localPredictionState.preAckReconcileGraceRemainingS - clampedDeltaS,
      );
    }

    // When ack replay is active, avoid pulling toward delayed authoritative state
    // while there are pending commands. Before first ack, apply a short grace window
    // to reduce start-of-movement tug while still preserving a smooth fallback.
    const shouldContinuouslyReconcile =
      this._localPredictionState.supportsInputAcknowledgements
        ? this._localPredictionState.commandBufferCount === 0
        : (
          this._localPredictionState.commandBufferCount === 0 ||
          this._localPredictionState.preAckReconcileGraceRemainingS <= 0
        );

    if (shouldContinuouslyReconcile) {
      const shouldDeferActiveInputReconcile =
        hasLocalMovementIntent &&
        this._shouldDeferActiveInputReconcile();

      if (!shouldDeferActiveInputReconcile) {
        this._reconcileLocalPrediction(isActivelyMoving, clampedDeltaS);
      }
    }

    entity.applyClientPredictedTransform(
      this._localPredictionState.predictedPosition,
      this._localPredictionState.predictedRotation,
    );
  }

  private _stepPredictedMovement(
    deltaTimeS: number,
    yaw: number,
    joystickDirection: number | null,
    w: boolean,
    a: boolean,
    s: boolean,
    d: boolean,
    sp: boolean,
    sh: boolean,
    c: boolean,
  ): boolean {
    const controllerState = this._localPredictionState.controllerState;
    controllerState.predictedJustSubmergedRemainingS = Math.max(
      0,
      controllerState.predictedJustSubmergedRemainingS - deltaTimeS,
    );
    controllerState.predictedSwimUpwardCooldownRemainingS = Math.max(
      0,
      controllerState.predictedSwimUpwardCooldownRemainingS - deltaTimeS,
    );

    const effectiveYaw = controllerState.predictedMovementReferenceYaw ?? yaw;
    const movementDirection = resolveDeterministicMovementDirection({
      yaw: effectiveYaw,
      joystickDirection,
      w,
      a,
      s,
      d,
    });
    const isActivelyMoving = movementDirection.lengthSq > 0;
    const motionBasisVelocity = controllerState.predictedMotionBasisVelocity;
    const isFastMovement = sh || controllerState.predictedFastMovementByDefault;
    const predictedPosition = this._localPredictionState.predictedPosition;
    const movementSpeed = controllerState.predictedSwimming
      ? (isFastMovement ? LOCAL_PREDICTION_DEFAULT_SWIM_FAST_SPEED : LOCAL_PREDICTION_DEFAULT_SWIM_SLOW_SPEED)
      : (
        isFastMovement
          ? Math.max(
            Math.max(LOCAL_PREDICTION_MIN_SPEED, this._localPredictionState.estimatedWalkSpeed),
            this._localPredictionState.estimatedRunSpeed,
          )
          : Math.max(LOCAL_PREDICTION_MIN_SPEED, this._localPredictionState.estimatedWalkSpeed)
      );

    const movementVelocityX = isActivelyMoving ? movementDirection.x * movementSpeed : 0;
    const movementVelocityZ = isActivelyMoving ? movementDirection.z * movementSpeed : 0;
    this._applyPredictedHorizontalMovement(
      (movementVelocityX + motionBasisVelocity.x) * deltaTimeS,
      (movementVelocityZ + motionBasisVelocity.z) * deltaTimeS,
    );

    let predictedVerticalVelocity = this._localPredictionState.estimatedVerticalVelocity + motionBasisVelocity.y;

    if (
      controllerState.predictedGrounded &&
      !controllerState.predictedSwimming &&
      !sp
    ) {
      predictedVerticalVelocity = motionBasisVelocity.y;
    }

    if (controllerState.predictedSwimming) {
      if (c) {
        predictedVerticalVelocity = -LOCAL_PREDICTION_DEFAULT_SWIM_UPWARD_VELOCITY + motionBasisVelocity.y;
      } else if (controllerState.predictedJustSubmergedRemainingS > 0) {
        predictedVerticalVelocity =
          (-LOCAL_PREDICTION_DEFAULT_SWIM_UPWARD_VELOCITY * LOCAL_PREDICTION_WATER_ENTRY_SINKING_FACTOR) +
          motionBasisVelocity.y;
      } else if (!sp) {
        predictedVerticalVelocity =
          (-this._localPredictionState.estimatedVerticalVelocity * LOCAL_PREDICTION_SWIMMING_DRAG_FACTOR) +
          motionBasisVelocity.y;
      }
    }

    if (sp) {
      if (
        controllerState.predictedGrounded &&
        !controllerState.predictedSwimming &&
        this._localPredictionState.estimatedVerticalVelocity > -0.001 &&
        this._localPredictionState.estimatedVerticalVelocity <= 3
      ) {
        predictedVerticalVelocity = LOCAL_PREDICTION_DEFAULT_JUMP_VELOCITY + motionBasisVelocity.y;
        controllerState.predictedGrounded = false;
      } else if (
        controllerState.predictedSwimming &&
        controllerState.predictedSwimUpwardCooldownRemainingS <= 0
      ) {
        predictedVerticalVelocity = LOCAL_PREDICTION_DEFAULT_SWIM_UPWARD_VELOCITY + motionBasisVelocity.y;
        controllerState.predictedSwimUpwardCooldownRemainingS = 0.6;
      }
    }

    const verticalDelta = predictedVerticalVelocity * deltaTimeS;
    if (!this._intersectsLocalPredictionWorldAt(predictedPosition.x, predictedPosition.y + verticalDelta, predictedPosition.z)) {
      predictedPosition.y += verticalDelta;
    } else if (verticalDelta > 0) {
      predictedVerticalVelocity = motionBasisVelocity.y;
    }

    if (!controllerState.predictedSwimming) {
      this._resolvePredictedGroundContact(predictedVerticalVelocity, motionBasisVelocity.y);
    }

    if (isActivelyMoving) {
      const movementYaw = resolveDeterministicMovementYaw(movementDirection.x, movementDirection.z);
      const halfMovementYaw = movementYaw * 0.5;
      this._localPredictionState.predictedRotation.set(0, Math.sin(halfMovementYaw), 0, Math.cos(halfMovementYaw));
    }

    return isActivelyMoving || motionBasisVelocity.lengthSq() > 0 || Math.abs(predictedVerticalVelocity) > 0.001;
  }

  private _applyPredictedHorizontalMovement(deltaX: number, deltaZ: number): void {
    const predictedPosition = this._localPredictionState.predictedPosition;

    if (deltaX !== 0) {
      const nextX = predictedPosition.x + deltaX;
      if (!this._intersectsLocalPredictionWorldAt(nextX, predictedPosition.y, predictedPosition.z)) {
        predictedPosition.x = nextX;
      }
    }

    if (deltaZ !== 0) {
      const nextZ = predictedPosition.z + deltaZ;
      if (!this._intersectsLocalPredictionWorldAt(predictedPosition.x, predictedPosition.y, nextZ)) {
        predictedPosition.z = nextZ;
      }
    }
  }

  private _resolvePredictedGroundContact(predictedVerticalVelocity: number, motionBasisVelocityY: number): void {
    const controllerState = this._localPredictionState.controllerState;
    const predictedPosition = this._localPredictionState.predictedPosition;
    const groundY = this._getPredictedGroundY(predictedPosition.x, predictedPosition.y, predictedPosition.z);

    if (groundY === undefined) {
      if (
        controllerState.predictedGrounded &&
        Math.abs(motionBasisVelocityY) <= LOCAL_PREDICTION_COLLISION_EPSILON
      ) {
        controllerState.predictedGrounded = false;
      }

      return;
    }

    const footY = predictedPosition.y - LOCAL_PREDICTION_FOOT_OFFSET;
    const distanceToGround = footY - groundY;
    const movingDownOrStable = predictedVerticalVelocity <= (motionBasisVelocityY + LOCAL_PREDICTION_COLLISION_EPSILON);

    if (
      distanceToGround < 0 ||
      (movingDownOrStable && distanceToGround <= LOCAL_PREDICTION_GROUND_SNAP_DISTANCE)
    ) {
      predictedPosition.y = groundY + LOCAL_PREDICTION_FOOT_OFFSET;
      controllerState.predictedGrounded = true;
      return;
    }

    if (
      distanceToGround > LOCAL_PREDICTION_GROUND_SNAP_DISTANCE &&
      Math.abs(motionBasisVelocityY) <= LOCAL_PREDICTION_COLLISION_EPSILON
    ) {
      controllerState.predictedGrounded = false;
    }
  }

  private _getPredictedGroundY(x: number, y: number, z: number): number | undefined {
    const sampleBlockY = Math.floor((y - LOCAL_PREDICTION_FOOT_OFFSET) - LOCAL_PREDICTION_COLLISION_EPSILON);
    let highestGroundY: number | undefined;

    for (const [sampleOffsetX, sampleOffsetZ] of LOCAL_PREDICTION_FOOTPRINT_SAMPLES) {
      const blockIsSolid = this._isSolidPredictionBlockAt(
        Math.floor(x + sampleOffsetX),
        sampleBlockY,
        Math.floor(z + sampleOffsetZ),
      );

      if (!blockIsSolid) {
        continue;
      }

      highestGroundY = Math.max(highestGroundY ?? -Infinity, sampleBlockY + 1);
    }

    return highestGroundY;
  }

  private _intersectsLocalPredictionWorldAt(x: number, y: number, z: number): boolean {
    const minBlockX = Math.floor(x - LOCAL_PREDICTION_COLLIDER_RADIUS + LOCAL_PREDICTION_COLLISION_EPSILON);
    const maxBlockX = Math.floor(x + LOCAL_PREDICTION_COLLIDER_RADIUS - LOCAL_PREDICTION_COLLISION_EPSILON);
    const minBlockY = Math.floor(y - LOCAL_PREDICTION_FOOT_OFFSET + LOCAL_PREDICTION_COLLISION_EPSILON);
    const maxBlockY = Math.floor(y + LOCAL_PREDICTION_TOP_OFFSET - LOCAL_PREDICTION_COLLISION_EPSILON);
    const minBlockZ = Math.floor(z - LOCAL_PREDICTION_COLLIDER_RADIUS + LOCAL_PREDICTION_COLLISION_EPSILON);
    const maxBlockZ = Math.floor(z + LOCAL_PREDICTION_COLLIDER_RADIUS - LOCAL_PREDICTION_COLLISION_EPSILON);

    for (let blockY = minBlockY; blockY <= maxBlockY; blockY++) {
      for (let blockZ = minBlockZ; blockZ <= maxBlockZ; blockZ++) {
        for (let blockX = minBlockX; blockX <= maxBlockX; blockX++) {
          if (this._isSolidPredictionBlockAt(blockX, blockY, blockZ)) {
            return true;
          }
        }
      }
    }

    return false;
  }

  private _isSolidPredictionBlockAt(x: number, y: number, z: number): boolean {
    const block = this._game.chunkManager.getBlock({ x, y, z });

    if (!block || block.blockId === 0) {
      return false;
    }

    const blockType = this._game.blockTypeManager.getBlockType(block.blockId);
    return !!blockType && !blockType.isLiquid;
  }

  private _shouldDeferActiveInputReconcile(): boolean {
    if (this._localPredictionState.hasAuthoritativePosition) {
      const predictedPosition = this._localPredictionState.predictedPosition;
      const authoritativePosition = this._localPredictionState.authoritativePosition;
      const dx = authoritativePosition.x - predictedPosition.x;
      const dz = authoritativePosition.z - predictedPosition.z;
      const horizontalErrorSq = (dx * dx) + (dz * dz);

      if (horizontalErrorSq > LOCAL_PREDICTION_ACTIVE_INPUT_HORIZONTAL_RECONCILE_TOLERANCE_SQ) {
        return false;
      }

      if (
        Math.abs(authoritativePosition.y - predictedPosition.y)
        > LOCAL_PREDICTION_ACTIVE_INPUT_VERTICAL_RECONCILE_TOLERANCE
      ) {
        return false;
      }
    }

    if (this._localPredictionState.hasAuthoritativeRotation) {
      const rotationError = this._localPredictionState.predictedRotation.angleTo(
        this._localPredictionState.authoritativeRotation,
      );

      if (rotationError > LOCAL_PREDICTION_ACTIVE_INPUT_ROTATION_RECONCILE_TOLERANCE) {
        return false;
      }
    }

    return true;
  }

  private _setLastAcknowledgedMovementDirection(command?: LocalPredictionCommand): void {
    this._localPredictionState.lastAcknowledgedMovementDirectionX = undefined;
    this._localPredictionState.lastAcknowledgedMovementDirectionZ = undefined;

    if (!command) {
      return;
    }

    const effectiveYaw = this._localPredictionState.controllerState.authoritativeMovementReferenceYaw ?? command.yaw;
    const movementDirection = resolveDeterministicMovementDirection({
      yaw: effectiveYaw,
      joystickDirection: command.joystickDirection,
      w: command.w,
      a: command.a,
      s: command.s,
      d: command.d,
    });
    if (movementDirection.lengthSq <= 0) {
      return;
    }

    this._localPredictionState.lastAcknowledgedMovementDirectionX = movementDirection.x;
    this._localPredictionState.lastAcknowledgedMovementDirectionZ = movementDirection.z;
  }

  private _updateLocalPredictionVerticalVelocityEstimate(sampledVerticalVelocity: number): void {
    if (!Number.isFinite(sampledVerticalVelocity)) {
      return;
    }

    if (Math.abs(sampledVerticalVelocity) > LOCAL_PREDICTION_VERTICAL_VELOCITY_REJECT_THRESHOLD) {
      this._localPredictionState.estimatedVerticalVelocity = 0;
      return;
    }

    this._localPredictionState.estimatedVerticalVelocity +=
      (sampledVerticalVelocity - this._localPredictionState.estimatedVerticalVelocity) * LOCAL_PREDICTION_VERTICAL_VELOCITY_ADAPT_RATE;
  }

  private _updateLocalPredictionSpeedEstimate(
    sampledHorizontalSpeed: number,
    dx: number,
    dy: number,
    dz: number,
    calibrationAcknowledgedInputSequenceNumber?: number,
  ): void {
    if (calibrationAcknowledgedInputSequenceNumber === undefined) {
      return;
    }

    if (
      !this._localPredictionState.supportsInputAcknowledgements ||
      !this._localPredictionState.lastAcknowledgedHadMovementInput
    ) {
      return;
    }

    if (
      !Number.isFinite(sampledHorizontalSpeed) ||
      sampledHorizontalSpeed < LOCAL_PREDICTION_MIN_SPEED ||
      sampledHorizontalSpeed > LOCAL_PREDICTION_SPEED_REJECT_THRESHOLD
    ) {
      return;
    }

    if (Math.abs(dy) > LOCAL_PREDICTION_SPEED_VERTICAL_REJECT_THRESHOLD) {
      return;
    }

    const movementDirectionX = this._localPredictionState.lastAcknowledgedMovementDirectionX;
    const movementDirectionZ = this._localPredictionState.lastAcknowledgedMovementDirectionZ;
    if (movementDirectionX === undefined || movementDirectionZ === undefined) {
      return;
    }

    const sampleHorizontalDistanceSq = (dx * dx) + (dz * dz);
    if (sampleHorizontalDistanceSq <= 0) {
      return;
    }

    const sampleHorizontalDistance = Math.sqrt(sampleHorizontalDistanceSq);
    const sampledDirectionX = dx / sampleHorizontalDistance;
    const sampledDirectionZ = dz / sampleHorizontalDistance;
    const movementAlignmentDot =
      (sampledDirectionX * movementDirectionX) +
      (sampledDirectionZ * movementDirectionZ);

    if (movementAlignmentDot < LOCAL_PREDICTION_SPEED_DIRECTION_ALIGNMENT_MIN_DOT) {
      return;
    }

    const clampedSampledSpeed = Math.min(sampledHorizontalSpeed, LOCAL_PREDICTION_MAX_SPEED);
    const shouldUpdateRunSpeed =
      !!this._localPredictionState.lastAcknowledgedMovementRunning ||
      this._localPredictionState.controllerState.authoritativeFastMovementByDefault;

    if (shouldUpdateRunSpeed) {
      this._localPredictionState.estimatedRunSpeed = this._applySpeedEstimateSample(
        this._localPredictionState.estimatedRunSpeed,
        clampedSampledSpeed,
      );
    } else {
      this._localPredictionState.estimatedWalkSpeed = this._applySpeedEstimateSample(
        this._localPredictionState.estimatedWalkSpeed,
        clampedSampledSpeed,
      );
    }

    this._localPredictionState.estimatedWalkSpeed = Math.min(
      this._localPredictionState.estimatedWalkSpeed,
      this._localPredictionState.estimatedRunSpeed,
    );
    this._localPredictionState.estimatedWalkSpeed = Math.max(
      this._localPredictionState.estimatedWalkSpeed,
      LOCAL_PREDICTION_MIN_SPEED,
    );
    this._localPredictionState.estimatedRunSpeed = Math.max(
      this._localPredictionState.estimatedRunSpeed,
      this._localPredictionState.estimatedWalkSpeed,
    );
  }

  private _applySpeedEstimateSample(currentEstimate: number, sampledSpeed: number): number {
    const adaptRate = sampledSpeed >= currentEstimate
      ? LOCAL_PREDICTION_SPEED_UPWARD_ADAPT_RATE
      : LOCAL_PREDICTION_SPEED_DOWNWARD_ADAPT_RATE;

    return currentEstimate + ((sampledSpeed - currentEstimate) * adaptRate);
  }

  private _reconcileLocalPrediction(isActivelyMoving: boolean, deltaTimeS: number): void {
    if (this._localPredictionState.hasAuthoritativePosition) {
      const predictedPosition = this._localPredictionState.predictedPosition;
      const authoritativePosition = this._localPredictionState.authoritativePosition;
      const dx = authoritativePosition.x - predictedPosition.x;
      const dz = authoritativePosition.z - predictedPosition.z;
      const horizontalErrorSq = (dx * dx) + (dz * dz);

      if (horizontalErrorSq > LOCAL_PREDICTION_HORIZONTAL_SNAP_DISTANCE_SQ) {
        predictedPosition.x = authoritativePosition.x;
        predictedPosition.z = authoritativePosition.z;
      } else {
        const horizontalDeadZoneSq = isActivelyMoving
          ? LOCAL_PREDICTION_MOVING_HORIZONTAL_ERROR_DEAD_ZONE_SQ
          : LOCAL_PREDICTION_IDLE_HORIZONTAL_ERROR_DEAD_ZONE_SQ;

        if (horizontalErrorSq > horizontalDeadZoneSq) {
          const correctionT = Math.min(
            1,
            deltaTimeS * (isActivelyMoving ? LOCAL_PREDICTION_MOVING_HORIZONTAL_CORRECTION_RATE : LOCAL_PREDICTION_IDLE_HORIZONTAL_CORRECTION_RATE),
          );
          predictedPosition.x += dx * correctionT;
          predictedPosition.z += dz * correctionT;
        }
      }

      const verticalError = authoritativePosition.y - predictedPosition.y;
      const absVerticalError = Math.abs(verticalError);
      if (absVerticalError > LOCAL_PREDICTION_VERTICAL_SNAP_DISTANCE) {
        predictedPosition.y = authoritativePosition.y;
      } else {
        const verticalDeadZone = isActivelyMoving
          ? LOCAL_PREDICTION_MOVING_VERTICAL_ERROR_DEAD_ZONE
          : LOCAL_PREDICTION_IDLE_VERTICAL_ERROR_DEAD_ZONE;

        if (absVerticalError > verticalDeadZone) {
          const correctionT = Math.min(
            1,
            deltaTimeS * (isActivelyMoving ? LOCAL_PREDICTION_MOVING_VERTICAL_CORRECTION_RATE : LOCAL_PREDICTION_IDLE_VERTICAL_CORRECTION_RATE),
          );
          predictedPosition.y += verticalError * correctionT;
        }
      }
    }

    if (this._localPredictionState.hasAuthoritativeRotation) {
      const rotationError = this._localPredictionState.predictedRotation.angleTo(this._localPredictionState.authoritativeRotation);
      if (rotationError > LOCAL_PREDICTION_ROTATION_SNAP_ANGLE) {
        this._localPredictionState.predictedRotation.copy(this._localPredictionState.authoritativeRotation);
      } else {
        const deadZone = isActivelyMoving
          ? LOCAL_PREDICTION_MOVING_ROTATION_ERROR_DEAD_ZONE
          : LOCAL_PREDICTION_IDLE_ROTATION_ERROR_DEAD_ZONE;

        if (rotationError > deadZone) {
          const correctionT = Math.min(
            1,
            deltaTimeS * (isActivelyMoving ? LOCAL_PREDICTION_MOVING_ROTATION_CORRECTION_RATE : LOCAL_PREDICTION_IDLE_ROTATION_CORRECTION_RATE),
          );
          this._localPredictionState.predictedRotation.slerp(this._localPredictionState.authoritativeRotation, correctionT);
        }
      }
    }
  }

  private _syncLocalPredictionStats(
    lastReplayCommandCount?: number,
    lastReplaySubstepCount?: number,
  ): void {
    LocalPredictionStats.entityId = this._localPredictionState.entityId ?? -1;
    LocalPredictionStats.supportsInputAcknowledgements = this._localPredictionState.supportsInputAcknowledgements;
    LocalPredictionStats.bufferedCommandCount = this._localPredictionState.commandBufferCount;
    LocalPredictionStats.lastAcknowledgedInputSequenceNumber = this._localPredictionState.lastAcknowledgedInputSequenceNumber;

    if (lastReplayCommandCount !== undefined) {
      LocalPredictionStats.lastReplayCommandCount = lastReplayCommandCount;
      LocalPredictionStats.peakReplayCommandCount = Math.max(
        LocalPredictionStats.peakReplayCommandCount,
        lastReplayCommandCount,
      );
    }

    if (lastReplaySubstepCount !== undefined) {
      LocalPredictionStats.lastReplaySubstepCount = lastReplaySubstepCount;
      LocalPredictionStats.peakReplaySubstepCount = Math.max(
        LocalPredictionStats.peakReplaySubstepCount,
        lastReplaySubstepCount,
      );
    }

    if (this._localPredictionState.hasAuthoritativePosition && this._localPredictionState.hasPredictedTransform) {
      const dx = this._localPredictionState.authoritativePosition.x - this._localPredictionState.predictedPosition.x;
      const dz = this._localPredictionState.authoritativePosition.z - this._localPredictionState.predictedPosition.z;
      LocalPredictionStats.horizontalError = Math.sqrt((dx * dx) + (dz * dz));
      LocalPredictionStats.verticalError =
        this._localPredictionState.authoritativePosition.y - this._localPredictionState.predictedPosition.y;
    } else {
      LocalPredictionStats.horizontalError = 0;
      LocalPredictionStats.verticalError = 0;
    }

    if (this._localPredictionState.hasAuthoritativeRotation && this._localPredictionState.hasPredictedTransform) {
      LocalPredictionStats.rotationErrorDeg = MathUtils.radToDeg(
        this._localPredictionState.predictedRotation.angleTo(this._localPredictionState.authoritativeRotation),
      );
    } else {
      LocalPredictionStats.rotationErrorDeg = 0;
    }
  }

  private _onBlockEntityBuilt = (payload: WorkerEventPayload.IBlockEntityBuilt): void => {
    const entity = this._entities.get(payload.entityId);

    if (!entity) {
      console.warn(`EntityManager._onBlockEntityBuilt(): Unknown Entity ID: ${payload.entityId}, or the corresponding Entity has already been removed.`)
      return;
    }

    // Ignore stale async worker results when a newer block texture request has already been sent.
    if (payload.requestVersion !== entity.blockTextureRequestVersion) {
      return;
    }

    entity.buildBlockModel(payload.geometry, payload.dimensions, payload.transparent);
  };

  private _onLightLevelVolumeBuilt = (payload: WorkerEventPayload.ILightLevelVolumeBuilt): void => {
    if (payload.lightLevelVolume) {
      if (!this._hasLightLevelVolumeUpdatedOnce) {
        this._hasLightLevelVolumeUpdatedOnce = true;
        this._game.gltfManager.onLightLevelVolumeUpdated();
      }
    }
    // Since the LightVolume was updated, update the LightLevel of all Entities just in case.
    // It might be an optimization if we can filter out only the Entities that actually need updating.
    this._needsLightLevelRefresh = true;
  }

  private _onSkyDistanceVolumeBuilt = (_payload: WorkerEventPayload.ISkyDistanceVolumeBuilt): void => {
    // Since the SkyDistanceVolume was updated, update the SkyLight of all Entities just in case.
    // It might be an optimization if we can filter out only the Entities that actually need updating.
    this._needsSkyLightRefresh = true;
  }

  private _onQualitySettingsUpdate = (): void => {
    const shouldSuppressAnimations = this._isEnvironmentalAnimationsSuppressed();

    if (this._shouldSuppressEnvironmentAnimations !== shouldSuppressAnimations) {
      this._shouldSuppressEnvironmentAnimations = shouldSuppressAnimations;

      for (const entity of this._entities.values()) {
        if (entity.isEnvironmental) {
          entity.suppressAnimations(shouldSuppressAnimations);
        }
      }
    }
  };

  private _isEnvironmentalAnimationsSuppressed(): boolean {
    return this._game.settingsManager.qualityPerfTradeoff.environmentalAnimations?.enabled === false;
  }
}
