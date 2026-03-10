import { definePacket, PacketId } from '../PacketCore';
import type { IPacket } from '../PacketCore';
import { blockEditPredictionResultsSchema } from '../../schemas/BlockEditPredictionResults';
import type { BlockEditPredictionResultsSchema } from '../../schemas/BlockEditPredictionResults';
import type { WorldTick } from '../PacketCore';

export type BlockEditPredictionResultsPacket = IPacket<typeof PacketId.BLOCK_EDIT_PREDICTION_RESULTS, BlockEditPredictionResultsSchema> & [WorldTick];

export const blockEditPredictionResultsPacketDefinition = definePacket(
  PacketId.BLOCK_EDIT_PREDICTION_RESULTS,
  blockEditPredictionResultsSchema,
);
