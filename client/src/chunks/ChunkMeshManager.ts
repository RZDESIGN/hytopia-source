import { BufferAttribute, BufferGeometry, Material, Mesh, MeshBasicMaterial, ShaderMaterial, Vector2, Vector3 } from 'three';
import Chunk from './Chunk';
import {
  BATCH_WORLD_SIZE,
  CHUNK_BUFFER_GEOMETRY_NUM_POSITION_COMPONENTS,
  CHUNK_BUFFER_GEOMETRY_NUM_NORMAL_COMPONENTS,
  CHUNK_BUFFER_GEOMETRY_NUM_UV_COMPONENTS,
  CHUNK_BUFFER_GEOMETRY_NUM_COLOR_COMPONENTS,
  CHUNK_BUFFER_GEOMETRY_NUM_LIGHT_LEVEL_COMPONENTS,
  CHUNK_BUFFER_GEOMETRY_NUM_FOAM_LEVEL_COMPONENTS,
  type BatchId,
} from './ChunkConstants';
import ChunkStats from './ChunkStats';
import type { BlocksBufferGeometryData } from '../blocks/BlockConstants';
import Game from '../Game';
import { updateAABB } from '../three/utils';

// Working variables
const toVec2 = new Vector2();
const batchCenterVec3 = new Vector3();

export default class ChunkMeshManager {
  private _game: Game;
  private _batchLiquidMeshes: Map<BatchId, Mesh<BufferGeometry, ShaderMaterial>> = new Map();
  private _batchOpaqueSolidMeshes: Map<BatchId, Mesh<BufferGeometry, MeshBasicMaterial>> = new Map();
  private _batchTransparentSolidMeshes: Map<BatchId, Mesh<BufferGeometry, MeshBasicMaterial>> = new Map();
  // Track all batch IDs for efficient iteration
  private _batchIds: Set<BatchId> = new Set();
  private _solidMeshesInScene: Mesh<BufferGeometry, MeshBasicMaterial>[] = [];
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

  private _createOrUpdateMesh(id: BatchId, data: BlocksBufferGeometryData, cache: Map<BatchId, Mesh>, material: Material): Mesh {
    const { positions, normals, uvs, indices, colors, lightLevels, foamLevels, foamLevelsDiag } = data;

    const geometry = new BufferGeometry();

    geometry.setAttribute(
      'position',
      new BufferAttribute(positions, CHUNK_BUFFER_GEOMETRY_NUM_POSITION_COMPONENTS),
    );

    geometry.setAttribute(
      'normal',
      new BufferAttribute(normals, CHUNK_BUFFER_GEOMETRY_NUM_NORMAL_COMPONENTS),
    );

    geometry.setAttribute(
      'uv',
      new BufferAttribute(uvs, CHUNK_BUFFER_GEOMETRY_NUM_UV_COMPONENTS),
    );

    geometry.setAttribute(
      'color',
      new BufferAttribute(colors, CHUNK_BUFFER_GEOMETRY_NUM_COLOR_COMPONENTS),
    );

    if (lightLevels) {
      geometry.setAttribute(
        'lightLevel',
        new BufferAttribute(lightLevels, CHUNK_BUFFER_GEOMETRY_NUM_LIGHT_LEVEL_COMPONENTS),
      );
    }

    if (foamLevels) {
      geometry.setAttribute(
        'foamLevel',
        new BufferAttribute(foamLevels, CHUNK_BUFFER_GEOMETRY_NUM_FOAM_LEVEL_COMPONENTS),
      );
    }

    if (foamLevelsDiag) {
      geometry.setAttribute(
        'foamLevelDiag',
        new BufferAttribute(foamLevelsDiag, CHUNK_BUFFER_GEOMETRY_NUM_FOAM_LEVEL_COMPONENTS),
      );
    }

    geometry.setIndex(new BufferAttribute(indices, 1));
    geometry.computeBoundingSphere();

    let mesh = cache.get(id);

    if (mesh) {
      mesh.geometry.dispose();
      mesh.geometry = geometry;
      mesh.material = material;
    } else {
      mesh = new Mesh(geometry, material);
      mesh.name = `batch_${id}`;

      // The mesh has a fixed default position/rotation/scale, so we can skip matrix updates
      mesh.matrixAutoUpdate = false;
      mesh.matrixWorldAutoUpdate = false;

      cache.set(id, mesh);
      this._batchIds.add(id);

      // Don't add to scene here - view distance will control when meshes enter the scene
    }

    updateAABB(mesh);

    return mesh;
  }

  private _removeMesh(id: BatchId, cache: Map<BatchId, Mesh>): void {
    const mesh = cache.get(id);

    if (mesh) {
      if (mesh.parent) {
        this._solidMeshesInSceneDirty = true;
      }
      mesh.geometry.dispose();
      cache.delete(id);
      this._game.renderer.removeFromScene(mesh);
    }
  }

