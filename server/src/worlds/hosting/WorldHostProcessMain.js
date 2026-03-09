const worlds = new Map();

const log = (level, message, worldId) => {
  if (typeof process.send === 'function') {
    process.send({
      type: 'world_log',
      level,
      message,
      worldId,
      processId: `child-${process.pid}`,
    });
  }
};

process.on('message', message => {
  if (!message || typeof message !== 'object') {
    return;
  }

  switch (message.type) {
    case 'world_boot': {
      const worldId = Number(message.world?.id ?? message.options?.id);
      worlds.set(worldId, {
        descriptor: message.world,
        options: message.options,
        players: new Set(),
        packetsReceived: 0,
      });

      if (typeof process.send === 'function') {
        process.send({
          type: 'world_ready',
          processId: `child-${process.pid}`,
          world: message.world,
        });
      }

      log('info', `booted shadow host for world ${worldId}`, worldId);
      break;
    }
    case 'world_stop': {
      worlds.delete(message.worldId);
      if (typeof process.send === 'function') {
        process.send({
          type: 'world_stopped',
          processId: `child-${process.pid}`,
          reason: message.reason,
          worldId: message.worldId,
        });
      }

      log('info', `stopped shadow host for world ${message.worldId}`, message.worldId);
      break;
    }
    case 'player_attach': {
      const world = worlds.get(message.worldId);
      if (world) {
        world.players.add(message.player.id);
      }

      log('debug', `attached player ${message.player.id}`, message.worldId);
      break;
    }
    case 'player_detach': {
      const world = worlds.get(message.worldId);
      if (world) {
        world.players.delete(message.playerId);
      }

      log('debug', `detached player ${message.playerId} (${message.reason})`, message.worldId);
      break;
    }
    case 'player_packets': {
      const world = worlds.get(message.worldId);
      if (world) {
        world.packetsReceived += Array.isArray(message.packets) ? message.packets.length : 0;
      }
      break;
    }
    default:
      log('warn', `ignored unknown message type ${String(message.type)}`);
      break;
  }
});

process.on('SIGTERM', () => {
  log('info', 'shadow host shutting down');
  process.exit(0);
});

log('info', 'shadow host process started');
