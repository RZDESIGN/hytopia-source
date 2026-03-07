import { Vector3 } from 'three';
import SceneUIStats from './SceneUIStats';
import { CSS2DObject } from '../three/CSS2DRenderer';
import Game from '../Game';
import type { Vector3Like } from 'three';
import type { TemplateRenderer } from './globals/hytopia';

export type OnStateCallback = (data: object) => void;

export interface SceneUIData {
  id: number;
  attachedToEntityId?: number;
  offset?: Vector3Like;
  position?: Vector3Like;
  state?: object;
  templateId: string;
  templateRenderer: TemplateRenderer;
  viewDistance?: number;
}

export default class SceneUI {
  private _game: Game;
  private _id: number;
  private _attachedToEntityId: number | undefined;
  private _containerDiv: HTMLDivElement | null = null;
  private _needsUpdatePosition: boolean = false;
  private _object: CSS2DObject;
  private _offset: Vector3Like | undefined;
  private _onStateCallback: OnStateCallback | undefined;
  private _position: Vector3;
  private _state: object;
  private _templateId: string | undefined;
  private _viewDistance: number;
  private _warnedMissingAttachedEntity: boolean = false;

  public constructor(game: Game, data: SceneUIData) {
    if (data.attachedToEntityId === undefined && data.position === undefined) {
      throw new Error('SceneUI.constructor(): SceneUI must have either an attachedToEntityId or position.');
    }

    this._game = game;
    this._id = data.id;
    this._attachedToEntityId = data.attachedToEntityId;
    this._offset = data.offset;
    this._position = data.position ? new Vector3(data.position.x, data.position.y, data.position.z) : new Vector3();
    this._state = data.state ?? {};
    this._templateId = data.templateId;
    this._viewDistance = data.viewDistance ?? 25;

    this._object = this._createObject(data.templateRenderer);
  }

  public get id(): number { return this._id; }
  public get attachedToEntityId(): number | undefined { return this._attachedToEntityId; }
  public get object(): CSS2DObject | null { return this._object; }
  public get position(): Vector3Like | undefined { return this._position; }
  public get offset(): Vector3Like | undefined { return this._offset; }
  public get state(): object { return this._state; }
  public get templateId(): string | undefined { return this._templateId; }
  public get viewDistance(): number | undefined { return this._viewDistance; }
  public get game(): Game { return this._game; }

  public update(): void {
    if (!this._containerDiv) return;

    // Update position if attached to entity
    if (this._attachedToEntityId !== undefined) {
      const entity = this._game.entityManager.getEntity(this._attachedToEntityId);
      if (!entity) {
        if (!this._warnedMissingAttachedEntity) {
          console.warn(`SceneUI.update(): Entity ${this._attachedToEntityId} not found.`);
          this._warnedMissingAttachedEntity = true;
        }
        // It is likely more natural to make the SceneUI invisible when Entity cannot be
        // found. Even if an entity was deleted but somehow the client did not receive
        // SceneUI delete message due to some issue, this approach should also reduce problems.
        this._object.visible = false;
        return;
      }

      this._warnedMissingAttachedEntity = false;

      // Synchronize the visibility of the associated Entity's model with the Scene UI,
      // and perform an early return if it is invisible.
      // Not sure if this behavior is correct.
      this._object.visible = entity.visible;
      if (!this._object.visible) {
        return;
      }

      entity.getWorldPosition(this._position);

      // Add offset, this only works with entity attachment.
      if (this._offset) {
        this._position.x += this._offset.x;
        this._position.y += this._offset.y; 
        this._position.z += this._offset.z;
      }

      this._needsUpdatePosition = true;
    } else {
      this._object.visible = true;
    }

    // Only calculate scale if we have an active camera
    const activeCamera = this._game.camera.activeCamera;
    
    if (activeCamera) {
      const maxDistance = this._viewDistance;
      const maxDistanceSquared = maxDistance * maxDistance;
      const distanceSquared = this._position.distanceToSquared(activeCamera.position);
      
      // Skip scale and matrix calculation if beyond max distance
      if (distanceSquared >= maxDistanceSquared) {
        this._object.visible = false;
        return;
      } else {
        const scale = 1 - distanceSquared / maxDistanceSquared;
        // Use scale3d for GPU compositing instead of scale
        const scaleStr = `scale3d(${scale}, ${scale}, 1)`;
        // Since updating styles can sometimes cause side effects even if the value doesn't change,
        // optimize by setting the value only when there is a difference.
        if (this._containerDiv.style.transform !== scaleStr) {
          this._containerDiv.style.transform = scaleStr;
        }
      }
    }

    // Only update object position if it changed
    if (this._needsUpdatePosition) {
      if(!this._object.position.equals(this._position)) {
        this._object.position.copy(this._position);
        this._object.updateMatrix();
        // Assumes that object is directly added to Scene and Scene matrix is an identity matrix
        this._object.matrixWorld.copy(this._object.matrix);
      }
      this._needsUpdatePosition = false;
    }

    if (this._object.visible) {
      SceneUIStats.visibleCount++;
    }
  }

  public addToScene(): void {
    this._game.renderer.addToUIScene(this._object);
  }

  public async removeFromScene(): Promise<void> {
    this._object.removeFromParent();
  }

  public setAttachedToEntityId(entityId: number) {
    this._attachedToEntityId = entityId;
    this._warnedMissingAttachedEntity = false;
  }

  public setOffset(offset: Vector3Like) {
    this._offset = offset;
  }

  public setPosition(position: Vector3Like) {
    this._position.copy(position);
    this._needsUpdatePosition = true;
  }

  public setState(state: object) {
    this._state = state;

    if (this._onStateCallback) {
      this._onStateCallback(state);
    }
  }

  public setViewDistance(viewDistance: number) {
    this._viewDistance = viewDistance;
  }

  private _createObject(templateRenderer: TemplateRenderer): CSS2DObject {
    const obj = new CSS2DObject();
    // Since the matrix will only be updated when necessary, these flags are turned off.
    obj.matrixAutoUpdate = false;
    obj.matrixWorldAutoUpdate = false;
    
    this._containerDiv = document.createElement('div');
    this._containerDiv.style.transform = 'scale3d(1, 1, 1)';
    // As an optimization, set properties that are likely to be updated frequently.
    this._containerDiv.style.willChange = 'transform';

    obj.element.appendChild(this._containerDiv);
    this._containerDiv.appendChild(templateRenderer(this._id, this._registerOnStateCallback));

    // Pass initial state
    if (this._onStateCallback) {
      this._onStateCallback(this._state);
    }

    return obj;
  }

  private _registerOnStateCallback = (callback: OnStateCallback) => {
    this._onStateCallback = callback;
  }
}
