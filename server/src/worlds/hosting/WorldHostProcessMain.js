import { gzipSync } from 'node:zlib';
import { Packr, FLOAT32_OPTIONS } from 'msgpackr';
import { ChunkSpatialInterestIndex } from '../../shared/helpers/ChunkSpatialInterestIndex.js';

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
const COALESCIBLE_BATCH_PACKET_IDS = new Set([
  ENTITIES_PACKET_ID,
  PARTICLE_EMITTERS_PACKET_ID,
  SCENE_UIS_PACKET_ID,
]);
const DEFAULT_TICK_RATE = 20;
const CHUNK_AXES_RANGE = 15;
const CHUNK_SIZE_BITS = 4;
const CHUNK_SIZE = 1 << CHUNK_SIZE_BITS;
const CHUNK_STREAM_HORIZONTAL_RADIUS = Math.max(0, Math.floor(Number(process.env.HYTOPIA_CHUNK_STREAM_HORIZONTAL_RADIUS ?? 16)));
const CHUNK_STREAM_VERTICAL_RADIUS = Math.max(0, Math.floor(Number(process.env.HYTOPIA_CHUNK_STREAM_VERTICAL_RADIUS ?? 8)));
const CHUNK_STREAM_MAX_LOADS_PER_SYNC = Math.max(1, Math.floor(Number(process.env.HYTOPIA_CHUNK_STREAM_MAX_LOADS_PER_SYNC ?? 12)));
const SCENE_UI_CHUNK_INTEREST_SAFE_VIEW_DISTANCE = Math.min(CHUNK_STREAM_HORIZONTAL_RADIUS, CHUNK_STREAM_VERTICAL_RADIUS) * CHUNK_SIZE;
const worlds = new Map();
const SORTED_CHUNK_INTEREST_OFFSETS = (() => {
  const offsets = [];

  for (let dy = -CHUNK_STREAM_VERTICAL_RADIUS; dy <= CHUNK_STREAM_VERTICAL_RADIUS; dy++) {
    for (let dx = -CHUNK_STREAM_HORIZONTAL_RADIUS; dx <= CHUNK_STREAM_HORIZONTAL_RADIUS; dx++) {
      for (let dz = -CHUNK_STREAM_HORIZONTAL_RADIUS; dz <= CHUNK_STREAM_HORIZONTAL_RADIUS; dz++) {
        const horizontalDistanceSq = dx * dx + dz * dz;
        if (horizontalDistanceSq > CHUNK_STREAM_HORIZONTAL_RADIUS * CHUNK_STREAM_HORIZONTAL_RADIUS) {
          continue;
        }

        offsets.push({
          dx,
          dy,
          dz,
          distanceSq: horizontalDistanceSq + dy * dy,
        });
      }
    }
  }

  offsets.sort((a, b) => a.distanceSq - b.distanceSq);
  return offsets.map(({ dx, dy, dz }) => ({ dx, dy, dz }));
})();

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
const coalesceQueuedBatchPackets = packets => {
  const coalescedPackets = [];
  const coalescedPacketIndexesByKey = new Map();

  for (const packet of packets) {
    const packetId = packet?.[0];
    const payload = packet?.[1];
    const worldTick = packet?.[2];

    if (!COALESCIBLE_BATCH_PACKET_IDS.has(packetId) || !Array.isArray(payload)) {
      coalescedPackets.push(packet);
      continue;
    }

    const packetKey = `${packetId}:${typeof worldTick === 'number' ? worldTick : 'na'}`;
    const existingPacketIndex = coalescedPacketIndexesByKey.get(packetKey);
    if (existingPacketIndex === undefined) {
      coalescedPacketIndexesByKey.set(packetKey, coalescedPackets.length);
      coalescedPackets.push([ packetId, coalesceSpatialBatchPayload(packetId, payload), worldTick ]);
      continue;
    }

    coalescedPackets[existingPacketIndex][1] = coalesceSpatialBatchPayload(
      packetId,
      [
        ...coalescedPackets[existingPacketIndex][1],
        ...payload,
      ],
    );
  }

  return coalescedPackets;
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
const unpackCoordinate = coordinateKey => {
  if (typeof coordinateKey !== 'string') {
    return undefined;
  }

  const coordinate = coordinateKey.split(',').map(Number);
  if (coordinate.length !== 3 || coordinate.some(value => !Number.isFinite(value))) {
    return undefined;
  }

  return coordinate;
};
const cloneChunkBlocks = blocks => {
  if (ArrayBuffer.isView(blocks) && !(blocks instanceof DataView)) {
    return new Uint8Array(blocks);
  }

  return Array.isArray(blocks) ? [ ...blocks ] : blocks;
};
const cloneChunkSchema = chunk => ({
  ...chunk,
  b: cloneChunkBlocks(chunk?.b),
  r: Array.isArray(chunk?.r) ? [ ...chunk.r ] : chunk?.r,
});
const cloneCameraSchema = camera => {
  const cloned = { ...camera };

  for (const key of ['h', 'o', 'p', 'pl', 'pt', 's']) {
    if (Object.prototype.hasOwnProperty.call(camera ?? {}, key)) {
      cloned[key] = Array.isArray(camera[key]) ? [ ...camera[key] ] : camera[key];
    }
  }

  return cloned;
};
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
const cloneParticleEmitterSchema = particleEmitter => ({
  ...particleEmitter,
  ce: Array.isArray(particleEmitter?.ce) ? [ ...particleEmitter.ce ] : particleEmitter?.ce,
  cev: Array.isArray(particleEmitter?.cev) ? [ ...particleEmitter.cev ] : particleEmitter?.cev,
  cs: Array.isArray(particleEmitter?.cs) ? [ ...particleEmitter.cs ] : particleEmitter?.cs,
  csv: Array.isArray(particleEmitter?.csv) ? [ ...particleEmitter.csv ] : particleEmitter?.csv,
  g: Array.isArray(particleEmitter?.g) ? [ ...particleEmitter.g ] : particleEmitter?.g,
  o: Array.isArray(particleEmitter?.o) ? [ ...particleEmitter.o ] : particleEmitter?.o,
  ofr: Array.isArray(particleEmitter?.ofr) ? [ ...particleEmitter.ofr ] : particleEmitter?.ofr,
  p: Array.isArray(particleEmitter?.p) ? [ ...particleEmitter.p ] : particleEmitter?.p,
  pv: Array.isArray(particleEmitter?.pv) ? [ ...particleEmitter.pv ] : particleEmitter?.pv,
  v: Array.isArray(particleEmitter?.v) ? [ ...particleEmitter.v ] : particleEmitter?.v,
  vv: Array.isArray(particleEmitter?.vv) ? [ ...particleEmitter.vv ] : particleEmitter?.vv,
});
const cloneSceneUISchema = sceneUI => ({
  ...sceneUI,
  o: Array.isArray(sceneUI?.o) ? [ ...sceneUI.o ] : sceneUI?.o,
  p: Array.isArray(sceneUI?.p) ? [ ...sceneUI.p ] : sceneUI?.p,
});
const cloneSpatialBatchItem = (packetId, item) => {
  switch (packetId) {
    case ENTITIES_PACKET_ID:
      return cloneEntitySchema(item);
    case PARTICLE_EMITTERS_PACKET_ID:
      return cloneParticleEmitterSchema(item);
    case SCENE_UIS_PACKET_ID:
      return cloneSceneUISchema(item);
    default:
      return { ...item };
  }
};
const mergeSpatialBatchItem = (packetId, existingItem, nextItem) => {
  const itemId = Number(nextItem?.i ?? existingItem?.i);

  if (existingItem?.rm || nextItem?.rm) {
    return Number.isFinite(itemId) ? { i: itemId, rm: true } : { rm: true };
  }

  switch (packetId) {
    case ENTITIES_PACKET_ID:
      return mergeEntitySchema(existingItem, nextItem);
    case PARTICLE_EMITTERS_PACKET_ID:
      return cloneParticleEmitterSchema({
        ...existingItem,
        ...nextItem,
      });
    case SCENE_UIS_PACKET_ID:
      return cloneSceneUISchema({
        ...existingItem,
        ...nextItem,
      });
    default:
      return {
        ...existingItem,
        ...nextItem,
      };
  }
};
const coalesceSpatialBatchPayload = (packetId, payload) => {
  const coalescedPayload = [];
  const coalescedIndexesById = new Map();

  for (const item of payload) {
    const itemId = Number(item?.i);

    if (!Number.isFinite(itemId)) {
      coalescedPayload.push(cloneSpatialBatchItem(packetId, item));
      continue;
    }

    const existingIndex = coalescedIndexesById.get(itemId);
    if (existingIndex === undefined) {
      coalescedIndexesById.set(itemId, coalescedPayload.length);
      coalescedPayload.push(cloneSpatialBatchItem(packetId, item));
      continue;
    }

    coalescedPayload[existingIndex] = mergeSpatialBatchItem(
      packetId,
      coalescedPayload[existingIndex],
      item,
    );
  }

  return coalescedPayload;
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
    this.desiredChunksByCenterChunkKey = new Map();
    this.descriptor = worldDescriptor;
    this.options = options;
    this.bootedAtMonotonicMs = performance.now();
    this.currentAudioStateById = new Map();
    this.currentBlockTypeStateById = new Map();
    this.currentCameraStateByPlayerId = new Map();
    this.currentChunkStateByKey = new Map();
    this.currentEntityStateById = new Map();
    this.lastRemovedEntityWorldTickById = new Map();
    this.currentParticleEmitterStateById = new Map();
    this.lastRemovedParticleEmitterWorldTickById = new Map();
    this.currentWorldState = toWorldSchema(worldDescriptor, options);
    this.currentSceneUIStateById = new Map();
    this.lastRemovedSceneUIWorldTickById = new Map();
    this.entitySpatialInterestIndex = new ChunkSpatialInterestIndex({
      chunkSize: CHUNK_SIZE,
      horizontalRadius: CHUNK_STREAM_HORIZONTAL_RADIUS,
      verticalRadius: CHUNK_STREAM_VERTICAL_RADIUS,
    });
    this.particleEmitterSpatialInterestIndex = new ChunkSpatialInterestIndex({
      chunkSize: CHUNK_SIZE,
      horizontalRadius: CHUNK_STREAM_HORIZONTAL_RADIUS,
      verticalRadius: CHUNK_STREAM_VERTICAL_RADIUS,
    });
    this.sceneUISpatialInterestIndex = new ChunkSpatialInterestIndex({
      chunkSize: CHUNK_SIZE,
      horizontalRadius: CHUNK_STREAM_HORIZONTAL_RADIUS,
      verticalRadius: CHUNK_STREAM_VERTICAL_RADIUS,
    });
    this.longRangeStaticEnvironmentEntityIds = new Set();
    this.longRangeSceneUIIds = new Set();
    this.loadedEntityIdsByPlayer = new Map();
    this.loadedChunkKeysByPlayer = new Map();
    this.loadedLongRangeSceneUIIdsByPlayer = new Map();
    this.loadedParticleEmitterIdsByPlayer = new Map();
    this.loadedSceneUIIdsByPlayer = new Map();
    this.packetsReceived = 0;
    this.players = new Map();
    this.playersByChunkInterestCenterKey = new Map();
    this.playersByLoadedChunkKey = new Map();
    this.pendingPacketsByPlayer = new Map();
    this.spatialInterestCenterChunkKeyByPlayer = new Map();
    this.flushScheduled = false;
    this.spatialInterestIndexInitialized = false;
  }

  get id() {
    return Number(this.descriptor?.id ?? this.options?.id);
  }

  attachPlayer(playerDescriptor) {
    const existingPlayers = Array.from(this.players.values());
    this.players.set(playerDescriptor.id, playerDescriptor);
    this.chunkInterestStateByPlayer.set(playerDescriptor.id, { needsRefresh: true });
    this.loadedEntityIdsByPlayer.set(playerDescriptor.id, new Set());
    this.loadedChunkKeysByPlayer.set(playerDescriptor.id, new Set());
    this.loadedLongRangeSceneUIIdsByPlayer.set(playerDescriptor.id, new Set());
    this.loadedParticleEmitterIdsByPlayer.set(playerDescriptor.id, new Set());
    this.loadedSceneUIIdsByPlayer.set(playerDescriptor.id, new Set());

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
    this.queuePacket(playerDescriptor.id, [
      PLAYERS_PACKET_ID,
      Array.from(this.players.values(), toPlayerSchema),
      this.getTickMetrics().currentTick,
    ]);

    const newPlayerSync = toPlayerSchema(playerDescriptor);
    for (const existingPlayer of existingPlayers) {
      this.queuePacket(existingPlayer.id, [
        PLAYERS_PACKET_ID,
        [ newPlayerSync ],
        this.getTickMetrics().currentTick,
      ]);
    }

    this.syncPlayerChunkInterest(playerDescriptor.id, this.getTickMetrics().currentTick);
    this.syncPlayerSpatialInterest(playerDescriptor.id, this.getTickMetrics().currentTick);
  }

  detachPlayer(playerId) {
    const existingPlayer = this.players.get(playerId);
    const chunkInterestState = this.chunkInterestStateByPlayer.get(playerId);
    if (chunkInterestState) {
      this.setPlayerChunkInterestCenterKey(playerId, undefined, chunkInterestState);
    }
    this.chunkInterestStateByPlayer.delete(playerId);
    this.currentCameraStateByPlayerId.delete(playerId);
    this.loadedEntityIdsByPlayer.delete(playerId);
    this.clearLoadedChunksForPlayer(playerId);
    this.loadedLongRangeSceneUIIdsByPlayer.delete(playerId);
    this.loadedParticleEmitterIdsByPlayer.delete(playerId);
    this.loadedSceneUIIdsByPlayer.delete(playerId);
    this.spatialInterestCenterChunkKeyByPlayer.delete(playerId);
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
    const cameraPatch = cloneCameraSchema(camera);
    const nextCamera = {
      ...existingCamera,
      ...cameraPatch,
    };

    if (Array.isArray(cameraPatch.p) && cameraPatch.p.length === 3) {
      delete nextCamera.e;
    }
    if (Number.isFinite(cameraPatch.e)) {
      delete nextCamera.p;
    }
    if (Array.isArray(cameraPatch.pt) && cameraPatch.pt.length === 3) {
      delete nextCamera.et;
      delete nextCamera.pl;
    }
    if (Number.isFinite(cameraPatch.et)) {
      delete nextCamera.pt;
      delete nextCamera.pl;
    }
    if (Array.isArray(cameraPatch.pl)) {
      delete nextCamera.pt;
      delete nextCamera.et;
    }

    this.currentCameraStateByPlayerId.set(playerId, nextCamera);

    this.queuePacket(playerId, [
      CAMERA_PACKET_ID,
      camera,
      this.resolveWorldTick(worldTick),
    ]);

    this.syncPlayerChunkInterest(playerId, worldTick);
    this.syncPlayerSpatialInterest(playerId, worldTick);
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

    const resolvedWorldTick = this.resolveWorldTick(worldTick);
    const lastRemovedWorldTick = this.lastRemovedSceneUIWorldTickById.get(sceneUIId);
    if (!sceneUI.rm && lastRemovedWorldTick !== undefined && resolvedWorldTick <= lastRemovedWorldTick) {
      return;
    }

    if (sceneUI.rm) {
      this.lastRemovedSceneUIWorldTickById.set(sceneUIId, resolvedWorldTick);
      this.currentSceneUIStateById.delete(sceneUIId);
    } else {
      if (lastRemovedWorldTick !== undefined) {
        this.lastRemovedSceneUIWorldTickById.delete(sceneUIId);
      }
      const existingSceneUI = this.currentSceneUIStateById.get(sceneUIId);
      this.currentSceneUIStateById.set(sceneUIId, cloneSceneUISchema({
        ...existingSceneUI,
        ...sceneUI,
      }));
    }

    this.updateSceneUISpatialInterestById(sceneUIId);

    for (const playerId of this.players.keys()) {
      const loadedSceneUIIds = this.getOrCreateLoadedSceneUIIds(playerId);
      const shouldSync = !sceneUI.rm && this.shouldSyncSceneUIToPlayer(this.currentSceneUIStateById.get(sceneUIId), playerId);

      if (sceneUI.rm) {
        if (!loadedSceneUIIds.has(sceneUIId)) {
          continue;
        }

        loadedSceneUIIds.delete(sceneUIId);
        this.queuePacket(playerId, [
          SCENE_UIS_PACKET_ID,
          [ sceneUI ],
          resolvedWorldTick,
        ]);
        continue;
      }

      if (loadedSceneUIIds.has(sceneUIId)) {
        if (!shouldSync) {
          loadedSceneUIIds.delete(sceneUIId);
          this.queuePacket(playerId, [
            SCENE_UIS_PACKET_ID,
            [ { i: sceneUIId, rm: true } ],
            resolvedWorldTick,
          ]);
          continue;
        }

        this.queuePacket(playerId, [
          SCENE_UIS_PACKET_ID,
          [ sceneUI ],
          resolvedWorldTick,
        ]);
        continue;
      }

      if (!shouldSync) {
        continue;
      }

      loadedSceneUIIds.add(sceneUIId);
      this.queuePacket(playerId, [
        SCENE_UIS_PACKET_ID,
        [ cloneSceneUISchema(this.currentSceneUIStateById.get(sceneUIId)) ],
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

    const hadChunk = this.currentChunkStateByKey.has(chunkKey);
    if (chunk.rm) {
      this.currentChunkStateByKey.delete(chunkKey);
      this.desiredChunksByCenterChunkKey.clear();
    } else {
      this.currentChunkStateByKey.set(chunkKey, cloneChunkSchema(chunk));
      if (!hadChunk) {
        this.desiredChunksByCenterChunkKey.clear();
      }
    }

    const resolvedWorldTick = this.resolveWorldTick(worldTick);

    if (chunk.rm) {
      for (const playerId of this.getPlayersWithLoadedChunk(chunkKey)) {
        this.queuePacket(playerId, [
          CHUNKS_PACKET_ID,
          [ chunk ],
          resolvedWorldTick,
        ]);
        this.markChunkUnloadedForPlayer(playerId, chunkKey);
      }

      return;
    }

    const queuedPlayerIds = new Set();
    for (const playerId of this.getPlayersWithLoadedChunk(chunkKey)) {
      this.queuePacket(playerId, [
        CHUNKS_PACKET_ID,
        [ chunk ],
        resolvedWorldTick,
      ]);
      queuedPlayerIds.add(playerId);
    }

    if (!hadChunk) {
      for (const playerId of this.getPlayersInterestedInChunk(chunkKey)) {
        if (queuedPlayerIds.has(playerId)) {
          continue;
        }

        this.queuePacket(playerId, [
          CHUNKS_PACKET_ID,
          [ chunk ],
          resolvedWorldTick,
        ]);
        this.markChunkLoadedForPlayer(playerId, chunkKey);
      }
    }
  }

  applyBlockStatePatch(block, worldTick) {
    const chunkKey = packOriginForGlobalCoordinate(block?.c);
    const currentChunk = chunkKey ? this.currentChunkStateByKey.get(chunkKey) : undefined;
    if (currentChunk?.b && (Array.isArray(currentChunk.b) || (ArrayBuffer.isView(currentChunk.b) && !(currentChunk.b instanceof DataView)))) {
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

    const resolvedWorldTick = this.resolveWorldTick(worldTick);
    const lastRemovedWorldTick = this.lastRemovedEntityWorldTickById.get(entityId);
    if (!entity.rm && lastRemovedWorldTick !== undefined && resolvedWorldTick <= lastRemovedWorldTick) {
      return;
    }

    if (entity.rm) {
      this.lastRemovedEntityWorldTickById.set(entityId, resolvedWorldTick);
      this.currentEntityStateById.delete(entityId);
    } else {
      if (lastRemovedWorldTick !== undefined) {
        this.lastRemovedEntityWorldTickById.delete(entityId);
      }
      const existingEntity = this.currentEntityStateById.get(entityId);
      this.currentEntityStateById.set(entityId, mergeEntitySchema(existingEntity, entity));
    }

    const spatialInterestRefresh = entity.rm
      ? this.removeEntitySpatialInterest(entityId)
      : this.updateEntitySpatialInterestById(entityId);

    for (const playerId of this.players.keys()) {
      const loadedEntityIds = this.getOrCreateLoadedEntityIds(playerId);
      const shouldSync = !entity.rm && this.shouldSyncEntityToPlayer(this.currentEntityStateById.get(entityId), playerId);

      if (entity.rm) {
        if (!loadedEntityIds.has(entityId)) {
          continue;
        }

        loadedEntityIds.delete(entityId);
        this.queuePacket(playerId, [
          ENTITIES_PACKET_ID,
          [ cloneEntitySchema(entity) ],
          resolvedWorldTick,
        ]);
        continue;
      }

      if (loadedEntityIds.has(entityId)) {
        if (!shouldSync) {
          loadedEntityIds.delete(entityId);
          this.queuePacket(playerId, [
            ENTITIES_PACKET_ID,
            [ { i: entityId, rm: true } ],
            resolvedWorldTick,
          ]);
          continue;
        }

        this.queuePacket(playerId, [
          ENTITIES_PACKET_ID,
          [ cloneEntitySchema(entity) ],
          resolvedWorldTick,
        ]);
        continue;
      }

      if (!shouldSync) {
        continue;
      }

      loadedEntityIds.add(entityId);
      this.queuePacket(playerId, [
        ENTITIES_PACKET_ID,
        [ cloneEntitySchema(this.currentEntityStateById.get(entityId)) ],
        resolvedWorldTick,
      ]);
    }

    if (!entity?.p && !entity?.rm && !Object.prototype.hasOwnProperty.call(entity ?? {}, 'pe')) {
      return;
    }

    const affectedEntityIds = spatialInterestRefresh.affectedEntityIds;
    affectedEntityIds.add(entityId);

    for (const [ playerId, camera ] of this.currentCameraStateByPlayerId.entries()) {
      if (!affectedEntityIds.has(camera?.e) && !affectedEntityIds.has(camera?.et)) {
        continue;
      }

      this.syncPlayerChunkInterest(playerId, resolvedWorldTick);
      this.syncPlayerSpatialInterest(playerId, resolvedWorldTick);
    }

    if (spatialInterestRefresh.particleEmitterChanged) {
      for (const playerId of this.players.keys()) {
        this.syncPlayerParticleEmitterInterest(playerId, resolvedWorldTick);
      }
    }

    if (spatialInterestRefresh.sceneUIChanged) {
      for (const playerId of this.players.keys()) {
        this.syncPlayerSceneUIInterest(playerId, resolvedWorldTick);
      }
    }
  }

  applyParticleEmitterStatePatch(particleEmitter, worldTick) {
    const particleEmitterId = Number(particleEmitter?.i);
    if (!Number.isFinite(particleEmitterId)) {
      return;
    }

    const resolvedWorldTick = this.resolveWorldTick(worldTick);
    const lastRemovedWorldTick = this.lastRemovedParticleEmitterWorldTickById.get(particleEmitterId);
    if (!particleEmitter.rm && lastRemovedWorldTick !== undefined && resolvedWorldTick <= lastRemovedWorldTick) {
      return;
    }

    if (particleEmitter.rm) {
      this.lastRemovedParticleEmitterWorldTickById.set(particleEmitterId, resolvedWorldTick);
      this.currentParticleEmitterStateById.delete(particleEmitterId);
    } else {
      if (lastRemovedWorldTick !== undefined) {
        this.lastRemovedParticleEmitterWorldTickById.delete(particleEmitterId);
      }
      const existingParticleEmitter = this.currentParticleEmitterStateById.get(particleEmitterId);
      this.currentParticleEmitterStateById.set(particleEmitterId, cloneParticleEmitterSchema({
        ...existingParticleEmitter,
        ...particleEmitter,
      }));
    }

    if (particleEmitter.rm) {
      this.removeParticleEmitterSpatialInterest(particleEmitterId);
    } else {
      this.updateParticleEmitterSpatialInterestById(particleEmitterId);
    }

    for (const playerId of this.players.keys()) {
      const loadedParticleEmitterIds = this.getOrCreateLoadedParticleEmitterIds(playerId);
      const shouldSync = !particleEmitter.rm && this.shouldSyncParticleEmitterToPlayer(
        this.currentParticleEmitterStateById.get(particleEmitterId),
        playerId,
      );

      if (particleEmitter.rm) {
        if (!loadedParticleEmitterIds.has(particleEmitterId)) {
          continue;
        }

        loadedParticleEmitterIds.delete(particleEmitterId);
        this.queuePacket(playerId, [
          PARTICLE_EMITTERS_PACKET_ID,
          [ particleEmitter ],
          resolvedWorldTick,
        ]);
        continue;
      }

      if (loadedParticleEmitterIds.has(particleEmitterId)) {
        if (!shouldSync) {
          loadedParticleEmitterIds.delete(particleEmitterId);
          this.queuePacket(playerId, [
            PARTICLE_EMITTERS_PACKET_ID,
            [ { i: particleEmitterId, rm: true } ],
            resolvedWorldTick,
          ]);
          continue;
        }

        this.queuePacket(playerId, [
          PARTICLE_EMITTERS_PACKET_ID,
          [ particleEmitter ],
          resolvedWorldTick,
        ]);
        continue;
      }

      if (!shouldSync) {
        continue;
      }

      loadedParticleEmitterIds.add(particleEmitterId);
      this.queuePacket(playerId, [
        PARTICLE_EMITTERS_PACKET_ID,
        [ cloneParticleEmitterSchema(this.currentParticleEmitterStateById.get(particleEmitterId)) ],
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

  getOrCreateLoadedEntityIds(playerId) {
    let loadedEntityIds = this.loadedEntityIdsByPlayer.get(playerId);
    if (!loadedEntityIds) {
      loadedEntityIds = new Set();
      this.loadedEntityIdsByPlayer.set(playerId, loadedEntityIds);
    }

    return loadedEntityIds;
  }

  getOrCreateLoadedParticleEmitterIds(playerId) {
    let loadedParticleEmitterIds = this.loadedParticleEmitterIdsByPlayer.get(playerId);
    if (!loadedParticleEmitterIds) {
      loadedParticleEmitterIds = new Set();
      this.loadedParticleEmitterIdsByPlayer.set(playerId, loadedParticleEmitterIds);
    }

    return loadedParticleEmitterIds;
  }

  getOrCreateLoadedSceneUIIds(playerId) {
    let loadedSceneUIIds = this.loadedSceneUIIdsByPlayer.get(playerId);
    if (!loadedSceneUIIds) {
      loadedSceneUIIds = new Set();
      this.loadedSceneUIIdsByPlayer.set(playerId, loadedSceneUIIds);
    }

    return loadedSceneUIIds;
  }

  getOrCreateLoadedLongRangeSceneUIIds(playerId) {
    let loadedSceneUIIds = this.loadedLongRangeSceneUIIdsByPlayer.get(playerId);
    if (!loadedSceneUIIds) {
      loadedSceneUIIds = new Set();
      this.loadedLongRangeSceneUIIdsByPlayer.set(playerId, loadedSceneUIIds);
    }

    return loadedSceneUIIds;
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

    if (Number.isFinite(camera.et)) {
      const entityPosition = this.getEntitySpatialInterestAnchor(this.currentEntityStateById.get(camera.et));
      if (Array.isArray(entityPosition) && entityPosition.length === 3) {
        return entityPosition;
      }
    }

    if (Array.isArray(camera.pt) && camera.pt.length === 3) {
      return camera.pt;
    }

    if (Number.isFinite(camera.e)) {
      const entityPosition = this.getEntitySpatialInterestAnchor(this.currentEntityStateById.get(camera.e));
      if (Array.isArray(entityPosition) && entityPosition.length === 3) {
        return entityPosition;
      }
    }

    if (Array.isArray(camera.p) && camera.p.length === 3) {
      return camera.p;
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

  isPositionInChunkInterestRange(position, centerChunkOrigin) {
    if (!Array.isArray(position) || position.length !== 3) {
      return false;
    }

    const chunkKey = packOriginForGlobalCoordinate(position);
    return !!chunkKey && this.isChunkKeyInRange(chunkKey, centerChunkOrigin);
  }

  ensureSpatialInterestIndex() {
    if (this.spatialInterestIndexInitialized) {
      return;
    }

    this.rebuildSpatialInterestIndex();
    this.spatialInterestIndexInitialized = true;
  }

  rebuildSpatialInterestIndex() {
    this.entitySpatialInterestIndex.clear();
    this.particleEmitterSpatialInterestIndex.clear();
    this.sceneUISpatialInterestIndex.clear();
    this.longRangeStaticEnvironmentEntityIds.clear();
    this.longRangeSceneUIIds.clear();

    for (const [entityId, entity] of this.currentEntityStateById.entries()) {
      this.entitySpatialInterestIndex.update(
        entityId,
        this.getEntitySpatialInterestAnchor(entity),
        this.getEntitySpatialInterestAttachedEntityId(entity),
      );
      this.refreshLongRangeStaticEnvironmentEntity(entityId);
    }

    for (const [particleEmitterId, particleEmitter] of this.currentParticleEmitterStateById.entries()) {
      this.particleEmitterSpatialInterestIndex.update(
        particleEmitterId,
        this.getAttachedStateSpatialInterestAnchor(particleEmitter),
        this.getAttachedStateSpatialInterestAttachedEntityId(particleEmitter),
      );
    }

    for (const [sceneUIId, sceneUI] of this.currentSceneUIStateById.entries()) {
      this.sceneUISpatialInterestIndex.update(
        sceneUIId,
        this.getAttachedStateSpatialInterestAnchor(sceneUI),
        this.getAttachedStateSpatialInterestAttachedEntityId(sceneUI),
      );
      if (this.isLongRangeSceneUI(sceneUI)) {
        this.longRangeSceneUIIds.add(sceneUIId);
      }
    }
  }

  createSpatialInterestRefresh() {
    return {
      affectedEntityIds: new Set(),
      entityChanged: false,
      particleEmitterChanged: false,
      sceneUIChanged: false,
    };
  }

  updateEntitySpatialInterestById(
    entityId,
    result = this.createSpatialInterestRefresh(),
    visitedEntityIds = new Set(),
  ) {
    this.ensureSpatialInterestIndex();
    const entity = this.currentEntityStateById.get(entityId);
    if (this.entitySpatialInterestIndex.update(
      entityId,
      this.getEntitySpatialInterestAnchor(entity),
      this.getEntitySpatialInterestAttachedEntityId(entity),
    )) {
      result.entityChanged = true;
      result.affectedEntityIds.add(entityId);
      this.refreshAttachedSpatialInterestForEntity(entityId, result, visitedEntityIds);
    }

    this.refreshLongRangeStaticEnvironmentEntity(entityId);
    return result;
  }

  removeEntitySpatialInterest(
    entityId,
    result = this.createSpatialInterestRefresh(),
    visitedEntityIds = new Set(),
  ) {
    this.ensureSpatialInterestIndex();
    if (this.entitySpatialInterestIndex.remove(entityId)) {
      result.entityChanged = true;
      result.affectedEntityIds.add(entityId);
    }

    this.longRangeStaticEnvironmentEntityIds.delete(entityId);
    this.refreshAttachedSpatialInterestForEntity(entityId, result, visitedEntityIds);
    return result;
  }

  refreshLongRangeStaticEnvironmentEntity(entityId) {
    const entity = this.currentEntityStateById.get(entityId);
    if (this.isLongRangeStaticEnvironmentEntity(entity)) {
      this.longRangeStaticEnvironmentEntityIds.add(entityId);
    } else {
      this.longRangeStaticEnvironmentEntityIds.delete(entityId);
    }
  }

  updateParticleEmitterSpatialInterestById(particleEmitterId) {
    this.ensureSpatialInterestIndex();

    const particleEmitter = this.currentParticleEmitterStateById.get(particleEmitterId);
    return this.particleEmitterSpatialInterestIndex.update(
      particleEmitterId,
      this.getAttachedStateSpatialInterestAnchor(particleEmitter),
      this.getAttachedStateSpatialInterestAttachedEntityId(particleEmitter),
    );
  }

  removeParticleEmitterSpatialInterest(particleEmitterId) {
    this.ensureSpatialInterestIndex();
    return this.particleEmitterSpatialInterestIndex.remove(particleEmitterId);
  }

  updateSceneUISpatialInterestById(sceneUIId) {
    this.ensureSpatialInterestIndex();

    const sceneUI = this.currentSceneUIStateById.get(sceneUIId);
    const changed = this.sceneUISpatialInterestIndex.update(
      sceneUIId,
      this.getAttachedStateSpatialInterestAnchor(sceneUI),
      this.getAttachedStateSpatialInterestAttachedEntityId(sceneUI),
    );

    if (this.isLongRangeSceneUI(sceneUI)) {
      this.longRangeSceneUIIds.add(sceneUIId);
    } else {
      this.longRangeSceneUIIds.delete(sceneUIId);
    }

    return changed;
  }

  removeSceneUISpatialInterest(sceneUIId) {
    this.ensureSpatialInterestIndex();
    const changed = this.sceneUISpatialInterestIndex.remove(sceneUIId);
    this.longRangeSceneUIIds.delete(sceneUIId);
    return changed;
  }

  refreshAttachedSpatialInterestForEntity(
    entityId,
    result = this.createSpatialInterestRefresh(),
    visitedEntityIds = new Set(),
  ) {
    if (visitedEntityIds.has(entityId)) {
      return result;
    }

    visitedEntityIds.add(entityId);

    const childEntityIds = this.entitySpatialInterestIndex.getAttachedIds(entityId);
    if (childEntityIds) {
      for (const childEntityId of Array.from(childEntityIds)) {
        if (childEntityId === entityId) {
          continue;
        }

        if (this.currentEntityStateById.has(childEntityId)) {
          this.updateEntitySpatialInterestById(childEntityId, result, visitedEntityIds);
        } else {
          this.removeEntitySpatialInterest(childEntityId, result, visitedEntityIds);
        }
      }
    }

    const particleEmitterIds = this.particleEmitterSpatialInterestIndex.getAttachedIds(entityId);
    if (particleEmitterIds) {
      for (const particleEmitterId of Array.from(particleEmitterIds)) {
        if (this.currentParticleEmitterStateById.has(particleEmitterId)) {
          result.particleEmitterChanged = this.updateParticleEmitterSpatialInterestById(particleEmitterId) || result.particleEmitterChanged;
        } else {
          result.particleEmitterChanged = this.removeParticleEmitterSpatialInterest(particleEmitterId) || result.particleEmitterChanged;
        }
      }
    }

    const sceneUIIds = this.sceneUISpatialInterestIndex.getAttachedIds(entityId);
    if (sceneUIIds) {
      for (const sceneUIId of Array.from(sceneUIIds)) {
        if (this.currentSceneUIStateById.has(sceneUIId)) {
          result.sceneUIChanged = this.updateSceneUISpatialInterestById(sceneUIId) || result.sceneUIChanged;
        } else {
          result.sceneUIChanged = this.removeSceneUISpatialInterest(sceneUIId) || result.sceneUIChanged;
        }
      }
    }

    return result;
  }

  isLongRangeSceneUI(sceneUI) {
    return Number.isFinite(sceneUI?.v) && sceneUI.v > SCENE_UI_CHUNK_INTEREST_SAFE_VIEW_DISTANCE;
  }

  getDesiredChunksForCenter(centerChunkOrigin, centerChunkKey) {
    const cached = this.desiredChunksByCenterChunkKey.get(centerChunkKey);
    if (cached) {
      return cached;
    }

    const chunkInfos = [];
    const chunkKeys = new Set();

    for (let i = 0; i < SORTED_CHUNK_INTEREST_OFFSETS.length; i++) {
      const offset = SORTED_CHUNK_INTEREST_OFFSETS[i];
      const chunkKey = packCoordinate([
        centerChunkOrigin[0] + offset.dx * CHUNK_SIZE,
        centerChunkOrigin[1] + offset.dy * CHUNK_SIZE,
        centerChunkOrigin[2] + offset.dz * CHUNK_SIZE,
      ]);
      const chunk = this.currentChunkStateByKey.get(chunkKey);
      if (!chunk) {
        continue;
      }

      chunkInfos.push({
        chunk,
        key: chunkKey,
      });
      chunkKeys.add(chunkKey);
    }

    const desiredChunks = {
      chunkInfos,
      chunkKeys,
    };
    this.desiredChunksByCenterChunkKey.set(centerChunkKey, desiredChunks);
    return desiredChunks;
  }

  canIncrementallyRefreshChunkInterest(previousCenterChunkOrigin, nextCenterChunkOrigin) {
    const deltaX = Math.abs((nextCenterChunkOrigin[0] - previousCenterChunkOrigin[0]) / CHUNK_SIZE);
    const deltaY = Math.abs((nextCenterChunkOrigin[1] - previousCenterChunkOrigin[1]) / CHUNK_SIZE);
    const deltaZ = Math.abs((nextCenterChunkOrigin[2] - previousCenterChunkOrigin[2]) / CHUNK_SIZE);

    return deltaX <= 1 && deltaY <= 1 && deltaZ <= 1;
  }

  collectChunkInterestTransitions(previousCenterChunkOrigin, nextCenterChunkOrigin) {
    const transitionKeys = this.collectChunkInterestTransitionKeys(previousCenterChunkOrigin, nextCenterChunkOrigin);
    const enteringChunkInfos = [];

    for (let i = 0; i < transitionKeys.enteringChunkKeys.length; i++) {
      const chunkKey = transitionKeys.enteringChunkKeys[i];
      const chunk = this.currentChunkStateByKey.get(chunkKey);
      if (!chunk) {
        continue;
      }

      enteringChunkInfos.push({
        chunk,
        key: chunkKey,
      });
    }

    return {
      enteringChunkInfos,
      leavingChunkKeys: transitionKeys.leavingChunkKeys,
    };
  }

  collectChunkInterestTransitionKeys(previousCenterChunkOrigin, nextCenterChunkOrigin) {
    const deltaX = (nextCenterChunkOrigin[0] - previousCenterChunkOrigin[0]) / CHUNK_SIZE;
    const deltaY = (nextCenterChunkOrigin[1] - previousCenterChunkOrigin[1]) / CHUNK_SIZE;
    const deltaZ = (nextCenterChunkOrigin[2] - previousCenterChunkOrigin[2]) / CHUNK_SIZE;
    const enteringChunkKeys = [];
    const leavingChunkKeys = [];

    for (let i = 0; i < SORTED_CHUNK_INTEREST_OFFSETS.length; i++) {
      const offset = SORTED_CHUNK_INTEREST_OFFSETS[i];

      if (!this.isChunkInterestOffsetInRange(offset.dx + deltaX, offset.dy + deltaY, offset.dz + deltaZ)) {
        enteringChunkKeys.push(packCoordinate([
          nextCenterChunkOrigin[0] + offset.dx * CHUNK_SIZE,
          nextCenterChunkOrigin[1] + offset.dy * CHUNK_SIZE,
          nextCenterChunkOrigin[2] + offset.dz * CHUNK_SIZE,
        ]));
      }
    }

    for (let i = 0; i < SORTED_CHUNK_INTEREST_OFFSETS.length; i++) {
      const offset = SORTED_CHUNK_INTEREST_OFFSETS[i];

      if (this.isChunkInterestOffsetInRange(offset.dx - deltaX, offset.dy - deltaY, offset.dz - deltaZ)) {
        continue;
      }

      leavingChunkKeys.push(packCoordinate([
        previousCenterChunkOrigin[0] + offset.dx * CHUNK_SIZE,
        previousCenterChunkOrigin[1] + offset.dy * CHUNK_SIZE,
        previousCenterChunkOrigin[2] + offset.dz * CHUNK_SIZE,
      ]));
    }

    return {
      enteringChunkKeys,
      leavingChunkKeys,
    };
  }

  isChunkInterestOffsetInRange(dx, dy, dz) {
    return Math.abs(dy) <= CHUNK_STREAM_VERTICAL_RADIUS &&
      (dx * dx + dz * dz) <= CHUNK_STREAM_HORIZONTAL_RADIUS * CHUNK_STREAM_HORIZONTAL_RADIUS;
  }

  markChunkLoadedForPlayer(playerId, chunkKey, loadedChunkKeys = this.getOrCreateLoadedChunkKeys(playerId)) {
    if (loadedChunkKeys.has(chunkKey)) {
      return;
    }

    loadedChunkKeys.add(chunkKey);

    let players = this.playersByLoadedChunkKey.get(chunkKey);
    if (!players) {
      players = new Set();
      this.playersByLoadedChunkKey.set(chunkKey, players);
    }

    players.add(playerId);
  }

  markChunkUnloadedForPlayer(playerId, chunkKey, loadedChunkKeys = this.getOrCreateLoadedChunkKeys(playerId)) {
    if (!loadedChunkKeys.delete(chunkKey)) {
      return;
    }

    const players = this.playersByLoadedChunkKey.get(chunkKey);
    if (!players) {
      return;
    }

    players.delete(playerId);
    if (players.size === 0) {
      this.playersByLoadedChunkKey.delete(chunkKey);
    }
  }

  clearLoadedChunksForPlayer(playerId) {
    const loadedChunkKeys = this.loadedChunkKeysByPlayer.get(playerId);
    if (loadedChunkKeys) {
      for (const chunkKey of loadedChunkKeys) {
        const players = this.playersByLoadedChunkKey.get(chunkKey);
        if (!players) {
          continue;
        }

        players.delete(playerId);
        if (players.size === 0) {
          this.playersByLoadedChunkKey.delete(chunkKey);
        }
      }
    }

    this.loadedChunkKeysByPlayer.delete(playerId);
  }

  setPlayerChunkInterestCenterKey(playerId, centerChunkKey, state) {
    const previousCenterChunkKey = state.centerChunkKey;
    if (previousCenterChunkKey === centerChunkKey) {
      return;
    }

    if (previousCenterChunkKey) {
      const previousPlayers = this.playersByChunkInterestCenterKey.get(previousCenterChunkKey);
      if (previousPlayers) {
        previousPlayers.delete(playerId);
        if (previousPlayers.size === 0) {
          this.playersByChunkInterestCenterKey.delete(previousCenterChunkKey);
        }
      }
    }

    state.centerChunkKey = centerChunkKey;

    if (!centerChunkKey) {
      return;
    }

    let nextPlayers = this.playersByChunkInterestCenterKey.get(centerChunkKey);
    if (!nextPlayers) {
      nextPlayers = new Set();
      this.playersByChunkInterestCenterKey.set(centerChunkKey, nextPlayers);
    }

    nextPlayers.add(playerId);
  }

  getPlayersWithLoadedChunk(chunkKey) {
    const players = this.playersByLoadedChunkKey.get(chunkKey);
    return players ? Array.from(players) : [];
  }

  getPlayersInterestedInChunk(chunkKey) {
    const chunkOrigin = unpackCoordinate(chunkKey);
    if (!chunkOrigin) {
      return [];
    }

    const players = new Set();

    for (let i = 0; i < SORTED_CHUNK_INTEREST_OFFSETS.length; i++) {
      const offset = SORTED_CHUNK_INTEREST_OFFSETS[i];
      const centerChunkKey = packCoordinate([
        chunkOrigin[0] - offset.dx * CHUNK_SIZE,
        chunkOrigin[1] - offset.dy * CHUNK_SIZE,
        chunkOrigin[2] - offset.dz * CHUNK_SIZE,
      ]);
      const interestedPlayers = this.playersByChunkInterestCenterKey.get(centerChunkKey);
      if (!interestedPlayers) {
        continue;
      }

      for (const playerId of interestedPlayers) {
        players.add(playerId);
      }
    }

    return Array.from(players);
  }

  shouldSyncEntityToPlayer(entity, playerId, centerChunkOrigin = this.getPlayerChunkInterestCenterOrigin(playerId)) {
    if (!centerChunkOrigin) {
      return false;
    }

    if (this.isLongRangeStaticEnvironmentEntity(entity)) {
      return true;
    }

    return this.isPositionInChunkInterestRange(this.getEntitySpatialInterestAnchor(entity), centerChunkOrigin);
  }

  isLongRangeStaticEnvironmentEntity(entity) {
    return entity?.e === true &&
      typeof entity.m === 'string' &&
      entity.m.length > 0 &&
      entity.bt == null &&
      !Number.isFinite(entity.pe) &&
      entity.pn == null &&
      (!Array.isArray(entity.ma) || entity.ma.length === 0) &&
      (!Array.isArray(entity.mo) || entity.mo.length === 0) &&
      entity.mt == null &&
      (entity.o === undefined || entity.o === 1);
  }

  getEntitySpatialInterestAnchor(entity) {
    if (!Number.isFinite(entity?.pe)) {
      return entity?.p;
    }

    let anchorEntity = entity;
    const visitedEntityIds = new Set();

    for (;;) {
      const attachedEntityId = this.getEntitySpatialInterestAttachedEntityId(anchorEntity);
      if (attachedEntityId === undefined) {
        return anchorEntity?.p;
      }

      const anchorEntityId = Number(anchorEntity?.i);
      if (Number.isFinite(anchorEntityId)) {
        if (visitedEntityIds.has(anchorEntityId)) {
          return undefined;
        }

        visitedEntityIds.add(anchorEntityId);
      }

      anchorEntity = this.currentEntityStateById.get(attachedEntityId);
      if (!anchorEntity) {
        return undefined;
      }
    }
  }

  getEntitySpatialInterestAttachedEntityId(entity) {
    return Number.isFinite(entity?.pe) ? entity.pe : undefined;
  }

  getAttachedStateSpatialInterestAnchor(state) {
    const attachedEntityId = this.getAttachedStateSpatialInterestAttachedEntityId(state);
    if (attachedEntityId !== undefined) {
      return this.getEntitySpatialInterestAnchor(this.currentEntityStateById.get(attachedEntityId));
    }

    return state?.p;
  }

  getAttachedStateSpatialInterestAttachedEntityId(state) {
    return Number.isFinite(state?.e) ? state.e : undefined;
  }

  shouldSyncParticleEmitterToPlayer(
    particleEmitter,
    playerId,
    centerChunkOrigin = this.getPlayerChunkInterestCenterOrigin(playerId),
  ) {
    if (!centerChunkOrigin) {
      return false;
    }

    const anchor = this.getAttachedStateSpatialInterestAnchor(particleEmitter);
    return this.isPositionInChunkInterestRange(anchor, centerChunkOrigin);
  }

  shouldSyncSceneUIToPlayer(
    sceneUI,
    playerId,
    center = this.getPlayerChunkInterestCenter(playerId),
    centerChunkOrigin = this.getPlayerChunkInterestCenterOrigin(playerId),
  ) {
    const resolvedCenterChunkOrigin = centerChunkOrigin;
    if (!center) {
      return false;
    }

    const anchor = this.getAttachedStateSpatialInterestAnchor(sceneUI);
    if (!Array.isArray(anchor) || anchor.length !== 3) {
      return false;
    }

    if (Number.isFinite(sceneUI?.v)) {
      const dx = anchor[0] - center[0];
      const dy = anchor[1] - center[1];
      const dz = anchor[2] - center[2];
      return (dx * dx) + (dy * dy) + (dz * dz) <= sceneUI.v * sceneUI.v;
    }

    return !!resolvedCenterChunkOrigin && this.isPositionInChunkInterestRange(anchor, resolvedCenterChunkOrigin);
  }

  syncPlayerSpatialInterest(playerId, worldTick) {
    if (!this.players.has(playerId)) {
      return;
    }

    const center = this.getPlayerChunkInterestCenter(playerId);
    if (!center) {
      this.spatialInterestCenterChunkKeyByPlayer.delete(playerId);
      return;
    }

    const centerChunkOrigin = this.getPlayerChunkInterestCenterOrigin(playerId);
    if (!centerChunkOrigin) {
      this.spatialInterestCenterChunkKeyByPlayer.delete(playerId);
      return;
    }

    this.ensureSpatialInterestIndex();

    const centerChunkKey = packCoordinate(centerChunkOrigin);
    const previousCenterChunkKey = this.spatialInterestCenterChunkKeyByPlayer.get(playerId);
    const previousCenterChunkOrigin = previousCenterChunkKey ? unpackCoordinate(previousCenterChunkKey) : undefined;
    const resolvedWorldTick = this.resolveWorldTick(worldTick);
    const canRefreshIncrementally = previousCenterChunkKey !== undefined &&
      previousCenterChunkKey !== centerChunkKey &&
      previousCenterChunkOrigin !== undefined &&
      this.canIncrementallyRefreshChunkInterest(previousCenterChunkOrigin, centerChunkOrigin);

    if (canRefreshIncrementally) {
      const transitions = this.collectChunkInterestTransitionKeys(previousCenterChunkOrigin, centerChunkOrigin);

      this.syncPlayerEntityInterestIncremental(
        playerId,
        resolvedWorldTick,
        centerChunkOrigin,
        transitions.enteringChunkKeys,
        transitions.leavingChunkKeys,
      );
      this.syncPlayerParticleEmitterInterestIncremental(
        playerId,
        resolvedWorldTick,
        centerChunkOrigin,
        transitions.enteringChunkKeys,
        transitions.leavingChunkKeys,
      );
      this.syncPlayerSceneUIInterestIncremental(
        playerId,
        resolvedWorldTick,
        center,
        centerChunkOrigin,
        transitions.enteringChunkKeys,
        transitions.leavingChunkKeys,
      );
    } else {
      this.syncPlayerEntityInterestFull(playerId, resolvedWorldTick, centerChunkOrigin);
      this.syncPlayerParticleEmitterInterestFull(playerId, resolvedWorldTick, centerChunkOrigin);
      this.syncPlayerSceneUIInterestFull(playerId, resolvedWorldTick, center, centerChunkOrigin);
    }

    this.spatialInterestCenterChunkKeyByPlayer.set(playerId, centerChunkKey);
  }

  syncPlayerEntityInterest(playerId, worldTick) {
    const centerChunkOrigin = this.getPlayerChunkInterestCenterOrigin(playerId);
    if (!centerChunkOrigin) {
      return;
    }

    this.ensureSpatialInterestIndex();
    this.syncPlayerEntityInterestFull(playerId, this.resolveWorldTick(worldTick), centerChunkOrigin);
  }

  syncPlayerEntityInterestFull(playerId, resolvedWorldTick, centerChunkOrigin) {
    const loadedEntityIds = this.getOrCreateLoadedEntityIds(playerId);
    const candidateEntityIds = this.entitySpatialInterestIndex.collectIdsInRange(centerChunkOrigin);
    const desiredEntityIds = new Set();

    for (const entityId of candidateEntityIds) {
      const entity = this.currentEntityStateById.get(entityId);
      if (!entity || !this.shouldSyncEntityToPlayer(entity, playerId, centerChunkOrigin)) {
        continue;
      }

      desiredEntityIds.add(entityId);
      if (loadedEntityIds.has(entityId)) {
        continue;
      }

      loadedEntityIds.add(entityId);
      this.queuePacket(playerId, [
        ENTITIES_PACKET_ID,
        [ cloneEntitySchema(entity) ],
        resolvedWorldTick,
      ]);
    }

    this.syncPlayerLongRangeStaticEnvironmentEntityInterest(playerId, resolvedWorldTick, loadedEntityIds, desiredEntityIds);

    for (const loadedEntityId of Array.from(loadedEntityIds)) {
      if (desiredEntityIds.has(loadedEntityId)) {
        continue;
      }

      loadedEntityIds.delete(loadedEntityId);
      this.queuePacket(playerId, [
        ENTITIES_PACKET_ID,
        [ { i: loadedEntityId, rm: true } ],
        resolvedWorldTick,
      ]);
    }
  }

  syncPlayerEntityInterestIncremental(playerId, resolvedWorldTick, centerChunkOrigin, enteringChunkKeys, leavingChunkKeys) {
    const loadedEntityIds = this.getOrCreateLoadedEntityIds(playerId);
    const enteringEntityIds = this.entitySpatialInterestIndex.collectIdsForChunkKeys(enteringChunkKeys);
    const leavingEntityIds = this.entitySpatialInterestIndex.collectIdsForChunkKeys(leavingChunkKeys);

    for (const entityId of enteringEntityIds) {
      const entity = this.currentEntityStateById.get(entityId);
      if (!entity || !this.shouldSyncEntityToPlayer(entity, playerId, centerChunkOrigin) || loadedEntityIds.has(entityId)) {
        continue;
      }

      loadedEntityIds.add(entityId);
      this.queuePacket(playerId, [
        ENTITIES_PACKET_ID,
        [ cloneEntitySchema(entity) ],
        resolvedWorldTick,
      ]);
    }

    for (const entityId of leavingEntityIds) {
      if (this.longRangeStaticEnvironmentEntityIds.has(entityId)) {
        continue;
      }

      if (!loadedEntityIds.has(entityId)) {
        continue;
      }

      const entity = this.currentEntityStateById.get(entityId);
      if (!entity || this.shouldSyncEntityToPlayer(entity, playerId, centerChunkOrigin)) {
        continue;
      }

      loadedEntityIds.delete(entityId);
      this.queuePacket(playerId, [
        ENTITIES_PACKET_ID,
        [ { i: entityId, rm: true } ],
        resolvedWorldTick,
      ]);
    }

    this.syncPlayerLongRangeStaticEnvironmentEntityInterest(playerId, resolvedWorldTick, loadedEntityIds);
  }

  syncPlayerLongRangeStaticEnvironmentEntityInterest(playerId, resolvedWorldTick, loadedEntityIds, desiredEntityIds) {
    for (const entityId of this.longRangeStaticEnvironmentEntityIds) {
      if (desiredEntityIds?.has(entityId)) {
        continue;
      }

      const entity = this.currentEntityStateById.get(entityId);
      if (!this.isLongRangeStaticEnvironmentEntity(entity)) {
        this.longRangeStaticEnvironmentEntityIds.delete(entityId);
        continue;
      }

      desiredEntityIds?.add(entityId);
      if (loadedEntityIds.has(entityId)) {
        continue;
      }

      loadedEntityIds.add(entityId);
      this.queuePacket(playerId, [
        ENTITIES_PACKET_ID,
        [ cloneEntitySchema(entity) ],
        resolvedWorldTick,
      ]);
    }
  }

  syncPlayerParticleEmitterInterest(playerId, worldTick) {
    const centerChunkOrigin = this.getPlayerChunkInterestCenterOrigin(playerId);
    if (!centerChunkOrigin) {
      return;
    }

    this.ensureSpatialInterestIndex();
    this.syncPlayerParticleEmitterInterestFull(playerId, this.resolveWorldTick(worldTick), centerChunkOrigin);
  }

  syncPlayerParticleEmitterInterestFull(playerId, resolvedWorldTick, centerChunkOrigin) {
    const loadedParticleEmitterIds = this.getOrCreateLoadedParticleEmitterIds(playerId);
    const candidateParticleEmitterIds = this.particleEmitterSpatialInterestIndex.collectIdsInRange(centerChunkOrigin);
    const desiredParticleEmitterIds = new Set();

    for (const particleEmitterId of candidateParticleEmitterIds) {
      const particleEmitter = this.currentParticleEmitterStateById.get(particleEmitterId);
      if (!particleEmitter || !this.shouldSyncParticleEmitterToPlayer(particleEmitter, playerId, centerChunkOrigin)) {
        continue;
      }

      desiredParticleEmitterIds.add(particleEmitterId);
      if (loadedParticleEmitterIds.has(particleEmitterId)) {
        continue;
      }

      loadedParticleEmitterIds.add(particleEmitterId);
      this.queuePacket(playerId, [
        PARTICLE_EMITTERS_PACKET_ID,
        [ cloneParticleEmitterSchema(particleEmitter) ],
        resolvedWorldTick,
      ]);
    }

    for (const loadedParticleEmitterId of Array.from(loadedParticleEmitterIds)) {
      if (desiredParticleEmitterIds.has(loadedParticleEmitterId)) {
        continue;
      }

      loadedParticleEmitterIds.delete(loadedParticleEmitterId);
      this.queuePacket(playerId, [
        PARTICLE_EMITTERS_PACKET_ID,
        [ { i: loadedParticleEmitterId, rm: true } ],
        resolvedWorldTick,
      ]);
    }
  }

  syncPlayerParticleEmitterInterestIncremental(playerId, resolvedWorldTick, centerChunkOrigin, enteringChunkKeys, leavingChunkKeys) {
    const loadedParticleEmitterIds = this.getOrCreateLoadedParticleEmitterIds(playerId);
    const enteringParticleEmitterIds = this.particleEmitterSpatialInterestIndex.collectIdsForChunkKeys(enteringChunkKeys);
    const leavingParticleEmitterIds = this.particleEmitterSpatialInterestIndex.collectIdsForChunkKeys(leavingChunkKeys);

    for (const particleEmitterId of enteringParticleEmitterIds) {
      const particleEmitter = this.currentParticleEmitterStateById.get(particleEmitterId);
      if (!particleEmitter ||
        !this.shouldSyncParticleEmitterToPlayer(particleEmitter, playerId, centerChunkOrigin) ||
        loadedParticleEmitterIds.has(particleEmitterId)) {
        continue;
      }

      loadedParticleEmitterIds.add(particleEmitterId);
      this.queuePacket(playerId, [
        PARTICLE_EMITTERS_PACKET_ID,
        [ cloneParticleEmitterSchema(particleEmitter) ],
        resolvedWorldTick,
      ]);
    }

    for (const particleEmitterId of leavingParticleEmitterIds) {
      if (!loadedParticleEmitterIds.has(particleEmitterId)) {
        continue;
      }

      const particleEmitter = this.currentParticleEmitterStateById.get(particleEmitterId);
      if (!particleEmitter || this.shouldSyncParticleEmitterToPlayer(particleEmitter, playerId, centerChunkOrigin)) {
        continue;
      }

      loadedParticleEmitterIds.delete(particleEmitterId);
      this.queuePacket(playerId, [
        PARTICLE_EMITTERS_PACKET_ID,
        [ { i: particleEmitterId, rm: true } ],
        resolvedWorldTick,
      ]);
    }
  }

  syncPlayerSceneUIInterest(playerId, worldTick) {
    const center = this.getPlayerChunkInterestCenter(playerId);
    if (!center) {
      return;
    }

    const centerChunkOrigin = this.getPlayerChunkInterestCenterOrigin(playerId);
    if (!centerChunkOrigin) {
      return;
    }

    this.ensureSpatialInterestIndex();
    this.syncPlayerSceneUIInterestFull(playerId, this.resolveWorldTick(worldTick), center, centerChunkOrigin);
  }

  syncPlayerSceneUIInterestFull(playerId, resolvedWorldTick, center, centerChunkOrigin) {
    const loadedSceneUIIds = this.getOrCreateLoadedSceneUIIds(playerId);
    const loadedLongRangeSceneUIIds = this.getOrCreateLoadedLongRangeSceneUIIds(playerId);
    const candidateSceneUIIds = this.sceneUISpatialInterestIndex.collectIdsInRange(centerChunkOrigin);
    const desiredSceneUIIds = new Set();

    for (const sceneUIId of candidateSceneUIIds) {
      const sceneUI = this.currentSceneUIStateById.get(sceneUIId);
      if (!sceneUI || !this.shouldSyncSceneUIToPlayer(sceneUI, playerId, center, centerChunkOrigin)) {
        continue;
      }

      desiredSceneUIIds.add(sceneUIId);
      if (loadedSceneUIIds.has(sceneUIId)) {
        continue;
      }

      loadedSceneUIIds.add(sceneUIId);
      loadedLongRangeSceneUIIds.delete(sceneUIId);
      this.queuePacket(playerId, [
        SCENE_UIS_PACKET_ID,
        [ cloneSceneUISchema(sceneUI) ],
        resolvedWorldTick,
      ]);
    }

    for (const sceneUIId of this.longRangeSceneUIIds) {
      if (desiredSceneUIIds.has(sceneUIId)) {
        continue;
      }

      const sceneUI = this.currentSceneUIStateById.get(sceneUIId);
      if (!sceneUI || !this.shouldSyncSceneUIToPlayer(sceneUI, playerId, center, centerChunkOrigin)) {
        continue;
      }

      desiredSceneUIIds.add(sceneUIId);
      if (loadedSceneUIIds.has(sceneUIId)) {
        continue;
      }

      loadedSceneUIIds.add(sceneUIId);
      loadedLongRangeSceneUIIds.add(sceneUIId);
      this.queuePacket(playerId, [
        SCENE_UIS_PACKET_ID,
        [ cloneSceneUISchema(sceneUI) ],
        resolvedWorldTick,
      ]);
    }

    for (const loadedSceneUIId of Array.from(loadedSceneUIIds)) {
      if (desiredSceneUIIds.has(loadedSceneUIId)) {
        continue;
      }

      loadedSceneUIIds.delete(loadedSceneUIId);
      loadedLongRangeSceneUIIds.delete(loadedSceneUIId);
      this.queuePacket(playerId, [
        SCENE_UIS_PACKET_ID,
        [ { i: loadedSceneUIId, rm: true } ],
        resolvedWorldTick,
      ]);
    }
  }

  syncPlayerSceneUIInterestIncremental(
    playerId,
    resolvedWorldTick,
    center,
    centerChunkOrigin,
    enteringChunkKeys,
    leavingChunkKeys,
  ) {
    const loadedSceneUIIds = this.getOrCreateLoadedSceneUIIds(playerId);
    const loadedLongRangeSceneUIIds = this.getOrCreateLoadedLongRangeSceneUIIds(playerId);
    const enteringSceneUIIds = this.sceneUISpatialInterestIndex.collectIdsForChunkKeys(enteringChunkKeys);
    const leavingSceneUIIds = this.sceneUISpatialInterestIndex.collectIdsForChunkKeys(leavingChunkKeys);

    for (const sceneUIId of enteringSceneUIIds) {
      const sceneUI = this.currentSceneUIStateById.get(sceneUIId);
      if (!sceneUI || !this.shouldSyncSceneUIToPlayer(sceneUI, playerId, center, centerChunkOrigin) || loadedSceneUIIds.has(sceneUIId)) {
        continue;
      }

      loadedSceneUIIds.add(sceneUIId);
      loadedLongRangeSceneUIIds.delete(sceneUIId);
      this.queuePacket(playerId, [
        SCENE_UIS_PACKET_ID,
        [ cloneSceneUISchema(sceneUI) ],
        resolvedWorldTick,
      ]);
    }

    for (const sceneUIId of leavingSceneUIIds) {
      if (!loadedSceneUIIds.has(sceneUIId) || loadedLongRangeSceneUIIds.has(sceneUIId)) {
        continue;
      }

      const sceneUI = this.currentSceneUIStateById.get(sceneUIId);
      if (!sceneUI || this.shouldSyncSceneUIToPlayer(sceneUI, playerId, center, centerChunkOrigin)) {
        continue;
      }

      loadedSceneUIIds.delete(sceneUIId);
      this.queuePacket(playerId, [
        SCENE_UIS_PACKET_ID,
        [ { i: sceneUIId, rm: true } ],
        resolvedWorldTick,
      ]);
    }

    this.reconcilePlayerLongRangeSceneUIInterest(
      playerId,
      resolvedWorldTick,
      center,
      centerChunkOrigin,
      loadedSceneUIIds,
      loadedLongRangeSceneUIIds,
    );
  }

  reconcilePlayerLongRangeSceneUIInterest(
    playerId,
    resolvedWorldTick,
    center,
    centerChunkOrigin,
    loadedSceneUIIds,
    loadedLongRangeSceneUIIds,
  ) {
    const desiredLongRangeSceneUIIds = new Set();

    for (const sceneUIId of this.longRangeSceneUIIds) {
      const sceneUI = this.currentSceneUIStateById.get(sceneUIId);
      if (!sceneUI || !this.shouldSyncSceneUIToPlayer(sceneUI, playerId, center, centerChunkOrigin)) {
        continue;
      }

      desiredLongRangeSceneUIIds.add(sceneUIId);
      if (loadedLongRangeSceneUIIds.has(sceneUIId)) {
        continue;
      }

      loadedSceneUIIds.add(sceneUIId);
      loadedLongRangeSceneUIIds.add(sceneUIId);
      this.queuePacket(playerId, [
        SCENE_UIS_PACKET_ID,
        [ cloneSceneUISchema(sceneUI) ],
        resolvedWorldTick,
      ]);
    }

    for (const loadedSceneUIId of Array.from(loadedLongRangeSceneUIIds)) {
      if (desiredLongRangeSceneUIIds.has(loadedSceneUIId)) {
        continue;
      }

      loadedLongRangeSceneUIIds.delete(loadedSceneUIId);
      loadedSceneUIIds.delete(loadedSceneUIId);
      this.queuePacket(playerId, [
        SCENE_UIS_PACKET_ID,
        [ { i: loadedSceneUIId, rm: true } ],
        resolvedWorldTick,
      ]);
    }
  }

  syncPlayerChunkInterest(playerId, worldTick) {
    if (!this.players.has(playerId)) {
      return;
    }

    const centerChunkOrigin = this.getPlayerChunkInterestCenterOrigin(playerId);
    const state = this.getOrCreateChunkInterestState(playerId);

    if (!centerChunkOrigin) {
      this.setPlayerChunkInterestCenterKey(playerId, undefined, state);
      state.needsRefresh = true;
      return;
    }

    const centerChunkKey = packCoordinate(centerChunkOrigin);
    if (!state.needsRefresh && state.centerChunkKey === centerChunkKey) {
      return;
    }

    const loadedChunkKeys = this.getOrCreateLoadedChunkKeys(playerId);
    const resolvedWorldTick = this.resolveWorldTick(worldTick);
    const previousCenterChunkOrigin = state.centerChunkKey ? unpackCoordinate(state.centerChunkKey) : undefined;
    const canRefreshIncrementally = !state.needsRefresh &&
      previousCenterChunkOrigin !== undefined &&
      this.canIncrementallyRefreshChunkInterest(previousCenterChunkOrigin, centerChunkOrigin);

    if (canRefreshIncrementally) {
      this.syncPlayerChunkInterestIncremental(
        playerId,
        resolvedWorldTick,
        state,
        loadedChunkKeys,
        previousCenterChunkOrigin,
        centerChunkOrigin,
        centerChunkKey,
      );
      return;
    }

    this.syncPlayerChunkInterestFull(playerId, resolvedWorldTick, state, loadedChunkKeys, centerChunkOrigin, centerChunkKey);
  }

  syncPlayerChunkInterestFull(playerId, resolvedWorldTick, state, loadedChunkKeys, centerChunkOrigin, centerChunkKey) {
    const desiredChunks = this.getDesiredChunksForCenter(centerChunkOrigin, centerChunkKey);
    const desiredChunkInfos = desiredChunks.chunkInfos;
    const desiredChunkKeys = desiredChunks.chunkKeys;

    for (const loadedChunkKey of Array.from(loadedChunkKeys)) {
      if (desiredChunkKeys.has(loadedChunkKey)) {
        continue;
      }

      const originCoordinate = unpackCoordinate(loadedChunkKey);
      if (originCoordinate) {
        this.queuePacket(playerId, [
          CHUNKS_PACKET_ID,
          [{ c: originCoordinate, rm: true }],
          resolvedWorldTick,
        ]);
      }

      this.markChunkUnloadedForPlayer(playerId, loadedChunkKey, loadedChunkKeys);
    }

    let remainingChunkLoads = CHUNK_STREAM_MAX_LOADS_PER_SYNC;
    let hasPendingChunkLoads = false;

    for (let i = 0; i < desiredChunkInfos.length; i++) {
      const chunkInfo = desiredChunkInfos[i];
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
      this.markChunkLoadedForPlayer(playerId, chunkInfo.key, loadedChunkKeys);
      remainingChunkLoads--;
    }

    this.setPlayerChunkInterestCenterKey(playerId, centerChunkKey, state);
    state.needsRefresh = hasPendingChunkLoads;
  }

  syncPlayerChunkInterestIncremental(
    playerId,
    resolvedWorldTick,
    state,
    loadedChunkKeys,
    previousCenterChunkOrigin,
    centerChunkOrigin,
    centerChunkKey,
  ) {
    const transitions = this.collectChunkInterestTransitions(previousCenterChunkOrigin, centerChunkOrigin);

    for (let i = 0; i < transitions.leavingChunkKeys.length; i++) {
      const loadedChunkKey = transitions.leavingChunkKeys[i];
      if (!loadedChunkKeys.has(loadedChunkKey)) {
        continue;
      }

      const originCoordinate = unpackCoordinate(loadedChunkKey);
      if (originCoordinate) {
        this.queuePacket(playerId, [
          CHUNKS_PACKET_ID,
          [{ c: originCoordinate, rm: true }],
          resolvedWorldTick,
        ]);
      }

      this.markChunkUnloadedForPlayer(playerId, loadedChunkKey, loadedChunkKeys);
    }

    let remainingChunkLoads = CHUNK_STREAM_MAX_LOADS_PER_SYNC;
    let hasPendingChunkLoads = false;

    for (let i = 0; i < transitions.enteringChunkInfos.length; i++) {
      const chunkInfo = transitions.enteringChunkInfos[i];
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
      this.markChunkLoadedForPlayer(playerId, chunkInfo.key, loadedChunkKeys);
      remainingChunkLoads--;
    }

    this.setPlayerChunkInterestCenterKey(playerId, centerChunkKey, state);
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

      const coalescedPackets = coalesceQueuedBatchPackets(packets);
      const serialized = serializePackets(coalescedPackets);
      sendToGateway({
        type: 'player_packet_batch',
        packetCount: coalescedPackets.length,
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
