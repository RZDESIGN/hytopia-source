import { definePacket, PacketId } from '../PacketCore';
import type { IPacket } from '../PacketCore';
import { predictedBlockEditsSendSchema } from '../../schemas/PredictedBlockEditsSend';
import type { PredictedBlockEditsSendSchema } from '../../schemas/PredictedBlockEditsSend';

export type PredictedBlockEditsSendPacket = IPacket<typeof PacketId.PREDICTED_BLOCK_EDITS_SEND, PredictedBlockEditsSendSchema>;

export const predictedBlockEditsSendPacketDefinition = definePacket(
  PacketId.PREDICTED_BLOCK_EDITS_SEND,
  predictedBlockEditsSendSchema,
);
