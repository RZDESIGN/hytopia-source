import EventRouter from '../events/EventRouter';
import { NetworkManagerEventType } from '../network/NetworkManager';
import { DistantBlockViewMode, QUALITY_PRESETS } from '../settings/SettingsManager';
import Game from '../Game';
import type { NetworkManagerEventPayload } from '../network/NetworkManager';
import type { DeserializedChatMessage, DeserializedPlayer } from '../network/Deserializer';

/**
 * This manager is responsible for relaying messages from the client to the
 * parent window, and handling messages from the parent window. This is
 * necessary because the client and parent window are in different frames.
 * The HYTOPIA game client, will in nearly all cases be embeded within
 * an iframe, with the game overlay and account level systems being the
 * top level parent window. These two need to be able to communicate with
 * each other, and this manager is responsible for that.
 */

enum BridgeMessageType {
  // Parent -> Client messages
  LOCK_POINTER = 'lock-pointer', // parent wants the client to lock the pointer
  UNLOCK_POINTER = 'unlock-pointer', // parent wants the client to unlock the pointer
  SEND_CHAT_MESSAGE = 'send-chat-message', // chat message is sent by user from parent input
  SET_DISTANT_BLOCK_VIEW_MODE = 'set-distant-block-view-mode', // parent wants the client to set the distant block view preference
  SET_MASTER_VOLUME = 'set-master-volume', // parent wants the client to set the master volume
  SET_INVERT_VERTICAL_LOOK = 'set-invert-vertical-look', // parent wants the client to invert vertical camera look
  SET_MOUSE_SENSITIVITY = 'set-mouse-sensitivity', // parent wants the client to set the mouse sensitivity
  SET_QUALITY_PRESET = 'set-quality-preset', // parent wants the client to set the game quality preset
  TOGGLE_DEBUG = 'toggle-debug', // parent wants the client to toggle the debug menu

  // Client -> Parent messages
  CHAT_MESSAGE = 'chat-message', // chat message is received from the server
  GAME_READY = 'game-ready', // sent when the game is fully loaded and ready
  KEY_DOWN = 'key-down', // key is pressed by user
  NOTIFICATION_PERMISSION_REQUEST = 'notification-permission-request', // notification permission requested
  PLAYER_UPDATE = 'player-update', // player update is received from the server
  RECONNECT = 'reconnect', // reconnect to the game
}

interface BridgeMessageDataMap {
  // Parent -> Client messages
  [BridgeMessageType.LOCK_POINTER]: undefined;
  [BridgeMessageType.UNLOCK_POINTER]: undefined;
  [BridgeMessageType.SEND_CHAT_MESSAGE]: { message: string; };
  [BridgeMessageType.SET_DISTANT_BLOCK_VIEW_MODE]: { mode: DistantBlockViewMode; };
  [BridgeMessageType.SET_MASTER_VOLUME]: { volume: number; };
  [BridgeMessageType.SET_INVERT_VERTICAL_LOOK]: { invert: boolean; };
  [BridgeMessageType.SET_QUALITY_PRESET]: { preset: keyof typeof QUALITY_PRESETS; };
  [BridgeMessageType.SET_MOUSE_SENSITIVITY]: { sensitivity: number; };
  [BridgeMessageType.TOGGLE_DEBUG]: undefined;

  // Client -> Parent messages
  [BridgeMessageType.CHAT_MESSAGE]: DeserializedChatMessage;
  [BridgeMessageType.GAME_READY]: undefined;
  [BridgeMessageType.KEY_DOWN]: { key: string; };
  [BridgeMessageType.NOTIFICATION_PERMISSION_REQUEST]: undefined;
  [BridgeMessageType.PLAYER_UPDATE]: DeserializedPlayer;
  [BridgeMessageType.RECONNECT]: { url: string; };
}

interface BridgeMessage<T extends BridgeMessageType> {
  type: T;
  data: BridgeMessageDataMap[T];
}

const MONITORED_KEY_COMBINATIONS = [
  'Escape',
  'Shift+~',
  '/',
  't'
];

export default class BridgeManager {
  private _game: Game;

  constructor(game: Game) {
    this._game = game;
    this._setupEventListeners();
  }

  public sendGameReady(): void {
    this._sendParentMessage({
      type: BridgeMessageType.GAME_READY,
      data: undefined
    });
  }

  public sendReconnect(url: string): void {
    this._sendParentMessage({
      type: BridgeMessageType.RECONNECT,
      data: { url }
    });
  }

