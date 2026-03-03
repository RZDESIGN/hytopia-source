import { Euler, Object3D, PerspectiveCamera, Quaternion, Raycaster, Vector2, Vector3 } from "three";
import Entity from "../entities/Entity";
import EventRouter from '../events/EventRouter';
import Game from "../Game";
import { NetworkManagerEventType } from '../network/NetworkManager';
import type { Ray } from 'three';
import type { NetworkManagerEventPayload } from '../network/NetworkManager';

const BASE_ZOOM = 3.5;
const MIN_ZOOM = 3.0;
const MAX_ZOOM = 10.0;
const INITIAL_ZOOM = 6.0;
const CAMERA_LERP_TIME = 0.2;

// Working variables
const vec2 = new Vector2();
const vec3 = new Vector3();
const vec3b = new Vector3();
const vec3c = new Vector3();
const modelViewEuler = new Euler(0, 0, 0, 'YXZ');
const yawOnlyEuler = new Euler(0, 0, 0, 'YXZ');
const entityYawEuler = new Euler(0, 0, 0, 'YXZ');
const modelViewQuat = new Quaternion();
const tempQuat = new Quaternion();
const positionQuat = new Quaternion();

const normalizeAngle = (radians: number): number => Math.atan2(Math.sin(radians), Math.cos(radians));

export enum CameraMode {
  FIRST_PERSON = 0,
  THIRD_PERSON = 1,
  SPECTATOR = 2,
}

export enum CameraEventType {
  GameCameraOrientationChange = 'CAMERA.GAME_CAMERA_ORIENTATION_CHANGE',
  UseSpectatorCamera = 'CAMERA.USE_SPECTATOR_CAMERA',
  UseGameCamera = 'CAMERA.USE_GAME_CAMERA',
}

export namespace CameraEventPayload {
  export interface GameCameraOrientationChange { pitch: number; yaw: number; }
  export interface UseSpectatorCamera {}
  export interface UseGameCamera { attachedTo: Entity | Vector3; }
}

export default class Camera {
  private _game: Game;

  private _activeCamera: PerspectiveCamera;
  private _activeViewDir: Vector3;

  private _gameCamera: PerspectiveCamera;
  private _gameCameraMode: CameraMode = CameraMode.THIRD_PERSON;
  private _gameCameraAttachedEntity: Entity | undefined;
  private _gameCameraAttachedEntityModelHiddenNodes: string[] = [];
  private _gameCameraAttachedEntityModelShownNodes: string[] = [];
  private _gameCameraAttachedPosition: Vector3 | undefined;
  private _gameCameraCollidesWithBlocks: boolean = true;
  private _gameCameraForwardOffset: number = 0;
  private _gameCameraModelPitchesWithCamera: boolean = false;
  private _gameCameraModelYawsWithCamera: boolean = false;
  private _gameCameraTargetFilmOffset: number = 0;
  private _gameCameraTargetFov: number = 75;
  private _gameCameraTargetZoom: number = 1;
  private _gameCameraLookAtPosition: Vector3 | undefined;
  private _gameCameraMouseSensitivityMultiplier: number = 1;
  private _gameCameraFirstPersonOffset: Vector3 = new Vector3(0, 0, 0);
  private _gameCameraThirdPersonOffset: Vector3 = new Vector3(0, 0, 0);
  private _gameCameraRadialZoom: number = INITIAL_ZOOM;
  private _gameCameraTrackedEntity: Entity | undefined;
  private _gameCameraTrackedPosition: Vector3 | undefined;
  private _gameCameraViewModelBaseCameraOffsets: Map<string, Vector3> = new Map();
  private _gameCameraPitch: number = 0.2;
  private _gameCameraShoulderRotationOffset: Quaternion = new Quaternion();
  private _gameCameraSkipNextFilmOffsetInterpolation: boolean = false;
  private _gameCameraYaw: number = 0;
  private _gameCameraViewDir: Vector3 = new Vector3();
  private _gameCameraCollisionDistance: number = Infinity; // Current collision-adjusted distance

  private _spectatorCamera: PerspectiveCamera;
  private _spectatorCameraPitch: number = 0;
  private _spectatorCameraYaw: number = 0;
  private _spectatorCameraViewDir: Vector3 = new Vector3();

  private _raycaster: Raycaster = new Raycaster();
    
