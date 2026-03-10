import type { JSONSchemaType } from 'ajv';

export type BlockEditPredictionResultSchema = {
  p: string;                 // prediction id
  a: 'confirm' | 'rollback'; // action
};

export const blockEditPredictionResultSchema: JSONSchemaType<BlockEditPredictionResultSchema> = {
  type: 'object',
  properties: {
    p: { type: 'string' },
    a: { type: 'string', enum: [ 'confirm', 'rollback' ] },
  },
  required: [ 'p', 'a' ],
  additionalProperties: false,
};
