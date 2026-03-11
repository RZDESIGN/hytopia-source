import protocol from '@hytopia.com/server-protocol';
import ErrorHandler from '@/errors/ErrorHandler';
import type GatewayPlayerSession from '@/networking/GatewayPlayerSession';
import GatewayPlayerSessionManager from '@/networking/GatewayPlayerSessionManager';
import IterationMap from '@/shared/classes/IterationMap';
import Telemetry, { TelemetrySpanOperation } from '@/metrics/Telemetry';
import { DEFAULT_TICK_RATE } from '@/worlds/physics/Simulation';
import type { AnyPacket, IPacketDefinition, PacketId } from '@hytopia.com/server-protocol';
import type { EventPayloads } from '@/events/Events';

import Connection from '@/networking/Connection';
import PlayerEntity from '@/worlds/entities/PlayerEntity';
import PlayerManager from '@/players/PlayerManager';
import Serializer from '@/networking/Serializer';
import { AudioEvent } from '@/worlds/audios/Audio';
import { BlockTypeRegistryEvent } from '@/worlds/blocks/BlockTypeRegistry';
import { ChatEvent } from '@/worlds/chat/ChatManager';
import { ChunkLatticeEvent } from '@/worlds/blocks/ChunkLattice';
import { EntityEvent } from '@/worlds/entities/Entity';
import { EntityModelAnimationEvent } from '@/worlds/entities/EntityModelAnimation';
import { EntityModelNodeOverrideEvent } from '@/worlds/entities/EntityModelNodeOverride';
import DefaultPlayerEntityController from '@/worlds/entities/controllers/DefaultPlayerEntityController';
import { ParticleEmitterEvent } from '@/worlds/particles/ParticleEmitter';
import { PlayerEvent } from '@/players/Player';
import { PlayerCameraEvent, PlayerCameraMode } from '@/players/PlayerCamera';
import { PlayerUIEvent } from '@/players/PlayerUI';
import { ChunkSpatialInterestIndex } from '@/shared/helpers/ChunkSpatialInterestIndex.js';
import { SceneUIEvent } from '@/worlds/ui/SceneUI';
import { SimulationEvent } from '@/worlds/physics/Simulation';
import { WorldEvent } from '@/worlds/World';
import WorldHostManager from '@/worlds/hosting/WorldHostManager';
import type Audio from '@/worlds/audios/Audio';
import type BlockType from '@/worlds/blocks/BlockType';
import Chunk, { CHUNK_SIZE } from '@/worlds/blocks/Chunk';
import type Entity from '@/worlds/entities/Entity';
import type EntityModelAnimation from '@/worlds/entities/EntityModelAnimation';
import type EntityModelNodeOverride from '@/worlds/entities/EntityModelNodeOverride';
import type ParticleEmitter from '@/worlds/particles/ParticleEmitter';
import type Player from '@/players/Player';
import type PlayerCamera from '@/players/PlayerCamera';
import type SceneUI from '@/worlds/ui/SceneUI';
import type World from '@/worlds/World';
import type Vector3Like from '@/shared/types/math/Vector3Like';

const DEFAULT_NETWORK_SYNC_RATE = 30;
const HIGH_FREQUENCY_NETWORK_SYNC_RATE = DEFAULT_TICK_RATE;
const HIGH_FREQUENCY_SYNC_MAX_PLAYERS = 8;
const NETWORK_SYNC_RATE_OVERRIDE = Number(process.env.HYTOPIA_NETWORK_SYNC_RATE);
const PROTOCOL_ENTITY_SCHEMA = (protocol as unknown as { entitySchema?: { properties?: Record<string, unknown> } }).entitySchema;
const PROTOCOL_ENTITY_PROPERTIES = PROTOCOL_ENTITY_SCHEMA?.properties ?? {};
const PROTOCOL_ENTITY_KEYS = Object.keys(PROTOCOL_ENTITY_PROPERTIES);
const UNRELIABLE_OWNER_PREDICTION_ENTITY_SYNC_KEYS = new Set([
  'aq',
  'fd',
  'ju',
  'js',
  'mv',
  'pf',
  'py',
  'rv',
  'sc',
  'sf',
  'sl',
  'su',
  'wv',
]);
const ENTITY_LOCAL_PREDICTION_FLAG_GROUNDED = 1 << 0;
const ENTITY_LOCAL_PREDICTION_FLAG_SWIMMING = 1 << 1;
const CHUNK_STREAM_HORIZONTAL_RADIUS = Math.max(0, Math.floor(Number(process.env.HYTOPIA_CHUNK_STREAM_HORIZONTAL_RADIUS ?? 6)));
const CHUNK_STREAM_VERTICAL_RADIUS = Math.max(0, Math.floor(Number(process.env.HYTOPIA_CHUNK_STREAM_VERTICAL_RADIUS ?? 3)));
const CHUNK_STREAM_MAX_LOADS_PER_SYNC = Math.max(1, Math.floor(Number(process.env.HYTOPIA_CHUNK_STREAM_MAX_LOADS_PER_SYNC ?? 48)));
const SCENE_UI_CHUNK_INTEREST_SAFE_VIEW_DISTANCE = Math.min(CHUNK_STREAM_HORIZONTAL_RADIUS, CHUNK_STREAM_VERTICAL_RADIUS) * CHUNK_SIZE;
const INPUT_ACK_UNRELIABLE_RESEND_SYNCS = 3;

type PlayerChunkInterestState = {
  centerChunkKey?: string;
  needsRefresh: boolean;
};

type InputAcknowledgementSendState = {
  resendSyncsRemaining: number;
  sequenceNumber: number;
};

type SyncQueue<TId, TSchema extends object | null> = {
  broadcast: IterationMap<TId, TSchema>;
  perPlayer: IterationMap<Player, IterationMap<TId, TSchema>>;
};

type SingletonSyncQueue<TSchema extends object | null> = {
  broadcast: TSchema | undefined;
  perPlayer: IterationMap<Player, TSchema>;
};

type ReliablePacketSlot = {
  perPlayerPackets?: Map<Player, AnyPacket[]>;
  sharedPackets?: AnyPacket[];
};

type PacketPlan = {
  perPlayerUnreliablePackets: Map<Player, AnyPacket[]>;
  postPlayerUIAfterChatReliableSlots: ReliablePacketSlot[];
  postPlayerUIBeforeWorldAndPlayersReliableSlots: ReliablePacketSlot[];
  prePlayerUIReliableSlots: ReliablePacketSlot[];
  prePlayerUISpecialReliableSlots: ReliablePacketSlot[];
  sharedUnreliablePackets: AnyPacket[];
};

/**
 * Batches world state changes into network packets for connected players.
 *
 * When to use: internal world loop synchronization only.
 * Do NOT use for: game logic or direct packet sends; use higher-level world/player APIs.
 *
 * @remarks
 * This class listens to world events, queues deltas, and flushes them at a fixed rate.
 * Pattern: constructed by `World` and invoked by the world loop each tick.
 * Anti-pattern: calling `synchronize` on every tick without `shouldSynchronize`.
 *
 * **Category:** Networking
 * @internal
 */
export default class NetworkSynchronizer {
  private _lastSentInputAcknowledgementByPlayer: WeakMap<Player, InputAcknowledgementSendState> = new WeakMap();

  private _queuedAudioSyncs: SyncQueue<number, protocol.AudioSchema> = { broadcast: new IterationMap(), perPlayer: new IterationMap() };
  private _queuedBlockSyncs: SyncQueue<string, protocol.BlockSchema> = { broadcast: new IterationMap(), perPlayer: new IterationMap() };
  private _queuedBlockTypeSyncs: SyncQueue<number, protocol.BlockTypeSchema> = { broadcast: new IterationMap(), perPlayer: new IterationMap() };
  private _queuedChunkSyncs: SyncQueue<string, protocol.ChunkSchema> = { broadcast: new IterationMap(), perPlayer: new IterationMap() };
  private _queuedEntitySyncs: SyncQueue<number, protocol.EntitySchema> = { broadcast: new IterationMap(), perPlayer: new IterationMap() };
  private _queuedParticleEmitterSyncs: SyncQueue<number, protocol.ParticleEmitterSchema> = { broadcast: new IterationMap(), perPlayer: new IterationMap() };
  private _queuedPlayerSyncs: SyncQueue<string, protocol.PlayerSchema> = { broadcast: new IterationMap(), perPlayer: new IterationMap() };
  private _queuedSceneUISyncs: SyncQueue<number, protocol.SceneUISchema> = { broadcast: new IterationMap(), perPlayer: new IterationMap() };
  
  private _queuedBlockEditPredictionConfigSyncs: SingletonSyncQueue<protocol.BlockEditPredictionConfigSchema> = { broadcast: undefined, perPlayer: new IterationMap() };
  private _queuedBlockEditPredictionResultsSyncs: SingletonSyncQueue<protocol.BlockEditPredictionResultsSchema> = { broadcast: undefined, perPlayer: new IterationMap() };
  private _queuedCameraSyncs: SingletonSyncQueue<protocol.CameraSchema> = { broadcast: undefined, perPlayer: new IterationMap() };
  private _queuedChatMessagesSyncs: SingletonSyncQueue<protocol.ChatMessagesSchema> = { broadcast: undefined, perPlayer: new IterationMap() };
  private _queuedDebugRaycastsSyncs: SingletonSyncQueue<protocol.PhysicsDebugRaycastsSchema> = { broadcast: undefined, perPlayer: new IterationMap() };
  private _queuedDebugRenderSyncs: SingletonSyncQueue<protocol.PhysicsDebugRenderSchema> = { broadcast: undefined, perPlayer: new IterationMap() };
  private _queuedUISyncs: SingletonSyncQueue<protocol.UISchema> = { broadcast: undefined, perPlayer: new IterationMap() };
  private _queuedUIDatasSyncs: SingletonSyncQueue<protocol.UIDatasSchema> = { broadcast: undefined, perPlayer: new IterationMap() };
  private _queuedWorldSyncs: SingletonSyncQueue<protocol.WorldSchema> = { broadcast: undefined, perPlayer: new IterationMap() };
  
  private _chunkInterestStateByPlayer: Map<Player, PlayerChunkInterestState> = new Map();
  private _loadedEntityIdsByPlayer: Map<Player, Set<number>> = new Map();
  private _loadedChunkKeysByPlayer: Map<Player, Set<string>> = new Map();
  private _loadedParticleEmitterIdsByPlayer: Map<Player, Set<number>> = new Map();
  private _loadedSceneUIIdsByPlayer: Map<Player, Set<number>> = new Map();
  private _entitySpatialInterestIndex: ChunkSpatialInterestIndex = new ChunkSpatialInterestIndex({
    chunkSize: CHUNK_SIZE,
    horizontalRadius: CHUNK_STREAM_HORIZONTAL_RADIUS,
    verticalRadius: CHUNK_STREAM_VERTICAL_RADIUS,
  });
  private _particleEmitterSpatialInterestIndex: ChunkSpatialInterestIndex = new ChunkSpatialInterestIndex({
    chunkSize: CHUNK_SIZE,
    horizontalRadius: CHUNK_STREAM_HORIZONTAL_RADIUS,
    verticalRadius: CHUNK_STREAM_VERTICAL_RADIUS,
  });
  private _sceneUISpatialInterestIndex: ChunkSpatialInterestIndex = new ChunkSpatialInterestIndex({
    chunkSize: CHUNK_SIZE,
    horizontalRadius: CHUNK_STREAM_HORIZONTAL_RADIUS,
    verticalRadius: CHUNK_STREAM_VERTICAL_RADIUS,
  });
  private _longRangeSceneUIIds: Set<number> = new Set();
  private _spatialInterestIndexesInitialized: boolean = false;
  private _loadedSceneUIs: Set<number> = new Set();
  private _spawnedEntities: Set<number> = new Set();
  private _syncAccumulator: number = 0;

  private _world: World;
  
  constructor(world: World) {
    this._world = world;

    this._subscribeToAudioEvents();
    this._subscribeToBlockTypeRegistryEvents();
    this._subscribeToChatEvents();
    this._subscribeToChunkLatticeEvents();
    this._subscribeToEntityEvents();
    this._subscribeToEntityModelAnimationEvents();
    this._subscribeToEntityModelNodeOverrideEvents();
    this._subscribeToParticleEmitterEvents();
    this._subscribeToPlayerEvents();
    this._subscribeToPlayerCameraEvents();
    this._subscribeToPlayerUIEvents();
    this._subscribeToSceneUIEvents();
    this._subscribeToSimulationEvents();
    this._subscribeToWorldEvents();
  }

  /**
   * Returns true when this tick should flush queued network syncs.
   *
   * @remarks
   * Uses a fixed sync rate lower than the physics tick rate.
   *
   * **Category:** Networking
   */
  public shouldSynchronize(): boolean {
    // Keep the first world tick responsive so initial joins and world changes
    // do not wait an extra frame for their first outbound sync.
    if (this._world.loop.currentTick === 0) {
      return true;
    }

    this._syncAccumulator += this._getTargetNetworkSyncRate();
    if (this._syncAccumulator < DEFAULT_TICK_RATE) {
      return false;
    }

    this._syncAccumulator -= DEFAULT_TICK_RATE;
    return true;
  }

  /**
   * Flushes queued deltas into outbound packets and sends them to players.
   *
   * @remarks
   * Packet ordering is significant. The flush order here matches client expectations.
   *
   * **Requires:** Call only when `shouldSynchronize` returns true.
   *
   * **Side effects:** Sends packets to all connected players, clears queued syncs,
   * and resets serialization caches.
   *
   * @see `shouldSynchronize`
   *
   * **Category:** Networking
   */
  public synchronize() {
    /*
     * Packet syncrhonization, order matters here!
     * The client will process packets in the order sent
     * unless they are unreliable packets!
     */

    const currentTick = this._world.loop.currentTick;
    this._queuePlayerInputAcknowledgements();
    this._refreshPlayerChunkInterests();
    this._refreshPlayerSpatialInterests();
    const packetPlan = Telemetry.startSpan({
      operation: TelemetrySpanOperation.BUILD_PACKETS,
    }, () => this._buildPacketPlan(currentTick));

    this._sendPacketPlan(packetPlan, currentTick);

    /*
     * Clear sync queues - We only clear queues if they aren't empty,
     * otherwise it causes significant memory growth and triggers unnecessary major GCs.
     */
    Telemetry.startSpan({ operation: TelemetrySpanOperation.NETWORK_SYNCHRONIZE_CLEANUP }, () => {
      if (this._loadedSceneUIs.size > 0) { this._loadedSceneUIs.clear(); }
      if (this._spawnedEntities.size > 0) { this._spawnedEntities.clear(); }

      this._clearSyncQueue(this._queuedAudioSyncs);
      this._clearSyncQueue(this._queuedBlockSyncs);
      this._clearSyncQueue(this._queuedBlockTypeSyncs);
      this._clearSyncQueue(this._queuedChunkSyncs);
      this._clearSyncQueue(this._queuedEntitySyncs);
      this._clearSyncQueue(this._queuedParticleEmitterSyncs);
      this._clearSyncQueue(this._queuedPlayerSyncs);
      this._clearSyncQueue(this._queuedSceneUISyncs);
      
      this._clearSingletonSyncQueue(this._queuedBlockEditPredictionConfigSyncs);
      this._clearSingletonSyncQueue(this._queuedBlockEditPredictionResultsSyncs);
      this._clearSingletonSyncQueue(this._queuedCameraSyncs);
      this._clearSingletonSyncQueue(this._queuedChatMessagesSyncs);
      this._clearSingletonSyncQueue(this._queuedDebugRaycastsSyncs);
      this._clearSingletonSyncQueue(this._queuedDebugRenderSyncs);
      this._clearSingletonSyncQueue(this._queuedUISyncs);
      this._clearSingletonSyncQueue(this._queuedUIDatasSyncs);
      this._clearSingletonSyncQueue(this._queuedWorldSyncs);
      
      // End of network synchronization, clear serialization cache
      Connection.clearCachedPacketsSerializedBuffers();
    });
  }

  private _subscribeToAudioEvents() {
    this._world.final(AudioEvent.PAUSE, this._onAudioPause);
    this._world.final(AudioEvent.PLAY, this._onAudioPlay);
    this._world.final(AudioEvent.PLAY_RESTART, this._onAudioPlayRestart);
    this._world.final(AudioEvent.SET_ATTACHED_TO_ENTITY, this._onAudioSetAttachedToEntity);
    this._world.final(AudioEvent.SET_CUTOFF_DISTANCE, this._onAudioSetCutoffDistance);
    this._world.final(AudioEvent.SET_DETUNE, this._onAudioSetDetune);
    this._world.final(AudioEvent.SET_DISTORTION, this._onAudioSetDistortion);
    this._world.final(AudioEvent.SET_POSITION, this._onAudioSetPosition);
    this._world.final(AudioEvent.SET_PLAYBACK_RATE, this._onAudioSetPlaybackRate);
    this._world.final(AudioEvent.SET_REFERENCE_DISTANCE, this._onAudioSetReferenceDistance);
    this._world.final(AudioEvent.SET_VOLUME, this._onAudioSetVolume);
    this._world.final(AudioEvent.UNLOAD, this._onAudioUnload);
  }

  private _subscribeToBlockTypeRegistryEvents() {
    this._world.final(BlockTypeRegistryEvent.REGISTER_BLOCK_TYPE, this._onBlockTypeRegistryRegisterBlockType);
  }

  private _subscribeToChatEvents() {
    this._world.final(ChatEvent.BROADCAST_MESSAGE, this._onChatSendBroadcastMessage);
    this._world.final(ChatEvent.PLAYER_MESSAGE, this._onChatSendPlayerMessage);
  }

  private _subscribeToChunkLatticeEvents() {
    this._world.final(ChunkLatticeEvent.ADD_CHUNK, this._onChunkLatticeAddChunk);
    this._world.final(ChunkLatticeEvent.REMOVE_CHUNK, this._onChunkLatticeRemoveChunk);
    this._world.final(ChunkLatticeEvent.SET_BLOCK, this._onChunkLatticeSetBlock);
  }

  private _subscribeToEntityEvents() {
    this._world.final(EntityEvent.SPAWN, this._onEntitySpawn);
    this._world.final(EntityEvent.DESPAWN, this._onEntityDespawn);
    this._world.final(EntityEvent.REMOVE_MODEL_NODE_OVERRIDE, this._onEntityRemoveModelNodeOverride);
    this._world.final(EntityEvent.SET_BLOCK_TEXTURE_URI, this._onEntitySetBlockTextureUri);
    this._world.final(EntityEvent.SET_EMISSIVE_COLOR, this._onEntitySetEmissiveColor);
    this._world.final(EntityEvent.SET_EMISSIVE_INTENSITY, this._onEntitySetEmissiveIntensity);
    this._world.final(EntityEvent.SET_MODEL_SCALE, this._onEntitySetModelScale);
    this._world.final(EntityEvent.SET_MODEL_SCALE_INTERPOLATION_MS, this._onEntitySetModelScaleInterpolationMs);
    this._world.final(EntityEvent.SET_MODEL_TEXTURE_URI, this._onEntitySetModelTextureUri);
    this._world.final(EntityEvent.SET_OPACITY, this._onEntitySetOpacity);
    this._world.final(EntityEvent.SET_OUTLINE, this._onEntitySetOutline);
    this._world.final(EntityEvent.SET_PARENT, this._onEntitySetParent);
    this._world.final(EntityEvent.SET_POSITION_INTERPOLATION_MS, this._onEntitySetPositionInterpolationMs);
    this._world.final(EntityEvent.SET_ROTATION_INTERPOLATION_MS, this._onEntitySetRotationInterpolationMs);
    this._world.final(EntityEvent.SET_TINT_COLOR, this._onEntitySetTintColor);
    this._world.final(EntityEvent.UPDATE_POSITION, this._onEntityUpdatePosition);
    this._world.final(EntityEvent.UPDATE_ROTATION, this._onEntityUpdateRotation);
  }
  
  private _subscribeToEntityModelAnimationEvents() {
    this._world.final(EntityModelAnimationEvent.PAUSE, this._onEntityModelAnimationPause);
    this._world.final(EntityModelAnimationEvent.PLAY, this._onEntityModelAnimationPlay);
    this._world.final(EntityModelAnimationEvent.RESTART, this._onEntityModelAnimationRestart);
    this._world.final(EntityModelAnimationEvent.SET_BLEND_MODE, this._onEntityModelAnimationSetBlendMode);
    this._world.final(EntityModelAnimationEvent.SET_CLAMP_WHEN_FINISHED, this._onEntityModelAnimationSetClampWhenFinished);
    this._world.final(EntityModelAnimationEvent.SET_FADES_IN, this._onEntityModelAnimationSetFadesIn);
    this._world.final(EntityModelAnimationEvent.SET_FADES_OUT, this._onEntityModelAnimationSetFadesOut);
    this._world.final(EntityModelAnimationEvent.SET_LOOP_MODE, this._onEntityModelAnimationSetLoopMode);
    this._world.final(EntityModelAnimationEvent.SET_PLAYBACK_RATE, this._onEntityModelAnimationSetPlaybackRate);
    this._world.final(EntityModelAnimationEvent.SET_WEIGHT, this._onEntityModelAnimationSetWeight);
    this._world.final(EntityModelAnimationEvent.STOP, this._onEntityModelAnimationStop);
  }

