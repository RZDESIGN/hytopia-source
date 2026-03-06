import protocol from '@hytopia.com/server-protocol';
import ErrorHandler from '@/errors/ErrorHandler';
import { EntityModelAnimationLoopMode } from '@/worlds/entities/EntityModelAnimation';
import { SimulationEvent } from '@/worlds/physics/Simulation';
import type { EventPayloads } from '@/events/Events';
import type { TrimeshColliderOptions } from '@/worlds/physics/Collider';

import type Audio from '@/worlds/audios/Audio';
import type BlockType from '@/worlds/blocks/BlockType';
import type BlockTypeRegistry from '@/worlds/blocks/BlockTypeRegistry';
import type Chunk from '@/worlds/blocks/Chunk';
import type Entity from '@/worlds/entities/Entity';
import type EntityModelAnimation from '@/worlds/entities/EntityModelAnimation';
import type EntityModelNodeOverride from '@/worlds/entities/EntityModelNodeOverride';
import type Outline from '@/shared/types/Outline';
import type ParticleEmitter from '@/worlds/particles/ParticleEmitter';
import type Player from '@/players/Player';
import type PlayerCamera from '@/players/PlayerCamera';
import type QuaternionLike from '@/shared/types/math/QuaternionLike';
import type RgbColor from '@/shared/types/RgbColor';
import type SceneUI from '@/worlds/ui/SceneUI';
import type Vector3Like from '@/shared/types/math/Vector3Like';
import type World from '@/worlds/World';

/**
 * Serializes server state into protocol schemas for network synchronization.
 *
 * When to use: internal networking pipeline only.
 * Do NOT use for: persistence or save files; design a dedicated serializer for that.
 *
 * @remarks
 * Used by `NetworkSynchronizer` and event handlers to build outbound packets.
 * Anti-pattern: caching serialized results across ticks; they represent point-in-time snapshots.
 *
 * **Category:** Networking
 * @internal
 */
export default class Serializer {
  /**
   * Serializes an audio instance into a protocol schema.
   *
   * @param audio - The audio instance to serialize.
   *
   * **Requires:** Audio must be loaded (have an id).
   *
   * **Category:** Networking
   */
  public static serializeAudio(audio: Audio): protocol.AudioSchema {
    if (audio.id === undefined) {
      ErrorHandler.fatalError(`Serializer.serializeAudio(): Audio ${audio.uri} is not playing!`);
    }

    if (audio.attachedToEntity && !audio.attachedToEntity.isSpawned) {
      ErrorHandler.warning(`Serializer.serializeAudio(): Audio ${audio.uri} is attached to an entity that is not spawned or was recently despawned, reverting to unattached!`);
    }

    // change this later to set properties only if present, to ignore encoding nullish optional properties.
    return {
      i: audio.id,
      a: audio.uri,
      cd: audio.cutoffDistance,
      d: audio.duration,
      de: audio.detune,
      di: audio.distortion,
      e: audio.attachedToEntity?.isSpawned ? audio.attachedToEntity.id : undefined,
      l: audio.loop,
      o: audio.offset,
      p: audio.position ? this.serializeVector(audio.position) : undefined,
      pa: !audio.isPlaying,
      pl: audio.isPlaying,
      pr: audio.playbackRate,
      rd: audio.referenceDistance,
      s: audio.startTick,
      v: audio.volume,
    };
  }

  /**
   * Serializes a block type definition.
   *
   * @param blockType - The block type to serialize.
   *
   * **Category:** Networking
   */
  public static serializeBlockType(blockType: BlockType): protocol.BlockTypeSchema {
    let trimeshIndices: number[] | undefined;
    let trimeshVertices: number[] | undefined;

    if (blockType.isTrimesh) {
      const colliderOptions = blockType.colliderOptions as TrimeshColliderOptions;
      const indices = colliderOptions.indices!;
      const vertices = colliderOptions.vertices!;

      trimeshIndices = new Array<number>(indices.length);
      for (let i = 0; i < indices.length; i++) {
        trimeshIndices[i] = indices[i];
      }

      trimeshVertices = new Array<number>(vertices.length);
      for (let i = 0; i < vertices.length; i++) {
        trimeshVertices[i] = vertices[i];
      }
    }

    return {
      i: blockType.id,
      l: blockType.isLiquid,
      ll: blockType.lightLevel,
      n: blockType.name,
      t: blockType.textureUri,
      ti: trimeshIndices,
      tv: trimeshVertices,
    };
  }

