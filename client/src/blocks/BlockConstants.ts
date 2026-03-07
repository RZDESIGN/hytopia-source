import type { Vector2Tuple, Vector3Tuple, Vector4Tuple } from 'three';

enum BlockFaceEnum {
  left,
  right,
  top,
  bottom,
  front,
  back,
}

export enum BlockFaceAxes {
  left = '-x',
  right = '+x',
  top = '+y',
  bottom = '-y',
  front = '+z',
  back = '-z',
}

export type BlockFace = keyof typeof BlockFaceEnum;
export type BlockId = number;
export type BlockTextureUri = string;

export type BlockFaceAO = {
  corner: Vector3Tuple;
  side1: Vector3Tuple;
  side2: Vector3Tuple;
}

export type BlockFaceGeometry = {
  normal: Vector3Tuple;
  vertices: {
    pos: Vector3Tuple;
    uv: Vector2Tuple;
    ao: BlockFaceAO;
  }[];
}

export type BlocksBufferGeometryData = {
  colors: Float32Array;
  indices: Uint32Array | Uint16Array;
  normals: Float32Array;
  positions: Float32Array;
  uvs: Float32Array;
  lightLevels?: Float32Array;
  foamLevels?: Float32Array;
  foamLevelsDiag?: Float32Array;
  surfaceFlags?: Float32Array;
}

export type BlockTextureAtlasMetadata = {
  x: number;
  invertedY: number;
  width: number;
  height: number;
  averageRGB: [number, number, number];
  needsAlphaTest: boolean;
  isTransparent: boolean;
}

export const BLOCK_ROTATION_MATRICES = [
  [  1, 0, 0,   0, 1, 0,   0, 0, 1 ], // Y_0
  [  0, 0,-1,   0, 1, 0,   1, 0, 0 ], // Y_90
  [ -1, 0, 0,   0, 1, 0,   0, 0,-1 ], // Y_180
  [  0, 0, 1,   0, 1, 0,  -1, 0, 0 ], // Y_270
  [ -1, 0, 0,   0,-1, 0,   0, 0, 1 ], // NY_0
  [  0, 0,-1,   0,-1, 0,  -1, 0, 0 ], // NY_90
  [  1, 0, 0,   0,-1, 0,   0, 0,-1 ], // NY_180
  [  0, 0, 1,   0,-1, 0,   1, 0, 0 ], // NY_270
  [  0,-1, 0,   1, 0, 0,   0, 0, 1 ], // X_0
  [  0, 0,-1,   1, 0, 0,   0,-1, 0 ], // X_90
  [  0, 1, 0,   1, 0, 0,   0, 0,-1 ], // X_180
  [  0, 0, 1,   1, 0, 0,   0, 1, 0 ], // X_270
  [  0, 1, 0,  -1, 0, 0,   0, 0, 1 ], // NX_0
  [  0, 0,-1,  -1, 0, 0,   0, 1, 0 ], // NX_90
  [  0,-1, 0,  -1, 0, 0,   0, 0,-1 ], // NX_180
  [  0, 0, 1,  -1, 0, 0,   0,-1, 0 ], // NX_270
  [  1, 0, 0,   0, 0, 1,   0,-1, 0 ], // Z_0
  [  0, 1, 0,   0, 0, 1,   1, 0, 0 ], // Z_90
  [ -1, 0, 0,   0, 0, 1,   0, 1, 0 ], // Z_180
  [  0,-1, 0,   0, 0, 1,  -1, 0, 0 ], // Z_270
  [  1, 0, 0,   0, 0,-1,   0, 1, 0 ], // NZ_0
  [  0,-1, 0,   0, 0,-1,   1, 0, 0 ], // NZ_90
  [ -1, 0, 0,   0, 0,-1,   0,-1, 0 ], // NZ_180
  [  0, 1, 0,   0, 0,-1,  -1, 0, 0 ], // NZ_270
] as const;

