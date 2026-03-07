import protocol from '@hytopia.com/server-protocol';
import Deserializer from './Deserializer';
import EventRouter from '../events/EventRouter';
import { NetworkManagerEventType } from './NetworkEvents';

import type {
  DeserializedConnection,
  DeserializedSyncResponse,
} from './Deserializer';

export type InboundPacketRouterDependencies = {
  onConnectionPacket: (deserializedConnection: DeserializedConnection) => void | Promise<void>;
  onFirstWorldPacket: () => void;
  onHeartbeatPacket: () => void;
  onSyncResponsePacket: (deserializedSyncResponse: DeserializedSyncResponse, serverTick: number) => void;
};

type InboundPacketHandler = (
  data: unknown,
  serverTick: number | undefined,
  dependencies: InboundPacketRouterDependencies,
) => void;

const inboundPacketHandlers: (InboundPacketHandler | undefined)[] = [];

inboundPacketHandlers[protocol.PacketId.ENTITIES] = (data, serverTick) => {
  EventRouter.instance.emit(NetworkManagerEventType.EntitiesPacket, {
    deserializedEntities: Deserializer.deserializeEntities(data as protocol.EntitiesSchema),
    serverTick: serverTick as number,
  });
};

inboundPacketHandlers[protocol.PacketId.CHUNKS] = (data, serverTick) => {
  EventRouter.instance.emit(NetworkManagerEventType.ChunksPacket, {
    deserializedChunks: Deserializer.deserializeChunks(data as protocol.ChunksSchema),
    serverTick: serverTick as number,
  });
};

inboundPacketHandlers[protocol.PacketId.BLOCKS] = (data, serverTick) => {
  EventRouter.instance.emit(NetworkManagerEventType.BlocksPacket, {
    deserializedBlocks: Deserializer.deserializeBlocks(data as protocol.BlocksSchema),
    serverTick: serverTick as number,
  });
};

inboundPacketHandlers[protocol.PacketId.WORLD] = (data, serverTick, dependencies) => {
  dependencies.onFirstWorldPacket();
  EventRouter.instance.emit(NetworkManagerEventType.WorldPacket, {
    deserializedWorld: Deserializer.deserializeWorld(data as protocol.WorldSchema),
    serverTick: serverTick as number,
  });
};

inboundPacketHandlers[protocol.PacketId.PLAYERS] = (data, serverTick) => {
  EventRouter.instance.emit(NetworkManagerEventType.PlayersPacket, {
    deserializedPlayers: Deserializer.deserializePlayers(data as protocol.PlayersSchema),
    serverTick: serverTick as number,
  });
};

inboundPacketHandlers[protocol.PacketId.CAMERA] = (data, serverTick) => {
  EventRouter.instance.emit(NetworkManagerEventType.CameraPacket, {
    deserializedCamera: Deserializer.deserializeCamera(data as protocol.CameraSchema),
    serverTick: serverTick as number,
  });
};

inboundPacketHandlers[protocol.PacketId.UI_DATAS] = (data, serverTick) => {
  EventRouter.instance.emit(NetworkManagerEventType.UIDatasPacket, {
    deserializedUIDatas: Deserializer.deserializeUIDatas(data as protocol.UIDatasSchema),
    serverTick: serverTick as number,
  });
};

inboundPacketHandlers[protocol.PacketId.UI] = (data, serverTick) => {
  EventRouter.instance.emit(NetworkManagerEventType.UIPacket, {
    deserializedUI: Deserializer.deserializeUI(data as protocol.UISchema),
    serverTick: serverTick as number,
  });
};

inboundPacketHandlers[protocol.PacketId.AUDIOS] = (data, serverTick) => {
  EventRouter.instance.emit(NetworkManagerEventType.AudiosPacket, {
    deserializedAudios: Deserializer.deserializeAudios(data as protocol.AudiosSchema),
    serverTick: serverTick as number,
  });
};

