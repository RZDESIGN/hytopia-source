import { gzipSync } from 'node:zlib';
import { Packr, FLOAT32_OPTIONS } from 'msgpackr';

const msgpackr = new Packr({ useFloat32: FLOAT32_OPTIONS.ALWAYS });
const PROCESS_ID = `child-${process.pid}`;
const SYNC_REQUEST_PACKET_ID = 0;
const SYNC_RESPONSE_PACKET_ID = 32;
const AUDIOS_PACKET_ID = 33;
const BLOCKS_PACKET_ID = 34;
const BLOCK_TYPES_PACKET_ID = 35;
const CHAT_MESSAGES_PACKET_ID = 36;
const CHUNKS_PACKET_ID = 37;
const ENTITIES_PACKET_ID = 38;
const WORLD_PACKET_ID = 39;
const CAMERA_PACKET_ID = 40;
const PLAYERS_PACKET_ID = 45;
const PARTICLE_EMITTERS_PACKET_ID = 46;
const UI_PACKET_ID = 41;
const UI_DATAS_PACKET_ID = 42;
const SCENE_UIS_PACKET_ID = 43;
const NOTIFICATION_PERMISSION_REQUEST_PACKET_ID = 47;
const DEFAULT_TICK_RATE = 20;
const CHUNK_AXES_RANGE = 15;
const CHUNK_SIZE_BITS = 4;
const CHUNK_SIZE = 1 << CHUNK_SIZE_BITS;
const CHUNK_STREAM_HORIZONTAL_RADIUS = Math.max(0, Math.floor(Number(process.env.HYTOPIA_CHUNK_STREAM_HORIZONTAL_RADIUS ?? 6)));
const CHUNK_STREAM_VERTICAL_RADIUS = Math.max(0, Math.floor(Number(process.env.HYTOPIA_CHUNK_STREAM_VERTICAL_RADIUS ?? 3)));
const CHUNK_STREAM_MAX_LOADS_PER_SYNC = Math.max(1, Math.floor(Number(process.env.HYTOPIA_CHUNK_STREAM_MAX_LOADS_PER_SYNC ?? 48)));
const worlds = new Map();

const serializePackets = packets => {
  const rawBuffer = msgpackr.pack(packets);
  let wireBuffer = rawBuffer;

  if (rawBuffer.byteLength > 64 * 1024) {
    wireBuffer = gzipSync(rawBuffer, { level: 1 });
  }

  return {
    rawBytes: rawBuffer.byteLength,
    wireBytes: wireBuffer,
  };
};

const sendToGateway = message => {
  if (typeof process.send === 'function') {
    process.send(message);
  }
};

const toRgbSchema = color => color ? [ color.r, color.g, color.b ] : undefined;
const toVectorSchema = vector => vector ? [ vector.x, vector.y, vector.z ] : undefined;
const toPlayerSchema = playerDescriptor => ({
  i: playerDescriptor.id,
  p: playerDescriptor.profilePictureUrl,
  u: playerDescriptor.username,
});
const toRemovedPlayerSchema = playerId => ({
  i: playerId,
  rm: true,
});
const toWorldSchema = (worldDescriptor, options) => ({
  i: Number(worldDescriptor?.id ?? options?.id),
  ac: toRgbSchema(options?.ambientLightColor),
  ai: options?.ambientLightIntensity,
  dc: toRgbSchema(options?.directionalLightColor),
  di: options?.directionalLightIntensity,
  dp: toVectorSchema(options?.directionalLightPosition),
  fc: toRgbSchema(options?.fogColor),
  ff: options?.fogFar,
  fn: options?.fogNear,
  n: options?.name ?? worldDescriptor?.name,
  s: options?.skyboxUri,
  si: options?.skyboxIntensity,
  t: options?.tickRate ? 1 / options.tickRate : 1 / DEFAULT_TICK_RATE,
});
const packCoordinate = coordinate => Array.isArray(coordinate) && coordinate.length === 3
  ? `${coordinate[0]},${coordinate[1]},${coordinate[2]}`
  : undefined;
const packOriginForGlobalCoordinate = coordinate => Array.isArray(coordinate) && coordinate.length === 3
  ? `${(coordinate[0] | 0) - (coordinate[0] & CHUNK_AXES_RANGE)},${(coordinate[1] | 0) - (coordinate[1] & CHUNK_AXES_RANGE)},${(coordinate[2] | 0) - (coordinate[2] & CHUNK_AXES_RANGE)}`
  : undefined;
