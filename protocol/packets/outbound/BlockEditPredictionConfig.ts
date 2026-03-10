import { definePacket, PacketId } from '../PacketCore';
import type { IPacket } from '../PacketCore';
import { blockEditPredictionConfigSchema } from '../../schemas/BlockEditPredictionConfig';
import type { BlockEditPredictionConfigSchema } from '../../schemas/BlockEditPredictionConfig';
import type { WorldTick } from '../PacketCore';

export type BlockEditPredictionConfigPacket = IPacket<typeof PacketId.BLOCK_EDIT_PREDICTION_CONFIG, BlockEditPredictionConfigSchema> & [WorldTick];

export const blockEditPredictionConfigPacketDefinition = definePacket(
  PacketId.BLOCK_EDIT_PREDICTION_CONFIG,
  blockEditPredictionConfigSchema,
);
