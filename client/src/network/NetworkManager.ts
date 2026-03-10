import protocol from '@hytopia.com/server-protocol';
import { gunzipSync } from 'fflate';
import { Packr, FLOAT32_OPTIONS } from 'msgpackr';
import {
  connectionFeatureFlagsToFeatures,
  type NegotiatedConnectionFeatures,
} from '@engine-shared/network/ConnectionFeatureFlags';
import { SEQUENCED_MOVEMENT_INPUT_SET, UNSEQUENCED_UNRELIABLE_INPUT_SET } from '@gameplay-shared/InputContract';
import { RendererEventType } from '../core/Renderer';
import {
  dispatchInboundPacket,
  type InboundPacketRouterDependencies,
} from './InboundPacketRouter';
import NetworkConditionSimulator from './NetworkConditionSimulator';
import EventRouter from '../events/EventRouter';
import Game from '../Game';
import { NetworkManagerEventType } from './NetworkEvents';

import type {
  DeserializedConnection,
  DeserializedSyncResponse,
} from './Deserializer';
import type { InputSchema } from '@hytopia.com/server-protocol';

const packr = new Packr({ useFloat32: FLOAT32_OPTIONS.ALWAYS });

const HEARTBEAT_INTERVAL_MS = 5000;
const INBOUND_APPLY_BASE_BUDGET_MS = 2;
const INBOUND_APPLY_MEDIUM_BACKLOG_BUDGET_MS = 4;
const INBOUND_APPLY_HIGH_BACKLOG_BUDGET_MS = 8;
const INBOUND_APPLY_MEDIUM_BACKLOG_THRESHOLD = 8;
const INBOUND_APPLY_HIGH_BACKLOG_THRESHOLD = 24;
let heartbeatReported = false;

type QueuedInboundMessage = {
  data: Uint8Array;
  protocolName: 'wt' | 'ws';
};

