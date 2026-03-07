import { Vector2 } from 'three';
import ParticleEmitter from './ParticleEmitter';
import { type ParticleEmitterID } from './ParticleEmitterConstants';
import { ParticleEmitterCoreOptions } from './ParticleEmitterCore';
import { RendererEventType, type RendererEventPayload } from '../core/Renderer';
import EventRouter from '../events/EventRouter';
import Game from '../Game';
import { type DeserializedParticleEmitter } from '../network/Deserializer';
import { NetworkManagerEventType, type NetworkManagerEventPayload } from '../network/NetworkManager';
import { toVector3 } from '../three/utils';

// Working variables
const fromVec2 = new Vector2();
const toVec2 = new Vector2();

export default class ParticleEmitterManager {
  private _game: Game;
  private _particleEmitters: Map<ParticleEmitterID, ParticleEmitter> = new Map();

  constructor(game: Game) {
    this._game = game;
    this._setupEventListeners();
  }

  private _setupEventListeners(): void {
    EventRouter.instance.on(
      RendererEventType.Animate,
      this._onAnimate,
    );

    EventRouter.instance.on(
      NetworkManagerEventType.ParticleEmittersPacket,
      this._onParticleEmittersPacket,
    );
  }

  private _onAnimate = (payload: RendererEventPayload.IAnimate): void => {
    for (const particleEmitter of this._particleEmitters.values()) {
      particleEmitter.update(payload.frameDeltaS);
    }

    if (!this._game.settingsManager.qualityPerfTradeoff.viewDistance.enabled) {
      return;
    }

    const viewDistance = this._game.renderer.viewDistance;
    const viewDistanceSquared = viewDistance * viewDistance;
    const cameraPos = this._game.camera.activeCamera.position;
    fromVec2.set(cameraPos.x, cameraPos.z);

    // TODO: Since emitted particles do not follow the ParticleEmitter's position,
    // this ViewDistance logic may need to be reconsidered. For example, if a
    // ParticleEmitter that was nearby moves far away, its already-emitted particles
    // may still be near and should remain visible, but they will be made invisible
    // due to the emitter's new position being outside the view distance.
    this._particleEmitters.forEach((particleEmitter) => {
      const pos = particleEmitter.mesh.position;
      particleEmitter.setVisible(fromVec2.distanceToSquared(toVec2.set(pos.x, pos.z)) <= viewDistanceSquared);
    });
  }

  private _onParticleEmittersPacket = (payload: NetworkManagerEventPayload.IParticleEmittersPacket): void => {
    for (const deserializedParticleEmitter of payload.deserializedParticleEmitters) {
      this._updateParticleEmitter(deserializedParticleEmitter);
    }
  }

