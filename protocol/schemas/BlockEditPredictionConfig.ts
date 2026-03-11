import type { JSONSchemaType } from 'ajv';

export type BlockEditPredictionConfigSchema = {
  m: number;         // max distance
  i: number;         // place block type id, 0 disables placement prediction
  r?: number;        // place block rotation index
};

export const blockEditPredictionConfigSchema: JSONSchemaType<BlockEditPredictionConfigSchema> = {
  type: 'object',
  properties: {
    m: { type: 'number' },
    i: { type: 'number' },
    r: { type: 'number', nullable: true },
  },
  required: [ 'm', 'i' ],
  additionalProperties: false,
};
