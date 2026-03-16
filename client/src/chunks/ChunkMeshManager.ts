import { BufferAttribute, BufferGeometry, Material, Mesh, ShaderMaterial, Vector2, Vector3 } from 'three';
import Chunk from './Chunk';
import {
  BATCH_WORLD_SIZE,
  CHUNK_BUFFER_GEOMETRY_NUM_POSITION_COMPONENTS,
  CHUNK_BUFFER_GEOMETRY_NUM_NORMAL_COMPONENTS,
  CHUNK_BUFFER_GEOMETRY_NUM_UV_COMPONENTS,
  CHUNK_BUFFER_GEOMETRY_NUM_COLOR_COMPONENTS,
  CHUNK_BUFFER_GEOMETRY_NUM_LIGHT_LEVEL_COMPONENTS,
  CHUNK_BUFFER_GEOMETRY_NUM_FOAM_LEVEL_COMPONENTS,
  CHUNK_BUFFER_GEOMETRY_NUM_SURFACE_FLAG_COMPONENTS,
  CHUNK_BUFFER_GEOMETRY_NUM_WIND_DATA_COMPONENTS,
  type BatchId,
  type ChunkId,
} from './ChunkConstants';
import ChunkStats from './ChunkStats';
import type { BlocksBufferGeometryData } from '../blocks/BlockConstants';
import { isAngleVisibilityCullingEnabled } from '../core/VisibilityCulling';
import Game from '../Game';
import { updateAABB } from '../three/utils';

// Working variables
const toVec2 = new Vector2();
const batchCenterVec3 = new Vector3();

export default class ChunkMeshManager {
  private _game: Game;
  private _batchFoliageMeshes: Map<BatchId, Mesh<BufferGeometry, ShaderMaterial>> = new Map();
  private _batchLiquidMeshes: Map<BatchId, Mesh<BufferGeometry, ShaderMaterial>> = new Map();
  private _batchOpaqueSolidMeshes: Map<BatchId, Mesh<BufferGeometry, Material>> = new Map();
  private _batchTransparentSolidMeshes: Map<BatchId, Mesh<BufferGeometry, Material>> = new Map();
  private _promotedChunkFoliageMeshes: Map<ChunkId, Mesh<BufferGeometry, ShaderMaterial>> = new Map();
  private _promotedChunkLiquidMeshes: Map<ChunkId, Mesh<BufferGeometry, ShaderMaterial>> = new Map();
  private _promotedChunkOpaqueSolidMeshes: Map<ChunkId, Mesh<BufferGeometry, Material>> = new Map();
  private _promotedChunkTransparentSolidMeshes: Map<ChunkId, Mesh<BufferGeometry, Material>> = new Map();
  private _promotedChunkIdsByBatch: Map<BatchId, Set<ChunkId>> = new Map();
  // Track all batch IDs for efficient iteration
  private _batchIds: Set<BatchId> = new Set();
  private _foliageMeshesInScene: Mesh<BufferGeometry, ShaderMaterial>[] = [];
  private _liquidMeshesInScene: Mesh<BufferGeometry, ShaderMaterial>[] = [];
  private _nearbyBlockRaycastMeshes: Mesh<BufferGeometry, Material | ShaderMaterial>[] = [];
  private _nearbyReflectionMeshes: Mesh<BufferGeometry, Material | ShaderMaterial>[] = [];
  private _nearbySolidMeshes: Mesh<BufferGeometry, Material>[] = [];
  private _solidMeshesInScene: Mesh<BufferGeometry, Material>[] = [];
  private _solidMeshesInSceneDirty: boolean = true;

  public constructor(game: Game) {
    this._game = game;
  }

  public get batchIds(): IterableIterator<BatchId> {
    return this._batchIds.values();
  }

  public get batchCount(): number {
    return this._batchIds.size;
  }

  public hasBatch(batchId: BatchId): boolean {
    return this._batchIds.has(batchId);
  }

