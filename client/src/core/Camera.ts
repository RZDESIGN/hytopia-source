import { Euler, Intersection, Object3D, OrthographicCamera, PerspectiveCamera, Quaternion, Raycaster, Vector2, Vector3 } from "three";
import Entity from "../entities/Entity";
import EventRouter from '../events/EventRouter';
import Game from "../Game";
import MobileManager from '../mobile/MobileManager';
import type { NetworkManagerEventPayload } from '../network/NetworkEventPayloads';
import { NetworkManagerEventType } from '../network/NetworkEvents';
import type { Ray } from 'three';

const BASE_ZOOM = 3.5;
const MIN_ZOOM = 3.0;
const MAX_ZOOM = 10.0;
const INITIAL_ZOOM = 6.0;
const CAMERA_LERP_TIME = 0.2;
const CAMERA_COLLISION_RAYCAST_INTERVAL_DESKTOP_S = 1 / 30;
const CAMERA_COLLISION_RAYCAST_INTERVAL_MOBILE_S = 1 / 15;
const CAMERA_COLLISION_RAYCAST_ORIGIN_DELTA_SQ_THRESHOLD = 0.1 * 0.1;
const CAMERA_COLLISION_RAYCAST_DIRECTION_DOT_THRESHOLD = 0.9995;
const CAMERA_COLLISION_RAYCAST_DISTANCE_DELTA_THRESHOLD = 0.1;
const CAMERA_ORIENTATION_EPSILON = 0.0001;
const CAMERA_TRACKED_POSITION_LERP_TIME_S = 0.08;
const CAMERA_TRACKED_POSITION_SNAP_DISTANCE_SQ = 4;
const CAMERA_ATTACHED_POSITION_LERP_TIME_S = 0.06;
const CAMERA_ATTACHED_POSITION_SNAP_DISTANCE_SQ = 9;
const CAMERA_POSITION_DEADZONE_SQ = 0.0004; // 2cm
const CAMERA_LOOK_AT_MIN_DISTANCE_SQ = 0.0004;
const ORTHOGRAPHIC_HALF_HEIGHT = 7.5;
const DYNAMIC_CAMERA_OFFSET_SPACE_ENTITY = 1;
const SUPPORTS_POINTER_RAW_UPDATE = typeof window !== 'undefined' && 'onpointerrawupdate' in window;

// Working variables
const vec2 = new Vector2();
const vec3 = new Vector3();
const vec3b = new Vector3();
const vec3c = new Vector3();
const vec3d = new Vector3();
const vec3e = new Vector3();
const vec3f = new Vector3();
const modelViewEuler = new Euler(0, 0, 0, 'YXZ');
const yawOnlyEuler = new Euler(0, 0, 0, 'YXZ');
const entityYawEuler = new Euler(0, 0, 0, 'YXZ');
const modelViewQuat = new Quaternion();
const tempQuat = new Quaternion();
const positionQuat = new Quaternion();
const shoulderRotationAxis = new Vector3(0, 1, 0);
const spectatorForward = new Vector3();
const spectatorRight = new Vector3();
const cameraCollisionIntersections: Intersection<Object3D>[] = [];