const toLocalCoordinate = coordinate => ({
  x: coordinate[0] & CHUNK_AXES_RANGE,
  y: coordinate[1] & CHUNK_AXES_RANGE,
  z: coordinate[2] & CHUNK_AXES_RANGE,
});
const localCoordinateToBlockIndex = localCoordinate => (
  localCoordinate.x + (localCoordinate.y << CHUNK_SIZE_BITS) + (localCoordinate.z << (CHUNK_SIZE_BITS * 2))
);
const cloneChunkSchema = chunk => ({
  ...chunk,
  b: Array.isArray(chunk?.b) ? [ ...chunk.b ] : chunk?.b,
  r: Array.isArray(chunk?.r) ? [ ...chunk.r ] : chunk?.r,
});
const cloneCameraSchema = camera => ({
  ...camera,
  h: Array.isArray(camera?.h) ? [ ...camera.h ] : camera?.h,
  o: Array.isArray(camera?.o) ? [ ...camera.o ] : camera?.o,
  p: Array.isArray(camera?.p) ? [ ...camera.p ] : camera?.p,
  pl: Array.isArray(camera?.pl) ? [ ...camera.pl ] : camera?.pl,
  pt: Array.isArray(camera?.pt) ? [ ...camera.pt ] : camera?.pt,
  s: Array.isArray(camera?.s) ? [ ...camera.s ] : camera?.s,
});
const cloneEntityModelAnimationSchema = entityModelAnimation => ({ ...entityModelAnimation });
const cloneEntityModelNodeOverrideSchema = entityModelNodeOverride => ({
  ...entityModelNodeOverride,
  ec: Array.isArray(entityModelNodeOverride?.ec) ? [ ...entityModelNodeOverride.ec ] : entityModelNodeOverride?.ec,
  p: Array.isArray(entityModelNodeOverride?.p) ? [ ...entityModelNodeOverride.p ] : entityModelNodeOverride?.p,
  r: Array.isArray(entityModelNodeOverride?.r) ? [ ...entityModelNodeOverride.r ] : entityModelNodeOverride?.r,
  s: Array.isArray(entityModelNodeOverride?.s) ? [ ...entityModelNodeOverride.s ] : entityModelNodeOverride?.s,
});
const mergeNamedSchemaList = (currentItems, patchItems, cloneItem) => {
  const mergedItemsByName = new Map();

  if (Array.isArray(currentItems)) {
    for (const currentItem of currentItems) {
      if (typeof currentItem?.n !== 'string') {
        continue;
      }

      mergedItemsByName.set(currentItem.n, cloneItem(currentItem));
    }
  }

  if (Array.isArray(patchItems)) {
    for (const patchItem of patchItems) {
      if (typeof patchItem?.n !== 'string') {
        continue;
      }

      if (patchItem.rm) {
        mergedItemsByName.delete(patchItem.n);
        continue;
      }

      const existingItem = mergedItemsByName.get(patchItem.n);
      mergedItemsByName.set(patchItem.n, cloneItem({
        ...existingItem,
        ...patchItem,
      }));
    }
  }

  return Array.from(mergedItemsByName.values());
};
const cloneEntitySchema = entity => ({
  ...entity,
  bh: Array.isArray(entity?.bh) ? [ ...entity.bh ] : entity?.bh,
  ec: Array.isArray(entity?.ec) ? [ ...entity.ec ] : entity?.ec,
  ma: Array.isArray(entity?.ma) ? entity.ma.map(cloneEntityModelAnimationSchema) : entity?.ma,
  mo: Array.isArray(entity?.mo) ? entity.mo.map(cloneEntityModelNodeOverrideSchema) : entity?.mo,
  ol: entity?.ol ? {
    ...entity.ol,
    c: Array.isArray(entity.ol.c) ? [ ...entity.ol.c ] : entity.ol.c,
  } : entity?.ol,
  p: Array.isArray(entity?.p) ? [ ...entity.p ] : entity?.p,
  r: Array.isArray(entity?.r) ? [ ...entity.r ] : entity?.r,
  sv: Array.isArray(entity?.sv) ? [ ...entity.sv ] : entity?.sv,
  t: Array.isArray(entity?.t) ? [ ...entity.t ] : entity?.t,
});
const mergeEntitySchema = (existingEntity, entityPatch) => {
  const mergedEntity = {
    ...existingEntity,
    ...entityPatch,
  };

  if (Array.isArray(entityPatch?.ma)) {
    mergedEntity.ma = mergeNamedSchemaList(existingEntity?.ma, entityPatch.ma, cloneEntityModelAnimationSchema);
  }

  if (Array.isArray(entityPatch?.mo)) {
    mergedEntity.mo = mergeNamedSchemaList(existingEntity?.mo, entityPatch.mo, cloneEntityModelNodeOverrideSchema);
  }

  return cloneEntitySchema(mergedEntity);
};
const upsertBlockRotation = (chunk, blockIndex, blockRotation) => {
  const rotations = Array.isArray(chunk.r) ? chunk.r : [];

  for (let i = 0; i < rotations.length; i += 2) {
    if (rotations[i] !== blockIndex) {
      continue;
    }

    if (blockRotation === undefined) {
      rotations.splice(i, 2);
    } else {
      rotations[i + 1] = blockRotation;
    }

    chunk.r = rotations;
    return;
  }

  if (blockRotation !== undefined) {
    rotations.push(blockIndex, blockRotation);
    chunk.r = rotations;
  }
};