  /**
   * Serializes a block type registry as an array of block type schemas.
   *
   * @param blockTypeRegistry - The registry to serialize.
   *
   * **Category:** Networking
   */
  public static serializeBlockTypeRegistry(blockTypeRegistry: BlockTypeRegistry): protocol.BlockTypesSchema {
    const blockTypes = blockTypeRegistry.getAllBlockTypes();
    const serializedBlockTypes = new Array<protocol.BlockTypeSchema>(blockTypes.length);

    for (let i = 0; i < blockTypes.length; i++) {
      serializedBlockTypes[i] = this.serializeBlockType(blockTypes[i]);
    }

    return serializedBlockTypes;
  }

  /**
   * Serializes a chunk and its block data.
   *
   * @param chunk - The chunk to serialize.
   *
   * **Category:** Networking
   */
  public static serializeChunk(chunk: Chunk): protocol.ChunkSchema {
    const blocks = new Array<number>(chunk.blocks.length);
    for (let i = 0; i < chunk.blocks.length; i++) {
      blocks[i] = chunk.blocks[i];
    }

    const blockRotations = new Array<number>(chunk.blockRotations.size * 2);
    let blockRotationIndex = 0;
    for (const [ index, rotation ] of chunk.blockRotations) {
      blockRotations[blockRotationIndex++] = index;
      blockRotations[blockRotationIndex++] = rotation.enumIndex;
    }

    return {
      c: this.serializeVector(chunk.originCoordinate),
      b: blocks,
      r: blockRotations,
    };
  }

  /**
   * Serializes an entity instance.
   *
   * @param entity - The entity to serialize.
   *
   * **Requires:** Entity must be spawned in a world and have an id.
   *
   * **Category:** Networking
   */
  public static serializeEntity(entity: Entity): protocol.EntitySchema {
    if (!entity.world || entity.id === undefined) { ErrorHandler.fatalError('Serializer.serializeEntity(): Entity is not in a world'); }

    const modelAnimations = entity.modelAnimations;
    const serializedModelAnimations = new Array<protocol.ModelAnimationSchema>(modelAnimations.length);
    for (let i = 0; i < modelAnimations.length; i++) {
      serializedModelAnimations[i] = this.serializeEntityModelAnimation(modelAnimations[i]);
    }

    const modelNodeOverrides = entity.modelNodeOverrides;
    const serializedModelNodeOverrides = new Array<protocol.ModelNodeOverrideSchema>(modelNodeOverrides.length);
    for (let i = 0; i < modelNodeOverrides.length; i++) {
      serializedModelNodeOverrides[i] = this.serializeEntityModelNodeOverride(modelNodeOverrides[i]);
    }

    return {
      i: entity.id,
      bt: entity.blockTextureUri,
      bh: entity.blockHalfExtents ? this.serializeVector(entity.blockHalfExtents) : undefined,
      e: entity.isEnvironmental,
      ec: entity.emissiveColor ? this.serializeRgbColor(entity.emissiveColor) : undefined,
      ei: entity.emissiveIntensity,
      m: entity.modelUri,
      ma: serializedModelAnimations,
      mo: serializedModelNodeOverrides,
      mt: entity.modelTextureUri,
      n: entity.name,
      o: entity.opacity,
      ol: entity.outline ? this.serializeOutline(entity.outline) : undefined,
      p: this.serializeVector(entity.position),
      pi: entity.positionInterpolationMs,
      pe: entity.parent ? entity.parent.id : undefined,
      pn: entity.parentNodeName,
      r: this.serializeQuaternion(entity.rotation),
      ri: entity.rotationInterpolationMs,
      si: entity.modelScaleInterpolationMs,
      sv: entity.modelScale ? this.serializeVector(entity.modelScale) : undefined,
      t: entity.tintColor ? this.serializeRgbColor(entity.tintColor) : undefined,
    };
  }

