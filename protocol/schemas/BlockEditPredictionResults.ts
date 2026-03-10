import { blockEditPredictionResultSchema } from './BlockEditPredictionResult';
import type { JSONSchemaType } from 'ajv';
import type { BlockEditPredictionResultSchema } from './BlockEditPredictionResult';

export type BlockEditPredictionResultsSchema = BlockEditPredictionResultSchema[];

export const blockEditPredictionResultsSchema: JSONSchemaType<BlockEditPredictionResultsSchema> = {
  type: 'array',
  items: { ...blockEditPredictionResultSchema },
};