export { NetworkManagerEventType } from './NetworkEvents';
export type { NetworkManagerEventPayload } from './NetworkEventPayloads';

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
  private _serverFeatures: NegotiatedConnectionFeatures = connectionFeatureFlagsToFeatures(undefined);
  private _serverHostname: string | undefined;
  private _serverLobbyId: string | undefined;
  private _serverVersion: string | undefined;
  private _syncStartTimeS: number = 0;
  private _networkConditionSimulator: NetworkConditionSimulator;
  private _inboundPacketRouterDependencies: InboundPacketRouterDependencies;
  private _pendingIncomingMessages: QueuedInboundMessage[] = [];
  private _nextPendingIncomingMessageIndex: number = 0;

  // Whether the World Packet has been received. This is intended to be used, for example,
  // as a reference point to determine whether game initialization has started.
  private _worldPacketReceived: boolean = false;

  public constructor(game: Game) {
    this._game = game;
    this._networkConditionSimulator = new NetworkConditionSimulator(new URLSearchParams(window.location.search));
    this._inboundPacketRouterDependencies = {
      onConnectionPacket: this._onConnectionPacket,
      onFirstWorldPacket: this._onFirstWorldPacket,
      onHeartbeatPacket: this._onHeartbeatPacket,
      onSyncResponsePacket: this._onSyncResponsePacket,
    };

    window.addEventListener('beforeunload', () => this._killConnection());
    EventRouter.instance.on(RendererEventType.Animate, this._onAnimate);

    if (this._networkConditionSimulator.enabled) {
      console.info(
        `NetworkManager: simulated network conditions enabled (${this._networkConditionSimulator.describe()}).`,
      );
    }
  }

  public get game(): Game { return this._game; }
  public get roundTripTimeS(): number { return this._roundTripTimeS; }
  public get roundTripTimeMaxS(): number { return this._roundTripTimeMaxS; }
  public get serverFeatures(): NegotiatedConnectionFeatures { return this._serverFeatures; }
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

    const { default: Servers } = await import('./Servers');
    const { hostname, lobbyId, version } = await Servers.getServerDetails();

    this._serverHostname = hostname;
    this._serverLobbyId = lobbyId;
    this._serverVersion = version;

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

  public sendInputPacket(changedInputState: Record<string, any>, reliableOverride?: boolean): number | undefined {
    let hasSequencedMovementInput = false;
    let hasReliableNonMovementInput = false;

    for (const key in changedInputState) {
      if (SEQUENCED_MOVEMENT_INPUT_SET.has(key as keyof InputSchema)) {
        hasSequencedMovementInput = true;
      } else if (!UNSEQUENCED_UNRELIABLE_INPUT_SET.has(key as keyof InputSchema)) {
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
    // msgpackr already returns a Uint8Array-compatible buffer in the browser.
    // Reuse it directly to avoid an extra copy on every send.
    const serializedPacket = packr.pack(packet) as Uint8Array;
    this._networkConditionSimulator.schedule('outgoing', reliable, () => {
      this._sendSerializedPacket(serializedPacket, reliable);
    });
  }

  private _sendSerializedPacket(serializedPacket: Uint8Array, reliable: boolean): void {

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

  public sendPredictedBlockEditsPacket(
    predictionId: string,
    edits: { globalCoordinate: { x: number; y: number; z: number }, blockTypeId: number, blockRotationIndex?: number }[],
  ): void {
    this.sendPacket(protocol.createPacket(protocol.predictedBlockEditsSendPacketDefinition, {
      p: predictionId,
      e: edits.map(edit => ({
        c: [
          edit.globalCoordinate.x,
          edit.globalCoordinate.y,
          edit.globalCoordinate.z,
        ] as [number, number, number],
        i: edit.blockTypeId,
        r: edit.blockRotationIndex,
      })),
    }));
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
            this._scheduleIncomingMessage(message, true, 'wt');
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
            
            this._scheduleIncomingMessage(value, false, 'wt');
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
        this._scheduleIncomingMessage(new Uint8Array(event.data as ArrayBuffer), true, 'ws');
      };
    });
  }

  private _scheduleIncomingMessage(
    data: Uint8Array,
    reliable: boolean,
    protocolName: 'wt' | 'ws',
  ): void {
    // Queued inbound messages must own their bytes because WebTransport can hand us
    // transient views that are only valid for the current callback tick.
    const ownedData = data.slice();

    this._networkConditionSimulator.schedule('incoming', reliable, () => {
      this._pendingIncomingMessages.push({
        data: ownedData,
        protocolName,
      });
    });
  }

  private _onAnimate = (): void => {
    if (this._pendingIncomingMessageCount() === 0) {
      return;
    }

    const deadlineMs = performance.now() + this._getInboundApplyBudgetMs();
    let processedMessageCount = 0;

    while (true) {
      const nextMessage = this._dequeuePendingIncomingMessage();
      if (!nextMessage) {
        break;
      }

      this._lastReceiveProtocol = nextMessage.protocolName;
      this._onMessage(nextMessage.data);
      processedMessageCount++;

      if (processedMessageCount > 0 && performance.now() >= deadlineMs) {
        break;
      }
    }
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
    const applyStartMs = performance.now();
    let dataUint8Array = data;

    // Handle encoding byte and decompression
    if (this._isGzip(dataUint8Array)) {
      dataUint8Array = gunzipSync(dataUint8Array);
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
      const serverTick = packet[2];
      if (typeof serverTick === 'number') {
        this._lastPacketServerTick = serverTick;
      }

      if (!dispatchInboundPacket(packet, this._inboundPacketRouterDependencies)) {
        console.warn(`Received unknown packet id: ${packet[0]}, packet data:`, packet[1]);
      }
    }

    this._game.performanceBaselineManager.recordInboundMessage(
      data.byteLength,
      packets.length,
      performance.now() - applyStartMs,
    );
  }

  private _onFirstWorldPacket = (): void => {
    if (this._worldPacketReceived) {
      return;
    }

    performance.mark('NetworkManager:world-packet-received');
    performance.measure('NetworkManager:connected-to-first-packet-time', 'NetworkManager:connected', 'NetworkManager:world-packet-received');
    performance.measure('NetworkManager:game-ready-time', 'NetworkManager:connecting', 'NetworkManager:world-packet-received');
    this._game.performanceBaselineManager.recordConnectedToFirstPacket(
      this._readLatestPerformanceMeasureMs('NetworkManager:connected-to-first-packet-time'),
    );
    this._game.bridgeManager.sendGameReady();
    this._worldPacketReceived = true;
  }

  private _onHeartbeatPacket = (): void => {
    this._lastHeartbeat = performance.now();
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

    this._serverFeatures = connectionFeatureFlagsToFeatures(deserializedConnection.featureFlags);

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
    // Probe server health for diagnostics; reconnect flow currently does not branch on this.
    const { default: Servers } = await import('./Servers');
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

  private _readLatestPerformanceMeasureMs(name: string): number {
    const entries = performance.getEntriesByName(name, 'measure');
    const latestDurationMs = entries.length > 0 ? entries[entries.length - 1].duration : 0;
    performance.clearMeasures(name);
    return latestDurationMs;
  }

  private _dequeuePendingIncomingMessage(): QueuedInboundMessage | undefined {
    if (this._nextPendingIncomingMessageIndex >= this._pendingIncomingMessages.length) {
      this._pendingIncomingMessages.length = 0;
      this._nextPendingIncomingMessageIndex = 0;
      return undefined;
    }

    const message = this._pendingIncomingMessages[this._nextPendingIncomingMessageIndex++];

    if (
      this._nextPendingIncomingMessageIndex >= 32 &&
      this._nextPendingIncomingMessageIndex * 2 >= this._pendingIncomingMessages.length
    ) {
      this._pendingIncomingMessages = this._pendingIncomingMessages.slice(this._nextPendingIncomingMessageIndex);
      this._nextPendingIncomingMessageIndex = 0;
    }

    return message;
  }

  private _getInboundApplyBudgetMs(): number {
    const pendingMessageCount = this._pendingIncomingMessageCount();
    if (!this._worldPacketReceived || pendingMessageCount >= INBOUND_APPLY_HIGH_BACKLOG_THRESHOLD) {
      return INBOUND_APPLY_HIGH_BACKLOG_BUDGET_MS;
    }

    if (pendingMessageCount >= INBOUND_APPLY_MEDIUM_BACKLOG_THRESHOLD) {
      return INBOUND_APPLY_MEDIUM_BACKLOG_BUDGET_MS;
    }

    return INBOUND_APPLY_BASE_BUDGET_MS;
  }

  private _pendingIncomingMessageCount(): number {
    return this._pendingIncomingMessages.length - this._nextPendingIncomingMessageIndex;
  }
}