  public static serializeEntityModelAnimation(entityModelAnimation: EntityModelAnimation): protocol.ModelAnimationSchema {
    return {
      n: entityModelAnimation.name,
      b: entityModelAnimation.blendMode,
      c: entityModelAnimation.clampWhenFinished,
      fi: entityModelAnimation.fadesIn,
      fo: entityModelAnimation.fadesOut,
      l: entityModelAnimation.loopMode,
      p: entityModelAnimation.isPlaying && entityModelAnimation.loopMode !== EntityModelAnimationLoopMode.ONCE,
      pr: entityModelAnimation.playbackRate,
      w: entityModelAnimation.weight,
    };
  }

  /**
   * Serializes an entity model node override.
   *
   * @param entityModelNodeOverride - The override to serialize.
   *
   * **Category:** Networking
   */
  public static serializeEntityModelNodeOverride(entityModelNodeOverride: EntityModelNodeOverride): protocol.ModelNodeOverrideSchema {
    return {
      n: entityModelNodeOverride.nameMatch,
      ec: entityModelNodeOverride.emissiveColor ? this.serializeRgbColor(entityModelNodeOverride.emissiveColor) : undefined,
      ei: entityModelNodeOverride.emissiveIntensity,
      h: entityModelNodeOverride.isHidden,
      p: entityModelNodeOverride.localPosition ? this.serializeVector(entityModelNodeOverride.localPosition) : undefined,
      pi: entityModelNodeOverride.localPositionInterpolationMs,
      r: entityModelNodeOverride.localRotation ? this.serializeQuaternion(entityModelNodeOverride.localRotation) : undefined,
      ri: entityModelNodeOverride.localRotationInterpolationMs,
      s: entityModelNodeOverride.localScale ? this.serializeVector(entityModelNodeOverride.localScale) : undefined,
      si: entityModelNodeOverride.localScaleInterpolationMs,
    };
  }

  /**
   * Serializes an outline configuration.
   *
   * @param outline - The outline to serialize.
   *
   * **Category:** Networking
   */
  public static serializeOutline(outline: Outline): protocol.OutlineSchema {
    return {
      c: outline.color ? this.serializeRgbColor(outline.color) : undefined,
      ci: outline.colorIntensity,
      th: outline.thickness,
      o: outline.opacity,
      oc: outline.occluded,
    };
  }

