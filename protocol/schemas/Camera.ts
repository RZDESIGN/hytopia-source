import type { JSONSchemaType } from 'ajv';
import { vectorSchema } from './Vector';
import type { VectorSchema } from './Vector';

export type CameraSchema = {
  cb?: boolean      // collides with blocks
  m?: number        // camera mode - 0: first person, 1: third person
  e?: number        // entity id to attach camera to
  et?: number       // entity id to track
  fe?: number       // fixed-follow preset entity id
  fo?: number       // film offset, + value shifts right, - shifts left
  ffo?: number      // first person forward offset, moves camera in (+) or out (-) relative to camera position
  fp?: VectorSchema // fixed-follow preset camera offset
  fs?: number       // fixed-follow preset offset space - 0: world, 1: entity
  ft?: VectorSchema // fixed-follow preset focus offset
  fv?: number       // field of view
  h?: string[]      // player model nodes to hide by partial case insensitive match of gltf node names
  mp?: boolean      // model pitches with camera
  my?: boolean      // model yaws with camera
  o?: VectorSchema  // offset - positional relative to target
  p?: VectorSchema  // position to attach camera to
  pt?: VectorSchema // position to track
  pl?: VectorSchema // position to look at
  s?: string[]      // player model nodes to show by partial case insensitive match of gltf node names
  sa?: number       // shoulder angle
  z?: number        // zoom
}

export const cameraSchema: JSONSchemaType<CameraSchema> = {
  type: 'object',
  properties: {
    cb: { type: 'boolean', nullable: true },
    m: { type: 'number', nullable: true },
    e: { type: 'number', nullable: true },
    et: { type: 'number', nullable: true },
    fe: { type: 'number', nullable: true },
    fo: { type: 'number', nullable: true },
    ffo: { type: 'number', nullable: true },
    fp: { ...vectorSchema, nullable: true },
    fs: { type: 'number', nullable: true },
    ft: { ...vectorSchema, nullable: true },
    fv: { type: 'number', nullable: true },
    h: { type: 'array', items: { type: 'string' }, nullable: true },
    mp: { type: 'boolean', nullable: true },
    my: { type: 'boolean', nullable: true },
    o: { ...vectorSchema, nullable: true },
    p: { ...vectorSchema, nullable: true },
    pt: { ...vectorSchema, nullable: true },
    pl: { ...vectorSchema, nullable: true },
    s: { type: 'array', items: { type: 'string' }, nullable: true },
    sa: { type: 'number', nullable: true },
    z: { type: 'number', nullable: true },
  },
  additionalProperties: false,
}
