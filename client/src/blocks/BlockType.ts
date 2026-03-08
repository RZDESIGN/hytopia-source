import type { Vector3Tuple, Vector4Tuple } from 'three';
import {
  DEFAULT_BLOCK_AO_INTENSITY,
  DEFAULT_BLOCK_COLOR,
  DEFAULT_BLOCK_FACES,
  DEFAULT_BLOCK_FACE_GEOMETRIES,
  DEFAULT_BLOCK_NEIGHBOR_OFFSETS,
} from './BlockConstants';
import type {
  BlockFace,
  BlockFaceGeometry,
  BlockId,
  BlockTextureUri,
} from './BlockConstants';

/** Precomputed data for each triangle in a trimesh block type. */
export type TrimeshTriangleData = {
  normalX: number;
  normalY: number;
  normalZ: number;
  v0x: number;
  v0y: number;
  v0z: number;
  v1x: number;
  v1y: number;
  v1z: number;
  v2x: number;
  v2y: number;
  v2z: number;
  v0u: number;
  v0v: number;
  v1u: number;
  v1v: number;
  v2u: number;
  v2v: number;
};

export type BlockTypeData = {
  id: BlockId;
  isLiquid: boolean;
  name: string;
  surfaceGrass?: boolean;
  textureUris: Record<BlockFace, BlockTextureUri>;
  lightLevel?: number;
  trimeshIndices?: Uint32Array;
  trimeshVertices?: Float32Array;
  transparencyRatio?: number;
}

export default class BlockType {
  private _id: BlockId;
  private _aoIntensity: Vector4Tuple = DEFAULT_BLOCK_AO_INTENSITY;
  private _blockFaces: BlockFace[] = DEFAULT_BLOCK_FACES;
  private _blockFaceGeometries: Record<BlockFace, BlockFaceGeometry> = DEFAULT_BLOCK_FACE_GEOMETRIES;
  private _blockNeighborOffsets: Vector3Tuple[] = DEFAULT_BLOCK_NEIGHBOR_OFFSETS;
  private _color: Vector4Tuple = DEFAULT_BLOCK_COLOR;
  private _isLiquid: boolean = false;
  private _name: string;
  private _surfaceGrass: boolean = false;
  private _textureUris: Record<BlockFace, BlockTextureUri>;
  private _lightLevel?: number;
  private _trimeshIndices?: Uint32Array;
  private _trimeshVertices?: Float32Array;
  private _trimeshTriangleData?: TrimeshTriangleData[];
  private _transparencyRatio: number = 0;

  constructor(data: BlockTypeData) {
    if (data.id === 0) {
      throw new Error('BlockType.constructor(): Block type id cannot be 0 because it is reserved for air!');
    }

    this._id = data.id;
    this._isLiquid = data.isLiquid;
    this._name = data.name;
    this._surfaceGrass = data.surfaceGrass ?? false;
    this._textureUris = data.textureUris;
    this._lightLevel = data.lightLevel;
    this._trimeshIndices = data.trimeshIndices;
    this._trimeshVertices = data.trimeshVertices;
    this.setTransparencyRatio(data.transparencyRatio ?? 0);
  }

  public get id(): BlockId {
    return this._id;
  }

  public get aoIntensity(): Vector4Tuple {
    return this._aoIntensity;
  }

  public get color(): Vector4Tuple {
    return this._color;
  }

  public get faces(): BlockFace[] {
    return this._blockFaces;
  }

  public get faceGeometries(): Record<BlockFace, BlockFaceGeometry> {
    return this._blockFaceGeometries;
  }

  public get isLiquid(): boolean {
    return this._isLiquid;
  }

  public get name(): string {
    return this._name;
  }

  public get neighborOffsets(): Vector3Tuple[] {
    return this._blockNeighborOffsets;
  }

  public get textureUris(): Record<BlockFace, BlockTextureUri> {
    return this._textureUris;
  }

  public get surfaceGrass(): boolean {
    return this._surfaceGrass;
  }

  public setName(name: string): void {
    this._name = name;
  }

  public setTextureUris(textureUris: Record<BlockFace, BlockTextureUri>): void {
    this._textureUris = { ...textureUris };
  }

  public setSurfaceGrass(surfaceGrass: boolean): void {
    this._surfaceGrass = surfaceGrass;
  }

  public getTextureUri(face: BlockFace): BlockTextureUri {
    return this._textureUris[face];
  }

  public get isTrimesh(): boolean {
    return this._trimeshVertices !== undefined && this._trimeshIndices !== undefined;
  }

  public get lightLevel(): number | undefined {
    return this._lightLevel;
  }

  // Only correctly set in the ChunkWorker. Main thread instances default to 0.
  public get transparencyRatio(): number {
    return this._transparencyRatio;
  }

  public setTransparencyRatio(transparencyRatio: number): void {
    if (!Number.isFinite(transparencyRatio)) {
      this._transparencyRatio = 0;
      return;
    }

    this._transparencyRatio = Math.min(1, Math.max(0, transparencyRatio));
  }

  public get trimeshIndices(): Uint32Array | undefined {
    return this._trimeshIndices;
  }

  public get trimeshVertices(): Float32Array | undefined {
    return this._trimeshVertices;
  }

  /**
   * Returns precomputed per-triangle data (normals, vertices, UVs) for trimesh rendering.
   * Computed once on first access and cached for reuse across all chunks and instances.
   */
  public get trimeshTriangleData(): TrimeshTriangleData[] | undefined {
    if (!this.isTrimesh) return undefined;

    if (!this._trimeshTriangleData) {
      const vertices = this._trimeshVertices!;
      const indices = this._trimeshIndices!;
      const triangleCount = indices.length / 3;
      this._trimeshTriangleData = new Array(triangleCount);

      for (let i = 0; i < triangleCount; i++) {
        const i0 = indices[i * 3] * 3, i1 = indices[i * 3 + 1] * 3, i2 = indices[i * 3 + 2] * 3;
        const v0x = vertices[i0], v0y = vertices[i0 + 1], v0z = vertices[i0 + 2];
        const v1x = vertices[i1], v1y = vertices[i1 + 1], v1z = vertices[i1 + 2];
        const v2x = vertices[i2], v2y = vertices[i2 + 1], v2z = vertices[i2 + 2];

        // Compute face normal via cross product
        const e1x = v1x - v0x, e1y = v1y - v0y, e1z = v1z - v0z;
        const e2x = v2x - v0x, e2y = v2y - v0y, e2z = v2z - v0z;
        const nx = e1y * e2z - e1z * e2y;
        const ny = e1z * e2x - e1x * e2z;
        const nz = e1x * e2y - e1y * e2x;
        const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;

        // Determine UV projection based on dominant normal axis
        const absNx = Math.abs(nx), absNy = Math.abs(ny), absNz = Math.abs(nz);
        const useXZ = absNy >= absNx && absNy >= absNz; // Y-dominant
        const useZY = !useXZ && absNx >= absNz;         // X-dominant

        this._trimeshTriangleData[i] = {
          normalX: nx / nLen,
          normalY: ny / nLen,
          normalZ: nz / nLen,
          v0x, v0y, v0z,
          v1x, v1y, v1z,
          v2x, v2y, v2z,
          v0u: useXZ ? v0x : useZY ? v0z : v0x,
          v0v: useXZ ? v0z : v0y,
          v1u: useXZ ? v1x : useZY ? v1z : v1x,
          v1v: useXZ ? v1z : v1y,
          v2u: useXZ ? v2x : useZY ? v2z : v2x,
          v2v: useXZ ? v2z : v2y,
        };
      }
    }

    return this._trimeshTriangleData;
  }
}