  /**
   * Serializes a particle emitter instance.
   *
   * @param particleEmitter - The particle emitter to serialize.
   *
   * **Requires:** ParticleEmitter must be spawned in a world and have an id.
   *
   * **Category:** Networking
   */
  public static serializeParticleEmitter(particleEmitter: ParticleEmitter): protocol.ParticleEmitterSchema {
    if (!particleEmitter.world || particleEmitter.id === undefined) { ErrorHandler.fatalError('Serializer.serializeParticleEmitter(): ParticleEmitter is not in a world'); }

    return {
      i: particleEmitter.id,
      at: particleEmitter.alphaTest,
      ce: particleEmitter.colorEnd ? this.serializeRgbColor(particleEmitter.colorEnd) : undefined, 
      cev: particleEmitter.colorEndVariance ? this.serializeRgbColor(particleEmitter.colorEndVariance) : undefined,
      cs: particleEmitter.colorStart ? this.serializeRgbColor(particleEmitter.colorStart) : undefined,
      csv: particleEmitter.colorStartVariance ? this.serializeRgbColor(particleEmitter.colorStartVariance) : undefined,
      cie: particleEmitter.colorIntensityEnd,
      ciev: particleEmitter.colorIntensityEndVariance,
      cis: particleEmitter.colorIntensityStart,
      cisv: particleEmitter.colorIntensityStartVariance,
      e: particleEmitter.attachedToEntity?.isSpawned ? particleEmitter.attachedToEntity.id : undefined,
      en: particleEmitter.attachedToEntityNodeName,
      g: particleEmitter.gravity ? this.serializeVector(particleEmitter.gravity) : undefined,
      l: particleEmitter.lifetime,
      le: particleEmitter.lockToEmitter,
      lv: particleEmitter.lifetimeVariance,
      mp: particleEmitter.maxParticles,
      o: particleEmitter.offset ? this.serializeVector(particleEmitter.offset) : undefined,
      or: particleEmitter.orientation ? this.serializeParticleEmitterOrientation(particleEmitter.orientation) : undefined,
      ofr: particleEmitter.orientationFixedRotation ? this.serializeVector(particleEmitter.orientationFixedRotation) : undefined,
      oe: particleEmitter.opacityEnd,
      oev: particleEmitter.opacityEndVariance,
      os: particleEmitter.opacityStart,
      osv: particleEmitter.opacityStartVariance,
      p: particleEmitter.position ? this.serializeVector(particleEmitter.position) : undefined,
      pa: particleEmitter.paused,
      pv: particleEmitter.positionVariance ? this.serializeVector(particleEmitter.positionVariance) : undefined,
      r: particleEmitter.rate,
      rv: particleEmitter.rateVariance,
      se: particleEmitter.sizeEnd,
      sev: particleEmitter.sizeEndVariance,
      ss: particleEmitter.sizeStart,
      ssv: particleEmitter.sizeStartVariance,
      t: particleEmitter.transparent,
      tu: particleEmitter.textureUri,
      v: particleEmitter.velocity ? this.serializeVector(particleEmitter.velocity) : undefined,
      vv: particleEmitter.velocityVariance ? this.serializeVector(particleEmitter.velocityVariance) : undefined,
    };
  }

  /**
   * Serializes a particle emitter orientation into its numeric protocol value.
   *
   * @param orientation - The orientation string.
   * @returns The numeric representation used by the protocol.
   *
   * **Category:** Networking
   */
  public static serializeParticleEmitterOrientation(orientation: 'billboard' | 'billboardY' | 'fixed' | 'velocity'): number {
    switch (orientation) {
      case 'billboard': return 0;
      case 'billboardY': return 1;
      case 'fixed': return 2;
      case 'velocity': return 3;
      default: return 0;
    }
  }

  /**
   * Serializes a physics debug raycast payload.
   *
   * @param raycast - The debug raycast payload.
   *
   * **Category:** Networking
   */
  public static serializePhysicsDebugRaycast(raycast: EventPayloads[SimulationEvent.DEBUG_RAYCAST]): protocol.PhysicsDebugRaycastSchema {
    return {
      o: this.serializeVector(raycast.origin),
      d: this.serializeVector(raycast.direction),
      l: raycast.length,
      h: raycast.hit,
    };
  }

  /**
   * Serializes a player profile snapshot.
   *
   * @param player - The player to serialize.
   *
   * **Category:** Networking
   */
  public static serializePlayer(player: Player): protocol.PlayerSchema {
    return {
      i: player.id,
      u: player.username,
      p: player.profilePictureUrl,
    };
  }

  /**
   * Serializes a player camera configuration.
   *
   * @param playerCamera - The player camera to serialize.
   *
   * **Category:** Networking
   */
  public static serializePlayerCamera(playerCamera: PlayerCamera): protocol.CameraSchema {
    const viewModelHiddenNodes = new Array<string>(playerCamera.viewModelHiddenNodes.size);
    let hiddenNodeIndex = 0;
    for (const hiddenNode of playerCamera.viewModelHiddenNodes) {
      viewModelHiddenNodes[hiddenNodeIndex++] = hiddenNode;
    }

    const viewModelShownNodes = new Array<string>(playerCamera.viewModelShownNodes.size);
    let shownNodeIndex = 0;
    for (const shownNode of playerCamera.viewModelShownNodes) {
      viewModelShownNodes[shownNodeIndex++] = shownNode;
    }

    return {
      cb: playerCamera.collidesWithBlocks,
      m: playerCamera.mode,
      e: playerCamera.attachedToEntity?.isSpawned ? playerCamera.attachedToEntity.id : undefined,
      et: playerCamera.targetEntity?.isSpawned ? playerCamera.targetEntity.id : undefined,
      fo: playerCamera.filmOffset,
      ffo: playerCamera.forwardOffset,
      fv: playerCamera.fov,
      h: viewModelHiddenNodes,
      mp: playerCamera.viewModelPitchesWithCamera,
      my: playerCamera.viewModelYawsWithCamera,
      o: playerCamera.offset ? this.serializeVector(playerCamera.offset) : undefined,
      p: playerCamera.attachedToPosition ? this.serializeVector(playerCamera.attachedToPosition) : undefined,
      pt: playerCamera.targetPosition ? this.serializeVector(playerCamera.targetPosition) : undefined,
      s: viewModelShownNodes,
      sa: playerCamera.shoulderAngle,
      z: playerCamera.zoom,
    };
  }

