import {
  startServer,
  BaseEntityControllerEvent,
  BLOCK_ROTATIONS,
  ConnectionFeatureFlag,
  DefaultPlayerEntity,
  DefaultPlayerEntityController,
  enableConnectionFeature,
  Player,
  PlayerEvent,
  PlayerEntity,
  World,
  type WorldMap,
  type BlockRotation,
  type PredictedBlockEditAttempt,
  type Vector3Like,
} from './';

import worldMap from '../../assets/release/maps/boilerplate-small.json';

/**
 * A local running server/playground for quick testing
 * and development of server code without
 * having to build the server.
 */

enableConnectionFeature(ConnectionFeatureFlag.DefaultBlockEditPrediction);

startServer(defaultWorld => {
  defaultWorld.loadMap(worldMap as WorldMap);
  defaultWorld.simulation.enableDebugRendering(true);
  defaultWorld.on(PlayerEvent.JOINED_WORLD, playerJoinedWorld);
  defaultWorld.on(PlayerEvent.LEFT_WORLD, playerLeftWorld);
});

function playerJoinedWorld({ player, world }: { player: Player, world: World }) {
  const playerEntity = new DefaultPlayerEntity({
    player,
    name: 'Player',
  });

  playerEntity.spawn(world, { x: 0, y: 10, z: 0 });

  // Block placement/removal for testing
  const controller = playerEntity.controller as DefaultPlayerEntityController;
  controller.on(BaseEntityControllerEvent.TICK_WITH_PLAYER_INPUT, ({ entity, predictedBlockEditBatches }) => {
    for (const batch of predictedBlockEditBatches) {
      const validatedEdit = validatePredictedDefaultBlockEdit(entity, world, batch.edits);

      if (!validatedEdit) {
        player.rollbackPredictedBlockEdit(batch.predictionId);
        continue;
      }

      world.chunkLattice.setBlock(
        validatedEdit.globalCoordinate,
        validatedEdit.blockTypeId,
        validatedEdit.blockRotation,
      );
      player.confirmPredictedBlockEdit(batch.predictionId);
    }
  });
}

function playerLeftWorld({ player, world }: { player: Player, world: World }) {
  world.entityManager.getPlayerEntitiesByPlayer(player).forEach(entity => entity.despawn());
}

function validatePredictedDefaultBlockEdit(
  playerEntity: PlayerEntity,
  world: World,
  edits: readonly PredictedBlockEditAttempt[],
): { globalCoordinate: Vector3Like, blockTypeId: number, blockRotation?: BlockRotation } | undefined {
  if (edits.length !== 1) {
    return undefined;
  }

  const [ edit ] = edits;
  const predictionConfig = playerEntity.player.defaultBlockEditPredictionConfig;
  const rayOrigin = getPlayerCameraRayOrigin(playerEntity);
  const rayDirection = playerEntity.player.camera.facingDirection;
  const raycastHit = world.simulation.raycast(
    rayOrigin,
    rayDirection,
    predictionConfig.maxDistance,
    { filterExcludeRigidBody: playerEntity.rawRigidBody },
  );
  const hitBlock = raycastHit?.hitBlock;

  if (!hitBlock || !raycastHit) {
    return undefined;
  }

  if (edit.blockTypeId === 0) {
    if (hitBlock.blockType.isLiquid || !vectorsEqual(edit.globalCoordinate, hitBlock.globalCoordinate)) {
      return undefined;
    }

    return {
      globalCoordinate: hitBlock.globalCoordinate,
      blockTypeId: 0,
    };
  }

  if (
    predictionConfig.placeBlockTypeId <= 0 ||
    edit.blockTypeId !== predictionConfig.placeBlockTypeId ||
    edit.blockRotationIndex !== predictionConfig.placeBlockRotationIndex
  ) {
    return undefined;
  }

  const placementCoordinate = hitBlock.blockType.isLiquid
    ? hitBlock.globalCoordinate
    : hitBlock.getNeighborGlobalCoordinateFromHitPoint(raycastHit.hitPoint);
  const replacedBlockType = world.chunkLattice.getBlockType(placementCoordinate);

  if (
    !vectorsEqual(edit.globalCoordinate, placementCoordinate) ||
    (replacedBlockType !== null && !replacedBlockType.isLiquid)
  ) {
    return undefined;
  }

  return {
    globalCoordinate: placementCoordinate,
    blockTypeId: predictionConfig.placeBlockTypeId,
    blockRotation: getBlockRotationByIndex(predictionConfig.placeBlockRotationIndex),
  };
}

function getBlockRotationByIndex(blockRotationIndex: number | undefined): BlockRotation | undefined {
  if (blockRotationIndex === undefined) {
    return undefined;
  }

  return Object.values(BLOCK_ROTATIONS).find(rotation => rotation.enumIndex === blockRotationIndex);
}

function getPlayerCameraRayOrigin(playerEntity: PlayerEntity): Vector3Like {
  const camera = playerEntity.player.camera;
  const basePosition = camera.attachedToPosition ?? camera.attachedToEntity?.position ?? playerEntity.position;

  return {
    x: basePosition.x + camera.offset.x,
    y: basePosition.y + camera.offset.y,
    z: basePosition.z + camera.offset.z,
  };
}

function vectorsEqual(a: Vector3Like, b: Vector3Like): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}
