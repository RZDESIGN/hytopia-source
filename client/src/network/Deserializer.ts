import * as THREE from 'three';
import protocol from '@hytopia.com/server-protocol';

export type DeserializedAudio = {
  id?: number;
  attachedToEntityId?: number;
  cutoffDistance?: number;
  duration?: number;
  detune?: number;
  distortion?: number;
  loop?: boolean;
  offset?: number;
  pause?: boolean;
  play?: boolean;
  playbackRate?: number;
  position?: THREE.Vector3Like;
  referenceDistance?: number;
  restart?: boolean;
  startTick?: number;
  uri?: string;
  volume?: number;
}
export type DeserializedAudios = DeserializedAudio[];

export type DeserializedBlock = {
  id: number;
  globalCoordinate: {
    x: number;
    y: number;
    z: number;
  };
  blockRotationIndex?: number;
}
export type DeserializedBlocks = DeserializedBlock[];

export type DeserializedBlockType = {
  id: number;
  isLiquid?: boolean;
  name?: string;
  textureUri?: string;
  lightLevel?: number;
  trimeshIndices?: Uint32Array;
  trimeshVertices?: Float32Array;
}
export type DeserializedBlockTypes = DeserializedBlockType[];

export type DeserializedCamera = {
  collidesWithBlocks?: boolean;
  mode?: number;
  attachedToEntityId?: number | null;
  attachedToPosition?: THREE.Vector3Like | null;
  filmOffset?: number;
  forwardOffset?: number;
  fov?: number;
  modelHiddenNodes?: string[];
  modelPitchesWithCamera?: boolean;
  modelShownNodes?: string[];
  modelYawsWithCamera?: boolean;
  lookAtPosition?: THREE.Vector3Like;
  offset?: THREE.Vector3Like;
  shoulderAngle?: number;
  trackedEntityId?: number | null;
  trackedPosition?: THREE.Vector3Like | null;
  zoom?: number;
}

export type DeserializedChatMessage = {
  message: string;
  color?: string;
  playerId?: string;
}
export type DeserializedChatMessages = DeserializedChatMessage[];

export type DeserializedConnection = {
  id?: string;
  kill?: boolean;
}

export type DeserializedChunk = {
  originCoordinate: {
    x: number;
    y: number;
    z: number;
  };
  blocks?: Uint8Array;
  blockRotations?: number[]; // array of pairs, [ blockIndex, blockRotationIndex .. ] 
  removed?: boolean;
}
export type DeserializedChunks = DeserializedChunk[];

export type DeserializedEntity = {
  acknowledgedInputSequenceNumber?: number;
  id: number;
  blockTextureUri?: string;
  blockHalfExtents?: THREE.Vector3Like;
  emissiveColor?: THREE.Color | null;
  emissiveIntensity?: number | null;
  isEnvironmental?: boolean;
  modelAnimations?: DeserializedModelAnimations;
  modelNodeOverrides?: DeserializedModelNodeOverrides;
  modelTextureUri?: string;
  modelUri?: string;
  name?: string;
  opacity?: number;
  outline?: DeserializedOutlineOptions | null;
  parentEntityId?: number | null;
  parentNodeName?: string | null;
  position?: THREE.Vector3Like;
  positionInterpolationMs?: number | null;
  rotation?: THREE.QuaternionLike;
  rotationInterpolationMs?: number | null;
  removed?: boolean;
  scale?: THREE.Vector3Like;
  scaleInterpolationMs?: number | null;
  tintColor?: THREE.Color | null;
}
export type DeserializedEntities = DeserializedEntity[];

export type DeserializedModelAnimation = {
  name: string;
  blendMode?: number;
  clampWhenFinished?: boolean;
  fadesIn?: boolean;
  fadesOut?: boolean;
  loopMode?: number;
  play?: boolean;
  pause?: boolean;
  playbackRate?: number;
  restart?: boolean;
  stop?: boolean;
  weight?: number;
}
export type DeserializedModelAnimations = DeserializedModelAnimation[];

export type DeserializedModelNodeOverride = {
  name: string;
  emissiveColor?: THREE.Color | null;
  emissiveIntensity?: number | null;
  hidden?: boolean;
  localPosition?: THREE.Vector3Like | null;
  localPositionInterpolationMs?: number | null;
  localRotation?: THREE.QuaternionLike | null;
  localRotationInterpolationMs?: number | null;
  localScale?: THREE.Vector3Like | null;
  localScaleInterpolationMs?: number | null;
  removed?: boolean;
}
export type DeserializedModelNodeOverrides = DeserializedModelNodeOverride[];

