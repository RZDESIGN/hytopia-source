import type { JSONSchemaType } from 'ajv';

export type BlockEditPredictionConfigSchema = {
  m: number;         // max distance
  i: number | null;  // place block type id
  r: number | null;  // place block rotation index
};

export const blockEditPredictionConfigSchema: JSONSchemaType<BlockEditPredictionConfigSchema> = {
  type: 'object',
  properties: {
    m: { type: 'number' },
    i: { type: 'number', nullable: true },
    r: { type: 'number', nullable: true },
  },
  required: [ 'm', 'i', 'r' ],
  additionalProperties: false,
};