  private _subscribeToEntityModelNodeOverrideEvents() {
    this._world.final(EntityModelNodeOverrideEvent.SET_EMISSIVE_COLOR, this._onEntityModelNodeOverrideSetEmissiveColor);
    this._world.final(EntityModelNodeOverrideEvent.SET_EMISSIVE_INTENSITY, this._onEntityModelNodeOverrideSetEmissiveIntensity);
    this._world.final(EntityModelNodeOverrideEvent.SET_HIDDEN, this._onEntityModelNodeOverrideSetHidden);
    this._world.final(EntityModelNodeOverrideEvent.SET_LOCAL_POSITION, this._onEntityModelNodeOverrideSetLocalPosition);
    this._world.final(EntityModelNodeOverrideEvent.SET_LOCAL_POSITION_INTERPOLATION_MS, this._onEntityModelNodeOverrideSetLocalPositionInterpolationMs);
    this._world.final(EntityModelNodeOverrideEvent.SET_LOCAL_ROTATION, this._onEntityModelNodeOverrideSetLocalRotation);
    this._world.final(EntityModelNodeOverrideEvent.SET_LOCAL_ROTATION_INTERPOLATION_MS, this._onEntityModelNodeOverrideSetLocalRotationInterpolationMs);
    this._world.final(EntityModelNodeOverrideEvent.SET_LOCAL_SCALE, this._onEntityModelNodeOverrideSetLocalScale);
    this._world.final(EntityModelNodeOverrideEvent.SET_LOCAL_SCALE_INTERPOLATION_MS, this._onEntityModelNodeOverrideSetLocalScaleInterpolationMs);
  }

  private _subscribeToParticleEmitterEvents() {
    this._world.final(ParticleEmitterEvent.DESPAWN, this._onParticleEmitterDespawn);
    this._world.final(ParticleEmitterEvent.BURST, this._onParticleEmitterBurst);
    this._world.final(ParticleEmitterEvent.SET_ALPHA_TEST, this._onParticleEmitterSetAlphaTest);
    this._world.final(ParticleEmitterEvent.SET_ATTACHED_TO_ENTITY, this._onParticleEmitterSetAttachedToEntity);
    this._world.final(ParticleEmitterEvent.SET_ATTACHED_TO_ENTITY_NODE_NAME, this._onParticleEmitterSetAttachedToEntityNodeName);
    this._world.final(ParticleEmitterEvent.SET_COLOR_END, this._onParticleEmitterSetColorEnd);
    this._world.final(ParticleEmitterEvent.SET_COLOR_END_VARIANCE, this._onParticleEmitterSetColorEndVariance);
    this._world.final(ParticleEmitterEvent.SET_COLOR_INTENSITY_END, this._onParticleEmitterSetColorIntensityEnd);
    this._world.final(ParticleEmitterEvent.SET_COLOR_INTENSITY_END_VARIANCE, this._onParticleEmitterSetColorIntensityEndVariance);
    this._world.final(ParticleEmitterEvent.SET_COLOR_INTENSITY_START, this._onParticleEmitterSetColorIntensityStart);
    this._world.final(ParticleEmitterEvent.SET_COLOR_INTENSITY_START_VARIANCE, this._onParticleEmitterSetColorIntensityStartVariance);
    this._world.final(ParticleEmitterEvent.SET_COLOR_START, this._onParticleEmitterSetColorStart);
    this._world.final(ParticleEmitterEvent.SET_COLOR_START_VARIANCE, this._onParticleEmitterSetColorStartVariance);
    this._world.final(ParticleEmitterEvent.SET_GRAVITY, this._onParticleEmitterSetGravity);
    this._world.final(ParticleEmitterEvent.SET_LIFETIME, this._onParticleEmitterSetLifetime);
    this._world.final(ParticleEmitterEvent.SET_LIFETIME_VARIANCE, this._onParticleEmitterSetLifetimeVariance);
    this._world.final(ParticleEmitterEvent.SET_MAX_PARTICLES, this._onParticleEmitterSetMaxParticles);
    this._world.final(ParticleEmitterEvent.SET_OFFSET, this._onParticleEmitterSetOffset);
    this._world.final(ParticleEmitterEvent.SET_ORIENTATION, this._onParticleEmitterSetOrientation);
    this._world.final(ParticleEmitterEvent.SET_ORIENTATION_FIXED_ROTATION, this._onParticleEmitterSetOrientationFixedRotation);
    this._world.final(ParticleEmitterEvent.SET_OPACITY_END, this._onParticleEmitterSetOpacityEnd);
    this._world.final(ParticleEmitterEvent.SET_OPACITY_END_VARIANCE, this._onParticleEmitterSetOpacityEndVariance);
    this._world.final(ParticleEmitterEvent.SET_OPACITY_START, this._onParticleEmitterSetOpacityStart);
    this._world.final(ParticleEmitterEvent.SET_OPACITY_START_VARIANCE, this._onParticleEmitterSetOpacityStartVariance);
    this._world.final(ParticleEmitterEvent.SET_PAUSED, this._onParticleEmitterSetPaused);
    this._world.final(ParticleEmitterEvent.SET_POSITION, this._onParticleEmitterSetPosition);
    this._world.final(ParticleEmitterEvent.SET_POSITION_VARIANCE, this._onParticleEmitterSetPositionVariance);
    this._world.final(ParticleEmitterEvent.SET_RATE, this._onParticleEmitterSetRate);
    this._world.final(ParticleEmitterEvent.SET_RATE_VARIANCE, this._onParticleEmitterSetRateVariance);
    this._world.final(ParticleEmitterEvent.SET_SIZE_END, this._onParticleEmitterSetSizeEnd);
    this._world.final(ParticleEmitterEvent.SET_SIZE_END_VARIANCE, this._onParticleEmitterSetSizeEndVariance);
    this._world.final(ParticleEmitterEvent.SET_SIZE_START, this._onParticleEmitterSetSizeStart);
    this._world.final(ParticleEmitterEvent.SET_SIZE_START_VARIANCE, this._onParticleEmitterSetSizeStartVariance);
    this._world.final(ParticleEmitterEvent.SET_TEXTURE_URI, this._onParticleEmitterSetTextureUri);
    this._world.final(ParticleEmitterEvent.SET_TRANSPARENT, this._onParticleEmitterSetTransparent);
    this._world.final(ParticleEmitterEvent.SET_VELOCITY, this._onParticleEmitterSetVelocity);
    this._world.final(ParticleEmitterEvent.SET_VELOCITY_VARIANCE, this._onParticleEmitterSetVelocityVariance);
    this._world.final(ParticleEmitterEvent.SPAWN, this._onParticleEmitterSpawn);
  }

  private _subscribeToPlayerEvents() {
    this._world.final(PlayerEvent.CONFIRM_BLOCK_EDIT_PREDICTION, this._onPlayerConfirmBlockEditPrediction);
    this._world.final(PlayerEvent.DEFAULT_BLOCK_EDIT_PREDICTION_CONFIG_UPDATE, this._onPlayerDefaultBlockEditPredictionConfigUpdate);
    this._world.final(PlayerEvent.JOINED_WORLD, this._onPlayerJoinedWorld);
    this._world.final(PlayerEvent.LEFT_WORLD, this._onPlayerLeftWorld);
    this._world.final(PlayerEvent.RECONNECTED_WORLD, this._onPlayerReconnectedWorld);
    this._world.final(PlayerEvent.REQUEST_NOTIFICATION_PERMISSION, this._onPlayerRequestNotificationPermission);
    this._world.final(PlayerEvent.REQUEST_SYNC, this._onPlayerRequestSync);
    this._world.final(PlayerEvent.ROLLBACK_BLOCK_EDIT_PREDICTION, this._onPlayerRollbackBlockEditPrediction);
  }

  private _subscribeToPlayerCameraEvents() {
    this._world.final(PlayerCameraEvent.FACE_ENTITY, this._onPlayerCameraFaceEntity);
    this._world.final(PlayerCameraEvent.FACE_POSITION, this._onPlayerCameraFacePosition);
    this._world.final(PlayerCameraEvent.SET_ATTACHED_TO_ENTITY, this._onPlayerCameraSetAttachedToEntity);
    this._world.final(PlayerCameraEvent.SET_ATTACHED_TO_POSITION, this._onPlayerCameraSetAttachedToPosition);
    this._world.final(PlayerCameraEvent.SET_COLLIDES_WITH_BLOCKS, this._onPlayerCameraSetCollidesWithBlocks);
    this._world.final(PlayerCameraEvent.SET_FILM_OFFSET, this._onPlayerCameraSetFilmOffset);
    this._world.final(PlayerCameraEvent.SET_FORWARD_OFFSET, this._onPlayerCameraSetForwardOffset);
    this._world.final(PlayerCameraEvent.SET_FOV, this._onPlayerCameraSetFov);
    this._world.final(PlayerCameraEvent.SET_MODE, this._onPlayerCameraSetMode);
    this._world.final(PlayerCameraEvent.SET_OFFSET, this._onPlayerCameraSetOffset);
    this._world.final(PlayerCameraEvent.SET_SHOULDER_ANGLE, this._onPlayerCameraSetShoulderAngle);
    this._world.final(PlayerCameraEvent.SET_TARGET_ENTITY, this._onPlayerCameraSetTargetEntity);
    this._world.final(PlayerCameraEvent.SET_TARGET_POSITION, this._onPlayerCameraSetTargetPosition);
    this._world.final(PlayerCameraEvent.SET_VIEW_MODEL, this._onPlayerCameraSetViewModel);
    this._world.final(PlayerCameraEvent.SET_VIEW_MODEL_HIDDEN_NODES, this._onPlayerCameraSetViewModelHiddenNodes);
    this._world.final(PlayerCameraEvent.SET_VIEW_MODEL_PITCHES_WITH_CAMERA, this._onPlayerCameraSetViewModelPitchesWithCamera);
    this._world.final(PlayerCameraEvent.SET_VIEW_MODEL_SHOWN_NODES, this._onPlayerCameraSetViewModelShownNodes);
    this._world.final(PlayerCameraEvent.SET_VIEW_MODEL_YAWS_WITH_CAMERA, this._onPlayerCameraSetViewModelYawsWithCamera);
    this._world.final(PlayerCameraEvent.SET_ZOOM, this._onPlayerCameraSetZoom);
  }

  private _subscribeToPlayerUIEvents() {
    this._world.final(PlayerUIEvent.APPEND, this._onPlayerUIAppend);
    this._world.final(PlayerUIEvent.FREEZE_POINTER_LOCK, this._onPlayerUIFreezePointerLock);
    this._world.final(PlayerUIEvent.LOAD, this._onPlayerUILoad);
    this._world.final(PlayerUIEvent.LOCK_POINTER, this._onPlayerUILockPointer);
    this._world.final(PlayerUIEvent.SEND_DATA, this._onPlayerUISendData);
  }

  private _subscribeToSceneUIEvents() {
    this._world.final(SceneUIEvent.LOAD, this._onSceneUILoad);
    this._world.final(SceneUIEvent.SET_ATTACHED_TO_ENTITY, this._onSceneUISetAttachedToEntity);
    this._world.final(SceneUIEvent.SET_OFFSET, this._onSceneUISetOffset);
    this._world.final(SceneUIEvent.SET_POSITION, this._onSceneUISetPosition);
    this._world.final(SceneUIEvent.SET_STATE, this._onSceneUISetState);
    this._world.final(SceneUIEvent.SET_VIEW_DISTANCE, this._onSceneUISetViewDistance);
    this._world.final(SceneUIEvent.UNLOAD, this._onSceneUIUnload);
  }

  private _subscribeToSimulationEvents() {
    this._world.final(SimulationEvent.DEBUG_RAYCAST, this._onSimulationDebugRaycast);
    this._world.final(SimulationEvent.DEBUG_RENDER, this._onSimulationDebugRender);
  }

  private _subscribeToWorldEvents() {
    this._world.final(WorldEvent.SET_AMBIENT_LIGHT_COLOR, this._onWorldSetAmbientLightColor);
    this._world.final(WorldEvent.SET_AMBIENT_LIGHT_INTENSITY, this._onWorldSetAmbientLightIntensity);
    this._world.final(WorldEvent.SET_DIRECTIONAL_LIGHT_COLOR, this._onWorldSetDirectionalLightColor);
    this._world.final(WorldEvent.SET_DIRECTIONAL_LIGHT_INTENSITY, this._onWorldSetDirectionalLightIntensity);
    this._world.final(WorldEvent.SET_DIRECTIONAL_LIGHT_POSITION, this._onWorldSetDirectionalLightPosition);
    this._world.final(WorldEvent.SET_FOG_COLOR, this._onWorldSetFogColor);
    this._world.final(WorldEvent.SET_FOG_FAR, this._onWorldSetFogFar);
    this._world.final(WorldEvent.SET_FOG_NEAR, this._onWorldSetFogNear);
    this._world.final(WorldEvent.SET_SKYBOX_INTENSITY, this._onWorldSetSkyboxIntensity);
    this._world.final(WorldEvent.SET_SKYBOX_URI, this._onWorldSetSkyboxUri);
  }

  private _onAudioPause = (payload: EventPayloads[AudioEvent.PAUSE]) => {
    if (this._mirrorAudioStatePatch({
      i: payload.audio.id!,
      pa: true,
    })) {
      return;
    }

    const audioSync = this._createOrGetQueuedAudioSync(payload.audio);
    audioSync.pa = true;
    delete audioSync.pl;
    delete audioSync.r;
  };

  private _onAudioPlay = (payload: EventPayloads[AudioEvent.PLAY]) => {
    if (this._mirrorAudioStatePatch({
      ...payload.audio.serialize(),
      pa: undefined,
      pl: true,
      r: undefined,
    })) {
      return;
    }

    const audioSync = this._createOrGetQueuedAudioSync(payload.audio);
    Object.assign(audioSync, payload.audio.serialize());
    audioSync.pl = true;
    delete audioSync.pa;
    delete audioSync.r;
  };

  private _onAudioPlayRestart = (payload: EventPayloads[AudioEvent.PLAY_RESTART]) => {
    if (this._mirrorAudioStatePatch({
      ...payload.audio.serialize(),
      pa: undefined,
      pl: undefined,
      r: true,
    })) {
      return;
    }

    const audioSync = this._createOrGetQueuedAudioSync(payload.audio);
    Object.assign(audioSync, payload.audio.serialize());
    audioSync.r = true;
    delete audioSync.pa;
    delete audioSync.pl;
  };

  private _onAudioSetAttachedToEntity = (payload: EventPayloads[AudioEvent.SET_ATTACHED_TO_ENTITY]) => {
    if (this._mirrorAudioStatePatch({
      e: payload.entity ? payload.entity.id : undefined,
      i: payload.audio.id!,
      p: payload.entity ? undefined : payload.audio.position ? Serializer.serializeVector(payload.audio.position) : undefined,
    })) {
      return;
    }

    const audioSync = this._createOrGetQueuedAudioSync(payload.audio);
    audioSync.e = payload.entity ? payload.entity.id : undefined;
    audioSync.p = payload.entity ? undefined : audioSync.p;
  };

  private _onAudioSetCutoffDistance = (payload: EventPayloads[AudioEvent.SET_CUTOFF_DISTANCE]) => {
    if (this._mirrorAudioStatePatch({
      cd: payload.cutoffDistance,
      i: payload.audio.id!,
    })) {
      return;
    }

    const audioSync = this._createOrGetQueuedAudioSync(payload.audio);
    audioSync.cd = payload.cutoffDistance;
  };

  private _onAudioSetDetune = (payload: EventPayloads[AudioEvent.SET_DETUNE]) => {
    if (this._mirrorAudioStatePatch({
      de: payload.detune,
      i: payload.audio.id!,
    })) {
      return;
    }

    const audioSync = this._createOrGetQueuedAudioSync(payload.audio);
    audioSync.de = payload.detune;
  };

  private _onAudioSetDistortion = (payload: EventPayloads[AudioEvent.SET_DISTORTION]) => {
    if (this._mirrorAudioStatePatch({
      di: payload.distortion,
      i: payload.audio.id!,
    })) {
      return;
    }

    const audioSync = this._createOrGetQueuedAudioSync(payload.audio);
    audioSync.di = payload.distortion;
  };

  private _onAudioSetPosition = (payload: EventPayloads[AudioEvent.SET_POSITION]) => {
    if (this._mirrorAudioStatePatch({
      e: payload.position ? undefined : payload.audio.attachedToEntity?.id,
      i: payload.audio.id!,
      p: payload.position ? Serializer.serializeVector(payload.position) : undefined,
    })) {
      return;
    }

    const audioSync = this._createOrGetQueuedAudioSync(payload.audio);
    audioSync.e = payload.position ? undefined : audioSync.e;
    audioSync.p = payload.position ? Serializer.serializeVector(payload.position) : undefined;
  };

  private _onAudioSetPlaybackRate = (payload: EventPayloads[AudioEvent.SET_PLAYBACK_RATE]) => {
    if (this._mirrorAudioStatePatch({
      i: payload.audio.id!,
      pr: payload.playbackRate,
    })) {
      return;
    }

    const audioSync = this._createOrGetQueuedAudioSync(payload.audio);
    audioSync.pr = payload.playbackRate;
  };

  private _onAudioSetReferenceDistance = (payload: EventPayloads[AudioEvent.SET_REFERENCE_DISTANCE]) => {
    if (this._mirrorAudioStatePatch({
      i: payload.audio.id!,
      rd: payload.referenceDistance,
    })) {
      return;
    }

    const audioSync = this._createOrGetQueuedAudioSync(payload.audio);
    audioSync.rd = payload.referenceDistance;
  };

  private _onAudioSetVolume = (payload: EventPayloads[AudioEvent.SET_VOLUME]) => {
    if (this._mirrorAudioStatePatch({
      i: payload.audio.id!,
      v: payload.volume,
    })) {
      return;
    }

    const audioSync = this._createOrGetQueuedAudioSync(payload.audio);
    audioSync.v = payload.volume;
  };

  private _onAudioUnload = (payload: EventPayloads[AudioEvent.UNLOAD]) => {
    this._removeMirroredAudioState(payload.audio.id!);
  };

  private _onBlockTypeRegistryRegisterBlockType = (payload: EventPayloads[BlockTypeRegistryEvent.REGISTER_BLOCK_TYPE]) => {
    if (this._mirrorBlockTypeStatePatch(payload.blockType.serialize())) {
      return;
    }

    const blockTypeSync = this._createOrGetQueuedBlockTypeSync(payload.blockType);
    Object.assign(blockTypeSync, payload.blockType.serialize());
  };

  private _onChatSendBroadcastMessage = (payload: EventPayloads[ChatEvent.BROADCAST_MESSAGE]) => {
    const chatMessagesSync = this._createOrGetQueuedChatMessagesSync();
    chatMessagesSync.push({ m: payload.message, c: payload.color, p: payload.player?.id });
  };

  private _onChatSendPlayerMessage = (payload: EventPayloads[ChatEvent.PLAYER_MESSAGE]) => {
    const playerChatMessagesSync = this._createOrGetQueuedChatMessagesSync(payload.player);
    playerChatMessagesSync.push({ m: payload.message, c: payload.color });
  };

  private _onChunkLatticeAddChunk = (payload: EventPayloads[ChunkLatticeEvent.ADD_CHUNK]) => {
    if (this._mirrorChunkStatePatch(payload.chunk.serialize())) {
      return;
    }

    for (const player of this._getPlayersInterestedInChunk(payload.chunk)) {
      this._queueChunkStateForPlayer(payload.chunk, player);
      this._getOrCreateLoadedChunkKeys(player).add(this._chunkKeyForOriginCoordinate(payload.chunk.originCoordinate));
    }
  };

  private _onChunkLatticeRemoveChunk = (payload: EventPayloads[ChunkLatticeEvent.REMOVE_CHUNK]) => {
    if (this._mirrorChunkStatePatch({
      c: Serializer.serializeVector(payload.chunk.originCoordinate),
      rm: true,
    })) {
      return;
    }

    const chunkKey = this._chunkKeyForOriginCoordinate(payload.chunk.originCoordinate);
    for (const [player, loadedChunkKeys] of this._loadedChunkKeysByPlayer.entries()) {
      if (!loadedChunkKeys.has(chunkKey)) {
        continue;
      }

      this._queueChunkRemovalForPlayer(payload.chunk, player);
      loadedChunkKeys.delete(chunkKey);
    }
  };

  private _onChunkLatticeSetBlock = (payload: EventPayloads[ChunkLatticeEvent.SET_BLOCK]) => {
    if (this._mirrorBlockStatePatch({
      c: Serializer.serializeVector(payload.globalCoordinate),
      i: payload.blockTypeId,
      r: payload.blockRotation?.enumIndex,
    })) {
      return;
    }

    const chunkKey = this._chunkKeyForGlobalCoordinate(payload.globalCoordinate);

    for (const [player, loadedChunkKeys] of this._loadedChunkKeysByPlayer.entries()) {
      if (!loadedChunkKeys.has(chunkKey)) {
        continue;
      }

      const blockSync = this._createOrGetQueuedBlockSync(payload.globalCoordinate, player);
      blockSync.i = payload.blockTypeId;
      blockSync.r = payload.blockRotation?.enumIndex;
    }
  };

  private _onEntitySpawn = (payload: EventPayloads[EntityEvent.SPAWN]) => {
    if (this._mirrorEntityStatePatch(payload.entity.serialize())) {
      if (payload.entity instanceof PlayerEntity) {
        this._queueOwnerPlayerEntityPredictionSync(payload.entity);
      }

      return;
    }

    const entitySync = this._createOrGetQueuedEntitySync(payload.entity);
    Object.assign(entitySync, payload.entity.serialize());
    if (payload.entity instanceof PlayerEntity) {
      this._queueOwnerPlayerEntityPredictionSync(payload.entity);
    }
    this._spawnedEntities.add(entitySync.i);
    this._updateEntitySpatialInterest(payload.entity);
  };

