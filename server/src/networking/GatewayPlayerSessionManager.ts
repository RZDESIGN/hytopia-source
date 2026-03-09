import type Connection from '@/networking/Connection';
import GatewayPlayerSession from '@/networking/GatewayPlayerSession';
import type Player from '@/players/Player';

/**
 * Gateway-owned registry of live player sessions.
 *
 * This is the authoritative lookup layer for routing by connection or player id
 * before packets cross into a hosted world.
 *
 * **Category:** Networking
 * @internal
 */
export default class GatewayPlayerSessionManager {
  public static readonly instance = new GatewayPlayerSessionManager();

  private _connectionSessions: Map<Connection, GatewayPlayerSession> = new Map();
  private _playerIdSessions: Map<string, GatewayPlayerSession> = new Map();

  private constructor() {}

  public get sessionCount(): number {
    return this._connectionSessions.size;
  }

  public createSession(player: Player): GatewayPlayerSession {
    const existing = this._playerIdSessions.get(player.id);
    if (existing) {
      this._connectionSessions.delete(existing.connection);
    }

    const session = new GatewayPlayerSession(player);
    this._connectionSessions.set(session.connection, session);
    this._playerIdSessions.set(session.playerId, session);
    return session;
  }

  public getSessionByConnection(connection: Connection): GatewayPlayerSession | undefined {
    return this._connectionSessions.get(connection);
  }

  public getSessionByPlayer(player: Player): GatewayPlayerSession | undefined {
    return this._playerIdSessions.get(player.id);
  }

  public getSessionByPlayerId(playerId: string): GatewayPlayerSession | undefined {
    return this._playerIdSessions.get(playerId);
  }

  public getAllSessions(): GatewayPlayerSession[] {
    return Array.from(this._connectionSessions.values());
  }

  public getAllPlayers(): Player[] {
    return this.getAllSessions().map(session => session.player);
  }

  public removeSessionByConnection(connection: Connection): GatewayPlayerSession | undefined {
    const session = this._connectionSessions.get(connection);
    if (!session) {
      return undefined;
    }

    this._connectionSessions.delete(connection);
    if (this._playerIdSessions.get(session.playerId) === session) {
      this._playerIdSessions.delete(session.playerId);
    }
    return session;
  }
}
