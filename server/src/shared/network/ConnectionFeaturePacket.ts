import protocol from '@hytopia.com/server-protocol';
import { JSONSchemaType } from 'ajv';

export type ConnectionSchemaWithFeatures = protocol.ConnectionSchema & {
  f?: number;
};

const connectionSchemaWithFeatures: JSONSchemaType<ConnectionSchemaWithFeatures> = {
  type: 'object',
  properties: {
    i: { type: 'string', nullable: true },
    k: { type: 'boolean', nullable: true },
    f: { type: 'number', nullable: true },
  },
  additionalProperties: false,
};

export const connectionPacketDefinitionWithFeatures = protocol.definePacket(
  protocol.PacketId.CONNECTION,
  connectionSchemaWithFeatures,
);

let connectionPacketDefinitionRegistered = false;

export const registerConnectionFeaturePacketDefinition = (): void => {
  if (connectionPacketDefinitionRegistered) {
    return;
  }

  protocol.registeredPackets.set(
    protocol.PacketId.CONNECTION,
    connectionPacketDefinitionWithFeatures as unknown as protocol.AnyPacketDefinition,
  );
  connectionPacketDefinitionRegistered = true;
};