  private _onEntityDespawn = (payload: EventPayloads[EntityEvent.DESPAWN]) => {
    const entityId = payload.entity.id!;

    if (this._mirrorEntityStatePatch({
      i: entityId,
      rm: true,
    })) {
      return;
    }

    this._markPerPlayerEntitySyncsRemoved(entityId);

    if (this._spawnedEntities.has(entityId)) {
      this._queuedEntitySyncs.broadcast.delete(entityId);
      this._spawnedEntities.delete(entityId);
    } else {
      this._markEntitySyncRemoved(this._createOrGetQueuedEntitySyncById(entityId));
    }

    this._removeEntitySpatialInterest(entityId);
  };

  private _onEntityRemoveModelNodeOverride = (payload: EventPayloads[EntityEvent.REMOVE_MODEL_NODE_OVERRIDE]) => {
    if (this._mirrorEntityStatePatch({
      i: payload.entityModelNodeOverride.entity.id!,
      mo: [{ n: payload.entityModelNodeOverride.nameMatch, rm: true }],
    })) {
      return;
    }

    const entityModelNodeOverrideSync = this._createOrGetQueuedEntityModelNodeOverrideSync(payload.entityModelNodeOverride);
    entityModelNodeOverrideSync.rm = true;
  };

  private _onEntitySetBlockTextureUri = (payload: EventPayloads[EntityEvent.SET_BLOCK_TEXTURE_URI]) => {
    if (this._mirrorEntityStatePatch({
      bt: payload.blockTextureUri,
      i: payload.entity.id!,
    })) {
      return;
    }

    const entitySync = this._createOrGetQueuedEntitySync(payload.entity);
    entitySync.bt = payload.blockTextureUri;
  };

  private _onEntitySetEmissiveColor = (payload: EventPayloads[EntityEvent.SET_EMISSIVE_COLOR]) => {
    if (this._mirrorEntityStatePatch({
      ec: payload.emissiveColor ? Serializer.serializeRgbColor(payload.emissiveColor) : undefined,
      i: payload.entity.id!,
    })) {
      return;
    }

    const entitySync = this._createOrGetQueuedEntitySync(payload.entity);
    entitySync.ec = payload.emissiveColor ? Serializer.serializeRgbColor(payload.emissiveColor) : undefined;
  };

  private _onEntitySetEmissiveIntensity = (payload: EventPayloads[EntityEvent.SET_EMISSIVE_INTENSITY]) => {
    if (this._mirrorEntityStatePatch({
      ei: payload.emissiveIntensity,
      i: payload.entity.id!,
    })) {
      return;
    }

    const entitySync = this._createOrGetQueuedEntitySync(payload.entity);
    entitySync.ei = payload.emissiveIntensity;
  };

  private _onEntitySetModelScale = (payload: EventPayloads[EntityEvent.SET_MODEL_SCALE]) => {
    if (this._mirrorEntityStatePatch({
      i: payload.entity.id!,
      sv: payload.modelScale ? Serializer.serializeVector(payload.modelScale) : undefined,
    })) {
      return;
    }

    const entitySync = this._createOrGetQueuedEntitySync(payload.entity);
    entitySync.sv = payload.modelScale ? Serializer.serializeVector(payload.modelScale) : undefined;
  };

  private _onEntitySetModelScaleInterpolationMs = (payload: EventPayloads[EntityEvent.SET_MODEL_SCALE_INTERPOLATION_MS]) => {
    if (this._mirrorEntityStatePatch({
      i: payload.entity.id!,
      si: payload.interpolationMs,
    })) {
      return;
    }

    const entitySync = this._createOrGetQueuedEntitySync(payload.entity);
    entitySync.si = payload.interpolationMs;
  };

  private _onEntitySetModelTextureUri = (payload: EventPayloads[EntityEvent.SET_MODEL_TEXTURE_URI]) => {
    if (this._mirrorEntityStatePatch({
      i: payload.entity.id!,
      mt: payload.modelTextureUri,
    })) {
      return;
    }

    const entitySync = this._createOrGetQueuedEntitySync(payload.entity);
    entitySync.mt = payload.modelTextureUri;
  };

  private _onEntitySetOpacity = (payload: EventPayloads[EntityEvent.SET_OPACITY]) => {
    if (this._mirrorEntityStatePatch({
      i: payload.entity.id!,
      o: payload.opacity,
    })) {
      return;
    }

    const entitySync = this._createOrGetQueuedEntitySync(payload.entity);
    entitySync.o = payload.opacity;
  };

  private _onEntitySetOutline = (payload: EventPayloads[EntityEvent.SET_OUTLINE]) => {
    if (!payload.forPlayer && this._mirrorEntityStatePatch({
      i: payload.entity.id!,
      ol: payload.outline ? Serializer.serializeOutline(payload.outline) : undefined,
    })) {
      return;
    }

    const entitySync = this._createOrGetQueuedEntitySync(payload.entity, payload.forPlayer);
    entitySync.ol = payload.outline ? Serializer.serializeOutline(payload.outline) : undefined;
  };

  private _onEntitySetParent = (payload: EventPayloads[EntityEvent.SET_PARENT]) => {
    if (this._mirrorEntityStatePatch({
      i: payload.entity.id!,
      pe: payload.parent ? payload.parent.id : undefined,
      pn: payload.parentNodeName,
    })) {
      return;
    }

    const entitySync = this._createOrGetQueuedEntitySync(payload.entity);
    entitySync.pe = payload.parent ? payload.parent.id : undefined;
    entitySync.pn = payload.parentNodeName;
    this._updateEntitySpatialInterest(payload.entity);
  };

  private _onEntitySetPositionInterpolationMs = (payload: EventPayloads[EntityEvent.SET_POSITION_INTERPOLATION_MS]) => {
    if (this._mirrorEntityStatePatch({
      i: payload.entity.id!,
      pi: payload.interpolationMs,
    })) {
      return;
    }

    const entitySync = this._createOrGetQueuedEntitySync(payload.entity);
    entitySync.pi = payload.interpolationMs;
  };

  private _onEntitySetRotationInterpolationMs = (payload: EventPayloads[EntityEvent.SET_ROTATION_INTERPOLATION_MS]) => {
    if (this._mirrorEntityStatePatch({
      i: payload.entity.id!,
      ri: payload.interpolationMs,
    })) {
      return;
    }

    const entitySync = this._createOrGetQueuedEntitySync(payload.entity);
    entitySync.ri = payload.interpolationMs;
  };

  private _onEntitySetTintColor = (payload: EventPayloads[EntityEvent.SET_TINT_COLOR]) => {
    if (this._mirrorEntityStatePatch({
      i: payload.entity.id!,
      t: payload.tintColor ? Serializer.serializeRgbColor(payload.tintColor) : undefined,
    })) {
      return;
    }

    const entitySync = this._createOrGetQueuedEntitySync(payload.entity);
    entitySync.t = payload.tintColor ? Serializer.serializeRgbColor(payload.tintColor) : undefined;
  };

  private _onEntityUpdatePosition = (payload: EventPayloads[EntityEvent.UPDATE_POSITION]) => {
    if (this._mirrorEntityStatePatch({
      i: payload.entity.id!,
      p: [ payload.position.x, payload.position.y, payload.position.z ],
    })) {
      if (payload.entity instanceof PlayerEntity) {
        this._queueOwnerPlayerEntityPredictionSync(payload.entity, true);
      }

      return;
    }

    const entitySync = this._createOrGetQueuedEntitySync(payload.entity);
    const p = entitySync.p;
    if (p) {
      p[0] = payload.position.x;
      p[1] = payload.position.y;
      p[2] = payload.position.z;
    } else {
      entitySync.p = [ payload.position.x, payload.position.y, payload.position.z ];
    }

    if (payload.entity instanceof PlayerEntity) {
      this._queueOwnerPlayerEntityPredictionSync(payload.entity, true);
    }

    this._updateEntitySpatialInterest(payload.entity);
  };

  private _onEntityUpdateRotation = (payload: EventPayloads[EntityEvent.UPDATE_ROTATION]) => {
    if (this._mirrorEntityStatePatch({
      i: payload.entity.id!,
      r: [ payload.rotation.x, payload.rotation.y, payload.rotation.z, payload.rotation.w ],
    })) {
      if (payload.entity instanceof PlayerEntity) {
        this._queueOwnerPlayerEntityPredictionSync(payload.entity, true);
      }

      return;
    }

    const entitySync = this._createOrGetQueuedEntitySync(payload.entity);
    const r = entitySync.r;
    if (r) {
      r[0] = payload.rotation.x;
      r[1] = payload.rotation.y;
      r[2] = payload.rotation.z;
      r[3] = payload.rotation.w;
    } else {
      entitySync.r = [ payload.rotation.x, payload.rotation.y, payload.rotation.z, payload.rotation.w ];
    }

    if (payload.entity instanceof PlayerEntity) {
      this._queueOwnerPlayerEntityPredictionSync(payload.entity, true);
    }
  };

  private _onEntityModelAnimationPause = (payload: EventPayloads[EntityModelAnimationEvent.PAUSE]) => {
    if (this._mirrorEntityStatePatch({
      i: payload.entityModelAnimation.entity.id!,
      ma: [{ n: payload.entityModelAnimation.name, pa: true }],
    })) {
      return;
    }

    const entityModelAnimationSync = this._createOrGetQueuedEntityModelAnimationSync(payload.entityModelAnimation);
    entityModelAnimationSync.pa = true;
    delete entityModelAnimationSync.p;
    delete entityModelAnimationSync.r;
    delete entityModelAnimationSync.s;
  };

  private _onEntityModelAnimationPlay = (payload: EventPayloads[EntityModelAnimationEvent.PLAY]) => {
    if (this._mirrorEntityStatePatch({
      i: payload.entityModelAnimation.entity.id!,
      ma: [{ n: payload.entityModelAnimation.name, p: true }],
    })) {
      return;
    }

    const entityModelAnimationSync = this._createOrGetQueuedEntityModelAnimationSync(payload.entityModelAnimation);
    entityModelAnimationSync.p = true;
    delete entityModelAnimationSync.pa;
    delete entityModelAnimationSync.r;
    delete entityModelAnimationSync.s;
  };

  private _onEntityModelAnimationRestart = (payload: EventPayloads[EntityModelAnimationEvent.RESTART]) => {
    if (this._mirrorEntityStatePatch({
      i: payload.entityModelAnimation.entity.id!,
      ma: [{ n: payload.entityModelAnimation.name, r: true }],
    })) {
      return;
    }

    const entityModelAnimationSync = this._createOrGetQueuedEntityModelAnimationSync(payload.entityModelAnimation);
    entityModelAnimationSync.r = true;
    delete entityModelAnimationSync.pa;
    delete entityModelAnimationSync.p;
    delete entityModelAnimationSync.s;
  };
  
  private _onEntityModelAnimationSetBlendMode = (payload: EventPayloads[EntityModelAnimationEvent.SET_BLEND_MODE]) => {
    if (this._mirrorEntityStatePatch({
      i: payload.entityModelAnimation.entity.id!,
      ma: [{ b: payload.blendMode, n: payload.entityModelAnimation.name }],
    })) {
      return;
    }

    const entityModelAnimationSync = this._createOrGetQueuedEntityModelAnimationSync(payload.entityModelAnimation);
    entityModelAnimationSync.b = payload.blendMode;
  };

  private _onEntityModelAnimationSetClampWhenFinished = (payload: EventPayloads[EntityModelAnimationEvent.SET_CLAMP_WHEN_FINISHED]) => {
    if (this._mirrorEntityStatePatch({
      i: payload.entityModelAnimation.entity.id!,
      ma: [{ c: payload.clampWhenFinished, n: payload.entityModelAnimation.name }],
    })) {
      return;
    }

    const entityModelAnimationSync = this._createOrGetQueuedEntityModelAnimationSync(payload.entityModelAnimation);
    entityModelAnimationSync.c = payload.clampWhenFinished;
  };

  private _onEntityModelAnimationSetFadesIn = (payload: EventPayloads[EntityModelAnimationEvent.SET_FADES_IN]) => {
    if (this._mirrorEntityStatePatch({
      i: payload.entityModelAnimation.entity.id!,
      ma: [{ fi: payload.fadesIn, n: payload.entityModelAnimation.name }],
    })) {
      return;
    }

    const entityModelAnimationSync = this._createOrGetQueuedEntityModelAnimationSync(payload.entityModelAnimation);
    entityModelAnimationSync.fi = payload.fadesIn;
  };

  private _onEntityModelAnimationSetFadesOut = (payload: EventPayloads[EntityModelAnimationEvent.SET_FADES_OUT]) => {
    if (this._mirrorEntityStatePatch({
      i: payload.entityModelAnimation.entity.id!,
      ma: [{ fo: payload.fadesOut, n: payload.entityModelAnimation.name }],
    })) {
      return;
    }

    const entityModelAnimationSync = this._createOrGetQueuedEntityModelAnimationSync(payload.entityModelAnimation);
    entityModelAnimationSync.fo = payload.fadesOut;
  };

  private _onEntityModelAnimationSetLoopMode = (payload: EventPayloads[EntityModelAnimationEvent.SET_LOOP_MODE]) => {
    if (this._mirrorEntityStatePatch({
      i: payload.entityModelAnimation.entity.id!,
      ma: [{ l: payload.loopMode, n: payload.entityModelAnimation.name }],
    })) {
      return;
    }

    const entityModelAnimationSync = this._createOrGetQueuedEntityModelAnimationSync(payload.entityModelAnimation);
    entityModelAnimationSync.l = payload.loopMode;
  };

  private _onEntityModelAnimationSetPlaybackRate = (payload: EventPayloads[EntityModelAnimationEvent.SET_PLAYBACK_RATE]) => {
    if (this._mirrorEntityStatePatch({
      i: payload.entityModelAnimation.entity.id!,
      ma: [{ n: payload.entityModelAnimation.name, pr: payload.playbackRate }],
    })) {
      return;
    }

    const entityModelAnimationSync = this._createOrGetQueuedEntityModelAnimationSync(payload.entityModelAnimation);
    entityModelAnimationSync.pr = payload.playbackRate;
  };
  
  private _onEntityModelAnimationSetWeight = (payload: EventPayloads[EntityModelAnimationEvent.SET_WEIGHT]) => {
    if (this._mirrorEntityStatePatch({
      i: payload.entityModelAnimation.entity.id!,
      ma: [{ n: payload.entityModelAnimation.name, w: payload.weight }],
    })) {
      return;
    }

    const entityModelAnimationSync = this._createOrGetQueuedEntityModelAnimationSync(payload.entityModelAnimation);
    entityModelAnimationSync.w = payload.weight;
  };

  private _onEntityModelAnimationStop = (payload: EventPayloads[EntityModelAnimationEvent.STOP]) => {
    if (this._mirrorEntityStatePatch({
      i: payload.entityModelAnimation.entity.id!,
      ma: [{ n: payload.entityModelAnimation.name, s: true }],
    })) {
      return;
    }

    const entityModelAnimationSync = this._createOrGetQueuedEntityModelAnimationSync(payload.entityModelAnimation);
    entityModelAnimationSync.s = true;
    delete entityModelAnimationSync.p;
    delete entityModelAnimationSync.pa;
    delete entityModelAnimationSync.r;
  };

  private _onEntityModelNodeOverrideSetEmissiveColor = (payload: EventPayloads[EntityModelNodeOverrideEvent.SET_EMISSIVE_COLOR]) => {
    if (this._mirrorEntityStatePatch({
      i: payload.entityModelNodeOverride.entity.id!,
      mo: [{
        ec: payload.emissiveColor ? Serializer.serializeRgbColor(payload.emissiveColor) : undefined,
        n: payload.entityModelNodeOverride.nameMatch,
      }],
    })) {
      return;
    }

    const entityModelNodeOverrideSync = this._createOrGetQueuedEntityModelNodeOverrideSync(payload.entityModelNodeOverride);
    entityModelNodeOverrideSync.ec = payload.emissiveColor ? Serializer.serializeRgbColor(payload.emissiveColor) : undefined;
    delete entityModelNodeOverrideSync.rm;
  };

  private _onEntityModelNodeOverrideSetEmissiveIntensity = (payload: EventPayloads[EntityModelNodeOverrideEvent.SET_EMISSIVE_INTENSITY]) => {
    if (this._mirrorEntityStatePatch({
      i: payload.entityModelNodeOverride.entity.id!,
      mo: [{ ei: payload.emissiveIntensity, n: payload.entityModelNodeOverride.nameMatch }],
    })) {
      return;
    }

    const entityModelNodeOverrideSync = this._createOrGetQueuedEntityModelNodeOverrideSync(payload.entityModelNodeOverride);
    entityModelNodeOverrideSync.ei = payload.emissiveIntensity;
    delete entityModelNodeOverrideSync.rm;
  };

  private _onEntityModelNodeOverrideSetHidden = (payload: EventPayloads[EntityModelNodeOverrideEvent.SET_HIDDEN]) => {
    if (this._mirrorEntityStatePatch({
      i: payload.entityModelNodeOverride.entity.id!,
      mo: [{ h: payload.hidden, n: payload.entityModelNodeOverride.nameMatch }],
    })) {
      return;
    }

    const entityModelNodeOverrideSync = this._createOrGetQueuedEntityModelNodeOverrideSync(payload.entityModelNodeOverride);
    entityModelNodeOverrideSync.h = payload.hidden;
    delete entityModelNodeOverrideSync.rm;
  };

  private _onEntityModelNodeOverrideSetLocalPosition = (payload: EventPayloads[EntityModelNodeOverrideEvent.SET_LOCAL_POSITION]) => {
    if (this._mirrorEntityStatePatch({
      i: payload.entityModelNodeOverride.entity.id!,
      mo: [{
        n: payload.entityModelNodeOverride.nameMatch,
        p: payload.localPosition ? Serializer.serializeVector(payload.localPosition) : undefined,
      }],
    })) {
      return;
    }

    const entityModelNodeOverrideSync = this._createOrGetQueuedEntityModelNodeOverrideSync(payload.entityModelNodeOverride);
    entityModelNodeOverrideSync.p = payload.localPosition ? Serializer.serializeVector(payload.localPosition) : undefined;
    delete entityModelNodeOverrideSync.rm;
  };

  private _onEntityModelNodeOverrideSetLocalPositionInterpolationMs = (payload: EventPayloads[EntityModelNodeOverrideEvent.SET_LOCAL_POSITION_INTERPOLATION_MS]) => {
    if (this._mirrorEntityStatePatch({
      i: payload.entityModelNodeOverride.entity.id!,
      mo: [{ n: payload.entityModelNodeOverride.nameMatch, pi: payload.interpolationMs }],
    })) {
      return;
    }

    const entityModelNodeOverrideSync = this._createOrGetQueuedEntityModelNodeOverrideSync(payload.entityModelNodeOverride);
    entityModelNodeOverrideSync.pi = payload.interpolationMs;
    delete entityModelNodeOverrideSync.rm;
  };

  private _onEntityModelNodeOverrideSetLocalRotation = (payload: EventPayloads[EntityModelNodeOverrideEvent.SET_LOCAL_ROTATION]) => {
    if (this._mirrorEntityStatePatch({
      i: payload.entityModelNodeOverride.entity.id!,
      mo: [{
        n: payload.entityModelNodeOverride.nameMatch,
        r: payload.localRotation ? Serializer.serializeQuaternion(payload.localRotation) : undefined,
      }],
    })) {
      return;
    }

    const entityModelNodeOverrideSync = this._createOrGetQueuedEntityModelNodeOverrideSync(payload.entityModelNodeOverride);
    entityModelNodeOverrideSync.r = payload.localRotation ? Serializer.serializeQuaternion(payload.localRotation) : undefined;
    delete entityModelNodeOverrideSync.rm;
  };

  private _onEntityModelNodeOverrideSetLocalRotationInterpolationMs = (payload: EventPayloads[EntityModelNodeOverrideEvent.SET_LOCAL_ROTATION_INTERPOLATION_MS]) => {
    if (this._mirrorEntityStatePatch({
      i: payload.entityModelNodeOverride.entity.id!,
      mo: [{ n: payload.entityModelNodeOverride.nameMatch, ri: payload.interpolationMs }],
    })) {
      return;
    }

    const entityModelNodeOverrideSync = this._createOrGetQueuedEntityModelNodeOverrideSync(payload.entityModelNodeOverride);
    entityModelNodeOverrideSync.ri = payload.interpolationMs;
    delete entityModelNodeOverrideSync.rm;
  };

  private _onEntityModelNodeOverrideSetLocalScale = (payload: EventPayloads[EntityModelNodeOverrideEvent.SET_LOCAL_SCALE]) => {
    if (this._mirrorEntityStatePatch({
      i: payload.entityModelNodeOverride.entity.id!,
      mo: [{
        n: payload.entityModelNodeOverride.nameMatch,
        s: payload.localScale ? Serializer.serializeVector(payload.localScale) : undefined,
      }],
    })) {
      return;
    }

    const entityModelNodeOverrideSync = this._createOrGetQueuedEntityModelNodeOverrideSync(payload.entityModelNodeOverride);
    entityModelNodeOverrideSync.s = payload.localScale ? Serializer.serializeVector(payload.localScale) : undefined;
    delete entityModelNodeOverrideSync.rm;
  };