  public constructor(game: Game) {
    this._game = game;

    const aspect = document.documentElement.clientWidth / document.documentElement.clientHeight;
    this._gameCamera = new PerspectiveCamera(75, aspect, 0.1, 1000);
    this._spectatorCamera = new PerspectiveCamera(75, aspect, 0.1, 1000);

    this._activeCamera = this._spectatorCamera;
    this._activeViewDir = this._spectatorCameraViewDir;

    this._setupGameCamera();
    this._setupSpectatorCamera();
    this._setupEventListeners();
  }

  public get activeCamera(): PerspectiveCamera {
    return this._activeCamera;
  }

  public get far(): number {
    return this._activeCamera.far;
  }

  public get gameCamera(): PerspectiveCamera {
    return this._gameCamera;
  }

  public get gameCameraAttachedEntity(): Entity | undefined {
    return this._gameCameraAttachedEntity;
  }

  public get gameCameraYaw(): number {
    return this._gameCameraYaw;
  }

  public get isGameCameraActive(): boolean {
    return this._activeCamera === this._gameCamera;
  }

  public get near(): number {
    return this._activeCamera.near;
  }

  public get spectatorCamera(): PerspectiveCamera {
    return this._spectatorCamera;
  }

  public get activeViewDir(): Vector3 {
    return this._activeViewDir;
  }

  public get gameCameraMode(): CameraMode {
    return this._gameCameraMode;
  }

  public get isFirstPersonGameCameraActive(): boolean {
    return this._activeCamera === this._gameCamera && this._gameCameraMode === CameraMode.FIRST_PERSON;
  }

  public addChild(object3d: Object3D): void {
    this._gameCamera.add(object3d);
  }

  public handleMobileCameraMovement(movementX: number, movementY: number): void {
    if (this._gameCameraTrackedEntity || this._gameCameraTrackedPosition) {
      return;
    }
  
    this._updateCameraRotation(movementX, movementY, this._game.settingsManager.clientSettings.controls.touchSensitivityForRotation);
  }

  public handleMobileCameraZoom(delta: number): void {
    this._gameCameraSkipNextFilmOffsetInterpolation = true;
    this._updateCameraZoom(delta * this._game.settingsManager.clientSettings.controls.pinchSensitivityForZoom);
  }

  public rayForInteract(screenX: number, screenY: number): Ray {
    // Convert screen coordinate from pointer event to normalized device coordinate (-1 to 1)
    vec2.x = (screenX / window.innerWidth) * 2 - 1;
    vec2.y = -(screenY / window.innerHeight) * 2 + 1;

    this._raycaster.setFromCamera(vec2, this._activeCamera);
    
    // In third-person mode, move ray origin to the point on the ray closest to 
    // the attached entity if we have one. This prevents interacting with objects between the camera and 
    // player while preserving the click target direction.
    if (this._gameCameraMode === CameraMode.THIRD_PERSON && this._gameCameraAttachedEntity && this._activeCamera === this._gameCamera) {
      const entityPos = this._gameCameraAttachedEntity.getWorldPosition(vec3);
      this._raycaster.ray.closestPointToPoint(entityPos, vec3b);
      this._raycaster.ray.origin.copy(vec3b);
    }
    
    return this._raycaster.ray;
  }

  public onWindowResize(): void {
    const aspect = document.documentElement.clientWidth / document.documentElement.clientHeight;
    [this._gameCamera, this._spectatorCamera].forEach(camera => {
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
    });
  }

  public setMouseSensitivityMultiplier(multiplier: number): void {
    this._gameCameraMouseSensitivityMultiplier = multiplier;
    
    console.log('Camera: Mouse sensitivity multiplier set to:', multiplier);
  }

  public useGameCamera(): void {
    if (!this._gameCameraAttachedEntity && !this._gameCameraAttachedPosition) {
      return console.warn(`Camera.useGameCamera(): No camera attachment or position set for game camera.`);
    }

    this._activeCamera = this._gameCamera;
    this._activeViewDir = this._gameCameraViewDir;

    this._game.inputManager.enableNetworkedInput(true);

    // Add spatial audio listener to game camera
    this._game.audioManager.listener.removeFromParent();
    this._gameCamera.add(this._game.audioManager.listener);

    EventRouter.instance.emit(CameraEventType.UseGameCamera, {
      attachedTo: this._gameCameraAttachedEntity || this._gameCameraAttachedPosition!,
    });
  }

