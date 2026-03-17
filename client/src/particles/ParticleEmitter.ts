import { Mesh, Object3D, Vector3, type Vector3Like } from 'three';
import { ParticleEmitterID } from './ParticleEmitterConstants';
import ParticleEmitterCore, { ParticleEmitterCoreOptions } from './ParticleEmitterCore';
import Entity from '../entities/Entity';
import { EntityId } from '../entities/EntityConstants';
import { isAngleVisibilityCullingEnabled } from '../core/VisibilityCulling';
import Game from '../Game';
import Assets from '../network/Assets';
import type { CustomTextureWrapper } from '../textures/CustomTextureManager';
import { updateAABB } from '../three/utils';

export interface ParticleEmitterOptions {
  id: ParticleEmitterID;
  attachedToEntityId?: EntityId | null;
  attachedToEntityNodeName?: string | null;
  textureUri: string;
  emitterCoreOptions?: ParticleEmitterCoreOptions;
  position?: Vector3Like;
  offset?: Vector3Like;
}

export default class ParticleEmitter {
  private _game: Game;
  private _id: ParticleEmitterID;
  private _attachedToEntityId: EntityId | null = null;
  private _attachedToEntityNode: Object3D | null = null;
  private _attachedToEntityNodeName: string | null = null;
  private _emitterCore: ParticleEmitterCore;
  private _position: Vector3 = new Vector3();
  private _offset: Vector3 = new Vector3();
  private _pendingTextureWrappers: Set<Promise<CustomTextureWrapper>> = new Set();
  private _textureUri: string = '';
  private _textureWrapper: CustomTextureWrapper | null = null;

  constructor(game: Game, options: ParticleEmitterOptions) {
    this._game = game;
    this._id = options.id;

    this._emitterCore = new ParticleEmitterCore(options.emitterCoreOptions || {});
    this._emitterCore.mesh.matrixAutoUpdate = false;
    this._emitterCore.mesh.matrixWorldAutoUpdate = false;
    this._emitterCore.mesh.frustumCulled = isAngleVisibilityCullingEnabled();

    if (options.position) {
      this.setPosition(options.position);
    }

    if (options.offset) {
      this.setOffset(options.offset);
    }

    if (options.attachedToEntityId !== undefined) {
      this.setAttachedToEntityId(options.attachedToEntityId);
    }

    if (options.attachedToEntityNodeName !== undefined) {
      this.setAttachedToEntityNodeName(options.attachedToEntityNodeName);
    }

    this.setTextureUri(options.textureUri);

    this._game.renderer.addToParticlesScene(this._emitterCore.mesh);
  }

  public get id(): ParticleEmitterID {
    return this._id;
  }

  public get mesh(): Mesh {
    return this._emitterCore.mesh;
  }

  public burst(count: number): void {
    this._emitterCore.burst(count);
  }

  public pause(): void {
    this._emitterCore.pause();
  }

  public restart(): void {
    this._emitterCore.restart();
  }

  public setPosition(position: Vector3Like): void {
    this._position.copy(position);
  }

  public setOffset(offset: Vector3Like): void {
    this._offset.copy(offset);
  }

  public setVisible(visible: boolean): void {
    this._emitterCore.mesh.visible = visible;
  }

  private _getAttachedToEntity(): Entity {
    const attachedToEntity = this._game.entityManager.getEntity(this._attachedToEntityId!);
    if (!attachedToEntity) {
      throw new Error(`Particles._getAttachedToEntity(): Attached To Entity ${this._attachedToEntityId} is not found.`);
    }
    return attachedToEntity;
  }

  private _attachToEntity(): void {
    this._getAttachedToEntity().addModelReadyListener(this._attachedToEntityModelReadyCallback, !!this._attachedToEntityNodeName);
  }

  private _detachFromEntity(): void {
    this._getAttachedToEntity().removeModelReadyListener(this._attachedToEntityModelReadyCallback);
    this._attachedToEntityNode = null;
  }

