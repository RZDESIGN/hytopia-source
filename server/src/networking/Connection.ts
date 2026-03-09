import { gzipSync } from 'zlib';
import { WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import protocol from '@hytopia.com/server-protocol';
import { getConnectionFeatureFlags } from '@engine-shared/network/ConnectionFeatureFlags';
import {
  connectionPacketDefinitionWithFeatures,
  registerConnectionFeaturePacketDefinition,
} from '@engine-shared/network/ConnectionFeaturePacket';
import ErrorHandler from '@/errors/ErrorHandler';
import EventRouter from '@/events/EventRouter';
import msgpackr from '@/shared/helpers/msgpackr';
import PerformanceBaseline from '@/metrics/PerformanceBaseline';
import Telemetry, { TelemetrySpanOperation } from '@/metrics/Telemetry';
import type { AnyPacket } from '@hytopia.com/server-protocol';
import type { MessageEvent, ErrorEvent } from 'ws';
import type { Session } from '@/networking/PlatformGateway';
import type { WebTransportSessionImpl } from '@fails-components/webtransport/dist/lib/types';
import type { WebTransportReceiveStream } from '@fails-components/webtransport';

const RECONNECT_WINDOW_MS = 30 * 1000; // 30 seconds
const VALIDATE_OUTBOUND_PACKETS = process.env.NODE_ENV !== 'production' || process.env.HYTOPIA_VALIDATE_OUTBOUND_PACKETS === 'true';

registerConnectionFeaturePacketDefinition();

/**
 * Event types a Connection can emit.
 *
 * **Category:** Events
 * @internal
 */
export enum ConnectionEvent {
  OPENED          = 'CONNECTION.OPENED',
  CLOSED          = 'CONNECTION.CLOSED',
  DISCONNECTED    = 'CONNECTION.DISCONNECTED',
  PACKET_RECEIVED = 'CONNECTION.PACKET_RECEIVED',
  PACKETS_SENT    = 'CONNECTION.PACKETS_SENT',
  RECONNECTED     = 'CONNECTION.RECONNECTED',
  ERROR           = 'CONNECTION.ERROR'
}

/**
 * Event payloads for Connection emitted events.
 *
 * **Category:** Events
 * @internal
 */
export interface ConnectionEventPayloads {
  [ConnectionEvent.OPENED]:          { connection: Connection, session?: Session };
  [ConnectionEvent.CLOSED]:          { connection: Connection };
  [ConnectionEvent.DISCONNECTED]:    { connection: Connection };
  [ConnectionEvent.PACKET_RECEIVED]: { connection: Connection, packet: AnyPacket };
  [ConnectionEvent.PACKETS_SENT]:    { connection: Connection, packets: AnyPacket[] };
  [ConnectionEvent.RECONNECTED]:     { connection: Connection };
  [ConnectionEvent.ERROR]:           { connection: Connection, error: ErrorEvent };
}

/**
 * Represents a live client transport connection (WebSocket or WebTransport).
 *
 * When to use: internal networking only; created by `Socket` during handshake.
 * Do NOT use for: sending per-entity updates; use `NetworkSynchronizer` instead.
 *
 * @remarks
 * Handles reconnect windows, packet framing, and reliable/unreliable transport selection.
 *
 * Pattern: aggregate packets per tick and call `send` once per player.
 * Anti-pattern: creating new Connection instances directly or sending per-message packets at high frequency.
 *
 * **Category:** Networking
 * @internal
 */
export default class Connection extends EventRouter {
  private static _cachedPacketsSerializedBuffer: Map<AnyPacket[], { buffer: Uint8Array; rawBytes: number }> = new Map();

  private _closeTimeout: NodeJS.Timeout | null = null;
  private _isDuplicate: boolean = false;
  private _ws: WebSocket | undefined;
  private _wsBinding: boolean = false;
  private _wt: WebTransportSessionImpl | undefined;
  private _wtBinding: boolean = false;
  private _wtReliableReader: WebTransportReceiveStream | undefined;
  private _wtReliableWriter: WritableStreamDefaultWriter<Uint8Array<ArrayBufferLike>> | undefined;
  private _wtUnreliableReader: ReadableStream<Uint8Array<ArrayBufferLike>> | undefined;
  private _wtUnreliableWriter: WritableStreamDefaultWriter<Uint8Array<ArrayBufferLike>> | undefined;

  /**
   * Unique connection identifier assigned by the server.
   *
   * **Category:** Networking
   */
  public readonly id: string;

  /**
   * Connection parameters captured during the initial handshake, if any.
   *
   * **Category:** Networking
   */
  public readonly initialConnectionParams: URLSearchParams | undefined;

  public constructor(ws?: WebSocket, wt?: WebTransportSessionImpl, initialConnectionParams?: URLSearchParams, session?: Session) {
    super();

    this.id = uuidv4();
    this.initialConnectionParams = initialConnectionParams;
    this.onPacket(protocol.PacketId.HEARTBEAT, this._onHeartbeatPacket);

    const emitOpened = () => {
      EventRouter.globalInstance.emit(ConnectionEvent.OPENED, {
        connection: this,
        session,
      });
    };

    if (ws) {
      this.bindWs(ws);
      emitOpened();
    } else if (wt) {
      this.bindWt(wt).then(emitOpened).catch(error => {
        this._onClose();
        ErrorHandler.error(`Connection.constructor(): Failed to bind WebTransport. Error: ${error as Error}`);
      });
    }
  }

  /**
   * Whether this connection was marked as a duplicate and terminated.
   *
   * **Category:** Networking
   */
  public get isDuplicate(): boolean { return this._isDuplicate; }

  /**
   * Clears the shared serialized-packet cache.
   *
   * @remarks
   * Used after network synchronization to avoid unbounded memory growth.
   *
   * **Side effects:** Clears a shared in-memory cache used by `serializePackets`.
   *
   * **Category:** Networking
   */
  public static clearCachedPacketsSerializedBuffers(): void {
    if (Connection._cachedPacketsSerializedBuffer.size > 0) {
      Connection._cachedPacketsSerializedBuffer.clear();
    }
  }

  /**
   * Serializes a batch of packets into a single buffer for transport.
   *
   * @remarks
   * Packets larger than 64KB are gzip-compressed. Results are cached by packet array identity.
   *
   * @param packets - The packets to serialize.
   * @returns The serialized buffer, or void if validation fails.
   *
   * **Requires:** Each packet must conform to the protocol schema.
   *
   * **Side effects:** Writes to the shared packet cache and emits telemetry spans.
   *
   * **Category:** Networking
   */
  public static serializePackets(packets: AnyPacket[]): { buffer: Uint8Array; rawBytes: number } | void {
    const cachedSerializedBuffer = Connection._cachedPacketsSerializedBuffer.get(packets);

    if (cachedSerializedBuffer) {
      return cachedSerializedBuffer;
    }

    if (VALIDATE_OUTBOUND_PACKETS) {
      for (const packet of packets) {
        if (!protocol.isValidPacket(packet)) {
          return ErrorHandler.error(`Connection.serializePackets(): Invalid packet payload: ${JSON.stringify(packet)}`);
        }
      }
    }

    const telemetryAttributes: Record<string, string | number> = {
      packets: packets.length,
    };
    if (Telemetry.sentry().isInitialized()) {
      telemetryAttributes.packetIds = packets.map(packet => packet[0]).join(',');
    }

    // We cache the packet after the first time its encoded so that
    // no matter how many times its sent, it only requires 1 encode.
    // This dramatically reduces CPU usage when multiple players are
    // connected, because without this we would encode the same packet
    // per player.
    return Telemetry.startSpan({
      operation: TelemetrySpanOperation.SERIALIZE_PACKETS,
      attributes: telemetryAttributes,
    }, span => {
      const rawBuffer = msgpackr.pack(packets) as unknown as Uint8Array;
      let outputBuffer = rawBuffer;

      if (rawBuffer.byteLength > 64 * 1024) { // Compress packets larger than 64kb, mainly chunks.
        outputBuffer = gzipSync(rawBuffer, { level: 1 }) as unknown as Uint8Array;
      }

      span?.setAttribute('serializedBytes', outputBuffer.byteLength);
      span?.setAttribute('serializedBytesRaw', rawBuffer.byteLength);

      const serialized = {
        buffer: outputBuffer,
        rawBytes: rawBuffer.byteLength,
      };

      Connection._cachedPacketsSerializedBuffer.set(packets, serialized);

      return serialized;
    });
  }

  /**
   * Binds a WebSocket transport to this connection.
   *
   * @remarks
   * Used during upgrade handshakes or reconnection.
   *
   * @param ws - The WebSocket instance to bind.
   *
   * **Side effects:** Sends a connection id packet and may emit `ConnectionEvent.RECONNECTED`.
   *
   * **Category:** Networking
   */
  public bindWs(ws: WebSocket): void {
    this._wsBinding = true;

    const reconnected = this._handleReconnect();
    
    this._cleanupConnections();

    this._ws = ws;
    this._ws.binaryType = 'nodebuffer';
    this._ws.onmessage = (event: MessageEvent) => this._onMessage(event.data as Buffer);
    this._ws.onclose = this._onClose;
    this._ws.onerror = this._onError;

    this._wsBinding = false;

    // Tell the client its connection id.
    this._signalConnectionId();

    // If the connection was previously closed, emit the reconnect event to trigger packets for client re-sync
    if (reconnected) {
      this.emitWithGlobal(ConnectionEvent.RECONNECTED, { connection: this });
    }
  }

  /**
   * Binds a WebTransport session to this connection.
   *
   * @remarks
   * Sets up reliable and unreliable streams and starts read loops.
   *
   * @param wt - The WebTransport session to bind.
   *
   * **Side effects:** Sends a connection id packet and may emit `ConnectionEvent.RECONNECTED`.
   *
   * **Category:** Networking
   */
  public async bindWt(wt: WebTransportSessionImpl): Promise<void> {
    this._wtBinding = true;

    const reconnected = this._handleReconnect();

    this._cleanupConnections();

    wt.userData.onclose = this._onClose; // assign onclose relative to the wt instance
    wt.closed.catch(() => { /* NOOP */}).finally(() => wt.userData.onclose?.()); // we need to capture the local instance, not _wt instance.
    this._wt = wt; // now assign for connection, after onclose/closed is configured on the new wt instance.

    // Use local wt (not this._wt) for all reads during async setup to avoid
    // undefined access if connection is killed mid-binding by killDuplicateConnection.
    try {
      await wt.ready;

      // Wait for client to create the bidirectional stream
      const streamReader = wt.incomingBidirectionalStreams.getReader();
      
      try {
        const { value: reliableStream } = await streamReader.read();
        
        if (reliableStream) {
          this._wtReliableReader = reliableStream.readable;
          this._wtReliableWriter = reliableStream.writable.getWriter();
        }
      } finally {
        streamReader.releaseLock(); // Always release after acquiring initial stream
      }

      this._wtUnreliableReader = wt.datagrams.readable;
      this._wtUnreliableWriter = wt.datagrams.createWritable().getWriter();
    } catch {
      this._wtBinding = false;
      
      return;
    }

    this._wtBinding = false;

    // If connection was replaced during async setup, don't start readers or signal
    if (this._wt !== wt) return;

    // Listen for reliable stream chunks.
    (async () => {
      if (!this._wtReliableReader) throw new Error('Connection.bindWt(): Reliable reader not found.');
      
      // Zero-copy unframer: callback receives view, must process immediately
      const unframe = protocol.createPacketBufferUnframer((message: Uint8Array) => {
        this._onMessage(message as unknown as Buffer);
      });

      for await (const chunk of this._wtReliableReader) {
        if (wt !== this._wt) return; // wt instance has changed, stop reader.

        unframe(chunk as unknown as Uint8Array);
      }
    })().catch(() => { try { wt?.close(); } catch { /* Already closed */ } });

    // Listen for unreliable datagrams.
    (async () => {
      if (!this._wtUnreliableReader) throw new Error('Connection.bindWt(): Unreliable reader not found.');

      for await (const datagram of this._wtUnreliableReader) {
        if (wt !== this._wt) return; // wt instance has changed, stop reader.
        this._onMessage(datagram as unknown as Buffer);
      }
    })().catch(() => { try { wt?.close(); } catch { /* Already closed */ } });

    // Tell the client its connection id.
    this._signalConnectionId();

    // If the connection was previously closed, emit the reconnect event to trigger packets for client re-sync
    if (reconnected) {
      this.emitWithGlobal(ConnectionEvent.RECONNECTED, { connection: this });
    }
  }

  /**
   * Closes the underlying transport(s).
   *
   * **Side effects:** Closes the WebSocket or WebTransport session.
   *
   * **Category:** Networking
   */
  public disconnect(): void {
    try {
      this._ws?.close();
      this._wt?.close();
    } catch (error) {
      ErrorHandler.error(`Connection.disconnect(): Connection disconnect failed. Error: ${error as Error}`);
    }
  }

  /**
   * Marks this connection as duplicate and closes it immediately.
   *
   * @remarks
   * Used when a newer connection for the same user is established.
   *
   * **Side effects:** Emits `ConnectionEvent.DISCONNECTED` and finalizes the connection.
   *
   * **Category:** Networking
   */
  public killDuplicateConnection(): void {
    this._isDuplicate = true;
    this._cleanupConnections();
    this.emitWithGlobal(ConnectionEvent.DISCONNECTED, { connection: this });
    this._finalizeClose();
  }

  /**
   * Registers a handler for a specific packet id.
   *
   * @param id - The packet id to listen for.
   * @param callback - The handler invoked when a matching packet is received.
   *
   * **Category:** Networking
   */
  public onPacket<T extends AnyPacket>(id: T[0], callback: (packet: T) => void): void {
    this.on(ConnectionEvent.PACKET_RECEIVED, ({ packet }) => {
      if (packet[0] === id) {
        callback(packet as T);
      }
    });
  }

  /**
   * Sends a batch of packets to the client.
   *
   * @remarks
   * Unreliable WebTransport datagrams are capped at ~1200 bytes and will
   * be promoted to reliable if too large.
   *
   * @param packets - The packets to send.
   * @param reliable - Whether to send reliably (default true).
   *
   * **Requires:** Connection must be bound and not in the close window.
   *
   * **Side effects:** Emits `ConnectionEvent.PACKETS_SENT` and writes to the network.
   *
   * **Category:** Networking
   */
  public send(packets: AnyPacket[], reliable: boolean = true): void {
    if (this._closeTimeout || this._wsBinding || this._wtBinding) {
      return; // Connection is scheduled to close, or is currently binding, don't send packets.
    }

    if (!this._ws && !this._wt) {
      return;
    }

    const wsConnected = !!this._ws && this._ws.readyState === WebSocket.OPEN;
    const wtConnected = !!this._wt && this._wt.state === 'connected';

    if (!wsConnected && !wtConnected) {
      return; // Connection is not connected, don't send packets.
    }
    
    Telemetry.startSpan({
      operation: TelemetrySpanOperation.SEND_PACKETS,
    }, () => {
      try {
        const serializedPackets = Connection.serializePackets(packets);

        if (!serializedPackets) return; // failed to serialize.

        const serializedBuffer = serializedPackets.buffer;
        this._writeSerializedBuffer(serializedBuffer, reliable, wtConnected);

        PerformanceBaseline.recordPackets(packets, {
          rawBytes: serializedPackets.rawBytes,
          reliable,
          wireBytes: serializedBuffer.byteLength,
        });

        this.emitWithGlobal(ConnectionEvent.PACKETS_SENT, {
          connection: this,
          packets,
        });
      } catch (error) {
        ErrorHandler.error(`Connection.send(): Packet send failed. Error: ${error as Error}`);
      }
    });
  }

  /**
   * Sends a pre-serialized packet batch to the client transport.
   *
   * Use for: forwarding already-encoded packet batches from a hosted world
   * process through the gateway without re-encoding them.
   *
   * **Category:** Networking
   */
  public sendSerializedBuffer(
    buffer: Uint8Array,
    reliable: boolean = true,
    options?: { packetCount?: number; rawBytes?: number },
  ): void {
    if (this._closeTimeout || this._wsBinding || this._wtBinding) {
      return;
    }

    if (!this._ws && !this._wt) {
      return;
    }

    const wsConnected = !!this._ws && this._ws.readyState === WebSocket.OPEN;
    const wtConnected = !!this._wt && this._wt.state === 'connected';

    if (!wsConnected && !wtConnected) {
      return;
    }

    Telemetry.startSpan({
      operation: TelemetrySpanOperation.SEND_PACKETS,
    }, () => {
      try {
        this._writeSerializedBuffer(buffer, reliable, wtConnected);

        if (options?.packetCount !== undefined && options.rawBytes !== undefined) {
          PerformanceBaseline.recordForwardedPacketBatch({
            packetCount: options.packetCount,
            rawBytes: options.rawBytes,
            reliable,
            wireBytes: buffer.byteLength,
          });
        }
      } catch (error) {
        ErrorHandler.error(`Connection.sendSerializedBuffer(): Packet send failed. Error: ${error as Error}`);
      }
    });
  }

  private _onHeartbeatPacket = () => {
    // To prevent NGINX from timing out the connection, we send 
    // a ping/pong heartbeat over the connection. Otherwise, the
    // proxy_read_timeout of NGINX will trigger and disconnect the connection.
    this.send([ protocol.createPacket(protocol.bidirectionalPackets.heartbeatPacketDefinition, null) ], true);
  };

  private _onMessage = (data: Buffer): void => {
    try {
      const packet = this._deserialize(data);

      if (!packet) return; // failed to deserialize.

      this.emitWithGlobal(ConnectionEvent.PACKET_RECEIVED, {
        connection: this,
        packet,
      });
    } catch (error) {
      ErrorHandler.error(`Connection._ws.onmessage(): Error: ${error as Error}`);
    }
  };

  private _onClose = (): void => {
    this.emitWithGlobal(ConnectionEvent.DISCONNECTED, { connection: this });

    // Give a brief window for the client to attempt to reconnect before fully closing the connection
    this._closeTimeout = setTimeout(() => this._finalizeClose(), RECONNECT_WINDOW_MS);    
  };

  private _onError = (error: ErrorEvent): void => {
    this.emitWithGlobal(ConnectionEvent.ERROR, {
      connection: this,
      error,
    });
  };

  private _cleanupConnections(): void {    
    if (this._ws) {
      this._ws.onmessage = () => {};
      this._ws.onclose = () => {};
      this._ws.onerror = () => {};
    }

    if (this._wt) {
      this._wt.userData.onclose = () => {}; // Prevent close handler from firing
    }

    // Send kill signal before closing.
    this._signalKill(); 

    // Close old connections if needed
    try { this._ws?.close(); } catch { /* NOOP */ }
    
    // Delay wt close to allow kill signal write to complete (wt write is async unlike ws)
    const wtToClose = this._wt;
    if (wtToClose) {
      setTimeout(() => { try { wtToClose.close(); } catch { /* NOOP */ } }, 50);
    }

    // Cleanup
    this._ws = undefined;
    this._wt = undefined;
    this._wtReliableReader = undefined;
    this._wtReliableWriter = undefined;
    this._wtUnreliableReader = undefined;
    this._wtUnreliableWriter = undefined;
  }

  private _writeSerializedBuffer(buffer: Uint8Array, reliable: boolean, wtConnected: boolean): void {
    if (wtConnected) {
      if (reliable || buffer.byteLength > 1200) {
        this._wtReliableWriter?.write(protocol.framePacketBuffer(buffer)).catch(() => {
          ErrorHandler.error('Connection._writeSerializedBuffer(): WebTransport reliable write failed, connection closing?');
        });
      } else {
        this._wtUnreliableWriter?.write(buffer).catch(() => {
          ErrorHandler.error('Connection._writeSerializedBuffer(): WebTransport unreliable write failed, connection closing?');
        });
      }
    } else {
      this._ws!.send(buffer);
    }
  }

  private _deserialize(data: Buffer): AnyPacket | void {
    const packet = msgpackr.unpack(data) as AnyPacket;

    if (!packet || typeof packet !== 'object' || typeof packet[0] !== 'number') {
      return ErrorHandler.error(`Connection._deserialize(): Invalid packet format. Packet: ${JSON.stringify(packet)}`);
    }
    
    if (!protocol.isValidPacket(packet)) {
      return ErrorHandler.error(`Connection._deserialize(): Invalid packet payload. Packet: ${JSON.stringify(packet)}`);
    }

    return packet;
  }

  private _finalizeClose(): void {
    this.emitWithGlobal(ConnectionEvent.CLOSED, { connection: this });
    this.offAll();
  }

  private _handleReconnect(): boolean {
    const reconnected = !!this._ws || !!this._wt; // Can be new auth for same user connection, or disconnect/reconnect.

    if (reconnected && this._closeTimeout) {
      clearTimeout(this._closeTimeout);
      this._closeTimeout = null;
    }

    return reconnected;
  }

  private _signalConnectionId(): void {
    this.send([
      protocol.createPacket(connectionPacketDefinitionWithFeatures, {
        i: this.id,
        f: getConnectionFeatureFlags(),
      }),
    ]);
  }

  private _signalKill(): void {
    this.send([
      protocol.createPacket(connectionPacketDefinitionWithFeatures, { k: true }),
    ]);
  }
}