  public useSpectatorCamera(): void {
    this._activeCamera = this._spectatorCamera;
    this._activeViewDir = this._spectatorCameraViewDir;
   
    this._game.inputManager.enableNetworkedInput(false);

    // Add spatial audio listener to spectator camera
    this._game.audioManager.listener.removeFromParent();
    this._spectatorCamera.add(this._game.audioManager.listener);

    EventRouter.instance.emit(CameraEventType.UseSpectatorCamera, {});
  }

  public update(frameDeltaS: number): void {
    if (this._activeCamera === this._gameCamera) {
      this._updateGameCamera(frameDeltaS);
    }

    if (this._activeCamera === this._spectatorCamera) {
      this._updateSpectatorCamera(frameDeltaS);
    }

    this._updateMatrix(this._activeCamera);
  }

  private _setupEventListeners(): void {
    document.addEventListener('mousemove', this._onMouseMove);
    document.addEventListener('wheel', this._onWheel);
 
    this._game.inputManager.onPress(']', this._toggleSpectator);

    EventRouter.instance.on(
      NetworkManagerEventType.CameraPacket,
      this._onCameraPacket,
    );
  }

  private _onCameraPacket = (payload: NetworkManagerEventPayload.ICameraPacket): void => {
    const { deserializedCamera } = payload;

    if (typeof deserializedCamera.mode === 'number') {
      this._gameCameraMode = deserializedCamera.mode;
    }

    if (deserializedCamera.collidesWithBlocks !== undefined) {
      this._gameCameraCollidesWithBlocks = deserializedCamera.collidesWithBlocks;
    }

    if (deserializedCamera.modelPitchesWithCamera !== undefined) {
      this._gameCameraModelPitchesWithCamera = deserializedCamera.modelPitchesWithCamera;
    }
    
    if (deserializedCamera.modelYawsWithCamera !== undefined) {
      this._gameCameraModelYawsWithCamera = deserializedCamera.modelYawsWithCamera;
    }

    if (deserializedCamera.attachedToEntityId !== undefined) {
      if (deserializedCamera.attachedToEntityId !== null) {
        this._gameCameraAttachedPosition = undefined;
      }

      this._gameCameraAttachedEntity = deserializedCamera.attachedToEntityId !== null
        ? this._game.entityManager.getEntity(deserializedCamera.attachedToEntityId)
        : undefined;

      if (this._gameCameraAttachedEntity) {
        this._gameCameraAttachedEntity.setModelHiddenNodes(this._gameCameraAttachedEntityModelHiddenNodes);
        this._gameCameraAttachedEntity.setModelShownNodes(this._gameCameraAttachedEntityModelShownNodes);
        this.useGameCamera();
      } else {
        console.warn(`Camera._updateGameCamera(): Entity id ${deserializedCamera.attachedToEntityId} not found for camera attachment.`);
      }
    }

    if (deserializedCamera.attachedToPosition !== undefined) {
      if (deserializedCamera.attachedToPosition !== null) {
        if (this._gameCameraAttachedEntity) {
          this._gameCameraAttachedEntity.setModelHiddenNodes([]);
          this._gameCameraAttachedEntity.setModelShownNodes([]);
          this._gameCameraAttachedEntity = undefined;
        }
      }

      this._gameCameraAttachedPosition = deserializedCamera.attachedToPosition !== null
        ? new Vector3(
            deserializedCamera.attachedToPosition.x,
            deserializedCamera.attachedToPosition.y,
            deserializedCamera.attachedToPosition.z,
          )
        : undefined;

      this.useGameCamera();
    }
    
    if (deserializedCamera.filmOffset !== undefined) {
      this._gameCameraTargetFilmOffset = deserializedCamera.filmOffset;
    }

    if (deserializedCamera.forwardOffset !== undefined && deserializedCamera.forwardOffset !== this._gameCameraForwardOffset) {
      this._gameCameraForwardOffset = deserializedCamera.forwardOffset;

      if (this._gameCameraMode !== CameraMode.FIRST_PERSON) {
        console.warn(`Camera._updateGameCamera(): Forward offset is only supported in first person mode.`);
      }
    }

    if (deserializedCamera.fov !== undefined) {
      this._gameCameraTargetFov = deserializedCamera.fov;
    }

    if (deserializedCamera.modelHiddenNodes !== undefined) {
      this._gameCameraAttachedEntityModelHiddenNodes = deserializedCamera.modelHiddenNodes;
      this._gameCameraAttachedEntity?.setModelHiddenNodes(this._gameCameraAttachedEntityModelHiddenNodes);
    }

    if (deserializedCamera.modelShownNodes !== undefined) {
      this._gameCameraAttachedEntityModelShownNodes = deserializedCamera.modelShownNodes;
      this._gameCameraAttachedEntity?.setModelShownNodes(this._gameCameraAttachedEntityModelShownNodes);
    }

    if (deserializedCamera.lookAtPosition !== undefined) {
      this._gameCameraTrackedEntity = undefined;
      this._gameCameraTrackedPosition = undefined;
      this._gameCameraLookAtPosition = new Vector3(
        deserializedCamera.lookAtPosition.x,
        deserializedCamera.lookAtPosition.y,
        deserializedCamera.lookAtPosition.z,
      );
    }

    if (deserializedCamera.offset !== undefined) {
      const nextOffset = new Vector3(
        deserializedCamera.offset.x,
        deserializedCamera.offset.y,
        deserializedCamera.offset.z,
      );

      if (this._gameCameraMode === CameraMode.FIRST_PERSON) {
        const firstPersonOffsetChanged = !this._gameCameraFirstPersonOffset.equals(nextOffset);
        this._gameCameraFirstPersonOffset.copy(nextOffset);

        // First-person view model anchor depends on first-person camera offset.
        if (firstPersonOffsetChanged) {
          delete this._gameCameraAttachedEntity?.model?.userData.cameraViewModelBaseCameraOffset;
          this._gameCameraViewModelBaseCameraOffsets.clear();
        }
      } else {
        this._gameCameraThirdPersonOffset.copy(nextOffset);
      }
    }

    if (deserializedCamera.shoulderAngle !== undefined) { // shoulderAngle is received in degrees
      this._gameCameraShoulderRotationOffset.setFromAxisAngle(new Vector3(0, 1, 0), deserializedCamera.shoulderAngle * Math.PI / 180);
    }

    if (deserializedCamera.trackedEntityId !== undefined) {
      if (deserializedCamera.trackedEntityId !== null) {
        this._gameCameraTrackedPosition = undefined;
      }

      this._gameCameraTrackedEntity = deserializedCamera.trackedEntityId !== null
        ? this._game.entityManager.getEntity(deserializedCamera.trackedEntityId)
        : undefined;
    }

    if (deserializedCamera.trackedPosition !== undefined) {
      if (deserializedCamera.trackedPosition !== null) {
        this._gameCameraTrackedEntity = undefined;
      }

      this._gameCameraTrackedPosition = deserializedCamera.trackedPosition !== null
        ? new Vector3(
            deserializedCamera.trackedPosition.x,
            deserializedCamera.trackedPosition.y,
            deserializedCamera.trackedPosition.z,
          )
        : undefined;
    }

    if (deserializedCamera.zoom !== undefined) {
      this._gameCameraTargetZoom = deserializedCamera.zoom;
    }
  }

