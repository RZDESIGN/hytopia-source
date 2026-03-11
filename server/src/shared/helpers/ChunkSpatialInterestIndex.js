const axisComponent = (vector, axis) => {
  if (Array.isArray(vector)) {
    return vector[axis];
  }

  if (!vector || typeof vector !== 'object') {
    return undefined;
  }

  switch (axis) {
    case 0: return vector.x;
    case 1: return vector.y;
    case 2: return vector.z;
    default: return undefined;
  }
};

export class ChunkSpatialInterestIndex {
  constructor({ chunkSize, horizontalRadius, verticalRadius }) {
    this._chunkSize = chunkSize;
    this._chunkAxesRange = chunkSize - 1;
    this._horizontalRadius = horizontalRadius;
    this._verticalRadius = verticalRadius;
    this._idsByChunkKey = new Map();
    this._chunkKeyById = new Map();
    this._attachedEntityIdById = new Map();
    this._idsByAttachedEntityId = new Map();
  }

  clear() {
    this._idsByChunkKey.clear();
    this._chunkKeyById.clear();
    this._attachedEntityIdById.clear();
    this._idsByAttachedEntityId.clear();
  }

  update(id, position, attachedEntityId = undefined) {
    this._setAttachedEntity(id, attachedEntityId);
    this.updatePosition(id, position);
  }

  updatePosition(id, position) {
    this._deleteIndexEntry(id);

    const chunkKey = this._chunkKeyForGlobalCoordinate(position);
    if (!chunkKey) {
      return;
    }

    let ids = this._idsByChunkKey.get(chunkKey);
    if (!ids) {
      ids = new Set();
      this._idsByChunkKey.set(chunkKey, ids);
    }

    ids.add(id);
    this._chunkKeyById.set(id, chunkKey);
  }

  remove(id) {
    this._setAttachedEntity(id, undefined);
    this._deleteIndexEntry(id);
  }

  hasAttachedIds(entityId) {
    return this._idsByAttachedEntityId.has(entityId);
  }

  getAttachedIds(entityId) {
    return this._idsByAttachedEntityId.get(entityId);
  }

  collectIdsInRange(centerChunkOrigin) {
    const ids = new Set();
    const centerX = axisComponent(centerChunkOrigin, 0);
    const centerY = axisComponent(centerChunkOrigin, 1);
    const centerZ = axisComponent(centerChunkOrigin, 2);

    if (!Number.isFinite(centerX) || !Number.isFinite(centerY) || !Number.isFinite(centerZ)) {
      return ids;
    }

    for (let dy = -this._verticalRadius; dy <= this._verticalRadius; dy++) {
      for (let dx = -this._horizontalRadius; dx <= this._horizontalRadius; dx++) {
        for (let dz = -this._horizontalRadius; dz <= this._horizontalRadius; dz++) {
          const horizontalDistanceSq = dx * dx + dz * dz;
          if (horizontalDistanceSq > this._horizontalRadius * this._horizontalRadius) {
            continue;
          }

          const chunkKey = `${centerX + dx * this._chunkSize},${centerY + dy * this._chunkSize},${centerZ + dz * this._chunkSize}`;
          const chunkIds = this._idsByChunkKey.get(chunkKey);
          if (!chunkIds) {
            continue;
          }

          for (const id of chunkIds) {
            ids.add(id);
          }
        }
      }
    }

    return ids;
  }

  _chunkKeyForGlobalCoordinate(position) {
    const x = axisComponent(position, 0);
    const y = axisComponent(position, 1);
    const z = axisComponent(position, 2);

    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      return undefined;
    }

    return `${(x | 0) - (x & this._chunkAxesRange)},${(y | 0) - (y & this._chunkAxesRange)},${(z | 0) - (z & this._chunkAxesRange)}`;
  }

  _deleteIndexEntry(id) {
    const chunkKey = this._chunkKeyById.get(id);
    if (!chunkKey) {
      return;
    }

    this._chunkKeyById.delete(id);
    const ids = this._idsByChunkKey.get(chunkKey);
    if (!ids) {
      return;
    }

    ids.delete(id);
    if (ids.size === 0) {
      this._idsByChunkKey.delete(chunkKey);
    }
  }

  _setAttachedEntity(id, attachedEntityId) {
    const previousAttachedEntityId = this._attachedEntityIdById.get(id);
    if (previousAttachedEntityId !== undefined) {
      this._attachedEntityIdById.delete(id);
      const previousIds = this._idsByAttachedEntityId.get(previousAttachedEntityId);
      if (previousIds) {
        previousIds.delete(id);
        if (previousIds.size === 0) {
          this._idsByAttachedEntityId.delete(previousAttachedEntityId);
        }
      }
    }

    if (!Number.isFinite(attachedEntityId)) {
      return;
    }

    this._attachedEntityIdById.set(id, attachedEntityId);
    let attachedIds = this._idsByAttachedEntityId.get(attachedEntityId);
    if (!attachedIds) {
      attachedIds = new Set();
      this._idsByAttachedEntityId.set(attachedEntityId, attachedIds);
    }

    attachedIds.add(id);
  }
}
