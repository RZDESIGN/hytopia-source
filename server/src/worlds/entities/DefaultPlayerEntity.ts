import { ColliderShape } from '@/worlds/physics/Collider';
import DefaultPlayerEntityController from '@/worlds/entities/controllers/DefaultPlayerEntityController';
import Entity from '@/worlds/entities/Entity';
import { EntityModelAnimationLoopMode } from '@/worlds/entities/EntityModelAnimation';
import ErrorHandler from '@/errors/ErrorHandler';
import ModelRegistry from '@/models/ModelRegistry';
import PlatformGateway from '@/networking/PlatformGateway';
import PlayerEntity from '@/worlds/entities/PlayerEntity';
import type { PlayerCosmetics } from '@/networking/PlatformGateway';
import type { PlayerEntityOptions } from '@/worlds/entities/PlayerEntity';
import type QuaternionLike from '@/shared/types/math/QuaternionLike';
import type Vector3Like from '@/shared/types/math/Vector3Like';
import type World from '@/worlds/World';

/** @internal */
const DefaultPlayerModelUri = 'models/players/player.gltf';

/** @internal */
const SelfHostCosmeticsRefreshIntervalMs = 1_000;

/** @internal */
const HairModelHeadAnchorDefaultOffset = { x: 0, y: -1.4334375, z: 0 } as const;

/** @internal */
const HairModelHeadAnchorOffsets: Record<number, Vector3Like> = {
  1: { x: 0, y: -1.433125, z: -0.00234375 },
  2: { x: 0, y: -1.435, z: -0.000625 },
  3: HairModelHeadAnchorDefaultOffset,
  4: HairModelHeadAnchorDefaultOffset,
  5: HairModelHeadAnchorDefaultOffset,
  6: { x: -0.00081953125, y: -1.436015625, z: 0.002265625 },
  7: { x: 0, y: -1.4355981917382417, z: 0 },
  8: { x: 0, y: -1.43171875, z: -0.0016328125 },
  9: HairModelHeadAnchorDefaultOffset,
  10: HairModelHeadAnchorDefaultOffset,
} as const;

/** @internal */
const PlayerCosmeticSlotToModelNode: Partial<Record<PlayerCosmeticSlot, string>> = {
  BACK: 'back-anchor',
  HEAD: 'head-anchor',
  LEFT_ARM: 'arm-left-anchor',
  LEFT_FOOT: 'foot-left-anchor',
  LEFT_HAND: 'hand-left-anchor',
  LEFT_ITEM: 'hand-left-anchor',
  LEFT_LEG: 'leg-left-anchor',
  RIGHT_ARM: 'arm-right-anchor',
  RIGHT_FOOT: 'foot-right-anchor',
  RIGHT_HAND: 'hand-right-anchor',
  RIGHT_ITEM: 'hand-right-anchor',
  RIGHT_LEG: 'leg-right-anchor',
  TORSO: 'torso-anchor',
} as const;