  public createOrUpdateBatchLiquidMesh(batchId: BatchId, data: BlocksBufferGeometryData): void {
    this._createOrUpdateMesh(
      batchId,
      data,
      this._batchLiquidMeshes,
      this._game.blockMaterialManager.liquidMaterial,
    );
  }

  public createOrUpdateBatchOpaqueSolidMesh(batchId: BatchId, data: BlocksBufferGeometryData): void {
    this._createOrUpdateMesh(
      batchId,
      data,
      this._batchOpaqueSolidMeshes,
      !!data.lightLevels ? this._game.blockMaterialManager.opaqueMaterial : this._game.blockMaterialManager.opaqueNonLitMaterial,
    );
  }

  public createOrUpdateBatchTransparentSolidMesh(batchId: BatchId, data: BlocksBufferGeometryData): void {
    this._createOrUpdateMesh(
      batchId,
      data,
      this._batchTransparentSolidMeshes,
      !!data.lightLevels ? this._game.blockMaterialManager.transparentMaterial : this._game.blockMaterialManager.transparentNonLitMaterial,
    );
  }

  public removeBatchLiquidMesh(batchId: BatchId): void {
    this._removeMesh(batchId, this._batchLiquidMeshes);
    this._cleanupBatchId(batchId);
  }

  public removeBatchOpaqueSolidMesh(batchId: BatchId): void {
    this._removeMesh(batchId, this._batchOpaqueSolidMeshes);
    this._cleanupBatchId(batchId);
  }

  public removeBatchTransparentSolidMesh(batchId: BatchId): void {
    this._removeMesh(batchId, this._batchTransparentSolidMeshes);
    this._cleanupBatchId(batchId);
  }

  public removeAllBatchMeshes(batchId: BatchId): void {
    this._removeMesh(batchId, this._batchLiquidMeshes);
    this._removeMesh(batchId, this._batchOpaqueSolidMeshes);
    this._removeMesh(batchId, this._batchTransparentSolidMeshes);
    this._batchIds.delete(batchId);
  }

  private _cleanupBatchId(batchId: BatchId): void {
    // Only remove from tracking if no meshes exist for this batch
    if (!this._batchLiquidMeshes.has(batchId) && 
        !this._batchOpaqueSolidMeshes.has(batchId) && 
        !this._batchTransparentSolidMeshes.has(batchId)) {
      this._batchIds.delete(batchId);
    }
  }

  public applyBatchViewDistance(fromVec2: Vector2, viewDistanceSquared: number): void {
    for (const batchId of this._batchIds) {
      const liquidMesh = this._batchLiquidMeshes.get(batchId);
      const opaqueSolidMesh = this._batchOpaqueSolidMeshes.get(batchId);
      const transparentSolidMesh = this._batchTransparentSolidMeshes.get(batchId);

      if (!liquidMesh && !opaqueSolidMesh && !transparentSolidMesh) {
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
      if (liquidMesh) {
        this._setMeshInScene(liquidMesh, inRange);
      }
      if (opaqueSolidMesh) {
        this._setMeshInScene(opaqueSolidMesh, inRange);
      }
      if (transparentSolidMesh) {
        this._setMeshInScene(transparentSolidMesh, inRange);
      }

      if (inRange) {
        ChunkStats.visibleCount++;
      }
    }
  }

  private _setMeshInScene(mesh: Mesh, inScene: boolean): void {
    const isInScene = mesh.parent !== null;
    
    if (inScene && !isInScene) {
      this._game.renderer.addToScene(mesh);
      this._solidMeshesInSceneDirty = true;
    } else if (!inScene && isInScene) {
      this._game.renderer.removeFromScene(mesh);
      this._solidMeshesInSceneDirty = true;
    }
  }

  public setBatchInScene(batchId: BatchId, inScene: boolean): void {
    const liquidMesh = this._batchLiquidMeshes.get(batchId);
    const opaqueSolidMesh = this._batchOpaqueSolidMeshes.get(batchId);
    const transparentSolidMesh = this._batchTransparentSolidMeshes.get(batchId);

    if (liquidMesh) {
      this._setMeshInScene(liquidMesh, inScene);
    }
    if (opaqueSolidMesh) {
      this._setMeshInScene(opaqueSolidMesh, inScene);
    }
    if (transparentSolidMesh) {
      this._setMeshInScene(transparentSolidMesh, inScene);
    }
  }

  public get solidMeshesInScene(): Mesh<BufferGeometry, MeshBasicMaterial>[] {
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
      this._solidMeshesInSceneDirty = false;
    }
    return this._solidMeshesInScene;
  }

  public get opaqueSolidMeshes(): IterableIterator<Mesh<BufferGeometry, MeshBasicMaterial>> {
    return this._batchOpaqueSolidMeshes.values();
  }

  public get transparentSolidMeshes(): IterableIterator<Mesh<BufferGeometry, MeshBasicMaterial>> {
    return this._batchTransparentSolidMeshes.values();
  }

  public addAllBatchMeshesToScene(): void {
    for (const batchId of this._batchIds) {
      this.setBatchInScene(batchId, true);
      ChunkStats.visibleCount++;
    }
  }
}