const log = (level, message, worldId) => {
  sendToGateway({
    type: 'world_log',
    level,
    message,
    worldId,
    processId: PROCESS_ID,
  });
};

class ShadowHostedWorldRuntime {
  constructor(worldDescriptor, options) {
    this.chunkInterestStateByPlayer = new Map();
    this.descriptor = worldDescriptor;
    this.options = options;
    this.bootedAtMonotonicMs = performance.now();
    this.currentAudioStateById = new Map();
    this.currentBlockTypeStateById = new Map();
    this.currentCameraStateByPlayerId = new Map();
    this.currentChunkStateByKey = new Map();
    this.currentEntityStateById = new Map();
    this.currentParticleEmitterStateById = new Map();
    this.currentWorldState = toWorldSchema(worldDescriptor, options);
    this.currentSceneUIStateById = new Map();
    this.loadedChunkKeysByPlayer = new Map();
    this.packetsReceived = 0;
    this.players = new Map();
    this.pendingPacketsByPlayer = new Map();
    this.flushScheduled = false;
  }

  get id() {
    return Number(this.descriptor?.id ?? this.options?.id);
  }

  attachPlayer(playerDescriptor) {
    const existingPlayers = Array.from(this.players.values());
    this.players.set(playerDescriptor.id, playerDescriptor);
    this.chunkInterestStateByPlayer.set(playerDescriptor.id, { needsRefresh: true });
    this.loadedChunkKeysByPlayer.set(playerDescriptor.id, new Set());

    this.queuePacket(playerDescriptor.id, [
      WORLD_PACKET_ID,
      { ...this.currentWorldState },
      this.getTickMetrics().currentTick,
    ]);
    if (this.currentAudioStateById.size > 0) {
      this.queuePacket(playerDescriptor.id, [
        AUDIOS_PACKET_ID,
        Array.from(this.currentAudioStateById.values(), audio => ({ ...audio })),
        this.getTickMetrics().currentTick,
      ]);
    }
    if (this.currentBlockTypeStateById.size > 0) {
      this.queuePacket(playerDescriptor.id, [
        BLOCK_TYPES_PACKET_ID,
        Array.from(this.currentBlockTypeStateById.values(), blockType => ({ ...blockType })),
        this.getTickMetrics().currentTick,
      ]);
    }
    if (this.currentEntityStateById.size > 0) {
      this.queuePacket(playerDescriptor.id, [
        ENTITIES_PACKET_ID,
        Array.from(this.currentEntityStateById.values(), cloneEntitySchema),
        this.getTickMetrics().currentTick,
      ]);
    }
    if (this.currentParticleEmitterStateById.size > 0) {
      this.queuePacket(playerDescriptor.id, [
        PARTICLE_EMITTERS_PACKET_ID,
        Array.from(this.currentParticleEmitterStateById.values(), particleEmitter => ({ ...particleEmitter })),
        this.getTickMetrics().currentTick,
      ]);
    }
    this.queuePacket(playerDescriptor.id, [
      PLAYERS_PACKET_ID,
      Array.from(this.players.values(), toPlayerSchema),
      this.getTickMetrics().currentTick,
    ]);
    if (this.currentSceneUIStateById.size > 0) {
      this.queuePacket(playerDescriptor.id, [
        SCENE_UIS_PACKET_ID,
        Array.from(this.currentSceneUIStateById.values(), sceneUI => ({ ...sceneUI })),
        this.getTickMetrics().currentTick,
      ]);
    }

    const newPlayerSync = toPlayerSchema(playerDescriptor);
    for (const existingPlayer of existingPlayers) {
      this.queuePacket(existingPlayer.id, [
        PLAYERS_PACKET_ID,
        [ newPlayerSync ],
        this.getTickMetrics().currentTick,
      ]);
    }

    this.syncPlayerChunkInterest(playerDescriptor.id, this.getTickMetrics().currentTick);
  }

  detachPlayer(playerId) {
    const existingPlayer = this.players.get(playerId);
    this.chunkInterestStateByPlayer.delete(playerId);
    this.currentCameraStateByPlayerId.delete(playerId);
    this.loadedChunkKeysByPlayer.delete(playerId);
    this.players.delete(playerId);
    this.pendingPacketsByPlayer.delete(playerId);

    if (!existingPlayer) {
      return;
    }

    const removedPlayerSync = toRemovedPlayerSchema(playerId);
    for (const remainingPlayerId of this.players.keys()) {
      this.queuePacket(remainingPlayerId, [
        PLAYERS_PACKET_ID,
        [ removedPlayerSync ],
        this.getTickMetrics().currentTick,
      ]);
    }
  }