  private _onEntityModelNodeOverrideSetLocalScaleInterpolationMs = (payload: EventPayloads[EntityModelNodeOverrideEvent.SET_LOCAL_SCALE_INTERPOLATION_MS]) => {
    if (this._mirrorEntityStatePatch({
      i: payload.entityModelNodeOverride.entity.id!,
      mo: [{ n: payload.entityModelNodeOverride.nameMatch, si: payload.interpolationMs }],
    })) {
      return;
    }

    const entityModelNodeOverrideSync = this._createOrGetQueuedEntityModelNodeOverrideSync(payload.entityModelNodeOverride);
    entityModelNodeOverrideSync.si = payload.interpolationMs;
    delete entityModelNodeOverrideSync.rm;
  };

  private _onParticleEmitterBurst = (payload: EventPayloads[ParticleEmitterEvent.BURST]) => {
    if (this._mirrorParticleEmitterStatePatch({
      b: payload.count,
      i: payload.particleEmitter.id!,
    })) {
      return;
    }

    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.b = payload.count;
  };

  private _onParticleEmitterDespawn = (payload: EventPayloads[ParticleEmitterEvent.DESPAWN]) => {
    const particleEmitterId = payload.particleEmitter.id!;

    if (this._mirrorParticleEmitterStatePatch({
      i: particleEmitterId,
      rm: true,
    })) {
      return;
    }

    this._markPerPlayerParticleEmitterSyncsRemoved(particleEmitterId);
    this._markParticleEmitterSyncRemoved(this._createOrGetQueuedParticleEmitterSyncById(particleEmitterId));
    this._removeParticleEmitterSpatialInterest(particleEmitterId);
  };

  private _onParticleEmitterSetAlphaTest = (payload: EventPayloads[ParticleEmitterEvent.SET_ALPHA_TEST]) => {
    if (this._mirrorParticleEmitterStatePatch({
      at: payload.alphaTest,
      i: payload.particleEmitter.id!,
    })) {
      return;
    }

    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.at = payload.alphaTest;
  };

  private _onParticleEmitterSetAttachedToEntity = (payload: EventPayloads[ParticleEmitterEvent.SET_ATTACHED_TO_ENTITY]) => {
    if (this._mirrorParticleEmitterStatePatch({
      e: payload.entity ? payload.entity.id : undefined,
      i: payload.particleEmitter.id!,
      p: payload.entity ? undefined : payload.particleEmitter.position ? Serializer.serializeVector(payload.particleEmitter.position) : undefined,
    })) {
      return;
    }

    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.e = payload.entity ? payload.entity.id : undefined;
    particleEmitterSync.p = payload.entity ? undefined : (
      payload.particleEmitter.position ? Serializer.serializeVector(payload.particleEmitter.position) : undefined
    );
    this._updateParticleEmitterSpatialInterest(payload.particleEmitter);
  };

  private _onParticleEmitterSetAttachedToEntityNodeName = (payload: EventPayloads[ParticleEmitterEvent.SET_ATTACHED_TO_ENTITY_NODE_NAME]) => {
    if (this._mirrorParticleEmitterStatePatch({
      en: payload.attachedToEntityNodeName,
      i: payload.particleEmitter.id!,
    })) {
      return;
    }

    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.en = payload.attachedToEntityNodeName;
  };

  private _onParticleEmitterSetColorEnd = (payload: EventPayloads[ParticleEmitterEvent.SET_COLOR_END]) => {
    if (this._mirrorParticleEmitterStatePatch({
      ce: payload.colorEnd ? Serializer.serializeRgbColor(payload.colorEnd) : undefined,
      i: payload.particleEmitter.id!,
    })) {
      return;
    }

    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.ce = payload.colorEnd ? Serializer.serializeRgbColor(payload.colorEnd) : undefined;
  };

  private _onParticleEmitterSetColorEndVariance = (payload: EventPayloads[ParticleEmitterEvent.SET_COLOR_END_VARIANCE]) => {
    if (this._mirrorParticleEmitterStatePatch({
      cev: payload.colorEndVariance ? Serializer.serializeRgbColor(payload.colorEndVariance) : undefined,
      i: payload.particleEmitter.id!,
    })) {
      return;
    }

    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.cev = payload.colorEndVariance ? Serializer.serializeRgbColor(payload.colorEndVariance) : undefined;
  };

  private _onParticleEmitterSetColorIntensityEnd = (payload: EventPayloads[ParticleEmitterEvent.SET_COLOR_INTENSITY_END]) => {
    if (this._mirrorParticleEmitterStatePatch({
      cie: payload.colorIntensityEnd,
      i: payload.particleEmitter.id!,
    })) {
      return;
    }

    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.cie = payload.colorIntensityEnd;
  };

  private _onParticleEmitterSetColorIntensityEndVariance = (payload: EventPayloads[ParticleEmitterEvent.SET_COLOR_INTENSITY_END_VARIANCE]) => {
    if (this._mirrorParticleEmitterStatePatch({
      ciev: payload.colorIntensityEndVariance,
      i: payload.particleEmitter.id!,
    })) {
      return;
    }

    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.ciev = payload.colorIntensityEndVariance;
  };

  private _onParticleEmitterSetColorIntensityStart = (payload: EventPayloads[ParticleEmitterEvent.SET_COLOR_INTENSITY_START]) => {
    if (this._mirrorParticleEmitterStatePatch({
      cis: payload.colorIntensityStart,
      i: payload.particleEmitter.id!,
    })) {
      return;
    }

    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.cis = payload.colorIntensityStart;
  };

  private _onParticleEmitterSetColorIntensityStartVariance = (payload: EventPayloads[ParticleEmitterEvent.SET_COLOR_INTENSITY_START_VARIANCE]) => {
    if (this._mirrorParticleEmitterStatePatch({
      cisv: payload.colorIntensityStartVariance,
      i: payload.particleEmitter.id!,
    })) {
      return;
    }

    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.cisv = payload.colorIntensityStartVariance;
  };

  private _onParticleEmitterSetColorStart = (payload: EventPayloads[ParticleEmitterEvent.SET_COLOR_START]) => {
    if (this._mirrorParticleEmitterStatePatch({
      cs: payload.colorStart ? Serializer.serializeRgbColor(payload.colorStart) : undefined,
      i: payload.particleEmitter.id!,
    })) {
      return;
    }

    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.cs = payload.colorStart ? Serializer.serializeRgbColor(payload.colorStart) : undefined;
  };

  private _onParticleEmitterSetColorStartVariance = (payload: EventPayloads[ParticleEmitterEvent.SET_COLOR_START_VARIANCE]) => {
    if (this._mirrorParticleEmitterStatePatch({
      csv: payload.colorStartVariance ? Serializer.serializeRgbColor(payload.colorStartVariance) : undefined,
      i: payload.particleEmitter.id!,
    })) {
      return;
    }

    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.csv = payload.colorStartVariance ? Serializer.serializeRgbColor(payload.colorStartVariance) : undefined;
  };

  private _onParticleEmitterSetGravity = (payload: EventPayloads[ParticleEmitterEvent.SET_GRAVITY]) => {
    if (this._mirrorParticleEmitterStatePatch({
      g: payload.gravity ? Serializer.serializeVector(payload.gravity) : undefined,
      i: payload.particleEmitter.id!,
    })) {
      return;
    }

    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.g = payload.gravity ? Serializer.serializeVector(payload.gravity) : undefined;
  };

  private _onParticleEmitterSetLifetime = (payload: EventPayloads[ParticleEmitterEvent.SET_LIFETIME]) => {
    if (this._mirrorParticleEmitterStatePatch({
      i: payload.particleEmitter.id!,
      l: payload.lifetime,
    })) {
      return;
    }

    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.l = payload.lifetime;
  };

  private _onParticleEmitterSetLifetimeVariance = (payload: EventPayloads[ParticleEmitterEvent.SET_LIFETIME_VARIANCE]) => {
    if (this._mirrorParticleEmitterStatePatch({
      i: payload.particleEmitter.id!,
      lv: payload.lifetimeVariance,
    })) {
      return;
    }

    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.lv = payload.lifetimeVariance;
  };

  private _onParticleEmitterSetMaxParticles = (payload: EventPayloads[ParticleEmitterEvent.SET_MAX_PARTICLES]) => {
    if (this._mirrorParticleEmitterStatePatch({
      i: payload.particleEmitter.id!,
      mp: payload.maxParticles,
    })) {
      return;
    }

    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.mp = payload.maxParticles;
  };

  private _onParticleEmitterSetOffset = (payload: EventPayloads[ParticleEmitterEvent.SET_OFFSET]) => {
    if (this._mirrorParticleEmitterStatePatch({
      i: payload.particleEmitter.id!,
      o: payload.offset ? Serializer.serializeVector(payload.offset) : undefined,
    })) {
      return;
    }

    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.o = payload.offset ? Serializer.serializeVector(payload.offset) : undefined;
  };

  private _onParticleEmitterSetOrientation = (payload: EventPayloads[ParticleEmitterEvent.SET_ORIENTATION]) => {
    if (this._mirrorParticleEmitterStatePatch({
      i: payload.particleEmitter.id!,
      or: Serializer.serializeParticleEmitterOrientation(payload.orientation),
    })) {
      return;
    }

    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.or = Serializer.serializeParticleEmitterOrientation(payload.orientation);
  };

  private _onParticleEmitterSetOrientationFixedRotation = (
    payload: EventPayloads[ParticleEmitterEvent.SET_ORIENTATION_FIXED_ROTATION],
  ) => {
    if (this._mirrorParticleEmitterStatePatch({
      i: payload.particleEmitter.id!,
      ofr: payload.orientationFixedRotation ? Serializer.serializeVector(payload.orientationFixedRotation) : undefined,
    })) {
      return;
    }

    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.ofr = payload.orientationFixedRotation
      ? Serializer.serializeVector(payload.orientationFixedRotation)
      : undefined;
  };

  private _onParticleEmitterSetOpacityEnd = (payload: EventPayloads[ParticleEmitterEvent.SET_OPACITY_END]) => {
    if (this._mirrorParticleEmitterStatePatch({
      i: payload.particleEmitter.id!,
      oe: payload.opacityEnd,
    })) {
      return;
    }

    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.oe = payload.opacityEnd;
  };

  private _onParticleEmitterSetOpacityEndVariance = (payload: EventPayloads[ParticleEmitterEvent.SET_OPACITY_END_VARIANCE]) => {
    if (this._mirrorParticleEmitterStatePatch({
      i: payload.particleEmitter.id!,
      oev: payload.opacityEndVariance,
    })) {
      return;
    }

    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.oev = payload.opacityEndVariance;
  };

  private _onParticleEmitterSetOpacityStart = (payload: EventPayloads[ParticleEmitterEvent.SET_OPACITY_START]) => {
    if (this._mirrorParticleEmitterStatePatch({
      i: payload.particleEmitter.id!,
      os: payload.opacityStart,
    })) {
      return;
    }

    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.os = payload.opacityStart;
  };

  private _onParticleEmitterSetOpacityStartVariance = (payload: EventPayloads[ParticleEmitterEvent.SET_OPACITY_START_VARIANCE]) => {
    if (this._mirrorParticleEmitterStatePatch({
      i: payload.particleEmitter.id!,
      osv: payload.opacityStartVariance,
    })) {
      return;
    }

    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.osv = payload.opacityStartVariance;
  };

  private _onParticleEmitterSetPaused = (payload: EventPayloads[ParticleEmitterEvent.SET_PAUSED]) => {
    if (this._mirrorParticleEmitterStatePatch({
      i: payload.particleEmitter.id!,
      pa: payload.paused,
    })) {
      return;
    }

    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.pa = payload.paused;
  };

  private _onParticleEmitterSetPosition = (payload: EventPayloads[ParticleEmitterEvent.SET_POSITION]) => {
    if (this._mirrorParticleEmitterStatePatch({
      e: payload.position ? undefined : payload.particleEmitter.attachedToEntity?.id,
      en: payload.position ? undefined : payload.particleEmitter.attachedToEntityNodeName,
      i: payload.particleEmitter.id!,
      p: payload.position ? Serializer.serializeVector(payload.position) : undefined,
    })) {
      return;
    }

    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.p = payload.position ? Serializer.serializeVector(payload.position) : undefined;
    particleEmitterSync.e = payload.position ? undefined : particleEmitterSync.e;
    particleEmitterSync.en = payload.position ? undefined : particleEmitterSync.en;
    this._updateParticleEmitterSpatialInterest(payload.particleEmitter);
  };

  private _onParticleEmitterSetPositionVariance = (payload: EventPayloads[ParticleEmitterEvent.SET_POSITION_VARIANCE]) => {
    if (this._mirrorParticleEmitterStatePatch({
      i: payload.particleEmitter.id!,
      pv: payload.positionVariance ? Serializer.serializeVector(payload.positionVariance) : undefined,
    })) {
      return;
    }

    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.pv = payload.positionVariance ? Serializer.serializeVector(payload.positionVariance) : undefined;
  };

  private _onParticleEmitterSetRate = (payload: EventPayloads[ParticleEmitterEvent.SET_RATE]) => {
    if (this._mirrorParticleEmitterStatePatch({
      i: payload.particleEmitter.id!,
      r: payload.rate,
    })) {
      return;
    }

    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.r = payload.rate;
  };

  private _onParticleEmitterSetRateVariance = (payload: EventPayloads[ParticleEmitterEvent.SET_RATE_VARIANCE]) => {
    if (this._mirrorParticleEmitterStatePatch({
      i: payload.particleEmitter.id!,
      rv: payload.rateVariance,
    })) {
      return;
    }

    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.rv = payload.rateVariance;
  };

  private _onParticleEmitterSetSizeEnd = (payload: EventPayloads[ParticleEmitterEvent.SET_SIZE_END]) => {
    if (this._mirrorParticleEmitterStatePatch({
      i: payload.particleEmitter.id!,
      se: payload.sizeEnd,
    })) {
      return;
    }

    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.se = payload.sizeEnd;
  };

  private _onParticleEmitterSetSizeEndVariance = (payload: EventPayloads[ParticleEmitterEvent.SET_SIZE_END_VARIANCE]) => {
    if (this._mirrorParticleEmitterStatePatch({
      i: payload.particleEmitter.id!,
      sev: payload.sizeEndVariance,
    })) {
      return;
    }

    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.sev = payload.sizeEndVariance;
  };

  private _onParticleEmitterSetSizeStart = (payload: EventPayloads[ParticleEmitterEvent.SET_SIZE_START]) => {
    if (this._mirrorParticleEmitterStatePatch({
      i: payload.particleEmitter.id!,
      ss: payload.sizeStart,
    })) {
      return;
    }

    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.ss = payload.sizeStart;
  };

  private _onParticleEmitterSetSizeStartVariance = (payload: EventPayloads[ParticleEmitterEvent.SET_SIZE_START_VARIANCE]) => {
    if (this._mirrorParticleEmitterStatePatch({
      i: payload.particleEmitter.id!,
      ssv: payload.sizeStartVariance,
    })) {
      return;
    }

    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.ssv = payload.sizeStartVariance;
  };

  private _onParticleEmitterSetTextureUri = (payload: EventPayloads[ParticleEmitterEvent.SET_TEXTURE_URI]) => {
    if (this._mirrorParticleEmitterStatePatch({
      i: payload.particleEmitter.id!,
      tu: payload.textureUri,
    })) {
      return;
    }

    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.tu = payload.textureUri;
  };

  private _onParticleEmitterSetTransparent = (payload: EventPayloads[ParticleEmitterEvent.SET_TRANSPARENT]) => {
    if (this._mirrorParticleEmitterStatePatch({
      i: payload.particleEmitter.id!,
      t: payload.transparent,
    })) {
      return;
    }

    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.t = payload.transparent;
  };

  private _onParticleEmitterSetVelocity = (payload: EventPayloads[ParticleEmitterEvent.SET_VELOCITY]) => {
    if (this._mirrorParticleEmitterStatePatch({
      i: payload.particleEmitter.id!,
      v: payload.velocity ? Serializer.serializeVector(payload.velocity) : undefined,
    })) {
      return;
    }

    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.v = payload.velocity ? Serializer.serializeVector(payload.velocity) : undefined;
  };

  private _onParticleEmitterSetVelocityVariance = (payload: EventPayloads[ParticleEmitterEvent.SET_VELOCITY_VARIANCE]) => {
    if (this._mirrorParticleEmitterStatePatch({
      i: payload.particleEmitter.id!,
      vv: payload.velocityVariance ? Serializer.serializeVector(payload.velocityVariance) : undefined,
    })) {
      return;
    }

    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.vv = payload.velocityVariance ? Serializer.serializeVector(payload.velocityVariance) : undefined;
  };

  private _onParticleEmitterSpawn = (payload: EventPayloads[ParticleEmitterEvent.SPAWN]) => {
    if (this._mirrorParticleEmitterStatePatch(payload.particleEmitter.serialize())) {
      return;
    }

    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    Object.assign(particleEmitterSync, payload.particleEmitter.serialize());
    this._updateParticleEmitterSpatialInterest(payload.particleEmitter);
  };
  
  private _onPlayerCameraFaceEntity = (payload: EventPayloads[PlayerCameraEvent.FACE_ENTITY]) => {
    const playerCameraSync = this._createOrGetQueuedCameraSync(payload.playerCamera.player);
    playerCameraSync.pl = Serializer.serializeVector(payload.entity.position);
    delete playerCameraSync.et; // stop targeting
    delete playerCameraSync.pt;
  };

  private _onPlayerCameraFacePosition = (payload: EventPayloads[PlayerCameraEvent.FACE_POSITION]) => {
    const playerCameraSync = this._createOrGetQueuedCameraSync(payload.playerCamera.player);
    playerCameraSync.pl = payload.position ? Serializer.serializeVector(payload.position) : undefined;
    delete playerCameraSync.et; // stop targeting
    delete playerCameraSync.pt;
  };

  private _onPlayerCameraSetAttachedToEntity = (payload: EventPayloads[PlayerCameraEvent.SET_ATTACHED_TO_ENTITY]) => {
    const playerCameraSync = this._createOrGetQueuedCameraSync(payload.playerCamera.player);
    playerCameraSync.e = payload.entity.id;
    delete playerCameraSync.p;
    this._syncPlayerCameraAttachedEntityModel(payload.playerCamera);
  };

  private _onPlayerCameraSetAttachedToPosition = (payload: EventPayloads[PlayerCameraEvent.SET_ATTACHED_TO_POSITION]) => {
    const playerCameraSync = this._createOrGetQueuedCameraSync(payload.playerCamera.player);
    playerCameraSync.p = payload.position ? Serializer.serializeVector(payload.position) : undefined;
    delete playerCameraSync.e;
  };

  private _onPlayerCameraSetCollidesWithBlocks = (payload: EventPayloads[PlayerCameraEvent.SET_COLLIDES_WITH_BLOCKS]) => {
    const playerCameraSync = this._createOrGetQueuedCameraSync(payload.playerCamera.player);
    playerCameraSync.cb = payload.collidesWithBlocks;
  };

  private _onPlayerCameraSetFilmOffset = (payload: EventPayloads[PlayerCameraEvent.SET_FILM_OFFSET]) => {
    const playerCameraSync = this._createOrGetQueuedCameraSync(payload.playerCamera.player);
    playerCameraSync.fo = payload.filmOffset;
  };

  private _onPlayerCameraSetForwardOffset = (payload: EventPayloads[PlayerCameraEvent.SET_FORWARD_OFFSET]) => {
    const playerCameraSync = this._createOrGetQueuedCameraSync(payload.playerCamera.player);
    playerCameraSync.ffo = payload.forwardOffset;
  };

  private _onPlayerCameraSetFov = (payload: EventPayloads[PlayerCameraEvent.SET_FOV]) => {
    const playerCameraSync = this._createOrGetQueuedCameraSync(payload.playerCamera.player);
    playerCameraSync.fv = payload.fov;
  };

  private _onPlayerCameraSetMode = (payload: EventPayloads[PlayerCameraEvent.SET_MODE]) => {
    const playerCameraSync = this._createOrGetQueuedCameraSync(payload.playerCamera.player);
    playerCameraSync.m = payload.mode;
    this._syncPlayerCameraAttachedEntityModel(payload.playerCamera);
  };

  private _onPlayerCameraSetOffset = (payload: EventPayloads[PlayerCameraEvent.SET_OFFSET]) => {
    const playerCameraSync = this._createOrGetQueuedCameraSync(payload.playerCamera.player);
    playerCameraSync.o = payload.offset ? Serializer.serializeVector(payload.offset) : undefined;
  };

  private _onPlayerCameraSetShoulderAngle = (payload: EventPayloads[PlayerCameraEvent.SET_SHOULDER_ANGLE]) => {
    const playerCameraSync = this._createOrGetQueuedCameraSync(payload.playerCamera.player);
    playerCameraSync.sa = payload.shoulderAngle;
  };
  
  private _onPlayerCameraSetTargetEntity = (payload: EventPayloads[PlayerCameraEvent.SET_TARGET_ENTITY]) => {
    const playerCameraSync = this._createOrGetQueuedCameraSync(payload.playerCamera.player);
    playerCameraSync.et = payload.entity ? payload.entity.id : undefined; // keys set undefined convert to null by msgpack
    delete playerCameraSync.pl;
    delete playerCameraSync.pt;
  };

  private _onPlayerCameraSetTargetPosition = (payload: EventPayloads[PlayerCameraEvent.SET_TARGET_POSITION]) => {
    const playerCameraSync = this._createOrGetQueuedCameraSync(payload.playerCamera.player);
    playerCameraSync.pt = payload.position ? Serializer.serializeVector(payload.position) : undefined;
    delete playerCameraSync.et;
    delete playerCameraSync.pl;
  };
  
