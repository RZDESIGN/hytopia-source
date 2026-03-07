import type { Vector3Like } from 'three';
import type ChunkManager from '../chunks/ChunkManager';

type GridCoordinate = {
  x: number;
  y: number;
  z: number;
};

type HeapEntry = {
  coordinate: GridCoordinate;
  key: string;
};

const ENTITY_HEIGHT_BLOCKS = 2;
const MAX_ENDPOINT_SCAN_DOWN_BLOCKS = 48;
const MAX_ENDPOINT_SCAN_UP_BLOCKS = 8;
const MAX_ENDPOINT_SEARCH_RADIUS = 2;
const MAX_FALL_BLOCKS = 8;
const MAX_JUMP_BLOCKS = 2;
const MAX_OPEN_SET_ITERATIONS = 4096;
const MAX_ROUTE_DISTANCE_MULTIPLIER = 3;

const HORIZONTAL_NEIGHBOR_OFFSETS: GridCoordinate[] = [
  { x: 0, y: 0, z: 1 },
  { x: 1, y: 0, z: 0 },
  { x: 0, y: 0, z: -1 },
  { x: -1, y: 0, z: 0 },
  { x: 1, y: 0, z: 1 },
  { x: 1, y: 0, z: -1 },
  { x: -1, y: 0, z: 1 },
  { x: -1, y: 0, z: -1 },
];

class MinHeap<T> {
  private _items: T[] = [];
  private _compare: (a: T, b: T) => number;

  public constructor(compare: (a: T, b: T) => number) {
    this._compare = compare;
  }

  public get isEmpty(): boolean {
    return this._items.length === 0;
  }

  public push(item: T): void {
    this._items.push(item);
    this._bubbleUp(this._items.length - 1);
  }

  public pop(): T | undefined {
    if (this._items.length === 0) {
      return undefined;
    }

    const root = this._items[0];
    const last = this._items.pop()!;

    if (this._items.length > 0) {
      this._items[0] = last;
      this._bubbleDown(0);
    }

    return root;
  }

  private _bubbleUp(index: number): void {
    let currentIndex = index;

    while (currentIndex > 0) {
      const parentIndex = Math.floor((currentIndex - 1) / 2);

      if (this._compare(this._items[currentIndex], this._items[parentIndex]) >= 0) {
        break;
      }

      const current = this._items[currentIndex];
      this._items[currentIndex] = this._items[parentIndex];
      this._items[parentIndex] = current;
      currentIndex = parentIndex;
    }
  }

  private _bubbleDown(index: number): void {
    let currentIndex = index;

    while (true) {
      const leftIndex = currentIndex * 2 + 1;
      const rightIndex = leftIndex + 1;
      let smallestIndex = currentIndex;

      if (leftIndex < this._items.length && this._compare(this._items[leftIndex], this._items[smallestIndex]) < 0) {
        smallestIndex = leftIndex;
      }

      if (rightIndex < this._items.length && this._compare(this._items[rightIndex], this._items[smallestIndex]) < 0) {
        smallestIndex = rightIndex;
      }

      if (smallestIndex === currentIndex) {
        break;
      }

      const current = this._items[currentIndex];
      this._items[currentIndex] = this._items[smallestIndex];
      this._items[smallestIndex] = current;
      currentIndex = smallestIndex;
    }
  }
}

function coordinateKey(coordinate: GridCoordinate): string {
  return `${coordinate.x},${coordinate.y},${coordinate.z}`;
}

function hasBlock(chunkManager: ChunkManager, coordinate: GridCoordinate): boolean | undefined {
  const block = chunkManager.getBlock(coordinate);

  if (!block) {
    return undefined;
  }

  return block.blockId !== 0;
}

function isWalkableCoordinate(chunkManager: ChunkManager, coordinate: GridCoordinate): boolean | undefined {
  const hasGround = hasBlock(chunkManager, { x: coordinate.x, y: coordinate.y - 1, z: coordinate.z });

  if (hasGround === undefined) {
    return undefined;
  }

  if (!hasGround) {
    return false;
  }

  for (let i = 0; i < ENTITY_HEIGHT_BLOCKS; i++) {
    const occupied = hasBlock(chunkManager, { x: coordinate.x, y: coordinate.y + i, z: coordinate.z });

    if (occupied === undefined) {
      return undefined;
    }

    if (occupied) {
      return false;
    }
  }

  return true;
}