export const BLOCK_TEXTURE_ATLAS_PATH = 'blocks/.atlas/atlas.ktx2'; // These should be relative uri's with no / prefix. Since toAssetUri will add the / separator.
export const BLOCK_TEXTURE_METADATA_PATH = 'blocks/.atlas/atlas.json';
export const MISSING_TEXTURE_URI = '/textures/missing.png';

export const DEFAULT_BLOCK_AO_INTENSITY: Vector4Tuple = [0, 0.5, 0.7, 0.9];

export const DEFAULT_BLOCK_COLOR: Vector4Tuple = [1.0, 1.0, 1.0, 1.0]; //rgba

export const DEFAULT_BLOCK_FACES = Object.keys(BlockFaceAxes) as BlockFace[];

export const DEFAULT_BLOCK_FACE_NORMALS: Record<BlockFace, Vector3Tuple> = {
  left: [-1, 0, 0],
  right: [1, 0, 0],
  top: [0, 1, 0],
  bottom: [0, -1, 0],
  front: [0, 0, 1],
  back: [0, 0, -1],
}

// Face shading multipliers - creates depth by darkening faces based on direction
// Top (+Y): brightest, Sides (+/-X, +/-Z): medium, Bottom (-Y): darkest
export const FACE_SHADE_TOP = 1.0;
export const FACE_SHADE_SIDE = 0.8;
export const FACE_SHADE_BOTTOM = 0.5;

// Sky light configuration for outdoor/indoor shading
// Blocks with clear sky access get full brightness, covered areas get darker
export const SKY_LIGHT_MAX_DISTANCE = 16;       // Max blocks to check upward for sky
export const SKY_LIGHT_MIN_BRIGHTNESS = 0.3;    // Minimum brightness in fully covered areas (0-1)

// Precomputed brightness by ceiling distance (index 0 unused, 1-16 are brightness values)
export const SKY_LIGHT_BRIGHTNESS_LUT = Array.from({ length: SKY_LIGHT_MAX_DISTANCE + 1 }, (_, dy) =>
  dy === 0 ? 0 : SKY_LIGHT_MIN_BRIGHTNESS + (1 - SKY_LIGHT_MIN_BRIGHTNESS) * (dy - 1) / (SKY_LIGHT_MAX_DISTANCE - 1)
);

