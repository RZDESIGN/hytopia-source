import { vectorSchema } from './Vector';
import type { JSONSchemaType } from 'ajv';
import type { VectorSchema } from './Vector';

export type PredictedBlockEditSchema = {
  c: VectorSchema; // block global coordinate
  i: number;       // block id
  r?: number;      // block rotation enum index
};

export const predictedBlockEditSchema: JSONSchemaType<PredictedBlockEditSchema> = {
  type: 'object',
  properties: {
    c: vectorSchema,
    i: { type: 'number' },
    r: { type: 'number', nullable: true },
  },
  required: [ 'c', 'i' ],
  additionalProperties: false,
};