  private _onPlayerCameraSetZoom = (payload: EventPayloads[PlayerCameraEvent.SET_ZOOM]) => {
    const playerCameraSync = this._createOrGetQueuedCameraSync(payload.playerCamera.player);
    playerCameraSync.z = payload.zoom;
  };

  private _onPlayerCameraSetViewModel = (payload: EventPayloads[PlayerCameraEvent.SET_VIEW_MODEL]) => {
    this._syncPlayerCameraAttachedEntityModel(payload.playerCamera);
  };

  private _onPlayerCameraSetViewModelHiddenNodes = (payload: EventPayloads[PlayerCameraEvent.SET_VIEW_MODEL_HIDDEN_NODES]) => {
    const playerCameraSync = this._createOrGetQueuedCameraSync(payload.playerCamera.player);
    playerCameraSync.h = Array.from(payload.viewModelHiddenNodes);
  };

  private _onPlayerCameraSetViewModelPitchesWithCamera = (payload: EventPayloads[PlayerCameraEvent.SET_VIEW_MODEL_PITCHES_WITH_CAMERA]) => {
    const playerCameraSync = this._createOrGetQueuedCameraSync(payload.playerCamera.player);
    playerCameraSync.mp = payload.viewModelPitchesWithCamera;
  };

  private _onPlayerCameraSetViewModelShownNodes = (payload: EventPayloads[PlayerCameraEvent.SET_VIEW_MODEL_SHOWN_NODES]) => {
    const playerCameraSync = this._createOrGetQueuedCameraSync(payload.playerCamera.player);
    playerCameraSync.s = Array.from(payload.viewModelShownNodes);
  };

  private _onPlayerCameraSetViewModelYawsWithCamera = (payload: EventPayloads[PlayerCameraEvent.SET_VIEW_MODEL_YAWS_WITH_CAMERA]) => {
    const playerCameraSync = this._createOrGetQueuedCameraSync(payload.playerCamera.player);
    playerCameraSync.my = payload.viewModelYawsWithCamera;
  };

  private _onPlayerJoinedWorld = (payload: EventPayloads[PlayerEvent.JOINED_WORLD]) => {
    const { player } = payload;
    const hostOwnsDerivedState = WorldHostManager.instance.client.ownsDerivedState(this._world);
    this._lastSentInputAcknowledgementByPlayer.delete(player);
    this._chunkInterestStateByPlayer.set(player, { needsRefresh: true });
    this._loadedEntityIdsByPlayer.set(player, new Set());
    this._loadedChunkKeysByPlayer.set(player, new Set());
    this._loadedParticleEmitterIdsByPlayer.set(player, new Set());
    this._loadedSceneUIIdsByPlayer.set(player, new Set());

    // Order doesn't matter here - synchronize() handles send order.
    // Use _assignUndefined to avoid overwriting properties already set by other event handlers.

    // Sync Audio
    if (!hostOwnsDerivedState) {
      for (const audio of this._world.audioManager.getAllAudios()) {
        const playerAudioSync = this._createOrGetQueuedAudioSync(audio, player);
        this._assignUndefined(playerAudioSync, audio.serialize());
      }
    }

    // Sync Block Types
    if (!hostOwnsDerivedState) {
      for (const blockType of this._world.blockTypeRegistry.getAllBlockTypes()) {
        const playerBlockTypeSync = this._createOrGetQueuedBlockTypeSync(blockType, player);
        this._assignUndefined(playerBlockTypeSync, blockType.serialize());
      }
    }

    // Sync Camera
    const playerCameraSync = this._createOrGetQueuedCameraSync(player);
    this._assignUndefined(playerCameraSync, player.camera.serialize());

    // Sync owner-only default block edit prediction config
    this._assignUndefined(
      this._createOrGetQueuedBlockEditPredictionConfigSync(player),
      this._serializeDefaultBlockEditPredictionConfig(player),
    );

    const playerEntity = this._world.entityManager.getPlayerEntitiesByPlayer(player)[0];
    if (player.camera.attachedToEntity === undefined && playerEntity) {
      player.camera.setAttachedToEntity(playerEntity);
    }

    if (hostOwnsDerivedState && playerEntity) {
      const playerEntitySync = this._createOrGetQueuedEntitySync(playerEntity, player);
      this._queuePlayerEntityOwnerPredictionState(playerEntitySync, playerEntity);
    }

    this._syncPlayerCameraAttachedEntityModel(player.camera);

    // Sync Players
    if (!hostOwnsDerivedState) {
      for (const otherPlayer of PlayerManager.instance.getConnectedPlayers()) {
        const playerPlayerSync = this._createOrGetQueuedPlayerSync(otherPlayer, player);
        this._assignUndefined(playerPlayerSync, otherPlayer.serialize());
      }
    }

    // Sync World
    if (!hostOwnsDerivedState) {
      const playerWorldSync = this._createOrGetQueuedWorldSync(this._world, player);
      this._assignUndefined(playerWorldSync, this._world.serialize());
    }

    // Notify everyone of the new player
    if (!hostOwnsDerivedState) {
      const playerSync = this._createOrGetQueuedPlayerSync(player);
      this._assignUndefined(playerSync, player.serialize());
      this._refreshPlayerChunkInterest(player);
      this._refreshPlayerSpatialInterest(player);
    }
  };

  private _onPlayerLeftWorld = (payload: EventPayloads[PlayerEvent.LEFT_WORLD]) => {
    this._lastSentInputAcknowledgementByPlayer.delete(payload.player);
    this._chunkInterestStateByPlayer.delete(payload.player);
    this._loadedEntityIdsByPlayer.delete(payload.player);
    this._loadedChunkKeysByPlayer.delete(payload.player);
    this._loadedParticleEmitterIdsByPlayer.delete(payload.player);
    this._loadedSceneUIIdsByPlayer.delete(payload.player);
    if (WorldHostManager.instance.client.ownsDerivedState(this._world)) {
      return;
    }

    const playerSync = this._createOrGetQueuedPlayerSync(payload.player);
    playerSync.rm = true;
  };

  private _onPlayerReconnectedWorld = (payload: EventPayloads[PlayerEvent.RECONNECTED_WORLD]) => {
    this._lastSentInputAcknowledgementByPlayer.delete(payload.player);
    this._chunkInterestStateByPlayer.delete(payload.player);
    this._loadedEntityIdsByPlayer.delete(payload.player);
    this._loadedChunkKeysByPlayer.delete(payload.player);
    this._loadedParticleEmitterIdsByPlayer.delete(payload.player);
    this._loadedSceneUIIdsByPlayer.delete(payload.player);
    this._onPlayerJoinedWorld(payload); // resync player state
  };

  private _onPlayerRequestNotificationPermission = (payload: EventPayloads[PlayerEvent.REQUEST_NOTIFICATION_PERMISSION]) => {
    const session = GatewayPlayerSessionManager.instance.getSessionByPlayer(payload.player);
    if (!session) {
      return;
    }

    WorldHostManager.instance.client.requestNotificationPermission(session);
  };

  private _onPlayerRequestSync = (payload: EventPayloads[PlayerEvent.REQUEST_SYNC]) => {
    const session = GatewayPlayerSessionManager.instance.getSessionByPlayer(payload.player);
    if (!session) {
      return;
    }

    WorldHostManager.instance.client.sendPacketsToPlayer(session, [
      protocol.createPacket(protocol.outboundPackets.syncResponsePacketDefinition, {
        r: payload.receivedAt,
        s: Date.now(),
        p: performance.now() - payload.receivedAtMs,
        n: this._world.loop.nextTickMs,
      }, this._world.loop.currentTick),
    ]);
  };

  private _onPlayerConfirmBlockEditPrediction = (
    payload: EventPayloads[PlayerEvent.CONFIRM_BLOCK_EDIT_PREDICTION],
  ) => {
    const resultsSync = this._createOrGetQueuedBlockEditPredictionResultsSync(payload.player);
    resultsSync.push({
      p: payload.predictionId,
      a: 'confirm',
    });
  };

  private _onPlayerDefaultBlockEditPredictionConfigUpdate = (
    payload: EventPayloads[PlayerEvent.DEFAULT_BLOCK_EDIT_PREDICTION_CONFIG_UPDATE],
  ) => {
    const configSync = this._createOrGetQueuedBlockEditPredictionConfigSync(payload.player);
    this._assignUndefined(configSync, this._serializeDefaultBlockEditPredictionConfig(payload.player));
    configSync.m = payload.config.maxDistance;
    configSync.i = payload.config.placeBlockTypeId;
    configSync.r = payload.config.placeBlockRotationIndex;
  };

  private _onPlayerRollbackBlockEditPrediction = (
    payload: EventPayloads[PlayerEvent.ROLLBACK_BLOCK_EDIT_PREDICTION],
  ) => {
    const resultsSync = this._createOrGetQueuedBlockEditPredictionResultsSync(payload.player);
    resultsSync.push({
      p: payload.predictionId,
      a: 'rollback',
    });
  };

  private _onPlayerUIAppend = (payload: EventPayloads[PlayerUIEvent.APPEND]) => {
    const playerUISync = this._createOrGetQueuedUISync(payload.playerUI.player);
    playerUISync.ua ??= [];
    playerUISync.ua.push(payload.htmlUri);
  };

  private _onPlayerUIFreezePointerLock = (payload: EventPayloads[PlayerUIEvent.FREEZE_POINTER_LOCK]) => {
    const playerUISync = this._createOrGetQueuedUISync(payload.playerUI.player);
    playerUISync.pf = payload.freeze;
  };

  private _onPlayerUILoad = (payload: EventPayloads[PlayerUIEvent.LOAD]) => {
    const playerUISync = this._createOrGetQueuedUISync(payload.playerUI.player);
    playerUISync.u = payload.htmlUri;
  };

  private _onPlayerUILockPointer = (payload: EventPayloads[PlayerUIEvent.LOCK_POINTER]) => {
    const playerUISync = this._createOrGetQueuedUISync(payload.playerUI.player);
    playerUISync.p = payload.lock;
  };

  private _onPlayerUISendData = (payload: EventPayloads[PlayerUIEvent.SEND_DATA]) => {
    const playerUIDatasSync = this._createOrGetQueuedUIDatasSync(payload.playerUI.player);
    playerUIDatasSync.push(payload.data);
  };

  private _onSceneUILoad = (payload: EventPayloads[SceneUIEvent.LOAD]) => {
    if (this._mirrorSceneUIStatePatch(payload.sceneUI.serialize())) {
      return;
    }

    const sceneUISync = this._createOrGetQueuedSceneUISync(payload.sceneUI);
    Object.assign(sceneUISync, payload.sceneUI.serialize());
    this._loadedSceneUIs.add(sceneUISync.i);
    this._updateSceneUISpatialInterest(payload.sceneUI);
  };

  private _onSceneUISetAttachedToEntity = (payload: EventPayloads[SceneUIEvent.SET_ATTACHED_TO_ENTITY]) => {
    if (this._mirrorSceneUIStatePatch({
      e: payload.entity ? payload.entity.id : undefined,
      i: payload.sceneUI.id!,
      p: payload.entity ? undefined : payload.sceneUI.position ? Serializer.serializeVector(payload.sceneUI.position) : undefined,
    })) {
      return;
    }

    const sceneUISync = this._createOrGetQueuedSceneUISync(payload.sceneUI);
    sceneUISync.e = payload.entity ? payload.entity.id : undefined;
    sceneUISync.p = payload.entity ? undefined : (
      payload.sceneUI.position ? Serializer.serializeVector(payload.sceneUI.position) : undefined
    );
    this._updateSceneUISpatialInterest(payload.sceneUI);
  };

  private _onSceneUISetOffset = (payload: EventPayloads[SceneUIEvent.SET_OFFSET]) => {
    if (this._mirrorSceneUIStatePatch({
      i: payload.sceneUI.id!,
      o: payload.offset ? Serializer.serializeVector(payload.offset) : undefined,
    })) {
      return;
    }

    const sceneUISync = this._createOrGetQueuedSceneUISync(payload.sceneUI);
    sceneUISync.o = payload.offset ? Serializer.serializeVector(payload.offset) : undefined;
  };

  private _onSceneUISetPosition = (payload: EventPayloads[SceneUIEvent.SET_POSITION]) => {
    if (this._mirrorSceneUIStatePatch({
      e: payload.position ? undefined : payload.sceneUI.attachedToEntity?.id,
      i: payload.sceneUI.id!,
      p: payload.position ? Serializer.serializeVector(payload.position) : undefined,
    })) {
      return;
    }

    const sceneUISync = this._createOrGetQueuedSceneUISync(payload.sceneUI);
    sceneUISync.p = payload.position ? Serializer.serializeVector(payload.position) : undefined;
    sceneUISync.e = payload.position ? undefined : sceneUISync.e;
    this._updateSceneUISpatialInterest(payload.sceneUI);
  };

  private _onSceneUISetState = (payload: EventPayloads[SceneUIEvent.SET_STATE]) => {
    if (this._mirrorSceneUIStatePatch({
      i: payload.sceneUI.id!,
      s: payload.state,
    })) {
      return;
    }

    const sceneUISync = this._createOrGetQueuedSceneUISync(payload.sceneUI);
    sceneUISync.s = payload.state;
  };

  private _onSceneUISetViewDistance = (payload: EventPayloads[SceneUIEvent.SET_VIEW_DISTANCE]) => {
    if (this._mirrorSceneUIStatePatch({
      i: payload.sceneUI.id!,
      v: payload.viewDistance,
    })) {
      return;
    }

    const sceneUISync = this._createOrGetQueuedSceneUISync(payload.sceneUI);
    sceneUISync.v = payload.viewDistance;
    this._updateSceneUISpatialInterest(payload.sceneUI);
  };

  private _onSceneUIUnload = (payload: EventPayloads[SceneUIEvent.UNLOAD]) => {
    const sceneUIId = payload.sceneUI.id!;

    if (this._mirrorSceneUIStatePatch({
      i: sceneUIId,
      rm: true,
    })) {
      return;
    }

    this._markPerPlayerSceneUISyncsRemoved(sceneUIId);
    this._removeSceneUISpatialInterest(sceneUIId);
    const sceneUISync = this._createOrGetQueuedSceneUISyncById(sceneUIId);

    if (this._loadedSceneUIs.has(sceneUISync.i)) {
      this._queuedSceneUISyncs.broadcast.delete(sceneUISync.i);
      this._loadedSceneUIs.delete(sceneUISync.i);
    } else {
      this._markSceneUISyncRemoved(sceneUISync);
    }
  };

  private _onSimulationDebugRaycast = (payload: EventPayloads[SimulationEvent.DEBUG_RAYCAST]) => {
    const debugRaycastsSync = this._createOrGetDebugRaycastsSync();
    debugRaycastsSync.push(Serializer.serializePhysicsDebugRaycast(payload));
  };

  private _onSimulationDebugRender = (payload: EventPayloads[SimulationEvent.DEBUG_RENDER]) => {
    const debugRenderSync = this._createOrGetDebugRenderSync();
    debugRenderSync.v = Array.from(payload.vertices);
    debugRenderSync.c = Array.from(payload.colors);
  };

  private _onWorldSetAmbientLightColor = (payload: EventPayloads[WorldEvent.SET_AMBIENT_LIGHT_COLOR]) => {
    if (this._mirrorWorldStatePatch({ i: payload.world.id, ac: Serializer.serializeRgbColor(payload.color) })) {
      return;
    }

    const worldSync = this._createOrGetQueuedWorldSync(payload.world);
    worldSync.ac = Serializer.serializeRgbColor(payload.color);
  };

  private _onWorldSetAmbientLightIntensity = (payload: EventPayloads[WorldEvent.SET_AMBIENT_LIGHT_INTENSITY]) => {
    if (this._mirrorWorldStatePatch({ i: payload.world.id, ai: payload.intensity })) {
      return;
    }

    const worldSync = this._createOrGetQueuedWorldSync(payload.world);
    worldSync.ai = payload.intensity;
  };

  private _onWorldSetDirectionalLightColor = (payload: EventPayloads[WorldEvent.SET_DIRECTIONAL_LIGHT_COLOR]) => {
    if (this._mirrorWorldStatePatch({ i: payload.world.id, dc: Serializer.serializeRgbColor(payload.color) })) {
      return;
    }

    const worldSync = this._createOrGetQueuedWorldSync(payload.world);
    worldSync.dc = Serializer.serializeRgbColor(payload.color);
  };

  private _onWorldSetDirectionalLightIntensity = (payload: EventPayloads[WorldEvent.SET_DIRECTIONAL_LIGHT_INTENSITY]) => {
    if (this._mirrorWorldStatePatch({ i: payload.world.id, di: payload.intensity })) {
      return;
    }

    const worldSync = this._createOrGetQueuedWorldSync(payload.world);
    worldSync.di = payload.intensity;
  };

  private _onWorldSetDirectionalLightPosition = (payload: EventPayloads[WorldEvent.SET_DIRECTIONAL_LIGHT_POSITION]) => {
    if (this._mirrorWorldStatePatch({ i: payload.world.id, dp: Serializer.serializeVector(payload.position) })) {
      return;
    }

    const worldSync = this._createOrGetQueuedWorldSync(payload.world);
    worldSync.dp = Serializer.serializeVector(payload.position);
  };

  private _onWorldSetFogColor = (payload: EventPayloads[WorldEvent.SET_FOG_COLOR]) => {
    if (this._mirrorWorldStatePatch({ i: payload.world.id, fc: Serializer.serializeRgbColor(payload.color) })) {
      return;
    }

    const worldSync = this._createOrGetQueuedWorldSync(payload.world);
    worldSync.fc = Serializer.serializeRgbColor(payload.color);
  };

  private _onWorldSetFogFar = (payload: EventPayloads[WorldEvent.SET_FOG_FAR]) => {
    if (this._mirrorWorldStatePatch({ i: payload.world.id, ff: payload.far })) {
      return;
    }

    const worldSync = this._createOrGetQueuedWorldSync(payload.world);
    worldSync.ff = payload.far;
  };

  private _onWorldSetFogNear = (payload: EventPayloads[WorldEvent.SET_FOG_NEAR]) => {
    if (this._mirrorWorldStatePatch({ i: payload.world.id, fn: payload.near })) {
      return;
    }

    const worldSync = this._createOrGetQueuedWorldSync(payload.world);
    worldSync.fn = payload.near;
  };

  private _onWorldSetSkyboxIntensity = (payload: EventPayloads[WorldEvent.SET_SKYBOX_INTENSITY]) => {
    if (this._mirrorWorldStatePatch({ i: payload.world.id, si: payload.intensity })) {
      return;
    }

    const worldSync = this._createOrGetQueuedWorldSync(payload.world);
    worldSync.si = payload.intensity;
  };

  private _onWorldSetSkyboxUri = (payload: EventPayloads[WorldEvent.SET_SKYBOX_URI]) => {
    if (this._mirrorWorldStatePatch({ i: payload.world.id, s: payload.uri })) {
      return;
    }

    const worldSync = this._createOrGetQueuedWorldSync(payload.world);
    worldSync.s = payload.uri;
  };

  /*
   * Helpers
   */

  private _assignUndefined<T extends object>(target: T, source: Partial<T>): T {
    for (const key in source) {
      if (target[key] === undefined) {
        target[key] = source[key] as T[Extract<keyof T, string>];
      }
    }

    return target;
  }

  private _createAudioSync = (audio: Audio) => ({ i: audio.id! });
  private _createOrGetQueuedAudioSync(audio: Audio, forPlayer?: Player): protocol.AudioSchema {
    if (audio.id === undefined) { ErrorHandler.fatalError('NetworkSynchronizer._createOrGetQueuedAudioSync(): Audio has no id!'); }

    return this._createOrGetQueuedSync(this._queuedAudioSyncs, audio.id, this._createAudioSync, audio, forPlayer);
  }

  private _createBlockSync = (globalCoordinate: Vector3Like) => ({ i: 0, c: [ globalCoordinate.x, globalCoordinate.y, globalCoordinate.z ] as [ number, number, number ] });
  private _createOrGetQueuedBlockSync(globalCoordinate: Vector3Like, forPlayer?: Player): protocol.BlockSchema {
    const id = `${globalCoordinate.x},${globalCoordinate.y},${globalCoordinate.z}`;

    return this._createOrGetQueuedSync(this._queuedBlockSyncs, id, this._createBlockSync, globalCoordinate, forPlayer);
  }

  private _createBlockTypeSync = (blockType: BlockType) => ({ i: blockType.id });
  private _createOrGetQueuedBlockTypeSync(blockType: BlockType, forPlayer?: Player): protocol.BlockTypeSchema {
    return this._createOrGetQueuedSync(this._queuedBlockTypeSyncs, blockType.id, this._createBlockTypeSync, blockType, forPlayer); 
  }

  private _createCameraSync = () => ({});
  private _createOrGetQueuedCameraSync(forPlayer?: Player): protocol.CameraSchema {
    return this._createOrGetQueuedSingletonSync(this._queuedCameraSyncs, this._createCameraSync, undefined, forPlayer);
  }

  private _createChatMessagesSync = () => ([]);
  private _createOrGetQueuedChatMessagesSync(forPlayer?: Player): protocol.ChatMessagesSchema {
    return this._createOrGetQueuedSingletonSync(this._queuedChatMessagesSyncs, this._createChatMessagesSync, undefined, forPlayer);
  }

