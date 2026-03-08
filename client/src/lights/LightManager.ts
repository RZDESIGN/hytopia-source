import {
  Color,
  Object3D,
  PointLight,
  Quaternion,
  SpotLight,
  Vector3,
} from 'three';
import { RendererEventType, type RendererEventPayload } from '../core/Renderer';
import EventRouter from '../events/EventRouter';
import type Game from '../Game';
import type { DeserializedLight } from '../network/Deserializer';
import type { NetworkManagerEventPayload } from '../network/NetworkEventPayloads';
import { NetworkManagerEventType } from '../network/NetworkEvents';

const DEFAULT_LIGHT_COLOR = new Color(1, 1, 1);
const DEFAULT_POINT_LIGHT_DISTANCE = 24;
const DEFAULT_SPOT_LIGHT_DISTANCE = 32;
const DEFAULT_SPOT_LIGHT_ANGLE = Math.PI / 4;
const DEFAULT_SPOT_TARGET_DISTANCE = 12;
const LIGHT_TYPE_POINT = 0;
const LIGHT_TYPE_SPOT = 1;
const SPOT_SHADOW_BIAS = -0.0002;
const SPOT_SHADOW_NORMAL_BIAS = 0.02;
const MIN_SPOT_SHADOW_SCORE = 0.08;

const tempOffset = new Vector3();
const tempTarget = new Vector3();
const tempForward = new Vector3();
const tempQuaternion = new Quaternion();
const tempInterest = new Vector3();
const tempLightDirection = new Vector3();
const tempLightToCamera = new Vector3();

type ManagedPointLight = {
  data: DeserializedLight;
  light: PointLight;
};

type ManagedSpotLight = {
  data: DeserializedLight;
  light: SpotLight;
  target: Object3D;
};

type ManagedLight = ManagedPointLight | ManagedSpotLight;

export default class LightManager {
  private _game: Game;
  private _lights: Map<number, ManagedLight> = new Map();
  private _spotShadowCandidates: ManagedSpotLight[] = [];

  public constructor(game: Game) {
    this._game = game;
    this._setupEventListeners();
  }

  private _setupEventListeners(): void {
    EventRouter.instance.on(NetworkManagerEventType.LightsPacket, this._onLightsPacket);
    EventRouter.instance.on(RendererEventType.Animate, this._onAnimate);
  }

  private _onLightsPacket = (payload: NetworkManagerEventPayload.ILightsPacket): void => {
    for (const deserializedLight of payload.deserializedLights) {
      this._updateLight(deserializedLight);
    }
  };

  private _onAnimate = (_payload: RendererEventPayload.IAnimate): void => {
    for (const entry of this._lights.values()) {
      this._updateLightTransform(entry);
    }

    this._applySpotShadowBudget();
  };

  private _updateLight(deserializedLight: DeserializedLight): void {
    if (deserializedLight.removed) {
      this._removeLight(deserializedLight.id);
      return;
    }

    let entry = this._lights.get(deserializedLight.id);
    if (!entry || entry.data.type !== deserializedLight.type) {
      if (entry) {
        this._removeLight(deserializedLight.id);
      }

      entry = this._createLight(deserializedLight);
      this._lights.set(deserializedLight.id, entry);
    }

    entry.data = { ...entry.data, ...deserializedLight };

    const color = entry.data.color ?? DEFAULT_LIGHT_COLOR;
    if (entry.light instanceof PointLight) {
      entry.light.color.copy(color);
      entry.light.intensity = entry.data.intensity ?? 1;
      entry.light.distance = entry.data.distance ?? DEFAULT_POINT_LIGHT_DISTANCE;
      entry.light.decay = 2;
    } else {
      entry.light.color.copy(color);
      entry.light.intensity = entry.data.intensity ?? 1;
      entry.light.distance = entry.data.distance ?? DEFAULT_SPOT_LIGHT_DISTANCE;
      entry.light.decay = 2;
      entry.light.angle = entry.data.angle ?? DEFAULT_SPOT_LIGHT_ANGLE;
      entry.light.penumbra = entry.data.penumbra ?? 0;
      entry.light.shadow.bias = SPOT_SHADOW_BIAS;
      entry.light.shadow.normalBias = SPOT_SHADOW_NORMAL_BIAS;
      entry.light.shadow.camera.near = 0.5;
      entry.light.shadow.camera.far = Math.max(entry.light.distance || DEFAULT_SPOT_LIGHT_DISTANCE, 8);
    }

    this._updateLightTransform(entry);
  }

