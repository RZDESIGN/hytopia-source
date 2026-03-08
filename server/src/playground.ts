import {
  startServer,
  BaseEntityControllerEvent,
  ConnectionFeatureFlag,
  DEFAULT_BLOCK_EDIT_PREDICTION_MAX_DISTANCE,
  DEFAULT_BLOCK_EDIT_PREDICTION_PLACE_BLOCK_ID,
  DefaultPlayerEntity,
  DefaultPlayerEntityController,
  enableConnectionFeature,
  Player,
  PlayerEvent,
  World,
  type WorldMap,
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
  controller.on(BaseEntityControllerEvent.TICK_WITH_PLAYER_INPUT, ({ input }) => {
    if (!input.ml && !input.mr) return;

    const pos = playerEntity.position;
    const dir = player.camera.facingDirection;
    const origin = {
      x: pos.x + dir.x * 0.5,
      y: pos.y + dir.y * 0.5 + player.camera.offset.y,
      z: pos.z + dir.z * 0.5,
    };

    const hit = world.simulation.raycast(origin, dir, DEFAULT_BLOCK_EDIT_PREDICTION_MAX_DISTANCE, {
      filterExcludeRigidBody: playerEntity.rawRigidBody,
    });

    if (!hit?.hitBlock) return;

    if (input.ml) {
      world.chunkLattice.setBlock(hit.hitBlock.globalCoordinate, 0);
      player.input.ml = false;
    }

    if (input.mr) {
      const placeCoord = hit.hitBlock.getNeighborGlobalCoordinateFromHitPoint(hit.hitPoint);
      world.chunkLattice.setBlock(placeCoord, DEFAULT_BLOCK_EDIT_PREDICTION_PLACE_BLOCK_ID);
      player.input.mr = false;
    }
  });
}

function playerLeftWorld({ player, world }: { player: Player, world: World }) {
  world.entityManager.getPlayerEntitiesByPlayer(player).forEach(entity => entity.despawn());
}