  private _onMouseMove = (event: MouseEvent): void => {
    if (
      this._gameCameraTrackedEntity ||
      this._gameCameraTrackedPosition ||
      !this._game.inputManager.isPointerLocked
    ) {
      return;
    }

    this._updateCameraRotation(event.movementX, event.movementY, this._game.settingsManager.clientSettings.controls.mouseSensitivityForRotation);
  }

  private _onWheel = (event: WheelEvent): void => {
    if (!this._game.inputManager.isPointerLocked) {
      return; // disable scroll zooming when not pointer locked
    }

    this._gameCameraSkipNextFilmOffsetInterpolation = true;

    // Normalize wheel delta for cross-platform consistency
    // Windows can have deltaY values of 100+, while other platforms use 1-2
    const normalizedDelta = Math.sign(event.deltaY) * Math.min(Math.abs(event.deltaY), 2);
    this._updateCameraZoom(normalizedDelta * this._game.settingsManager.clientSettings.controls.wheelSensitivityForZoom);
  }

  private _updateCameraRotation(movementX: number, movementY: number, rotationSpeed: number): void {
    const isGameCameraActive = this.isGameCameraActive;

    let cameraPitch = isGameCameraActive ? this._gameCameraPitch : this._spectatorCameraPitch;
    let cameraYaw = isGameCameraActive ? this._gameCameraYaw : this._spectatorCameraYaw;

    cameraPitch += movementY * rotationSpeed * this._gameCameraMouseSensitivityMultiplier;
    cameraYaw -= movementX * rotationSpeed * this._gameCameraMouseSensitivityMultiplier;

    // Clamp the pitch to avoid flipping & gimbal lock
    cameraPitch = Math.max(-Math.PI / 2 + 0.1, Math.min(Math.PI / 2 - 0.1, cameraPitch));

    if (isGameCameraActive) {
      this._updateGameCameraOrientation(cameraPitch, cameraYaw);
    } else {
      this._updateSpectatorCameraOrientation(cameraPitch, cameraYaw);
    }
  }