  private _createLight(deserializedLight: DeserializedLight): ManagedLight {
    if (deserializedLight.type === LIGHT_TYPE_SPOT) {
      const light = new SpotLight(0xffffff, 1, DEFAULT_SPOT_LIGHT_DISTANCE, DEFAULT_SPOT_LIGHT_ANGLE, 0, 2);
      const target = new Object3D();
      light.target = target;
      light.castShadow = false;

      this._game.renderer.addToScene(light);
      this._game.renderer.addToScene(target);

      return {
        data: { ...deserializedLight },
        light,
        target,
      };
    }

    const light = new PointLight(0xffffff, 1, DEFAULT_POINT_LIGHT_DISTANCE, 2);
    light.castShadow = false;
    this._game.renderer.addToScene(light);

    return {
      data: { ...deserializedLight, type: LIGHT_TYPE_POINT },
      light,
    };
  }

  private _removeLight(id: number): void {
    const entry = this._lights.get(id);
    if (!entry) {
      return;
    }

    this._game.renderer.removeFromScene(entry.light);
    entry.light.shadow.dispose();

    if ('target' in entry) {
      this._game.renderer.removeFromScene(entry.target);
    }

    this._lights.delete(id);
  }

  private _resolveLightPosition(entry: ManagedLight): boolean {
    const { data } = entry;
    const attachedToEntityId = data.attachedToEntityId;

    if (attachedToEntityId !== undefined) {
      const entity = this._game.entityManager.getEntity(attachedToEntityId);
      if (!entity) {
        entry.light.visible = false;
        return false;
      }

      if (data.offset) {
        tempOffset.set(data.offset.x, data.offset.y, data.offset.z);
        entity.entityRoot.localToWorld(tempOffset);
        entry.light.position.copy(tempOffset);
      } else {
        entity.entityRoot.getWorldPosition(entry.light.position);
      }

      return true;
    }

    if (!data.position) {
      entry.light.visible = false;
      return false;
    }

    entry.light.position.set(data.position.x, data.position.y, data.position.z);
    if (data.offset) {
      entry.light.position.add(tempOffset.set(data.offset.x, data.offset.y, data.offset.z));
    }

    return true;
  }

  private _resolveSpotTarget(entry: ManagedSpotLight): boolean {
    const { data, light, target } = entry;

    if (data.trackedPosition) {
      target.position.set(data.trackedPosition.x, data.trackedPosition.y, data.trackedPosition.z);
      target.updateMatrixWorld();
      return true;
    }

    if (data.trackedEntityId !== undefined) {
      const trackedEntity = this._game.entityManager.getEntity(data.trackedEntityId);
      if (trackedEntity && data.trackedEntityId !== data.attachedToEntityId) {
        trackedEntity.entityRoot.getWorldPosition(target.position);
        target.updateMatrixWorld();
        return true;
      }
    }

    if (data.attachedToEntityId !== undefined) {
      const entity = this._game.entityManager.getEntity(data.attachedToEntityId);
      if (entity) {
        entity.entityRoot.getWorldQuaternion(tempQuaternion);
        tempForward.set(0, 0, -1).applyQuaternion(tempQuaternion).normalize();
        tempTarget.copy(light.position).addScaledVector(
          tempForward,
          Math.max(light.distance || DEFAULT_SPOT_LIGHT_DISTANCE, DEFAULT_SPOT_TARGET_DISTANCE),
        );
        target.position.copy(tempTarget);
        target.updateMatrixWorld();
        return true;
      }
    }

    tempTarget.copy(light.position);
    tempTarget.z -= DEFAULT_SPOT_TARGET_DISTANCE;
    target.position.copy(tempTarget);
    target.updateMatrixWorld();
    return true;
  }

  private _updateLightTransform(entry: ManagedLight): void {
    const hasPosition = this._resolveLightPosition(entry);
    if (!hasPosition) {
      return;
    }

    if ('target' in entry) {
      const hasTarget = this._resolveSpotTarget(entry);
      entry.light.visible = hasTarget && entry.light.intensity > 0;
      return;
    }

    entry.light.visible = entry.light.intensity > 0;
  }

