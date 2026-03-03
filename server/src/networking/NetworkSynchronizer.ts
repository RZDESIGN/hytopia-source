import protocol from '@hytopia.com/server-protocol';
import ErrorHandler from '@/errors/ErrorHandler';
import IterationMap from '@/shared/classes/IterationMap';
import Telemetry, { TelemetrySpanOperation } from '@/metrics/Telemetry';
import { DEFAULT_TICK_RATE } from '@/worlds/physics/Simulation';
import type { AnyPacket, IPacket, IPacketDefinition, PacketId } from '@hytopia.com/server-protocol';
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
import { ParticleEmitterEvent } from '@/worlds/particles/ParticleEmitter';
import { PlayerEvent } from '@/players/Player';
import { PlayerCameraEvent, PlayerCameraMode } from '@/players/PlayerCamera';
import { PlayerUIEvent } from '@/players/PlayerUI';
import { SceneUIEvent } from '@/worlds/ui/SceneUI';
import { SimulationEvent } from '@/worlds/physics/Simulation';
import { WorldEvent } from '@/worlds/World';
import type Audio from '@/worlds/audios/Audio';
import type BlockType from '@/worlds/blocks/BlockType';
import type Chunk from '@/worlds/blocks/Chunk';
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
const TICKS_PER_NETWORK_SYNC = Math.round(DEFAULT_TICK_RATE / DEFAULT_NETWORK_SYNC_RATE); // eg 60hz / 30hz = 2 tick syncs
const PROTOCOL_ENTITY_SCHEMA = (protocol as unknown as { entitySchema?: { properties?: Record<string, unknown> } }).entitySchema;
const PROTOCOL_SUPPORTS_ENTITY_INPUT_ACK = Object.prototype.hasOwnProperty.call(
  PROTOCOL_ENTITY_SCHEMA?.properties ?? {},
  'aq',
);

type SyncQueue<TId, TSchema extends object | null> = {
  broadcast: IterationMap<TId, TSchema>;
  perPlayer: IterationMap<Player, IterationMap<TId, TSchema>>;
};