  handlePlayerPackets(playerId, envelopes) {
    this.packetsReceived += envelopes.length;

    for (const envelope of envelopes) {
      if (!Array.isArray(envelope?.packet)) {
        continue;
      }

      if (envelope.packet[0] === SYNC_REQUEST_PACKET_ID) {
        this.queuePacket(playerId, [
          SYNC_RESPONSE_PACKET_ID,
          {
            r: envelope.receivedAtUnixMs,
            s: Date.now(),
            p: performance.now() - envelope.receivedAtMonotonicMs,
            n: this.getTickMetrics().nextTickAtMs,
          },
          this.getTickMetrics().currentTick,
        ]);
      }
    }
  }

  requestNotificationPermission(playerId) {
    this.queuePacket(playerId, [
      NOTIFICATION_PERMISSION_REQUEST_PACKET_ID,
      null,
      this.getTickMetrics().currentTick,
    ]);
  }

  queueCamera(playerId, camera, worldTick) {
    const existingCamera = this.currentCameraStateByPlayerId.get(playerId);
    this.currentCameraStateByPlayerId.set(playerId, {
      ...existingCamera,
      ...cloneCameraSchema(camera),
    });

    this.queuePacket(playerId, [
      CAMERA_PACKET_ID,
      camera,
      this.resolveWorldTick(worldTick),
    ]);

    this.syncPlayerChunkInterest(playerId, worldTick);
  }

  queueEntities(playerId, entities, worldTick) {
    this.queuePacket(playerId, [
      ENTITIES_PACKET_ID,
      entities.map(cloneEntitySchema),
      this.resolveWorldTick(worldTick),
    ]);
  }

  queueChatMessages(playerId, chatMessages, worldTick) {
    this.queuePacket(playerId, [
      CHAT_MESSAGES_PACKET_ID,
      chatMessages,
      this.resolveWorldTick(worldTick),
    ]);
  }

  queueUI(playerId, ui, worldTick) {
    this.queuePacket(playerId, [
      UI_PACKET_ID,
      ui,
      this.resolveWorldTick(worldTick),
    ]);
  }

  queueUIDatas(playerId, uiDatas, worldTick) {
    this.queuePacket(playerId, [
      UI_DATAS_PACKET_ID,
      uiDatas,
      this.resolveWorldTick(worldTick),
    ]);
  }

  queuePlayers(playerId, players, worldTick) {
    this.queuePacket(playerId, [
      PLAYERS_PACKET_ID,
      players,
      this.resolveWorldTick(worldTick),
    ]);
  }

  queueWorld(playerId, world, worldTick) {
    this.currentWorldState = {
      ...this.currentWorldState,
      ...world,
    };

    this.queuePacket(playerId, [
      WORLD_PACKET_ID,
      world,
      this.resolveWorldTick(worldTick),
    ]);
  }

  applyWorldStatePatch(world, worldTick) {
    this.currentWorldState = {
      ...this.currentWorldState,
      ...world,
    };

    const resolvedWorldTick = this.resolveWorldTick(worldTick);
    for (const playerId of this.players.keys()) {
      this.queuePacket(playerId, [
        WORLD_PACKET_ID,
        world,
        resolvedWorldTick,
      ]);
    }
  }

  applySceneUIStatePatch(sceneUI, worldTick) {
    const sceneUIId = Number(sceneUI?.i);
    if (!Number.isFinite(sceneUIId)) {
      return;
    }

    if (sceneUI.rm) {
      this.currentSceneUIStateById.delete(sceneUIId);
    } else {
      const existingSceneUI = this.currentSceneUIStateById.get(sceneUIId);
      this.currentSceneUIStateById.set(sceneUIId, {
        ...existingSceneUI,
        ...sceneUI,
      });
    }

    const resolvedWorldTick = this.resolveWorldTick(worldTick);
    for (const playerId of this.players.keys()) {
      this.queuePacket(playerId, [
        SCENE_UIS_PACKET_ID,
        [ sceneUI ],
        resolvedWorldTick,
      ]);
    }
  }

  applyAudioStatePatch(audio, worldTick) {
    const audioId = Number(audio?.i);
    if (!Number.isFinite(audioId)) {
      return;
    }

    const existingAudio = this.currentAudioStateById.get(audioId);
    this.currentAudioStateById.set(audioId, {
      ...existingAudio,
      ...audio,
    });

    const resolvedWorldTick = this.resolveWorldTick(worldTick);
    for (const playerId of this.players.keys()) {
      this.queuePacket(playerId, [
        AUDIOS_PACKET_ID,
        [ audio ],
        resolvedWorldTick,
      ]);
    }
  }