  private _updateCameraZoom(delta: number): void {
    if (this._activeCamera === this._gameCamera) {
      this._gameCameraRadialZoom = Math.max(
        MIN_ZOOM,
        Math.min(MAX_ZOOM, this._gameCameraRadialZoom + delta),
      );
    }
  }

  private _lookAt(camera: PerspectiveCamera, lookAtPosition: Vector3): void {
    // Temporarily enable matrixAutoUpdate and matrixWorldAutoUpdate so lookAt() updates the camera matrix automatically
    const currentMatrixAutoUpdate = camera.matrixAutoUpdate;
    const currentMatrixWorldAutoUpdate = camera.matrixWorldAutoUpdate;
    camera.matrixAutoUpdate = true;
    camera.matrixWorldAutoUpdate = true;
    camera.lookAt(lookAtPosition);
    camera.matrixAutoUpdate = currentMatrixAutoUpdate;
    camera.matrixWorldAutoUpdate = currentMatrixWorldAutoUpdate;

    this._updateViewDir(camera, camera === this._gameCamera ? this._gameCameraViewDir : this._spectatorCameraViewDir);
  }

  private _updateMatrix(camera: PerspectiveCamera): void {
    const currentMatrixAutoUpdate = camera.matrixAutoUpdate;
    const currentMatrixWorldAutoUpdate = camera.matrixWorldAutoUpdate;
    camera.matrixAutoUpdate = true;
    camera.matrixWorldAutoUpdate = true;
    camera.updateMatrixWorld();
    camera.matrixAutoUpdate = currentMatrixAutoUpdate;
    camera.matrixWorldAutoUpdate = currentMatrixWorldAutoUpdate;

    this._updateViewDir(camera, camera === this._gameCamera ? this._gameCameraViewDir : this._spectatorCameraViewDir);
  }

  private _updateViewDir(camera: PerspectiveCamera, viewDir: Vector3): void {
    const e = camera.matrixWorld.elements;
    viewDir.set(e[8], e[9], e[10]).normalize().negate();
  }

  private _setupGameCamera(): void {
    this._gameCamera.matrixAutoUpdate = false;
    this._gameCamera.matrixWorldAutoUpdate = false;
  }

  private _setupSpectatorCamera(): void {
    this._spectatorCamera.matrixAutoUpdate = false;
    this._spectatorCamera.matrixWorldAutoUpdate = false;
    this._spectatorCamera.position.set(-20, 20, 0);
    this._spectatorCamera.updateProjectionMatrix();
  }

  private _toggleSpectator = (): void => {
    if (this.isGameCameraActive) {
      this.useSpectatorCamera();
    } else {
      this.useGameCamera();
    }
  }