export type DeserializedOutlineOptions = {
  color?: THREE.Color;
  colorIntensity?: number;
  thickness?: number;
  opacity?: number;
  occluded?: boolean;
}

export type DeserializedParticleEmitter = {
  id: number;
  burst?: number;
  removed?: boolean;
  attachedToEntityId?: number;
  attachedToEntityNodeName?: string;
  position?: THREE.Vector3Like;
  offset?: THREE.Vector3Like;
  paused?: boolean;
  textureUri?: string;

  // Emitter options
  alphaTest?: number;
  colorEnd?: THREE.Color;
  colorEndVariance?: THREE.Color;
  colorStart?: THREE.Color;
  colorStartVariance?: THREE.Color;
  colorIntensityEnd?: number;
  colorIntensityEndVariance?: number;
  colorIntensityStart?: number;
  colorIntensityStartVariance?: number;
  gravity?: THREE.Vector3Like;
  lifetime?: number;
  lifetimeVariance?: number;
  lockToEmitter?: boolean;
  maxParticles?: number;
  orientation?: 'billboard' | 'billboardY' | 'fixed' | 'velocity';
  orientationFixedRotation?: THREE.Vector3Like;
  opacityEnd?: number;
  opacityEndVariance?: number;
  opacityStart?: number;
  opacityStartVariance?: number;
  positionVariance?: THREE.Vector3Like;
  rate?: number;
  rateVariance?: number;
  sizeEnd?: number;
  sizeEndVariance?: number;
  sizeStart?: number;
  sizeStartVariance?: number;
  transparent?: boolean;
  velocity?: THREE.Vector3Like;
  velocityVariance?: THREE.Vector3Like;
}
export type DeserializedParticleEmitters = DeserializedParticleEmitter[];

export type DeserializedPhysicsDebugRaycast = {
  origin: THREE.Vector3Like;
  direction: THREE.Vector3Like;
  length: number;
  hit: boolean;
}
export type DeserializedPhysicsDebugRaycasts = DeserializedPhysicsDebugRaycast[];

export type DeserializedPhysicsDebugRender = {
  vertices: Float32Array;
  colors: Float32Array;
}

export type DeserializedPlayer = {
  id: string;
  username?: string;
  profilePictureUrl?: string;
  removed?: boolean;
}
export type DeserializedPlayers = DeserializedPlayer[];

export type DeserializedSceneUI = {
  id: number;
  attachedToEntityId?: number;
  offset?: THREE.Vector3Like;
  position?: THREE.Vector3Like;
  removed?: boolean;
  state?: object;
  templateId?: string;
  viewDistance?: number;
}
export type DeserializedSceneUIs = DeserializedSceneUI[];

export type DeserializedSyncResponse = {
  serverReceivedRequestAt: number;
  serverSentResponseAt: number;
  serverProcessingTimeMs: number;
  serverNextTickFromResponseAtMs: number;
}

export type DeserializedUI = {
  appendHtmlUris?: string[];
  htmlUri?: string;
  pointerLock?: boolean;
  pointerLockFrozen?: boolean;
}

export type DeserializedUIData = { [key: string]: unknown };
export type DeserializedUIDatas = DeserializedUIData[];

export type DeserializedVectorBoolean = {
  x: boolean;
  y: boolean;
  z: boolean;
}

export type DeserializedWorld = {
  id: number;
  ambientLightColor?: THREE.Color;
  ambientLightIntensity?: number;
  directionalLightColor?: THREE.Color;
  directionalLightIntensity?: number;
  directionalLightPosition?: THREE.Vector3Like;
  fogColor?: THREE.Color | null;
  fogFar?: number;
  fogNear?: number;
  name?: string;
  skyboxUri?: string;
  skyboxIntensity?: number;
  timestep?: number;
}

export default class Deserializer {
  public static deserializeAudio(audio: protocol.AudioSchema): DeserializedAudio {
    return {
      id: audio.i,
      attachedToEntityId: audio.e ?? undefined, // temporray ?? undefined.
      cutoffDistance: audio.cd,
      duration: audio.d,
      detune: audio.de,
      distortion: audio.di,
      loop: audio.l,
      offset: audio.o,
      pause: audio.pa,
      play: audio.pl,
      playbackRate: audio.pr,
      position: audio.p ? this.deserializeVector(audio.p) : undefined,
      restart: audio.r,
      referenceDistance: audio.rd,
      startTick: audio.s,
      uri: audio.a,
      volume: audio.v,
    };
  }