  public setAttachedToEntityId(attachedToEntityId: EntityId | null): void {
    if (this._attachedToEntityId === attachedToEntityId) {
      return;
    }

    if (this._attachedToEntityId !== null) {
      this._detachFromEntity();
    }

    this._attachedToEntityId = attachedToEntityId;

    if (this._attachedToEntityId !== null) {
      this._attachToEntity();
    }

    // Particles emitted after emission do not follow the entity attached to's position.
    // Because of this, if the entity attached to moves, it's very difficult to perform
    // efficient frustum culling on the CPU. As a result, we disable CPU-side
    // frustum culling in this case.
    // TODO: Either solve the root problem or relax the condition. e.g., only disable
    // frustum culling when the entity attached to's position has changed.
    // TODO: Enabling frustum culling may need to be done more carefully. For example,
    // if the position changes frequently or significantly, already emitted particles may
    // be unintentionally culled.
    this._emitterCore.mesh.frustumCulled = isAngleVisibilityCullingEnabled() && attachedToEntityId === null;
  }

  public setAttachedToEntityNodeName(attachedToEntityNodeName: string | null): void {
    if (this._attachedToEntityNodeName === attachedToEntityNodeName) {
      return;
    }

    this._attachedToEntityNodeName = attachedToEntityNodeName;

    if (this._attachedToEntityId !== null) {
      this._detachFromEntity();
      this._attachToEntity();
    }
  }

  private _attachedToEntityModelReadyCallback = (attachedToEntity: Entity): void => {
    const attachedToEntityNode = (this._attachedToEntityNodeName !== null) ? attachedToEntity.entityRoot.getObjectByName(this._attachedToEntityNodeName) : attachedToEntity.entityRoot

    if (!attachedToEntityNode) {
      throw new Error(`Particles._attachedToEntityModelReadyCallback(): Node ${this._attachedToEntityNodeName} is not found in Entity ${this._attachedToEntityId}`);
    }

    // TODO: Holding a reference to the Object3D inside an Entity is probably not a good design.
    // Switch to a better approach.
    this._attachedToEntityNode = attachedToEntityNode;
  };

  public setEmitterCoreOptions(options: ParticleEmitterCoreOptions): void {
    this._emitterCore.updateParameters(options);
  }

  public setTextureUri(textureUri: string): void {
    const newUri = textureUri.startsWith('data:') ? textureUri : Assets.toAssetUri(textureUri);

    if (this._textureUri === newUri) {
      return;
    }

    this._textureUri = newUri;
    this._loadTexture();
  }

  private async _loadTexture(): Promise<void> {
    this._pendingTextureWrappers.forEach(pendingTextureWrapper => {
      this._game.customTextureManager.cancel(pendingTextureWrapper, true);
    });
    this._pendingTextureWrappers.clear();

    const loadingTextureUri = this._textureUri;

    const pendingTextureWrapper = this._game.customTextureManager.load(loadingTextureUri);
    this._pendingTextureWrappers.add(pendingTextureWrapper);
    const textureWrapper = await pendingTextureWrapper;

    if (!this._pendingTextureWrappers.has(pendingTextureWrapper)) {
      this._game.customTextureManager.release(textureWrapper);
      return;
    }

    this._pendingTextureWrappers.delete(pendingTextureWrapper);

    if (this._textureWrapper) {
      this._game.customTextureManager.release(this._textureWrapper);
    }

    this._textureWrapper = textureWrapper;
    this._emitterCore.updateParameters({ texture: textureWrapper.texture });
  }

  public update(deltaTimeS: number): void {
    this._updatePosition();
    this._emitterCore.update(deltaTimeS);
  }

  private _updatePosition(): void {
    // TODO: Update only when needed
    if (this._attachedToEntityNode !== null) {
      // TODO: What if the entity attached to has been already removed?
      this._attachedToEntityNode.getWorldPosition(this._emitterCore.mesh.position);
    } else {
      this._emitterCore.mesh.position.copy(this._position);
    }

    this._emitterCore.mesh.position.add(this._offset);
    this._emitterCore.mesh.updateMatrix();
    this._emitterCore.mesh.matrixWorld.copy(this._emitterCore.mesh.matrix);
    this._emitterCore.mesh.matrixWorldNeedsUpdate = false;

    updateAABB(this._emitterCore.mesh);
  }

  public dispose(): void {
    this._pendingTextureWrappers.forEach(pendingTextureWrapper => {
      this._game.customTextureManager.cancel(pendingTextureWrapper, true);
    });
    this._pendingTextureWrappers.clear();

    if (this._textureWrapper) {
      this._game.customTextureManager.release(this._textureWrapper);
      this._textureWrapper = null;
    }

    this._emitterCore.dispose();
    this._game.renderer.removeFromParticlesScene(this._emitterCore.mesh);
  }
}
