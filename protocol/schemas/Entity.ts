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
  pc?: number;                    // local prediction controller flags bitmask (owner-only)
  fd?: boolean;                  // whether fast movement is the default intent (owner-only)
  js?: number;                    // local prediction just-submerged remaining ms (owner-only)
  i: number;                      // entity id
  ju?: number;                    // local prediction jump velocity (owner-only)
  bh?: VectorSchema;              // block half extents
  bt?: string;                    // block texture uri
  e?: boolean;                    // environmental
  ec?: RgbColorSchema;            // emissive color
  ei?: number;                    // emissive intensity
  m?: string;                     // model uri
  ma?: ModelAnimationSchema[];    // model animations
  mo?: ModelNodeOverrideSchema[]; // model node overrides
  mv?: VectorSchema;              // local prediction motion-basis velocity (owner-only)
  mt?: string;                    // model texture uri (custom override)
  n?: string;                     // name
  o?: number;                     // opacity
  ol?: OutlineSchema;             // outline options
  p?: VectorSchema;               // position
  pe?: number;                    // parent entity id
  pf?: number;                    // local prediction flags bitmask (owner-only)
  pi?: number;                    // position interpolation time in milliseconds
  py?: number;                    // local prediction movement reference yaw in radians (owner-only)
  rh?: number;                    // rollback-predicted input mask high word (owner-only)
  rl?: number;                    // rollback-predicted input mask low word (owner-only)
  pn?: string;                    // parent node name
  r?: QuaternionSchema;           // rotation
  ri?: number;                    // rotation interpolation time in milliseconds
  rm?: boolean;                   // removed/remove
  rv?: number;                    // local prediction run velocity (owner-only)
  sc?: number;                    // local prediction swim-upward cooldown remaining ms (owner-only)
  si?: number;                    // model scale interpolation time in milliseconds
  sf?: number;                    // local prediction swim-fast velocity (owner-only)
  sl?: number;                    // local prediction swim-slow velocity (owner-only)
  sv?: VectorSchema;              // model scale vector for each axis
  su?: number;                    // local prediction swim-upward velocity (owner-only)
  t?: RgbColorSchema;             // tint color
  wv?: number;                    // local prediction walk velocity (owner-only)
}

export const entitySchema: JSONSchemaType<EntitySchema> = {
  type: 'object',
  properties: {
    aq: { type: 'number', nullable: true },
    pc: { type: 'number', nullable: true },
    fd: { type: 'boolean', nullable: true },
    js: { type: 'number', nullable: true },
    i: { type: 'number' },
    ju: { type: 'number', nullable: true },
    bh: { ...vectorSchema, nullable: true },
    bt: { type: 'string', nullable: true },
    e: { type: 'boolean', nullable: true },
    ec: { ...rgbColorSchema, nullable: true },
    ei: { type: 'number', nullable: true },
    m: { type: 'string', nullable: true },
    ma: { type: 'array', items: { ...modelAnimationSchema }, nullable: true },
    mo: { type: 'array', items: { ...modelNodeOverrideSchema }, nullable: true },
    mv: { ...vectorSchema, nullable: true },
    mt: { type: 'string', nullable: true },
    n: { type: 'string', nullable: true },
    o: { type: 'number', nullable: true },
    ol: { ...outlineSchema, nullable: true },
    p: { ...vectorSchema, nullable: true },
    pi: { type: 'number', nullable: true },
    pe: { type: 'number', nullable: true },
    pf: { type: 'number', nullable: true },
    py: { type: 'number', nullable: true },
    rh: { type: 'number', nullable: true },
    rl: { type: 'number', nullable: true },
    pn: { type: 'string', nullable: true },
    r: { ...quaternionSchema, nullable: true },
    ri: { type: 'number', nullable: true },
    rm: { type: 'boolean', nullable: true },
    rv: { type: 'number', nullable: true },
    sc: { type: 'number', nullable: true },
    si: { type: 'number', nullable: true },
    sf: { type: 'number', nullable: true },
    sl: { type: 'number', nullable: true },
    sv: { ...vectorSchema, nullable: true },
    su: { type: 'number', nullable: true },
    t: { ...rgbColorSchema, nullable: true },
    wv: { type: 'number', nullable: true },
  },
  required: [ 'i' ],
  additionalProperties: false,
}