type SingletonSyncQueue<TSchema extends object | null> = {
  broadcast: TSchema | undefined;
  perPlayer: IterationMap<Player, TSchema>;
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

  private _outboundPerPlayerReliablePackets: IterationMap<Player, IPacket<number, any>[]> = new IterationMap();
  private _outboundSharedReliablePackets: AnyPacket[] = [];
  private _outboundSharedUnreliablePackets: AnyPacket[] = [];

  private _queuedAudioSyncs: SyncQueue<number, protocol.AudioSchema> = { broadcast: new IterationMap(), perPlayer: new IterationMap() };
  private _queuedBlockSyncs: SyncQueue<string, protocol.BlockSchema> = { broadcast: new IterationMap(), perPlayer: new IterationMap() };
  private _queuedBlockTypeSyncs: SyncQueue<number, protocol.BlockTypeSchema> = { broadcast: new IterationMap(), perPlayer: new IterationMap() };
  private _queuedChunkSyncs: SyncQueue<string, protocol.ChunkSchema> = { broadcast: new IterationMap(), perPlayer: new IterationMap() };
  private _queuedEntitySyncs: SyncQueue<number, protocol.EntitySchema> = { broadcast: new IterationMap(), perPlayer: new IterationMap() };
  private _queuedParticleEmitterSyncs: SyncQueue<number, protocol.ParticleEmitterSchema> = { broadcast: new IterationMap(), perPlayer: new IterationMap() };
  private _queuedPlayerSyncs: SyncQueue<string, protocol.PlayerSchema> = { broadcast: new IterationMap(), perPlayer: new IterationMap() };
  private _queuedSceneUISyncs: SyncQueue<number, protocol.SceneUISchema> = { broadcast: new IterationMap(), perPlayer: new IterationMap() };
  
  private _queuedCameraSyncs: SingletonSyncQueue<protocol.CameraSchema> = { broadcast: undefined, perPlayer: new IterationMap() };
  private _queuedChatMessagesSyncs: SingletonSyncQueue<protocol.ChatMessagesSchema> = { broadcast: undefined, perPlayer: new IterationMap() };
  private _queuedDebugRaycastsSyncs: SingletonSyncQueue<protocol.PhysicsDebugRaycastsSchema> = { broadcast: undefined, perPlayer: new IterationMap() };
  private _queuedDebugRenderSyncs: SingletonSyncQueue<protocol.PhysicsDebugRenderSchema> = { broadcast: undefined, perPlayer: new IterationMap() };
  private _queuedNotificationPermissionRequestSyncs: SingletonSyncQueue<protocol.NotificationPermissionRequestSchema> = { broadcast: undefined, perPlayer: new IterationMap() };
  private _queuedUISyncs: SingletonSyncQueue<protocol.UISchema> = { broadcast: undefined, perPlayer: new IterationMap() };
  private _queuedUIDatasSyncs: SingletonSyncQueue<protocol.UIDatasSchema> = { broadcast: undefined, perPlayer: new IterationMap() };
  private _queuedWorldSyncs: SingletonSyncQueue<protocol.WorldSchema> = { broadcast: undefined, perPlayer: new IterationMap() };
  
  private _loadedSceneUIs: Set<number> = new Set();
  private _spawnedChunks: Set<string> = new Set();
  private _spawnedEntities: Set<number> = new Set();

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
    // Only synchronize at the defined rate, less than physics step rate
    // to balance performance & network i/o work.
    return this._world.loop.currentTick % TICKS_PER_NETWORK_SYNC === 0;
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

    // 1. entities
    /**
     * Entity synchronizations specific to rotational and positional updates
     * account for 90%+ of all packets sent. Because these are not deltas and 
     * send as full position / rotation updates, we can send them over the
     * unreliable channel to drastically reduce blocking on the client and stutter
     * in poor network conditions. To do this, we split the entity synchronizations
     * into two arrays, one for reliable updates and one for unreliable updates.
     */
    if (this._queuedEntitySyncs.broadcast.size > 0) {
      const reliableUpdates: protocol.EntitySchema[] = [];
      const unreliableUpdates: protocol.EntitySchema[] = [];

      for (const entitySync of this._queuedEntitySyncs.broadcast.valuesArray) {
        let isReliableUpdate = false;
        
        for (const key in entitySync) {
          isReliableUpdate = key !== 'i' && key !== 'p' && key !== 'r';
          if (isReliableUpdate) { break; }
        }

        (isReliableUpdate ? reliableUpdates : unreliableUpdates).push(entitySync);
      }

      if (unreliableUpdates.length > 0) {
        const unreliablePacket = protocol.createPacket(protocol.outboundPackets.entitiesPacketDefinition, unreliableUpdates, currentTick);
        this._outboundSharedUnreliablePackets.push(unreliablePacket);
      }
      
      if (reliableUpdates.length > 0) {
        const reliablePacket = protocol.createPacket(protocol.outboundPackets.entitiesPacketDefinition, reliableUpdates, currentTick);
        this._outboundSharedReliablePackets.push(reliablePacket);
        for (const packets of this._outboundPerPlayerReliablePackets.valuesArray) { packets.push(reliablePacket); }
      }
    }

    if (this._queuedEntitySyncs.perPlayer.size > 0) {
      for (const [ player, entitySyncs ] of this._queuedEntitySyncs.perPlayer.entries()) {
        this._outboundPerPlayerReliablePackets.get(player)?.push(
          protocol.createPacket(protocol.outboundPackets.entitiesPacketDefinition, entitySyncs.valuesArray, currentTick),
        );
      }
    }

    // 2. Camera
    this._collectSingletonSyncToOutboundPackets(this._queuedCameraSyncs, protocol.outboundPackets.cameraPacketDefinition);

    // 3. Audios
    this._collectSyncToOutboundPackets(this._queuedAudioSyncs, protocol.outboundPackets.audiosPacketDefinition);

    // 4. block types
    this._collectSyncToOutboundPackets(this._queuedBlockTypeSyncs, protocol.outboundPackets.blockTypesPacketDefinition);

    // 5. chunks
    this._collectSyncToOutboundPackets(this._queuedChunkSyncs, protocol.outboundPackets.chunksPacketDefinition);

    // 6. blocks
    this._collectSyncToOutboundPackets(this._queuedBlockSyncs, protocol.outboundPackets.blocksPacketDefinition);
    
    // 7. particle emitters
    this._collectSyncToOutboundPackets(this._queuedParticleEmitterSyncs, protocol.outboundPackets.particleEmittersPacketDefinition);

    // 8. player UIs
    this._collectSingletonSyncToOutboundPackets(this._queuedUISyncs, protocol.outboundPackets.uiPacketDefinition);

    // 9. player UI datas
    this._collectSingletonSyncToOutboundPackets(this._queuedUIDatasSyncs, protocol.outboundPackets.uiDatasPacketDefinition);
    
    // 10. scene UIs
    this._collectSyncToOutboundPackets(this._queuedSceneUISyncs, protocol.outboundPackets.sceneUIsPacketDefinition);

    // 11. world
    this._collectSingletonSyncToOutboundPackets(this._queuedWorldSyncs, protocol.outboundPackets.worldPacketDefinition);

    // 12. players
    this._collectSyncToOutboundPackets(this._queuedPlayerSyncs, protocol.outboundPackets.playersPacketDefinition);

    // 13. chat messages
    this._collectSingletonSyncToOutboundPackets(this._queuedChatMessagesSyncs, protocol.outboundPackets.chatMessagesPacketDefinition);

    // 14. notification permission request
    this._collectSingletonSyncToOutboundPackets(this._queuedNotificationPermissionRequestSyncs, protocol.outboundPackets.notificationPermissionRequestPacketDefinition);

    // 15. debug renders
    this._collectSingletonSyncToOutboundPackets(this._queuedDebugRenderSyncs, protocol.outboundPackets.physicsDebugRenderPacketDefinition);

    // 16. debug raycasts
    this._collectSingletonSyncToOutboundPackets(this._queuedDebugRaycastsSyncs, protocol.outboundPackets.physicsDebugRaycastsPacketDefinition);

    /*
     * Send packets to players
     */
    Telemetry.startSpan({ operation: TelemetrySpanOperation.SEND_ALL_PACKETS }, () => {
      for (const player of PlayerManager.instance.getConnectedPlayersByWorld(this._world)) {
        const reliablePackets = this._outboundPerPlayerReliablePackets.get(player) ?? this._outboundSharedReliablePackets;

        if (reliablePackets.length > 0) {
          player.connection.send(reliablePackets);
        }

        if (this._outboundSharedUnreliablePackets.length > 0) {
          player.connection.send(this._outboundSharedUnreliablePackets, false);
        }
      }
    });

    /*
     * Clear sync queues - We only clear queues if they aren't empty,
     * otherwise it causes significant memory growth and triggers unnecessary major GCs.
     */
    Telemetry.startSpan({ operation: TelemetrySpanOperation.NETWORK_SYNCHRONIZE_CLEANUP }, () => {
      if (this._outboundPerPlayerReliablePackets.size > 0) { this._outboundPerPlayerReliablePackets.clear(); }
      if (this._outboundSharedReliablePackets.length > 0) { this._outboundSharedReliablePackets.length = 0; }
      if (this._outboundSharedUnreliablePackets.length > 0) { this._outboundSharedUnreliablePackets.length = 0; }
      if (this._loadedSceneUIs.size > 0) { this._loadedSceneUIs.clear(); }
      if (this._spawnedChunks.size > 0) { this._spawnedChunks.clear(); }
      if (this._spawnedEntities.size > 0) { this._spawnedEntities.clear(); }

      this._clearSyncQueue(this._queuedAudioSyncs);
      this._clearSyncQueue(this._queuedBlockSyncs);
      this._clearSyncQueue(this._queuedBlockTypeSyncs);
      this._clearSyncQueue(this._queuedChunkSyncs);
      this._clearSyncQueue(this._queuedEntitySyncs);
      this._clearSyncQueue(this._queuedParticleEmitterSyncs);
      this._clearSyncQueue(this._queuedPlayerSyncs);
      this._clearSyncQueue(this._queuedSceneUISyncs);
      
      this._clearSingletonSyncQueue(this._queuedCameraSyncs);
      this._clearSingletonSyncQueue(this._queuedChatMessagesSyncs);
      this._clearSingletonSyncQueue(this._queuedDebugRaycastsSyncs);
      this._clearSingletonSyncQueue(this._queuedDebugRenderSyncs);
      this._clearSingletonSyncQueue(this._queuedNotificationPermissionRequestSyncs);
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
    this._world.final(PlayerEvent.JOINED_WORLD, this._onPlayerJoinedWorld);
    this._world.final(PlayerEvent.LEFT_WORLD, this._onPlayerLeftWorld);
    this._world.final(PlayerEvent.RECONNECTED_WORLD, this._onPlayerReconnectedWorld);
    this._world.final(PlayerEvent.REQUEST_NOTIFICATION_PERMISSION, this._onPlayerRequestNotificationPermission);
    this._world.final(PlayerEvent.REQUEST_SYNC, this._onPlayerRequestSync);
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
    const audioSync = this._createOrGetQueuedAudioSync(payload.audio);
    audioSync.pa = true;
    delete audioSync.pl;
    delete audioSync.r;
  };

  private _onAudioPlay = (payload: EventPayloads[AudioEvent.PLAY]) => {
    const audioSync = this._createOrGetQueuedAudioSync(payload.audio);
    Object.assign(audioSync, payload.audio.serialize());
    audioSync.pl = true;
    delete audioSync.pa;
    delete audioSync.r;
  };

  private _onAudioPlayRestart = (payload: EventPayloads[AudioEvent.PLAY_RESTART]) => {
    const audioSync = this._createOrGetQueuedAudioSync(payload.audio);
    Object.assign(audioSync, payload.audio.serialize());
    audioSync.r = true;
    delete audioSync.pa;
    delete audioSync.pl;
  };

  private _onAudioSetAttachedToEntity = (payload: EventPayloads[AudioEvent.SET_ATTACHED_TO_ENTITY]) => {
    const audioSync = this._createOrGetQueuedAudioSync(payload.audio);
    audioSync.e = payload.entity ? payload.entity.id : undefined;
    audioSync.p = payload.entity ? undefined : audioSync.p;
  };

  private _onAudioSetCutoffDistance = (payload: EventPayloads[AudioEvent.SET_CUTOFF_DISTANCE]) => {
    const audioSync = this._createOrGetQueuedAudioSync(payload.audio);
    audioSync.cd = payload.cutoffDistance;
  };

  private _onAudioSetDetune = (payload: EventPayloads[AudioEvent.SET_DETUNE]) => {
    const audioSync = this._createOrGetQueuedAudioSync(payload.audio);
    audioSync.de = payload.detune;
  };

  private _onAudioSetDistortion = (payload: EventPayloads[AudioEvent.SET_DISTORTION]) => {
    const audioSync = this._createOrGetQueuedAudioSync(payload.audio);
    audioSync.di = payload.distortion;
  };

  private _onAudioSetPosition = (payload: EventPayloads[AudioEvent.SET_POSITION]) => {
    const audioSync = this._createOrGetQueuedAudioSync(payload.audio);
    audioSync.e = payload.position ? undefined : audioSync.e;
    audioSync.p = payload.position ? Serializer.serializeVector(payload.position) : undefined;
  };

  private _onAudioSetPlaybackRate = (payload: EventPayloads[AudioEvent.SET_PLAYBACK_RATE]) => {
    const audioSync = this._createOrGetQueuedAudioSync(payload.audio);
    audioSync.pr = payload.playbackRate;
  };

  private _onAudioSetReferenceDistance = (payload: EventPayloads[AudioEvent.SET_REFERENCE_DISTANCE]) => {
    const audioSync = this._createOrGetQueuedAudioSync(payload.audio);
    audioSync.rd = payload.referenceDistance;
  };

  private _onAudioSetVolume = (payload: EventPayloads[AudioEvent.SET_VOLUME]) => {
    const audioSync = this._createOrGetQueuedAudioSync(payload.audio);
    audioSync.v = payload.volume;
  };

  private _onBlockTypeRegistryRegisterBlockType = (payload: EventPayloads[BlockTypeRegistryEvent.REGISTER_BLOCK_TYPE]) => {
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
    const chunkSync = this._createOrGetQueuedChunkSync(payload.chunk);
    Object.assign(chunkSync, payload.chunk.serialize());
    chunkSync.rm = undefined;

    this._spawnedChunks.add(chunkSync.c.join(','));
  };

  private _onChunkLatticeRemoveChunk = (payload: EventPayloads[ChunkLatticeEvent.REMOVE_CHUNK]) => {
    const chunkSync = this._createOrGetQueuedChunkSync(payload.chunk);
    const chunkKey = chunkSync.c.join(',');

    if (this._spawnedChunks.has(chunkKey)) {
      this._queuedChunkSyncs.broadcast.delete(chunkKey);
      this._spawnedChunks.delete(chunkKey);
    } else {
      chunkSync.rm = true;
    }
  };

  private _onChunkLatticeSetBlock = (payload: EventPayloads[ChunkLatticeEvent.SET_BLOCK]) => {
    const blockSync = this._createOrGetQueuedBlockSync(payload.globalCoordinate);
    blockSync.i = payload.blockTypeId;
    blockSync.r = payload.blockRotation?.enumIndex;
  };

  private _onEntitySpawn = (payload: EventPayloads[EntityEvent.SPAWN]) => {
    const entitySync = this._createOrGetQueuedEntitySync(payload.entity);
    Object.assign(entitySync, payload.entity.serialize());
    this._spawnedEntities.add(entitySync.i);
  };

  private _onEntityDespawn = (payload: EventPayloads[EntityEvent.DESPAWN]) => {
    const entitySync = this._createOrGetQueuedEntitySync(payload.entity);

    if (this._spawnedEntities.has(entitySync.i)) {
      this._queuedEntitySyncs.broadcast.delete(entitySync.i);
      this._spawnedEntities.delete(entitySync.i);
    } else {
      entitySync.rm = true;
    }
  };

  private _onEntityRemoveModelNodeOverride = (payload: EventPayloads[EntityEvent.REMOVE_MODEL_NODE_OVERRIDE]) => {
    const entityModelNodeOverrideSync = this._createOrGetQueuedEntityModelNodeOverrideSync(payload.entityModelNodeOverride);
    entityModelNodeOverrideSync.rm = true;
  };

  private _onEntitySetBlockTextureUri = (payload: EventPayloads[EntityEvent.SET_BLOCK_TEXTURE_URI]) => {
    const entitySync = this._createOrGetQueuedEntitySync(payload.entity);
    entitySync.bt = payload.blockTextureUri;
  };

  private _onEntitySetEmissiveColor = (payload: EventPayloads[EntityEvent.SET_EMISSIVE_COLOR]) => {
    const entitySync = this._createOrGetQueuedEntitySync(payload.entity);
    entitySync.ec = payload.emissiveColor ? Serializer.serializeRgbColor(payload.emissiveColor) : undefined;
  };

  private _onEntitySetEmissiveIntensity = (payload: EventPayloads[EntityEvent.SET_EMISSIVE_INTENSITY]) => {
    const entitySync = this._createOrGetQueuedEntitySync(payload.entity);
    entitySync.ei = payload.emissiveIntensity;
  };

  private _onEntitySetModelScale = (payload: EventPayloads[EntityEvent.SET_MODEL_SCALE]) => {
    const entitySync = this._createOrGetQueuedEntitySync(payload.entity);
    entitySync.sv = payload.modelScale ? Serializer.serializeVector(payload.modelScale) : undefined;
  };

  private _onEntitySetModelScaleInterpolationMs = (payload: EventPayloads[EntityEvent.SET_MODEL_SCALE_INTERPOLATION_MS]) => {
    const entitySync = this._createOrGetQueuedEntitySync(payload.entity);
    entitySync.si = payload.interpolationMs;
  };

  private _onEntitySetModelTextureUri = (payload: EventPayloads[EntityEvent.SET_MODEL_TEXTURE_URI]) => {
    const entitySync = this._createOrGetQueuedEntitySync(payload.entity);
    entitySync.mt = payload.modelTextureUri;
  };

  private _onEntitySetOpacity = (payload: EventPayloads[EntityEvent.SET_OPACITY]) => {
    const entitySync = this._createOrGetQueuedEntitySync(payload.entity);
    entitySync.o = payload.opacity;
  };

  private _onEntitySetOutline = (payload: EventPayloads[EntityEvent.SET_OUTLINE]) => {
    const entitySync = this._createOrGetQueuedEntitySync(payload.entity, payload.forPlayer);
    entitySync.ol = payload.outline ? Serializer.serializeOutline(payload.outline) : undefined;
  };

  private _onEntitySetParent = (payload: EventPayloads[EntityEvent.SET_PARENT]) => {
    const entitySync = this._createOrGetQueuedEntitySync(payload.entity);
    entitySync.pe = payload.parent ? payload.parent.id : undefined;
    entitySync.pn = payload.parentNodeName;
  };

  private _onEntitySetPositionInterpolationMs = (payload: EventPayloads[EntityEvent.SET_POSITION_INTERPOLATION_MS]) => {
    const entitySync = this._createOrGetQueuedEntitySync(payload.entity);
    entitySync.pi = payload.interpolationMs;
  };

  private _onEntitySetRotationInterpolationMs = (payload: EventPayloads[EntityEvent.SET_ROTATION_INTERPOLATION_MS]) => {
    const entitySync = this._createOrGetQueuedEntitySync(payload.entity);
    entitySync.ri = payload.interpolationMs;
  };

  private _onEntitySetTintColor = (payload: EventPayloads[EntityEvent.SET_TINT_COLOR]) => {
    const entitySync = this._createOrGetQueuedEntitySync(payload.entity);
    entitySync.t = payload.tintColor ? Serializer.serializeRgbColor(payload.tintColor) : undefined;
  };

  private _onEntityUpdatePosition = (payload: EventPayloads[EntityEvent.UPDATE_POSITION]) => {
    const entitySync = this._createOrGetQueuedEntitySync(payload.entity);
    entitySync.p = [ payload.position.x, payload.position.y, payload.position.z ];
  };

  private _onEntityUpdateRotation = (payload: EventPayloads[EntityEvent.UPDATE_ROTATION]) => {
    const entitySync = this._createOrGetQueuedEntitySync(payload.entity);
    entitySync.r = [ payload.rotation.x, payload.rotation.y, payload.rotation.z, payload.rotation.w ];
  };

  private _onEntityModelAnimationPause = (payload: EventPayloads[EntityModelAnimationEvent.PAUSE]) => {
    const entityModelAnimationSync = this._createOrGetQueuedEntityModelAnimationSync(payload.entityModelAnimation);
    entityModelAnimationSync.pa = true;
    delete entityModelAnimationSync.p;
    delete entityModelAnimationSync.r;
    delete entityModelAnimationSync.s;
  };

  private _onEntityModelAnimationPlay = (payload: EventPayloads[EntityModelAnimationEvent.PLAY]) => {
    const entityModelAnimationSync = this._createOrGetQueuedEntityModelAnimationSync(payload.entityModelAnimation);
    entityModelAnimationSync.p = true;
    delete entityModelAnimationSync.pa;
    delete entityModelAnimationSync.r;
    delete entityModelAnimationSync.s;
  };

  private _onEntityModelAnimationRestart = (payload: EventPayloads[EntityModelAnimationEvent.RESTART]) => {
    const entityModelAnimationSync = this._createOrGetQueuedEntityModelAnimationSync(payload.entityModelAnimation);
    entityModelAnimationSync.r = true;
    delete entityModelAnimationSync.pa;
    delete entityModelAnimationSync.p;
    delete entityModelAnimationSync.s;
  };
  
  private _onEntityModelAnimationSetBlendMode = (payload: EventPayloads[EntityModelAnimationEvent.SET_BLEND_MODE]) => {
    const entityModelAnimationSync = this._createOrGetQueuedEntityModelAnimationSync(payload.entityModelAnimation);
    entityModelAnimationSync.b = payload.blendMode;
  };

  private _onEntityModelAnimationSetClampWhenFinished = (payload: EventPayloads[EntityModelAnimationEvent.SET_CLAMP_WHEN_FINISHED]) => {
    const entityModelAnimationSync = this._createOrGetQueuedEntityModelAnimationSync(payload.entityModelAnimation);
    entityModelAnimationSync.c = payload.clampWhenFinished;
  };

  private _onEntityModelAnimationSetFadesIn = (payload: EventPayloads[EntityModelAnimationEvent.SET_FADES_IN]) => {
    const entityModelAnimationSync = this._createOrGetQueuedEntityModelAnimationSync(payload.entityModelAnimation);
    entityModelAnimationSync.fi = payload.fadesIn;
  };

  private _onEntityModelAnimationSetFadesOut = (payload: EventPayloads[EntityModelAnimationEvent.SET_FADES_OUT]) => {
    const entityModelAnimationSync = this._createOrGetQueuedEntityModelAnimationSync(payload.entityModelAnimation);
    entityModelAnimationSync.fo = payload.fadesOut;
  };

  private _onEntityModelAnimationSetLoopMode = (payload: EventPayloads[EntityModelAnimationEvent.SET_LOOP_MODE]) => {
    const entityModelAnimationSync = this._createOrGetQueuedEntityModelAnimationSync(payload.entityModelAnimation);
    entityModelAnimationSync.l = payload.loopMode;
  };

  private _onEntityModelAnimationSetPlaybackRate = (payload: EventPayloads[EntityModelAnimationEvent.SET_PLAYBACK_RATE]) => {
    const entityModelAnimationSync = this._createOrGetQueuedEntityModelAnimationSync(payload.entityModelAnimation);
    entityModelAnimationSync.pr = payload.playbackRate;
  };
  
  private _onEntityModelAnimationSetWeight = (payload: EventPayloads[EntityModelAnimationEvent.SET_WEIGHT]) => {
    const entityModelAnimationSync = this._createOrGetQueuedEntityModelAnimationSync(payload.entityModelAnimation);
    entityModelAnimationSync.w = payload.weight;
  };

  private _onEntityModelAnimationStop = (payload: EventPayloads[EntityModelAnimationEvent.STOP]) => {
    const entityModelAnimationSync = this._createOrGetQueuedEntityModelAnimationSync(payload.entityModelAnimation);
    entityModelAnimationSync.s = true;
    delete entityModelAnimationSync.p;
    delete entityModelAnimationSync.pa;
    delete entityModelAnimationSync.r;
  };

  private _onEntityModelNodeOverrideSetEmissiveColor = (payload: EventPayloads[EntityModelNodeOverrideEvent.SET_EMISSIVE_COLOR]) => {
    const entityModelNodeOverrideSync = this._createOrGetQueuedEntityModelNodeOverrideSync(payload.entityModelNodeOverride);
    entityModelNodeOverrideSync.ec = payload.emissiveColor ? Serializer.serializeRgbColor(payload.emissiveColor) : undefined;
    delete entityModelNodeOverrideSync.rm;
  };

  private _onEntityModelNodeOverrideSetEmissiveIntensity = (payload: EventPayloads[EntityModelNodeOverrideEvent.SET_EMISSIVE_INTENSITY]) => {
    const entityModelNodeOverrideSync = this._createOrGetQueuedEntityModelNodeOverrideSync(payload.entityModelNodeOverride);
    entityModelNodeOverrideSync.ei = payload.emissiveIntensity;
    delete entityModelNodeOverrideSync.rm;
  };

  private _onEntityModelNodeOverrideSetHidden = (payload: EventPayloads[EntityModelNodeOverrideEvent.SET_HIDDEN]) => {
    const entityModelNodeOverrideSync = this._createOrGetQueuedEntityModelNodeOverrideSync(payload.entityModelNodeOverride);
    entityModelNodeOverrideSync.h = payload.hidden;
    delete entityModelNodeOverrideSync.rm;
  };

  private _onEntityModelNodeOverrideSetLocalPosition = (payload: EventPayloads[EntityModelNodeOverrideEvent.SET_LOCAL_POSITION]) => {
    const entityModelNodeOverrideSync = this._createOrGetQueuedEntityModelNodeOverrideSync(payload.entityModelNodeOverride);
    entityModelNodeOverrideSync.p = payload.localPosition ? Serializer.serializeVector(payload.localPosition) : undefined;
    delete entityModelNodeOverrideSync.rm;
  };

  private _onEntityModelNodeOverrideSetLocalPositionInterpolationMs = (payload: EventPayloads[EntityModelNodeOverrideEvent.SET_LOCAL_POSITION_INTERPOLATION_MS]) => {
    const entityModelNodeOverrideSync = this._createOrGetQueuedEntityModelNodeOverrideSync(payload.entityModelNodeOverride);
    entityModelNodeOverrideSync.pi = payload.interpolationMs;
    delete entityModelNodeOverrideSync.rm;
  };

  private _onEntityModelNodeOverrideSetLocalRotation = (payload: EventPayloads[EntityModelNodeOverrideEvent.SET_LOCAL_ROTATION]) => {
    const entityModelNodeOverrideSync = this._createOrGetQueuedEntityModelNodeOverrideSync(payload.entityModelNodeOverride);
    entityModelNodeOverrideSync.r = payload.localRotation ? Serializer.serializeQuaternion(payload.localRotation) : undefined;
    delete entityModelNodeOverrideSync.rm;
  };

  private _onEntityModelNodeOverrideSetLocalRotationInterpolationMs = (payload: EventPayloads[EntityModelNodeOverrideEvent.SET_LOCAL_ROTATION_INTERPOLATION_MS]) => {
    const entityModelNodeOverrideSync = this._createOrGetQueuedEntityModelNodeOverrideSync(payload.entityModelNodeOverride);
    entityModelNodeOverrideSync.ri = payload.interpolationMs;
    delete entityModelNodeOverrideSync.rm;
  };

  private _onEntityModelNodeOverrideSetLocalScale = (payload: EventPayloads[EntityModelNodeOverrideEvent.SET_LOCAL_SCALE]) => {
    const entityModelNodeOverrideSync = this._createOrGetQueuedEntityModelNodeOverrideSync(payload.entityModelNodeOverride);
    entityModelNodeOverrideSync.s = payload.localScale ? Serializer.serializeVector(payload.localScale) : undefined;
    delete entityModelNodeOverrideSync.rm;
  };

  private _onEntityModelNodeOverrideSetLocalScaleInterpolationMs = (payload: EventPayloads[EntityModelNodeOverrideEvent.SET_LOCAL_SCALE_INTERPOLATION_MS]) => {
    const entityModelNodeOverrideSync = this._createOrGetQueuedEntityModelNodeOverrideSync(payload.entityModelNodeOverride);
    entityModelNodeOverrideSync.si = payload.interpolationMs;
    delete entityModelNodeOverrideSync.rm;
  };

  private _onParticleEmitterBurst = (payload: EventPayloads[ParticleEmitterEvent.BURST]) => {
    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.b = payload.count;
  };

  private _onParticleEmitterDespawn = (payload: EventPayloads[ParticleEmitterEvent.DESPAWN]) => {
    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.rm = true;
  };

  private _onParticleEmitterSetAlphaTest = (payload: EventPayloads[ParticleEmitterEvent.SET_ALPHA_TEST]) => {
    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.at = payload.alphaTest;
  };

  private _onParticleEmitterSetAttachedToEntity = (payload: EventPayloads[ParticleEmitterEvent.SET_ATTACHED_TO_ENTITY]) => {
    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.e = payload.entity ? payload.entity.id : undefined;
    particleEmitterSync.p = payload.entity ? undefined : particleEmitterSync.p;
  };

  private _onParticleEmitterSetAttachedToEntityNodeName = (payload: EventPayloads[ParticleEmitterEvent.SET_ATTACHED_TO_ENTITY_NODE_NAME]) => {
    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.en = payload.attachedToEntityNodeName;
  };

  private _onParticleEmitterSetColorEnd = (payload: EventPayloads[ParticleEmitterEvent.SET_COLOR_END]) => {
    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.ce = payload.colorEnd ? Serializer.serializeRgbColor(payload.colorEnd) : undefined;
  };

  private _onParticleEmitterSetColorEndVariance = (payload: EventPayloads[ParticleEmitterEvent.SET_COLOR_END_VARIANCE]) => {
    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.cev = payload.colorEndVariance ? Serializer.serializeRgbColor(payload.colorEndVariance) : undefined;
  };

  private _onParticleEmitterSetColorIntensityEnd = (payload: EventPayloads[ParticleEmitterEvent.SET_COLOR_INTENSITY_END]) => {
    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.cie = payload.colorIntensityEnd;
  };

  private _onParticleEmitterSetColorIntensityEndVariance = (payload: EventPayloads[ParticleEmitterEvent.SET_COLOR_INTENSITY_END_VARIANCE]) => {
    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.ciev = payload.colorIntensityEndVariance;
  };

  private _onParticleEmitterSetColorIntensityStart = (payload: EventPayloads[ParticleEmitterEvent.SET_COLOR_INTENSITY_START]) => {
    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.cis = payload.colorIntensityStart;
  };

  private _onParticleEmitterSetColorIntensityStartVariance = (payload: EventPayloads[ParticleEmitterEvent.SET_COLOR_INTENSITY_START_VARIANCE]) => {
    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.cisv = payload.colorIntensityStartVariance;
  };

  private _onParticleEmitterSetColorStart = (payload: EventPayloads[ParticleEmitterEvent.SET_COLOR_START]) => {
    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.cs = payload.colorStart ? Serializer.serializeRgbColor(payload.colorStart) : undefined;
  };

  private _onParticleEmitterSetColorStartVariance = (payload: EventPayloads[ParticleEmitterEvent.SET_COLOR_START_VARIANCE]) => {
    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.csv = payload.colorStartVariance ? Serializer.serializeRgbColor(payload.colorStartVariance) : undefined;
  };

  private _onParticleEmitterSetGravity = (payload: EventPayloads[ParticleEmitterEvent.SET_GRAVITY]) => {
    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.g = payload.gravity ? Serializer.serializeVector(payload.gravity) : undefined;
  };

  private _onParticleEmitterSetLifetime = (payload: EventPayloads[ParticleEmitterEvent.SET_LIFETIME]) => {
    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.l = payload.lifetime;
  };

  private _onParticleEmitterSetLifetimeVariance = (payload: EventPayloads[ParticleEmitterEvent.SET_LIFETIME_VARIANCE]) => {
    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.lv = payload.lifetimeVariance;
  };

  private _onParticleEmitterSetMaxParticles = (payload: EventPayloads[ParticleEmitterEvent.SET_MAX_PARTICLES]) => {
    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.mp = payload.maxParticles;
  };

  private _onParticleEmitterSetOffset = (payload: EventPayloads[ParticleEmitterEvent.SET_OFFSET]) => {
    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.o = payload.offset ? Serializer.serializeVector(payload.offset) : undefined;
  };

  private _onParticleEmitterSetOpacityEnd = (payload: EventPayloads[ParticleEmitterEvent.SET_OPACITY_END]) => {
    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.oe = payload.opacityEnd;
  };

  private _onParticleEmitterSetOpacityEndVariance = (payload: EventPayloads[ParticleEmitterEvent.SET_OPACITY_END_VARIANCE]) => {
    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.oev = payload.opacityEndVariance;
  };

  private _onParticleEmitterSetOpacityStart = (payload: EventPayloads[ParticleEmitterEvent.SET_OPACITY_START]) => {
    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.os = payload.opacityStart;
  };

  private _onParticleEmitterSetOpacityStartVariance = (payload: EventPayloads[ParticleEmitterEvent.SET_OPACITY_START_VARIANCE]) => {
    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.osv = payload.opacityStartVariance;
  };

  private _onParticleEmitterSetPaused = (payload: EventPayloads[ParticleEmitterEvent.SET_PAUSED]) => {
    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.pa = payload.paused;
  };

  private _onParticleEmitterSetPosition = (payload: EventPayloads[ParticleEmitterEvent.SET_POSITION]) => {
    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.p = payload.position ? Serializer.serializeVector(payload.position) : undefined;
    particleEmitterSync.e = payload.position ? undefined : particleEmitterSync.e;
    particleEmitterSync.en = payload.position ? undefined : particleEmitterSync.en;
  };

  private _onParticleEmitterSetPositionVariance = (payload: EventPayloads[ParticleEmitterEvent.SET_POSITION_VARIANCE]) => {
    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.pv = payload.positionVariance ? Serializer.serializeVector(payload.positionVariance) : undefined;
  };

  private _onParticleEmitterSetRate = (payload: EventPayloads[ParticleEmitterEvent.SET_RATE]) => {
    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.r = payload.rate;
  };

  private _onParticleEmitterSetRateVariance = (payload: EventPayloads[ParticleEmitterEvent.SET_RATE_VARIANCE]) => {
    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.rv = payload.rateVariance;
  };

  private _onParticleEmitterSetSizeEnd = (payload: EventPayloads[ParticleEmitterEvent.SET_SIZE_END]) => {
    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.se = payload.sizeEnd;
  };

  private _onParticleEmitterSetSizeEndVariance = (payload: EventPayloads[ParticleEmitterEvent.SET_SIZE_END_VARIANCE]) => {
    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.sev = payload.sizeEndVariance;
  };

  private _onParticleEmitterSetSizeStart = (payload: EventPayloads[ParticleEmitterEvent.SET_SIZE_START]) => {
    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.ss = payload.sizeStart;
  };

  private _onParticleEmitterSetSizeStartVariance = (payload: EventPayloads[ParticleEmitterEvent.SET_SIZE_START_VARIANCE]) => {
    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.ssv = payload.sizeStartVariance;
  };

  private _onParticleEmitterSetTextureUri = (payload: EventPayloads[ParticleEmitterEvent.SET_TEXTURE_URI]) => {
    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.tu = payload.textureUri;
  };

  private _onParticleEmitterSetTransparent = (payload: EventPayloads[ParticleEmitterEvent.SET_TRANSPARENT]) => {
    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.t = payload.transparent;
  };

  private _onParticleEmitterSetVelocity = (payload: EventPayloads[ParticleEmitterEvent.SET_VELOCITY]) => {
    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.v = payload.velocity ? Serializer.serializeVector(payload.velocity) : undefined;
  };

  private _onParticleEmitterSetVelocityVariance = (payload: EventPayloads[ParticleEmitterEvent.SET_VELOCITY_VARIANCE]) => {
    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    particleEmitterSync.vv = payload.velocityVariance ? Serializer.serializeVector(payload.velocityVariance) : undefined;
  };

  private _onParticleEmitterSpawn = (payload: EventPayloads[ParticleEmitterEvent.SPAWN]) => {
    const particleEmitterSync = this._createOrGetQueuedParticleEmitterSync(payload.particleEmitter);
    Object.assign(particleEmitterSync, payload.particleEmitter.serialize());
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

    // Order doesn't matter here - synchronize() handles send order.
    // Use _assignUndefined to avoid overwriting properties already set by other event handlers.

    // Sync Audio
    for (const audio of this._world.audioManager.getAllAudios()) {
      const playerAudioSync = this._createOrGetQueuedAudioSync(audio, player);
      this._assignUndefined(playerAudioSync, audio.serialize());
    }

    // Sync Block Types
    for (const blockType of this._world.blockTypeRegistry.getAllBlockTypes()) {
      const playerBlockTypeSync = this._createOrGetQueuedBlockTypeSync(blockType, player);
      this._assignUndefined(playerBlockTypeSync, blockType.serialize());
    }

    // Sync Camera
    const playerCameraSync = this._createOrGetQueuedCameraSync(player);
    this._assignUndefined(playerCameraSync, player.camera.serialize());

    // Sync Chunks
    for (const chunk of this._world.chunkLattice.getAllChunks()) {
      const chunkSync = this._createOrGetQueuedChunkSync(chunk, player);
      this._assignUndefined(chunkSync, chunk.serialize());
    }

    // Sync Entities
    for (const entity of this._world.entityManager.getAllEntities()) {
      if (player.camera.attachedToEntity === undefined && entity instanceof PlayerEntity && entity.player === player) {
        player.camera.setAttachedToEntity(entity);
      }

      const playerEntitySync = this._createOrGetQueuedEntitySync(entity, player);
      this._assignUndefined(playerEntitySync, entity.serialize());
    }

    this._syncPlayerCameraAttachedEntityModel(player.camera);

    // Sync Particle Emitters
    for (const particleEmitter of this._world.particleEmitterManager.getAllParticleEmitters()) {
      const playerParticleEmitterSync = this._createOrGetQueuedParticleEmitterSync(particleEmitter, player);
      this._assignUndefined(playerParticleEmitterSync, particleEmitter.serialize());
    }

    // Sync Players
    for (const otherPlayer of PlayerManager.instance.getConnectedPlayers()) {
      const playerPlayerSync = this._createOrGetQueuedPlayerSync(otherPlayer, player);
      this._assignUndefined(playerPlayerSync, otherPlayer.serialize());
    }

    // Sync Scene UIs
    for (const sceneUI of this._world.sceneUIManager.getAllSceneUIs()) {
      const playerSceneUISync = this._createOrGetQueuedSceneUISync(sceneUI, player);
      this._assignUndefined(playerSceneUISync, sceneUI.serialize());
    }

    // Sync World
    const playerWorldSync = this._createOrGetQueuedWorldSync(this._world, player);
    this._assignUndefined(playerWorldSync, this._world.serialize());

    // Notify everyone of the new player
    const playerSync = this._createOrGetQueuedPlayerSync(player);
    this._assignUndefined(playerSync, player.serialize());
  };

  private _onPlayerLeftWorld = (payload: EventPayloads[PlayerEvent.LEFT_WORLD]) => {
    const playerSync = this._createOrGetQueuedPlayerSync(payload.player);
    playerSync.rm = true;
  };

  private _onPlayerReconnectedWorld = (payload: EventPayloads[PlayerEvent.RECONNECTED_WORLD]) => {
    this._onPlayerJoinedWorld(payload); // resync player state
  };

  private _onPlayerRequestNotificationPermission = (payload: EventPayloads[PlayerEvent.REQUEST_NOTIFICATION_PERMISSION]) => {
    this._createOrGetQueuedNotificationPermissionRequestSync(payload.player); // null payload default
  };

  private _onPlayerRequestSync = (payload: EventPayloads[PlayerEvent.REQUEST_SYNC]) => {
    payload.player.connection.send([
      protocol.createPacket(protocol.outboundPackets.syncResponsePacketDefinition, {
        r: payload.receivedAt,
        s: Date.now(),
        p: performance.now() - payload.receivedAtMs,
        n: this._world.loop.nextTickMs,
      }, this._world.loop.currentTick),
    ]);
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
    const sceneUISync = this._createOrGetQueuedSceneUISync(payload.sceneUI);
    Object.assign(sceneUISync, payload.sceneUI.serialize());
    this._loadedSceneUIs.add(sceneUISync.i);
  };

  private _onSceneUISetAttachedToEntity = (payload: EventPayloads[SceneUIEvent.SET_ATTACHED_TO_ENTITY]) => {
    const sceneUISync = this._createOrGetQueuedSceneUISync(payload.sceneUI);
    sceneUISync.e = payload.entity ? payload.entity.id : undefined;
    sceneUISync.p = payload.entity ? undefined : sceneUISync.p;
  };

  private _onSceneUISetOffset = (payload: EventPayloads[SceneUIEvent.SET_OFFSET]) => {
    const sceneUISync = this._createOrGetQueuedSceneUISync(payload.sceneUI);
    sceneUISync.o = payload.offset ? Serializer.serializeVector(payload.offset) : undefined;
  };

  private _onSceneUISetPosition = (payload: EventPayloads[SceneUIEvent.SET_POSITION]) => {
    const sceneUISync = this._createOrGetQueuedSceneUISync(payload.sceneUI);
    sceneUISync.p = payload.position ? Serializer.serializeVector(payload.position) : undefined;
    sceneUISync.e = payload.position ? undefined : sceneUISync.e;
  };

  private _onSceneUISetState = (payload: EventPayloads[SceneUIEvent.SET_STATE]) => {
    const sceneUISync = this._createOrGetQueuedSceneUISync(payload.sceneUI);
    sceneUISync.s = payload.state;
  };

  private _onSceneUISetViewDistance = (payload: EventPayloads[SceneUIEvent.SET_VIEW_DISTANCE]) => {
    const sceneUISync = this._createOrGetQueuedSceneUISync(payload.sceneUI);
    sceneUISync.v = payload.viewDistance;
  };

  private _onSceneUIUnload = (payload: EventPayloads[SceneUIEvent.UNLOAD]) => {
    const sceneUISync = this._createOrGetQueuedSceneUISync(payload.sceneUI);

    if (this._loadedSceneUIs.has(sceneUISync.i)) {
      this._queuedSceneUISyncs.broadcast.delete(sceneUISync.i);
      this._loadedSceneUIs.delete(sceneUISync.i);
    } else {
      sceneUISync.rm = true;
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
    const worldSync = this._createOrGetQueuedWorldSync(payload.world);
    worldSync.ac = Serializer.serializeRgbColor(payload.color);
  };

  private _onWorldSetAmbientLightIntensity = (payload: EventPayloads[WorldEvent.SET_AMBIENT_LIGHT_INTENSITY]) => {
    const worldSync = this._createOrGetQueuedWorldSync(payload.world);
    worldSync.ai = payload.intensity;
  };

  private _onWorldSetDirectionalLightColor = (payload: EventPayloads[WorldEvent.SET_DIRECTIONAL_LIGHT_COLOR]) => {
    const worldSync = this._createOrGetQueuedWorldSync(payload.world);
    worldSync.dc = Serializer.serializeRgbColor(payload.color);
  };

  private _onWorldSetDirectionalLightIntensity = (payload: EventPayloads[WorldEvent.SET_DIRECTIONAL_LIGHT_INTENSITY]) => {
    const worldSync = this._createOrGetQueuedWorldSync(payload.world);
    worldSync.di = payload.intensity;
  };

  private _onWorldSetDirectionalLightPosition = (payload: EventPayloads[WorldEvent.SET_DIRECTIONAL_LIGHT_POSITION]) => {
    const worldSync = this._createOrGetQueuedWorldSync(payload.world);
    worldSync.dp = Serializer.serializeVector(payload.position);
  };

  private _onWorldSetFogColor = (payload: EventPayloads[WorldEvent.SET_FOG_COLOR]) => {
    const worldSync = this._createOrGetQueuedWorldSync(payload.world);
    worldSync.fc = Serializer.serializeRgbColor(payload.color);
  };

  private _onWorldSetFogFar = (payload: EventPayloads[WorldEvent.SET_FOG_FAR]) => {
    const worldSync = this._createOrGetQueuedWorldSync(payload.world);
    worldSync.ff = payload.far;
  };

  private _onWorldSetFogNear = (payload: EventPayloads[WorldEvent.SET_FOG_NEAR]) => {
    const worldSync = this._createOrGetQueuedWorldSync(payload.world);
    worldSync.fn = payload.near;
  };

  private _onWorldSetSkyboxIntensity = (payload: EventPayloads[WorldEvent.SET_SKYBOX_INTENSITY]) => {
    const worldSync = this._createOrGetQueuedWorldSync(payload.world);
    worldSync.si = payload.intensity;
  };

  private _onWorldSetSkyboxUri = (payload: EventPayloads[WorldEvent.SET_SKYBOX_URI]) => {
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

  private _createNotificationPermissionRequestSync = () => null;
  private _createOrGetQueuedNotificationPermissionRequestSync(forPlayer?: Player): protocol.NotificationPermissionRequestSchema {
    return this._createOrGetQueuedSingletonSync(this._queuedNotificationPermissionRequestSyncs, this._createNotificationPermissionRequestSync, undefined, forPlayer);
  }

  private _createParticleEmitterSync = (particleEmitter: ParticleEmitter) => ({ i: particleEmitter.id! });
  private _createOrGetQueuedParticleEmitterSync(particleEmitter: ParticleEmitter, forPlayer?: Player): protocol.ParticleEmitterSchema {
    if (particleEmitter.id === undefined) { ErrorHandler.fatalError('NetworkSynchronizer._createOrGetQueuedParticleEmitterSync(): ParticleEmitter has no id!'); }

    return this._createOrGetQueuedSync(this._queuedParticleEmitterSyncs, particleEmitter.id, this._createParticleEmitterSync, particleEmitter, forPlayer);
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

  private _createUISync = () => ({});
  private _createOrGetQueuedUISync(forPlayer?: Player): protocol.UISchema {
    return this._createOrGetQueuedSingletonSync(this._queuedUISyncs, this._createUISync, undefined, forPlayer);
  }

  private _createUIDatasSync = () => ([]);
  private _createOrGetQueuedUIDatasSync(forPlayer?: Player): protocol.UIDatasSchema {
    return this._createOrGetQueuedSingletonSync(this._queuedUIDatasSyncs, this._createUIDatasSync, undefined, forPlayer);
  }

  private _createWorldSync = (world: World) => ({ i: world.id });
  private _createOrGetQueuedWorldSync(world: World, forPlayer?: Player): protocol.WorldSchema {
    if (world.id !== this._world.id) { ErrorHandler.fatalError('NetworkSynchronizer._createOrGetQueuedWorldSync(): World does not match this network synchronizer world!'); }

    return this._createOrGetQueuedSingletonSync(this._queuedWorldSyncs, this._createWorldSync, world, forPlayer);
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

      if (!this._outboundPerPlayerReliablePackets.has(forPlayer)) {
        this._outboundPerPlayerReliablePackets.set(forPlayer, []);
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

        if (!this._outboundPerPlayerReliablePackets.has(forPlayer)) {
          this._outboundPerPlayerReliablePackets.set(forPlayer, []);
        }
      } else {
        syncQueue.broadcast = sync;
      }
    }

    return sync;
  }

  private _clearSyncQueue(syncQueue: SyncQueue<any, any>) {
    if (syncQueue.broadcast.size > 0) { syncQueue.broadcast.clear(); }
    if (syncQueue.perPlayer.size > 0) { syncQueue.perPlayer.clear(); }
  }

  private _clearSingletonSyncQueue(syncQueue: SingletonSyncQueue<any>) {
    if (syncQueue.broadcast !== undefined) { syncQueue.broadcast = undefined; }
    if (syncQueue.perPlayer.size > 0) { syncQueue.perPlayer.clear(); }
  }

  private _collectSingletonSyncToOutboundPackets<TId extends PacketId, TSchema extends object | null>(
    singletonSyncQueue: SingletonSyncQueue<TSchema>,
    packetDefinition: IPacketDefinition<TId, TSchema>,
  ) {
    if (singletonSyncQueue.broadcast !== undefined) {
      const reliablePacket = protocol.createPacket(packetDefinition, singletonSyncQueue.broadcast, this._world.loop.currentTick);
      this._outboundSharedReliablePackets.push(reliablePacket);
      for (const packets of this._outboundPerPlayerReliablePackets.valuesArray) { packets.push(reliablePacket); }
    }

    if (singletonSyncQueue.perPlayer.size > 0) {
      for (const [ player, sync ] of singletonSyncQueue.perPlayer.entries()) {
        this._outboundPerPlayerReliablePackets.get(player)?.push(protocol.createPacket(packetDefinition, sync, this._world.loop.currentTick));
      }
    }
  }

  private _collectSyncToOutboundPackets<TKey, TId extends PacketId, TSchema extends object | null>(
    syncQueue: SyncQueue<TKey, TSchema>,
    packetDefinition: IPacketDefinition<TId, TSchema[]>,
  ) {
    if (syncQueue.broadcast.size > 0) {
      const reliablePacket = protocol.createPacket(packetDefinition, syncQueue.broadcast.valuesArray, this._world.loop.currentTick);
      this._outboundSharedReliablePackets.push(reliablePacket);
      for (const packets of this._outboundPerPlayerReliablePackets.valuesArray) { packets.push(reliablePacket); }
    }

    if (syncQueue.perPlayer.size > 0) {
      for (const [ player, sync ] of syncQueue.perPlayer.entries()) {
        this._outboundPerPlayerReliablePackets.get(player)?.push(protocol.createPacket(packetDefinition, sync.valuesArray, this._world.loop.currentTick));
      }
    }
  }

  private _syncPlayerCameraAttachedEntityModel(playerCamera: PlayerCamera): void {
    const entity = playerCamera.attachedToEntity;
    const modelUri = entity && (playerCamera.mode === PlayerCameraMode.FIRST_PERSON ? playerCamera.viewModelUri : entity.modelUri);
  
    if (entity && modelUri) {
      this._createOrGetQueuedEntitySync(entity, playerCamera.player).m = modelUri;
    }
  }

  private _queuePlayerInputAcknowledgements(): void {
    if (!PROTOCOL_SUPPORTS_ENTITY_INPUT_ACK) {
      return;
    }

    for (const playerEntity of this._world.entityManager.getAllPlayerEntities()) {
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

      const entitySync = this._createOrGetQueuedEntitySync(playerEntity, playerEntity.player);
      (entitySync as protocol.EntitySchema & { aq?: number }).aq = acknowledgedInputSequence;
    }
  }
}
