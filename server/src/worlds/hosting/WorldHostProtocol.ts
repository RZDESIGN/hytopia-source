import type { AnyPacket } from '@hytopia.com/server-protocol';
import type Vector3Like from '@/shared/types/math/Vector3Like';

/**
 * Runtime mode used to host a world.
 *
 * `inline` is the current single-process model.
 * `process` is the target model for isolated simulation workers.
 *
 * **Category:** Networking
 * @internal
 */
export type WorldHostMode = 'inline' | 'process';

/**
 * Stable identifier for a process hosting one or more worlds.
 *
 * **Category:** Networking
 * @internal
 */
export type WorldHostProcessId = string;

/**
 * Minimal routing descriptor for a hosted world.
 *
 * This is intentionally metadata-only. The gateway should be able to route
 * players and packets without holding a live `World` instance.
 *
 * **Category:** Networking
 * @internal
 */
export interface HostedWorldDescriptor {
  id: number;
  name: string;
  tag?: string;
  mode: WorldHostMode;
  processId: WorldHostProcessId;
}

/**
 * Minimal player identity the gateway can pass to a world host.
 *
 * **Category:** Networking
 * @internal
 */
export interface HostedPlayerDescriptor {
  connectionId: string;
  id: string;
  isGuest: boolean;
  sessionToken?: string;
  username: string;
}

/**
 * Packet envelope forwarded from the gateway to a world host.
 *
 * The dual timestamps preserve the current sync-request behavior while also
 * carrying a wall-clock receive time suitable for logs or cross-process traces.
 *
 * **Category:** Networking
 * @internal
 */
export interface HostedPlayerPacketEnvelope {
  packet: AnyPacket;
  receivedAtMonotonicMs: number;
  receivedAtUnixMs: number;
}

/**
 * Bootstrap options required by an isolated world host.
 *
 * This mirrors the subset of `WorldOptions` required to start simulation
 * without shipping a live `World` object across process boundaries.
 *
 * **Category:** Networking
 * @internal
 */
export interface HostedWorldBootOptions {
  ambientLightColor?: { r: number; g: number; b: number };
  ambientLightIntensity?: number;
  directionalLightColor?: { r: number; g: number; b: number };
  directionalLightIntensity?: number;
  directionalLightPosition?: Vector3Like;
  fogColor?: { r: number; g: number; b: number };
  fogFar?: number;
  fogNear?: number;
  gravity?: Vector3Like;
  id: number;
  mapUri?: string;
  name: string;
  skyboxIntensity?: number;
  skyboxUri: string;
  tag?: string;
  tickRate?: number;
}

/**
 * Reason a world host is detaching a player.
 *
 * **Category:** Networking
 * @internal
 */
export type HostedPlayerDetachReason =
  | 'connection_closed'
  | 'connection_lost'
  | 'server_shutdown'
  | 'world_shutdown'
  | 'world_transfer';

/**
 * Reason a world is stopping.
 *
 * **Category:** Networking
 * @internal
 */
export type HostedWorldStopReason =
  | 'crash'
  | 'empty'
  | 'manual'
  | 'rebalanced'
  | 'server_shutdown';

/**
 * Messages sent from the gateway process to a world host process.
 *
 * The gateway owns sockets and player connections. The world host owns
 * simulation and game logic. Client packets are forwarded as protocol packets
 * so the world process can remain authoritative over gameplay semantics.
 *
 * **Category:** Networking
 * @internal
 */
export type GatewayToWorldHostMessage =
  | {
    type: 'world_boot';
    processId: WorldHostProcessId;
    world: HostedWorldDescriptor;
    options: HostedWorldBootOptions;
  }
  | {
    type: 'world_stop';
    processId: WorldHostProcessId;
    reason: HostedWorldStopReason;
    worldId: number;
  }
  | {
    type: 'player_attach';
    player: HostedPlayerDescriptor;
    worldId: number;
  }
  | {
    type: 'player_detach';
    playerId: string;
    reason: HostedPlayerDetachReason;
    worldId: number;
  }
  | {
    type: 'player_packets';
    packets: HostedPlayerPacketEnvelope[];
    playerId: string;
    worldId: number;
  };

/**
 * Messages sent from a world host process back to the gateway.
 *
 * Outbound packets are already serialized in the world host so packet encoding
 * cost stays close to the simulation that produced them.
 *
 * **Category:** Networking
 * @internal
 */
export type WorldHostToGatewayMessage =
  | {
    type: 'world_ready';
    processId: WorldHostProcessId;
    world: HostedWorldDescriptor;
  }
  | {
    type: 'world_stopped';
    processId: WorldHostProcessId;
    reason: HostedWorldStopReason;
    worldId: number;
  }
  | {
    type: 'player_packet_batch';
    packetCount: number;
    playerId: string;
    processId: WorldHostProcessId;
    rawBytes: number;
    reliable: boolean;
    wireBytes: Uint8Array;
    worldId: number;
  }
  | {
    type: 'player_transfer_request';
    playerId: string;
    processId: WorldHostProcessId;
    targetWorldId: number;
    worldId: number;
  }
  | {
    type: 'world_log';
    level: 'debug' | 'info' | 'warn' | 'error';
    message: string;
    processId: WorldHostProcessId;
    worldId?: number;
  };