  public static deserializeAudios(audios: protocol.AudiosSchema): DeserializedAudios {
    return audios.map((a: protocol.AudioSchema) => this.deserializeAudio(a));
  }

  public static deserializeBlock(block: protocol.BlockSchema): DeserializedBlock {
    return {
      id: block.i,
      globalCoordinate: this.deserializeVector(block.c),
      blockRotationIndex: block.r,
    };
  }

  public static deserializeBlocks(blocks: protocol.BlocksSchema): DeserializedBlocks {
    return blocks.map((b: protocol.BlockSchema) => this.deserializeBlock(b));
  }

  public static deserializeBlockType(blockType: protocol.BlockTypeSchema): DeserializedBlockType {
    return {
      id: blockType.i,
      isLiquid: blockType.l,
      name: blockType.n,
      textureUri: blockType.t,
      lightLevel: blockType.ll,
      trimeshIndices: blockType.ti ? new Uint32Array(blockType.ti) : undefined,
      trimeshVertices: blockType.tv ? new Float32Array(blockType.tv) : undefined,
    };
  }

  public static deserializeBlockTypes(blockTypes: protocol.BlockTypesSchema): DeserializedBlockTypes {
    return blockTypes.map((b: protocol.BlockTypeSchema) => this.deserializeBlockType(b));
  }

  public static deserializeCamera(camera: protocol.CameraSchema): DeserializedCamera {
    return {
      collidesWithBlocks: camera.cb,
      mode: camera.m,
      attachedToEntityId: 'e' in camera ? (camera.e ?? null) : undefined,
      attachedToPosition: 'p' in camera ? (camera.p ? this.deserializeVector(camera.p) : null) : undefined,
      filmOffset: camera.fo,
      forwardOffset: camera.ffo,
      fov: camera.fv,
      modelHiddenNodes: camera.h,
      modelPitchesWithCamera: camera.mp,
      modelShownNodes: camera.s,
      modelYawsWithCamera: camera.my,
      lookAtPosition: camera.pl ? this.deserializeVector(camera.pl) : undefined,
      offset: camera.o ? this.deserializeVector(camera.o) : undefined,
      shoulderAngle: camera.sa,
      trackedEntityId: 'et' in camera ? (camera.et ?? null) : undefined,
      trackedPosition: 'pt' in camera ? (camera.pt ? this.deserializeVector(camera.pt) : null) : undefined,
      zoom: camera.z,
    }
  }

  public static deserializeChatMessage(chatMessage: protocol.ChatMessageSchema): DeserializedChatMessage {
    return {
      message: chatMessage.m,
      color: chatMessage.c,
      playerId: chatMessage.p,
    }
  }

  public static deserializeChatMessages(chatMessages: protocol.ChatMessagesSchema): DeserializedChatMessages {
    return chatMessages.map((c: protocol.ChatMessageSchema) => this.deserializeChatMessage(c));
  }

  public static deserializeChunk(chunk: protocol.ChunkSchema): DeserializedChunk {
    return {
      originCoordinate: this.deserializeVector(chunk.c),
      blocks: chunk.b ? new Uint8Array(chunk.b) : undefined,
      blockRotations: chunk.r,
      removed: chunk.rm,
    }
  }

  public static deserializeChunks(chunks: protocol.ChunksSchema): DeserializedChunks {
    return chunks.map((c: protocol.ChunkSchema) => this.deserializeChunk(c));
  }

  public static deserializeConnection(connection: protocol.ConnectionSchema): DeserializedConnection {
    return {
      id: connection.i,
      kill: connection.k,
    };
  }

