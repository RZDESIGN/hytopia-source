import ErrorHandler from '@/errors/ErrorHandler';
import type GatewayPlayerSession from '@/networking/GatewayPlayerSession';
import type World from '@/worlds/World';
import type { AnyPacket } from '@hytopia.com/server-protocol';
import type WorldHostClient from '@/worlds/hosting/WorldHostClient';
import type {
  HostedPlayerDetachReason,
  HostedPlayerPacketEnvelope,
  HostedWorldDescriptor,
} from '@/worlds/hosting/WorldHostProtocol';

/**
 * In-process implementation of the world host boundary.
 *
 * This preserves the current runtime behavior while moving world registration
 * and player assignment behind the same interface a process-backed host will use.
 *
 * **Category:** Networking
 * @internal
 */
export default class InlineWorldHostClient implements WorldHostClient {
  public static readonly instance = new InlineWorldHostClient();

  public readonly mode = 'inline' as const;

  private readonly _processId = `inline-${process.pid}`;
  private _defaultWorldId: number | undefined;
  private _worldDescriptorsById: Map<number, HostedWorldDescriptor> = new Map();
  private _worldDescriptorsByWorld: WeakMap<World, HostedWorldDescriptor> = new WeakMap();
  private _worldsById: Map<number, World> = new Map();

  private constructor() {}

  public registerWorld(world: World): HostedWorldDescriptor {
    const existing = this._worldDescriptorsByWorld.get(world);
    if (existing) {
      return existing;
    }

    const descriptor: HostedWorldDescriptor = {
      id: world.id,
      mode: this.mode,
      name: world.name,
      processId: this._processId,
      tag: world.tag,
    };

    this._worldDescriptorsById.set(world.id, descriptor);
    this._worldDescriptorsByWorld.set(world, descriptor);
    this._worldsById.set(world.id, world);

    return descriptor;
  }

  public setDefaultWorld(world: World): HostedWorldDescriptor {
    const descriptor = this.registerWorld(world);
    this._defaultWorldId = descriptor.id;
    return descriptor;
  }

  public getHostedWorldDescriptor(world: World): HostedWorldDescriptor | undefined {
    return this._worldDescriptorsByWorld.get(world);
  }

  public getDefaultWorldDescriptor(): HostedWorldDescriptor | undefined {
    return this._defaultWorldId !== undefined
      ? this._worldDescriptorsById.get(this._defaultWorldId)
      : undefined;
  }

  public getLocalWorldById(worldId: number): World | undefined {
    return this._worldsById.get(worldId);
  }

  public assignPlayerToWorld(session: GatewayPlayerSession, targetWorld: World | HostedWorldDescriptor): HostedWorldDescriptor {
    const descriptor = this._resolveDescriptor(targetWorld);
    const player = session.player;

    if (descriptor.mode !== this.mode) {
      ErrorHandler.error(
        `InlineWorldHostClient.assignPlayerToWorld(): Cannot route player ${player.id} to non-inline world ${descriptor.id} in mode ${descriptor.mode}.`,
      );

      return descriptor;
    }

    const localWorld = this.getLocalWorldById(descriptor.id);
    if (!localWorld) {
      ErrorHandler.error(
        `InlineWorldHostClient.assignPlayerToWorld(): Local world ${descriptor.id} was not found for player ${player.id}.`,
      );

      return descriptor;
    }

    player.joinWorld(localWorld);

    return descriptor;
  }

  public handlePlayerPacket(session: GatewayPlayerSession, envelope: HostedPlayerPacketEnvelope): void {
    session.player.handleHostedPacket(envelope);
  }

  public sendPacketsToPlayer(session: GatewayPlayerSession, packets: AnyPacket[], reliable: boolean = true): void {
    session.connection.send(packets, reliable);
  }

  public detachPlayerFromWorld(
    _session: GatewayPlayerSession,
    _targetWorld: World | HostedWorldDescriptor,
    _reason: HostedPlayerDetachReason,
  ): void {
    // Inline mode keeps local world membership as the source of truth.
  }

  private _resolveDescriptor(targetWorld: World | HostedWorldDescriptor): HostedWorldDescriptor {
    if ('processId' in targetWorld) {
      return targetWorld;
    }

    return this.registerWorld(targetWorld);
  }
}