  private _createOrUpdateMesh<TKey extends string>(
    id: TKey,
    data: BlocksBufferGeometryData,
    cache: Map<TKey, Mesh>,
    material: Material,
    castShadow: boolean,
    receiveShadow: boolean,
  ): Mesh {
    const { positions, normals, uvs, indices, colors, lightLevels, foamLevels, foamLevelsDiag, surfaceFlags, windData } = data;

    let mesh = cache.get(id);

    if (mesh) {
      // Reuse existing geometry — swap typed arrays and mark dirty.
      // Three.js reuses the WebGL buffer via bufferSubData when byte-size is
      // unchanged, and only recreates when the size differs. Either path avoids
      // the dispose() + new BufferGeometry() + new BufferAttribute() overhead.
      const geometry = mesh.geometry;

      this._swapAttribute(geometry, 'position', positions, CHUNK_BUFFER_GEOMETRY_NUM_POSITION_COMPONENTS);
      this._swapOptionalAttribute(geometry, 'normal', normals, CHUNK_BUFFER_GEOMETRY_NUM_NORMAL_COMPONENTS);
      this._swapAttribute(geometry, 'uv', uvs, CHUNK_BUFFER_GEOMETRY_NUM_UV_COMPONENTS);
      this._swapAttribute(geometry, 'color', colors, CHUNK_BUFFER_GEOMETRY_NUM_COLOR_COMPONENTS);

      this._swapOptionalAttribute(geometry, 'lightLevel', lightLevels, CHUNK_BUFFER_GEOMETRY_NUM_LIGHT_LEVEL_COMPONENTS);
      this._swapOptionalAttribute(geometry, 'foamLevel', foamLevels, CHUNK_BUFFER_GEOMETRY_NUM_FOAM_LEVEL_COMPONENTS);
      this._swapOptionalAttribute(geometry, 'foamLevelDiag', foamLevelsDiag, CHUNK_BUFFER_GEOMETRY_NUM_FOAM_LEVEL_COMPONENTS);
      this._swapOptionalAttribute(geometry, 'surfaceFlag', surfaceFlags, CHUNK_BUFFER_GEOMETRY_NUM_SURFACE_FLAG_COMPONENTS);
      this._swapOptionalAttribute(geometry, 'windData', windData, CHUNK_BUFFER_GEOMETRY_NUM_WIND_DATA_COMPONENTS);

      // Index may switch between Uint16 and Uint32 depending on vertex count
      const indexAttr = geometry.getIndex();
      if (indexAttr && indexAttr.array.constructor === indices.constructor && indexAttr.array.byteLength === indices.byteLength) {
        indexAttr.array = indices;
        indexAttr.needsUpdate = true;
      } else {
        geometry.setIndex(new BufferAttribute(indices, 1));
      }

      // Invalidate cached bounds so they are recomputed from the new data
      geometry.boundingSphere = null;
      geometry.boundingBox = null;
      geometry.computeBoundingSphere();

      mesh.material = material;
    } else {
      const geometry = new BufferGeometry();

      geometry.setAttribute('position', new BufferAttribute(positions, CHUNK_BUFFER_GEOMETRY_NUM_POSITION_COMPONENTS));
      if (normals) {
        geometry.setAttribute('normal', new BufferAttribute(normals, CHUNK_BUFFER_GEOMETRY_NUM_NORMAL_COMPONENTS));
      }
      geometry.setAttribute('uv', new BufferAttribute(uvs, CHUNK_BUFFER_GEOMETRY_NUM_UV_COMPONENTS));
      geometry.setAttribute('color', new BufferAttribute(colors, CHUNK_BUFFER_GEOMETRY_NUM_COLOR_COMPONENTS));

      if (lightLevels) {
        geometry.setAttribute('lightLevel', new BufferAttribute(lightLevels, CHUNK_BUFFER_GEOMETRY_NUM_LIGHT_LEVEL_COMPONENTS));
      }
      if (foamLevels) {
        geometry.setAttribute('foamLevel', new BufferAttribute(foamLevels, CHUNK_BUFFER_GEOMETRY_NUM_FOAM_LEVEL_COMPONENTS));
      }
      if (foamLevelsDiag) {
        geometry.setAttribute('foamLevelDiag', new BufferAttribute(foamLevelsDiag, CHUNK_BUFFER_GEOMETRY_NUM_FOAM_LEVEL_COMPONENTS));
      }
      if (surfaceFlags) {
        geometry.setAttribute('surfaceFlag', new BufferAttribute(surfaceFlags, CHUNK_BUFFER_GEOMETRY_NUM_SURFACE_FLAG_COMPONENTS));
      }
      if (windData) {
        geometry.setAttribute('windData', new BufferAttribute(windData, CHUNK_BUFFER_GEOMETRY_NUM_WIND_DATA_COMPONENTS));
      }

      geometry.setIndex(new BufferAttribute(indices, 1));
      geometry.computeBoundingSphere();

      mesh = new Mesh(geometry, material);
      mesh.name = `batch_${id}`;

      mesh.matrixAutoUpdate = false;
      mesh.matrixWorldAutoUpdate = false;

      cache.set(id, mesh);
    }

    mesh.castShadow = castShadow;
    mesh.receiveShadow = receiveShadow;
    mesh.frustumCulled = isAngleVisibilityCullingEnabled();
    updateAABB(mesh);

    return mesh;
  }