  public static deserializeEntity(entity: protocol.EntitySchema): DeserializedEntity {
    const entityWithInputAck = entity as protocol.EntitySchema & { aq?: number };

    return {
      acknowledgedInputSequenceNumber: entityWithInputAck.aq,
      id: entity.i,
      blockTextureUri: entity.bt,
      blockHalfExtents: entity.bh ? this.deserializeVector(entity.bh) : undefined,
      emissiveColor: 'ec' in entity ? (entity.ec ? new THREE.Color(entity.ec[0] / 255, entity.ec[1] / 255, entity.ec[2] / 255) : null) : undefined,
      emissiveIntensity: entity.ei,
      isEnvironmental: entity.e,
      modelAnimations: entity.ma ? this.deserializeModelAnimations(entity.ma) : undefined,
      modelNodeOverrides: entity.mo ? this.deserializeModelNodeOverrides(entity.mo) : undefined,
      modelTextureUri: entity.mt,
      modelUri: entity.m,
      name: entity.n,
      opacity: entity.o,
      outline: 'ol' in entity ? (entity.ol ? this.deserializeOutlineOptions(entity.ol) : null) : undefined,
      parentEntityId: 'pe' in entity ? (entity.pe ?? null) : undefined,
      parentNodeName: 'pn' in entity ? (entity.pn ?? null) : undefined,
      position: entity.p ? this.deserializeVector(entity.p) : undefined,
      positionInterpolationMs: 'pi' in entity ? (entity.pi ?? null) : undefined,
      rotation: entity.r ? this.deserializeQuaternion(entity.r) : undefined,
      rotationInterpolationMs: 'ri' in entity ? (entity.ri ?? null) : undefined,
      removed: entity.rm,
      scale: entity.sv ? this.deserializeVector(entity.sv) : undefined,
      scaleInterpolationMs: 'si' in entity ? (entity.si ?? null) : undefined,
      tintColor: 't' in entity ? (entity.t ? new THREE.Color(entity.t[0] / 255, entity.t[1] / 255, entity.t[2] / 255) : null) : undefined,
    };
  }

  public static deserializeEntities(entities: protocol.EntitiesSchema): DeserializedEntities {
    return entities.map((e: protocol.EntitySchema) => this.deserializeEntity(e));
  }

  public static deserializeModelAnimation(modelAnimation: protocol.ModelAnimationSchema): DeserializedModelAnimation {
    return {
      name: modelAnimation.n,
      blendMode: modelAnimation.b,
      clampWhenFinished: modelAnimation.c,
      fadesIn: modelAnimation.fi,
      fadesOut: modelAnimation.fo,
      loopMode: modelAnimation.l,
      play: modelAnimation.p,
      pause: modelAnimation.pa,
      playbackRate: modelAnimation.pr,
      restart: modelAnimation.r,
      stop: modelAnimation.s,
      weight: modelAnimation.w,
    };
  }

  public static deserializeModelAnimations(modelAnimations: protocol.ModelAnimationSchema[]): DeserializedModelAnimations {
    return modelAnimations.map((modelAnimation: protocol.ModelAnimationSchema) => this.deserializeModelAnimation(modelAnimation));
  }

  public static deserializeModelNodeOverride(modelNodeOverride: protocol.ModelNodeOverrideSchema): DeserializedModelNodeOverride {
    return {
      name: modelNodeOverride.n,
      emissiveColor: 'ec' in modelNodeOverride ? (modelNodeOverride.ec ? new THREE.Color(modelNodeOverride.ec[0] / 255, modelNodeOverride.ec[1] / 255, modelNodeOverride.ec[2] / 255) : null) : undefined,
      emissiveIntensity: 'ei' in modelNodeOverride ? (modelNodeOverride.ei ?? null) : undefined,
      hidden: modelNodeOverride.h,
      localPosition: 'p' in modelNodeOverride ? (modelNodeOverride.p ? this.deserializeVector(modelNodeOverride.p) : null) : undefined,
      localPositionInterpolationMs: 'pi' in modelNodeOverride ? (modelNodeOverride.pi ?? null) : undefined,
      localRotation: 'r' in modelNodeOverride ? (modelNodeOverride.r ? this.deserializeQuaternion(modelNodeOverride.r) : null) : undefined,
      localRotationInterpolationMs: 'ri' in modelNodeOverride ? (modelNodeOverride.ri ?? null) : undefined,
      localScale: 's' in modelNodeOverride ? (modelNodeOverride.s ? this.deserializeVector(modelNodeOverride.s) : null) : undefined,
      localScaleInterpolationMs: 'si' in modelNodeOverride ? (modelNodeOverride.si ?? null) : undefined,
      removed: modelNodeOverride.rm,
    };
  }

  public static deserializeModelNodeOverrides(modelNodeOverrides: protocol.ModelNodeOverrideSchema[]): DeserializedModelNodeOverrides {
    return modelNodeOverrides.map((m: protocol.ModelNodeOverrideSchema) => this.deserializeModelNodeOverride(m));
  }

