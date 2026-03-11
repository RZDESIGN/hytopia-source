// AssetsLibrary
export { default as AssetsLibrary } from '@/assets/AssetsLibrary';

// Audio
export { default as Audio, AudioEvent } from '@/worlds/audios/Audio';
export type { AudioEventPayloads, AudioOptions } from '@/worlds/audios/Audio';

// AudioManager
export { default as AudioManager } from '@/worlds/audios/AudioManager';

// BaseEntityController
export { default as BaseEntityController, BaseEntityControllerEvent } from '@/worlds/entities/controllers/BaseEntityController';
export type { BaseEntityControllerEventPayloads } from '@/worlds/entities/controllers/BaseEntityController';

// Block
export { default as Block, BLOCK_ROTATIONS } from '@/worlds/blocks/Block';
export type { BlockPlacement, BlockRotation } from '@/worlds/blocks/Block';

// BlockTextureRegistry
export { default as BlockTextureRegistry } from '@/textures/BlockTextureRegistry';
export type { BlockTextureMetadata } from '@/textures/BlockTextureRegistry';

// BlockType
export { default as BlockType, BlockTypeEvent } from '@/worlds/blocks/BlockType';
export type { BlockTypeEventPayloads, BlockTypeOptions } from '@/worlds/blocks/BlockType';

// BlockTypeRegistry
export { default as BlockTypeRegistry, BlockTypeRegistryEvent } from '@/worlds/blocks/BlockTypeRegistry';
export type { BlockTypeRegistryEventPayloads } from '@/worlds/blocks/BlockTypeRegistry';

// ChatManager
export { default as ChatManager, ChatEvent } from '@/worlds/chat/ChatManager';
export type { ChatEventPayloads, CommandCallback } from '@/worlds/chat/ChatManager';

// Chunk
export { default as Chunk } from '@/worlds/blocks/Chunk';

// ChunkLattice
export { default as ChunkLattice, ChunkLatticeEvent } from '@/worlds/blocks/ChunkLattice';
export type { ChunkLatticeEventPayloads } from '@/worlds/blocks/ChunkLattice';

// Collider
export { default as Collider, CoefficientCombineRule, ColliderShape } from '@/worlds/physics/Collider';
export type { BaseColliderOptions, BallColliderOptions, BlockColliderOptions, CapsuleColliderOptions, ConeColliderOptions, CylinderColliderOptions, RoundCylinderColliderOptions, TrimeshColliderOptions, VoxelsColliderOptions, WedgeColliderOptions, NoneColliderOptions, ColliderOptions, RawCollider, RawShape } from '@/worlds/physics/Collider';

// ColliderMap
export { default as ColliderMap } from '@/worlds/physics/ColliderMap';
export type { CollisionCallback, CollisionObject } from '@/worlds/physics/ColliderMap';

// CollisionGroupsBuilder
export { default as CollisionGroupsBuilder, CollisionGroup } from '@/worlds/physics/CollisionGroupsBuilder';
export type { CollisionGroups, DecodedCollisionGroups, RawCollisionGroups } from '@/worlds/physics/CollisionGroupsBuilder';

// DefaultPlayerEntity
export { default as DefaultPlayerEntity } from '@/worlds/entities/DefaultPlayerEntity';
export type { DefaultPlayerEntityOptions, PlayerCosmeticSlot } from '@/worlds/entities/DefaultPlayerEntity';

// DefaultPlayerEntityController
export {
  default as DefaultPlayerEntityController,
  DefaultPlayerEntityControllerEvent,
} from '@/worlds/entities/controllers/DefaultPlayerEntityController';
export type {
  DefaultPlayerEntityControllerEventPayloads,
  DefaultPlayerEntityControllerOptions,
} from '@/worlds/entities/controllers/DefaultPlayerEntityController';

// Entity
export { default as Entity, EntityEvent, DEFAULT_ENTITY_RIGID_BODY_OPTIONS, ENTITY_POSITION_UPDATE_THRESHOLD_SQ, ENTITY_ROTATION_UPDATE_THRESHOLD } from '@/worlds/entities/Entity';
export type { BaseEntityOptions, BlockEntityOptions, EntityEventPayloads, EntityOptions, ModelEntityOptions } from '@/worlds/entities/Entity';

