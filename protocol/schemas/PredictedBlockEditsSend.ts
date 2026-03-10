import { predictedBlockEditSchema } from './PredictedBlockEdit';
import type { JSONSchemaType } from 'ajv';
import type { PredictedBlockEditSchema } from './PredictedBlockEdit';

export type PredictedBlockEditsSendSchema = {
  p: string; // prediction id
  e: PredictedBlockEditSchema[];
};

export const predictedBlockEditsSendSchema: JSONSchemaType<PredictedBlockEditsSendSchema> = {
  type: 'object',
  properties: {
    p: { type: 'string' },
    e: {
      type: 'array',
      items: { ...predictedBlockEditSchema },
    },
  },
  required: [ 'p', 'e' ],
  additionalProperties: false,
};
