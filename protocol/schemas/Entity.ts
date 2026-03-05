import { rgbColorSchema } from './RgbColor';
import { modelAnimationSchema } from './ModelAnimation';
import { modelNodeOverrideSchema } from './ModelNodeOverride';
import { outlineSchema } from './Outline';
import { quaternionSchema } from './Quaternion';
import { vectorSchema } from './Vector';
import type { JSONSchemaType } from 'ajv';
import type { ModelAnimationSchema } from './ModelAnimation';
import type { ModelNodeOverrideSchema } from './ModelNodeOverride';
import type { OutlineSchema } from './Outline';
import type { QuaternionSchema } from './Quaternion';
import type { RgbColorSchema } from './RgbColor';
import type { VectorSchema } from './Vector';

export type EntitySchema = {
  aq?: number;                    // last applied input sequence number (owner-only)
  i: number;                      // entity id
  bh?: VectorSchema;              // block half extents
  bt?: string;                    // block texture uri
  e?: boolean;                    // environmental
  ec?: RgbColorSchema;            // emissive color
  ei?: number;                    // emissive intensity
  m?: string;                     // model uri
  ma?: ModelAnimationSchema[];    // model animations
  mo?: ModelNodeOverrideSchema[]; // model node overrides
  mt?: string;                    // model texture uri (custom override)
  n?: string;                     // name
  o?: number;                     // opacity
  ol?: OutlineSchema;             // outline options
  p?: VectorSchema;               // position
  pe?: number;                    // parent entity id
  pi?: number;                    // position interpolation time in milliseconds
  pn?: string;                    // parent node name
  r?: QuaternionSchema;           // rotation
  ri?: number;                    // rotation interpolation time in milliseconds
  rm?: boolean;                   // removed/remove
  si?: number;                    // model scale interpolation time in milliseconds
  sv?: VectorSchema;              // model scale vector for each axis
  t?: RgbColorSchema;             // tint color
}

export const entitySchema: JSONSchemaType<EntitySchema> = {
  type: 'object',
  properties: {
    aq: { type: 'number', nullable: true },
    i: { type: 'number' },
    bh: { ...vectorSchema, nullable: true },
    bt: { type: 'string', nullable: true },
    e: { type: 'boolean', nullable: true },
    ec: { ...rgbColorSchema, nullable: true },
    ei: { type: 'number', nullable: true },
    m: { type: 'string', nullable: true },
    ma: { type: 'array', items: { ...modelAnimationSchema }, nullable: true },
    mo: { type: 'array', items: { ...modelNodeOverrideSchema }, nullable: true },
    mt: { type: 'string', nullable: true },
    n: { type: 'string', nullable: true },
    o: { type: 'number', nullable: true },
    ol: { ...outlineSchema, nullable: true },
    p: { ...vectorSchema, nullable: true },
    pi: { type: 'number', nullable: true },
    pe: { type: 'number', nullable: true },
    pn: { type: 'string', nullable: true },
    r: { ...quaternionSchema, nullable: true },
    ri: { type: 'number', nullable: true },
    rm: { type: 'boolean', nullable: true },
    si: { type: 'number', nullable: true },
    sv: { ...vectorSchema, nullable: true },
    t: { ...rgbColorSchema, nullable: true },
  },
  required: [ 'i' ],
  additionalProperties: false,
}
