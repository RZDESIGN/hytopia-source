import type { AudioEventPayloads } from '@/worlds/audios/Audio';
import type { BaseEntityControllerEventPayloads } from '@/worlds/entities/controllers/BaseEntityController';
import type { BlockTypeEventPayloads } from '@/worlds/blocks/BlockType';
import type { BlockTypeRegistryEventPayloads } from '@/worlds/blocks/BlockTypeRegistry';
import type { ChatEventPayloads } from '@/worlds/chat/ChatManager';
import type { ChunkLatticeEventPayloads } from '@/worlds/blocks/ChunkLattice';
import type { ConnectionEventPayloads } from '@/networking/Connection';
import type { EntityEventPayloads } from '@/worlds/entities/Entity';
import type { EntityModelAnimationEventPayloads } from '@/worlds/entities/EntityModelAnimation';
import type { EntityModelNodeOverrideEventPayloads } from '@/worlds/entities/EntityModelNodeOverride';
import type { GameServerEventPayloads } from '@/GameServer';
import type { ParticleEmitterEventPayloads } from '@/worlds/particles/ParticleEmitter';
import type { PlayerCameraEventPayloads } from '@/players/PlayerCamera';
import type { PlayerEventPayloads } from '@/players/Player';
import type { PlayerManagerEventPayloads } from '@/players/PlayerManager';
import type { PlayerUIEventPayloads } from '@/players/PlayerUI';
import type { DefaultPlayerEntityControllerEventPayloads } from '@/worlds/entities/controllers/DefaultPlayerEntityController';
import type { SceneUIEventPayloads } from '@/worlds/ui/SceneUI';
import type { SimulationEventPayloads } from '@/worlds/physics/Simulation';
import type { WebServerEventPayloads } from '@/networking/WebServer';
import type { WorldEventPayloads } from '@/worlds/World';
import type { WorldLoopEventPayloads } from '@/worlds/WorldLoop';
import type { WorldManagerEventPayloads } from '@/worlds/WorldManager';

/**
 * The payloads for all events in the game server.
 *
 * **Category:** Events
 * @public
 */
export interface EventPayloads extends 
  AudioEventPayloads,
  BaseEntityControllerEventPayloads,
  BlockTypeEventPayloads,
  BlockTypeRegistryEventPayloads,
  ChatEventPayloads,
  ChunkLatticeEventPayloads,
  ConnectionEventPayloads,
  EntityEventPayloads,
  EntityModelAnimationEventPayloads,
  EntityModelNodeOverrideEventPayloads,
  GameServerEventPayloads,
  ParticleEmitterEventPayloads,
  DefaultPlayerEntityControllerEventPayloads,
  PlayerCameraEventPayloads,
  PlayerEventPayloads,
  PlayerManagerEventPayloads,
  PlayerUIEventPayloads,
  SceneUIEventPayloads,
  SimulationEventPayloads,
  WebServerEventPayloads,
  WorldEventPayloads,
  WorldLoopEventPayloads,
  WorldManagerEventPayloads
  {};
