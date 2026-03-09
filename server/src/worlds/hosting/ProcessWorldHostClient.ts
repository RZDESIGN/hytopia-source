import fs from 'fs';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import ErrorHandler from '@/errors/ErrorHandler';
import type GatewayPlayerSession from '@/networking/GatewayPlayerSession';
import InlineWorldHostClient from '@/worlds/hosting/InlineWorldHostClient';
import type WorldHostClient from '@/worlds/hosting/WorldHostClient';
import type World from '@/worlds/World';
import type { AnyPacket } from '@hytopia.com/server-protocol';
import type {
  GatewayToWorldHostMessage,
  HostedPlayerDetachReason,
  HostedPlayerPacketEnvelope,
  HostedWorldDescriptor,
} from '@/worlds/hosting/WorldHostProtocol';

const PROCESS_HOST_MODE = process.env.HYTOPIA_WORLD_HOST_MODE;
const PROCESS_HOST_WORLD_IDS = new Set(
  (process.env.HYTOPIA_PROCESS_WORLD_HOST_WORLD_IDS ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .map(value => Number(value))
    .filter(value => Number.isFinite(value)),
);
const PROCESS_HOST_WORLD_TAGS = new Set(
  (process.env.HYTOPIA_PROCESS_WORLD_HOST_WORLD_TAGS ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean),
);

/**
 * Shadow-mode process-backed world host client.
 *
 * This client starts a child process and mirrors selected world/session traffic
 * to it while keeping inline simulation authoritative. It is the first runtime
 * step toward a true out-of-process world host.
 *
 * **Category:** Networking
 * @internal
 */
export default class ProcessWorldHostClient implements WorldHostClient {
  public readonly mode = 'process' as const;

  private _child: ChildProcess | null = null;
  private _defaultWorldId: number | undefined;
  private _descriptorsByWorldId: Map<number, HostedWorldDescriptor> = new Map();
  private _inlineClient: WorldHostClient;
  private _processId = `shadow-${process.pid}`;

  public constructor(inlineClient: WorldHostClient = InlineWorldHostClient.instance) {
    this._inlineClient = inlineClient;
    this._spawnChild();
  }

  public static shouldEnableFromEnvironment(): boolean {
    return PROCESS_HOST_MODE === 'process_shadow';
  }

  public registerWorld(world: World): HostedWorldDescriptor {
    const existing = this._descriptorsByWorldId.get(world.id);
    if (existing) {
      return existing;
    }

    const inlineDescriptor = this._inlineClient.registerWorld(world);
    const descriptor = this._buildDescriptorForWorld(world, inlineDescriptor);
    this._descriptorsByWorldId.set(world.id, descriptor);

    if (descriptor.mode === this.mode) {
      this._send({
        type: 'world_boot',
        processId: descriptor.processId,
        world: descriptor,
        options: this._toBootOptions(world),
      });
    }

    return descriptor;
  }

  public setDefaultWorld(world: World): HostedWorldDescriptor {
    const inlineDescriptor = this._inlineClient.setDefaultWorld(world);
    this._defaultWorldId = world.id;
    const descriptor = this._buildDescriptorForWorld(world, inlineDescriptor, true);
    const previous = this._descriptorsByWorldId.get(world.id);
    this._descriptorsByWorldId.set(world.id, descriptor);
    if (descriptor.mode === this.mode && previous?.mode !== this.mode) {
      this._send({
        type: 'world_boot',
        processId: descriptor.processId,
        world: descriptor,
        options: this._toBootOptions(world),
      });
    }

    return descriptor;
  }

  public getHostedWorldDescriptor(world: World): HostedWorldDescriptor | undefined {
    return this._descriptorsByWorldId.get(world.id) ?? this._inlineClient.getHostedWorldDescriptor(world);
  }

  public getDefaultWorldDescriptor(): HostedWorldDescriptor | undefined {
    if (this._defaultWorldId !== undefined) {
      return this._descriptorsByWorldId.get(this._defaultWorldId);
    }

    return this._inlineClient.getDefaultWorldDescriptor();
  }

  public getLocalWorldById(worldId: number): World | undefined {
    return this._inlineClient.getLocalWorldById(worldId);
  }

  public assignPlayerToWorld(session: GatewayPlayerSession, targetWorld: World | HostedWorldDescriptor): HostedWorldDescriptor {
    const descriptor = this._resolveDescriptor(targetWorld);
    if (descriptor.mode === this.mode) {
      this._send({
        type: 'player_attach',
        player: this._toHostedPlayerDescriptor(session),
        worldId: descriptor.id,
      });
    }

    const localWorld = this._inlineClient.getLocalWorldById(descriptor.id);
    this._inlineClient.assignPlayerToWorld(session, localWorld ?? targetWorld);
    return descriptor;
  }

  public handlePlayerPacket(session: GatewayPlayerSession, envelope: HostedPlayerPacketEnvelope): void {
    const worldId = session.player.world?.id;
    if (worldId !== undefined && this._descriptorsByWorldId.get(worldId)?.mode === this.mode) {
      this._send({
        type: 'player_packets',
        packets: [ envelope ],
        playerId: session.playerId,
        worldId,
      });
    }

    this._inlineClient.handlePlayerPacket(session, envelope);
  }

  public sendPacketsToPlayer(session: GatewayPlayerSession, packets: AnyPacket[], reliable: boolean = true): void {
    this._inlineClient.sendPacketsToPlayer(session, packets, reliable);
  }

  public detachPlayerFromWorld(
    session: GatewayPlayerSession,
    targetWorld: World | HostedWorldDescriptor,
    reason: HostedPlayerDetachReason,
  ): void {
    const descriptor = this._resolveDescriptor(targetWorld);
    if (descriptor.mode === this.mode) {
      this._send({
        type: 'player_detach',
        playerId: session.playerId,
        reason,
        worldId: descriptor.id,
      });
    }

    this._inlineClient.detachPlayerFromWorld(session, targetWorld, reason);
  }

  private _buildDescriptorForWorld(
    world: World,
    inlineDescriptor: HostedWorldDescriptor,
    allowDefaultPromotion: boolean = false,
  ): HostedWorldDescriptor {
    const shouldMirror = this._shouldMirrorWorld(world, allowDefaultPromotion);
    if (!shouldMirror || this._child === null) {
      return inlineDescriptor;
    }

    return {
      ...inlineDescriptor,
      mode: this.mode,
      processId: this._processId,
    };
  }

  private _resolveDescriptor(targetWorld: World | HostedWorldDescriptor): HostedWorldDescriptor {
    if ('processId' in targetWorld) {
      return targetWorld;
    }

    return this._descriptorsByWorldId.get(targetWorld.id) ?? this.registerWorld(targetWorld);
  }

  private _shouldMirrorWorld(world: World, allowDefaultPromotion: boolean): boolean {
    if (PROCESS_HOST_WORLD_IDS.has(world.id)) {
      return true;
    }

    if (world.tag && PROCESS_HOST_WORLD_TAGS.has(world.tag)) {
      return true;
    }

    return allowDefaultPromotion && PROCESS_HOST_WORLD_IDS.size === 0 && PROCESS_HOST_WORLD_TAGS.size === 0;
  }

  private _spawnChild(): void {
    const childPath = path.resolve(process.cwd(), 'src/worlds/hosting/WorldHostProcessMain.js');
    if (!fs.existsSync(childPath)) {
      ErrorHandler.warning(
        `ProcessWorldHostClient: Host child script not found at ${childPath}. Falling back to inline-only execution.`,
      );
      return;
    }

    const child = spawn(process.execPath, [childPath], {
      env: {
        ...process.env,
        HYTOPIA_WORLD_HOST_PROCESS_CHILD: 'true',
      },
      stdio: [ 'ignore', 'inherit', 'inherit', 'ipc' ],
    });

    child.on('error', error => {
      ErrorHandler.warning(`ProcessWorldHostClient: Failed to start host child. Error: ${String(error)}`);
    });

    child.on('exit', (code, signal) => {
      ErrorHandler.warning(
        `ProcessWorldHostClient: Host child exited. code=${String(code)} signal=${String(signal)}`,
      );
      if (this._child === child) {
        this._child = null;
      }
    });

    child.on('message', message => {
      if (!message || typeof message !== 'object') {
        return;
      }

      const payload = message as { type?: string; level?: string; message?: string; worldId?: number };
      if (payload.type === 'world_log' && typeof payload.message === 'string') {
        const prefix = payload.worldId !== undefined ? `[world:${payload.worldId}] ` : '';
        const rendered = `ProcessWorldHostClient(${payload.level ?? 'info'}): ${prefix}${payload.message}`;
        if (payload.level === 'error' || payload.level === 'warn') {
          ErrorHandler.warning(rendered);
        } else {
          console.info(rendered);
        }
      }
    });

    this._child = child;
    this._processId = `shadow-${child.pid ?? process.pid}`;
  }

  private _send(message: GatewayToWorldHostMessage): void {
    if (!this._child?.connected) {
      return;
    }

    this._child.send(message);
  }

  private _toHostedPlayerDescriptor(session: GatewayPlayerSession) {
    return {
      connectionId: session.connectionId,
      id: session.playerId,
      isGuest: session.playerId.startsWith('player-'),
      username: session.player.username,
    };
  }

  private _toBootOptions(world: World) {
    return {
      ambientLightColor: world.ambientLightColor,
      ambientLightIntensity: world.ambientLightIntensity,
      directionalLightColor: world.directionalLightColor,
      directionalLightIntensity: world.directionalLightIntensity,
      directionalLightPosition: world.directionalLightPosition,
      fogColor: world.fogColor,
      fogFar: world.fogFar,
      fogNear: world.fogNear,
      gravity: world.simulation.gravity,
      id: world.id,
      name: world.name,
      skyboxIntensity: world.skyboxIntensity,
      skyboxUri: world.skyboxUri,
      tag: world.tag,
      tickRate: Math.round(1 / world.loop.timestepS),
    };
  }
}
