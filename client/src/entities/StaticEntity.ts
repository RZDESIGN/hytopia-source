import { Color, QuaternionLike, Vector3Like } from 'three';
import Chunk from '../chunks/Chunk';
import Entity, { type EntityData } from './Entity';
import EntityStats from './EntityStats';
import { MAX_LIGHT_LEVEL } from '../blocks/BlockConstants';
import type Game from '../Game';
import type { DeserializedModelAnimations, DeserializedModelNodeOverrides } from '../network/Deserializer';

// Static Entities are processed through a special path with lower CPU cost. In
// exchange for faster processing, Static Entities are subject to the following
// constraints. (Some of these constraints may be relaxed in the future):
// * Dynamic changes to position, rotation, scale, or other parameters are not allowed
// * Must be a glTF Entity
// * Animations cannot be played
// * Parent child relationships are not allowed
// * Visibility control by specifying node names is not supported
// * Custom textures cannot be applied
// * No color and opacity change support
// * Opaque objects are strongly recommended
//
// Specifically, compared to regular Entities, the processing differs as follows:
// * Entity data does not need to be updated after creation
// * Data is copied to InstancedMesh only when the Entity is added
// * View distance handling is done in the shader with conservative padding
// * Per-instance frustum culling is not performed
//
// Currently, the goal is to implement StaticEntity with minimal changes, so we
// made small modifications to Entity, and StaticEntity inherits from it.
//
// To improve readability and maintainability, it would be better to define a base
// BaseEntity class, or a common IEntity interface, then define DynamicEntity and
// StaticEntity classes that inherit from it or implement it. We could then create
// a DynamicEntityManager and a StaticEntityManager to process each separately.
//
// However, this would require a fairly large refactoring of the Entity related
// classes, so I plan to make that change after things have settled down.
export default class StaticEntity extends Entity {
  public constructor(game: Game, data: EntityData) {
    super(game, data);

    this.entityRoot.updateMatrix();
    this.entityRoot.updateMatrixWorld();
    this.entityRoot.matrixAutoUpdate = false;
    this.entityRoot.matrixWorldAutoUpdate = false;
  }

  protected async _buildGLTFModel(): Promise<void> {
  }

  public get lightLevel(): number {
    return this._lightLevel;
  }

  public get skyLight(): number {
    return this._skyLight;
  }

  // Override all modification methods to warn and ignore
  public setPosition(_position: Vector3Like, _interpolate?: boolean, _serverTick?: number): void {
    console.warn(`StaticEntity ${this.id}: Position cannot be modified after creation`);
  }

  public setRotation(_rotation: QuaternionLike, _interpolate?: boolean, _serverTick?: number): void {
    console.warn(`StaticEntity ${this.id}: Rotation cannot be modified after creation`);
  }

  public setScale(_scale: Vector3Like, _interpolate?: boolean): void {
    console.warn(`StaticEntity ${this.id}: Scale cannot be modified after creation`);
  }

  public setPositionInterpolationMs(_interpolationMs: number | null): void {
    console.warn(`StaticEntity ${this.id}: Position interpolation cannot be modified after creation`);
  }

  public setRotationInterpolationMs(_interpolationMs: number | null): void {
    console.warn(`StaticEntity ${this.id}: Rotation interpolation cannot be modified after creation`);
  }

  public setScaleInterpolationMs(_interpolationMs: number | null): void {
    console.warn(`StaticEntity ${this.id}: Scale interpolation cannot be modified after creation`);
  }

  public setOpacity(_opacity: number): void {
    console.warn(`StaticEntity ${this.id}: Opacity cannot be modified after creation`);
  }

  public setTintColor(_tintColor: Color | null | undefined): void {
    console.warn(`StaticEntity ${this.id}: Tint color cannot be modified after creation`);
  }

  public setEmissiveColor(_emissiveColor: Color | null | undefined, _nodeNames?: string[]): void {
    console.warn(`StaticEntity ${this.id}: Emissive color cannot be modified after creation`);
  }

  public setEmissiveIntensity(_emissiveIntensity: number | null | undefined, _nodeNames?: string[]): void {
    console.warn(`StaticEntity ${this.id}: Emissive intensity cannot be modified after creation`);
  }

  public setCustomTexture(_textureUri: string | null): void {
    console.warn(`StaticEntity ${this.id}: Custom texture changes are not supported`);
  }

  public setModelUri(_modelUri: string): void {
    console.warn(`StaticEntity ${this.id}: Model URI cannot be modified after creation`);
  }

  public setName(_name: string): void {
    console.warn(`StaticEntity ${this.id}: Name cannot be modified after creation`);
  }

  public setModelAnimations(_modelAnimations: DeserializedModelAnimations): void {
    console.warn(`StaticEntity ${this.id}: Animations are not supported`);
  }

  public setModelNodeOverrides(_modelNodeOverrides: DeserializedModelNodeOverrides): void {
    console.warn(`StaticEntity ${this.id}: Model node overrides are not supported`);
  }

  public release(): void {
    console.warn(`StaticEntity ${this.id}: Cannot be released (deletion not supported)`);
  }

  public update(): void {
    console.warn(`StaticEntity ${this.id}: update() should not be called.`)
  }

  public updateAnimationAndLocalMatrix(): void {
    console.warn(`StaticEntity ${this.id}: updateAnimationAndLocalMatrix() should not be called.`)
  }

  public updateWorldMatrices(): void {
    console.warn(`StaticEntity ${this.id}: World matrix updates are not supported after initialization`);
  }

  public updateLightLevel(): void {
    const { x: gx, y: gy, z: gz } = this._globalCoordinate;
    Chunk.worldPositionToGlobalCoordinate(this.entityRoot.position, this._globalCoordinate);

    if (
      this._globalCoordinate.x !== gx ||
      this._globalCoordinate.y !== gy ||
      this._globalCoordinate.z !== gz
    ) {
      this._lightLevel = this._game.lightLevelManager.getLightLevelByGlobalCoordinate(this._globalCoordinate) / MAX_LIGHT_LEVEL;
      EntityStats.lightLevelUpdateCount++;
    }
  }

  public updateSkyLight(): void {
    this._skyLight = this._game.skyDistanceVolumeManager.getSkyLightBrightnessByGlobalCoordinate(this._globalCoordinate);
    EntityStats.lightLevelUpdateCount++;
  }
}