  public static deserializeOutlineOptions(outlineOptions: protocol.OutlineSchema): DeserializedOutlineOptions {
    return {
      color: outlineOptions.c ? new THREE.Color(outlineOptions.c[0] / 255, outlineOptions.c[1] / 255, outlineOptions.c[2] / 255) : undefined,
      colorIntensity: outlineOptions.ci,
      thickness: outlineOptions.th,
      opacity: outlineOptions.o,
      occluded: outlineOptions.oc,
    };
  }

  public static deserializeParticleEmitter(particleEmitter: protocol.ParticleEmitterSchema): DeserializedParticleEmitter {
    return {
      id: particleEmitter.i,
      alphaTest: particleEmitter.at,
      attachedToEntityId: particleEmitter.e ?? undefined,
      attachedToEntityNodeName: particleEmitter.en ?? undefined,
      burst: particleEmitter.b,
      colorEnd: particleEmitter.ce ? new THREE.Color(particleEmitter.ce[0] / 255, particleEmitter.ce[1] / 255, particleEmitter.ce[2] / 255) : undefined,
      colorEndVariance: particleEmitter.cev ? new THREE.Color(particleEmitter.cev[0] / 255, particleEmitter.cev[1] / 255, particleEmitter.cev[2] / 255) : undefined,
      colorStart: particleEmitter.cs ? new THREE.Color(particleEmitter.cs[0] / 255, particleEmitter.cs[1] / 255, particleEmitter.cs[2] / 255) : undefined,
      colorStartVariance: particleEmitter.csv ? new THREE.Color(particleEmitter.csv[0] / 255, particleEmitter.csv[1] / 255, particleEmitter.csv[2] / 255) : undefined,
      colorIntensityStart: particleEmitter.cis,
      colorIntensityEnd: particleEmitter.cie,
      colorIntensityStartVariance: particleEmitter.cisv,
      colorIntensityEndVariance: particleEmitter.ciev,
      gravity: particleEmitter.g ? this.deserializeVector(particleEmitter.g) : undefined,
      lifetime: particleEmitter.l,
      lifetimeVariance: particleEmitter.lv,
      lockToEmitter: particleEmitter.le,
      maxParticles: particleEmitter.mp,
      offset: particleEmitter.o ? this.deserializeVector(particleEmitter.o) : undefined,
      orientation: particleEmitter.or !== undefined ? this.deserializeOrientation(particleEmitter.or) : undefined,
      orientationFixedRotation: particleEmitter.ofr ? this.deserializeVector(particleEmitter.ofr) : undefined,
      opacityEnd: particleEmitter.oe,
      opacityEndVariance: particleEmitter.oev,
      opacityStart: particleEmitter.os,
      opacityStartVariance: particleEmitter.osv,
      paused: particleEmitter.pa,
      position: particleEmitter.p ? this.deserializeVector(particleEmitter.p) : undefined,
      positionVariance: particleEmitter.pv ? this.deserializeVector(particleEmitter.pv) : undefined,
      rate: particleEmitter.r,
      rateVariance: particleEmitter.rv,
      removed: particleEmitter.rm,
      sizeEnd: particleEmitter.se,
      sizeEndVariance: particleEmitter.sev,
      sizeStart: particleEmitter.ss,
      sizeStartVariance: particleEmitter.ssv,
      textureUri: particleEmitter.tu,
      transparent: particleEmitter.t,
      velocity: particleEmitter.v ? this.deserializeVector(particleEmitter.v) : undefined,
      velocityVariance: particleEmitter.vv ? this.deserializeVector(particleEmitter.vv) : undefined,
    };
  }

  public static deserializeParticleEmitters(particleEmitters: protocol.ParticleEmittersSchema): DeserializedParticleEmitters {
    return particleEmitters.map((p: protocol.ParticleEmitterSchema) => this.deserializeParticleEmitter(p));
  }

  public static deserializePhysicsDebugRaycast(physicsDebugRaycast: protocol.PhysicsDebugRaycastSchema): DeserializedPhysicsDebugRaycast {
    return {
      origin: this.deserializeVector(physicsDebugRaycast.o),
      direction: this.deserializeVector(physicsDebugRaycast.d),
      length: physicsDebugRaycast.l,
      hit: physicsDebugRaycast.h,
    }
  }

  public static deserializePhysicsDebugRaycasts(physicsDebugRaycasts: protocol.PhysicsDebugRaycastsSchema): DeserializedPhysicsDebugRaycasts {
    return physicsDebugRaycasts.map((r: protocol.PhysicsDebugRaycastSchema) => this.deserializePhysicsDebugRaycast(r));
  }