  private _updateParticleEmitter = (deserializedParticleEmitter: DeserializedParticleEmitter): void => {
    let particleEmitter = this._particleEmitters.get(deserializedParticleEmitter.id);

    if (!particleEmitter) {
      // Create new particles
      if (
        deserializedParticleEmitter.id === undefined ||
        deserializedParticleEmitter.textureUri === undefined
      ) {
        return console.info(`ParticlesManager._updateParticles(): Particles ${deserializedParticleEmitter.id} not yet created, this can be safely ignored if no gameplay bugs are experienced.`, deserializedParticleEmitter);
      }

      particleEmitter = new ParticleEmitter(this._game, {
        id: deserializedParticleEmitter.id,
        attachedToEntityId: deserializedParticleEmitter.attachedToEntityId,
        attachedToEntityNodeName: deserializedParticleEmitter.attachedToEntityNodeName,
        offset: deserializedParticleEmitter.offset,
        position: deserializedParticleEmitter.position,
        textureUri: deserializedParticleEmitter.textureUri,
        emitterCoreOptions: {
          alphaTest: deserializedParticleEmitter.alphaTest,
          colorEnd: deserializedParticleEmitter.colorEnd,
          colorEndVariance: deserializedParticleEmitter.colorEndVariance,
          colorIntensityEnd: deserializedParticleEmitter.colorIntensityEnd,
          colorIntensityEndVariance: deserializedParticleEmitter.colorIntensityEndVariance,
          colorIntensityStart: deserializedParticleEmitter.colorIntensityStart,
          colorIntensityStartVariance: deserializedParticleEmitter.colorIntensityStartVariance,
          colorStart: deserializedParticleEmitter.colorStart,
          colorStartVariance: deserializedParticleEmitter.colorStartVariance,
          gravity: toVector3(deserializedParticleEmitter.gravity),
          lifetime: deserializedParticleEmitter.lifetime,
          lifetimeVariance: deserializedParticleEmitter.lifetimeVariance,
          lockToEmitter: deserializedParticleEmitter.lockToEmitter,
          maxParticles: deserializedParticleEmitter.maxParticles,
          opacityEnd: deserializedParticleEmitter.opacityEnd,
          opacityEndVariance: deserializedParticleEmitter.opacityEndVariance,
          opacityStart: deserializedParticleEmitter.opacityStart,
          opacityStartVariance: deserializedParticleEmitter.opacityStartVariance,
          orientation: deserializedParticleEmitter.orientation,
          orientationFixedRotation: toVector3(deserializedParticleEmitter.orientationFixedRotation),
          positionVariance: toVector3(deserializedParticleEmitter.positionVariance),
          rate: deserializedParticleEmitter.rate,
          rateVariance: deserializedParticleEmitter.rateVariance,
          sizeEnd: deserializedParticleEmitter.sizeEnd,
          sizeEndVariance: deserializedParticleEmitter.sizeEndVariance,
          sizeStart: deserializedParticleEmitter.sizeStart,
          sizeStartVariance: deserializedParticleEmitter.sizeStartVariance,
          transparent: deserializedParticleEmitter.transparent,
          velocity: toVector3(deserializedParticleEmitter.velocity),
          velocityVariance: toVector3(deserializedParticleEmitter.velocityVariance),
        },
      });

      this._particleEmitters.set(particleEmitter.id, particleEmitter);
    } else {
      if (deserializedParticleEmitter.removed) {
        particleEmitter.dispose();
        this._particleEmitters.delete(particleEmitter.id);
        return;
      }

      if (deserializedParticleEmitter.attachedToEntityId !== undefined) {
        particleEmitter.setAttachedToEntityId(deserializedParticleEmitter.attachedToEntityId);
      }

      if (deserializedParticleEmitter.attachedToEntityNodeName !== undefined) {
        particleEmitter.setAttachedToEntityNodeName(deserializedParticleEmitter.attachedToEntityNodeName);
      }

      if (deserializedParticleEmitter.offset !== undefined) {
        particleEmitter.setOffset(deserializedParticleEmitter.offset);
      }


      if (deserializedParticleEmitter.position !== undefined) {
        particleEmitter.setPosition(deserializedParticleEmitter.position);
      }

      if (deserializedParticleEmitter.textureUri !== undefined) {
        particleEmitter.setTextureUri(deserializedParticleEmitter.textureUri);
      }

      const emitterCoreOptions: ParticleEmitterCoreOptions = {};
      if (deserializedParticleEmitter.alphaTest !== undefined) emitterCoreOptions.alphaTest = deserializedParticleEmitter.alphaTest;
      if (deserializedParticleEmitter.colorEnd !== undefined) emitterCoreOptions.colorEnd = deserializedParticleEmitter.colorEnd;
      if (deserializedParticleEmitter.colorEndVariance !== undefined) emitterCoreOptions.colorEndVariance = deserializedParticleEmitter.colorEndVariance;
      if (deserializedParticleEmitter.colorIntensityEnd !== undefined) emitterCoreOptions.colorIntensityEnd = deserializedParticleEmitter.colorIntensityEnd;
      if (deserializedParticleEmitter.colorIntensityEndVariance !== undefined) emitterCoreOptions.colorIntensityEndVariance = deserializedParticleEmitter.colorIntensityEndVariance;
      if (deserializedParticleEmitter.colorIntensityStart !== undefined) emitterCoreOptions.colorIntensityStart = deserializedParticleEmitter.colorIntensityStart;
      if (deserializedParticleEmitter.colorIntensityStartVariance !== undefined) emitterCoreOptions.colorIntensityStartVariance = deserializedParticleEmitter.colorIntensityStartVariance;
      if (deserializedParticleEmitter.colorStart !== undefined) emitterCoreOptions.colorStart = deserializedParticleEmitter.colorStart;
      if (deserializedParticleEmitter.colorStartVariance !== undefined) emitterCoreOptions.colorStartVariance = deserializedParticleEmitter.colorStartVariance;
      if (deserializedParticleEmitter.gravity !== undefined) emitterCoreOptions.gravity = toVector3(deserializedParticleEmitter.gravity);
      if (deserializedParticleEmitter.lifetime !== undefined) emitterCoreOptions.lifetime = deserializedParticleEmitter.lifetime;
      if (deserializedParticleEmitter.lifetimeVariance !== undefined) emitterCoreOptions.lifetimeVariance = deserializedParticleEmitter.lifetimeVariance;
      if (deserializedParticleEmitter.maxParticles !== undefined) emitterCoreOptions.maxParticles = deserializedParticleEmitter.maxParticles;
      if (deserializedParticleEmitter.orientation !== undefined) emitterCoreOptions.orientation = deserializedParticleEmitter.orientation;
      if (deserializedParticleEmitter.orientationFixedRotation !== undefined) emitterCoreOptions.orientationFixedRotation = toVector3(deserializedParticleEmitter.orientationFixedRotation);
      if (deserializedParticleEmitter.opacityEnd !== undefined) emitterCoreOptions.opacityEnd = deserializedParticleEmitter.opacityEnd;
      if (deserializedParticleEmitter.opacityEndVariance !== undefined) emitterCoreOptions.opacityEndVariance = deserializedParticleEmitter.opacityEndVariance;
      if (deserializedParticleEmitter.opacityStart !== undefined) emitterCoreOptions.opacityStart = deserializedParticleEmitter.opacityStart;
      if (deserializedParticleEmitter.opacityStartVariance !== undefined) emitterCoreOptions.opacityStartVariance = deserializedParticleEmitter.opacityStartVariance;
      if (deserializedParticleEmitter.rate !== undefined) emitterCoreOptions.rate = deserializedParticleEmitter.rate;
      if (deserializedParticleEmitter.rateVariance !== undefined) emitterCoreOptions.rateVariance = deserializedParticleEmitter.rateVariance;
      if (deserializedParticleEmitter.positionVariance !== undefined) emitterCoreOptions.positionVariance = toVector3(deserializedParticleEmitter.positionVariance);
      if (deserializedParticleEmitter.sizeEnd !== undefined) emitterCoreOptions.sizeEnd = deserializedParticleEmitter.sizeEnd;
      if (deserializedParticleEmitter.sizeEndVariance !== undefined) emitterCoreOptions.sizeEndVariance = deserializedParticleEmitter.sizeEndVariance;
      if (deserializedParticleEmitter.sizeStart !== undefined) emitterCoreOptions.sizeStart = deserializedParticleEmitter.sizeStart;
      if (deserializedParticleEmitter.sizeStartVariance !== undefined) emitterCoreOptions.sizeStartVariance = deserializedParticleEmitter.sizeStartVariance;
      if (deserializedParticleEmitter.transparent !== undefined) emitterCoreOptions.transparent = deserializedParticleEmitter.transparent;
      if (deserializedParticleEmitter.velocity !== undefined) emitterCoreOptions.velocity = toVector3(deserializedParticleEmitter.velocity);
      if (deserializedParticleEmitter.velocityVariance !== undefined) emitterCoreOptions.velocityVariance = toVector3(deserializedParticleEmitter.velocityVariance);

      if (Object.keys(emitterCoreOptions).length > 0) {
        particleEmitter.setEmitterCoreOptions(emitterCoreOptions);
      }
    }

    if (deserializedParticleEmitter.paused !== undefined) {
      if (deserializedParticleEmitter.paused) {
        particleEmitter.pause();
      } else {
        particleEmitter.restart();
      }
    }

    if (deserializedParticleEmitter.burst !== undefined) {
      particleEmitter.burst(deserializedParticleEmitter.burst);
    }
  }
}
