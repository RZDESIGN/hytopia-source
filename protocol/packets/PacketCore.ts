import Ajv from '../shared/Ajv';
import type { JSONSchemaType, ValidateFunction } from 'ajv';

const FRAME_HEADER_SIZE = 4;
const MAX_FRAME_BUFFER_SIZE = 32 * 1024 * 1024; // 32MB max buffer size

/*
 * Packet types are numerically ordered relative to their use.
 *
 * Standard inbound/outbound packets must be within the id
 * range of 0-127 to allow their numerical representation in
 * msgpack'd format to be 1 byte - these packets are the most
 * frequent and thus should be optimized for the smallest 
 * representation.
 * 
 * Debug packets must be within the id range of 128-255 to
 * allow their msgpack'd format to be 2 bytes - these packets
 * are not packets used in typical or frequent gameplay and
 * are acceptable to be represented with an additional byte
 * in encoded format.
 */

export enum PacketId {
  // Standard Inbound Packet Types: 0 - 31 range
  SYNC_REQUEST = 0,
  INPUT = 1,
  STATE_REQUEST = 2,
  CHAT_MESSAGE_SEND = 3,
  UI_DATA_SEND = 4,
  PREDICTED_BLOCK_EDITS_SEND = 5,

  // Standard Outbound Packet Types: 32 - 127 range
  SYNC_RESPONSE = 32,
  AUDIOS = 33,
  BLOCKS = 34,
  BLOCK_TYPES = 35,
  CHAT_MESSAGES = 36,
  CHUNKS = 37,
  ENTITIES = 38,
  WORLD = 39,
  CAMERA = 40,
  UI = 41,
  UI_DATAS = 42,
  SCENE_UIS = 43,
  LIGHTS = 44,
  PLAYERS = 45,
  PARTICLE_EMITTERS = 46,
  NOTIFICATION_PERMISSION_REQUEST = 47,
  BLOCK_EDIT_PREDICTION_RESULTS = 48,
  BLOCK_EDIT_PREDICTION_CONFIG = 49,

  // Standard Bi-Directional Packet Types: 116 - 127 range
  CONNECTION = 116,
  HEARTBEAT = 117,

  // Debug Inbound Packet Types: 128 - 191 range
  DEBUG_CONFIG = 128,

  // Debug Outbound Packet Types: 192 - 255 range
  PHYSICS_DEBUG_RENDER = 192,
  PHYSICS_DEBUG_RAYCASTS = 193,
}

/*
 * Generators for packet definitions and validators.
 */

export interface IPacketDefinition<TId extends PacketId, TSchema> {
  id: TId;
  schema: JSONSchemaType<TSchema>;
  validate: ValidateFunction<TSchema>;
}

export type WorldTick = number;

export type IPacket<TId extends PacketId, TSchema> = [
  TId,     // packet id
  TSchema, // packet data
  WorldTick?,  // world tick
];

export type AnyPacket = IPacket<PacketId, unknown>;

export type AnyPacketDefinition = IPacketDefinition<number, unknown>;

export type AnySchema = unknown;

type NumericArrayView = ArrayBufferView<ArrayBufferLike> & ArrayLike<number>;

export interface Serializable {
  serialize(): AnySchema;
}

export function normalizePacketDataForValidation<T>(value: T): T {
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    return Array.from(value as unknown as NumericArrayView) as T;
  }

  if (Array.isArray(value)) {
    return value.map(item => normalizePacketDataForValidation(item)) as T;
  }

  if (value && typeof value === 'object') {
    const normalized: Record<string, unknown> = {};

    for (const [ key, nestedValue ] of Object.entries(value)) {
      normalized[key] = normalizePacketDataForValidation(nestedValue);
    }

    return normalized as T;
  }

  return value;
}

export function createPacket<TId extends PacketId, TSchema>(
  packetDef: IPacketDefinition<TId, TSchema>,
  data: TSchema,
  worldTick?: WorldTick,
): IPacket<TId, TSchema> {
  let valid = packetDef.validate(data);
  if (!valid) {
    valid = packetDef.validate(normalizePacketDataForValidation(data));
  }

  if (!valid) {
    throw new Error(`Invalid payload for packet with id ${packetDef.id}. Error: ${Ajv.instance.errorsText(packetDef.validate.errors)}`);
  }

  const packet: IPacket<TId, TSchema> = [packetDef.id, data];

  if (typeof worldTick === 'number') {
    packet.push(worldTick);
  }

  return packet;
}

export function createPacketBufferUnframer(onMessage: (message: Uint8Array) => void): (chunk: Uint8Array) => void {
  let buffer = new Uint8Array(512 * 1024); // 512KB initial buffer
  let view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let used = 0;

  return (chunk: Uint8Array): void => {
    // Grow buffer if needed
    if (used + chunk.length > buffer.length) {
      const requiredSize = Math.max(buffer.length * 2, used + chunk.length);
      
      // Enforce max buffer size cap
      if (requiredSize > MAX_FRAME_BUFFER_SIZE) {
        console.error(`Unframer packet buffer exceeded maximum size of ${MAX_FRAME_BUFFER_SIZE} bytes, discarding packet...`);
        used = 0;
        return;
      }
      
      const grown = new Uint8Array(requiredSize);
      grown.set(buffer.subarray(0, used));
      buffer = grown;
      view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    }

    // Append new chunk
    buffer.set(chunk, used);
    used += chunk.length;

    // Extract and process complete messages
    let readOffset = 0;
    
    while (used - readOffset >= FRAME_HEADER_SIZE) {
      const length = view.getUint32(readOffset, false); // big-endian
      const totalFrameSize = FRAME_HEADER_SIZE + length;
      
      // Wait for complete message
      if (used - readOffset < totalFrameSize) {
        break;
      }

      // Zero-copy: subarray() returns a view, not a copy
      // BUT! Callback must process immediately before buffer is modified
      const messageStart = readOffset + FRAME_HEADER_SIZE;
      onMessage(buffer.subarray(messageStart, messageStart + length));
      
      readOffset += totalFrameSize;
    }

    // Shift remaining data to start (after all callbacks complete)
    if (readOffset > 0) {
      if (used > readOffset) {
        buffer.copyWithin(0, readOffset, used);
      }

      used -= readOffset;
    }
  };
}

export function definePacket<TId extends PacketId, TSchema>(
  id: TId,
  schema: JSONSchemaType<TSchema>,
): IPacketDefinition<TId, TSchema> {
  return {
    id,
    schema,
    validate: Ajv.instance.compile(schema),
  };
};

export function framePacketBuffer(buffer: Uint8Array): Uint8Array {
  const framed = new Uint8Array(FRAME_HEADER_SIZE + buffer.length);
  const view = new DataView(framed.buffer);
  
  // Write length as big-endian uint32 in first 4 bytes
  view.setUint32(0, buffer.length, false);
  
  // Copy data after header
  framed.set(buffer, FRAME_HEADER_SIZE);
  
  return framed;
}