  removeAudioState(audioId) {
    this.currentAudioStateById.delete(audioId);
  }

  applyBlockTypeStatePatch(blockType, worldTick) {
    const blockTypeId = Number(blockType?.i);
    if (!Number.isFinite(blockTypeId)) {
      return;
    }

    this.currentBlockTypeStateById.set(blockTypeId, { ...blockType });

    const resolvedWorldTick = this.resolveWorldTick(worldTick);
    for (const playerId of this.players.keys()) {
      this.queuePacket(playerId, [
        BLOCK_TYPES_PACKET_ID,
        [ blockType ],
        resolvedWorldTick,
      ]);
    }
  }

  applyChunkStatePatch(chunk, worldTick) {
    const chunkKey = packCoordinate(chunk?.c);
    if (!chunkKey) {
      return;
    }

    if (chunk.rm) {
      this.currentChunkStateByKey.delete(chunkKey);
    } else {
      this.currentChunkStateByKey.set(chunkKey, cloneChunkSchema(chunk));
    }

    const resolvedWorldTick = this.resolveWorldTick(worldTick);

    for (const playerId of this.players.keys()) {
      const loadedChunkKeys = this.loadedChunkKeysByPlayer.get(playerId);

      if (chunk.rm) {
        if (!loadedChunkKeys?.has(chunkKey)) {
          continue;
        }

        loadedChunkKeys.delete(chunkKey);
        this.queuePacket(playerId, [
          CHUNKS_PACKET_ID,
          [ chunk ],
          resolvedWorldTick,
        ]);
        continue;
      }

      if (loadedChunkKeys?.has(chunkKey)) {
        this.queuePacket(playerId, [
          CHUNKS_PACKET_ID,
          [ chunk ],
          resolvedWorldTick,
        ]);
        continue;
      }

      const centerChunkOrigin = this.getPlayerChunkInterestCenterOrigin(playerId);
      if (!centerChunkOrigin || !this.isChunkKeyInRange(chunkKey, centerChunkOrigin)) {
        continue;
      }

      this.queuePacket(playerId, [
        CHUNKS_PACKET_ID,
        [ chunk ],
        resolvedWorldTick,
      ]);
      this.getOrCreateLoadedChunkKeys(playerId).add(chunkKey);
    }
  }

  applyBlockStatePatch(block, worldTick) {
    const chunkKey = packOriginForGlobalCoordinate(block?.c);
    const currentChunk = chunkKey ? this.currentChunkStateByKey.get(chunkKey) : undefined;
    if (currentChunk?.b && Array.isArray(currentChunk.b)) {
      const localCoordinate = toLocalCoordinate(block.c);
      const blockIndex = localCoordinateToBlockIndex(localCoordinate);
      currentChunk.b[blockIndex] = block.i;
      upsertBlockRotation(currentChunk, blockIndex, block.r);
    }

    const resolvedWorldTick = this.resolveWorldTick(worldTick);
    for (const playerId of this.players.keys()) {
      const loadedChunkKeys = this.loadedChunkKeysByPlayer.get(playerId);
      if (!chunkKey || !loadedChunkKeys?.has(chunkKey)) {
        continue;
      }

      this.queuePacket(playerId, [
        BLOCKS_PACKET_ID,
        [ block ],
        resolvedWorldTick,
      ]);
    }
  }

  applyEntityStatePatch(entity, worldTick) {
    const entityId = Number(entity?.i);
    if (!Number.isFinite(entityId)) {
      return;
    }

    if (entity.rm) {
      this.currentEntityStateById.delete(entityId);
    } else {
      const existingEntity = this.currentEntityStateById.get(entityId);
      this.currentEntityStateById.set(entityId, mergeEntitySchema(existingEntity, entity));
    }

    const resolvedWorldTick = this.resolveWorldTick(worldTick);
    for (const playerId of this.players.keys()) {
      this.queuePacket(playerId, [
        ENTITIES_PACKET_ID,
        [ cloneEntitySchema(entity) ],
        resolvedWorldTick,
      ]);
    }

    if (!entity?.p && !entity?.rm) {
      return;
    }

    for (const [ playerId, camera ] of this.currentCameraStateByPlayerId.entries()) {
      if (camera?.e !== entityId) {
        continue;
      }

      this.syncPlayerChunkInterest(playerId, resolvedWorldTick);
    }
  }