// EntityManager
export { default as EntityManager } from '@/worlds/entities/EntityManager';

// EntityModelAnimation
export { default as EntityModelAnimation, EntityModelAnimationBlendMode, EntityModelAnimationEvent, EntityModelAnimationLoopMode, EntityModelAnimationState } from '@/worlds/entities/EntityModelAnimation';
export type { EntityModelAnimationOptions, EntityModelAnimationEventPayloads } from '@/worlds/entities/EntityModelAnimation';

// EntityModelNodeOverride
export { default as EntityModelNodeOverride, EntityModelNodeOverrideEvent } from '@/worlds/entities/EntityModelNodeOverride';
export type { EntityModelNodeOverrideOptions, EntityModelNodeOverrideEventPayloads } from '@/worlds/entities/EntityModelNodeOverride';

// ErrorHandler
export { default as ErrorHandler } from '@/errors/ErrorHandler';

// Connection features
export {
  ConnectionFeatureFlag,
  createDefaultBlockEditPredictionConfig,
  DEFAULT_BLOCK_EDIT_PREDICTION_MAX_DISTANCE,
  DEFAULT_BLOCK_EDIT_PREDICTION_PLACE_BLOCK_ID,
  disableConnectionFeature,
  enableConnectionFeature,
} from '@engine-shared/network/ConnectionFeatureFlags';
export type { DefaultBlockEditPredictionConfig } from '@engine-shared/network/ConnectionFeatureFlags';

// Events
export type { EventPayloads } from '@/events/Events';

// Event Router
export { default as EventRouter } from '@/events/EventRouter';

// GameServer
export { default as GameServer, GameServerEvent, startServer } from '@/GameServer';
export type { GameServerEventPayloads } from '@/GameServer';

// Generic Types
export type { default as Outline } from '@/shared/types/Outline';
export type { default as RgbColor } from '@/shared/types/RgbColor';

// Helpers
export { default as IterationMap } from '@/shared/classes/IterationMap';

// Math
export { default as Matrix2 } from '@/shared/classes/Matrix2';
export { default as Matrix3 } from '@/shared/classes/Matrix3';
export { default as Matrix4 } from '@/shared/classes/Matrix4';
export { default as Quaternion } from '@/shared/classes/Quaternion';
export { default as Vector2 } from '@/shared/classes/Vector2';
export { default as Vector3 } from '@/shared/classes/Vector3';
export type { default as QuaternionLike } from '@/shared/types/math/QuaternionLike';
export type { default as SpdMatrix3 } from '@/shared/types/math/SpdMatrix3';
export type { default as Vector2Boolean } from '@/shared/types/math/Vector2Boolean';
export type { default as Vector2Like } from '@/shared/types/math/Vector2Like';
export type { default as Vector3Boolean } from '@/shared/types/math/Vector3Boolean';
export type { default as Vector3Like } from '@/shared/types/math/Vector3Like';

// ModelRegistry
export { default as ModelRegistry } from '@/models/ModelRegistry';
export type { ModelBoundingBox, ModelTrimesh } from '@/models/ModelRegistry';

// ParticleEmitter
export { default as ParticleEmitter, ParticleEmitterEvent } from '@/worlds/particles/ParticleEmitter';
export type { ParticleEmitterEventPayloads, ParticleEmitterOptions, ParticleEmitterOrientation } from '@/worlds/particles/ParticleEmitter';

// ParticleEmitterManager
export { default as ParticleEmitterManager } from '@/worlds/particles/ParticleEmitterManager';

// PathfindingEntityController
export { default as PathfindingEntityController } from '@/worlds/entities/controllers/PathfindingEntityController';
export type { PathfindAbortCallback, PathfindCompleteCallback, PathfindingOptions, WaypointMoveCompleteCallback, WaypointMoveSkippedCallback } from '@/worlds/entities/controllers/PathfindingEntityController';

// PersistenceManager
export { default as PersistenceManager } from '@/persistence/PersistenceManager';

// PlatformGateway
export type { PlayerCosmetics, PlayerCosmeticsEquippedItem } from '@/networking/PlatformGateway';

