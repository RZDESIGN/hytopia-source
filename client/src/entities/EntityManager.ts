import { Color, Frustum, Matrix4, Object3D, Vector2, Vector3, Quaternion } from 'three';
import Entity from './Entity';
import { type EntityId, MAX_OUTLINES } from './EntityConstants';
import EntityStats from './EntityStats';
import StaticEntity from './StaticEntity';
import StaticEntityManager from './StaticEntityManager';
import { type RendererEventPayload, RendererEventType } from '../core/Renderer';
import EventRouter from '../events/EventRouter';
import type Game from '../Game';
import type { DeserializedEntity } from '../network/Deserializer';
import { type NetworkManagerEventPayload, NetworkManagerEventType } from '../network/NetworkManager';
import { ClientSettingsEventType } from '../settings/SettingsManager';
import {
  type WorkerEventPayload,
  WorkerEventType,
} from '../workers/ChunkWorkerConstants';

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

export default class EntityManager {
  private _game: Game;
  private _entities: Map<EntityId, Entity | StaticEntity> = new Map();
  private _dynamicEntities: Set<Entity> = new Set();
  private _dynamicEntityList: Entity[] = [];
  private _dynamicEntityListDirty: boolean = false;
  private _outlines: Map<EntityId, OutlineOptions> = new Map();
  private _outlineTargets: OutlineTarget[] = new Array(MAX_OUTLINES).fill(undefined).map(() => { return { object3d: null, options: null }; });
  private _staticEnvironmentEntityManager: StaticEntityManager;
  private _needsLightLevelRefresh: boolean = false;
  private _hasLightLevelVolumeUpdatedOnce: boolean = false;
  private _needsSkyLightRefresh: boolean = false;
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

  public getEntity(id: number): Entity | StaticEntity | undefined {
    return this._entities.get(id);
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
    const dynamicEntities = this._getDynamicEntityList();

    // Entities are updated using a multi-pass approach.

    // First pass: Update local position and rotation
    for (let i = 0; i < dynamicEntities.length; i++) {
      dynamicEntities[i].update(payload.frameDeltaS);
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
        dynamicEntities[i].applyViewDistance(viewDistanceSquared, fromVec2);
      }
    } else {
      // If ViewDistance can be toggled dynamically in the future, we need to
      // make everything visible at the moment it switches to enabled.
      EntityStats.inViewDistanceCount = this._entities.size;
    }

    // Third pass: Apply frustum culling
    const camera = this._game.camera.activeCamera;
    frustum.setFromProjectionMatrix(projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));

    for (let i = 0; i < dynamicEntities.length; i++) {
      dynamicEntities[i].applyFrustumCulling(frustum);
    }

    // Forth pass: Update Animation and Local matrix
    const frameCount = this._game.performanceMetricsManager.frameCount;
    for (let i = 0; i < dynamicEntities.length; i++) {
      dynamicEntities[i].updateAnimationAndLocalMatrix(payload.frameDeltaS, frameCount);
    }

    // Fifth pass: World matrices update.
    // Considering parent-child relationships, the WorldMatrix must be updated only
    // after the LocalMatrix of all entities has been updated.
    for (let i = 0; i < dynamicEntities.length; i++) {
      dynamicEntities[i].updateWorldMatrices(this._hasLightLevelVolumeUpdatedOnce);
    }

    // Sixth pass: Light level update
    // LightLevel is only needed when a Light Emission Block is placed. However, in most maps, Light Emission
    // Blocks are probably not placed at all. Therefore, detects whether a Light Level Volume has ever been
    // generated by a Light Emission Block is placed, and only then perform Light Level update processing.
    if (this._hasLightLevelVolumeUpdatedOnce) {
      for (let i = 0; i < dynamicEntities.length; i++) {
        dynamicEntities[i].updateLightLevel(this._needsLightLevelRefresh);
      }
      if (this._needsLightLevelRefresh) {
        this._staticEnvironmentEntityManager.updateLightLevel();
      }
      this._needsLightLevelRefresh = false;
    }

    // Seventh pass: Sky light update
    // Sky light is always available and doesn't depend on light emission blocks
    for (let i = 0; i < dynamicEntities.length; i++) {
      dynamicEntities[i].updateSkyLight(this._needsSkyLightRefresh, payload.frameDeltaS);
    }
    if (this._needsSkyLightRefresh) {
      this._staticEnvironmentEntityManager.updateSkyLight();
    }
    this._needsSkyLightRefresh = false;
  }

  private _onEntitiesPacket = (payload: NetworkManagerEventPayload.IEntitiesPacket): void => {
    for (const deserializedEntity of payload.deserializedEntities) {
      this._updateEntity(deserializedEntity, payload.serverTick);
    }
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

        entity.release();
        this._entities.delete(entity.id);
        if (entity instanceof Entity && this._dynamicEntities.delete(entity)) {
          this._dynamicEntityListDirty = true;
        }
        this._outlines.delete(entity.id);
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

      if (deserializedEntity.position) {
        // do not interpolate if we are also attaching or detaching to/from a parent
        entity.setPosition(
          deserializedEntity.position,
          shouldInterpolateTransform,
          serverTick,
        );
      }

      if (deserializedEntity.rotation) {
        // do not interpolate if we are also attaching or detaching to/from a parent
        entity.setRotation(
          deserializedEntity.rotation,
          shouldInterpolateTransform,
          serverTick,
        );
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