function findGroundedCoordinate(chunkManager: ChunkManager, position: Vector3Like): GridCoordinate | null {
  const start = {
    x: Math.floor(position.x),
    y: Math.floor(position.y),
    z: Math.floor(position.z),
  };

  const offsets: { dx: number; dz: number }[] = [];

  for (let radius = 0; radius <= MAX_ENDPOINT_SEARCH_RADIUS; radius++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) {
          continue;
        }

        offsets.push({ dx, dz });
      }
    }
  }

  offsets.sort((a, b) => (Math.abs(a.dx) + Math.abs(a.dz)) - (Math.abs(b.dx) + Math.abs(b.dz)));

  for (const offset of offsets) {
    const baseX = start.x + offset.dx;
    const baseZ = start.z + offset.dz;

    for (let dy = -MAX_ENDPOINT_SCAN_UP_BLOCKS; dy <= MAX_ENDPOINT_SCAN_DOWN_BLOCKS; dy++) {
      const candidate = {
        x: baseX,
        y: start.y - dy,
        z: baseZ,
      };

      const walkable = isWalkableCoordinate(chunkManager, candidate);

      if (walkable) {
        return candidate;
      }
    }
  }

  return null;
}

function isNeighborBlocked(
  chunkManager: ChunkManager,
  currentCoordinate: GridCoordinate,
  neighborCoordinate: GridCoordinate,
): boolean | null {
  const x = neighborCoordinate.x;
  const y = neighborCoordinate.y;
  const z = neighborCoordinate.z;
  const currentX = currentCoordinate.x;
  const currentZ = currentCoordinate.z;

  const hasGround = hasBlock(chunkManager, { x, y: y - 1, z });
  if (hasGround === undefined) {
    return null;
  }

  if (!hasGround) {
    return true;
  }

  for (let i = 0; i < ENTITY_HEIGHT_BLOCKS; i++) {
    const occupied = hasBlock(chunkManager, { x, y: y + i, z });

    if (occupied === undefined) {
      return null;
    }

    if (occupied) {
      return true;
    }
  }

  if (x !== currentX && z !== currentZ) {
    for (let i = 0; i < ENTITY_HEIGHT_BLOCKS; i++) {
      const occupiedX = hasBlock(chunkManager, { x, y: y + i, z: currentZ });
      const occupiedZ = hasBlock(chunkManager, { x: currentX, y: y + i, z });

      if (occupiedX === undefined || occupiedZ === undefined) {
        return null;
      }

      if (occupiedX || occupiedZ) {
        return true;
      }
    }
  }

  return false;
}

function reconstructPath(cameFrom: Map<string, GridCoordinate>, current: GridCoordinate): GridCoordinate[] {
  const path = [current];
  let cursor = current;

  while (cameFrom.has(coordinateKey(cursor))) {
    cursor = cameFrom.get(coordinateKey(cursor))!;
    path.unshift(cursor);
  }

  return path;
}

function heuristic(a: GridCoordinate, b: GridCoordinate): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z);
}

function buildNeighborOffsets(start: GridCoordinate, end: GridCoordinate): GridCoordinate[] {
  const verticalOffsets: { distanceToTargetY: number; y: number }[] = [];

  for (let y = MAX_JUMP_BLOCKS; y >= -MAX_FALL_BLOCKS; y--) {
    if (y === 0) {
      continue;
    }

    verticalOffsets.push({
      distanceToTargetY: Math.abs(start.y + y - end.y),
      y,
    });
  }

  verticalOffsets.sort((a, b) => a.distanceToTargetY - b.distanceToTargetY);

  return [
    ...HORIZONTAL_NEIGHBOR_OFFSETS,
    ...verticalOffsets.flatMap(({ y }) => HORIZONTAL_NEIGHBOR_OFFSETS.map((offset) => ({
      x: offset.x,
      y,
      z: offset.z,
    }))),
  ];
}

