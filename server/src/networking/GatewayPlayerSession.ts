import type Connection from '@/networking/Connection';
import type Player from '@/players/Player';

/**
 * Gateway-owned session for a connected player.
 *
 * This object is the routing identity used by gateway-facing systems. It keeps
 * transport and player references together without forcing host interfaces to
 * depend on `Player` directly.
 *
 * **Category:** Networking
 * @internal
 */
export default class GatewayPlayerSession {
  public readonly connection: Connection;
  public readonly player: Player;

  public constructor(player: Player) {
    this.player = player;
    this.connection = player.connection;
  }

  public get connectionId(): string {
    return this.connection.id;
  }

  public get playerId(): string {
    return this.player.id;
  }
}
