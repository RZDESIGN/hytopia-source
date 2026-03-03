import protocol from '@hytopia.com/server-protocol';
import { gunzipSync } from 'fflate';
import { Packr, FLOAT32_OPTIONS } from 'msgpackr';
import Deserializer from './Deserializer';
import EventRouter from '../events/EventRouter';
import Game from '../Game';
import Servers from './Servers';

import type {
  DeserializedAudios,
  DeserializedBlocks,
  DeserializedBlockTypes,
  DeserializedCamera,
  DeserializedChatMessages,
  DeserializedChunks,
  DeserializedConnection,
  DeserializedEntities,
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

const packr = new Packr({ useFloat32: FLOAT32_OPTIONS.ALWAYS });

const HEARTBEAT_INTERVAL_MS = 5000;
let heartbeatReported = false;
const SEQUENCED_MOVEMENT_INPUT_KEYS = new Set([
  'w', 'a', 's', 'd',
  'sp', 'sh', 'c',
  'jd',
]);
const UNSEQUENCED_UNRELIABLE_INPUT_KEYS = new Set([ 'cp', 'cy' ]);

type ServerFeatures = {
  supportsSceneInteract?: boolean;
}

export enum NetworkManagerEventType {
  AudiosPacket = 'NETWORK_MANAGER.AUDIOS_PACKET',
  BlocksPacket = 'NETWORK_MANAGER.BLOCKS_PACKET',
  BlockTypesPacket = 'NETWORK_MANAGER.BLOCK_TYPES_PACKET',
  CameraPacket = 'NETWORK_MANAGER.CAMERA_PACKET',
  ChatMessagesPacket = 'NETWORK_MANAGER.CHAT_MESSAGE_PACKET',
  ChunksPacket = 'NETWORK_MANAGER.CHUNKS_PACKET',
  ConnectionPacket = 'NETWORK_MANAGER.CONNECTION_PACKET',
  EntitiesPacket = 'NETWORK_MANAGER.ENTITIES_PACKET',
  NotificationPermissionRequestPacket = 'NETWORK_MANAGER.NOTIFICATION_PERMISSION_REQUEST_PACKET',
  ParticleEmittersPacket = 'NETWORK_MANAGER.PARTICLE_EMITTERS_PACKET',
  PhysicsDebugRaycastsPacket = 'NETWORK_MANAGER.PHYSICS_DEBUG_RAYCASTS_PACKET',
  PhysicsDebugRenderPacket = 'NETWORK_MANAGER.PHYSICS_DEBUG_RENDER_PACKET',
  PlayersPacket = 'NETWORK_MANAGER.PLAYERS_PACKET',
  SceneUIsPacket = 'NETWORK_MANAGER.SCENE_UIS_PACKET',
  SyncResponsePacket = 'NETWORK_MANAGER.SYNC_RESPONSE_PACKET',
  UIPacket = 'NETWORK_MANAGER.UI_PACKET',
  UIDatasPacket = 'NETWORK_MANAGER.UI_DATAS_PACKET',
  WorldPacket = 'NETWORK_MANAGER.WORLD_PACKET',
}

export namespace NetworkManagerEventPayload {
  export interface IAudiosPacket { deserializedAudios: DeserializedAudios; serverTick: number; }
  export interface IBlocksPacket { deserializedBlocks: DeserializedBlocks; serverTick: number; }
  export interface IBlockTypesPacket { deserializedBlockTypes: DeserializedBlockTypes; serverTick: number; }
  export interface ICameraPacket { deserializedCamera: DeserializedCamera; serverTick: number; }
  export interface IChatMessagesPacket { deserializedChatMessages: DeserializedChatMessages; serverTick: number; }
  export interface IChunksPacket { deserializedChunks: DeserializedChunks; serverTick: number; }
  export interface IConnectionPacket { deserializedConnection: DeserializedConnection; }
  export interface IEntitiesPacket { deserializedEntities: DeserializedEntities; serverTick: number; }
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

export default class NetworkManager {
  private _ws: WebSocket | undefined;
  private _wt: WebTransport | undefined;
  private _wtOnClose: () => void = () => {};
  private _wtReliablePacketQueue: Uint8Array[] = [];
  private _wtReliablePacketQueueProcessing: boolean = false;
  private _wtReliableWriter: WritableStreamDefaultWriter<Uint8Array> | undefined;
  private _wtUnreliableWriter: WritableStreamDefaultWriter<Uint8Array> | undefined;
  private _game: Game;
  private _connectionId: string | undefined;
  private _lastPacketServerTick: number = 0;
  private _lastSendProtocol: 'wt' | 'ws' | 'none' = 'none';
  private _lastReceiveProtocol: 'wt' | 'ws' | 'none' = 'none';
  private _lastHeartbeat: number = 0;
  private _lastInputSequenceNumber: number = 0;
  private _roundTripTimeS: number = 0;
  private _roundTripTimeMaxS: number = 0;
  private _serverFeatures: ServerFeatures = {};
  private _serverHostname: string | undefined;
  private _serverLobbyId: string | undefined;
  private _serverVersion: string | undefined;
  private _syncStartTimeS: number = 0;

  // Whether the World Packet has been received. This is intended to be used, for example,
  // as a reference point to determine whether game initialization has started.
  private _worldPacketReceived: boolean = false;

  public constructor(game: Game) {
    this._game = game;

    window.addEventListener('beforeunload', () => this._killConnection());
  }

  public get game(): Game { return this._game; }
  public get roundTripTimeS(): number { return this._roundTripTimeS; }
  public get roundTripTimeMaxS(): number { return this._roundTripTimeMaxS; }
  public get serverFeatures(): ServerFeatures { return this._serverFeatures; }
  public get serverHostname(): string | undefined { return this._serverHostname; }
  public get serverLobbyId(): string | undefined { return this._serverLobbyId; }
  public get serverVersion(): string | undefined { return this._serverVersion; }
  public get lastPacketServerTick(): number { return this._lastPacketServerTick; }
  public get lastReceiveProtocol(): string { return this._lastReceiveProtocol; }
  public get lastSendProtocol(): string { return this._lastSendProtocol; }
  public get worldPacketReceived(): boolean { return this._worldPacketReceived; }

  public async connect(): Promise<void> {
    if (this._ws || this._wt) {
      return console.warn('NetworkManager.connect(): Already connected to server, ignoring.');
    }

    const { hostname, lobbyId, version } = await Servers.getServerDetails();

    this._serverHostname = hostname;
    this._serverLobbyId = lobbyId;
    this._serverVersion = version;
    this._serverFeatures = {
      supportsSceneInteract: this.isServerAtLeastVersion('0.14.26'),
    };

    performance.mark('NetworkManager:connecting');

    // Try WebTransport (HTTP/3), fallback to WebSocket if unavailable
    if (typeof WebTransport !== 'undefined') {
      await this._connectWebTransport();
    }

    // WebSocket fallback (if WebTransport unavailable or failed)
    if (!this._wt) {
      await this._connectWebSocket();
    }

    if (!this._wt && !this._ws) {
      return console.error('NetworkManager.connect(): Failed to connect to server.');
    }

    // Start synchronization and heartbeat intervals
    setInterval(() => this._synchronize(), 2000);
    setInterval(() => this._heartbeat(), 5000);

    performance.mark('NetworkManager:connected');
    performance.measure('NetworkManager:connected-time', 'NetworkManager:connecting', 'NetworkManager:connected');
  }

  public isServerAtLeastVersion(version: string): boolean {
    if (!this._serverVersion) {
      return false;
    }

    if (this._serverVersion.includes('DEV')) {
      return true;
    }

    // Split on - to handle things like -dev versions, IE 0.4.1-dev.1
    const [ major, minor, patch ] = this._serverVersion.split('.').map(n => Number(n.split('-')[0]));
    const [ majorMin, minorMin, patchMin ] = version.split('.').map(n => Number(n.split('-')[0]));

    // major comparison
    if (major > majorMin) return true;
    if (major < majorMin) return false;

    // major === majorMin, minor comparison
    if (minor > minorMin) return true;
    if (minor < minorMin) return false;

    // major === majorMin && minor === minorMin, patch comparison
    return patch >= patchMin;
  }

  public sendInputPacket(changedInputState: Record<string, any>, reliableOverride?: boolean): number | undefined {
    let hasSequencedMovementInput = false;
    let hasReliableNonMovementInput = false;

    for (const key in changedInputState) {
      if (SEQUENCED_MOVEMENT_INPUT_KEYS.has(key)) {
        hasSequencedMovementInput = true;
      } else if (!UNSEQUENCED_UNRELIABLE_INPUT_KEYS.has(key)) {
        hasReliableNonMovementInput = true;
      }
    }

    let sequenceNumber: number | undefined;
    if (hasSequencedMovementInput) {
      sequenceNumber = this._lastInputSequenceNumber++;
      changedInputState.sq = sequenceNumber;
    }

    // Movement snapshots are sent unreliably for low latency.
    // Action/state packets stay reliable unless mixed with movement data.
    const reliable = reliableOverride ?? hasReliableNonMovementInput;
    this.sendPacket(protocol.createPacket(protocol.inputPacketDefinition, changedInputState), reliable);

    return sequenceNumber;
  }

  public sendChatMessagePacket(message: string): void {
    const messagePacket = protocol.createPacket(protocol.chatMessageSendPacketDefinition, { m: message });
    this.sendPacket(messagePacket);
  }

  public sendPacket(packet: protocol.AnyPacket, reliable: boolean = true): void {
    const serializedPacket = packr.pack(packet);

    if (this._wt) {
      this._lastSendProtocol = 'wt';

      if (reliable) {
        // Prevent unbounded queue growth
        if (this._wtReliablePacketQueue.length >= 32) {
          console.warn('NetworkManager: Reliable packet send queue full, dropping oldest');
          this._wtReliablePacketQueue.shift();
        }

        this._wtReliablePacketQueue.push(protocol.framePacketBuffer(serializedPacket));

        if (this._wtReliablePacketQueueProcessing) return;

        this._wtReliablePacketQueueProcessing = true;

        void (async () => {
          try {
            while (this._wtReliablePacketQueue.length > 0) {
              await this._wtReliableWriter?.ready;
              const packet = this._wtReliablePacketQueue.shift()!;
              void this._wtReliableWriter?.write(packet);
            }
          } catch (error) {
            console.error('NetworkManager.sendPacket(): Error processing webtransport reliable packet queue:', error);
          } finally {
            this._wtReliablePacketQueueProcessing = false;
          }
        })();
      } else {
        void this._wtUnreliableWriter?.write(serializedPacket);
      }
    } else if (this._ws?.readyState === WebSocket.OPEN) {
      this._lastSendProtocol = 'ws';
      this._ws.send(serializedPacket);
    } else {
      console.error('NetworkManager.sendPacket(): Connection is not open.');
    }
  }

  public sendUIDataPacket(data: object): void {
    this.sendPacket(protocol.createPacket(protocol.uiDataSendPacketDefinition, { ...data }));
  }

  private async _connectWebTransport(): Promise<void> {
    console.log('NetworkManager._connectWebTransport(): Attempting to connect using WebTransport...');

    try {
      const wt = new WebTransport(`https://${this._serverHostname}${window.location.search}`);

      await wt.ready;

      this._wt = wt; // assign after ready, to prevent sendPacket() from sending before ready
      this._wtOnClose = () => this._reconnect();
      this._wt.closed.catch(() => { /* NOOP */ }).finally(() => this._wtOnClose());

      const stream = await this._wt.createBidirectionalStream();
      this._wtReliableWriter = stream.writable.getWriter();
      this._wtUnreliableWriter = this._wt.datagrams.writable.getWriter();

      // Listen for reliable stream chunks
      void (async () => {
        const reader = stream.readable.getReader();

        try {
          // Zero-copy unframer: callback receives view, must process immediately
          const unframe = protocol.createPacketBufferUnframer((message: Uint8Array) => {
            this._onMessage(message);
            this._lastReceiveProtocol = 'wt';
          });

          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            unframe(value);
          }
        } catch (error) {
          console.log('NetworkManager: Reliable stream no longer available.', error);
          this._wt?.close();
        }
      })();

      // Listen for unreliable datagrams
      void (async () => {
        const reader = this._wt!.datagrams.readable.getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            
            this._lastReceiveProtocol = 'wt';
            this._onMessage(value);
          }
        } catch (error) {
          console.log('NetworkManager: Datagrams no longer available.', error);
          this._wt?.close();
        }
      })();

      console.log('NetworkManager._connectWebTransport(): WebTransport connection successful!');
    } catch (error) {
      console.log('NetworkManager._connectWebTransport(): WebTransport connection failed:', error);
      this._wt?.close();
      this._wt = undefined;
      return;
    }
  }

  private async _connectWebSocket(): Promise<void> {
    return new Promise(resolve => {
      console.log('NetworkManager._connectWebSocket(): Attempting to connect using WebSocket...');

      this._ws = new WebSocket(`wss://${this._serverHostname}${window.location.search}`);
      this._ws.binaryType = 'arraybuffer';
      this._ws.onopen = () => {
        console.log('NetworkManager._connectWebSocket(): WebSocket connection successful!');
        resolve();
      };
      this._ws.onerror = () => this._ws!.close();
      this._ws.onclose = () => this._reconnect();
      this._ws.onmessage = (event: MessageEvent) => {
        this._lastReceiveProtocol = 'ws';
        this._onMessage(new Uint8Array(event.data as ArrayBuffer));
      };
    });
  }

  private _killConnection(): void {
    try {
      if (this._ws) {
        this._ws.onclose = () => {};
        this._ws.onerror = () => {};
        this._ws.onmessage = () => {}; // can't use null, expects function assignment at runtime otherwise throws for null.
        this._ws.close();
      }

      if (this._wt) {
        this._wtOnClose = () => {};
        this._wt.close();
      }
    } catch (error) {
      console.log('Error killing connection', error);
    }
  }

  private _heartbeat(): void {
    const heartbeatLag = performance.now() - this._lastHeartbeat;
    if (this._lastHeartbeat && !heartbeatReported && heartbeatLag > HEARTBEAT_INTERVAL_MS * 2) {
      heartbeatReported = true;
    }

    this.sendPacket(protocol.createPacket(protocol.heartbeatPacketDefinition, null), true);
  }

  private _isGzip(data: Uint8Array): boolean {
    // Check for gzip magic number
    return data[0] === 0x1f && data[1] === 0x8b;
  }

  private _onMessage = (data: Uint8Array): void => {
    let dataUint8Array = data;

    // Handle encoding byte and decompression
    if (this._isGzip(dataUint8Array)) {
      dataUint8Array = new Uint8Array(gunzipSync(dataUint8Array));
    }

    // Msgpackr Decode
    const decodedData = packr.unpack(dataUint8Array);

    if (!Array.isArray(decodedData)) {
      return console.warn('Received non-array packet data', decodedData);
    }

    /*
     * This is for backwards compatbility with legacy SDK versions prior to the upgrade to batched packets.
     * A packet prior to the upgrade to batched packets was in the format [ packetId (number), data (object), serverTick (number) ]
     * Now, packets are received batched in the format [ [ packetId (number), data (object), serverTick (number) ], ... ]
     *
     * This code gracefully handles both formats without breaking changes.
     */
    const packets: protocol.AnyPacket[] = Array.isArray(decodedData[0]) ? decodedData : [ decodedData ];

    for (let i = 0; i < packets.length; i++) {
      const packet = packets[i];
      const packetId = packet[0];
      const data = packet[1];
      const serverTick = packet[2] as number;

      this._lastPacketServerTick = serverTick;

      if (packetId === protocol.PacketId.WORLD) {
        if (!this._worldPacketReceived) { // only send on first world packet
          performance.mark('NetworkManager:world-packet-received');
          performance.measure('NetworkManager:connected-to-first-packet-time', 'NetworkManager:connected', 'NetworkManager:world-packet-received');
          performance.measure('NetworkManager:game-ready-time', 'NetworkManager:connecting', 'NetworkManager:world-packet-received');
          this._game.bridgeManager.sendGameReady();
        }

        this._worldPacketReceived = true;
      }

      switch (packetId) {
        case protocol.PacketId.AUDIOS:
          EventRouter.instance.emit(NetworkManagerEventType.AudiosPacket, {
            deserializedAudios: Deserializer.deserializeAudios(data as protocol.AudiosSchema),
            serverTick,
          });
          break;
        case protocol.PacketId.BLOCKS:
          EventRouter.instance.emit(NetworkManagerEventType.BlocksPacket, {
            deserializedBlocks: Deserializer.deserializeBlocks(data as protocol.BlocksSchema),
            serverTick,
          });
          break;
        case protocol.PacketId.BLOCK_TYPES:
          EventRouter.instance.emit(NetworkManagerEventType.BlockTypesPacket, {
            deserializedBlockTypes: Deserializer.deserializeBlockTypes(data as protocol.BlockTypesSchema),
            serverTick,
          });
          break;
        case protocol.PacketId.CAMERA:
          EventRouter.instance.emit(NetworkManagerEventType.CameraPacket, {
            deserializedCamera: Deserializer.deserializeCamera(data as protocol.CameraSchema),
            serverTick,
          });
          break;
        case protocol.PacketId.CHAT_MESSAGES:
          EventRouter.instance.emit(NetworkManagerEventType.ChatMessagesPacket, {
            deserializedChatMessages: Deserializer.deserializeChatMessages(data as protocol.ChatMessagesSchema),
            serverTick,
          });
          break;
        case protocol.PacketId.CHUNKS:
          EventRouter.instance.emit(NetworkManagerEventType.ChunksPacket, {
            deserializedChunks: Deserializer.deserializeChunks(data as protocol.ChunksSchema),
            serverTick,
          });
          break;
        case protocol.PacketId.CONNECTION:
          this._onConnectionPacket(
            Deserializer.deserializeConnection(data as protocol.ConnectionSchema),
          );
          break;
        case protocol.PacketId.ENTITIES:
          EventRouter.instance.emit(NetworkManagerEventType.EntitiesPacket, {
            deserializedEntities: Deserializer.deserializeEntities(data as protocol.EntitiesSchema),
            serverTick,
          });
          break;
        case protocol.PacketId.HEARTBEAT:
          this._lastHeartbeat = performance.now();
          break;
        case protocol.PacketId.LIGHTS:
          // NOOP - PointLight/SpotLight not supported with switch to MeshBasicMaterial, Reimplement later.
          break;
        case protocol.PacketId.NOTIFICATION_PERMISSION_REQUEST:
          EventRouter.instance.emit(NetworkManagerEventType.NotificationPermissionRequestPacket, {
            serverTick,
          });
          break;
        case protocol.PacketId.PARTICLE_EMITTERS:
          EventRouter.instance.emit(NetworkManagerEventType.ParticleEmittersPacket, {
            deserializedParticleEmitters: Deserializer.deserializeParticleEmitters(data as protocol.ParticleEmittersSchema),
            serverTick,
          });
          break;
        case protocol.PacketId.PHYSICS_DEBUG_RAYCASTS:
          EventRouter.instance.emit(NetworkManagerEventType.PhysicsDebugRaycastsPacket, {
            deserializedPhysicsDebugRaycasts: Deserializer.deserializePhysicsDebugRaycasts(data as protocol.PhysicsDebugRaycastsSchema),
            serverTick,
          });
          break;
        case protocol.PacketId.PHYSICS_DEBUG_RENDER:
          EventRouter.instance.emit(NetworkManagerEventType.PhysicsDebugRenderPacket, {
            deserializedPhysicsDebugRender: Deserializer.deserializePhysicsDebugRender(data as protocol.PhysicsDebugRenderSchema),
            serverTick,
          });
          break;
        case protocol.PacketId.PLAYERS:
          EventRouter.instance.emit(NetworkManagerEventType.PlayersPacket, {
            deserializedPlayers: Deserializer.deserializePlayers(data as protocol.PlayersSchema),
            serverTick,
          });
          break;
        case protocol.PacketId.SCENE_UIS:
          EventRouter.instance.emit(NetworkManagerEventType.SceneUIsPacket, {
            deserializedSceneUIs: Deserializer.deserializeSceneUIs(data as protocol.SceneUIsSchema),
            serverTick,
          });
          break;
        case protocol.PacketId.SYNC_RESPONSE:
          this._onSyncResponsePacket(
            Deserializer.deserializeSyncResponse(data as protocol.SyncResponseSchema),
            serverTick,
          );
          break;
        case protocol.PacketId.UI:
          EventRouter.instance.emit(NetworkManagerEventType.UIPacket, {
            deserializedUI: Deserializer.deserializeUI(data as protocol.UISchema),
            serverTick,
          });
          break;
        case protocol.PacketId.UI_DATAS:
          EventRouter.instance.emit(NetworkManagerEventType.UIDatasPacket, {
            deserializedUIDatas: Deserializer.deserializeUIDatas(data as protocol.UIDatasSchema),
            serverTick,
          });
          break;
        case protocol.PacketId.WORLD:
          EventRouter.instance.emit(NetworkManagerEventType.WorldPacket, {
            deserializedWorld: Deserializer.deserializeWorld(data as protocol.WorldSchema),
            serverTick,
          });
          break;
        default:
          console.warn(`Received unknown packet id: ${packetId}, packet data:`, data);
          break;
      }
    }
  }

  private _onConnectionPacket = async (deserializedConnection: DeserializedConnection): Promise<void> => {
    // Immediately upon connection on SDK versions >= 0.4.6, the server
    // will send the client a connection id. This is used to identify the
    // client on the server side, and allows the client to re-establish
    // connection state if a connection drops or if world switching
    // which requires a page reload occurs.
    if (deserializedConnection.id) {
      this._connectionId = deserializedConnection.id;
    }

    // If the server tells the client to kill its connection, do so.
    // We need to disable reconnects, and kill all active connections.
    if (deserializedConnection.kill) {
      this._killConnection();
      return;
    }
  }

  private _onSyncResponsePacket = (deserializedSyncResponse: DeserializedSyncResponse, serverTick: number): void => {
    const clientReceiveTimeS = performance.now() / 1000;
    const newRoundTripTimeS = clientReceiveTimeS - this._syncStartTimeS - (deserializedSyncResponse.serverProcessingTimeMs / 1000);
    const smoothingFactor = 0.5;

    this._roundTripTimeMaxS = Math.max(this._roundTripTimeMaxS, newRoundTripTimeS);
    this._roundTripTimeS = (this._roundTripTimeS * (1 - smoothingFactor)) + (newRoundTripTimeS * smoothingFactor);

    EventRouter.instance.emit(NetworkManagerEventType.SyncResponsePacket, {
      deserializedSyncResponse,
      syncStartTimeS: this._syncStartTimeS,
      roundTripTimeS: this._roundTripTimeS,
      serverTick,
    });
  }

  private async _reconnect(): Promise<void> {
    // Check if server is still up - if not, it's an unexpected disconnect (crash)
    await Servers.isCurrentServerHealthy().catch(() => false);

    const url = new URL(window.location.href);

    if (this._connectionId) {
      url.searchParams.set('connectionId', this._connectionId);
    }

    // sendReconnect() tells parent window to recreate the containing iframe to fully
    // reset the iframe context, webgl, memory usage, etc for stability.
    if (window.self !== window.top) {
      this.game.bridgeManager.sendReconnect(url.toString());
    } else {
      window.location.href = url.toString();
    }
  }

  private _synchronize(): void {
    this._syncStartTimeS = performance.now() / 1000;
    this.sendPacket(protocol.createPacket(protocol.syncRequestPacketDefinition, null));
  }
}