inboundPacketHandlers[protocol.PacketId.BLOCK_TYPES] = (data, serverTick) => {
  EventRouter.instance.emit(NetworkManagerEventType.BlockTypesPacket, {
    deserializedBlockTypes: Deserializer.deserializeBlockTypes(data as protocol.BlockTypesSchema),
    serverTick: serverTick as number,
  });
};

inboundPacketHandlers[protocol.PacketId.PARTICLE_EMITTERS] = (data, serverTick) => {
  EventRouter.instance.emit(NetworkManagerEventType.ParticleEmittersPacket, {
    deserializedParticleEmitters: Deserializer.deserializeParticleEmitters(data as protocol.ParticleEmittersSchema),
    serverTick: serverTick as number,
  });
};

inboundPacketHandlers[protocol.PacketId.SCENE_UIS] = (data, serverTick) => {
  EventRouter.instance.emit(NetworkManagerEventType.SceneUIsPacket, {
    deserializedSceneUIs: Deserializer.deserializeSceneUIs(data as protocol.SceneUIsSchema),
    serverTick: serverTick as number,
  });
};

inboundPacketHandlers[protocol.PacketId.CHAT_MESSAGES] = (data, serverTick) => {
  EventRouter.instance.emit(NetworkManagerEventType.ChatMessagesPacket, {
    deserializedChatMessages: Deserializer.deserializeChatMessages(data as protocol.ChatMessagesSchema),
    serverTick: serverTick as number,
  });
};

inboundPacketHandlers[protocol.PacketId.HEARTBEAT] = (_data, _serverTick, dependencies) => {
  dependencies.onHeartbeatPacket();
};

inboundPacketHandlers[protocol.PacketId.SYNC_RESPONSE] = (data, serverTick, dependencies) => {
  dependencies.onSyncResponsePacket(
    Deserializer.deserializeSyncResponse(data as protocol.SyncResponseSchema),
    serverTick as number,
  );
};

inboundPacketHandlers[protocol.PacketId.CONNECTION] = (data, _serverTick, dependencies) => {
  void dependencies.onConnectionPacket(
    Deserializer.deserializeConnection(data as protocol.ConnectionSchema),
  );
};

inboundPacketHandlers[protocol.PacketId.NOTIFICATION_PERMISSION_REQUEST] = (_data, serverTick) => {
  EventRouter.instance.emit(NetworkManagerEventType.NotificationPermissionRequestPacket, {
    serverTick: serverTick as number,
  });
};

inboundPacketHandlers[protocol.PacketId.LIGHTS] = () => {
  // NOOP - PointLight/SpotLight not supported with switch to MeshBasicMaterial, Reimplement later.
};

inboundPacketHandlers[protocol.PacketId.PHYSICS_DEBUG_RAYCASTS] = (data, serverTick) => {
  EventRouter.instance.emit(NetworkManagerEventType.PhysicsDebugRaycastsPacket, {
    deserializedPhysicsDebugRaycasts: Deserializer.deserializePhysicsDebugRaycasts(data as protocol.PhysicsDebugRaycastsSchema),
    serverTick: serverTick as number,
  });
};

inboundPacketHandlers[protocol.PacketId.PHYSICS_DEBUG_RENDER] = (data, serverTick) => {
  EventRouter.instance.emit(NetworkManagerEventType.PhysicsDebugRenderPacket, {
    deserializedPhysicsDebugRender: Deserializer.deserializePhysicsDebugRender(data as protocol.PhysicsDebugRenderSchema),
    serverTick: serverTick as number,
  });
};

export const dispatchInboundPacket = (
  packet: protocol.AnyPacket,
  dependencies: InboundPacketRouterDependencies,
): boolean => {
  const handler = inboundPacketHandlers[packet[0]];
  if (!handler) {
    return false;
  }

  handler(packet[1], packet[2], dependencies);
  return true;
};