  applyParticleEmitterStatePatch(particleEmitter, worldTick) {
    const particleEmitterId = Number(particleEmitter?.i);
    if (!Number.isFinite(particleEmitterId)) {
      return;
    }

    if (particleEmitter.rm) {
      this.currentParticleEmitterStateById.delete(particleEmitterId);
    } else {
      const existingParticleEmitter = this.currentParticleEmitterStateById.get(particleEmitterId);
      this.currentParticleEmitterStateById.set(particleEmitterId, {
        ...existingParticleEmitter,
        ...particleEmitter,
      });
    }

    const resolvedWorldTick = this.resolveWorldTick(worldTick);
    for (const playerId of this.players.keys()) {
      this.queuePacket(playerId, [
        PARTICLE_EMITTERS_PACKET_ID,
        [ particleEmitter ],
        resolvedWorldTick,
      ]);
    }
  }

  queuePacket(playerId, packet) {
    if (!this.players.has(playerId)) {
      return false;
    }

    const queuedPackets = this.pendingPacketsByPlayer.get(playerId);
    if (queuedPackets) {
      queuedPackets.push(packet);
    } else {
      this.pendingPacketsByPlayer.set(playerId, [ packet ]);
    }

    this.scheduleFlush();
    return true;
  }

  scheduleFlush() {
    if (this.flushScheduled) {
      return;
    }

    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      this.flushPendingPackets();
    });
  }

  getOrCreateLoadedChunkKeys(playerId) {
    let loadedChunkKeys = this.loadedChunkKeysByPlayer.get(playerId);
    if (!loadedChunkKeys) {
      loadedChunkKeys = new Set();
      this.loadedChunkKeysByPlayer.set(playerId, loadedChunkKeys);
    }

    return loadedChunkKeys;
  }

  getOrCreateChunkInterestState(playerId) {
    let state = this.chunkInterestStateByPlayer.get(playerId);
    if (!state) {
      state = { needsRefresh: true };
      this.chunkInterestStateByPlayer.set(playerId, state);
    }

    return state;
  }

  getPlayerChunkInterestCenter(playerId) {
    const camera = this.currentCameraStateByPlayerId.get(playerId);
    if (!camera) {
      return undefined;
    }

    if (Array.isArray(camera.p) && camera.p.length === 3) {
      return camera.p;
    }

    if (Number.isFinite(camera.e)) {
      const entityPosition = this.currentEntityStateById.get(camera.e)?.p;
      if (Array.isArray(entityPosition) && entityPosition.length === 3) {
        return entityPosition;
      }
    }

    if (Array.isArray(camera.pt) && camera.pt.length === 3) {
      return camera.pt;
    }

    if (Number.isFinite(camera.et)) {
      const entityPosition = this.currentEntityStateById.get(camera.et)?.p;
      if (Array.isArray(entityPosition) && entityPosition.length === 3) {
        return entityPosition;
      }
    }

    return undefined;
  }

  getPlayerChunkInterestCenterOrigin(playerId) {
    const center = this.getPlayerChunkInterestCenter(playerId);
    if (!center) {
      return undefined;
    }

    return [
      (center[0] | 0) - (center[0] & CHUNK_AXES_RANGE),
      (center[1] | 0) - (center[1] & CHUNK_AXES_RANGE),
      (center[2] | 0) - (center[2] & CHUNK_AXES_RANGE),
    ];
  }

  isChunkKeyInRange(chunkKey, centerChunkOrigin) {
    const originCoordinate = chunkKey.split(',').map(Number);
    if (originCoordinate.length !== 3 || originCoordinate.some(value => !Number.isFinite(value))) {
      return false;
    }

    const dx = (originCoordinate[0] - centerChunkOrigin[0]) / CHUNK_SIZE;
    const dy = Math.abs((originCoordinate[1] - centerChunkOrigin[1]) / CHUNK_SIZE);
    const dz = (originCoordinate[2] - centerChunkOrigin[2]) / CHUNK_SIZE;

    return dy <= CHUNK_STREAM_VERTICAL_RADIUS &&
      (dx * dx + dz * dz) <= CHUNK_STREAM_HORIZONTAL_RADIUS * CHUNK_STREAM_HORIZONTAL_RADIUS;
  }

  collectDesiredChunksForCenter(centerChunkOrigin) {
    const desiredChunks = [];

    for (let dy = -CHUNK_STREAM_VERTICAL_RADIUS; dy <= CHUNK_STREAM_VERTICAL_RADIUS; dy++) {
      for (let dx = -CHUNK_STREAM_HORIZONTAL_RADIUS; dx <= CHUNK_STREAM_HORIZONTAL_RADIUS; dx++) {
        for (let dz = -CHUNK_STREAM_HORIZONTAL_RADIUS; dz <= CHUNK_STREAM_HORIZONTAL_RADIUS; dz++) {
          const horizontalDistanceSq = dx * dx + dz * dz;
          if (horizontalDistanceSq > CHUNK_STREAM_HORIZONTAL_RADIUS * CHUNK_STREAM_HORIZONTAL_RADIUS) {
            continue;
          }

          const chunkKey = `${centerChunkOrigin[0] + dx * CHUNK_SIZE},${centerChunkOrigin[1] + dy * CHUNK_SIZE},${centerChunkOrigin[2] + dz * CHUNK_SIZE}`;
          const chunk = this.currentChunkStateByKey.get(chunkKey);
          if (!chunk) {
            continue;
          }

          desiredChunks.push({
            chunk,
            key: chunkKey,
            distanceSq: horizontalDistanceSq + dy * dy,
          });
        }
      }
    }

    desiredChunks.sort((a, b) => a.distanceSq - b.distanceSq);
    return desiredChunks;
  }

  syncPlayerChunkInterest(playerId, worldTick) {
    if (!this.players.has(playerId)) {
      return;
    }

    const centerChunkOrigin = this.getPlayerChunkInterestCenterOrigin(playerId);
    const state = this.getOrCreateChunkInterestState(playerId);

    if (!centerChunkOrigin) {
      state.needsRefresh = true;
      return;
    }

    const centerChunkKey = packCoordinate(centerChunkOrigin);
    if (!state.needsRefresh && state.centerChunkKey === centerChunkKey) {
      return;
    }

    const loadedChunkKeys = this.getOrCreateLoadedChunkKeys(playerId);
    const desiredChunks = this.collectDesiredChunksForCenter(centerChunkOrigin);
    const desiredChunkKeys = new Set(desiredChunks.map(chunkInfo => chunkInfo.key));
    const resolvedWorldTick = this.resolveWorldTick(worldTick);

    for (const loadedChunkKey of Array.from(loadedChunkKeys)) {
      if (desiredChunkKeys.has(loadedChunkKey)) {
        continue;
      }

      const originCoordinate = loadedChunkKey.split(',').map(Number);
      if (originCoordinate.length === 3 && originCoordinate.every(value => Number.isFinite(value))) {
        this.queuePacket(playerId, [
          CHUNKS_PACKET_ID,
          [{ c: originCoordinate, rm: true }],
          resolvedWorldTick,
        ]);
      }

      loadedChunkKeys.delete(loadedChunkKey);
    }

    let remainingChunkLoads = CHUNK_STREAM_MAX_LOADS_PER_SYNC;
    let hasPendingChunkLoads = false;

    for (const chunkInfo of desiredChunks) {
      if (loadedChunkKeys.has(chunkInfo.key)) {
        continue;
      }

      if (remainingChunkLoads <= 0) {
        hasPendingChunkLoads = true;
        continue;
      }

      this.queuePacket(playerId, [
        CHUNKS_PACKET_ID,
        [ cloneChunkSchema(chunkInfo.chunk) ],
        resolvedWorldTick,
      ]);
      loadedChunkKeys.add(chunkInfo.key);
      remainingChunkLoads--;
    }

    state.centerChunkKey = centerChunkKey;
    state.needsRefresh = hasPendingChunkLoads;
  }

  flushPendingPackets() {
    if (this.pendingPacketsByPlayer.size === 0) {
      return;
    }

    for (const [playerId, packets] of this.pendingPacketsByPlayer.entries()) {
      this.pendingPacketsByPlayer.delete(playerId);

      if (!this.players.has(playerId) || packets.length === 0) {
        continue;
      }

      const serialized = serializePackets(packets);
      sendToGateway({
        type: 'player_packet_batch',
        packetCount: packets.length,
        playerId,
        processId: PROCESS_ID,
        rawBytes: serialized.rawBytes,
        reliable: true,
        wireBytes: serialized.wireBytes,
        worldId: this.id,
      });
    }
  }

  resolveWorldTick(worldTick) {
    return typeof worldTick === 'number'
      ? worldTick
      : this.getTickMetrics().currentTick;
  }

  getTickMetrics() {
    const tickRate = Math.max(1, Number(this.options?.tickRate ?? DEFAULT_TICK_RATE));
    const tickDurationMs = 1000 / tickRate;
    const elapsedMs = Math.max(0, performance.now() - this.bootedAtMonotonicMs);
    const currentTick = Math.floor(elapsedMs / tickDurationMs);

    return {
      currentTick,
      nextTickAtMs: this.bootedAtMonotonicMs + ((currentTick + 1) * tickDurationMs),
    };
  }
}

