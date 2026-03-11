import fs from 'fs';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import protocol from '@hytopia.com/server-protocol';
import ErrorHandler from '@/errors/ErrorHandler';
import GatewayPlayerSessionManager from '@/networking/GatewayPlayerSessionManager';
import Serializer from '@/networking/Serializer';
import type GatewayPlayerSession from '@/networking/GatewayPlayerSession';
import PlayerManager from '@/players/PlayerManager';
import { PlayerCameraMode } from '@/players/PlayerCamera';
import InlineWorldHostClient from '@/worlds/hosting/InlineWorldHostClient';
import type WorldHostClient from '@/worlds/hosting/WorldHostClient';
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
import PlayerEntity from '@/worlds/entities/PlayerEntity';
import DefaultPlayerEntityController from '@/worlds/entities/controllers/DefaultPlayerEntityController';
import { encodeLocalPredictionControllerFlags } from '@gameplay-shared/LocalPredictionControllerFlags';
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
const ENTITY_LOCAL_PREDICTION_FLAG_GROUNDED = 1 << 0;
const ENTITY_LOCAL_PREDICTION_FLAG_SWIMMING = 1 << 1;

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

  private static readonly _RESPAWN_DELAY_MS = 1_000;

  private _child: ChildProcess | null = null;
  private _defaultWorldId: number | undefined;
  private _descriptorsByWorldId: Map<number, HostedWorldDescriptor> = new Map();
  private _inlineClient: WorldHostClient;
  private _perPlayerEntityStateByWorldId: Map<number, Map<string, Map<number, EntitySchema>>> = new Map();
  private _processId = `shadow-${process.pid}`;
  private _respawnTimer: ReturnType<typeof setTimeout> | undefined;

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

  public ownsDerivedState(targetWorld: World | HostedWorldDescriptor): boolean {
    const descriptor = this._resolveDescriptor(targetWorld);
    return descriptor.mode === this.mode && !!this._child?.connected;
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
    const isProcessHostedWorld = worldId !== undefined && this._descriptorsByWorldId.get(worldId)?.mode === this.mode;
    if (isProcessHostedWorld) {
      this._send({
        type: 'player_packets',
        packets: [ envelope ],
        playerId: session.playerId,
        worldId,
      });

      if (this._child?.connected && envelope.packet[0] === protocol.PacketId.SYNC_REQUEST) {
        return;
      }
    }

    this._inlineClient.handlePlayerPacket(session, envelope);
  }

  public sendPacketsToPlayer(session: GatewayPlayerSession, packets: AnyPacket[], reliable: boolean = true): void {
    this._inlineClient.sendPacketsToPlayer(session, packets, reliable);
  }

  public requestNotificationPermission(session: GatewayPlayerSession): void {
    this._mirrorTargetedPlayerMessage(
      session,
      worldId => ({
        type: 'player_request_notification_permission',
        playerId: session.playerId,
        worldId,
      }),
      () => this._inlineClient.requestNotificationPermission(session),
    );
  }

  public updateAudioState(targetWorld: World | HostedWorldDescriptor, audio: AudioSchema, worldTick: number): boolean {
    const descriptor = this._resolveDescriptor(targetWorld);
    if (descriptor.mode !== this.mode || !this._child?.connected) {
      return false;
    }

    this._send({
      type: 'audio_state_patch',
      audio,
      worldId: descriptor.id,
      worldTick,
    });

    return true;
  }

  public removeAudioState(targetWorld: World | HostedWorldDescriptor, audioId: number): boolean {
    const descriptor = this._resolveDescriptor(targetWorld);
    if (descriptor.mode !== this.mode || !this._child?.connected) {
      return false;
    }

    this._send({
      type: 'audio_state_remove',
      audioId,
      worldId: descriptor.id,
    });

    return true;
  }

  public sendCameraToPlayer(session: GatewayPlayerSession, camera: CameraSchema, worldTick: number): void {
    this._mirrorTargetedPlayerMessage(
      session,
      worldId => ({
        type: 'player_camera',
        camera,
        playerId: session.playerId,
        worldId,
        worldTick,
      }),
      () => this._inlineClient.sendCameraToPlayer(session, camera, worldTick),
    );
  }

  public sendEntitiesToPlayer(session: GatewayPlayerSession, entities: EntitySchema[], worldTick: number): void {
    const worldId = session.player.world?.id;
    if (worldId !== undefined) {
      this._cachePerPlayerEntityState(worldId, session.playerId, entities);
    }

    this._mirrorTargetedPlayerMessage(
      session,
      worldId => ({
        entities,
        playerId: session.playerId,
        type: 'player_entities',
        worldId,
        worldTick,
      }),
      () => this._inlineClient.sendEntitiesToPlayer(session, entities, worldTick),
    );
  }

  public sendChatMessagesToPlayer(
    session: GatewayPlayerSession,
    chatMessages: ChatMessagesSchema,
    worldTick: number,
  ): void {
    this._mirrorTargetedPlayerMessage(
      session,
      worldId => ({
        type: 'player_chat_messages',
        chatMessages,
        playerId: session.playerId,
        worldId,
        worldTick,
      }),
      () => this._inlineClient.sendChatMessagesToPlayer(session, chatMessages, worldTick),
    );
  }

  public sendPlayersToPlayer(session: GatewayPlayerSession, players: PlayersSchema, worldTick: number): void {
    this._mirrorTargetedPlayerMessage(
      session,
      worldId => ({
        type: 'player_players',
        playerId: session.playerId,
        players,
        worldId,
        worldTick,
      }),
      () => this._inlineClient.sendPlayersToPlayer(session, players, worldTick),
    );
  }

  public sendUIToPlayer(session: GatewayPlayerSession, ui: UISchema, worldTick: number): void {
    this._mirrorTargetedPlayerMessage(
      session,
      worldId => ({
        type: 'player_ui',
        playerId: session.playerId,
        ui,
        worldId,
        worldTick,
      }),
      () => this._inlineClient.sendUIToPlayer(session, ui, worldTick),
    );
  }

  public sendUIDataToPlayer(session: GatewayPlayerSession, uiDatas: UIDatasSchema, worldTick: number): void {
    this._mirrorTargetedPlayerMessage(
      session,
      worldId => ({
        type: 'player_ui_datas',
        playerId: session.playerId,
        uiDatas,
        worldId,
        worldTick,
      }),
      () => this._inlineClient.sendUIDataToPlayer(session, uiDatas, worldTick),
    );
  }

  public sendWorldToPlayer(session: GatewayPlayerSession, world: WorldSchema, worldTick: number): void {
    this._mirrorTargetedPlayerMessage(
      session,
      worldId => ({
        type: 'player_world',
        playerId: session.playerId,
        world,
        worldId,
        worldTick,
      }),
      () => this._inlineClient.sendWorldToPlayer(session, world, worldTick),
    );
  }

  public updateWorldState(targetWorld: World | HostedWorldDescriptor, world: WorldSchema, worldTick: number): boolean {
    const descriptor = this._resolveDescriptor(targetWorld);
    if (descriptor.mode !== this.mode || !this._child?.connected) {
      return false;
    }

    this._send({
      type: 'world_state_patch',
      world,
      worldId: descriptor.id,
      worldTick,
    });

    return true;
  }

  public updateSceneUIState(targetWorld: World | HostedWorldDescriptor, sceneUI: SceneUISchema, worldTick: number): boolean {
    const descriptor = this._resolveDescriptor(targetWorld);
    if (descriptor.mode !== this.mode || !this._child?.connected) {
      return false;
    }

    this._send({
      type: 'scene_ui_state_patch',
      sceneUI,
      worldId: descriptor.id,
      worldTick,
    });

    return true;
  }

  public updateBlockTypeState(targetWorld: World | HostedWorldDescriptor, blockType: BlockTypeSchema, worldTick: number): boolean {
    const descriptor = this._resolveDescriptor(targetWorld);
    if (descriptor.mode !== this.mode || !this._child?.connected) {
      return false;
    }

    this._send({
      type: 'block_type_state_patch',
      blockType,
      worldId: descriptor.id,
      worldTick,
    });

    return true;
  }

  public updateChunkState(targetWorld: World | HostedWorldDescriptor, chunk: ChunkSchema, worldTick: number): boolean {
    const descriptor = this._resolveDescriptor(targetWorld);
    if (descriptor.mode !== this.mode || !this._child?.connected) {
      return false;
    }

    this._send({
      type: 'chunk_state_patch',
      chunk,
      worldId: descriptor.id,
      worldTick,
    });

    return true;
  }

  public updateBlockState(targetWorld: World | HostedWorldDescriptor, block: BlockSchema, worldTick: number): boolean {
    const descriptor = this._resolveDescriptor(targetWorld);
    if (descriptor.mode !== this.mode || !this._child?.connected) {
      return false;
    }

    this._send({
      type: 'block_state_patch',
      block,
      worldId: descriptor.id,
      worldTick,
    });

    return true;
  }

  public updateEntityState(targetWorld: World | HostedWorldDescriptor, entity: EntitySchema, worldTick: number): boolean {
    const descriptor = this._resolveDescriptor(targetWorld);
    if (descriptor.mode !== this.mode || !this._child?.connected) {
      return false;
    }

    this._send({
      type: 'entity_state_patch',
      entity,
      worldId: descriptor.id,
      worldTick,
    });

    return true;
  }

  public updateParticleEmitterState(
    targetWorld: World | HostedWorldDescriptor,
    particleEmitter: ParticleEmitterSchema,
    worldTick: number,
  ): boolean {
    const descriptor = this._resolveDescriptor(targetWorld);
    if (descriptor.mode !== this.mode || !this._child?.connected) {
      return false;
    }

    this._send({
      type: 'particle_emitter_state_patch',
      particleEmitter,
      worldId: descriptor.id,
      worldTick,
    });

    return true;
  }

  public detachPlayerFromWorld(
    session: GatewayPlayerSession,
    targetWorld: World | HostedWorldDescriptor,
    reason: HostedPlayerDetachReason,
  ): void {
    const descriptor = this._resolveDescriptor(targetWorld);
    const perPlayerEntityState = this._perPlayerEntityStateByWorldId.get(descriptor.id);
    perPlayerEntityState?.delete(session.playerId);
    if (perPlayerEntityState?.size === 0) {
      this._perPlayerEntityStateByWorldId.delete(descriptor.id);
    }

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

  private _mirrorTargetedPlayerMessage(
    session: GatewayPlayerSession,
    createMessage: (worldId: number) => GatewayToWorldHostMessage,
    fallback: () => void,
  ): void {
    const worldId = session.player.world?.id;
    if (worldId !== undefined && this._descriptorsByWorldId.get(worldId)?.mode === this.mode) {
      this._send(createMessage(worldId));

      if (this._child?.connected) {
        return;
      }
    }

    fallback();
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
      serialization: 'advanced',
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
        this._scheduleRespawn();
      }
    });

    child.on('message', message => {
      if (!message || typeof message !== 'object') {
        return;
      }

      this._handleChildMessage(message as {
        type?: string;
        level?: string;
        message?: string;
        packetCount?: number;
        playerId?: string;
        processId?: string;
        rawBytes?: number;
        reliable?: boolean;
        targetWorldId?: number;
        wireBytes?: Uint8Array;
        world?: HostedWorldDescriptor;
        worldId?: number;
      });
    });

    this._child = child;
    this._processId = `shadow-${child.pid ?? process.pid}`;
    this._bootstrapMirroredWorlds();
  }

  private _scheduleRespawn(): void {
    if (this._respawnTimer) {
      return;
    }

    this._respawnTimer = setTimeout(() => {
      this._respawnTimer = undefined;

      if (this._child !== null) {
        return;
      }

      this._spawnChild();
    }, ProcessWorldHostClient._RESPAWN_DELAY_MS);
  }

  private _bootstrapMirroredWorlds(): void {
    for (const descriptor of this._descriptorsByWorldId.values()) {
      if (descriptor.mode !== this.mode) {
        continue;
      }

      const world = this._inlineClient.getLocalWorldById(descriptor.id);
      if (!world) {
        continue;
      }

      this._send({
        type: 'world_boot',
        processId: descriptor.processId,
        world: descriptor,
        options: this._toBootOptions(world),
      });

      this.updateWorldState(world, world.serialize(), world.loop.currentTick);

      for (const audio of world.audioManager.getAllAudios()) {
        this.updateAudioState(world, audio.serialize(), world.loop.currentTick);
      }

      for (const blockType of world.blockTypeRegistry.getAllBlockTypes()) {
        this.updateBlockTypeState(world, blockType.serialize(), world.loop.currentTick);
      }

      for (const chunk of world.chunkLattice.getAllChunks()) {
        this.updateChunkState(world, chunk.serialize(), world.loop.currentTick);
      }

      for (const entity of world.entityManager.getAllEntities()) {
        this.updateEntityState(world, entity.serialize(), world.loop.currentTick);
      }

      for (const particleEmitter of world.particleEmitterManager.getAllParticleEmitters()) {
        this.updateParticleEmitterState(world, particleEmitter.serialize(), world.loop.currentTick);
      }

      for (const sceneUI of world.sceneUIManager.getAllSceneUIs()) {
        this.updateSceneUIState(world, sceneUI.serialize(), world.loop.currentTick);
      }

      for (const player of PlayerManager.instance.getConnectedPlayersByWorldSet(world)) {
        const session = GatewayPlayerSessionManager.instance.getSessionByPlayer(player);
        if (!session) {
          continue;
        }

        this._send({
          type: 'player_attach',
          player: this._toHostedPlayerDescriptor(session),
          worldId: descriptor.id,
        });

        const playerLocalEntitySyncs = this._mergeEntityStateArrays(
          this._buildPlayerLocalEntitySyncs(world, session),
          this._getCachedPerPlayerEntityState(descriptor.id, session.playerId),
        );
        if (playerLocalEntitySyncs.length > 0 && this._child?.connected) {
          this._send({
            entities: playerLocalEntitySyncs,
            playerId: session.playerId,
            type: 'player_entities',
            worldId: descriptor.id,
            worldTick: world.loop.currentTick,
          });
        }
      }
    }
  }

  private _buildPlayerLocalEntitySyncs(
    world: World,
    session: GatewayPlayerSession,
  ): EntitySchema[] {
    type OwnerPredictionEntitySchema = EntitySchema & {
      aq?: number;
      fd?: boolean;
      js?: number;
      mv?: protocol.VectorSchema;
      pf?: number;
      py?: number;
      sc?: number;
    };

    const entitySyncsById = new Map<number, OwnerPredictionEntitySchema>();
    const player = session.player;
    const attachedEntity = player.camera.attachedToEntity;
    const attachedEntityModelUri = attachedEntity && (
      player.camera.mode === PlayerCameraMode.FIRST_PERSON
        ? player.camera.viewModelUri
        : attachedEntity.modelUri
    );

    if (attachedEntity?.isSpawned && attachedEntity.id !== undefined && attachedEntityModelUri) {
      entitySyncsById.set(attachedEntity.id, {
        i: attachedEntity.id,
        m: attachedEntityModelUri,
      });
    }

    for (const playerEntity of world.entityManager.getPlayerEntitiesByPlayer(player)) {
      if (!playerEntity.isSpawned || playerEntity.id === undefined) {
        continue;
      }

      const entitySync = entitySyncsById.get(playerEntity.id) ?? { i: playerEntity.id };
      entitySync.p = Serializer.serializeVector(playerEntity.position);
      entitySync.r = Serializer.serializeQuaternion(playerEntity.rotation);

      this._applyOwnerPredictionEntitySync(entitySync, playerEntity);

      const acknowledgedInputSequence = player.lastAppliedInputSequenceNumber;
      if (acknowledgedInputSequence !== undefined) {
        entitySync.aq = acknowledgedInputSequence;
      }

      entitySyncsById.set(playerEntity.id, entitySync);
    }

    return Array.from(entitySyncsById.values());
  }

  private _getCachedPerPlayerEntityState(worldId: number, playerId: string): EntitySchema[] {
    const cachedPlayerEntityState = this._perPlayerEntityStateByWorldId.get(worldId)?.get(playerId);
    if (!cachedPlayerEntityState || cachedPlayerEntityState.size === 0) {
      return [];
    }

    return Array.from(cachedPlayerEntityState.values(), entity => this._cloneEntityState(entity));
  }

  private _cachePerPlayerEntityState(worldId: number, playerId: string, entities: EntitySchema[]): void {
    let perWorldEntityState = this._perPlayerEntityStateByWorldId.get(worldId);
    if (!perWorldEntityState) {
      perWorldEntityState = new Map();
      this._perPlayerEntityStateByWorldId.set(worldId, perWorldEntityState);
    }

    let perPlayerEntityState = perWorldEntityState.get(playerId);
    if (!perPlayerEntityState) {
      perPlayerEntityState = new Map();
      perWorldEntityState.set(playerId, perPlayerEntityState);
    }

    for (const entity of entities) {
      const entityId = Number(entity?.i);
      if (!Number.isFinite(entityId)) {
        continue;
      }

      if (entity.rm) {
        perPlayerEntityState.delete(entityId);
        continue;
      }

      const existingEntity = perPlayerEntityState.get(entityId);
      perPlayerEntityState.set(entityId, this._mergeEntityState(existingEntity, entity));
    }
  }

  private _mergeEntityStateArrays(baseEntities: EntitySchema[], overrideEntities: EntitySchema[]): EntitySchema[] {
    const mergedEntities = new Map<number, EntitySchema>();

    for (const entity of baseEntities) {
      const entityId = Number(entity?.i);
      if (!Number.isFinite(entityId)) {
        continue;
      }

      mergedEntities.set(entityId, this._cloneEntityState(entity));
    }

    for (const entity of overrideEntities) {
      const entityId = Number(entity?.i);
      if (!Number.isFinite(entityId)) {
        continue;
      }

      const existingEntity = mergedEntities.get(entityId);
      mergedEntities.set(entityId, this._mergeEntityState(existingEntity, entity));
    }

    return Array.from(mergedEntities.values());
  }

  private _mergeEntityState(existingEntity: EntitySchema | undefined, entityPatch: EntitySchema): EntitySchema {
    return this._cloneEntityState({
      ...existingEntity,
      ...entityPatch,
    });
  }

  private _cloneEntityState(entity: EntitySchema): EntitySchema {
    const entityWithOwnerPrediction = entity as EntitySchema & {
      mv?: protocol.VectorSchema;
    };

    return {
      ...entity,
      bh: entity.bh ? [ ...entity.bh ] : undefined,
      ec: entity.ec ? [ ...entity.ec ] : undefined,
      mv: entityWithOwnerPrediction.mv ? [ ...entityWithOwnerPrediction.mv ] : undefined,
      ol: entity.ol ? {
        ...entity.ol,
        c: entity.ol.c ? [ ...entity.ol.c ] : undefined,
      } : undefined,
      p: entity.p ? [ ...entity.p ] : undefined,
      r: entity.r ? [ ...entity.r ] : undefined,
      sv: entity.sv ? [ ...entity.sv ] : undefined,
      t: entity.t ? [ ...entity.t ] : undefined,
    } as EntitySchema;
  }

  private _applyOwnerPredictionEntitySync(
    entitySync: EntitySchema & {
      pc?: number;
      fd?: boolean;
      ju?: number;
      js?: number;
      mv?: protocol.VectorSchema;
      pf?: number;
      py?: number;
      rh?: number;
      rl?: number;
      rv?: number;
      sc?: number;
      sf?: number;
      sl?: number;
      su?: number;
      wv?: number;
    },
    playerEntity: PlayerEntity,
  ): void {
    entitySync.rl = playerEntity.player.rollbackPredictedInputMaskLow || undefined;
    entitySync.rh = playerEntity.player.rollbackPredictedInputMaskHigh || undefined;

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
    entitySync.pc = encodeLocalPredictionControllerFlags({
      canWalk: controller.canWalk(controller),
      canRun: controller.canRun(controller),
      canJump: controller.canJump(controller),
      applyDirectionalMovementRotations: controller.applyDirectionalMovementRotations,
      facesCameraWhenIdle: controller.facesCameraWhenIdle,
    });
    entitySync.ju = controller.jumpVelocity;
    entitySync.pf = predictionFlags || undefined;
    entitySync.py = controller.localPredictionMovementReferenceYaw;
    entitySync.rv = controller.runVelocity;
    entitySync.mv = Serializer.serializeVector(controller.localPredictionMotionBasisVelocity);
    entitySync.sf = controller.swimFastVelocity;
    entitySync.sl = controller.swimSlowVelocity;
    entitySync.su = controller.swimUpwardVelocity;
    entitySync.wv = controller.walkVelocity;

    const justSubmergedRemainingMs = controller.localPredictionJustSubmergedRemainingMs;
    entitySync.js = justSubmergedRemainingMs > 0 ? justSubmergedRemainingMs : undefined;

    const swimUpwardCooldownRemainingMs = controller.localPredictionSwimUpwardCooldownRemainingMs;
    entitySync.sc = swimUpwardCooldownRemainingMs > 0 ? swimUpwardCooldownRemainingMs : undefined;
  }

  private _send(message: GatewayToWorldHostMessage): void {
    if (!this._child?.connected) {
      return;
    }

    this._child.send(message);
  }

  private _handleChildMessage(message: {
    type?: string;
    level?: string;
    message?: string;
    packetCount?: number;
    playerId?: string;
    processId?: string;
    rawBytes?: number;
    reliable?: boolean;
    targetWorldId?: number;
    wireBytes?: Uint8Array;
    world?: HostedWorldDescriptor;
    worldId?: number;
  }): void {
    switch (message.type) {
      case 'player_packet_batch':
        this._handlePlayerPacketBatch(message);
        return;
      case 'player_transfer_request':
        ErrorHandler.warning(
          `ProcessWorldHostClient: Player transfer requested for ${message.playerId ?? 'unknown'} to world ${String(message.targetWorldId)}`,
        );
        return;
      case 'world_ready':
        if (message.world) {
          console.info(`ProcessWorldHostClient: world ${message.world.id} ready in process ${message.processId ?? this._processId}`);
        }
        return;
      case 'world_stopped':
        ErrorHandler.warning(
          `ProcessWorldHostClient: world ${String(message.worldId)} stopped in process ${message.processId ?? this._processId}`,
        );
        return;
      case 'world_log':
        if (typeof message.message === 'string') {
          const prefix = message.worldId !== undefined ? `[world:${message.worldId}] ` : '';
          const rendered = `ProcessWorldHostClient(${message.level ?? 'info'}): ${prefix}${message.message}`;
          if (message.level === 'error' || message.level === 'warn') {
            ErrorHandler.warning(rendered);
          } else {
            console.info(rendered);
          }
        }
        return;
      default:
        return;
    }
  }

  private _handlePlayerPacketBatch(message: {
    packetCount?: number;
    playerId?: string;
    rawBytes?: number;
    reliable?: boolean;
    wireBytes?: Uint8Array;
  }): void {
    if (!message.playerId || !message.wireBytes) {
      return;
    }

    const session = GatewayPlayerSessionManager.instance.getSessionByPlayerId(message.playerId);
    if (!session) {
      return;
    }

    session.connection.sendSerializedBuffer(
      message.wireBytes,
      message.reliable ?? true,
      {
        packetCount: message.packetCount,
        rawBytes: message.rawBytes,
      },
    );
  }

  private _toHostedPlayerDescriptor(session: GatewayPlayerSession) {
    return {
      connectionId: session.connectionId,
      id: session.playerId,
      isGuest: session.playerId.startsWith('player-'),
      profilePictureUrl: session.player.profilePictureUrl,
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
