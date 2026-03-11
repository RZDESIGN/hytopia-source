import type Vector3Like from '../types/math/Vector3Like';

export type SpatialInterestCoordinate = Vector3Like | [number, number, number];

export type ChunkSpatialInterestIndexOptions = {
  chunkSize: number;
  horizontalRadius: number;
  verticalRadius: number;
};

export class ChunkSpatialInterestIndex {
  constructor(options: ChunkSpatialInterestIndexOptions);
  clear(): void;
  update(id: number, position: SpatialInterestCoordinate | undefined, attachedEntityId?: number | undefined): void;
  updatePosition(id: number, position: SpatialInterestCoordinate | undefined): void;
  remove(id: number): void;
  hasAttachedIds(entityId: number): boolean;
  getAttachedIds(entityId: number): ReadonlySet<number> | undefined;
  collectIdsInRange(centerChunkOrigin: SpatialInterestCoordinate): Set<number>;
}