  private _createChunkSync = (chunk: Chunk) => ({ c: [ chunk.originCoordinate.x, chunk.originCoordinate.y, chunk.originCoordinate.z ] as [ number, number, number ] });
  private _createOrGetQueuedChunkSync(chunk: Chunk, forPlayer?: Player): protocol.ChunkSchema {
    if (!chunk.originCoordinate) { ErrorHandler.fatalError('NetworkSynchronizer._createOrGetQueuedChunkSync(): Chunk has no origin coordinate!'); }
    const id = `${chunk.originCoordinate.x},${chunk.originCoordinate.y},${chunk.originCoordinate.z}`;

    return this._createOrGetQueuedSync(this._queuedChunkSyncs, id, this._createChunkSync, chunk, forPlayer);
  }

  private _createDebugRaycastsSync = () => ([]);
  private _createOrGetDebugRaycastsSync(forPlayer?: Player): protocol.PhysicsDebugRaycastsSchema {
    return this._createOrGetQueuedSingletonSync(this._queuedDebugRaycastsSyncs, this._createDebugRaycastsSync, undefined, forPlayer);
  }

  private _createDebugRenderSync = () => ({ v: [], c: [] });
  private _createOrGetDebugRenderSync(forPlayer?: Player): protocol.PhysicsDebugRenderSchema {
    return this._createOrGetQueuedSingletonSync(this._queuedDebugRenderSyncs, this._createDebugRenderSync, undefined, forPlayer);
  }
  
  private _createEntitySync = (entity: Entity) => ({ i: entity.id! });
  private _createOrGetQueuedEntitySync(entity: Entity, forPlayer?: Player): protocol.EntitySchema {
    if (entity.id === undefined) { ErrorHandler.fatalError('NetworkSynchronizer._createOrGetQueuedEntitySync(): Entity has no id!'); }

    return this._createOrGetQueuedSync(this._queuedEntitySyncs, entity.id, this._createEntitySync, entity, forPlayer);
  }

  private _createEntitySyncById = (entityId: number) => ({ i: entityId });
  private _createOrGetQueuedEntitySyncById(entityId: number, forPlayer?: Player): protocol.EntitySchema {
    return this._createOrGetQueuedSync(this._queuedEntitySyncs, entityId, this._createEntitySyncById, entityId, forPlayer);
  }

  private _createEntityModelAnimationSync = (entityModelAnimation: EntityModelAnimation) => ({ n: entityModelAnimation.name });
  private _createOrGetQueuedEntityModelAnimationSync(entityModelAnimation: EntityModelAnimation, forPlayer?: Player): protocol.ModelAnimationSchema {
    if (entityModelAnimation.entity.id === undefined) { ErrorHandler.fatalError('NetworkSynchronizer._createOrGetQueuedEntityModelAnimationSync(): EntityModelAnimation entity has no id!'); }

    const entitySync = this._createOrGetQueuedEntitySync(entityModelAnimation.entity, forPlayer);
    entitySync.ma ??= [];
    
    let entityModelAnimationSync = entitySync.ma.find(sync => sync.n === entityModelAnimation.name);

    if (!entityModelAnimationSync) {
      entityModelAnimationSync = this._createEntityModelAnimationSync(entityModelAnimation);
      entitySync.ma.push(entityModelAnimationSync);
    }

    return entityModelAnimationSync;
  }  

  private _createEntityModelNodeOverrideSync = (entityModelNodeOverride: EntityModelNodeOverride) => ({ n: entityModelNodeOverride.nameMatch });
  private _createOrGetQueuedEntityModelNodeOverrideSync(entityModelNodeOverride: EntityModelNodeOverride, forPlayer?: Player): protocol.ModelNodeOverrideSchema {
    if (entityModelNodeOverride.entity.id === undefined) { ErrorHandler.fatalError('NetworkSynchronizer._createOrGetQueuedEntityModelNodeOverrideSync(): EntityModelNodeOverride entity has no id!'); }

    const entitySync = this._createOrGetQueuedEntitySync(entityModelNodeOverride.entity, forPlayer);
    entitySync.mo ??= [];
    
    let entityModelNodeOverrideSync = entitySync.mo.find(sync => sync.n === entityModelNodeOverride.nameMatch);

    if (!entityModelNodeOverrideSync) {
      entityModelNodeOverrideSync = this._createEntityModelNodeOverrideSync(entityModelNodeOverride);
      entitySync.mo.push(entityModelNodeOverrideSync);
    }

    return entityModelNodeOverrideSync;
  }

  private _createParticleEmitterSync = (particleEmitter: ParticleEmitter) => ({ i: particleEmitter.id! });
  private _createOrGetQueuedParticleEmitterSync(particleEmitter: ParticleEmitter, forPlayer?: Player): protocol.ParticleEmitterSchema {
    if (particleEmitter.id === undefined) { ErrorHandler.fatalError('NetworkSynchronizer._createOrGetQueuedParticleEmitterSync(): ParticleEmitter has no id!'); }

    return this._createOrGetQueuedSync(this._queuedParticleEmitterSyncs, particleEmitter.id, this._createParticleEmitterSync, particleEmitter, forPlayer);
  }

  private _createParticleEmitterSyncById = (particleEmitterId: number) => ({ i: particleEmitterId });
  private _createOrGetQueuedParticleEmitterSyncById(particleEmitterId: number, forPlayer?: Player): protocol.ParticleEmitterSchema {
    return this._createOrGetQueuedSync(
      this._queuedParticleEmitterSyncs,
      particleEmitterId,
      this._createParticleEmitterSyncById,
      particleEmitterId,
      forPlayer,
    );
  }

  private _createPlayerSync = (player: Player) => ({ i: player.id });
  private _createOrGetQueuedPlayerSync(player: Player, forPlayer?: Player): protocol.PlayerSchema {
    return this._createOrGetQueuedSync(this._queuedPlayerSyncs, player.id, this._createPlayerSync, player, forPlayer);
  }

  private _createSceneUISync = (sceneUI: SceneUI) => ({ i: sceneUI.id! });
  private _createOrGetQueuedSceneUISync(sceneUI: SceneUI, forPlayer?: Player): protocol.SceneUISchema {
    if (sceneUI.id === undefined) { ErrorHandler.fatalError('NetworkSynchronizer._createOrGetQueuedSceneUISync(): SceneUI has no id!'); }

    return this._createOrGetQueuedSync(this._queuedSceneUISyncs, sceneUI.id, this._createSceneUISync, sceneUI, forPlayer);
  }

  private _createSceneUISyncById = (sceneUIId: number) => ({ i: sceneUIId });
  private _createOrGetQueuedSceneUISyncById(sceneUIId: number, forPlayer?: Player): protocol.SceneUISchema {
    return this._createOrGetQueuedSync(
      this._queuedSceneUISyncs,
      sceneUIId,
      this._createSceneUISyncById,
      sceneUIId,
      forPlayer,
    );
  }

  private _createUISync = () => ({});
  private _createOrGetQueuedUISync(forPlayer?: Player): protocol.UISchema {
    return this._createOrGetQueuedSingletonSync(this._queuedUISyncs, this._createUISync, undefined, forPlayer);
  }

  private _createUIDatasSync = () => ([]);
  private _createOrGetQueuedUIDatasSync(forPlayer?: Player): protocol.UIDatasSchema {
    return this._createOrGetQueuedSingletonSync(this._queuedUIDatasSyncs, this._createUIDatasSync, undefined, forPlayer);
  }

  private _createBlockEditPredictionConfigSync = (
    player: Player,
  ): protocol.BlockEditPredictionConfigSchema => this._serializeDefaultBlockEditPredictionConfig(player);
  private _createOrGetQueuedBlockEditPredictionConfigSync(
    forPlayer: Player,
  ): protocol.BlockEditPredictionConfigSchema {
    return this._createOrGetQueuedSingletonSync(
      this._queuedBlockEditPredictionConfigSyncs,
      this._createBlockEditPredictionConfigSync,
      forPlayer,
      forPlayer,
    );
  }

  private _createBlockEditPredictionResultsSync = () => ([]);
  private _createOrGetQueuedBlockEditPredictionResultsSync(
    forPlayer?: Player,
  ): protocol.BlockEditPredictionResultsSchema {
    return this._createOrGetQueuedSingletonSync(
      this._queuedBlockEditPredictionResultsSyncs,
      this._createBlockEditPredictionResultsSync,
      undefined,
      forPlayer,
    );
  }

  private _createWorldSync = (world: World) => ({ i: world.id });
  private _createOrGetQueuedWorldSync(world: World, forPlayer?: Player): protocol.WorldSchema {
    if (world.id !== this._world.id) { ErrorHandler.fatalError('NetworkSynchronizer._createOrGetQueuedWorldSync(): World does not match this network synchronizer world!'); }

    return this._createOrGetQueuedSingletonSync(this._queuedWorldSyncs, this._createWorldSync, world, forPlayer);
  }

  private _serializeDefaultBlockEditPredictionConfig(
    player: Player,
  ): protocol.BlockEditPredictionConfigSchema {
    return {
      m: player.defaultBlockEditPredictionConfig.maxDistance,
      i: player.defaultBlockEditPredictionConfig.placeBlockTypeId,
      r: player.defaultBlockEditPredictionConfig.placeBlockRotationIndex,
    };
  }

  private _createOrGetQueuedSync<TId, TSchema extends object | null, TContext>(
    syncQueue: SyncQueue<TId, TSchema>,
    id: TId,
    createSync: (createContext: TContext) => TSchema,
    createContext: TContext,
    forPlayer?: Player,
  ): TSchema {
    let sync: TSchema | undefined;
    let syncMap: IterationMap<TId, TSchema> | undefined;

    if (forPlayer) {
      syncMap = syncQueue.perPlayer.get(forPlayer);

      if (!syncMap) {
        syncMap = new IterationMap();
        syncQueue.perPlayer.set(forPlayer, syncMap);
      }

    } else {
      syncMap = syncQueue.broadcast;
    }

    sync = syncMap.get(id);

    if (sync === undefined) {
      sync = createSync(createContext);
      syncMap.set(id, sync);
    }

    return sync;
  }

  private _createOrGetQueuedSingletonSync<TSchema extends object | null, TContext>(
    syncQueue: SingletonSyncQueue<TSchema>,
    createSync: (createContext: TContext) => TSchema,
    createContext: TContext,
    forPlayer?: Player,
  ): TSchema {
    let sync = forPlayer ? syncQueue.perPlayer.get(forPlayer) : syncQueue.broadcast;

    if (sync === undefined) {
      sync = createSync(createContext);

      if (forPlayer) {
        syncQueue.perPlayer.set(forPlayer, sync);
      } else {
        syncQueue.broadcast = sync;
      }
    }

    return sync;
  }

  private _markEntitySyncRemoved(entitySync: protocol.EntitySchema): void {
    entitySync.rm = true;
    delete entitySync.ma;
    delete entitySync.mo;
    delete entitySync.p;
    delete entitySync.r;
  }

  private _markPerPlayerEntitySyncsRemoved(entityId: number): void {
    for (const syncMap of this._queuedEntitySyncs.perPlayer.values()) {
      const entitySync = syncMap.get(entityId);
      if (!entitySync) {
        continue;
      }

      this._markEntitySyncRemoved(entitySync);
    }
  }

  private _markParticleEmitterSyncRemoved(particleEmitterSync: protocol.ParticleEmitterSchema): void {
    particleEmitterSync.rm = true;
    delete particleEmitterSync.b;
    delete particleEmitterSync.e;
    delete particleEmitterSync.en;
    delete particleEmitterSync.p;
  }

  private _markPerPlayerParticleEmitterSyncsRemoved(particleEmitterId: number): void {
    for (const syncMap of this._queuedParticleEmitterSyncs.perPlayer.values()) {
      const particleEmitterSync = syncMap.get(particleEmitterId);
      if (!particleEmitterSync) {
        continue;
      }

      this._markParticleEmitterSyncRemoved(particleEmitterSync);
    }
  }

  private _markSceneUISyncRemoved(sceneUISync: protocol.SceneUISchema): void {
    sceneUISync.rm = true;
    delete sceneUISync.e;
    delete sceneUISync.o;
    delete sceneUISync.p;
    delete sceneUISync.s;
    delete sceneUISync.v;
  }

  private _markPerPlayerSceneUISyncsRemoved(sceneUIId: number): void {
    for (const syncMap of this._queuedSceneUISyncs.perPlayer.values()) {
      const sceneUISync = syncMap.get(sceneUIId);
      if (!sceneUISync) {
        continue;
      }

      this._markSceneUISyncRemoved(sceneUISync);
    }
  }

  private _clearSyncQueue(syncQueue: SyncQueue<any, any>) {
    if (syncQueue.broadcast.size > 0) { syncQueue.broadcast.clear(); }
    if (syncQueue.perPlayer.size > 0) { syncQueue.perPlayer.clear(); }
  }

  private _refreshPlayerChunkInterests(): void {
    if (WorldHostManager.instance.client.ownsDerivedState(this._world)) {
      return;
    }

    for (const player of PlayerManager.instance.getConnectedPlayersByWorldSet(this._world)) {
      this._refreshPlayerChunkInterest(player);
    }
  }

  private _refreshPlayerChunkInterest(player: Player): void {
    const center = this._getChunkInterestCenter(player);
    const state = this._getOrCreatePlayerChunkInterestState(player);

    if (!center) {
      state.needsRefresh = true;
      return;
    }

    const centerChunkOrigin = Chunk.globalCoordinateToOriginCoordinate(center);
    const centerChunkKey = this._chunkKeyForOriginCoordinate(centerChunkOrigin);
    if (!state.needsRefresh && state.centerChunkKey === centerChunkKey) {
      return;
    }

    const loadedChunkKeys = this._getOrCreateLoadedChunkKeys(player);
    const desiredChunkInfos = this._collectDesiredChunksForCenter(centerChunkOrigin);
    const desiredChunkKeys = new Set<string>();

    for (let i = 0; i < desiredChunkInfos.length; i++) {
      desiredChunkKeys.add(desiredChunkInfos[i].key);
    }

    for (const loadedChunkKey of Array.from(loadedChunkKeys)) {
      if (desiredChunkKeys.has(loadedChunkKey)) {
        continue;
      }

      const originCoordinate = this._originCoordinateFromChunkKey(loadedChunkKey);
      if (!originCoordinate) {
        loadedChunkKeys.delete(loadedChunkKey);
        continue;
      }

      const chunk = this._world.chunkLattice.getChunk(originCoordinate);
      if (chunk) {
        this._queueChunkRemovalForPlayer(chunk, player);
      }

      loadedChunkKeys.delete(loadedChunkKey);
    }

    let remainingChunkLoads = CHUNK_STREAM_MAX_LOADS_PER_SYNC;
    let hasPendingChunkLoads = false;

    for (let i = 0; i < desiredChunkInfos.length; i++) {
      const desiredChunkInfo = desiredChunkInfos[i];
      if (loadedChunkKeys.has(desiredChunkInfo.key)) {
        continue;
      }

      if (remainingChunkLoads <= 0) {
        hasPendingChunkLoads = true;
        continue;
      }

      this._queueChunkStateForPlayer(desiredChunkInfo.chunk, player);
      loadedChunkKeys.add(desiredChunkInfo.key);
      remainingChunkLoads--;
    }

    state.centerChunkKey = centerChunkKey;
    state.needsRefresh = hasPendingChunkLoads;
  }

  private _refreshPlayerSpatialInterests(): void {
    if (WorldHostManager.instance.client.ownsDerivedState(this._world)) {
      return;
    }

    this._ensureSpatialInterestIndexesInitialized();

    for (const player of PlayerManager.instance.getConnectedPlayersByWorldSet(this._world)) {
      this._refreshPlayerSpatialInterest(player);
    }
  }

  private _refreshPlayerSpatialInterest(player: Player): void {
    const center = this._getChunkInterestCenter(player);
    if (!center) {
      return;
    }

    const centerChunkOrigin = Chunk.globalCoordinateToOriginCoordinate(center);
    this._refreshPlayerEntityInterest(player, centerChunkOrigin);
    this._refreshPlayerParticleEmitterInterest(player, centerChunkOrigin);
    this._refreshPlayerSceneUIInterest(player, center, centerChunkOrigin);
  }

  private _refreshPlayerEntityInterest(player: Player, centerChunkOrigin: Vector3Like): void {
    const loadedEntityIds = this._getOrCreateLoadedEntityIds(player);
    const candidateEntityIds = this._entitySpatialInterestIndex.collectIdsInRange(centerChunkOrigin);
    const desiredEntityIds: Set<number> = new Set();

    for (const entityId of candidateEntityIds) {
      const entity = this._world.entityManager.getEntity(entityId);
      if (!entity || !this._shouldSyncEntityToPlayer(entity, player, centerChunkOrigin)) {
        continue;
      }

      desiredEntityIds.add(entity.id!);
      if (loadedEntityIds.has(entity.id!)) {
        continue;
      }

      this._queueEntityStateForPlayer(entity, player);
      loadedEntityIds.add(entity.id!);
    }

    for (const playerEntity of this._world.entityManager.getPlayerEntitiesByPlayer(player)) {
      if (playerEntity.id === undefined || desiredEntityIds.has(playerEntity.id)) {
        continue;
      }

      if (!this._shouldSyncEntityToPlayer(playerEntity, player, centerChunkOrigin)) {
        continue;
      }

      desiredEntityIds.add(playerEntity.id);
      if (loadedEntityIds.has(playerEntity.id)) {
        continue;
      }

      this._queueEntityStateForPlayer(playerEntity, player);
      loadedEntityIds.add(playerEntity.id);
    }

    for (const loadedEntityId of Array.from(loadedEntityIds)) {
      if (desiredEntityIds.has(loadedEntityId)) {
        continue;
      }

      const entity = this._world.entityManager.getEntity(loadedEntityId);
      if (entity) {
        this._queueEntityRemovalForPlayer(entity, player);
      } else {
        // The broadcast remove will be filtered out after we drop the loaded-id entry
        // below, so synthesize a player-specific remove before clearing the loaded set.
        this._markEntitySyncRemoved(this._createOrGetQueuedEntitySyncById(loadedEntityId, player));
      }

      loadedEntityIds.delete(loadedEntityId);
    }
  }

  private _refreshPlayerParticleEmitterInterest(player: Player, centerChunkOrigin: Vector3Like): void {
    const loadedParticleEmitterIds = this._getOrCreateLoadedParticleEmitterIds(player);
    const candidateParticleEmitterIds = this._particleEmitterSpatialInterestIndex.collectIdsInRange(centerChunkOrigin);
    const desiredParticleEmitterIds: Set<number> = new Set();

    for (const particleEmitterId of candidateParticleEmitterIds) {
      const particleEmitter = this._world.particleEmitterManager.getParticleEmitterById(particleEmitterId);
      if (!particleEmitter) {
        continue;
      }

      if (!this._shouldSyncParticleEmitterToPlayer(particleEmitter, centerChunkOrigin)) {
        continue;
      }

      desiredParticleEmitterIds.add(particleEmitter.id!);
      if (loadedParticleEmitterIds.has(particleEmitter.id!)) {
        continue;
      }

      this._queueParticleEmitterStateForPlayer(particleEmitter, player);
      loadedParticleEmitterIds.add(particleEmitter.id!);
    }

    for (const loadedParticleEmitterId of Array.from(loadedParticleEmitterIds)) {
      if (desiredParticleEmitterIds.has(loadedParticleEmitterId)) {
        continue;
      }

      const particleEmitter = this._world.particleEmitterManager.getParticleEmitterById(loadedParticleEmitterId);
      if (particleEmitter) {
        this._queueParticleEmitterRemovalForPlayer(particleEmitter, player);
      } else {
        this._markParticleEmitterSyncRemoved(this._createOrGetQueuedParticleEmitterSyncById(loadedParticleEmitterId, player));
      }

      loadedParticleEmitterIds.delete(loadedParticleEmitterId);
    }
  }

  private _refreshPlayerSceneUIInterest(player: Player, center: Vector3Like, centerChunkOrigin: Vector3Like): void {
    const loadedSceneUIIds = this._getOrCreateLoadedSceneUIIds(player);
    const candidateSceneUIIds = this._sceneUISpatialInterestIndex.collectIdsInRange(centerChunkOrigin);
    const desiredSceneUIIds: Set<number> = new Set();

    for (const sceneUIId of candidateSceneUIIds) {
      const sceneUI = this._world.sceneUIManager.getSceneUIById(sceneUIId);
      if (!sceneUI || !this._shouldSyncSceneUIToPlayer(sceneUI, center, centerChunkOrigin)) {
        continue;
      }

      desiredSceneUIIds.add(sceneUI.id!);
      if (loadedSceneUIIds.has(sceneUI.id!)) {
        continue;
      }

      this._queueSceneUIStateForPlayer(sceneUI, player);
      loadedSceneUIIds.add(sceneUI.id!);
    }

    for (const sceneUIId of this._longRangeSceneUIIds) {
      if (desiredSceneUIIds.has(sceneUIId)) {
        continue;
      }

      const sceneUI = this._world.sceneUIManager.getSceneUIById(sceneUIId);
      if (!sceneUI || !this._shouldSyncSceneUIToPlayer(sceneUI, center, centerChunkOrigin)) {
        continue;
      }

      desiredSceneUIIds.add(sceneUI.id!);
      if (loadedSceneUIIds.has(sceneUI.id!)) {
        continue;
      }

      this._queueSceneUIStateForPlayer(sceneUI, player);
      loadedSceneUIIds.add(sceneUI.id!);
    }

    for (const loadedSceneUIId of Array.from(loadedSceneUIIds)) {
      if (desiredSceneUIIds.has(loadedSceneUIId)) {
        continue;
      }

      const sceneUI = this._world.sceneUIManager.getSceneUIById(loadedSceneUIId);
      if (sceneUI) {
        this._queueSceneUIRemovalForPlayer(sceneUI, player);
      } else {
        this._markSceneUISyncRemoved(this._createOrGetQueuedSceneUISyncById(loadedSceneUIId, player));
      }

      loadedSceneUIIds.delete(loadedSceneUIId);
    }
  }