  private _setupEventListeners(): void {
    document.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('message', this._onParentMessage);

    EventRouter.instance.on(
      NetworkManagerEventType.ChatMessagesPacket,
      this._onChatMessagesPacket
    );

    EventRouter.instance.on(
      NetworkManagerEventType.NotificationPermissionRequestPacket,
      this._onNotificationPermissionRequestPacket
    );

    EventRouter.instance.on(
      NetworkManagerEventType.PlayersPacket,
      this._onPlayersPacket
    );
  }

  private _onKeyDown = (event: KeyboardEvent): void => {
    // Don't trigger monitored key combinations if user is typing in an input field
    const activeElement = document.activeElement;
    const isTypingInInput = activeElement && (
      activeElement.tagName === 'INPUT' ||
      activeElement.tagName === 'TEXTAREA' ||
      activeElement.getAttribute('contenteditable') === 'true'
    );

    if (isTypingInInput) {
      return;
    }

    const matchedCombination = MONITORED_KEY_COMBINATIONS.find(combo => {
      const parts = combo.split('+').map(p => p.trim());
      const keyToken = parts.pop() ?? '';

      if (event.key.toLowerCase() !== keyToken.toLowerCase()) return false;

      const mods = new Set(parts.map(m => m.toLowerCase()));
      const wantCtrl = mods.has('ctrl') || mods.has('control');
      const wantShift = mods.has('shift');
      const wantAlt = mods.has('alt') || mods.has('option');
      const wantMeta = mods.has('meta') || mods.has('cmd') || mods.has('command');

      return event.ctrlKey === wantCtrl &&
             event.shiftKey === wantShift &&
             event.altKey === wantAlt &&
             event.metaKey === wantMeta;
    });

    if (matchedCombination) {
      event.preventDefault();
      this._sendParentMessage({
        type: BridgeMessageType.KEY_DOWN,
        data: { key: matchedCombination }
      });
    }
  }

  private _onParentMessage = (event: MessageEvent): void => {
    const { type, message } = event.data;

    switch (type) {
      case BridgeMessageType.LOCK_POINTER:
        this._game.inputManager.requestPointerLock();
        break;

      case BridgeMessageType.UNLOCK_POINTER:
        document.exitPointerLock();
        break;

      case BridgeMessageType.SEND_CHAT_MESSAGE:
        if (!message) {
          console.warn('BridgeManager: Missing message in chat message', event.data);
          return;
        }
        this._game.networkManager.sendChatMessagePacket(message.trim());
        break;

      case BridgeMessageType.SET_DISTANT_BLOCK_VIEW_MODE:
        this._game.settingsManager.setDistantBlockViewMode(message.mode);
        break;

      case BridgeMessageType.SET_MASTER_VOLUME:
        this._game.audioManager.setMasterVolume(message.volume);
        break;

      case BridgeMessageType.SET_INVERT_VERTICAL_LOOK:
        this._game.settingsManager.setInvertVerticalLook(message.invert);
        break;

      case BridgeMessageType.SET_QUALITY_PRESET:
        this._game.settingsManager.setQualityPreset(message.preset);
        break;

      case BridgeMessageType.SET_MOUSE_SENSITIVITY:
        this._game.camera.setMouseSensitivityMultiplier(message.sensitivity);
        break;

      case BridgeMessageType.TOGGLE_DEBUG:
        this._game.renderer.toggleDebug();
        break;
    }
  }

  private _onChatMessagesPacket = (payload: NetworkManagerEventPayload.IChatMessagesPacket): void => {
    for (const chatMessage of payload.deserializedChatMessages) {
      this._sendParentMessage({
        type: BridgeMessageType.CHAT_MESSAGE,
        data: chatMessage
      });
    }
  }

  private _onNotificationPermissionRequestPacket = (_payload: NetworkManagerEventPayload.INotificationPermissionRequestPacket): void => {
    this._sendParentMessage({
      type: BridgeMessageType.NOTIFICATION_PERMISSION_REQUEST,
      data: undefined
    });
  }

  private _onPlayersPacket = (payload: NetworkManagerEventPayload.IPlayersPacket): void => {
    for (const player of payload.deserializedPlayers) {
      this._sendParentMessage({
        type: BridgeMessageType.PLAYER_UPDATE,
        data: player
      });
    }
  }

  private _sendParentMessage = <T extends BridgeMessageType>(message: BridgeMessage<T>): void => {
    window.parent.postMessage(message, '*');
  }
}