  private _swapAttribute(geometry: BufferGeometry, name: string, data: Float32Array, itemSize: number): void {
    const attr = geometry.getAttribute(name) as BufferAttribute | undefined;
    if (attr && attr.array.byteLength === data.byteLength) {
      attr.array = data;
      attr.needsUpdate = true;
    } else {
      geometry.setAttribute(name, new BufferAttribute(data, itemSize));
    }
  }

  private _swapOptionalAttribute(geometry: BufferGeometry, name: string, data: Float32Array | undefined, itemSize: number): void {
    if (data) {
      this._swapAttribute(geometry, name, data, itemSize);
    } else if (geometry.hasAttribute(name)) {
      geometry.deleteAttribute(name);
    }
  }

  private _removeMesh<TKey extends string>(id: TKey, cache: Map<TKey, Mesh>, affectsSolidList: boolean): void {
    const mesh = cache.get(id);

    if (mesh) {
      if (mesh.parent && affectsSolidList) {
        this._solidMeshesInSceneDirty = true;
      }
      mesh.geometry.dispose();
      cache.delete(id);
      this._game.renderer.removeFromScene(mesh);
    }
  }

  public createOrUpdateBatchFoliageMesh(batchId: BatchId, data: BlocksBufferGeometryData): void {
    this._batchIds.add(batchId);
    this._createOrUpdateMesh(
      batchId,
      data,
      this._batchFoliageMeshes,
      this._game.blockMaterialManager.foliageMaterial,
      false,
      false,
    );
  }

  public createOrUpdateBatchLiquidMesh(batchId: BatchId, data: BlocksBufferGeometryData): void {
    this._batchIds.add(batchId);
    this._createOrUpdateMesh(
      batchId,
      data,
      this._batchLiquidMeshes,
      this._game.blockMaterialManager.liquidMaterial,
      false,
      false,
    );
  }

  public createOrUpdateBatchOpaqueSolidMesh(batchId: BatchId, data: BlocksBufferGeometryData): void {
    this._batchIds.add(batchId);
    this._createOrUpdateMesh(
      batchId,
      data,
      this._batchOpaqueSolidMeshes,
      !!data.lightLevels ? this._game.blockMaterialManager.opaqueMaterial : this._game.blockMaterialManager.opaqueNonLitMaterial,
      true,
      true,
    );
  }

  public createOrUpdateBatchTransparentSolidMesh(batchId: BatchId, data: BlocksBufferGeometryData): void {
    this._batchIds.add(batchId);
    this._createOrUpdateMesh(
      batchId,
      data,
      this._batchTransparentSolidMeshes,
      !!data.lightLevels ? this._game.blockMaterialManager.transparentMaterial : this._game.blockMaterialManager.transparentNonLitMaterial,
      true,
      true,
    );
  }

  public removeBatchFoliageMesh(batchId: BatchId): void {
    this._removeMesh(batchId, this._batchFoliageMeshes, false);
    this._cleanupBatchId(batchId);
  }

  public removeBatchLiquidMesh(batchId: BatchId): void {
    this._removeMesh(batchId, this._batchLiquidMeshes, false);
    this._cleanupBatchId(batchId);
  }

  public removeBatchOpaqueSolidMesh(batchId: BatchId): void {
    this._removeMesh(batchId, this._batchOpaqueSolidMeshes, true);
    this._cleanupBatchId(batchId);
  }

  public removeBatchTransparentSolidMesh(batchId: BatchId): void {
    this._removeMesh(batchId, this._batchTransparentSolidMeshes, true);
    this._cleanupBatchId(batchId);
  }

  public removeAllBatchMeshes(batchId: BatchId): void {
    this._removeMesh(batchId, this._batchFoliageMeshes, false);
    this._removeMesh(batchId, this._batchLiquidMeshes, false);
    this._removeMesh(batchId, this._batchOpaqueSolidMeshes, true);
    this._removeMesh(batchId, this._batchTransparentSolidMeshes, true);
    this._cleanupBatchId(batchId);
  }