  private _updateGameCamera(frameDeltaS: number): void {
    if (!this._gameCameraAttachedEntity && !this._gameCameraAttachedPosition) {
      return console.warn(`Camera._updateGameCamera(): No camera attachment or position set for game camera.`);
    }

    // Get base positions for camera calculations
    const attachedPosition = this._gameCameraAttachedEntity?.getWorldPosition(vec3) || this._gameCameraAttachedPosition!;
    const lookAtPosition = this._gameCameraLookAtPosition || this._gameCameraTrackedEntity?.position || this._gameCameraTrackedPosition;
    let lookAtDirection: Vector3 | undefined;

    // Calculate look direction and orientation if we have a look target
    if (lookAtPosition) {
      lookAtDirection = new Vector3().subVectors(attachedPosition, lookAtPosition).normalize();

      this._updateGameCameraOrientation(
        Math.asin(lookAtDirection.y),
        Math.atan2(lookAtDirection.x, lookAtDirection.z) 
      );
    }

    // Handle film offset - scale by zoom to prevent crosshair drift
    const filmOffset = this._gameCamera.filmOffset;
    const zoomScale = this._gameCameraMode === CameraMode.THIRD_PERSON
      ? BASE_ZOOM / this._gameCameraRadialZoom
      : 1;
    const scaledTargetFilmOffset = this._gameCameraTargetFilmOffset * zoomScale;
    if (filmOffset !== scaledTargetFilmOffset) {
      if (this._gameCameraSkipNextFilmOffsetInterpolation) {
        // Apply immediately when skipping interpolation
        this._gameCamera.filmOffset = scaledTargetFilmOffset;
        this._gameCameraSkipNextFilmOffsetInterpolation = false;
      } else {
        // Interpolate smoothly for normal film offset changes
        const filmOffsetLerpFactor = Math.min(frameDeltaS / CAMERA_LERP_TIME, 1);
        this._gameCamera.filmOffset = filmOffset + (scaledTargetFilmOffset - filmOffset) * filmOffsetLerpFactor;
      }
    }

    // Handle fov
    const fov = this._gameCamera.fov;
    const targetFov = this._gameCameraTargetFov;
    if (fov !== targetFov) {
      const fovLerpFactor = Math.min(frameDeltaS / CAMERA_LERP_TIME, 1);
      this._gameCamera.fov = fov + (targetFov - fov) * fovLerpFactor;
    }

    // Handle zoom
    const zoom = this._gameCamera.zoom;
    const targetZoom = this._gameCameraTargetZoom;
    if (zoom !== targetZoom) {
      const zoomLerpFactor = Math.min(frameDeltaS / CAMERA_LERP_TIME, 1);
      this._gameCamera.zoom = zoom + (targetZoom - zoom) * zoomLerpFactor;
    }

    // Position and orient camera based on mode
    if (this._gameCameraMode === CameraMode.FIRST_PERSON) {
      // Calculate and apply orientation
      const quaternion = tempQuat.setFromEuler(
        modelViewEuler.set(-this._gameCameraPitch, this._gameCameraYaw, 0, 'YXZ'),
      );

      // First-person offset is camera-local so camera/view-model relation is stable.
      this._gameCamera.position.copy(attachedPosition)
        .add(vec3b.copy(this._gameCameraFirstPersonOffset).applyQuaternion(quaternion));

      // Apply forward offset
      const direction = vec3c.set(
        0,
        this._gameCameraForwardOffset >= 0 ? this._gameCameraForwardOffset : 0,
        this._gameCameraForwardOffset >= 0 ? 0 : -this._gameCameraForwardOffset,
      ).applyQuaternion(quaternion);

      this._gameCamera.position.add(direction);
      this._gameCamera.quaternion.copy(quaternion);

      if (lookAtPosition) {
        this._lookAt(this._gameCamera, lookAtPosition);
      }
    }

    if (this._gameCameraMode === CameraMode.THIRD_PERSON) {
      const radius = this._gameCameraRadialZoom - 1;
      const heightOffset = 1.25;
      const lookAtTarget = (lookAtPosition || attachedPosition).clone();
      
      // Default +y 0.5 offset for better default player perspective for now.
      // Devs can adjust this with their own provided offset for gameCameraOffset in the sdk.
      lookAtTarget.y += 0.5;

      // Position camera based on look direction or orientation
      if (lookAtDirection) {
        this._gameCamera.position.copy(attachedPosition)
          .addScaledVector(lookAtDirection, -radius)
          .setY(this._gameCamera.position.y + heightOffset);
      } else {
        this._gameCamera.position.set(
          attachedPosition.x + radius * Math.sin(this._gameCameraYaw) * Math.cos(this._gameCameraPitch),
          attachedPosition.y + radius * Math.sin(this._gameCameraPitch) + heightOffset,
          attachedPosition.z + radius * Math.cos(this._gameCameraYaw) * Math.cos(this._gameCameraPitch)
        );
      }

      // Apply visual rotation to camera position around the look target (skip if no rotation, if not identity quat)
      if (this._gameCameraShoulderRotationOffset.w !== 1) {
        const positionOffset = this._gameCamera.position.clone().sub(lookAtTarget);
        positionOffset.applyQuaternion(this._gameCameraShoulderRotationOffset);
        this._gameCamera.position.copy(lookAtTarget).add(positionOffset);
      }

      // Third-person offset shifts perspective while preserving orbit around the target.
      if (this._gameCameraThirdPersonOffset.lengthSq() > 0) {
        yawOnlyEuler.set(0, this._gameCameraYaw, 0, 'YXZ');
        positionQuat.setFromEuler(yawOnlyEuler);
        this._gameCamera.position.add(vec3b.copy(this._gameCameraThirdPersonOffset).applyQuaternion(positionQuat));
      }

      // Check for block collision and move camera closer if needed
      const direction = vec3b.subVectors(this._gameCamera.position, lookAtTarget).normalize();
      const desiredDistance = this._gameCamera.position.distanceTo(lookAtTarget);

      if (this._gameCameraCollidesWithBlocks) {
        this._raycaster.set(lookAtTarget, direction);
        this._raycaster.far = desiredDistance;
        
        const collisionMeshes = this._game.chunkMeshManager.solidMeshesInScene;
        // Determine target distance based on collision
        let targetDistance = desiredDistance;
        const intersects = this._raycaster.intersectObjects(collisionMeshes, false);
        if (intersects.length > 0) {
          // Account for near plane so the camera frustum doesn't graze the block face.
          const nearPadding = this._gameCamera.near + 0.1;
          targetDistance = Math.max(0.5, intersects[0].distance - nearPadding);
        }
        
        // Smooth camera movement both in/out to reduce jarring jumps.
        const inSpeed = 20.0;  // Faster to avoid noticeable clipping.
        const outSpeed = 10.0; // Slower for smooth recovery.
        const delta = targetDistance - this._gameCameraCollisionDistance;
        if (delta !== 0) {
          const maxStep = frameDeltaS * (delta < 0 ? inSpeed : outSpeed);
          const step = Math.sign(delta) * Math.min(Math.abs(delta), maxStep);
          this._gameCameraCollisionDistance += step;
        }
        
        // Apply the collision distance if it's less than desired
        if (this._gameCameraCollisionDistance < desiredDistance) {
          this._gameCamera.position.copy(lookAtTarget).addScaledVector(direction, this._gameCameraCollisionDistance);
        } else {
          // Reset collision distance when no longer constrained
          this._gameCameraCollisionDistance = desiredDistance;
        }
      } else {
        // Reset collision distance when collision is disabled.
        this._gameCameraCollisionDistance = desiredDistance;
      }

      // Look at target - this maintains proper orientation
      this._lookAt(this._gameCamera, lookAtTarget);
    }

    if (this._gameCameraMode === CameraMode.SPECTATOR) {
      this.useSpectatorCamera();
    }

    this._gameCameraLookAtPosition = undefined;

    // Apply pitch to attached entity's model if enabled
    // Rotate around the camera pivot so the model stays fixed on screen
    if (this._gameCameraAttachedEntity) {
      const entity = this._gameCameraAttachedEntity;
      const model = entity.model;

      const basePosition = model?.userData.cameraViewModelBasePosition as Vector3 | undefined;
      const baseQuaternion = model?.userData.cameraViewModelBaseQuaternion as Quaternion | undefined;
      const baseCameraOffset = model?.userData.cameraViewModelBaseCameraOffset as Vector3 | undefined;

      if (model && (this._gameCameraMode === CameraMode.FIRST_PERSON || this._gameCameraModelPitchesWithCamera || this._gameCameraModelYawsWithCamera)) {
        if (!basePosition) {
          model.userData.cameraViewModelBasePosition = model.position.clone();
        }
        const resolvedBaseQuaternion = baseQuaternion ?? (model.userData.cameraViewModelBaseQuaternion = model.quaternion.clone());

        const pitch = this._gameCameraModelPitchesWithCamera ? -this._gameCameraPitch : 0;
        let yaw = 0;
        if (this._gameCameraModelYawsWithCamera) {
          const entityYaw = entityYawEuler.setFromQuaternion(entity.entityRoot.quaternion, 'YXZ').y;
          yaw = normalizeAngle(this._gameCameraYaw - entityYaw);
        }

        modelViewEuler.set(pitch, yaw, 0, 'YXZ');
        modelViewQuat.setFromEuler(modelViewEuler);

        if (this._gameCameraMode === CameraMode.FIRST_PERSON) {
          const modelAnchorPosition = this._gameCamera.position;
          const modelBaseCameraOffsetCacheKey = entity.modelUri ? `${entity.id}:${entity.modelUri}` : undefined;
          const cachedBaseCameraOffset = modelBaseCameraOffsetCacheKey
            ? this._gameCameraViewModelBaseCameraOffsets.get(modelBaseCameraOffsetCacheKey)
            : undefined;
          let resolvedBaseCameraOffset = baseCameraOffset ?? cachedBaseCameraOffset;
          if (!resolvedBaseCameraOffset) {
            model.getWorldPosition(vec3b).sub(modelAnchorPosition);
            tempQuat.copy(this._gameCamera.quaternion).invert();
            vec3b.applyQuaternion(tempQuat);
            resolvedBaseCameraOffset = vec3b.clone();
          }

          if (!baseCameraOffset) {
            model.userData.cameraViewModelBaseCameraOffset = resolvedBaseCameraOffset.clone();
          }

          if (modelBaseCameraOffsetCacheKey && !cachedBaseCameraOffset) {
            this._gameCameraViewModelBaseCameraOffsets.set(modelBaseCameraOffsetCacheKey, resolvedBaseCameraOffset.clone());
          }

          // Use full camera orientation for first-person anchoring so the model
          // stays fixed in view when pitching.
          positionQuat.copy(this._gameCamera.quaternion);

          vec3.copy(resolvedBaseCameraOffset)
            .applyQuaternion(positionQuat)
            .add(modelAnchorPosition);
          entity.entityRoot.worldToLocal(vec3);
          model.position.copy(vec3);
        } else if (basePosition) {
          // Third-person: keep the model anchored to its base position.
          model.position.copy(basePosition);
        }

        model.quaternion.copy(modelViewQuat).multiply(resolvedBaseQuaternion);
        model.updateMatrix();
        model.updateMatrixWorld(true);
      } else if (model) {
        if (basePosition && baseQuaternion) {
          model.position.copy(basePosition);
          model.quaternion.copy(baseQuaternion);
          model.updateMatrix();
          model.updateMatrixWorld(true);
        }
      }
    }
    
    this._gameCamera.updateProjectionMatrix();
  }