export const DEFAULT_BLOCK_FACE_GEOMETRIES: Record<BlockFace, BlockFaceGeometry> = {
  left: {
    normal: DEFAULT_BLOCK_FACE_NORMALS.left,
    vertices: [
      // top left (y=1, z=0)
      {
        pos: [0, 1, 0],
        uv: [0, 1],
        ao: {
          corner: [-0.5, 0.5, -0.5],
          side1: [-0.5, 0.5, 0.5],
          side2: [-0.5, -0.5, -0.5],
        },
      },
      // bottom left (y=0, z=0)
      {
        pos: [0, 0, 0],
        uv: [0, 0],
        ao: {
          corner: [-0.5, -0.5, -0.5],
          side1: [-0.5, 0.5, -0.5],
          side2: [-0.5, -0.5, 0.5],
        },
      },
      // top right (y=1, z=1)
      {
        pos: [0, 1, 1],
        uv: [1, 1],
        ao: {
          corner: [-0.5, 0.5, 0.5],
          side1: [-0.5, 0.5, -0.5],
          side2: [-0.5, -0.5, 0.5],
        },
      },
      // bottom right (y=0, z=1)
      {
        pos: [0, 0, 1],
        uv: [1, 0],
        ao: {
          corner: [-0.5, -0.5, 0.5],
          side1: [-0.5, 0.5, 0.5],
          side2: [-0.5, -0.5, -0.5],
        },
      },
    ],
  },
  right: {
    normal: DEFAULT_BLOCK_FACE_NORMALS.right,
    vertices: [
      // top left (y=1, z=1)
      {
        pos: [1, 1, 1],
        uv: [0, 1],
        ao: {
          corner: [0.5, 0.5, 0.5],
          side1: [0.5, 0.5, -0.5],
          side2: [0.5, -0.5, 0.5],
        },
      },
      // bottom left (y=0, z=1)
      {
        pos: [1, 0, 1],
        uv: [0, 0],
        ao: {
          corner: [0.5, -0.5, 0.5],
          side1: [0.5, 0.5, 0.5],
          side2: [0.5, -0.5, -0.5],
        },
      },
      // top right (y=1, z=0)
      {
        pos: [1, 1, 0],
        uv: [1, 1],
        ao: {
          corner: [0.5, 0.5, -0.5],
          side1: [0.5, 0.5, 0.5],
          side2: [0.5, -0.5, -0.5],
        },
      },
      // bottom right (y=0, z=0)
      {
        pos: [1, 0, 0],
        uv: [1, 0],
        ao: {
          corner: [0.5, -0.5, -0.5],
          side1: [0.5, 0.5, -0.5],
          side2: [0.5, -0.5, 0.5],
        },
      },
    ],
  },
  top: {
    normal: DEFAULT_BLOCK_FACE_NORMALS.top,
    vertices: [
      // bottom left (back-left in world space, z=1)
      {
        pos: [0, 1, 1],
        uv: [1, 1],
        ao: {
          corner: [-0.5, 0.5, 0.5],
          side1: [0.5, 0.5, 0.5],
          side2: [-0.5, 0.5, -0.5],
        },
      },
      // bottom right (back-right in world space, z=1)
      {
        pos: [1, 1, 1],
        uv: [0, 1],
        ao: {
          corner: [0.5, 0.5, 0.5],
          side1: [-0.5, 0.5, 0.5],
          side2: [0.5, 0.5, -0.5],
        },
      },
      // top left (front-left in world space, z=0)
      {
        pos: [0, 1, 0],
        uv: [1, 0],
        ao: {
          corner: [-0.5, 0.5, -0.5],
          side1: [0.5, 0.5, -0.5],
          side2: [-0.5, 0.5, 0.5],
        },
      },
      // top right (front-right in world space, z=0)
      {
        pos: [1, 1, 0],
        uv: [0, 0],
        ao: {
          corner: [0.5, 0.5, -0.5],
          side1: [-0.5, 0.5, -0.5],
          side2: [0.5, 0.5, 0.5],
        },
      },
    ],
  },
  bottom: {
    normal: DEFAULT_BLOCK_FACE_NORMALS.bottom,
    vertices: [
      // top right (back-right in world space, z=1)
      {
        pos: [1, 0, 1],
        uv: [1, 0],
        ao: {
          corner: [0.5, -0.5, 0.5],
          side1: [-0.5, -0.5, 0.5],
          side2: [0.5, -0.5, -0.5],
        },
      },
      // top left (back-left in world space, z=1)
      {
        pos: [0, 0, 1],
        uv: [0, 0],
        ao: {
          corner: [-0.5, -0.5, 0.5],
          side1: [0.5, -0.5, 0.5],
          side2: [-0.5, -0.5, -0.5],
        },
      },
      // bottom right (front-right in world space, z=0)
      {
        pos: [1, 0, 0],
        uv: [1, 1],
        ao: {
          corner: [0.5, -0.5, -0.5],
          side1: [-0.5, -0.5, -0.5],
          side2: [0.5, -0.5, 0.5],
        },
      },
      // bottom left (front-left in world space, z=0)
      {
        pos: [0, 0, 0],
        uv: [0, 1],
        ao: {
          corner: [-0.5, -0.5, -0.5],
          side1: [0.5, -0.5, -0.5],
          side2: [-0.5, -0.5, 0.5],
        },
      },
    ],
  },
  front: {
    normal: DEFAULT_BLOCK_FACE_NORMALS.front,
    vertices: [
      // bottom left (x=0, y=0)
      {
        pos: [0, 0, 1],
        uv: [0, 0],
        ao: {
          corner: [-0.5, -0.5, 0.5],
          side1: [0.5, -0.5, 0.5],
          side2: [-0.5, 0.5, 0.5],
        },
      },
      // bottom right (x=1, y=0)
      {
        pos: [1, 0, 1],
        uv: [1, 0],
        ao: {
          corner: [0.5, -0.5, 0.5],
          side1: [-0.5, -0.5, 0.5],
          side2: [0.5, 0.5, 0.5],
        },
      },
      // top left (x=0, y=1)
      {
        pos: [0, 1, 1],
        uv: [0, 1],
        ao: {
          corner: [-0.5, 0.5, 0.5],
          side1: [0.5, 0.5, 0.5],
          side2: [-0.5, -0.5, 0.5],
        },
      },
      // top right (x=1, y=1)
      {
        pos: [1, 1, 1],
        uv: [1, 1],
        ao: {
          corner: [0.5, 0.5, 0.5],
          side1: [-0.5, 0.5, 0.5],
          side2: [0.5, -0.5, 0.5],
        },
      },
    ],
  },
  back: {
    normal: DEFAULT_BLOCK_FACE_NORMALS.back,
    vertices: [
      // bottom left (x=1, y=0)
      {
        pos: [1, 0, 0],
        uv: [0, 0],
        ao: {
          corner: [0.5, -0.5, -0.5],
          side1: [-0.5, -0.5, -0.5],
          side2: [0.5, 0.5, -0.5],
        },
      },
      // bottom right (x=0, y=0)
      {
        pos: [0, 0, 0],
        uv: [1, 0],
        ao: {
          corner: [-0.5, -0.5, -0.5],
          side1: [0.5, -0.5, -0.5],
          side2: [-0.5, 0.5, -0.5],
        },
      },
      // top left (x=1, y=1)
      {
        pos: [1, 1, 0],
        uv: [0, 1],
        ao: {
          corner: [0.5, 0.5, -0.5],
          side1: [-0.5, 0.5, -0.5],
          side2: [0.5, -0.5, -0.5],
        },
      },
      // top right (x=0, y=1)
      {
        pos: [0, 1, 0],
        uv: [1, 1],
        ao: {
          corner: [-0.5, 0.5, -0.5],
          side1: [0.5, 0.5, -0.5],
          side2: [-0.5, -0.5, -0.5],
        },
      },
    ],
  },
};