export function findArrowPath(
  chunkManager: ChunkManager,
  startPosition: Vector3Like,
  endPosition: Vector3Like,
): GridCoordinate[] | null {
  const start = findGroundedCoordinate(chunkManager, startPosition);
  const end = findGroundedCoordinate(chunkManager, endPosition);

  if (!start || !end) {
    return null;
  }

  if (start.x === end.x && start.y === end.y && start.z === end.z) {
    return [start];
  }

  const directPathIsBlocked = isNeighborBlocked(chunkManager, start, end);
  const isClose = Math.abs(end.x - start.x) <= 2 && Math.abs(end.y - start.y) <= 2 && Math.abs(end.z - start.z) <= 2;

  if (isClose && directPathIsBlocked === false) {
    return [start, end];
  }

  const startKey = coordinateKey(start);
  const cameFrom = new Map<string, GridCoordinate>();
  const gScore = new Map<string, number>([[startKey, 0]]);
  const fScore = new Map<string, number>([[startKey, heuristic(start, end)]]);
  const closedSet = new Set<string>();
  const openSet = new MinHeap<HeapEntry>((a, b) => (fScore.get(a.key) ?? Number.POSITIVE_INFINITY) - (fScore.get(b.key) ?? Number.POSITIVE_INFINITY));
  const neighborOffsets = buildNeighborOffsets(start, end);
  const maxDistance = heuristic(start, end);
  const iterationLimit = Math.min(MAX_OPEN_SET_ITERATIONS, Math.max(256, maxDistance * 40));

  openSet.push({ coordinate: start, key: startKey });

  let iterations = 0;

  while (!openSet.isEmpty && iterations < iterationLimit) {
    iterations++;

    const currentEntry = openSet.pop();
    if (!currentEntry) {
      break;
    }

    const current = currentEntry.coordinate;

    if (current.x === end.x && current.y === end.y && current.z === end.z) {
      return reconstructPath(cameFrom, current);
    }

    if (closedSet.has(currentEntry.key)) {
      continue;
    }

    closedSet.add(currentEntry.key);
    const currentGScore = gScore.get(currentEntry.key) ?? 0;
    const xzOffsetFloorBlocked = new Map<string, boolean>();

    for (const offset of neighborOffsets) {
      const requiresFalling = offset.y < 0;
      const xzOffsetKey = `${offset.x},${offset.z}`;

      if (requiresFalling && xzOffsetFloorBlocked.has(xzOffsetKey)) {
        continue;
      }

      const neighbor = {
        x: current.x + offset.x,
        y: current.y + offset.y,
        z: current.z + offset.z,
      };

      if (heuristic(neighbor, end) > Math.max(24, maxDistance * MAX_ROUTE_DISTANCE_MULTIPLIER)) {
        continue;
      }

      const neighborKey = coordinateKey(neighbor);

      if (closedSet.has(neighborKey)) {
        continue;
      }

      const blocked = isNeighborBlocked(chunkManager, current, neighbor);

      if (blocked === null) {
        continue;
      }

      if (requiresFalling && blocked) {
        xzOffsetFloorBlocked.set(xzOffsetKey, true);
        continue;
      }

      if (blocked) {
        continue;
      }

      const dx = Math.abs(offset.x);
      const dy = Math.abs(offset.y);
      const dz = Math.abs(offset.z);
      const stepCost = Math.max(dx, dy, dz) === 1 && dx + dy + dz > 1 ? 1.4 : 1;
      const tentativeGScore = currentGScore + stepCost;

      if (tentativeGScore >= (gScore.get(neighborKey) ?? Number.POSITIVE_INFINITY)) {
        continue;
      }

      cameFrom.set(neighborKey, current);
      gScore.set(neighborKey, tentativeGScore);
      fScore.set(neighborKey, tentativeGScore + heuristic(neighbor, end));
      openSet.push({ coordinate: neighbor, key: neighborKey });
    }
  }

  return null;
}
