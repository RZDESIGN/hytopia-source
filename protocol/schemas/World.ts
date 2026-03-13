import { rgbColorSchema } from './RgbColor';
import { vectorSchema } from './Vector';
import type { JSONSchemaType } from 'ajv';
import type { RgbColorSchema } from './RgbColor';
import type { VectorSchema } from './Vector';

export type WorldSchema = {
  i: number;           // id
  ac?: RgbColorSchema; // ambient light color
  ai?: number;         // ambient light intensity
  dc?: RgbColorSchema; // directional light color
  di?: number;         // directional light intensity
  dp?: VectorSchema;   // directional light position
  fc?: RgbColorSchema; // fog color
  ff?: number;         // fog far
  fn?: number;         // fog near
  n?: string;          // name
  s?: string;          // skyboxUri
  sd?: VectorSchema | null; // procedural sky sun direction
  si?: number;         // skybox intensity
  t?: number;          // timestep (seconds)
};

export const worldSchema: JSONSchemaType<WorldSchema> = {
  type: 'object',
  properties: {
    i: { type: 'number' },
    ac: { ...rgbColorSchema, nullable: true },
    ai: { type: 'number', nullable: true },
    dc: { ...rgbColorSchema, nullable: true },
    di: { type: 'number', nullable: true },
    dp: { ...vectorSchema, nullable: true },
    fc: { ...rgbColorSchema, nullable: true },
    ff: { type: 'number', nullable: true },
    fn: { type: 'number', nullable: true },
    n: { type: 'string', nullable: true },
    s: { type: 'string', nullable: true },
    sd: { ...vectorSchema, nullable: true },
    si: { type: 'number', nullable: true },
    t: { type: 'number', nullable: true },
  },
  required: [ 'i' ],
  additionalProperties: false,
}