  private _cleanupBatchId(batchId: BatchId): void {
    // Only remove from tracking if no meshes exist for this batch
    if (!this._batchFoliageMeshes.has(batchId) &&
        !this._batchLiquidMeshes.has(batchId) &&
        !this._batchOpaqueSolidMeshes.has(batchId) && 
        !this._batchTransparentSolidMeshes.has(batchId) &&
        !this._promotedChunkIdsByBatch.has(batchId)) {
      this._batchIds.delete(batchId);
    }
  }

  private _trackPromotedChunk(chunkId: ChunkId): void {
    const batchId = Chunk.chunkIdToBatchId(chunkId);
    let chunkIds = this._promotedChunkIdsByBatch.get(batchId);

    if (!chunkIds) {
      chunkIds = new Set();
      this._promotedChunkIdsByBatch.set(batchId, chunkIds);
    }

    chunkIds.add(chunkId);
    this._batchIds.add(batchId);
  }

  private _cleanupPromotedChunk(chunkId: ChunkId): void {
    const batchId = Chunk.chunkIdToBatchId(chunkId);

    if (
      this._promotedChunkFoliageMeshes.has(chunkId) ||
      this._promotedChunkLiquidMeshes.has(chunkId) ||
      this._promotedChunkOpaqueSolidMeshes.has(chunkId) ||
      this._promotedChunkTransparentSolidMeshes.has(chunkId)
    ) {
      return;
    }

    const chunkIds = this._promotedChunkIdsByBatch.get(batchId);
    if (!chunkIds) {
      this._cleanupBatchId(batchId);
      return;
    }

    chunkIds.delete(chunkId);
    if (chunkIds.size === 0) {
      this._promotedChunkIdsByBatch.delete(batchId);
    }

    this._cleanupBatchId(batchId);
  }

  public applyPromotedChunkBuild(
    chunkId: ChunkId,
    data: {
      foliageGeometry?: BlocksBufferGeometryData;
      liquidGeometry?: BlocksBufferGeometryData;
      opaqueSolidGeometry?: BlocksBufferGeometryData;
      transparentSolidGeometry?: BlocksBufferGeometryData;
    },
  ): void {
    this._trackPromotedChunk(chunkId);

    if (data.foliageGeometry) {
      this._createOrUpdateMesh(
        chunkId,
        data.foliageGeometry,
        this._promotedChunkFoliageMeshes,
        this._game.blockMaterialManager.foliageMaterial,
        false,
        false,
      );
    } else {
      this._removeMesh(chunkId, this._promotedChunkFoliageMeshes, false);
    }

    if (data.liquidGeometry) {
      this._createOrUpdateMesh(
        chunkId,
        data.liquidGeometry,
        this._promotedChunkLiquidMeshes,
        this._game.blockMaterialManager.liquidMaterial,
        false,
        false,
      );
    } else {
      this._removeMesh(chunkId, this._promotedChunkLiquidMeshes, false);
    }

    if (data.opaqueSolidGeometry) {
      this._createOrUpdateMesh(
        chunkId,
        data.opaqueSolidGeometry,
        this._promotedChunkOpaqueSolidMeshes,
        !!data.opaqueSolidGeometry.lightLevels
          ? this._game.blockMaterialManager.opaqueMaterial
          : this._game.blockMaterialManager.opaqueNonLitMaterial,
        true,
        true,
      );
    } else {
      this._removeMesh(chunkId, this._promotedChunkOpaqueSolidMeshes, true);
    }

    if (data.transparentSolidGeometry) {
      this._createOrUpdateMesh(
        chunkId,
        data.transparentSolidGeometry,
        this._promotedChunkTransparentSolidMeshes,
        !!data.transparentSolidGeometry.lightLevels
          ? this._game.blockMaterialManager.transparentMaterial
          : this._game.blockMaterialManager.transparentNonLitMaterial,
        true,
        true,
      );
    } else {
      this._removeMesh(chunkId, this._promotedChunkTransparentSolidMeshes, true);
    }

    this._cleanupPromotedChunk(chunkId);
  }

  public removePromotedChunkMeshes(chunkId: ChunkId): void {
    this._removeMesh(chunkId, this._promotedChunkFoliageMeshes, false);
    this._removeMesh(chunkId, this._promotedChunkLiquidMeshes, false);
    this._removeMesh(chunkId, this._promotedChunkOpaqueSolidMeshes, true);
    this._removeMesh(chunkId, this._promotedChunkTransparentSolidMeshes, true);
    this._cleanupPromotedChunk(chunkId);
  }

