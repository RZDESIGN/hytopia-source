import * as bidirectionalPackets from './bidirectional';
import * as inboundPackets from './inbound';
import * as outboundPackets from './outbound';
import { normalizePacketDataForValidation } from './PacketCore';
import type { PacketId, AnyPacket, AnyPacketDefinition, IPacket } from './PacketCore';

export { bidirectionalPackets, inboundPackets, outboundPackets };

export const registeredPackets = new Map<PacketId, AnyPacketDefinition>();

const allPackets = { ...bidirectionalPackets, ...inboundPackets, ...outboundPackets };

for (const packet of Object.values(allPackets)) {
  if ('id' in packet && 'schema' in packet) {
    const definition = packet as AnyPacketDefinition;

    if (registeredPackets.has(definition.id)) {
      throw new Error(`Packet with id ${definition.id} is already registered.`);
    }
    
    registeredPackets.set(definition.id, definition);
  }
}

export function isValidPacket(packet: IPacket<PacketId, unknown>): packet is AnyPacket {
  if (
    typeof packet !== 'object' || 
    packet === null || 
    typeof packet[0] !== 'number' || packet[0] < 0 ||
    packet[1] === undefined ||
    (packet[2] !== undefined && (typeof packet[2] !== 'number' || packet[2] < 0))
  ) {
    return false;
  }

  const packetDef = registeredPackets.get(packet[0]);
  return !!packetDef && (
    packetDef.validate(packet[1]) ||
    packetDef.validate(normalizePacketDataForValidation(packet[1]))
  );
}
