import type GatewayPlayerSession from '@/networking/GatewayPlayerSession';
import type World from '@/worlds/World';
import type { AnyPacket } from '@hytopia.com/server-protocol';
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