  public applyBatchViewDistance(fromVec2: Vector2, viewDistanceSquared: number): void {
    for (const batchId of this._batchIds) {
      const foliageMesh = this._batchFoliageMeshes.get(batchId);
      const liquidMesh = this._batchLiquidMeshes.get(batchId);
      const opaqueSolidMesh = this._batchOpaqueSolidMeshes.get(batchId);
      const transparentSolidMesh = this._batchTransparentSolidMeshes.get(batchId);
      const promotedChunkIds = this._promotedChunkIdsByBatch.get(batchId);

      if (!foliageMesh && !liquidMesh && !opaqueSolidMesh && !transparentSolidMesh && !promotedChunkIds?.size) {
        continue;
      }

      // Use batch center for distance calculation
      const batchOrigin = Chunk.batchIdToBatchOrigin(batchId);
      const halfBatchSize = BATCH_WORLD_SIZE / 2;
      batchCenterVec3.set(
        batchOrigin.x + halfBatchSize,
        batchOrigin.y + halfBatchSize,
        batchOrigin.z + halfBatchSize,
      );

      // Use squared distance to avoid expensive sqrt
      const inRange = fromVec2.distanceToSquared(toVec2.set(batchCenterVec3.x, batchCenterVec3.z)) <= viewDistanceSquared;

      // Add/remove from scene graph instead of just toggling visibility
      if (foliageMesh) {
        this._setMeshInScene(foliageMesh, inRange, false);
      }
      if (liquidMesh) {
        this._setMeshInScene(liquidMesh, inRange, false);
      }
      if (opaqueSolidMesh) {
        this._setMeshInScene(opaqueSolidMesh, inRange, true);
      }
      if (transparentSolidMesh) {
        this._setMeshInScene(transparentSolidMesh, inRange, true);
      }

      if (promotedChunkIds) {
        for (const chunkId of promotedChunkIds) {
          const promotedFoliageMesh = this._promotedChunkFoliageMeshes.get(chunkId);
          const promotedLiquidMesh = this._promotedChunkLiquidMeshes.get(chunkId);
          const promotedOpaqueMesh = this._promotedChunkOpaqueSolidMeshes.get(chunkId);
          const promotedTransparentMesh = this._promotedChunkTransparentSolidMeshes.get(chunkId);

          if (promotedFoliageMesh) {
            this._setMeshInScene(promotedFoliageMesh, inRange, false);
          }
          if (promotedLiquidMesh) {
            this._setMeshInScene(promotedLiquidMesh, inRange, false);
          }
          if (promotedOpaqueMesh) {
            this._setMeshInScene(promotedOpaqueMesh, inRange, true);
          }
          if (promotedTransparentMesh) {
            this._setMeshInScene(promotedTransparentMesh, inRange, true);
          }
        }
      }

      if (inRange) {
        ChunkStats.visibleCount++;
      }
    }
  }

  private _setMeshInScene(mesh: Mesh, inScene: boolean, affectsSolidList: boolean): void {
    const isInScene = mesh.parent !== null;
    
    if (inScene && !isInScene) {
      this._game.renderer.addToScene(mesh);
      if (affectsSolidList) {
        this._solidMeshesInSceneDirty = true;
      }
    } else if (!inScene && isInScene) {
      this._game.renderer.removeFromScene(mesh);
      if (affectsSolidList) {
        this._solidMeshesInSceneDirty = true;
      }
    }
  }

