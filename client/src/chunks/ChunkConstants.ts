export const CHUNK_BUFFER_GEOMETRY_NUM_POSITION_COMPONENTS = 3;
export const CHUNK_BUFFER_GEOMETRY_NUM_NORMAL_COMPONENTS = 3;
export const CHUNK_BUFFER_GEOMETRY_NUM_UV_COMPONENTS = 2;
export const CHUNK_BUFFER_GEOMETRY_NUM_COLOR_COMPONENTS = 4;
export const CHUNK_BUFFER_GEOMETRY_NUM_LIGHT_LEVEL_COMPONENTS = 1;
export const CHUNK_BUFFER_GEOMETRY_NUM_FOAM_LEVEL_COMPONENTS = 4;
export const CHUNK_BUFFER_GEOMETRY_NUM_SURFACE_FLAG_COMPONENTS = 1;
export const CHUNK_BUFFER_GEOMETRY_NUM_WIND_DATA_COMPONENTS = 3;

export const CHUNK_SIZE = 16;
export const CHUNK_INDEX_RANGE = CHUNK_SIZE - 1;

// Batch meshing: 2x2x2 chunks batched together for reduced draw calls.
// Larger batch sizes cubically reduce draw calls (batches are 3D),
// but can have view distance granularity issues on lower quality settings. 
export const BATCH_SIZE = 2; 
export const BATCH_WORLD_SIZE = CHUNK_SIZE * BATCH_SIZE; // 32 blocks per batch dimension

export type ChunkId = `${number},${number},${number}`;
export type BatchId = `${number},${number},${number}`;
