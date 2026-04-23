import EventRouter from '../events/EventRouter';
import { NetworkManagerEventType } from '../network/NetworkManager';
import Player from './Player';
import type Game from '../Game';
import type { NetworkManagerEventPayload } from '../network/NetworkManager';
import { DeserializedPlayer } from '../network/Deserializer';

export default class PlayerManager {
  private _game: Game;
  private _players: Map<string, Player> = new Map();
  private _loggedIncompletePlayerIds: Set<string> = new Set();

  public constructor(game: Game) {
    this._game = game;

    this._setupEventListeners();
  }

  public get game(): Game { return this._game; }

  private _setupEventListeners(): void {
    EventRouter.instance.on(
      NetworkManagerEventType.PlayersPacket,
      this._onPlayersPacket,
    );
  }

  private _onPlayersPacket = (payload: NetworkManagerEventPayload.IPlayersPacket): void => {
    for (const deserializedPlayer of payload.deserializedPlayers) {
      this._updatePlayer(deserializedPlayer);
    }
  }

  private _updatePlayer = (deserializedPlayer: DeserializedPlayer): void => {
    let player = this._players.get(deserializedPlayer.id);

    if (!player) {
      if (
        deserializedPlayer.id === undefined ||
        deserializedPlayer.username === undefined
      ) {
        if (
          deserializedPlayer.id !== undefined &&
          !this._loggedIncompletePlayerIds.has(deserializedPlayer.id)
        ) {
          this._loggedIncompletePlayerIds.add(deserializedPlayer.id);
          console.info(`PlayerManager._updatePlayer(): Player ${deserializedPlayer.id} not yet created, this can be safely ignored if no gameplay bugs are experienced.`, deserializedPlayer);
        }
        return;
      }

      this._loggedIncompletePlayerIds.delete(deserializedPlayer.id);
      player = new Player(this._game, {
        id: deserializedPlayer.id,
        username: deserializedPlayer.username,
        profilePictureUrl: deserializedPlayer.profilePictureUrl,
      });

      this._players.set(player.id, player);
    } else {
      if (deserializedPlayer.removed) {
        this._players.delete(player.id);
        this._loggedIncompletePlayerIds.delete(player.id);
      }
    }
  }
}