  /**
   * Serializes a quaternion to protocol order.
   *
   * @param quaternion - The quaternion to serialize.
   *
   * **Category:** Networking
   */
  public static serializeQuaternion(quaternion: QuaternionLike): protocol.QuaternionSchema {
    return [ quaternion.x, quaternion.y, quaternion.z, quaternion.w ];
  }

  /**
   * Serializes an RGB color.
   *
   * @param rgbColor - The RGB color to serialize.
   *
   * **Category:** Networking
   */
  public static serializeRgbColor(rgbColor: RgbColor): protocol.RgbColorSchema {
    return [ rgbColor.r, rgbColor.g, rgbColor.b ];
  }

  /**
   * Serializes a Scene UI instance.
   *
   * @param sceneUI - The scene UI to serialize.
   *
   * **Requires:** SceneUI must be loaded and have an id.
   *
   * **Category:** Networking
   */
  public static serializeSceneUI(sceneUI: SceneUI): protocol.SceneUISchema {
    if (sceneUI.id === undefined) { ErrorHandler.fatalError('Serializer.serializeSceneUI(): SceneUI is not loaded!'); }

    return {
      i: sceneUI.id,
      e: sceneUI.attachedToEntity?.isSpawned ? sceneUI.attachedToEntity.id : undefined,
      o: sceneUI.offset ? this.serializeVector(sceneUI.offset) : undefined,
      p: sceneUI.position ? this.serializeVector(sceneUI.position) : undefined,
      s: sceneUI.state,
      t: sceneUI.templateId,
      v: sceneUI.viewDistance,
    };
  }

  /**
   * Serializes a vector.
   *
   * @param vector - The vector to serialize.
   *
   * **Category:** Networking
   */
  public static serializeVector(vector: Vector3Like): protocol.VectorSchema {
    return [ vector.x, vector.y, vector.z ];
  }

  /**
   * Serializes a boolean vector.
   *
   * @param vectorBoolean - The boolean vector to serialize.
   *
   * **Category:** Networking
   */
  public static serializeVectorBoolean(vectorBoolean: { x: boolean, y: boolean, z: boolean }): protocol.VectorBooleanSchema {
    return [ vectorBoolean.x, vectorBoolean.y, vectorBoolean.z ];
  }

  /**
   * Serializes a world snapshot.
   *
   * @param world - The world to serialize.
   *
   * **Requires:** World must be the active world for the sync context.
   *
   * **Category:** Networking
   */
  public static serializeWorld(world: World): protocol.WorldSchema {
    return {
      i: world.id,
      ac: this.serializeRgbColor(world.ambientLightColor),
      ai: world.ambientLightIntensity,
      dc: this.serializeRgbColor(world.directionalLightColor),
      di: world.directionalLightIntensity,
      dp: this.serializeVector(world.directionalLightPosition),
      fc: world.fogColor ? this.serializeRgbColor(world.fogColor) : undefined,
      ff: world.fogFar,
      fn: world.fogNear,
      n: world.name,
      s: world.skyboxUri,
      si: world.skyboxIntensity,
      t: world.loop.timestepS,
    };
  }
}
