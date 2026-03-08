import type {
  DeserializedAudios,
  DeserializedBlocks,
  DeserializedBlockTypes,
  DeserializedCamera,
  DeserializedChatMessages,
  DeserializedChunks,
  DeserializedConnection,
  DeserializedEntities,
  DeserializedLights,
  DeserializedParticleEmitters,
  DeserializedPhysicsDebugRaycasts,
  DeserializedPhysicsDebugRender,
  DeserializedPlayers,
  DeserializedSceneUIs,
  DeserializedSyncResponse,
  DeserializedUI,
  DeserializedUIDatas,
  DeserializedWorld,
} from './Deserializer';

export namespace NetworkManagerEventPayload {
  export interface IAudiosPacket { deserializedAudios: DeserializedAudios; serverTick: number; }
  export interface IBlocksPacket { deserializedBlocks: DeserializedBlocks; serverTick: number; }
  export interface IBlockTypesPacket { deserializedBlockTypes: DeserializedBlockTypes; serverTick: number; }
  export interface ICameraPacket { deserializedCamera: DeserializedCamera; serverTick: number; }
  export interface IChatMessagesPacket { deserializedChatMessages: DeserializedChatMessages; serverTick: number; }
  export interface IChunksPacket { deserializedChunks: DeserializedChunks; serverTick: number; }
  export interface IConnectionPacket { deserializedConnection: DeserializedConnection; }
  export interface IEntitiesPacket { deserializedEntities: DeserializedEntities; serverTick: number; }
  export interface ILightsPacket { deserializedLights: DeserializedLights; serverTick: number; }
  export interface INotificationPermissionRequestPacket { serverTick: number; }
  export interface IParticleEmittersPacket { deserializedParticleEmitters: DeserializedParticleEmitters; serverTick: number; }
  export interface IPhysicsDebugRaycastsPacket { deserializedPhysicsDebugRaycasts: DeserializedPhysicsDebugRaycasts; serverTick: number; }
  export interface IPhysicsDebugRenderPacket { deserializedPhysicsDebugRender: DeserializedPhysicsDebugRender; serverTick: number; }
  export interface IPlayersPacket { deserializedPlayers: DeserializedPlayers; serverTick: number; }
  export interface ISceneUIsPacket { deserializedSceneUIs: DeserializedSceneUIs; serverTick: number; }
  export interface ISyncResponsePacket { deserializedSyncResponse: DeserializedSyncResponse; syncStartTimeS: number; roundTripTimeS: number; serverTick: number; }
  export interface IUIPacket { deserializedUI: DeserializedUI; serverTick: number; }
  export interface IUIDatasPacket { deserializedUIDatas: DeserializedUIDatas; serverTick: number; }
  export interface IWorldPacket { deserializedWorld: DeserializedWorld; serverTick: number; }
}