  private _ensureSpatialInterestIndexesInitialized(): void {
    if (this._spatialInterestIndexesInitialized) {
      return;
    }

    this._rebuildSpatialInterestIndexes();
    this._spatialInterestIndexesInitialized = true;
  }

  private _rebuildSpatialInterestIndexes(): void {
    this._entitySpatialInterestIndex.clear();
    this._particleEmitterSpatialInterestIndex.clear();
    this._sceneUISpatialInterestIndex.clear();
    this._longRangeSceneUIIds.clear();

    for (const entity of this._world.entityManager.getAllEntities()) {
      if (entity.id === undefined) {
        continue;
      }

      this._entitySpatialInterestIndex.update(entity.id, entity.position);
    }

    for (const particleEmitter of this._world.particleEmitterManager.getAllParticleEmitters()) {
      if (particleEmitter.id === undefined) {
        continue;
      }

      this._particleEmitterSpatialInterestIndex.update(
        particleEmitter.id,
        particleEmitter.attachedToEntity?.position ?? particleEmitter.position,
        particleEmitter.attachedToEntity?.id,
      );
    }

    for (const sceneUI of this._world.sceneUIManager.getAllSceneUIs()) {
      if (sceneUI.id === undefined) {
        continue;
      }

      this._sceneUISpatialInterestIndex.update(
        sceneUI.id,
        sceneUI.attachedToEntity?.position ?? sceneUI.position,
        sceneUI.attachedToEntity?.id,
      );

      if (this._isLongRangeSceneUI(sceneUI)) {
        this._longRangeSceneUIIds.add(sceneUI.id);
      }
    }
  }

  private _updateEntitySpatialInterest(entity: Entity): void {
    if (entity.id === undefined) {
      return;
    }

    this._ensureSpatialInterestIndexesInitialized();
    this._entitySpatialInterestIndex.update(entity.id, entity.position);
    this._refreshAttachedSpatialInterestForEntity(entity.id);
  }

  private _removeEntitySpatialInterest(entityId: number): void {
    this._ensureSpatialInterestIndexesInitialized();
    this._entitySpatialInterestIndex.remove(entityId);
    this._refreshAttachedSpatialInterestForEntity(entityId);
  }

  private _updateParticleEmitterSpatialInterest(particleEmitter: ParticleEmitter): void {
    if (particleEmitter.id === undefined) {
      return;
    }

    this._ensureSpatialInterestIndexesInitialized();
    this._particleEmitterSpatialInterestIndex.update(
      particleEmitter.id,
      particleEmitter.attachedToEntity?.position ?? particleEmitter.position,
      particleEmitter.attachedToEntity?.id,
    );
  }

  private _removeParticleEmitterSpatialInterest(particleEmitterId: number): void {
    this._ensureSpatialInterestIndexesInitialized();
    this._particleEmitterSpatialInterestIndex.remove(particleEmitterId);
  }

  private _updateSceneUISpatialInterest(sceneUI: SceneUI): void {
    if (sceneUI.id === undefined) {
      return;
    }

    this._ensureSpatialInterestIndexesInitialized();
    this._sceneUISpatialInterestIndex.update(
      sceneUI.id,
      sceneUI.attachedToEntity?.position ?? sceneUI.position,
      sceneUI.attachedToEntity?.id,
    );

    if (this._isLongRangeSceneUI(sceneUI)) {
      this._longRangeSceneUIIds.add(sceneUI.id);
    } else {
      this._longRangeSceneUIIds.delete(sceneUI.id);
    }
  }

  private _removeSceneUISpatialInterest(sceneUIId: number): void {
    this._ensureSpatialInterestIndexesInitialized();
    this._sceneUISpatialInterestIndex.remove(sceneUIId);
    this._longRangeSceneUIIds.delete(sceneUIId);
  }

  private _refreshAttachedSpatialInterestForEntity(entityId: number): void {
    const particleEmitterIds = this._particleEmitterSpatialInterestIndex.getAttachedIds(entityId);
    if (particleEmitterIds) {
      for (const particleEmitterId of Array.from(particleEmitterIds)) {
        const particleEmitter = this._world.particleEmitterManager.getParticleEmitterById(particleEmitterId);
        if (particleEmitter) {
          this._updateParticleEmitterSpatialInterest(particleEmitter);
        } else {
          this._removeParticleEmitterSpatialInterest(particleEmitterId);
        }
      }
    }

    const sceneUIIds = this._sceneUISpatialInterestIndex.getAttachedIds(entityId);
    if (sceneUIIds) {
      for (const sceneUIId of Array.from(sceneUIIds)) {
        const sceneUI = this._world.sceneUIManager.getSceneUIById(sceneUIId);
        if (sceneUI) {
          this._updateSceneUISpatialInterest(sceneUI);
        } else {
          this._removeSceneUISpatialInterest(sceneUIId);
        }
      }
    }
  }

  private _isLongRangeSceneUI(sceneUI: SceneUI): boolean {
    return typeof sceneUI.viewDistance === 'number'
      && Number.isFinite(sceneUI.viewDistance)
      && sceneUI.viewDistance > SCENE_UI_CHUNK_INTEREST_SAFE_VIEW_DISTANCE;
  }

  private _collectDesiredChunksForCenter(centerChunkOrigin: Vector3Like): { chunk: Chunk; key: string; distanceSq: number }[] {
    const desiredChunks: { chunk: Chunk; key: string; distanceSq: number }[] = [];

    for (let dy = -CHUNK_STREAM_VERTICAL_RADIUS; dy <= CHUNK_STREAM_VERTICAL_RADIUS; dy++) {
      for (let dx = -CHUNK_STREAM_HORIZONTAL_RADIUS; dx <= CHUNK_STREAM_HORIZONTAL_RADIUS; dx++) {
        for (let dz = -CHUNK_STREAM_HORIZONTAL_RADIUS; dz <= CHUNK_STREAM_HORIZONTAL_RADIUS; dz++) {
          const horizontalDistanceSq = dx * dx + dz * dz;
          if (horizontalDistanceSq > CHUNK_STREAM_HORIZONTAL_RADIUS * CHUNK_STREAM_HORIZONTAL_RADIUS) {
            continue;
          }

          const originCoordinate = {
            x: centerChunkOrigin.x + dx * CHUNK_SIZE,
            y: centerChunkOrigin.y + dy * CHUNK_SIZE,
            z: centerChunkOrigin.z + dz * CHUNK_SIZE,
          };
          const chunk = this._world.chunkLattice.getChunk(originCoordinate);
          if (!chunk) {
            continue;
          }

          desiredChunks.push({
            chunk,
            key: this._chunkKeyForOriginCoordinate(chunk.originCoordinate),
            distanceSq: horizontalDistanceSq + dy * dy,
          });
        }
      }
    }

    desiredChunks.sort((a, b) => a.distanceSq - b.distanceSq);
    return desiredChunks;
  }

  private _getPlayersInterestedInChunk(chunk: Chunk): Player[] {
    const players: Player[] = [];

    for (const player of PlayerManager.instance.getConnectedPlayersByWorldSet(this._world)) {
      const center = this._getChunkInterestCenter(player);
      if (!center) {
        continue;
      }

      if (!this._isChunkOriginInRange(chunk.originCoordinate, Chunk.globalCoordinateToOriginCoordinate(center))) {
        continue;
      }

      players.push(player);
    }

    return players;
  }

  private _getChunkInterestCenter(player: Player): Vector3Like | undefined {
    return player.camera.attachedToPosition ??
      player.camera.attachedToEntity?.position ??
      player.camera.targetPosition ??
      player.camera.targetEntity?.position ??
      this._world.entityManager.getPlayerEntitiesByPlayer(player)[0]?.position;
  }

  private _isChunkOriginInRange(originCoordinate: Vector3Like, centerChunkOrigin: Vector3Like): boolean {
    const dx = (originCoordinate.x - centerChunkOrigin.x) / CHUNK_SIZE;
    const dy = Math.abs((originCoordinate.y - centerChunkOrigin.y) / CHUNK_SIZE);
    const dz = (originCoordinate.z - centerChunkOrigin.z) / CHUNK_SIZE;

    return dy <= CHUNK_STREAM_VERTICAL_RADIUS &&
      (dx * dx + dz * dz) <= CHUNK_STREAM_HORIZONTAL_RADIUS * CHUNK_STREAM_HORIZONTAL_RADIUS;
  }

  private _queueChunkStateForPlayer(chunk: Chunk, player: Player): void {
    const chunkSync = this._createOrGetQueuedChunkSync(chunk, player);
    Object.assign(chunkSync, chunk.serialize());
    chunkSync.rm = undefined;
  }

  private _queueChunkRemovalForPlayer(chunk: Chunk, player: Player): void {
    const chunkSync = this._createOrGetQueuedChunkSync(chunk, player);
    chunkSync.rm = true;
    delete chunkSync.b;
    delete chunkSync.r;
  }

  private _queueEntityStateForPlayer(entity: Entity, player: Player): void {
    const entitySync = this._createOrGetQueuedEntitySync(entity, player);
    this._assignUndefined(entitySync, entity.serialize());

    if (entity instanceof PlayerEntity && entity.player === player) {
      this._queuePlayerEntityOwnerPredictionState(entitySync, entity);
    }
  }

  private _queueEntityRemovalForPlayer(entity: Entity, player: Player): void {
    const entitySync = this._createOrGetQueuedEntitySync(entity, player);
    this._markEntitySyncRemoved(entitySync);
  }

  private _queueParticleEmitterStateForPlayer(particleEmitter: ParticleEmitter, player: Player): void {
    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(particleEmitter, player);
    this._assignUndefined(particleEmitterSync, particleEmitter.serialize());
  }

  private _queueParticleEmitterRemovalForPlayer(particleEmitter: ParticleEmitter, player: Player): void {
    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(particleEmitter, player);
    this._markParticleEmitterSyncRemoved(particleEmitterSync);
  }

  private _queueSceneUIStateForPlayer(sceneUI: SceneUI, player: Player): void {
    const sceneUISync = this._createOrGetQueuedSceneUISync(sceneUI, player);
    this._assignUndefined(sceneUISync, sceneUI.serialize());
  }

  private _queueSceneUIRemovalForPlayer(sceneUI: SceneUI, player: Player): void {
    const sceneUISync = this._createOrGetQueuedSceneUISync(sceneUI, player);
    this._markSceneUISyncRemoved(sceneUISync);
  }

  private _coalesceRemovalDominatedSyncs<TSchema extends { i?: number; rm?: boolean }>(syncs: TSchema[]): TSchema[] {
    const coalescedSyncs: (TSchema | undefined)[] = [];
    const seenIndexesById: Map<number, number[]> = new Map();
    const removedIds: Set<number> = new Set();

    for (let i = 0; i < syncs.length; i++) {
      const sync = syncs[i];
      const syncId = sync.i;

      if (syncId === undefined) {
        coalescedSyncs.push(sync);
        continue;
      }

      if (removedIds.has(syncId)) {
        continue;
      }

      if (sync.rm) {
        const seenIndexes = seenIndexesById.get(syncId);
        if (seenIndexes) {
          for (let j = 0; j < seenIndexes.length; j++) {
            coalescedSyncs[seenIndexes[j]] = undefined;
          }
        }

        coalescedSyncs.push(sync);
        seenIndexesById.set(syncId, [ coalescedSyncs.length - 1 ]);
        removedIds.add(syncId);
        continue;
      }

      const seenIndexes = seenIndexesById.get(syncId);
      if (seenIndexes) {
        seenIndexes.push(coalescedSyncs.length);
      } else {
        seenIndexesById.set(syncId, [ coalescedSyncs.length ]);
      }

      coalescedSyncs.push(sync);
    }

    return coalescedSyncs.filter((sync): sync is TSchema => sync !== undefined);
  }

  private _getOrCreateLoadedChunkKeys(player: Player): Set<string> {
    let loadedChunkKeys = this._loadedChunkKeysByPlayer.get(player);
    if (!loadedChunkKeys) {
      loadedChunkKeys = new Set();
      this._loadedChunkKeysByPlayer.set(player, loadedChunkKeys);
    }

    return loadedChunkKeys;
  }

  private _getOrCreateLoadedEntityIds(player: Player): Set<number> {
    let loadedEntityIds = this._loadedEntityIdsByPlayer.get(player);
    if (!loadedEntityIds) {
      loadedEntityIds = new Set();
      this._loadedEntityIdsByPlayer.set(player, loadedEntityIds);
    }

    return loadedEntityIds;
  }

  private _getOrCreateLoadedParticleEmitterIds(player: Player): Set<number> {
    let loadedParticleEmitterIds = this._loadedParticleEmitterIdsByPlayer.get(player);
    if (!loadedParticleEmitterIds) {
      loadedParticleEmitterIds = new Set();
      this._loadedParticleEmitterIdsByPlayer.set(player, loadedParticleEmitterIds);
    }

    return loadedParticleEmitterIds;
  }

  private _getOrCreateLoadedSceneUIIds(player: Player): Set<number> {
    let loadedSceneUIIds = this._loadedSceneUIIdsByPlayer.get(player);
    if (!loadedSceneUIIds) {
      loadedSceneUIIds = new Set();
      this._loadedSceneUIIdsByPlayer.set(player, loadedSceneUIIds);
    }

    return loadedSceneUIIds;
  }

  private _getOrCreatePlayerChunkInterestState(player: Player): PlayerChunkInterestState {
    let state = this._chunkInterestStateByPlayer.get(player);
    if (!state) {
      state = { needsRefresh: true };
      this._chunkInterestStateByPlayer.set(player, state);
    }

    return state;
  }

  private _shouldSyncEntityToPlayer(
    entity: Entity,
    player: Player,
    centerChunkOrigin: Vector3Like,
  ): boolean {
    if (entity instanceof PlayerEntity && entity.player === player) {
      return true;
    }

    return this._isPositionInChunkInterestRange(entity.position, centerChunkOrigin);
  }

  private _shouldSyncParticleEmitterToPlayer(
    particleEmitter: ParticleEmitter,
    centerChunkOrigin: Vector3Like,
  ): boolean {
    const anchor = particleEmitter.attachedToEntity?.position ?? particleEmitter.position;
    return anchor ? this._isPositionInChunkInterestRange(anchor, centerChunkOrigin) : false;
  }

  private _shouldSyncSceneUIToPlayer(
    sceneUI: SceneUI,
    center: Vector3Like,
    centerChunkOrigin: Vector3Like,
  ): boolean {
    const anchor = sceneUI.attachedToEntity?.position ?? sceneUI.position;
    if (!anchor) {
      return false;
    }

    if (typeof sceneUI.viewDistance === 'number' && Number.isFinite(sceneUI.viewDistance) && sceneUI.viewDistance >= 0) {
      const dx = anchor.x - center.x;
      const dy = anchor.y - center.y;
      const dz = anchor.z - center.z;
      return (dx * dx) + (dy * dy) + (dz * dz) <= sceneUI.viewDistance * sceneUI.viewDistance;
    }

    return this._isPositionInChunkInterestRange(anchor, centerChunkOrigin);
  }

  private _isPositionInChunkInterestRange(position: Vector3Like | undefined, centerChunkOrigin: Vector3Like): boolean {
    if (!position) {
      return false;
    }

    return this._isChunkOriginInRange(Chunk.globalCoordinateToOriginCoordinate(position), centerChunkOrigin);
  }

  private _chunkKeyForGlobalCoordinate(globalCoordinate: Vector3Like): string {
    return this._chunkKeyForOriginCoordinate(Chunk.globalCoordinateToOriginCoordinate(globalCoordinate));
  }

  private _chunkKeyForOriginCoordinate(originCoordinate: Vector3Like): string {
    return `${originCoordinate.x},${originCoordinate.y},${originCoordinate.z}`;
  }

  private _originCoordinateFromChunkKey(chunkKey: string): Vector3Like | undefined {
    const [x, y, z] = chunkKey.split(',').map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      return undefined;
    }