export const DEFAULT_BLOCK_NEIGHBOR_OFFSETS: Vector3Tuple[] = [
  [0, 0, 0], // self
  [0, 1, 0], // top
  [0, -1, 0], // bottom

  // left
  [-1, 0, 0], // left
  [-1, 1, 0], // top left
  [-1, -1, 0], // bottom left
  
  // right
  [1, 0, 0], // right
  [1, 1, 0], // top right
  [1, -1, 0], // bottom right
  
  // front
  [0, 0, 1], // front
  [0, 1, 1], // top front
  [0, -1, 1], // bottom front
  [-1, 0, 1], // front left
  [-1, 1, 1], // top front left
  [-1, -1, 1], // bottom front left
  [1, 0, 1], // front right
  [1, 1, 1], // top front right
  [1, -1, 1], // bottom front right
  
  // back
  [0, 0, -1], // back
  [0, 1, -1], // top back
  [0, -1, -1], // bottom back
  [-1, 0, -1], // back left
  [-1, 1, -1], // top back left
  [-1, -1, -1], // bottom back left
  [1, 0, -1], // back right
  [1, 1, -1], // top back right
  [1, -1, -1], // bottom back right
];

export const WATER_SURFACE_Y_OFFSET: number = -0.1;
export const ALPHA_TEST_THRESHOLD: number = 0.05;
export const MAX_LIGHT_LEVEL = 15;
export const LIGHT_LEVEL_STRENGTH_MULTIPLIER = (1.0).toFixed(1);

export enum BlockTextureAtlasEventType {
  Ready = 'BLOCK_TEXTURE_ATLAS.READY',
}

export namespace BlockTextureAtlasEventPayload {
  export interface IReady {}
}

export type BlockTextureMetadata = {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  averageRGB: [number, number, number];
  isTransparent: boolean;
  needsAlphaTest: boolean;
  transparencyRatio: number;
};

export type BlockTextureAtlasMetadataJson = {
  version: number;
  textureSize: number;
  padding: number;
  atlasWidth: number;
  atlasHeight: number;
  textures: Record<string, BlockTextureMetadata>;
  sourceHash: string;
};
