import type GatewayPlayerSession from '@/networking/GatewayPlayerSession';
import type World from '@/worlds/World';
import type {
  AudioSchema,
  AnyPacket,
  BlockSchema,
  BlockTypeSchema,
  CameraSchema,
  ChatMessagesSchema,
  ChunkSchema,
  EntitySchema,
  ParticleEmitterSchema,
  PlayersSchema,
  SceneUISchema,
  UIDatasSchema,
  UISchema,
  WorldSchema,
} from '@hytopia.com/server-protocol';
import type {
  HostedPlayerDetachReason,
  HostedPlayerPacketEnvelope,
  HostedWorldDescriptor,
  WorldHostMode,
} from '@/worlds/hosting/WorldHostProtocol';

/**
 * Minimal runtime interface for assigning players to hosted worlds.
 *
 * `inline` implementations keep simulation in the current process. Later
 * implementations can route the same operations across process boundaries.
 *
 * **Category:** Networking
 * @internal
 */
export default interface WorldHostClient {
  /**
   * Hosting mode used by the implementation.
   *
   * **Category:** Networking
   */
  readonly mode: WorldHostMode;

  /**
   * Ensures a live world has a hosted-world descriptor.
   *
   * **Category:** Networking
   */
  registerWorld(world: World): HostedWorldDescriptor;

  /**
   * Marks the provided world as the default hosted destination.
   *
   * **Category:** Networking
   */
  setDefaultWorld(world: World): HostedWorldDescriptor;

  /**
   * Returns the hosted-world descriptor for a live world.
   *
   * **Category:** Networking
   */
  getHostedWorldDescriptor(world: World): HostedWorldDescriptor | undefined;

  /**
   * Returns the current default hosted world descriptor, if any.
   *
   * **Category:** Networking
   */
  getDefaultWorldDescriptor(): HostedWorldDescriptor | undefined;

  /**
   * Resolves a hosted-world descriptor back to a live local world.
   *
   * **Category:** Networking
   */
  getLocalWorldById(worldId: number): World | undefined;

  /**
   * Returns whether the host currently owns derived world/player state for the target world.
   *
   * **Category:** Networking
   */
  ownsDerivedState(targetWorld: World | HostedWorldDescriptor): boolean;

  /**
   * Assigns the player to a hosted world.
   *
   * **Category:** Networking
   */
  assignPlayerToWorld(session: GatewayPlayerSession, targetWorld: World | HostedWorldDescriptor): HostedWorldDescriptor;

  /**
   * Forwards an inbound gameplay packet to the world host that owns the player.
   *
   * **Category:** Networking
   */
  handlePlayerPacket(session: GatewayPlayerSession, envelope: HostedPlayerPacketEnvelope): void;

  /**
   * Sends outbound gameplay packets to a player through the active host.
   *
   * **Category:** Networking
   */
  sendPacketsToPlayer(session: GatewayPlayerSession, packets: AnyPacket[], reliable?: boolean): void;

  /**
   * Requests browser notification permission for a player through the active host.
   *
   * **Category:** Networking
  */
  requestNotificationPermission(session: GatewayPlayerSession): void;

  /**
   * Applies an audio-scoped state patch in the active host.
   *
   * Returns `true` if the host accepted responsibility for owning future bootstrap state.
   *
   * **Category:** Networking
   */
  updateAudioState(targetWorld: World | HostedWorldDescriptor, audio: AudioSchema, worldTick: number): boolean;

  /**
   * Removes an audio instance from the active host's derived bootstrap state.
   *
   * Returns `true` if the host accepted responsibility for the removal.
   *
   * **Category:** Networking
   */
  removeAudioState(targetWorld: World | HostedWorldDescriptor, audioId: number): boolean;

  /**
   * Sends a coalesced player camera update through the active host.
   *
   * **Category:** Networking
   */
  sendCameraToPlayer(session: GatewayPlayerSession, camera: CameraSchema, worldTick: number): void;

