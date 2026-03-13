import { expect, test } from 'bun:test';
import { ChunkSpatialInterestIndex } from '@/shared/helpers/ChunkSpatialInterestIndex.js';

test('chunk spatial interest index skips reinsertion when an id stays in the same chunk', () => {
  const index = new ChunkSpatialInterestIndex({
    chunkSize: 16,
    horizontalRadius: 6,
    verticalRadius: 3,
  });

  expect(index.update(10, { x: 1, y: 2, z: 3 })).toBe(true);
  expect(index.update(10, { x: 15, y: 14, z: 7 })).toBe(false);
  expect(Array.from(index.collectIdsForChunkKeys([ '0,0,0' ]))).toEqual([ 10 ]);
});

test('chunk spatial interest index reports attachment-only changes without moving chunks', () => {
  const index = new ChunkSpatialInterestIndex({
    chunkSize: 16,
    horizontalRadius: 6,
    verticalRadius: 3,
  });

  expect(index.update(20, { x: 1, y: 2, z: 3 }, 100)).toBe(true);
  expect(index.update(20, { x: 4, y: 5, z: 6 }, 100)).toBe(false);
  expect(index.update(20, { x: 4, y: 5, z: 6 }, 101)).toBe(true);
  expect(index.getAttachedIds(100)).toBeUndefined();
  expect(index.getAttachedIds(101)?.has(20)).toBe(true);
});