  public static deserializePhysicsDebugRender(physicsDebugRender: protocol.PhysicsDebugRenderSchema): DeserializedPhysicsDebugRender {
    return {
      vertices: new Float32Array(physicsDebugRender.v),
      colors: new Float32Array(physicsDebugRender.c),
    }
  }

  public static deserializePlayer(player: protocol.PlayerSchema): DeserializedPlayer {
    return {
      id: player.i,
      username: player.u,
      profilePictureUrl: player.p,
      removed: player.rm,
    }
  }

  public static deserializePlayers(players: protocol.PlayersSchema): DeserializedPlayers {
    return players.map((p: protocol.PlayerSchema) => this.deserializePlayer(p));
  }

  public static deserializeSceneUI(sceneUI: protocol.SceneUISchema): DeserializedSceneUI {
    return {
      id: sceneUI.i,
      attachedToEntityId: sceneUI.e ?? undefined,
      offset: sceneUI.o ? this.deserializeVector(sceneUI.o) : undefined,
      position: sceneUI.p ? this.deserializeVector(sceneUI.p) : undefined,
      removed: sceneUI.rm,
      state: sceneUI.s,
      templateId: sceneUI.t,
      viewDistance: sceneUI.v,
    }
  }

  public static deserializeSceneUIs(sceneUIs: protocol.SceneUIsSchema): DeserializedSceneUIs {
    return sceneUIs.map((s: protocol.SceneUISchema) => this.deserializeSceneUI(s));
  }

  public static deserializeSyncResponse(syncResponse: protocol.SyncResponseSchema): DeserializedSyncResponse {
    return {
      serverReceivedRequestAt: syncResponse.r,
      serverSentResponseAt: syncResponse.s,
      serverProcessingTimeMs: syncResponse.p,
      serverNextTickFromResponseAtMs: syncResponse.n,
    };
  }

  public static deserializeOrientation(orientation: number): 'billboard' | 'billboardY' | 'fixed' | 'velocity' {
    switch (orientation) {
      case 0: return 'billboard';
      case 1: return 'billboardY';
      case 2: return 'fixed';
      case 3: return 'velocity';
      default: return 'billboard';
    }
  }

  public static deserializeQuaternion(quaternion: protocol.QuaternionSchema): THREE.QuaternionLike {
    return {
      x: quaternion[0],
      y: quaternion[1],
      z: quaternion[2],
      w: quaternion[3],
    };
  }

  public static deserializeUI(ui: protocol.UISchema): DeserializedUI {
    return {
      appendHtmlUris: ui.ua,
      htmlUri: ui.u,
      pointerLock: ui.p,
      pointerLockFrozen: ui.pf,
    }
  }

  public static deserializeUIData(uiData: protocol.UIDataSchema): DeserializedUIData {
    return uiData;
  }

  public static deserializeUIDatas(uiDatas: protocol.UIDatasSchema): DeserializedUIDatas {
    return uiDatas.map((u: protocol.UIDataSchema) => this.deserializeUIData(u));
  }

  public static deserializeVector(vector: protocol.VectorSchema): THREE.Vector3Like {
    return {
      x: vector[0],
      y: vector[1],
      z: vector[2],
    };
  }

  public static deserializeVectorBoolean(vectorBoolean: protocol.VectorBooleanSchema): DeserializedVectorBoolean {
    return {
      x: vectorBoolean[0],
      y: vectorBoolean[1],
      z: vectorBoolean[2],
    };
  }

  public static deserializeWorld(world: protocol.WorldSchema): DeserializedWorld {
    return {
      id: world.i,
      ambientLightColor: world.ac ? new THREE.Color(world.ac[0] / 255, world.ac[1] / 255, world.ac[2] / 255) : undefined,
      ambientLightIntensity: world.ai,
      directionalLightColor: world.dc ? new THREE.Color(world.dc[0] / 255, world.dc[1] / 255, world.dc[2] / 255) : undefined,
      directionalLightIntensity: world.di,
      directionalLightPosition: world.dp ? this.deserializeVector(world.dp) : undefined,
      fogColor: 'fc' in world ? (world.fc ? new THREE.Color(world.fc[0] / 255, world.fc[1] / 255, world.fc[2] / 255) : null) : undefined,
      fogFar: world.ff,
      fogNear: world.fn,
      name: world.n,
      skyboxUri: world.s,
      skyboxIntensity: world.si,
      timestep: world.t,
    };
  }
}