process.on('message', message => {
  if (!message || typeof message !== 'object') {
    return;
  }

  switch (message.type) {
    case 'world_boot': {
      const runtime = new ShadowHostedWorldRuntime(message.world, message.options);
      worlds.set(runtime.id, runtime);

      sendToGateway({
        type: 'world_ready',
        processId: PROCESS_ID,
        world: message.world,
      });

      log('info', `booted shadow host for world ${runtime.id}`, runtime.id);
      break;
    }
    case 'world_stop': {
      const runtime = worlds.get(message.worldId);
      if (runtime) {
        runtime.flushPendingPackets();
      }

      worlds.delete(message.worldId);
      sendToGateway({
        type: 'world_stopped',
        processId: PROCESS_ID,
        reason: message.reason,
        worldId: message.worldId,
      });

      log('info', `stopped shadow host for world ${message.worldId}`, message.worldId);
      break;
    }
    case 'player_attach': {
      const runtime = worlds.get(message.worldId);
      if (runtime) {
        runtime.attachPlayer(message.player);
      }

      log('debug', `attached player ${message.player.id}`, message.worldId);
      break;
    }
    case 'player_detach': {
      const runtime = worlds.get(message.worldId);
      if (runtime) {
        runtime.detachPlayer(message.playerId);
      }

      log('debug', `detached player ${message.playerId} (${message.reason})`, message.worldId);
      break;
    }
    case 'player_packets': {
      const runtime = worlds.get(message.worldId);
      if (runtime) {
        const packets = Array.isArray(message.packets) ? message.packets : [];
        runtime.handlePlayerPackets(message.playerId, packets);
      }
      break;
    }
    case 'player_request_notification_permission': {
      const runtime = worlds.get(message.worldId);
      runtime?.requestNotificationPermission(message.playerId);
      break;
    }
    case 'audio_state_patch': {
      const runtime = worlds.get(message.worldId);
      runtime?.applyAudioStatePatch(message.audio, message.worldTick);
      break;
    }
    case 'audio_state_remove': {
      const runtime = worlds.get(message.worldId);
      runtime?.removeAudioState(message.audioId);
      break;
    }
    case 'player_camera': {
      const runtime = worlds.get(message.worldId);
      runtime?.queueCamera(message.playerId, message.camera, message.worldTick);
      break;
    }
    case 'player_entities': {
      const runtime = worlds.get(message.worldId);
      runtime?.queueEntities(message.playerId, message.entities, message.worldTick);
      break;
    }
    case 'player_chat_messages': {
      const runtime = worlds.get(message.worldId);
      runtime?.queueChatMessages(message.playerId, message.chatMessages, message.worldTick);
      break;
    }
    case 'player_ui': {
      const runtime = worlds.get(message.worldId);
      runtime?.queueUI(message.playerId, message.ui, message.worldTick);
      break;
    }
    case 'player_ui_datas': {
      const runtime = worlds.get(message.worldId);
      runtime?.queueUIDatas(message.playerId, message.uiDatas, message.worldTick);
      break;
    }
    case 'player_players': {
      const runtime = worlds.get(message.worldId);
      runtime?.queuePlayers(message.playerId, message.players, message.worldTick);
      break;
    }
    case 'player_world': {
      const runtime = worlds.get(message.worldId);
      runtime?.queueWorld(message.playerId, message.world, message.worldTick);
      break;
    }
    case 'world_state_patch': {
      const runtime = worlds.get(message.worldId);
      runtime?.applyWorldStatePatch(message.world, message.worldTick);
      break;
    }
    case 'scene_ui_state_patch': {
      const runtime = worlds.get(message.worldId);
      runtime?.applySceneUIStatePatch(message.sceneUI, message.worldTick);
      break;
    }
    case 'block_type_state_patch': {
      const runtime = worlds.get(message.worldId);
      runtime?.applyBlockTypeStatePatch(message.blockType, message.worldTick);
      break;
    }
    case 'chunk_state_patch': {
      const runtime = worlds.get(message.worldId);
      runtime?.applyChunkStatePatch(message.chunk, message.worldTick);
      break;
    }
    case 'block_state_patch': {
      const runtime = worlds.get(message.worldId);
      runtime?.applyBlockStatePatch(message.block, message.worldTick);
      break;
    }
    case 'entity_state_patch': {
      const runtime = worlds.get(message.worldId);
      runtime?.applyEntityStatePatch(message.entity, message.worldTick);
      break;
    }
    case 'particle_emitter_state_patch': {
      const runtime = worlds.get(message.worldId);
      runtime?.applyParticleEmitterStatePatch(message.particleEmitter, message.worldTick);
      break;
    }
    default:
      log('warn', `ignored unknown message type ${String(message.type)}`);
      break;
  }
});

process.on('SIGTERM', () => {
  for (const runtime of worlds.values()) {
    runtime.flushPendingPackets();
  }

  log('info', 'shadow host shutting down');
  process.exit(0);
});

log('info', 'shadow host process started');