  /**
   * Sends a coalesced per-player entity update through the active host.
   *
   * **Category:** Networking
   */
  sendEntitiesToPlayer(session: GatewayPlayerSession, entities: EntitySchema[], worldTick: number): void;

  /**
   * Sends coalesced chat messages through the active host.
   *
   * **Category:** Networking
   */
  sendChatMessagesToPlayer(session: GatewayPlayerSession, chatMessages: ChatMessagesSchema, worldTick: number): void;

  /**
   * Sends coalesced player state updates through the active host.
   *
   * **Category:** Networking
   */
  sendPlayersToPlayer(session: GatewayPlayerSession, players: PlayersSchema, worldTick: number): void;

  /**
   * Sends a coalesced player UI update through the active host.
   *
   * **Category:** Networking
   */
  sendUIToPlayer(session: GatewayPlayerSession, ui: UISchema, worldTick: number): void;

  /**
   * Sends coalesced player UI data payloads through the active host.
   *
   * **Category:** Networking
   */
  sendUIDataToPlayer(session: GatewayPlayerSession, uiDatas: UIDatasSchema, worldTick: number): void;

  /**
   * Sends coalesced world state through the active host.
   *
   * **Category:** Networking
   */
  sendWorldToPlayer(session: GatewayPlayerSession, world: WorldSchema, worldTick: number): void;

  /**
   * Applies a world-scoped state patch in the active host.
   *
   * Returns `true` if the host accepted responsibility for broadcasting the patch.
   *
   * **Category:** Networking
   */
  updateWorldState(targetWorld: World | HostedWorldDescriptor, world: WorldSchema, worldTick: number): boolean;

  /**
   * Applies a scene-UI-scoped state patch in the active host.
   *
   * Returns `true` if the host accepted responsibility for broadcasting the patch.
   *
   * **Category:** Networking
  */
  updateSceneUIState(targetWorld: World | HostedWorldDescriptor, sceneUI: SceneUISchema, worldTick: number): boolean;

  /**
   * Applies a block-type-scoped state patch in the active host.
   *
   * Returns `true` if the host accepted responsibility for broadcasting the patch.
   *
   * **Category:** Networking
   */
  updateBlockTypeState(targetWorld: World | HostedWorldDescriptor, blockType: BlockTypeSchema, worldTick: number): boolean;

  /**
   * Applies a chunk-scoped state patch in the active host.
   *
   * Returns `true` if the host accepted responsibility for broadcasting the patch.
   *
   * **Category:** Networking
   */
  updateChunkState(targetWorld: World | HostedWorldDescriptor, chunk: ChunkSchema, worldTick: number): boolean;

  /**
   * Applies a block-scoped state patch in the active host.
   *
   * Returns `true` if the host accepted responsibility for broadcasting the patch.
   *
   * **Category:** Networking
   */
  updateBlockState(targetWorld: World | HostedWorldDescriptor, block: BlockSchema, worldTick: number): boolean;

  /**
   * Applies an entity-scoped state patch in the active host.
   *
   * Returns `true` if the host accepted responsibility for broadcasting the patch.
   *
   * **Category:** Networking
   */
  updateEntityState(targetWorld: World | HostedWorldDescriptor, entity: EntitySchema, worldTick: number): boolean;

  /**
   * Applies a particle-emitter-scoped state patch in the active host.
   *
   * Returns `true` if the host accepted responsibility for broadcasting the patch.
   *
   * **Category:** Networking
   */
  updateParticleEmitterState(
    targetWorld: World | HostedWorldDescriptor,
    particleEmitter: ParticleEmitterSchema,
    worldTick: number,
  ): boolean;

  /**
   * Detaches a player from a hosted world.
   *
   * **Category:** Networking
   */
  detachPlayerFromWorld(
    session: GatewayPlayerSession,
    targetWorld: World | HostedWorldDescriptor,
    reason: HostedPlayerDetachReason,
  ): void;
}