  private _updateGameCameraOrientation(pitch: number, yaw: number): void {
    this._gameCameraPitch = pitch;
    this._gameCameraYaw = yaw;

    EventRouter.instance.emit(CameraEventType.GameCameraOrientationChange, {
      pitch: -1 * this._gameCameraPitch,
      yaw: this._gameCameraYaw,
    });
  }

  private _updateSpectatorCameraOrientation(pitch: number, yaw: number): void {
    this._spectatorCameraPitch = pitch;
    this._spectatorCameraYaw = yaw;
  }

  private _updateSpectatorCamera(frameDeltaS: number): void {
    if (this._activeCamera !== this._spectatorCamera) return;

    const inputState = this._game.inputManager.inputState;
    const moveSpeed = 15 * frameDeltaS;

    // Get camera direction vectors
    const forward = new Vector3(0, 0, -1).applyEuler(this._spectatorCamera.rotation);
    const right = new Vector3(1, 0, 0).applyEuler(this._spectatorCamera.rotation);

    // Handle movement
    if (inputState['w']) this._spectatorCamera.position.addScaledVector(forward, moveSpeed);
    if (inputState['s']) this._spectatorCamera.position.addScaledVector(forward, -moveSpeed);
    if (inputState['a']) this._spectatorCamera.position.addScaledVector(right, -moveSpeed);
    if (inputState['d']) this._spectatorCamera.position.addScaledVector(right, moveSpeed);
    if (inputState['sp']) this._spectatorCamera.position.y += moveSpeed;
    if (inputState['sh']) this._spectatorCamera.position.y -= moveSpeed;

    // Update camera rotation
    this._spectatorCamera.rotation.set(-this._spectatorCameraPitch, this._spectatorCameraYaw, 0, 'YXZ');
  }
}