// Player
export { default as Player, PlayerEvent, SUPPORTED_INPUTS } from '@/players/Player';
export type { PlayerEventPayloads, PlayerInput, PredictedBlockEditAttempt, PredictedBlockEditBatch } from '@/players/Player';

// Rollback prediction helpers
export {
  DEFAULT_ROLLBACK_PREDICTED_INPUTS,
  didRollbackPredictedInputPress,
  didRollbackPredictedInputRelease,
  isRollbackPredictedInputActive,
  normalizeRollbackPredictedInputs,
} from '@gameplay-shared/InputContract';
export type {
  RollbackPredictedInputSnapshot,
  RollbackPredictedInputValue,
  RollbackPredictableInput,
} from '@gameplay-shared/InputContract';

// PlayerCamera
export {
  default as PlayerCamera,
  PlayerCameraEvent,
  PlayerCameraMode,
  PlayerCameraPreset,
  PlayerCameraPresetOffsetSpace,
} from '@/players/PlayerCamera';
export type {
  PlayerCameraEventPayloads,
  PlayerCameraOrientation,
  PlayerCameraPresetOptions,
} from '@/players/PlayerCamera';

// PlayerEntity
export { default as PlayerEntity, PLAYER_POSITION_UPDATE_THRESHOLD_SQ, PLAYER_ROTATION_UPDATE_THRESHOLD } from '@/worlds/entities/PlayerEntity';
export type { PlayerEntityOptions } from '@/worlds/entities/PlayerEntity';

// PlayerManager
export { default as PlayerManager, PlayerManagerEvent } from '@/players/PlayerManager';
export type { PlayerManagerEventPayloads } from '@/players/PlayerManager';

// PlayerUI
export { default as PlayerUI, PlayerUIEvent } from '@/players/PlayerUI';
export type { PlayerUIEventPayloads } from '@/players/PlayerUI';

// RigidBody
export { default as RigidBody, RigidBodyType } from '@/worlds/physics/RigidBody';
export type { BaseRigidBodyOptions, DynamicRigidBodyOptions, FixedRigidBodyOptions, KinematicPositionRigidBodyOptions, KinematicVelocityRigidBodyOptions, RigidBodyAdditionalMassProperties, RigidBodyOptions } from '@/worlds/physics/RigidBody';

// SceneUI
export { default as SceneUI, SceneUIEvent } from '@/worlds/ui/SceneUI';
export type { SceneUIEventPayloads, SceneUIOptions } from '@/worlds/ui/SceneUI';

// SceneUIManager
export { default as SceneUIManager } from '@/worlds/ui/SceneUIManager';

// SimpleEntityController
export { default as SimpleEntityController } from '@/worlds/entities/controllers/SimpleEntityController';
export type { FaceCallback, FaceCompleteCallback, FaceOptions, MoveCallback, MoveCompleteCallback, MoveOptions } from '@/worlds/entities/controllers/SimpleEntityController';

// Simulation
export { default as Simulation, SimulationEvent } from '@/worlds/physics/Simulation';
export type { ContactForceData, ContactManifold, FilterOptions, IntersectionResult, RaycastOptions, RaycastHit, SimulationEventPayloads } from '@/worlds/physics/Simulation';

// Ticker
export { default as Ticker } from '@/shared/classes/Ticker';

// Telemetry
export { default as Telemetry, TelemetrySpanOperation } from '@/metrics/Telemetry';
export type { TelemetrySpanOptions } from '@/metrics/Telemetry';

// WebServer
export { default as WebServer, WebServerEvent } from '@/networking/WebServer';

// World
export { default as World, WorldEvent } from '@/worlds/World';
export type { WorldEventPayloads, WorldMap, WorldOptions } from '@/worlds/World';

// WorldLoop
export { default as WorldLoop, WorldLoopEvent } from '@/worlds/WorldLoop';
export type { WorldLoopEventPayloads } from '@/worlds/WorldLoop';

// WorldManager
export { default as WorldManager, WorldManagerEvent } from '@/worlds/WorldManager';
export type { WorldManagerEventPayloads } from '@/worlds/WorldManager';