    return { x, y, z };
  }

  private _clearSingletonSyncQueue(syncQueue: SingletonSyncQueue<any>) {
    if (syncQueue.broadcast !== undefined) { syncQueue.broadcast = undefined; }
    if (syncQueue.perPlayer.size > 0) { syncQueue.perPlayer.clear(); }
  }

  private _appendPerPlayerSlotPacket(slot: ReliablePacketSlot, player: Player, packet: AnyPacket): void {
    if (!slot.perPlayerPackets) {
      slot.perPlayerPackets = new Map();
    }

    const existingPackets = slot.perPlayerPackets.get(player);
    if (existingPackets) {
      existingPackets.push(packet);
      return;
    }

    slot.perPlayerPackets.set(player, [ packet ]);
  }

  private _appendPerPlayerUnreliablePacket(packetPlan: PacketPlan, player: Player, packet: AnyPacket): void {
    const existingPackets = packetPlan.perPlayerUnreliablePackets.get(player);
    if (existingPackets) {
      existingPackets.push(packet);
      return;
    }

    packetPlan.perPlayerUnreliablePackets.set(player, [ packet ]);
  }

  private _buildPacketPlan(currentTick: number): PacketPlan {
    const packetPlan: PacketPlan = {
      perPlayerUnreliablePackets: new Map(),
      postPlayerUIAfterChatReliableSlots: [],
      postPlayerUIBeforeWorldAndPlayersReliableSlots: [],
      prePlayerUIReliableSlots: [],
      prePlayerUISpecialReliableSlots: [],
      sharedUnreliablePackets: [],
    };

    const entitySlot = this._buildEntityPacketSlot(currentTick, packetPlan);
    if (entitySlot) {
      packetPlan.prePlayerUISpecialReliableSlots.push(entitySlot);
    }

    // 2. Audios
    this._pushReliablePacketSlot(
      packetPlan.prePlayerUIReliableSlots,
      this._buildSyncPacketSlot(this._queuedAudioSyncs, protocol.outboundPackets.audiosPacketDefinition, currentTick),
    );

    // 3. block types
    this._pushReliablePacketSlot(
      packetPlan.prePlayerUIReliableSlots,
      this._buildSyncPacketSlot(this._queuedBlockTypeSyncs, protocol.outboundPackets.blockTypesPacketDefinition, currentTick),
    );

    // 4. owner-only default block edit prediction config
    this._pushReliablePacketSlot(
      packetPlan.prePlayerUIReliableSlots,
      this._buildSingletonSyncPacketSlot(
        this._queuedBlockEditPredictionConfigSyncs,
        protocol.outboundPackets.blockEditPredictionConfigPacketDefinition,
        currentTick,
      ),
    );

    // 5. owner-only block edit prediction responses
    this._pushReliablePacketSlot(
      packetPlan.prePlayerUIReliableSlots,
      this._buildSingletonSyncPacketSlot(
        this._queuedBlockEditPredictionResultsSyncs,
        protocol.outboundPackets.blockEditPredictionResultsPacketDefinition,
        currentTick,
      ),
    );

    // 6. chunks
    this._pushReliablePacketSlot(
      packetPlan.prePlayerUIReliableSlots,
      this._buildSyncPacketSlot(this._queuedChunkSyncs, protocol.outboundPackets.chunksPacketDefinition, currentTick),
    );

    // 7. blocks
    this._pushReliablePacketSlot(
      packetPlan.prePlayerUIReliableSlots,
      this._buildSyncPacketSlot(this._queuedBlockSyncs, protocol.outboundPackets.blocksPacketDefinition, currentTick),
    );

    // 8. particle emitters
    this._pushReliablePacketSlot(
      packetPlan.prePlayerUIReliableSlots,
      this._buildSpatialSyncPacketSlot(
        this._queuedParticleEmitterSyncs,
        protocol.outboundPackets.particleEmittersPacketDefinition,
        currentTick,
        this._loadedParticleEmitterIdsByPlayer,
      ),
    );

    // 7. scene UIs
    this._pushReliablePacketSlot(
      packetPlan.postPlayerUIBeforeWorldAndPlayersReliableSlots,
      this._buildSpatialSyncPacketSlot(
        this._queuedSceneUISyncs,
        protocol.outboundPackets.sceneUIsPacketDefinition,
        currentTick,
        this._loadedSceneUIIdsByPlayer,
      ),
    );

    // 8. debug renders
    this._pushReliablePacketSlot(
      packetPlan.postPlayerUIAfterChatReliableSlots,
      this._buildSingletonSyncPacketSlot(this._queuedDebugRenderSyncs, protocol.outboundPackets.physicsDebugRenderPacketDefinition, currentTick),
    );

    // 9. debug raycasts
    this._pushReliablePacketSlot(
      packetPlan.postPlayerUIAfterChatReliableSlots,
      this._buildSingletonSyncPacketSlot(this._queuedDebugRaycastsSyncs, protocol.outboundPackets.physicsDebugRaycastsPacketDefinition, currentTick),
    );

    return packetPlan;
  }

  private _buildEntityPacketSlot(currentTick: number, packetPlan: PacketPlan): ReliablePacketSlot | undefined {
    const slot: ReliablePacketSlot = {};
    const hostOwnsDerivedState = WorldHostManager.instance.client.ownsDerivedState(this._world);

    /**
     * Entity synchronizations specific to rotational and positional updates
     * account for 90%+ of all packets sent. Because these are not deltas and
     * send as full position / rotation updates, we can send them over the
     * unreliable channel to drastically reduce blocking on the client and stutter
     * in poor network conditions.
     */
    const targetPlayers = hostOwnsDerivedState
      ? Array.from(this._queuedEntitySyncs.perPlayer.keys())
      : PlayerManager.instance.getConnectedPlayersByWorldSet(this._world);

    for (const player of targetPlayers) {
      const pendingUpdates: protocol.EntitySchema[] = [];
      const reliableUpdates: protocol.EntitySchema[] = [];
      const unreliableUpdates: protocol.EntitySchema[] = [];

      if (!hostOwnsDerivedState && this._queuedEntitySyncs.broadcast.size > 0) {
        const loadedEntityIds = this._loadedEntityIdsByPlayer.get(player);
        if (loadedEntityIds && loadedEntityIds.size > 0) {
          for (const entitySync of this._queuedEntitySyncs.broadcast.valuesArray) {
            if (!loadedEntityIds.has(entitySync.i)) {
              continue;
            }

            this._sanitizeEntitySync(entitySync);
            pendingUpdates.push(entitySync);
          }
        }
      }

      const perPlayerEntitySyncs = this._queuedEntitySyncs.perPlayer.get(player);
      if (perPlayerEntitySyncs && perPlayerEntitySyncs.size > 0) {
        for (const entitySync of perPlayerEntitySyncs.valuesArray) {
          this._sanitizeEntitySync(entitySync);
          pendingUpdates.push(entitySync);
        }
      }

      const coalescedUpdates = this._coalesceRemovalDominatedSyncs(pendingUpdates);
      for (let i = 0; i < coalescedUpdates.length; i++) {
        const entitySync = coalescedUpdates[i];
        (this._isReliableEntitySync(entitySync) ? reliableUpdates : unreliableUpdates).push(entitySync);
      }

      if (reliableUpdates.length > 0) {
        this._appendPerPlayerSlotPacket(
          slot,
          player,
          protocol.createPacket(protocol.outboundPackets.entitiesPacketDefinition, reliableUpdates, currentTick),
        );
      }

      if (unreliableUpdates.length > 0) {
        this._appendPerPlayerUnreliablePacket(
          packetPlan,
          player,
          protocol.createPacket(protocol.outboundPackets.entitiesPacketDefinition, unreliableUpdates, currentTick),
        );
      }
    }

    return this._hasReliablePacketSlotPackets(slot) ? slot : undefined;
  }

  private _buildSpatialSyncPacketSlot<TKey, TId extends PacketId, TSchema extends { i?: number; rm?: boolean }>(
    syncQueue: SyncQueue<TKey, TSchema>,
    packetDefinition: IPacketDefinition<TId, TSchema[]>,
    currentTick: number,
    loadedIdsByPlayer: Map<Player, Set<number>>,
  ): ReliablePacketSlot | undefined {
    const slot: ReliablePacketSlot = {};
    const hostOwnsDerivedState = WorldHostManager.instance.client.ownsDerivedState(this._world);
    const targetPlayers = hostOwnsDerivedState
      ? Array.from(syncQueue.perPlayer.keys())
      : PlayerManager.instance.getConnectedPlayersByWorldSet(this._world);

    for (const player of targetPlayers) {
      const updates: TSchema[] = [];

      if (!hostOwnsDerivedState && syncQueue.broadcast.size > 0) {
        const loadedIds = loadedIdsByPlayer.get(player);
        if (loadedIds && loadedIds.size > 0) {
          for (const sync of syncQueue.broadcast.valuesArray) {
            if (sync.i !== undefined && loadedIds.has(sync.i)) {
              updates.push(sync);
            }
          }
        }
      }

      const perPlayerSync = syncQueue.perPlayer.get(player);
      if (perPlayerSync && perPlayerSync.size > 0) {
        updates.push(...perPlayerSync.valuesArray);
      }

      const coalescedUpdates = this._coalesceRemovalDominatedSyncs(updates);
      if (coalescedUpdates.length > 0) {
        this._appendPerPlayerSlotPacket(
          slot,
          player,
          protocol.createPacket(packetDefinition, coalescedUpdates, currentTick),
        );
      }
    }

    return this._hasReliablePacketSlotPackets(slot) ? slot : undefined;
  }

  private _buildSingletonSyncPacketSlot<TId extends PacketId, TSchema extends object | null>(
    singletonSyncQueue: SingletonSyncQueue<TSchema>,
    packetDefinition: IPacketDefinition<TId, TSchema>,
    currentTick: number,
  ): ReliablePacketSlot | undefined {
    const slot: ReliablePacketSlot = {};

    if (singletonSyncQueue.broadcast !== undefined) {
      slot.sharedPackets = [
        protocol.createPacket(packetDefinition, singletonSyncQueue.broadcast, currentTick),
      ];
    }

    if (singletonSyncQueue.perPlayer.size > 0) {
      for (const [ player, sync ] of singletonSyncQueue.perPlayer.entries()) {
        this._appendPerPlayerSlotPacket(
          slot,
          player,
          protocol.createPacket(packetDefinition, sync, currentTick),
        );
      }
    }

    return this._hasReliablePacketSlotPackets(slot) ? slot : undefined;
  }

  private _buildSyncPacketSlot<TKey, TId extends PacketId, TSchema extends object | null>(
    syncQueue: SyncQueue<TKey, TSchema>,
    packetDefinition: IPacketDefinition<TId, TSchema[]>,
    currentTick: number,
  ): ReliablePacketSlot | undefined {
    const slot: ReliablePacketSlot = {};

    if (syncQueue.broadcast.size > 0) {
      slot.sharedPackets = [
        protocol.createPacket(packetDefinition, syncQueue.broadcast.valuesArray, currentTick),
      ];
    }

    if (syncQueue.perPlayer.size > 0) {
      for (const [ player, sync ] of syncQueue.perPlayer.entries()) {
        this._appendPerPlayerSlotPacket(
          slot,
          player,
          protocol.createPacket(packetDefinition, sync.valuesArray, currentTick),
        );
      }
    }

    return this._hasReliablePacketSlotPackets(slot) ? slot : undefined;
  }

  private _hasReliablePacketSlotPackets(slot: ReliablePacketSlot): boolean {
    return (slot.sharedPackets?.length ?? 0) > 0 || (slot.perPlayerPackets?.size ?? 0) > 0;
  }

  private _pushReliablePacketSlot(slots: ReliablePacketSlot[], slot: ReliablePacketSlot | undefined): void {
    if (slot) {
      slots.push(slot);
    }
  }

  private _sendPacketPlan(packetPlan: PacketPlan, currentTick: number): void {
    Telemetry.startSpan({ operation: TelemetrySpanOperation.SEND_ALL_PACKETS }, () => {
      for (const player of PlayerManager.instance.getConnectedPlayersByWorldSet(this._world)) {
        const session = GatewayPlayerSessionManager.instance.getSessionByPlayer(player);
        if (!session) {
          continue;
        }

        this._sendHostedEntitiesToPlayer(session, player, currentTick);
        this._sendReliableSlotsToPlayer(session, player, packetPlan.prePlayerUISpecialReliableSlots);
        this._sendHostedCameraToPlayer(session, player, currentTick);
        this._sendReliableSlotsToPlayer(session, player, packetPlan.prePlayerUIReliableSlots);
        this._sendHostedUIToPlayer(session, player, currentTick);
        this._sendReliableSlotsToPlayer(session, player, packetPlan.postPlayerUIBeforeWorldAndPlayersReliableSlots);
        this._sendHostedWorldToPlayer(session, player, currentTick);
        this._sendHostedPlayersToPlayer(session, player, currentTick);
        this._sendHostedChatToPlayer(session, player, currentTick);
        this._sendReliableSlotsToPlayer(session, player, packetPlan.postPlayerUIAfterChatReliableSlots);

        if (packetPlan.sharedUnreliablePackets.length > 0) {
          WorldHostManager.instance.client.sendPacketsToPlayer(session, packetPlan.sharedUnreliablePackets, false);
        }

        const perPlayerUnreliablePackets = packetPlan.perPlayerUnreliablePackets.get(player);
        if (perPlayerUnreliablePackets && perPlayerUnreliablePackets.length > 0) {
          WorldHostManager.instance.client.sendPacketsToPlayer(session, perPlayerUnreliablePackets, false);
        }
      }
    });
  }

  private _sendHostedCameraToPlayer(
    session: GatewayPlayerSession,
    player: Player,
    currentTick: number,
  ): void {
    this._sendHostedSingletonSyncToPlayer(
      session,
      player,
      currentTick,
      this._queuedCameraSyncs,
      (targetSession, sync, tick) => WorldHostManager.instance.client.sendCameraToPlayer(targetSession, sync, tick),
    );
  }

  private _sendHostedEntitiesToPlayer(
    session: GatewayPlayerSession,
    player: Player,
    currentTick: number,
  ): void {
    if (!WorldHostManager.instance.client.ownsDerivedState(this._world)) {
      return;
    }

    this._sendHostedSyncQueueToPlayer(
      session,
      player,
      currentTick,
      this._queuedEntitySyncs,
      (targetSession, sync, tick) => {
        for (let i = 0; i < sync.length; i++) {
          this._sanitizeEntitySync(sync[i]);
        }

        WorldHostManager.instance.client.sendEntitiesToPlayer(targetSession, sync, tick);
      },
    );
  }

  private _sendHostedUIToPlayer(
    session: GatewayPlayerSession,
    player: Player,
    currentTick: number,
  ): void {
    this._sendHostedSingletonSyncToPlayer(
      session,
      player,
      currentTick,
      this._queuedUISyncs,
      (targetSession, sync, tick) => WorldHostManager.instance.client.sendUIToPlayer(targetSession, sync, tick),
    );
    this._sendHostedSingletonSyncToPlayer(
      session,
      player,
      currentTick,
      this._queuedUIDatasSyncs,
      (targetSession, sync, tick) => WorldHostManager.instance.client.sendUIDataToPlayer(targetSession, sync, tick),
    );
  }

  private _sendHostedPlayersToPlayer(
    session: GatewayPlayerSession,
    player: Player,
    currentTick: number,
  ): void {
    this._sendHostedSyncQueueToPlayer(
      session,
      player,
      currentTick,
      this._queuedPlayerSyncs,
      (targetSession, sync, tick) => WorldHostManager.instance.client.sendPlayersToPlayer(targetSession, sync, tick),
    );
  }

  private _sendHostedWorldToPlayer(
    session: GatewayPlayerSession,
    player: Player,
    currentTick: number,
  ): void {
    this._sendHostedSingletonSyncToPlayer(
      session,
      player,
      currentTick,
      this._queuedWorldSyncs,
      (targetSession, sync, tick) => WorldHostManager.instance.client.sendWorldToPlayer(targetSession, sync, tick),
    );
  }

  private _sendHostedChatToPlayer(
    session: GatewayPlayerSession,
    player: Player,
    currentTick: number,
  ): void {
    this._sendHostedSingletonSyncToPlayer(
      session,
      player,
      currentTick,
      this._queuedChatMessagesSyncs,
      (targetSession, sync, tick) => WorldHostManager.instance.client.sendChatMessagesToPlayer(targetSession, sync, tick),
    );
  }

  private _sendHostedSingletonSyncToPlayer<TSchema extends object | null>(
    session: GatewayPlayerSession,
    player: Player,
    currentTick: number,
    syncQueue: SingletonSyncQueue<TSchema>,
    sendSync: (session: GatewayPlayerSession, sync: TSchema, currentTick: number) => void,
  ): void {
    if (syncQueue.broadcast !== undefined) {
      sendSync(session, syncQueue.broadcast, currentTick);
    }

    const perPlayerSync = syncQueue.perPlayer.get(player);
    if (perPlayerSync !== undefined) {
      sendSync(session, perPlayerSync, currentTick);
    }
  }

  private _sendHostedSyncQueueToPlayer<TKey, TSchema extends object | null>(
    session: GatewayPlayerSession,
    player: Player,
    currentTick: number,
    syncQueue: SyncQueue<TKey, TSchema>,
    sendSync: (session: GatewayPlayerSession, sync: TSchema[], currentTick: number) => void,
  ): void {
    const combinedSync: TSchema[] = [];

    if (syncQueue.broadcast.size > 0) {
      combinedSync.push(...syncQueue.broadcast.valuesArray);
    }

    const perPlayerSync = syncQueue.perPlayer.get(player);
    if (perPlayerSync && perPlayerSync.size > 0) {
      combinedSync.push(...perPlayerSync.valuesArray);
    }

    if (combinedSync.length > 0) {
      sendSync(session, combinedSync, currentTick);
    }
  }

  private _sendReliableSlotsToPlayer(
    session: GatewayPlayerSession,
    player: Player,
    slots: ReliablePacketSlot[],
  ): void {
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];

      if (slot.sharedPackets && slot.sharedPackets.length > 0) {
        WorldHostManager.instance.client.sendPacketsToPlayer(session, slot.sharedPackets);
      }

      const perPlayerPackets = slot.perPlayerPackets?.get(player);
      if (perPlayerPackets && perPlayerPackets.length > 0) {
        WorldHostManager.instance.client.sendPacketsToPlayer(session, perPlayerPackets);
      }
    }
  }

  private _mirrorWorldStatePatch(world: protocol.WorldSchema): boolean {
    return WorldHostManager.instance.client.updateWorldState(this._world, world, this._world.loop.currentTick);
  }

  private _mirrorSceneUIStatePatch(sceneUI: protocol.SceneUISchema): boolean {
    return WorldHostManager.instance.client.updateSceneUIState(this._world, sceneUI, this._world.loop.currentTick);
  }

  private _mirrorBlockTypeStatePatch(blockType: protocol.BlockTypeSchema): boolean {
    return WorldHostManager.instance.client.updateBlockTypeState(this._world, blockType, this._world.loop.currentTick);
  }

  private _mirrorChunkStatePatch(chunk: protocol.ChunkSchema): boolean {
    return WorldHostManager.instance.client.updateChunkState(this._world, chunk, this._world.loop.currentTick);
  }

  private _mirrorBlockStatePatch(block: protocol.BlockSchema): boolean {
    return WorldHostManager.instance.client.updateBlockState(this._world, block, this._world.loop.currentTick);
  }

  private _mirrorEntityStatePatch(entity: protocol.EntitySchema): boolean {
    return WorldHostManager.instance.client.updateEntityState(this._world, entity, this._world.loop.currentTick);
  }

  private _mirrorParticleEmitterStatePatch(particleEmitter: protocol.ParticleEmitterSchema): boolean {
    return WorldHostManager.instance.client.updateParticleEmitterState(
      this._world,
      particleEmitter,
      this._world.loop.currentTick,
    );
  }

  private _mirrorAudioStatePatch(audio: protocol.AudioSchema): boolean {
    return WorldHostManager.instance.client.updateAudioState(this._world, audio, this._world.loop.currentTick);
  }

  private _removeMirroredAudioState(audioId: number): boolean {
    return WorldHostManager.instance.client.removeAudioState(this._world, audioId);
  }

  private _sanitizeEntitySync(entitySync: protocol.EntitySchema): void {
    if (PROTOCOL_ENTITY_KEYS.length === 0) {
      return;
    }

    for (const key in entitySync) {
      if (!Object.prototype.hasOwnProperty.call(PROTOCOL_ENTITY_PROPERTIES, key)) {
        delete (entitySync as Record<string, unknown>)[key];
      }
    }
  }

  private _isReliableEntitySync(entitySync: protocol.EntitySchema): boolean {
    for (const key in entitySync) {
      if (
        key !== 'i' &&
        key !== 'p' &&
        key !== 'r' &&
        !UNRELIABLE_OWNER_PREDICTION_ENTITY_SYNC_KEYS.has(key)
      ) {
        return true;
      }
    }

    return false;
  }

  private _syncPlayerCameraAttachedEntityModel(playerCamera: PlayerCamera): void {
    const entity = playerCamera.attachedToEntity;
    const modelUri = entity && (playerCamera.mode === PlayerCameraMode.FIRST_PERSON ? playerCamera.viewModelUri : entity.modelUri);
  
    if (entity && modelUri) {
      this._createOrGetQueuedEntitySync(entity, playerCamera.player).m = modelUri;
    }
  }

  private _queuePlayerEntityOwnerPredictionState(
    entitySync: protocol.EntitySchema & {
      aq?: number;
      fd?: boolean;
      ju?: number;
      js?: number;
      mv?: protocol.VectorSchema;
      pf?: number;
      py?: number;
      rv?: number;
      sc?: number;
      sf?: number;
      sl?: number;
      su?: number;
      wv?: number;
    },
    playerEntity: PlayerEntity,
  ): void {
    const controller = playerEntity.controller;

    if (!(controller instanceof DefaultPlayerEntityController)) {
      return;
    }

    let predictionFlags = 0;
    if (controller.isGrounded) {
      predictionFlags |= ENTITY_LOCAL_PREDICTION_FLAG_GROUNDED;
    }
    if (controller.isSwimming) {
      predictionFlags |= ENTITY_LOCAL_PREDICTION_FLAG_SWIMMING;
    }

    entitySync.fd = controller.localPredictionFastMovementByDefault || undefined;
    entitySync.ju = controller.jumpVelocity;
    entitySync.pf = predictionFlags;
    entitySync.py = controller.localPredictionMovementReferenceYaw;
    entitySync.rv = controller.runVelocity;
    entitySync.mv = Serializer.serializeVector(controller.localPredictionMotionBasisVelocity);
    entitySync.sf = controller.swimFastVelocity;
    entitySync.sl = controller.swimSlowVelocity;
    entitySync.su = controller.swimUpwardVelocity;
    entitySync.js = undefined;
    entitySync.sc = undefined;
    entitySync.wv = controller.walkVelocity;

    const justSubmergedRemainingMs = controller.localPredictionJustSubmergedRemainingMs;
    if (justSubmergedRemainingMs > 0) {
      entitySync.js = justSubmergedRemainingMs;
    }

    const swimUpwardCooldownRemainingMs = controller.localPredictionSwimUpwardCooldownRemainingMs;
    if (swimUpwardCooldownRemainingMs > 0) {
      entitySync.sc = swimUpwardCooldownRemainingMs;
    }
  }

  private _queueOwnerPlayerEntityPredictionSync(
    playerEntity: PlayerEntity,
    includeTransform: boolean = false,
  ): void {
    const entitySync = this._createOrGetQueuedEntitySync(playerEntity, playerEntity.player) as protocol.EntitySchema & {
      aq?: number;
      fd?: boolean;
      ju?: number;
      js?: number;
      mv?: protocol.VectorSchema;
      pf?: number;
      py?: number;
      rv?: number;
      sc?: number;
      sf?: number;
      sl?: number;
      su?: number;
      wv?: number;
    };

    // Owner prediction metadata needs to stay paired with every authoritative
    // owner transform/ack update. Omitting it on active movement syncs leaves
    // the client replaying from stale grounded/reference-yaw/motion-basis state.
    this._queuePlayerEntityOwnerPredictionState(entitySync, playerEntity);

    if (includeTransform) {
      entitySync.p ??= Serializer.serializeVector(playerEntity.position);
      entitySync.r ??= Serializer.serializeQuaternion(playerEntity.rotation);
    }

    const acknowledgedInputSequence = playerEntity.player.lastAppliedInputSequenceNumber;
    if (acknowledgedInputSequence !== undefined) {
      entitySync.aq = acknowledgedInputSequence;
    }
  }

  private _queuePlayerInputAcknowledgements(): void {
    for (const playerEntity of this._world.entityManager.playerEntities) {
      if (!playerEntity.isSpawned || playerEntity.id === undefined) {
        continue;
      }

      if (playerEntity.player.world !== this._world) {
        continue;
      }

      const acknowledgedInputSequence = playerEntity.player.lastAppliedInputSequenceNumber;
      if (acknowledgedInputSequence === undefined) {
        continue;
      }

      const lastSentAcknowledgement = this._lastSentInputAcknowledgementByPlayer.get(playerEntity.player);
      const acknowledgementSequenceChanged =
        lastSentAcknowledgement?.sequenceNumber !== acknowledgedInputSequence;
      const resendSyncsRemaining = lastSentAcknowledgement?.resendSyncsRemaining ?? 0;
      if (!acknowledgementSequenceChanged && resendSyncsRemaining <= 0) {
        continue;
      }

      const entitySync = this._createOrGetQueuedEntitySync(playerEntity, playerEntity.player) as protocol.EntitySchema & {
        aq?: number;
      };
      this._queuePlayerEntityOwnerPredictionState(entitySync, playerEntity);
      entitySync.aq = acknowledgedInputSequence;
      entitySync.p ??= Serializer.serializeVector(playerEntity.position);
      entitySync.r ??= Serializer.serializeQuaternion(playerEntity.rotation);
      this._lastSentInputAcknowledgementByPlayer.set(playerEntity.player, {
        resendSyncsRemaining: acknowledgementSequenceChanged
          ? INPUT_ACK_UNRELIABLE_RESEND_SYNCS
          : Math.max(0, resendSyncsRemaining - 1),
        sequenceNumber: acknowledgedInputSequence,
      });
    }
  }

  private _getTargetNetworkSyncRate(): number {
    if (Number.isFinite(NETWORK_SYNC_RATE_OVERRIDE) && NETWORK_SYNC_RATE_OVERRIDE > 0) {
      return Math.min(DEFAULT_TICK_RATE, NETWORK_SYNC_RATE_OVERRIDE);
    }

    const playerCount = PlayerManager.instance.getConnectedPlayersByWorldSet(this._world).size;
    return playerCount <= HIGH_FREQUENCY_SYNC_MAX_PLAYERS
      ? HIGH_FREQUENCY_NETWORK_SYNC_RATE
      : DEFAULT_NETWORK_SYNC_RATE;
  }
}