  public setBatchInScene(batchId: BatchId, inScene: boolean): void {
    const foliageMesh = this._batchFoliageMeshes.get(batchId);
    const liquidMesh = this._batchLiquidMeshes.get(batchId);
    const opaqueSolidMesh = this._batchOpaqueSolidMeshes.get(batchId);
    const transparentSolidMesh = this._batchTransparentSolidMeshes.get(batchId);

    if (foliageMesh) {
      this._setMeshInScene(foliageMesh, inScene, false);
    }
    if (liquidMesh) {
      this._setMeshInScene(liquidMesh, inScene, false);
    }
    if (opaqueSolidMesh) {
      this._setMeshInScene(opaqueSolidMesh, inScene, true);
    }
    if (transparentSolidMesh) {
      this._setMeshInScene(transparentSolidMesh, inScene, true);
    }

    const promotedChunkIds = this._promotedChunkIdsByBatch.get(batchId);
    if (!promotedChunkIds) {
      return;
    }

    for (const chunkId of promotedChunkIds) {
      const promotedFoliageMesh = this._promotedChunkFoliageMeshes.get(chunkId);
      const promotedLiquidMesh = this._promotedChunkLiquidMeshes.get(chunkId);
      const promotedOpaqueMesh = this._promotedChunkOpaqueSolidMeshes.get(chunkId);
      const promotedTransparentMesh = this._promotedChunkTransparentSolidMeshes.get(chunkId);

      if (promotedFoliageMesh) {
        this._setMeshInScene(promotedFoliageMesh, inScene, false);
      }
      if (promotedLiquidMesh) {
        this._setMeshInScene(promotedLiquidMesh, inScene, false);
      }
      if (promotedOpaqueMesh) {
        this._setMeshInScene(promotedOpaqueMesh, inScene, true);
      }
      if (promotedTransparentMesh) {
        this._setMeshInScene(promotedTransparentMesh, inScene, true);
      }
    }
  }

  public get solidMeshesInScene(): Mesh<BufferGeometry, Material>[] {
    if (this._solidMeshesInSceneDirty) {
      this._solidMeshesInScene.length = 0;
      for (const mesh of this._batchOpaqueSolidMeshes.values()) {
        if (mesh.parent) {
          this._solidMeshesInScene.push(mesh);
        }
      }
      for (const mesh of this._batchTransparentSolidMeshes.values()) {
        if (mesh.parent) {
          this._solidMeshesInScene.push(mesh);
        }
      }
      for (const mesh of this._promotedChunkOpaqueSolidMeshes.values()) {
        if (mesh.parent) {
          this._solidMeshesInScene.push(mesh);
        }
      }
      for (const mesh of this._promotedChunkTransparentSolidMeshes.values()) {
        if (mesh.parent) {
          this._solidMeshesInScene.push(mesh);
        }
      }
      this._solidMeshesInSceneDirty = false;
    }
    return this._solidMeshesInScene;
  }

  public get liquidMeshesInScene(): Mesh<BufferGeometry, ShaderMaterial>[] {
    this._liquidMeshesInScene.length = 0;

    for (const mesh of this._batchLiquidMeshes.values()) {
      if (mesh.parent) {
        this._liquidMeshesInScene.push(mesh);
      }
    }

    for (const mesh of this._promotedChunkLiquidMeshes.values()) {
      if (mesh.parent) {
        this._liquidMeshesInScene.push(mesh);
      }
    }

    return this._liquidMeshesInScene;
  }

  public get foliageMeshesInScene(): Mesh<BufferGeometry, ShaderMaterial>[] {
    this._foliageMeshesInScene.length = 0;

    for (const mesh of this._batchFoliageMeshes.values()) {
      if (mesh.parent) {
        this._foliageMeshesInScene.push(mesh);
      }
    }

    for (const mesh of this._promotedChunkFoliageMeshes.values()) {
      if (mesh.parent) {
        this._foliageMeshesInScene.push(mesh);
      }
    }

    return this._foliageMeshesInScene;
  }