/** @internal */
function getHairModelHeadAnchorOffset(modelUri: string): Vector3Like {
  const match = /hair-(\d{4})\.(?:gltf|glb)(?:[?#].*)?$/i.exec(modelUri) ??
                /\/hair-(\d{4})(?:\/|%2f)/i.exec(modelUri);
  const hairStyleId = match ? Number.parseInt(match[1], 10) : NaN;

  return HairModelHeadAnchorOffsets[hairStyleId] ?? HairModelHeadAnchorDefaultOffset;
}

/**
 * The slots used for player cosmetics.
 *
 * **Category:** Entities
 * @public
 */
export type PlayerCosmeticSlot = 'ALL' | 'BACK' | 'HEAD' | 'LEFT_ARM' | 'LEFT_FOOT' | 
                                 'LEFT_HAND' | 'LEFT_ITEM' | 'LEFT_LEG' | 'RIGHT_ARM' | 
                                 'RIGHT_FOOT' | 'RIGHT_HAND' | 'RIGHT_ITEM' | 'RIGHT_LEG' | 
                                 'TORSO';

/**
 * Options for creating a DefaultPlayerEntity instance.
 *
 * Use for: customizing the default player avatar (for example cosmetic visibility).
 * Do NOT use for: changing movement behavior; use `DefaultPlayerEntityControllerOptions`.
 *
 * **Category:** Entities
 * @public
 */
export type DefaultPlayerEntityOptions = {
  /** Cosmetic slots to hide. Use 'ALL' to hide all cosmetics. */
  cosmeticHiddenSlots?: PlayerCosmeticSlot[];
} & PlayerEntityOptions;

/**
 * Represents the default player model entity.
 *
 * When to use: standard player avatars with built-in cosmetics and default controls.
 * Do NOT use for: fully custom player rigs that don't match the default model's anchors/animations.
 *
 * @remarks
 * Extends `PlayerEntity`, uses the default player model, and assigns
 * `DefaultPlayerEntityController`. You can override defaults, but if you
 * change `modelUri`, ensure the model has the same animation names and anchor points.
 *
 * @example
 * ```typescript
 * const playerEntity = new DefaultPlayerEntity({ player });
 *
 * playerEntity.spawn(world, { x: 0, y: 10, z: 0 });
 * ```
 *
 * **Category:** Entities
 * @public
 */
export default class DefaultPlayerEntity extends PlayerEntity {
  private _cosmeticHiddenSlots: PlayerCosmeticSlot[];
  private _cosmeticEntities: Entity[] = [];
  private _cosmeticsRefreshInterval: ReturnType<typeof setInterval> | undefined;
  private _cosmeticsRefreshInFlight: boolean = false;
  private _cosmeticsSignature: string | undefined;

  /**
   * Creates a new DefaultPlayerEntity instance.
   * 
   * @remarks
   * **Auto-assigned defaults:** A `DefaultPlayerEntityController` is automatically created and assigned.
   * Default idle animations are initialized as looped and playing.
   * 
   * **Cosmetics on spawn:** When spawned, player cosmetics (hair, skin, equipped items) are fetched asynchronously
   * and applied. Child entities are created for hair and equipped cosmetic items.
   * 
   * @param options - The options for the default player entity.
   *
   * **Category:** Entities
   */
  public constructor(options: DefaultPlayerEntityOptions) {
    super({
      controller: new DefaultPlayerEntityController(),
      modelAnimations: [
        { name: 'idle-lower', loopMode: EntityModelAnimationLoopMode.LOOP, play: true },
        { name: 'idle-upper', loopMode: EntityModelAnimationLoopMode.LOOP, play: true },
      ],
      modelUri: DefaultPlayerModelUri,
      ...options,
    });

    this._cosmeticHiddenSlots = options.cosmeticHiddenSlots ?? [];
  }

  /**
   * The cosmetic slots that are hidden.
   *
   * **Category:** Entities
   * @public
   */
  public get cosmeticHiddenSlots(): PlayerCosmeticSlot[] { return this._cosmeticHiddenSlots; }

  /** @internal */  
  public override spawn(world: World, position: Vector3Like, rotation?: QuaternionLike) {
    super.spawn(world, position, rotation);

    this._cosmeticsSignature = undefined;
    void this._loadAndApplyCosmetics(this.player.cosmetics);
    this._startSelfHostCosmeticsRefresh();
  }

  /** @internal */
  public override despawn() {
    this._stopSelfHostCosmeticsRefresh();
    super.despawn();
    this._cosmeticEntities = [];
    this._cosmeticsSignature = undefined;
  }

  private _startSelfHostCosmeticsRefresh() {
    if (!PlatformGateway.instance.isSelfHost || this._cosmeticsRefreshInterval) return;

    this._cosmeticsRefreshInterval = setInterval(() => {
      if (!this.isSpawned || !this.world) return;
      void this._loadAndApplyCosmetics(PlatformGateway.instance.getPlayerCosmetics(this.player.id));
    }, SelfHostCosmeticsRefreshIntervalMs);
  }

  private _stopSelfHostCosmeticsRefresh() {
    if (!this._cosmeticsRefreshInterval) return;

    clearInterval(this._cosmeticsRefreshInterval);
    this._cosmeticsRefreshInterval = undefined;
  }

  private async _loadAndApplyCosmetics(cosmeticsPromise: Promise<PlayerCosmetics | void>) {
    if (this._cosmeticsRefreshInFlight) return;

    this._cosmeticsRefreshInFlight = true;

    try {
      const cosmetics = await cosmeticsPromise;
      if (!cosmetics || !this.isSpawned || !this.world || !this.modelUri) return;

      const signature = this._createCosmeticsSignature(cosmetics);
      if (signature === this._cosmeticsSignature) return;

      this._cosmeticsSignature = signature;
      this._applyCosmetics(this.world, cosmetics);
    } catch (e) {
      ErrorHandler.warning(`DefaultPlayerEntity.spawn(): Failed to get player cosmetics: ${e}`);
    } finally {
      this._cosmeticsRefreshInFlight = false;
    }
  }

  private _applyCosmetics(world: World, cosmetics: PlayerCosmetics) {
    this._clearCosmeticEntities();

    const hidesHair = cosmetics.equippedItems.some(item => item.item.flags.includes('HIDES_HAIR')) &&
                      !this._cosmeticHiddenSlots.includes('ALL') &&
                      !this._cosmeticHiddenSlots.includes('HEAD');

    if (!hidesHair && cosmetics.hairModelUri) {
      const hairEntity = new Entity({
        modelUri: cosmetics.hairModelUri,
        modelPreferredShape: ColliderShape.NONE,
        modelTextureUri: cosmetics.hairTextureUri,
        parent: this,
        parentNodeName: 'head-anchor',
      });

      // Hair assets are authored around their own head anchor; offset the root so anchors overlap.
      hairEntity.spawn(world, getHairModelHeadAnchorOffset(cosmetics.hairModelUri));
      this._cosmeticEntities.push(hairEntity);
    }

    if (this.modelUri === DefaultPlayerModelUri) {
      this.setModelTextureUri(cosmetics.skinTextureUri);
    }

    if (this._cosmeticHiddenSlots.includes('ALL')) {
      return;
    }

    for (const equippedItem of cosmetics.equippedItems) {
      const item = equippedItem.item;
      const slot = equippedItem.slot as PlayerCosmeticSlot;

      if (this._cosmeticHiddenSlots.includes(slot)) {
        continue;
      }

      const slotAnchor = PlayerCosmeticSlotToModelNode[slot];

      if (!slotAnchor || !this.modelUri || !ModelRegistry.instance.modelHasNode(this.modelUri, slotAnchor)) {
        continue;
      }

      const cosmeticItemEntity = new Entity({
        modelUri: item.modelUrl,
        modelPreferredShape: ColliderShape.NONE,
        parent: this,
        parentNodeName: slotAnchor,
      });

      cosmeticItemEntity.spawn(world, { x: 0, y: 0, z: 0 });
      this._cosmeticEntities.push(cosmeticItemEntity);
    }
  }

  private _clearCosmeticEntities() {
    for (const entity of this._cosmeticEntities) {
      if (entity.isSpawned) {
        entity.despawn();
      }
    }

    this._cosmeticEntities = [];
  }

  private _createCosmeticsSignature(cosmetics: PlayerCosmetics): string {
    return JSON.stringify({
      skinTextureUri: cosmetics.skinTextureUri,
      hairModelUri: cosmetics.hairModelUri,
      hairTextureUri: cosmetics.hairTextureUri,
      equippedItems: cosmetics.equippedItems.map(equippedItem => ({
        slot: equippedItem.slot,
        flags: equippedItem.item.flags,
        modelUrl: equippedItem.item.modelUrl,
        textureUrl: equippedItem.item.textureUrl,
      })),
      hiddenSlots: this._cosmeticHiddenSlots,
    });
  }
}