const normalizeAngle = (radians: number): number => Math.atan2(Math.sin(radians), Math.cos(radians));
const smoothingAlpha = (deltaS: number, timeConstantS: number): number => 1 - Math.exp(-deltaS / Math.max(0.001, timeConstantS));
type ProjectionCamera = PerspectiveCamera | OrthographicCamera;

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

  private _activeCamera: ProjectionCamera;
  private _activeViewDir: Vector3;

  private _gameCamera: ProjectionCamera;
  private _gamePerspectiveCamera: PerspectiveCamera;
  private _gameOrthographicCamera: OrthographicCamera;
  private _gameCameraMode: CameraMode = CameraMode.THIRD_PERSON;
  private _gameCameraUsesOrthographicProjection: boolean = false;
  private _gameCameraAttachedEntity: Entity | undefined;
  private _gameCameraAttachedEntityModelHiddenNodes: string[] = [];
  private _gameCameraAttachedEntityModelShownNodes: string[] = [];
  private _gameCameraAttachedPosition: Vector3 | undefined;
  private _gameCameraAttachedPositionTarget: Vector3 | undefined;
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
  private _gameCameraTrackedPositionTarget: Vector3 | undefined;
  private _gameCameraDynamicFollowEntityId: number | null | undefined;
  private _gameCameraDynamicFollowOffset: Vector3 | undefined;
  private _gameCameraDynamicFollowFocusOffset: Vector3 | undefined;
  private _gameCameraDynamicFollowOffsetSpace: number | undefined;
  private _gameCameraViewModelBaseCameraOffsets: Map<string, Vector3> = new Map();
  private _gameCameraPitch: number = 0.2;
  private _gameCameraShoulderRotationOffset: Quaternion = new Quaternion();
  private _gameCameraSkipNextFilmOffsetInterpolation: boolean = false;
  private _gameCameraYaw: number = 0;
  private _gameCameraViewDir: Vector3 = new Vector3();
  private _gameCameraCollisionDistance: number = Infinity; // Current collision-adjusted distance
  private _gameCameraCollisionTargetDistance: number = Infinity;
  private _gameCameraCollisionRaycastHasSample: boolean = false;
  private _gameCameraCollisionRaycastIntervalRemainingS: number = 0;
  private _gameCameraCollisionRaycastIntervalS: number =
    MobileManager.isMobile
      ? CAMERA_COLLISION_RAYCAST_INTERVAL_MOBILE_S
      : CAMERA_COLLISION_RAYCAST_INTERVAL_DESKTOP_S;
  private _gameCameraCollisionRaycastDesiredDistance: number = 0;
  private _gameCameraCollisionRaycastOrigin: Vector3 = new Vector3();
  private _gameCameraCollisionRaycastDirection: Vector3 = new Vector3();
  private _gameCameraShoulderPositionOffset: Vector3 = new Vector3();
  private _smoothedLocalPredictedEntity: Entity | undefined;

  private _spectatorCamera: PerspectiveCamera;
  private _spectatorCameraPitch: number = 0;
  private _spectatorCameraYaw: number = 0;
  private _spectatorCameraViewDir: Vector3 = new Vector3();

  private _raycaster: Raycaster = new Raycaster();
    
  public constructor(game: Game) {
    this._game = game;

    const aspect = document.documentElement.clientWidth / document.documentElement.clientHeight;
    this._gamePerspectiveCamera = new PerspectiveCamera(75, aspect, 0.1, 1000);
    this._gameOrthographicCamera = new OrthographicCamera(
      -aspect * ORTHOGRAPHIC_HALF_HEIGHT,
      aspect * ORTHOGRAPHIC_HALF_HEIGHT,
      ORTHOGRAPHIC_HALF_HEIGHT,
      -ORTHOGRAPHIC_HALF_HEIGHT,
      0.1,
      1000,
    );
    this._gameCamera = this._gamePerspectiveCamera;
    this._spectatorCamera = new PerspectiveCamera(75, aspect, 0.1, 1000);

    this._activeCamera = this._spectatorCamera;
    this._activeViewDir = this._spectatorCameraViewDir;

    this._setupGameCamera();
    this._setupSpectatorCamera();
    this._setupEventListeners();
  }

  public get activeCamera(): ProjectionCamera {
    return this._activeCamera;
  }

  public get far(): number {
    return this._activeCamera.far;
  }

  public get gameCamera(): ProjectionCamera {
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

  public get isOrthographicGameCameraActive(): boolean {
    return this.isGameCameraActive && this._gameCameraUsesOrthographicProjection;
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

  public handleGamepadCameraMovement(axisX: number, axisY: number, frameDeltaS: number): void {
    if (this._gameCameraTrackedEntity || this._gameCameraTrackedPosition) {
      return;
    }

    const rotationSpeed = this._game.settingsManager.clientSettings.controls.gamepadSensitivityForRotation;
    this._applyCameraRotationDelta(
      axisY * rotationSpeed * frameDeltaS * this._gameCameraMouseSensitivityMultiplier,
      -axisX * rotationSpeed * frameDeltaS * this._gameCameraMouseSensitivityMultiplier,
    );
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
    this._gamePerspectiveCamera.aspect = aspect;
    this._gamePerspectiveCamera.updateProjectionMatrix();
    this._spectatorCamera.aspect = aspect;
    this._spectatorCamera.updateProjectionMatrix();
    this._updateOrthographicGameCameraFrustum();
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

  private _updateOrthographicGameCameraFrustum(): void {
    const aspect = document.documentElement.clientWidth / document.documentElement.clientHeight;
    this._gameOrthographicCamera.left = -aspect * ORTHOGRAPHIC_HALF_HEIGHT;
    this._gameOrthographicCamera.right = aspect * ORTHOGRAPHIC_HALF_HEIGHT;
    this._gameOrthographicCamera.top = ORTHOGRAPHIC_HALF_HEIGHT;
    this._gameOrthographicCamera.bottom = -ORTHOGRAPHIC_HALF_HEIGHT;
    this._gameOrthographicCamera.updateProjectionMatrix();
  }

  private _setGameProjectionFromTargetFov(targetFov: number): void {
    const useOrthographicProjection = targetFov <= 0;
    const nextGameCamera = useOrthographicProjection ? this._gameOrthographicCamera : this._gamePerspectiveCamera;

    if (this._gameCamera === nextGameCamera && this._gameCameraUsesOrthographicProjection === useOrthographicProjection) {
      if (useOrthographicProjection) {
        this._updateOrthographicGameCameraFrustum();
      }

      return;
    }

    const previousGameCamera = this._gameCamera;
    const wasGameCameraActive = this._activeCamera === previousGameCamera;

    nextGameCamera.position.copy(previousGameCamera.position);
    nextGameCamera.quaternion.copy(previousGameCamera.quaternion);
    nextGameCamera.zoom = previousGameCamera.zoom;
    nextGameCamera.near = previousGameCamera.near;
    nextGameCamera.far = previousGameCamera.far;

    while (previousGameCamera.children.length > 0) {
      nextGameCamera.add(previousGameCamera.children[0]);
    }

    this._gameCameraUsesOrthographicProjection = useOrthographicProjection;
    this._gameCamera = nextGameCamera;

    if (useOrthographicProjection) {
      this._updateOrthographicGameCameraFrustum();
    } else {
      this._gamePerspectiveCamera.updateProjectionMatrix();
    }

    if (wasGameCameraActive) {
      this._activeCamera = this._gameCamera;
      this._activeViewDir = this._gameCameraViewDir;
    }
  }

  public update(frameDeltaS: number): void {
    this._updateOwnerVisualSmoothingBinding();

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
    if (SUPPORTS_POINTER_RAW_UPDATE) {
      document.addEventListener('pointerrawupdate', this._onPointerRawUpdate);
    }
    document.addEventListener('wheel', this._onWheel);
 
    this._game.inputManager.onPress(']', this._toggleSpectator);

    EventRouter.instance.on(
      NetworkManagerEventType.CameraPacket,
      this._onCameraPacket,
    );
  }

  private _onCameraPacket = (payload: NetworkManagerEventPayload.ICameraPacket): void => {
    const { deserializedCamera } = payload;
    const previousAttachedEntity = this._gameCameraAttachedEntity;

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
        this._gameCameraAttachedPositionTarget = undefined;
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
      if (deserializedCamera.attachedToPosition === null) {
        this._gameCameraAttachedPosition = undefined;
        this._gameCameraAttachedPositionTarget = undefined;
      } else {
        if (this._gameCameraAttachedEntity) {
          this._gameCameraAttachedEntity.setModelHiddenNodes([]);
          this._gameCameraAttachedEntity.setModelShownNodes([]);
          this._gameCameraAttachedEntity = undefined;
        }

        this._gameCameraAttachedPositionTarget ??= new Vector3();
        this._gameCameraAttachedPositionTarget.set(
          deserializedCamera.attachedToPosition.x,
          deserializedCamera.attachedToPosition.y,
          deserializedCamera.attachedToPosition.z,
        );

        if (!this._gameCameraAttachedPosition) {
          this._gameCameraAttachedPosition = new Vector3().copy(this._gameCameraAttachedPositionTarget);
        } else if (this._shouldSkipPositionCameraSmoothing()) {
          this._gameCameraAttachedPosition.copy(this._gameCameraAttachedPositionTarget);
        } else if (
          this._gameCameraAttachedPosition.distanceToSquared(this._gameCameraAttachedPositionTarget)
          > CAMERA_ATTACHED_POSITION_SNAP_DISTANCE_SQ
        ) {
          // Snap large jumps (teleports) immediately.
          this._gameCameraAttachedPosition.copy(this._gameCameraAttachedPositionTarget);
        }
      }

      this.useGameCamera();
    }

    if (deserializedCamera.dynamicFollowEntityId !== undefined) {
      this._gameCameraDynamicFollowEntityId = deserializedCamera.dynamicFollowEntityId;
      if (deserializedCamera.dynamicFollowEntityId === null) {
        this._gameCameraDynamicFollowOffset = undefined;
        this._gameCameraDynamicFollowFocusOffset = undefined;
        this._gameCameraDynamicFollowOffsetSpace = undefined;
      }
    }

    if (deserializedCamera.dynamicFollowOffset !== undefined) {
      this._gameCameraDynamicFollowOffset = deserializedCamera.dynamicFollowOffset
        ? new Vector3(
          deserializedCamera.dynamicFollowOffset.x,
          deserializedCamera.dynamicFollowOffset.y,
          deserializedCamera.dynamicFollowOffset.z,
        )
        : undefined;
    }

    if (deserializedCamera.dynamicFollowFocusOffset !== undefined) {
      this._gameCameraDynamicFollowFocusOffset = deserializedCamera.dynamicFollowFocusOffset
        ? new Vector3(
          deserializedCamera.dynamicFollowFocusOffset.x,
          deserializedCamera.dynamicFollowFocusOffset.y,
          deserializedCamera.dynamicFollowFocusOffset.z,
        )
        : undefined;
    }

    if (deserializedCamera.dynamicFollowOffsetSpace !== undefined) {
      this._gameCameraDynamicFollowOffsetSpace = deserializedCamera.dynamicFollowOffsetSpace ?? undefined;
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
      this._setGameProjectionFromTargetFov(deserializedCamera.fov);
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
      this._gameCameraShoulderRotationOffset.setFromAxisAngle(shoulderRotationAxis, deserializedCamera.shoulderAngle * Math.PI / 180);
    }

    if (deserializedCamera.trackedEntityId !== undefined) {
      // Target entity/position are mutually exclusive.
      this._gameCameraTrackedPosition = undefined;
      this._gameCameraTrackedPositionTarget = undefined;

      this._gameCameraTrackedEntity = deserializedCamera.trackedEntityId !== null
        ? this._game.entityManager.getEntity(deserializedCamera.trackedEntityId)
        : undefined;
    }

    if (deserializedCamera.trackedPosition !== undefined) {
      // Target entity/position are mutually exclusive.
      this._gameCameraTrackedEntity = undefined;

      if (deserializedCamera.trackedPosition === null) {
        this._gameCameraTrackedPosition = undefined;
        this._gameCameraTrackedPositionTarget = undefined;
      } else {
        this._gameCameraTrackedPositionTarget ??= new Vector3();
        this._gameCameraTrackedPositionTarget.set(
          deserializedCamera.trackedPosition.x,
          deserializedCamera.trackedPosition.y,
          deserializedCamera.trackedPosition.z,
        );

        if (!this._gameCameraTrackedPosition) {
          this._gameCameraTrackedPosition = new Vector3().copy(this._gameCameraTrackedPositionTarget);
        } else if (this._shouldSkipPositionCameraSmoothing()) {
          this._gameCameraTrackedPosition.copy(this._gameCameraTrackedPositionTarget);
        } else if (
          this._gameCameraTrackedPosition.distanceToSquared(this._gameCameraTrackedPositionTarget)
          > CAMERA_TRACKED_POSITION_SNAP_DISTANCE_SQ
        ) {
          // Snap large jumps (teleports) immediately instead of smoothing through walls/geometry.
          this._gameCameraTrackedPosition.copy(this._gameCameraTrackedPositionTarget);
        }
      }
    }

    if (deserializedCamera.zoom !== undefined) {
      this._gameCameraTargetZoom = deserializedCamera.zoom;
    }

    if (
      deserializedCamera.mode !== undefined ||
      deserializedCamera.attachedToEntityId !== undefined ||
      deserializedCamera.attachedToPosition !== undefined
    ) {
      this._refreshAttachedEntityViewModelState(previousAttachedEntity);
      if (this._gameCameraAttachedEntity !== previousAttachedEntity) {
        this._refreshAttachedEntityViewModelState(this._gameCameraAttachedEntity);
      }
    }
  }

  private _refreshAttachedEntityViewModelState(entity: Entity | undefined): void {
    const model = entity?.model;
    if (!model) {
      return;
    }

    delete model.userData.cameraViewModelBasePosition;
    delete model.userData.cameraViewModelBaseQuaternion;
    delete model.userData.cameraViewModelBaseCameraOffset;
    entity.refreshModelOffset();
  }

  private _onMouseMove = (event: MouseEvent): void => {
    if (SUPPORTS_POINTER_RAW_UPDATE || !this._canProcessPointerLook()) {
      return;
    }

    this._applyPointerLook(event.movementX, event.movementY);
  }

  private _onPointerRawUpdate = (rawEvent: Event): void => {
    const event = rawEvent as PointerEvent;

    if (event.pointerType !== 'mouse' || !this._canProcessPointerLook()) {
      return;
    }

    this._applyPointerLook(event.movementX, event.movementY);
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
    this._applyCameraRotationDelta(
      movementY * rotationSpeed * this._gameCameraMouseSensitivityMultiplier,
      -movementX * rotationSpeed * this._gameCameraMouseSensitivityMultiplier,
    );
  }

  private _applyPointerLook(movementX: number, movementY: number): void {
    this._updateCameraRotation(
      movementX,
      movementY,
      this._game.settingsManager.clientSettings.controls.mouseSensitivityForRotation,
    );
  }

  private _canProcessPointerLook(): boolean {
    return !this._gameCameraTrackedEntity &&
      !this._gameCameraTrackedPosition &&
      this._game.inputManager.isPointerLocked;
  }

  private _applyCameraRotationDelta(deltaPitch: number, deltaYaw: number): void {
    const isGameCameraActive = this.isGameCameraActive;
    const pitchDirection = this._game.settingsManager.clientSettings.controls.invertVerticalLook ? -1 : 1;

    let cameraPitch = isGameCameraActive ? this._gameCameraPitch : this._spectatorCameraPitch;
    let cameraYaw = isGameCameraActive ? this._gameCameraYaw : this._spectatorCameraYaw;

    cameraPitch += deltaPitch * pitchDirection;
    cameraYaw += deltaYaw;

    // Clamp the pitch to avoid flipping & gimbal lock
    cameraPitch = Math.max(-Math.PI / 2 + 0.1, Math.min(Math.PI / 2 - 0.1, cameraPitch));

    if (isGameCameraActive) {
      this._updateGameCameraOrientation(cameraPitch, cameraYaw);
    } else {
      this._updateSpectatorCameraOrientation(cameraPitch, cameraYaw);
    }
  }

  private _updateCameraZoom(delta: number): void {
    if (this._activeCamera === this._gameCamera && !this._gameCameraUsesOrthographicProjection) {
      this._gameCameraRadialZoom = Math.max(
        MIN_ZOOM,
        Math.min(MAX_ZOOM, this._gameCameraRadialZoom + delta),
      );
    }
  }

  private _lookAt(camera: ProjectionCamera, lookAtPosition: Vector3): void {
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

  private _updateMatrix(camera: ProjectionCamera): void {
    const currentMatrixAutoUpdate = camera.matrixAutoUpdate;
    const currentMatrixWorldAutoUpdate = camera.matrixWorldAutoUpdate;
    camera.matrixAutoUpdate = true;
    camera.matrixWorldAutoUpdate = true;
    camera.updateMatrixWorld();
    camera.matrixAutoUpdate = currentMatrixAutoUpdate;
    camera.matrixWorldAutoUpdate = currentMatrixWorldAutoUpdate;

    this._updateViewDir(camera, camera === this._gameCamera ? this._gameCameraViewDir : this._spectatorCameraViewDir);
  }

  private _updateViewDir(camera: ProjectionCamera, viewDir: Vector3): void {
    const e = camera.matrixWorld.elements;
    viewDir.set(e[8], e[9], e[10]).normalize().negate();
  }

  private _setupGameCamera(): void {
    this._gamePerspectiveCamera.matrixAutoUpdate = false;
    this._gamePerspectiveCamera.matrixWorldAutoUpdate = false;
    this._gamePerspectiveCamera.updateProjectionMatrix();

    this._gameOrthographicCamera.matrixAutoUpdate = false;
    this._gameOrthographicCamera.matrixWorldAutoUpdate = false;
    this._updateOrthographicGameCameraFrustum();

    this._setGameProjectionFromTargetFov(this._gameCameraTargetFov);
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

  private _shouldSampleGameCameraCollision(
    lookAtTarget: Vector3,
    direction: Vector3,
    desiredDistance: number,
    frameDeltaS: number,
  ): boolean {
    this._gameCameraCollisionRaycastIntervalRemainingS = Math.max(
      0,
      this._gameCameraCollisionRaycastIntervalRemainingS - frameDeltaS,
    );

    if (!this._gameCameraCollisionRaycastHasSample) {
      return true;
    }

    if (this._gameCameraCollisionRaycastIntervalRemainingS <= 0) {
      return true;
    }

    if (
      lookAtTarget.distanceToSquared(this._gameCameraCollisionRaycastOrigin)
      > CAMERA_COLLISION_RAYCAST_ORIGIN_DELTA_SQ_THRESHOLD
    ) {
      return true;
    }

    if (
      direction.dot(this._gameCameraCollisionRaycastDirection)
      < CAMERA_COLLISION_RAYCAST_DIRECTION_DOT_THRESHOLD
    ) {
      return true;
    }

    return Math.abs(desiredDistance - this._gameCameraCollisionRaycastDesiredDistance)
      > CAMERA_COLLISION_RAYCAST_DISTANCE_DELTA_THRESHOLD;
  }

  private _sampleGameCameraCollisionDistance(
    lookAtTarget: Vector3,
    direction: Vector3,
    desiredDistance: number,
  ): void {
    this._raycaster.set(lookAtTarget, direction);
    this._raycaster.far = desiredDistance;

    let targetDistance = desiredDistance;
    cameraCollisionIntersections.length = 0;
    const nearbySolidMeshes = this._game.chunkMeshManager.getSolidMeshesNear(lookAtTarget, desiredDistance);
    this._raycaster.intersectObjects(nearbySolidMeshes, false, cameraCollisionIntersections);
    if (cameraCollisionIntersections.length > 0) {
      // Account for near plane so the camera frustum doesn't graze the block face.
      const nearPadding = this._gameCamera.near + 0.1;
      targetDistance = Math.max(0.5, cameraCollisionIntersections[0].distance - nearPadding);
    }

    this._gameCameraCollisionTargetDistance = targetDistance;
    this._gameCameraCollisionRaycastOrigin.copy(lookAtTarget);
    this._gameCameraCollisionRaycastDirection.copy(direction);
    this._gameCameraCollisionRaycastDesiredDistance = desiredDistance;
    this._gameCameraCollisionRaycastIntervalRemainingS = this._gameCameraCollisionRaycastIntervalS;
    this._gameCameraCollisionRaycastHasSample = true;
  }

  private _getLocallyPredictedDynamicFollowEntity(): Entity | undefined {
    const localPredictedEntity = this._game.entityManager.localPredictedEntity;
    if (!localPredictedEntity) {
      return undefined;
    }

    return this._gameCameraDynamicFollowEntityId === localPredictedEntity.id
      ? localPredictedEntity
      : undefined;
  }

  private _resolveOwnerVisualSmoothingEntity(): Entity | undefined {
    if (this._activeCamera !== this._gameCamera || this._gameCameraMode !== CameraMode.THIRD_PERSON) {
      return undefined;
    }

    const localPredictedEntity = this._game.entityManager.localPredictedEntity;
    if (!localPredictedEntity) {
      return undefined;
    }

    if (this._gameCameraAttachedEntity?.id === localPredictedEntity.id) {
      return localPredictedEntity;
    }

    if (this._gameCameraTrackedEntity?.id === localPredictedEntity.id) {
      return localPredictedEntity;
    }

    if (this._gameCameraDynamicFollowEntityId === localPredictedEntity.id) {
      return localPredictedEntity;
    }

    return undefined;
  }

  private _updateOwnerVisualSmoothingBinding(): void {
    const nextSmoothedEntity = this._resolveOwnerVisualSmoothingEntity();

    if (this._smoothedLocalPredictedEntity === nextSmoothedEntity) {
      return;
    }

    this._smoothedLocalPredictedEntity?.setClientPredictedTransformSmoothingEnabled(false);
    this._smoothedLocalPredictedEntity = nextSmoothedEntity;
    this._smoothedLocalPredictedEntity?.setClientPredictedTransformSmoothingEnabled(true);
  }

  private _resolveDynamicFollowAttachmentPosition(target: Vector3): Vector3 | undefined {
    const followEntity = this._getLocallyPredictedDynamicFollowEntity();
    const followOffset = this._gameCameraDynamicFollowOffset;
    if (!followEntity || !followOffset) {
      return undefined;
    }

    target.copy(followOffset);
    if (this._gameCameraDynamicFollowOffsetSpace === DYNAMIC_CAMERA_OFFSET_SPACE_ENTITY) {
      target.applyQuaternion(followEntity.rotation);
    }

    return target.add(followEntity.position);
  }

  private _resolveDynamicFollowTargetPosition(target: Vector3): Vector3 | undefined {
    const followEntity = this._getLocallyPredictedDynamicFollowEntity();
    const focusOffset = this._gameCameraDynamicFollowFocusOffset;
    if (!followEntity || !focusOffset) {
      return undefined;
    }

    return target.copy(followEntity.position).add(focusOffset);
  }

  private _updateGameCamera(frameDeltaS: number): void {
    if (!this._gameCameraAttachedEntity && !this._gameCameraAttachedPosition) {
      return console.warn(`Camera._updateGameCamera(): No camera attachment or position set for game camera.`);
    }

    if (this._gameCameraAttachedPosition && this._gameCameraAttachedPositionTarget) {
      if (this._shouldSkipPositionCameraSmoothing()) {
        this._gameCameraAttachedPosition.copy(this._gameCameraAttachedPositionTarget);
      } else {
      const lerpT = smoothingAlpha(frameDeltaS, CAMERA_ATTACHED_POSITION_LERP_TIME_S);
      this._gameCameraAttachedPosition.lerp(this._gameCameraAttachedPositionTarget, lerpT);

      if (
        this._gameCameraAttachedPosition.distanceToSquared(this._gameCameraAttachedPositionTarget)
        <= CAMERA_POSITION_DEADZONE_SQ
      ) {
        this._gameCameraAttachedPosition.copy(this._gameCameraAttachedPositionTarget);
      }
      }
    }

    if (this._gameCameraTrackedPosition && this._gameCameraTrackedPositionTarget) {
      if (this._shouldSkipPositionCameraSmoothing()) {
        this._gameCameraTrackedPosition.copy(this._gameCameraTrackedPositionTarget);
      } else {
      const lerpT = smoothingAlpha(frameDeltaS, CAMERA_TRACKED_POSITION_LERP_TIME_S);
      this._gameCameraTrackedPosition.lerp(this._gameCameraTrackedPositionTarget, lerpT);

      if (
        this._gameCameraTrackedPosition.distanceToSquared(this._gameCameraTrackedPositionTarget)
        <= CAMERA_POSITION_DEADZONE_SQ
      ) {
        this._gameCameraTrackedPosition.copy(this._gameCameraTrackedPositionTarget);
      }
      }
    }

    // Get base positions for camera calculations.
    const attachedPosition = this._gameCameraMode === CameraMode.FIRST_PERSON && this._gameCameraAttachedEntity
      ? vec3.copy(this._gameCameraAttachedEntity.predictedPosition)
      : this._gameCameraAttachedEntity?.getWorldPosition(vec3)
      || this._resolveDynamicFollowAttachmentPosition(vec3e)
      || this._gameCameraAttachedPosition!;
    const trackedPosition = this._resolveDynamicFollowTargetPosition(vec3f) || this._gameCameraTrackedPosition;
    const lookAtPosition = this._gameCameraLookAtPosition || this._gameCameraTrackedEntity?.position || trackedPosition;
    let lookAtDirection: Vector3 | undefined;

    // Calculate look direction and orientation if we have a look target
    if (lookAtPosition) {
      const lookAtDistanceSq = vec3d.subVectors(attachedPosition, lookAtPosition).lengthSq();
      if (lookAtDistanceSq >= CAMERA_LOOK_AT_MIN_DISTANCE_SQ) {
        lookAtDirection = vec3d.normalize();

        this._updateGameCameraOrientation(
          Math.asin(lookAtDirection.y),
          Math.atan2(lookAtDirection.x, lookAtDirection.z) 
        );
      }
    }

    const gameCamera = this._gameCamera;
    const perspectiveGameCamera = gameCamera instanceof PerspectiveCamera ? gameCamera : undefined;
    let projectionMatrixDirty = false;

    // Handle film offset - scale by zoom to prevent crosshair drift
    if (perspectiveGameCamera) {
      const filmOffset = perspectiveGameCamera.filmOffset;
      const zoomScale = this._gameCameraMode === CameraMode.THIRD_PERSON
        ? BASE_ZOOM / this._gameCameraRadialZoom
        : 1;
      const scaledTargetFilmOffset = this._gameCameraTargetFilmOffset * zoomScale;
      if (filmOffset !== scaledTargetFilmOffset) {
        if (
          this._gameCameraMode === CameraMode.FIRST_PERSON ||
          this._gameCameraSkipNextFilmOffsetInterpolation
        ) {
          // Apply immediately when skipping interpolation
          perspectiveGameCamera.filmOffset = scaledTargetFilmOffset;
          this._gameCameraSkipNextFilmOffsetInterpolation = false;
        } else {
          // Interpolate smoothly for normal film offset changes
          const filmOffsetLerpFactor = Math.min(frameDeltaS / CAMERA_LERP_TIME, 1);
          perspectiveGameCamera.filmOffset = filmOffset + (scaledTargetFilmOffset - filmOffset) * filmOffsetLerpFactor;
        }
        projectionMatrixDirty = true;
      }
    }

    // Handle fov
    const targetFov = this._gameCameraTargetFov;
    if (perspectiveGameCamera && perspectiveGameCamera.fov !== targetFov) {
      const fovLerpFactor = Math.min(frameDeltaS / CAMERA_LERP_TIME, 1);
      perspectiveGameCamera.fov = perspectiveGameCamera.fov + (targetFov - perspectiveGameCamera.fov) * fovLerpFactor;
      projectionMatrixDirty = true;
    }

    // Handle zoom
    const zoom = gameCamera.zoom;
    const targetZoom = this._gameCameraTargetZoom;
    if (zoom !== targetZoom) {
      const zoomLerpFactor = Math.min(frameDeltaS / CAMERA_LERP_TIME, 1);
      gameCamera.zoom = zoom + (targetZoom - zoom) * zoomLerpFactor;
      projectionMatrixDirty = true;
    }

    // Position and orient camera based on mode
    if (this._gameCameraMode === CameraMode.FIRST_PERSON) {
      // Calculate and apply orientation
      const quaternion = tempQuat.setFromEuler(
        modelViewEuler.set(-this._gameCameraPitch, this._gameCameraYaw, 0, 'YXZ'),
      );

      // First-person offset is camera-local so camera/view-model relation is stable.
      gameCamera.position.copy(attachedPosition)
        .add(vec3b.copy(this._gameCameraFirstPersonOffset).applyQuaternion(quaternion));

      // Apply forward offset
      const direction = vec3c.set(
        0,
        this._gameCameraForwardOffset >= 0 ? this._gameCameraForwardOffset : 0,
        this._gameCameraForwardOffset >= 0 ? 0 : -this._gameCameraForwardOffset,
      ).applyQuaternion(quaternion);

      gameCamera.position.add(direction);
      gameCamera.quaternion.copy(quaternion);

      if (lookAtPosition && lookAtDirection) {
        this._lookAt(gameCamera, lookAtPosition);
      }
    }

    if (this._gameCameraMode === CameraMode.THIRD_PERSON) {
      const radius = this._gameCameraRadialZoom - 1;
      const heightOffset = 1.25;
      const lookAtTarget = vec3c.copy(lookAtPosition || attachedPosition);
      
      // Default +y 0.5 offset for better default player perspective for now.
      // Devs can adjust this with their own provided offset for gameCameraOffset in the sdk.
      lookAtTarget.y += 0.5;

      // Position camera based on look direction or orientation
      if (lookAtDirection) {
        gameCamera.position.copy(attachedPosition)
          .addScaledVector(lookAtDirection, -radius)
          .setY(gameCamera.position.y + heightOffset);
      } else {
        gameCamera.position.set(
          attachedPosition.x + radius * Math.sin(this._gameCameraYaw) * Math.cos(this._gameCameraPitch),
          attachedPosition.y + radius * Math.sin(this._gameCameraPitch) + heightOffset,
          attachedPosition.z + radius * Math.cos(this._gameCameraYaw) * Math.cos(this._gameCameraPitch)
        );
      }

      // Apply visual rotation to camera position around the look target (skip if no rotation, if not identity quat)
      if (this._gameCameraShoulderRotationOffset.w !== 1) {
        this._gameCameraShoulderPositionOffset.copy(gameCamera.position).sub(lookAtTarget);
        this._gameCameraShoulderPositionOffset.applyQuaternion(this._gameCameraShoulderRotationOffset);
        gameCamera.position.copy(lookAtTarget).add(this._gameCameraShoulderPositionOffset);
      }

      // Third-person offset shifts perspective while preserving orbit around the target.
      if (this._gameCameraThirdPersonOffset.lengthSq() > 0) {
        yawOnlyEuler.set(0, this._gameCameraYaw, 0, 'YXZ');
        positionQuat.setFromEuler(yawOnlyEuler);
        gameCamera.position.add(vec3b.copy(this._gameCameraThirdPersonOffset).applyQuaternion(positionQuat));
      }

      // Check for block collision and move camera closer if needed
      const direction = vec3b.subVectors(gameCamera.position, lookAtTarget).normalize();
      const desiredDistance = gameCamera.position.distanceTo(lookAtTarget);

      if (this._gameCameraCollidesWithBlocks) {
        if (this._shouldSampleGameCameraCollision(lookAtTarget, direction, desiredDistance, frameDeltaS)) {
          this._sampleGameCameraCollisionDistance(lookAtTarget, direction, desiredDistance);
        }

        if (!Number.isFinite(this._gameCameraCollisionDistance)) {
          this._gameCameraCollisionDistance = this._gameCameraCollisionTargetDistance;
        }

        // Smooth camera movement both in/out to reduce jarring jumps.
        const inSpeed = 20.0;  // Faster to avoid noticeable clipping.
        const outSpeed = 10.0; // Slower for smooth recovery.
        const delta = this._gameCameraCollisionTargetDistance - this._gameCameraCollisionDistance;
        if (delta !== 0) {
          const maxStep = frameDeltaS * (delta < 0 ? inSpeed : outSpeed);
          const step = Math.sign(delta) * Math.min(Math.abs(delta), maxStep);
          this._gameCameraCollisionDistance += step;
        }
        
        // Apply the collision distance if it's less than desired
        if (this._gameCameraCollisionDistance < desiredDistance) {
          gameCamera.position.copy(lookAtTarget).addScaledVector(direction, this._gameCameraCollisionDistance);
        } else {
          // Reset collision distance when no longer constrained
          this._gameCameraCollisionDistance = desiredDistance;
        }
      } else {
        // Reset collision distance when collision is disabled.
        this._gameCameraCollisionDistance = desiredDistance;
        this._gameCameraCollisionTargetDistance = desiredDistance;
        this._gameCameraCollisionRaycastHasSample = false;
        this._gameCameraCollisionRaycastIntervalRemainingS = 0;
      }

      // Look at target - this maintains proper orientation
      this._lookAt(gameCamera, lookAtTarget);
    }

    if (this._gameCameraMode === CameraMode.SPECTATOR) {
      this.useSpectatorCamera();
    }

    this._gameCameraLookAtPosition = undefined;

    // Apply pitch to attached entity's model if enabled
    // Rotate around the camera pivot so the model stays fixed on screen
    if (this._gameCameraAttachedEntity) {
      const entity = this._gameCameraAttachedEntity;
      // First-person view models derive their local camera anchor from the entity root.
      // After the recent update-pass reordering, that matrix can still be stale here
      // unless we refresh it before converting world space back into entity-local space.
      entity.ensureEntityRootMatrixWorldUpdated();
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
          const modelAnchorPosition = gameCamera.position;
          const modelBaseCameraOffsetCacheKey = entity.modelUri ? `${entity.id}:${entity.modelUri}` : undefined;
          const cachedBaseCameraOffset = modelBaseCameraOffsetCacheKey
            ? this._gameCameraViewModelBaseCameraOffsets.get(modelBaseCameraOffsetCacheKey)
            : undefined;
          let resolvedBaseCameraOffset = baseCameraOffset ?? cachedBaseCameraOffset;
          if (!resolvedBaseCameraOffset) {
            model.getWorldPosition(vec3b).sub(modelAnchorPosition);
            tempQuat.copy(gameCamera.quaternion).invert();
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
          positionQuat.copy(gameCamera.quaternion);

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
    
    if (projectionMatrixDirty) {
      gameCamera.updateProjectionMatrix();
    }
  }

  private _shouldSkipPositionCameraSmoothing(): boolean {
    return this._gameCameraMode === CameraMode.FIRST_PERSON
      && !this._gameCameraAttachedEntity
      && !!this._gameCameraAttachedPositionTarget;
  }

  private _updateGameCameraOrientation(pitch: number, yaw: number): void {
    const normalizedYaw = normalizeAngle(yaw);
    const yawDelta = normalizeAngle(normalizedYaw - this._gameCameraYaw);

    // Avoid spamming unchanged orientation packets; this reduces network churn and camera feedback jitter.
    if (
      Math.abs(this._gameCameraPitch - pitch) <= CAMERA_ORIENTATION_EPSILON &&
      Math.abs(yawDelta) <= CAMERA_ORIENTATION_EPSILON
    ) {
      return;
    }

    this._gameCameraPitch = pitch;
    this._gameCameraYaw = normalizedYaw;

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
    const forward = spectatorForward.set(0, 0, -1).applyEuler(this._spectatorCamera.rotation);
    const right = spectatorRight.set(1, 0, 0).applyEuler(this._spectatorCamera.rotation);

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