  public getSolidMeshesNear(worldPosition: { x: number, y: number, z: number }, maxDistance: number): Mesh<BufferGeometry, Material>[] {
    const nearbySolidMeshes = this._nearbySolidMeshes;
    nearbySolidMeshes.length = 0;

    // Search one extra batch in each direction so short raycasts near a batch edge
    // don't need to scan every visible mesh in the scene.
    const searchPadding = BATCH_WORLD_SIZE;
    const minX = Math.floor((worldPosition.x - maxDistance - searchPadding) / BATCH_WORLD_SIZE) * BATCH_WORLD_SIZE;
    const maxX = Math.floor((worldPosition.x + maxDistance + searchPadding) / BATCH_WORLD_SIZE) * BATCH_WORLD_SIZE;
    const minY = Math.floor((worldPosition.y - maxDistance - searchPadding) / BATCH_WORLD_SIZE) * BATCH_WORLD_SIZE;
    const maxY = Math.floor((worldPosition.y + maxDistance + searchPadding) / BATCH_WORLD_SIZE) * BATCH_WORLD_SIZE;
    const minZ = Math.floor((worldPosition.z - maxDistance - searchPadding) / BATCH_WORLD_SIZE) * BATCH_WORLD_SIZE;
    const maxZ = Math.floor((worldPosition.z + maxDistance + searchPadding) / BATCH_WORLD_SIZE) * BATCH_WORLD_SIZE;

    for (let x = minX; x <= maxX; x += BATCH_WORLD_SIZE) {
      for (let y = minY; y <= maxY; y += BATCH_WORLD_SIZE) {
        for (let z = minZ; z <= maxZ; z += BATCH_WORLD_SIZE) {
          const batchId = `${x},${y},${z}` as BatchId;
          const opaqueSolidMesh = this._batchOpaqueSolidMeshes.get(batchId);
          const transparentSolidMesh = this._batchTransparentSolidMeshes.get(batchId);

          if (opaqueSolidMesh?.parent) {
            nearbySolidMeshes.push(opaqueSolidMesh);
          }

          if (transparentSolidMesh?.parent) {
            nearbySolidMeshes.push(transparentSolidMesh);
          }

          const promotedChunkIds = this._promotedChunkIdsByBatch.get(batchId);
          if (!promotedChunkIds) {
            continue;
          }

          for (const chunkId of promotedChunkIds) {
            const promotedOpaqueMesh = this._promotedChunkOpaqueSolidMeshes.get(chunkId);
            const promotedTransparentMesh = this._promotedChunkTransparentSolidMeshes.get(chunkId);

            if (promotedOpaqueMesh?.parent) {
              nearbySolidMeshes.push(promotedOpaqueMesh);
            }

            if (promotedTransparentMesh?.parent) {
              nearbySolidMeshes.push(promotedTransparentMesh);
            }
          }
        }
      }
    }

    return nearbySolidMeshes;
  }

  public getBlockRaycastMeshesNear(
    worldPosition: { x: number, y: number, z: number },
    maxDistance: number,
  ): Mesh<BufferGeometry, Material | ShaderMaterial>[] {
    const nearbyBlockRaycastMeshes = this._nearbyBlockRaycastMeshes;
    nearbyBlockRaycastMeshes.length = 0;

    const searchPadding = BATCH_WORLD_SIZE;
    const minX = Math.floor((worldPosition.x - maxDistance - searchPadding) / BATCH_WORLD_SIZE) * BATCH_WORLD_SIZE;
    const maxX = Math.floor((worldPosition.x + maxDistance + searchPadding) / BATCH_WORLD_SIZE) * BATCH_WORLD_SIZE;
    const minY = Math.floor((worldPosition.y - maxDistance - searchPadding) / BATCH_WORLD_SIZE) * BATCH_WORLD_SIZE;
    const maxY = Math.floor((worldPosition.y + maxDistance + searchPadding) / BATCH_WORLD_SIZE) * BATCH_WORLD_SIZE;
    const minZ = Math.floor((worldPosition.z - maxDistance - searchPadding) / BATCH_WORLD_SIZE) * BATCH_WORLD_SIZE;
    const maxZ = Math.floor((worldPosition.z + maxDistance + searchPadding) / BATCH_WORLD_SIZE) * BATCH_WORLD_SIZE;

    for (let x = minX; x <= maxX; x += BATCH_WORLD_SIZE) {
      for (let y = minY; y <= maxY; y += BATCH_WORLD_SIZE) {
        for (let z = minZ; z <= maxZ; z += BATCH_WORLD_SIZE) {
          const batchId = `${x},${y},${z}` as BatchId;
          const opaqueSolidMesh = this._batchOpaqueSolidMeshes.get(batchId);
          const transparentSolidMesh = this._batchTransparentSolidMeshes.get(batchId);
          const liquidMesh = this._batchLiquidMeshes.get(batchId);

          if (opaqueSolidMesh?.parent) {
            nearbyBlockRaycastMeshes.push(opaqueSolidMesh);
          }

          if (transparentSolidMesh?.parent) {
            nearbyBlockRaycastMeshes.push(transparentSolidMesh);
          }

          if (liquidMesh?.parent) {
            nearbyBlockRaycastMeshes.push(liquidMesh);
          }

          const promotedChunkIds = this._promotedChunkIdsByBatch.get(batchId);
          if (!promotedChunkIds) {
            continue;
          }

          for (const chunkId of promotedChunkIds) {
            const promotedOpaqueMesh = this._promotedChunkOpaqueSolidMeshes.get(chunkId);
            const promotedTransparentMesh = this._promotedChunkTransparentSolidMeshes.get(chunkId);
            const promotedLiquidMesh = this._promotedChunkLiquidMeshes.get(chunkId);

            if (promotedOpaqueMesh?.parent) {
              nearbyBlockRaycastMeshes.push(promotedOpaqueMesh);
            }

            if (promotedTransparentMesh?.parent) {
              nearbyBlockRaycastMeshes.push(promotedTransparentMesh);
            }

            if (promotedLiquidMesh?.parent) {
              nearbyBlockRaycastMeshes.push(promotedLiquidMesh);
            }
          }
        }
      }
    }

    return nearbyBlockRaycastMeshes;
  }