  private _scoreSpotShadowCandidate(
    entry: ManagedSpotLight,
    cameraPosition: Vector3,
    cameraForward: Vector3,
  ): number {
    tempInterest.copy(entry.light.position).lerp(entry.target.position, 0.65);
    tempOffset.subVectors(tempInterest, cameraPosition);
    const interestDistance = Math.max(0.001, tempOffset.length());
    tempOffset.multiplyScalar(1 / interestDistance);
    const screenWeight = Math.max(0, Math.min(1, (tempOffset.dot(cameraForward) + 0.25) / 1.25));
    if (screenWeight <= 0.001) {
      return 0;
    }

    tempLightDirection.subVectors(entry.target.position, entry.light.position);
    const lightDirectionLength = tempLightDirection.length();
    if (lightDirectionLength > 0.0001) {
      tempLightDirection.multiplyScalar(1 / lightDirectionLength);
    } else {
      tempLightDirection.set(0, 0, -1);
    }

    tempLightToCamera.subVectors(cameraPosition, entry.light.position);
    const lightToCameraDistance = Math.max(0.001, tempLightToCamera.length());
    tempLightToCamera.multiplyScalar(1 / lightToCameraDistance);

    const coneWeight = Math.max(0, tempLightDirection.dot(tempLightToCamera));
    const lightRange = Math.max(entry.light.distance || DEFAULT_SPOT_LIGHT_DISTANCE, DEFAULT_SPOT_TARGET_DISTANCE);
    const distanceWeight = 1 - Math.min(1, interestDistance / (lightRange * 2.4));
    const intensityWeight = 0.35 + Math.min(2, Math.max(0, entry.light.intensity)) * 0.5;
    const coneSizeWeight = 0.65 + Math.sin(entry.light.angle) * 0.55;

    return intensityWeight
      * coneSizeWeight
      * (0.1 + 0.9 * screenWeight)
      * (0.25 + 0.75 * coneWeight)
      * (0.2 + 0.8 * distanceWeight);
  }

  private _applySpotShadowBudget(): void {
    const shadowSettings = this._game.settingsManager.qualityPerfTradeoff.shadows;
    const maxSpotlightShadows = shadowSettings?.enabled ? shadowSettings.maxSpotlightShadows : 0;
    const spotlightMapSize = shadowSettings?.spotlightMapSize ?? 512;

    this._spotShadowCandidates.length = 0;

    for (const entry of this._lights.values()) {
      if ('target' in entry && entry.light.visible) {
        this._spotShadowCandidates.push(entry);
      }
    }

    if (maxSpotlightShadows <= 0) {
      for (const entry of this._spotShadowCandidates) {
        entry.light.castShadow = false;
      }
      return;
    }

    const cameraPosition = this._game.camera.activeCamera.position;
    tempForward.copy(this._game.camera.activeViewDir);
    if (tempForward.lengthSq() <= 0.0001) {
      tempForward.set(0, 0, -1);
    } else {
      tempForward.normalize();
    }
    this._spotShadowCandidates.sort(
      (a, b) => this._scoreSpotShadowCandidate(b, cameraPosition, tempForward)
        - this._scoreSpotShadowCandidate(a, cameraPosition, tempForward),
    );

    let assignedShadowCount = 0;
    for (let i = 0; i < this._spotShadowCandidates.length; i++) {
      const entry = this._spotShadowCandidates[i];
      const score = this._scoreSpotShadowCandidate(entry, cameraPosition, tempForward);
      const shouldCastShadow = assignedShadowCount < maxSpotlightShadows && score >= MIN_SPOT_SHADOW_SCORE;
      if (entry.light.castShadow !== shouldCastShadow) {
        entry.light.castShadow = shouldCastShadow;
        if (shouldCastShadow) {
          entry.light.shadow.needsUpdate = true;
        }
      }

      if (shouldCastShadow) {
        assignedShadowCount++;
        if (
          entry.light.shadow.mapSize.x !== spotlightMapSize ||
          entry.light.shadow.mapSize.y !== spotlightMapSize
        ) {
          entry.light.shadow.mapSize.set(spotlightMapSize, spotlightMapSize);
          entry.light.shadow.needsUpdate = true;
        }
      }
    }
  }
}