  public getReflectionCandidateMeshesNear(
    worldPosition: { x: number, y: number, z: number },
    maxDistance: number,
  ): Mesh<BufferGeometry, Material | ShaderMaterial>[] {
    const nearbyMeshes = this._nearbyReflectionMeshes;
    nearbyMeshes.length = 0;

    const searchPadding = BATCH_WORLD_SIZE;
    const minX = Math.floor((worldPosition.x - maxDistance - searchPadding) / BATCH_WORLD_SIZE) * BATCH_WORLD_SIZE;
    const maxX = Math.floor((worldPosition.x + maxDistance + searchPadding) / BATCH_WORLD_SIZE) * BATCH_WORLD_SIZE;
    const minY = Math.floor((worldPosition.y - maxDistance - searchPadding) / BATCH_WORLD_SIZE) * BATCH_WORLD_SIZE;
    const maxY = Math.floor((worldPosition.y + maxDistance + searchPadding) / BATCH_WORLD_SIZE) * BATCH_WORLD_SIZE;
    const minZ = Math.floor((worldPosition.z - maxDistance - searchPadding) / BATCH_WORLD_SIZE) * BATCH_WORLD_SIZE;
    const maxZ = Math.floor((worldPosition.z + maxDistance + searchPadding) / BATCH_WORLD_SIZE) * BATCH_WORLD_SIZE;

    for (let x = minX; x <= maxX; x += BATCH_WORLD_SIZE) {
      for (let y = minY; y <= maxY; y += BATCH_WORLD_SIZE) {
        for (let z = minZ; z <= maxZ; z += BATCH_WORLD_SIZE) {
          const batchId = `${x},${y},${z}` as BatchId;
          const foliageMesh = this._batchFoliageMeshes.get(batchId);
          const opaqueSolidMesh = this._batchOpaqueSolidMeshes.get(batchId);
          const transparentSolidMesh = this._batchTransparentSolidMeshes.get(batchId);

          if (foliageMesh?.parent) {
            nearbyMeshes.push(foliageMesh);
          }

          if (opaqueSolidMesh?.parent) {
            nearbyMeshes.push(opaqueSolidMesh);
          }

          if (transparentSolidMesh?.parent) {
            nearbyMeshes.push(transparentSolidMesh);
          }

          const promotedChunkIds = this._promotedChunkIdsByBatch.get(batchId);
          if (!promotedChunkIds) {
            continue;
          }

          for (const chunkId of promotedChunkIds) {
            const promotedFoliageMesh = this._promotedChunkFoliageMeshes.get(chunkId);
            const promotedOpaqueMesh = this._promotedChunkOpaqueSolidMeshes.get(chunkId);
            const promotedTransparentMesh = this._promotedChunkTransparentSolidMeshes.get(chunkId);

            if (promotedFoliageMesh?.parent) {
              nearbyMeshes.push(promotedFoliageMesh);
            }

            if (promotedOpaqueMesh?.parent) {
              nearbyMeshes.push(promotedOpaqueMesh);
            }

            if (promotedTransparentMesh?.parent) {
              nearbyMeshes.push(promotedTransparentMesh);
            }
          }
        }
      }
    }

    return nearbyMeshes;
  }

  public get opaqueSolidMeshes(): IterableIterator<Mesh<BufferGeometry, Material>> {
    return this._batchOpaqueSolidMeshes.values();
  }

  public get transparentSolidMeshes(): IterableIterator<Mesh<BufferGeometry, Material>> {
    return this._batchTransparentSolidMeshes.values();
  }

  public addAllBatchMeshesToScene(): void {
    for (const batchId of this._batchIds) {
      this.setBatchInScene(batchId, true);
      ChunkStats.visibleCount++;
    }
  }
}
