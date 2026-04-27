import fs from 'fs';
import path from 'path';
import { inspect } from 'util';
import WebSocket from 'ws';
import * as graphQLWS from 'graphql-ws';
import { CreativeGateway } from '@hytopia.com/creative-lib';
import ErrorHandler from '@/errors/ErrorHandler';
import type { ErrorCodes as KVErrorCodes } from '@hytopia.com/creative-lib/dist/impl/kv/get';
import type { LobbyMembershipDto, ErrorCodes as SessionErrorCodes } from '@hytopia.com/creative-lib/dist/impl/getSession';
import type { ServiceResponseDto } from '@hytopia.com/creative-lib/dist/types/serviceResponse';

const LOCAL_DATA_DIRECTORY = './dev/persistence';
const NOTIFICATION_SERVICE_URL = process.env.HYTOPIA_NOTIFICATION_SERVICE_URL || 'https://prod.notifications.hytopia.com';
const SELFHOST_ENABLED = process.env.HYTOPIA_SELFHOST === '1' || process.env.HYTOPIA_API_KEY === 'selfhost-local';
const SELFHOST_USERS_PATH = process.env.HYTOPIA_SELFHOST_USERS_PATH || '/hytopia-manager/public/users.json';
const SELFHOST_ASSET_BASE_URL = (process.env.HYTOPIA_SELFHOST_ASSET_BASE || '').replace(/\/+$/, '');
const DEFAULT_LOCKER = {
  skinTone: 3,
  clothing: 1,
  hairStyle: 3,
  hairColor: 5,
  eyeColor: '00FF00',
} as const;
const VALID_EYE_COLORS = new Set(['00FF00', '2F80ED', '7A4A20', 'D99A2B', '8E5CF2', 'B9C1CC']);

type SelfHostLocker = {
  skinTone: number;
  clothing: number;
  hairStyle: number;
  hairColor: number;
  eyeColor: string;
};

/**
 * The cosmetics of a player.
 *
 * **Category:** Networking
 * @public
 */
export type PlayerCosmetics = {
  equippedItems: {
    slot: string;
    item: PlayerCosmeticsEquippedItem;
  }[];
  hairModelUri?: string;
  hairTextureUri?: string;
  skinTextureUri: string;
}

/**
 * An equipped item of a player's cosmetics.
 *
 * **Category:** Networking
 * @public
 */
export type PlayerCosmeticsEquippedItem = {
  flags: string[];
  type: string;
  modelUrl: string;
  textureUrl?: string;
}

/** @internal */
export type PlayerCosmeticsGqlUserById = {
  userById?: {
    characterSettings?: Partial<{
      skinTone: string; 
      clothing: string; 
      hair: {
        modelUrl?: string;
        textureUrl?: string;
      };
      hairStyle: string; 
      hairColor: string; 
      eyeColor: string; 
    }>;
    equippedItems?: {
      slot: string;
      itemInstance: {
        item: {
          slots: PlayerCosmeticsEquippedItem[];
        };
      };
    }[];
  };
};

/** @internal */
export type KVData = Record<string, unknown>;

/** @internal */
export type KVResult = ServiceResponseDto<KVData, KVErrorCodes>;

/** @internal */
export type Session = LobbyMembershipDto;

/** @internal */
export type SessionResult = ServiceResponseDto<Session, SessionErrorCodes>;

function normalizeLocker(input: unknown): SelfHostLocker {
  const locker = input && typeof input === 'object' ? input as Partial<SelfHostLocker> : {};
  const eyeColor = String(locker.eyeColor || '').toUpperCase();
  return {
    skinTone: clampInteger(locker.skinTone, 1, 5, DEFAULT_LOCKER.skinTone),
    clothing: clampInteger(locker.clothing, 1, 41, DEFAULT_LOCKER.clothing),
    hairStyle: clampInteger(locker.hairStyle, 1, 10, DEFAULT_LOCKER.hairStyle),
    hairColor: clampInteger(locker.hairColor, 1, 10, DEFAULT_LOCKER.hairColor),
    eyeColor: VALID_EYE_COLORS.has(eyeColor) ? eyeColor : DEFAULT_LOCKER.eyeColor,
  };
}

function buildCloudfrontSkinTextureUri(locker: SelfHostLocker): string {
  const params = new URLSearchParams({
    skin_tone: `SKIN_COLOR_${locker.skinTone}`,
    clothing: `CLOTHING_${locker.clothing}`,
    hair_style: `HAIR_STYLE_${locker.hairStyle}`,
    hair_color: `HAIR_COLOR_${locker.hairColor}`,
    eye_color: locker.eyeColor,
  });
  return `https://d3qkovarww0lj1.cloudfront.net/?${params.toString()}`;
}

function lockerSignature(locker: SelfHostLocker): string {
  return [locker.skinTone, locker.clothing, locker.hairStyle, locker.hairColor, locker.eyeColor].join('-');
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number.parseInt(String(value), 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/**
 * Accesses HYTOPIA platform services (sessions, cosmetics, persistence, notifications).
 *
 * When to use: integrating with live player accounts and platform-backed data.
 * Do NOT use for: per-frame data access; cache results per player.
 *
 * @remarks
 * In local development without platform credentials, this gateway falls back to
 * local persistence and disables live platform features.
 *
 * Pattern: call `getPlayerSession` during connection authorization, then
 * cache `getPlayerCosmetics` results on join.
 * Anti-pattern: calling `getPlayerCosmetics` or `getGlobalData` every tick.
 *
 * **Category:** Networking
 * @internal
 */
export default class PlatformGateway {
  public static readonly instance: PlatformGateway = new PlatformGateway();

  public readonly creatorApiKey: string | undefined = process.env.HYTOPIA_API_KEY;
  public readonly gameId: string | undefined = process.env.HYTOPIA_GAME_ID;
  public readonly lobbyId: string | undefined = process.env.HYTOPIA_LOBBY_ID;

  private _creativeGateway: CreativeGateway | undefined;
  private _gqlWs: graphQLWS.Client;

  private constructor() {
    this._gqlWs = graphQLWS.createClient({
      url: 'wss://prod.gql.hytopia.com/graphql',
      webSocketImpl: WebSocket,
    });

    try {
      this._creativeGateway = new CreativeGateway();
    } catch {
      console.warn([
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        '🚨 HYTOPIA PLATFORM GATEWAY IS NOT INITIALIZED 🚨',
        '',
        '🔧 Local development is still possible, but these features will be disabled:',
        '  • 👤 Live Player Accounts',
        '  • 🎭 Live Player Cosmetics',
        '  • 🔔 Scheduled Notifications',
        '  • 🐛 Crash Analytics & Debug Logs',
        '',
        '💡 These features will be enabled but modified:',
        '  • 💾 Player & Global Persisted Data - Data will be persisted',
        '       locally in the ./dev/persistence directory of your project.',
        '       Player ids for data persistence will begin at 1 for the first ',
        '       player to join your local server, and increments for each',
        '       additional player. This means that if you restart your',
        '       server, the first player id will be 1 again. This is to ensure',
        '       that data persistence across server restarts can be easily',
        '       tested and debugged in local development.',
        '',
        'To enable the HYTOPIA Platform Gateway locally:',
        '  1. Set these environment variables:',
        '     HYTOPIA_API_KEY, HYTOPIA_GAME_ID, HYTOPIA_LOBBY_ID',
        '  2. You can find these values at: https://create.hytopia.com',
        '',
        'Note: In production, these environment variables will be auto-populated ', 
        '& the HYTOPIA Platform Gateway will automatically be initialized 🚀',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        '',
      ].join('\n'));
    }
  }

  /**
   * Whether the platform gateway is available (credentials configured).
   *
   * **Category:** Networking
   */
  public get isGatewayAvailable(): boolean { return !!this._creativeGateway; }

  /** @internal */
  public get isSelfHost(): boolean { return SELFHOST_ENABLED; }

  /**
   * Retrieves global key-value data for the current game.
   *
   * @remarks
   * In local development, this reads from the local persistence directory.
   *
   * @param key - The key to retrieve.
   * @returns A service response containing data or an error.
   *
   * **Requires:** Platform credentials in production or local persistence in dev.
   *
   * **Side effects:** May perform network or filesystem I/O.
   *
   * @see `setGlobalData`
   *
   * **Category:** Networking
   */
  public async getGlobalData(key: string): Promise<KVResult> {
    if (!this._creativeGateway && process.env.NODE_ENV === 'production') {
      ErrorHandler.warning('PlatformGateway.getGlobalData(): You are running in production mode, but the Platform Gateway is not initialized! No data will be returned.');

      return { error: { code: 'gatewayError', message: 'Platform Gateway is not initialized.' } };
    }

    return this._creativeGateway 
      ? await this._creativeGateway.kv.get(key)
      : this._readDevGlobalDataLocally(key);
  }

  /**
   * Retrieves a player's cosmetics and equipped items.
   *
   * @remarks
   * Uses the public GraphQL endpoint; cache results per player to avoid repeated calls.
   *
   * @param userId - The HYTOPIA user id.
   * @returns The player's cosmetics or void if unavailable.
   *
   * **Side effects:** Performs a network request to the platform GraphQL service.
   *
   * **Category:** Networking
   */
  public async getPlayerCosmetics(userId: string): Promise<PlayerCosmetics | void> {
    if (SELFHOST_ENABLED) {
      return this._getSelfHostPlayerCosmetics(userId);
    }

    const iterator = this._gqlWs.iterate<PlayerCosmeticsGqlUserById, { id: string }>({
      query: `{
        userById(id: "${userId}") {
          characterSettings {
            clothing
            eyeColor
            skinTone
            hairColor
            hairStyle
            hair {
              modelUrl
              textureUrl
            }
          }
          equippedItems {
            slot
            itemInstance {
              item {
                slots {
                  flags
                  type
                  modelUrl
                  textureUrl
                }
              }
            }
          }
        }
      }`,
    });

    try {
      const gqlResult = await iterator.next();
      const cosmeticsUser = ((gqlResult.value as Record<string, unknown>)?.data as PlayerCosmeticsGqlUserById)?.userById;

      if (!cosmeticsUser) {
        return ErrorHandler.warning(`PlatformGateway.getPlayerCosmetics(): No cosmetic data returned for user id "${userId}".`);
      };

      const equippedItems = cosmeticsUser.equippedItems ? cosmeticsUser.equippedItems.map(item => ({
        slot: item.slot,
        item: item.itemInstance.item.slots.find(s => s.type === item.slot),
      })).filter(s => !!s.item) as PlayerCosmetics['equippedItems'] : [];

      const hairModelUri = cosmeticsUser.characterSettings?.hair?.modelUrl;
      const hairTextureUri = cosmeticsUser.characterSettings?.hair?.textureUrl;
      const skinTextureUri = 'https://d3qkovarww0lj1.cloudfront.net/' +
                             `?skin_tone=${cosmeticsUser.characterSettings?.skinTone || 'SKIN_COLOR_1'}` +
                             `&clothing=${cosmeticsUser.characterSettings?.clothing || 'CLOTHING_1'}` +
                             `&hair_style=${cosmeticsUser.characterSettings?.hairStyle || 'HAIR_STYLE_1'}` +
                             `&hair_color=${cosmeticsUser.characterSettings?.hairColor || 'HAIR_COLOR_1'}` +
                             `&eye_color=${cosmeticsUser.characterSettings?.eyeColor || '00FF00'}`;

      return { equippedItems, hairModelUri, hairTextureUri, skinTextureUri };
    } catch (error) {
      ErrorHandler.warning(
        `PlatformGateway.getPlayerCosmetics(): Failed to fetch cosmetics for user id "${userId}". Falling back to default cosmetics.`,
        inspect(error, { depth: 3 }),
      );

      return;
    } finally {
      await iterator.return?.();
    }
  }

  private async _getSelfHostPlayerCosmetics(userId: string): Promise<PlayerCosmetics> {
    const account = await this._readSelfHostAccount(userId);
    const locker = normalizeLocker(account?.locker);
    const assetBase = SELFHOST_ASSET_BASE_URL;
    const skinTextureUri = account?.id && assetBase
      ? `${assetBase}/api/public/locker/texture/${encodeURIComponent(account.id)}.png?v=${encodeURIComponent(lockerSignature(locker))}`
      : buildCloudfrontSkinTextureUri(locker);

    return {
      equippedItems: [],
      hairModelUri: assetBase ? `${assetBase}/player-locker/hair/hair-${String(locker.hairStyle).padStart(4, '0')}.gltf` : undefined,
      hairTextureUri: assetBase ? `${assetBase}/player-locker/Textures/hairstyle-texture/${locker.hairStyle}/hair-${locker.hairStyle}-${locker.hairColor}.png` : undefined,
      skinTextureUri,
    };
  }

  private async _readSelfHostAccount(userId: string): Promise<{ id: string, locker?: unknown } | undefined> {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(SELFHOST_USERS_PATH, 'utf8'));
      const account = parsed?.users?.[userId];
      if (!account?.id) return;
      return { id: account.id, locker: account.locker };
    } catch (error) {
      const err = error as { code?: string, message?: string };
      if (err?.code !== 'ENOENT') {
        ErrorHandler.warning(`PlatformGateway.getPlayerCosmetics(): Failed to read self-host users at ${SELFHOST_USERS_PATH}: ${err?.message || error}`);
      }
      return;
    }
  }

  /**
   * Retrieves a player session from a session token.
   *
   * @param sessionToken - The session token from the client.
   * @returns The session response, or void if the gateway is unavailable.
   *
   * **Requires:** Platform gateway must be available.
   *
   * **Side effects:** Performs a network request when the gateway is available.
   *
   * **Category:** Networking
   */
  public async getPlayerSession(sessionToken: string): Promise<SessionResult | void> {
    if (!this._creativeGateway) {
      return;
    }

    return await this._creativeGateway.getSession(sessionToken);
  }

  /**
   * Schedules a notification for a player.
   *
   * @param userId - The HYTOPIA user id to notify.
   * @param type - The notification type.
   * @param scheduledFor - Epoch time in ms; must be at least 60 seconds in the future.
   * @returns The notification id, or void if scheduling fails.
   *
   * **Requires:** `HYTOPIA_GAME_ID` and `HYTOPIA_API_KEY` environment variables.
   *
   * **Side effects:** Performs an authenticated HTTP request to the notification service.
   *
   * @see `unscheduleNotification`
   *
   * **Category:** Networking
   */
  public async scheduleNotification(userId: string, type: string, scheduledFor: number): Promise<string | void> {
    if (!NOTIFICATION_SERVICE_URL) {
      return ErrorHandler.warning('PlatformGateway.scheduleNotification(): HYTOPIA_NOTIFICATION_SERVICE_URL is not set. Unable to schedule notification.');
    }

    if (!this.gameId || !this.creatorApiKey) {
      return ErrorHandler.warning('PlatformGateway.scheduleNotification(): HYTOPIA_GAME_ID or HYTOPIA_API_KEY is not set. Unable to schedule notification.');
    }

    if (scheduledFor < Date.now() + 55 * 1000) { // Use 55s to account for latency/clock drift
      return ErrorHandler.warning('PlatformGateway.scheduleNotification(): scheduledFor must be at least 60 seconds in the future. Unable to schedule notification.');
    }

    try {
      const response = await fetch(`${NOTIFICATION_SERVICE_URL}/notifications`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Game-Id': this.gameId,
          'X-Creator-Api-Key': this.creatorApiKey,
        },
        body: JSON.stringify({ hytopiaUserId: userId, type, scheduledFor }),
      });

      if (!response.ok) {
        return ErrorHandler.warning(`PlatformGateway.scheduleNotification(): Failed ${response.status}: ${await response.text()}`);
      }

      const json = (await response.json()) as { id?: string };

      return json.id;
    } catch (error) {
      return ErrorHandler.warning(`PlatformGateway.scheduleNotification(): Failed to schedule notification: ${error as Error}`);
    }
  }

  /**
   * Writes global key-value data for the current game.
   *
   * @remarks
   * In local development, this performs a shallow merge with existing data on disk.
   *
   * @param key - The key to set.
   * @param data - The data to store (no `error` property allowed).
   * @returns A service response, or void if the gateway is unavailable.
   *
   * **Requires:** Platform credentials in production or local persistence in dev.
   *
   * **Side effects:** May perform network or filesystem I/O.
   *
   * @see `getGlobalData`
   *
   * **Category:** Networking
   */
  public async setGlobalData(key: string, data: Record<string, unknown>): Promise<KVResult | void> {
    if (data.error) {
      return ErrorHandler.warning('PlatformGateway.setGlobalData(): Cannot set data with an error property.');
    }

    if (!this._creativeGateway && process.env.NODE_ENV === 'production') {
      return ErrorHandler.warning('PlatformGateway.setGlobalData(): You are running in production mode, but the Platform Gateway is not initialized! No data will be set.');
    }

    return this._creativeGateway
      ? await this._creativeGateway.kv.set(key, data)
      : this._writeDevGlobalDataLocally(key, data);
  }

  /**
   * Cancels a previously scheduled notification.
   *
   * @param notificationId - The id returned by `scheduleNotification`.
   * @returns True if the notification was cancelled.
   *
   * **Requires:** `HYTOPIA_GAME_ID` and `HYTOPIA_API_KEY` environment variables.
   *
   * **Side effects:** Performs an authenticated HTTP request to the notification service.
   *
   * @see `scheduleNotification`
   *
   * **Category:** Networking
   */
  public async unscheduleNotification(notificationId: string): Promise<boolean> {
    if (!NOTIFICATION_SERVICE_URL) {
      ErrorHandler.warning('PlatformGateway.unscheduleNotification(): HYTOPIA_NOTIFICATION_SERVICE_URL is not set.');

      return false;
    }

    if (!this.gameId || !this.creatorApiKey) {
      ErrorHandler.warning('PlatformGateway.scheduleNotification(): HYTOPIA_GAME_ID or HYTOPIA_API_KEY is not set.');

      return false;
    }

    try {
      const response = await fetch(`${NOTIFICATION_SERVICE_URL}/notifications/${notificationId}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'X-Game-Id': this.gameId,
          'X-Creator-Api-Key': this.creatorApiKey,
        },
      });

      if (!response.ok) {
        ErrorHandler.warning(`PlatformGateway.unscheduleNotification(): Failed ${response.status}: ${await response.text()}`);

        return false;
      }

      return true;
    } catch (error) {
      ErrorHandler.warning(`PlatformGateway.unscheduleNotification(): Failed to unschedule notification: ${error as Error}`);

      return false;
    }
  }

  private _readDevGlobalDataLocally(key: string): KVResult {
    try {
      if (!fs.existsSync(LOCAL_DATA_DIRECTORY)) {
        return { error: { code: 'keyNotFound', message: 'Local data directory not found.' } };
      }

      const filePath = path.join(LOCAL_DATA_DIRECTORY, `${key}.json`);

      if (!fs.existsSync(filePath)) {
        return { error: { code: 'keyNotFound', message: `Data for key "${key}" not found.` } };
      }

      return JSON.parse(fs.readFileSync(filePath, 'utf8')) as KVResult;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { error: { code: 'keyNotFound', message: `Data for key "${key}" not found.` } };
      }

      ErrorHandler.warning(`PlatformGateway._readDevGlobalDataLocally(): Failed to read data for key "${key}": ${error as Error}`);
      
      return { error: { code: 'gatewayError', message: 'Failed to read data for key.' } };
    }
  }

  private _writeDevGlobalDataLocally(key: string, data: KVData): void {
    try {
      if (!fs.existsSync(LOCAL_DATA_DIRECTORY)) {
        fs.mkdirSync(LOCAL_DATA_DIRECTORY, { recursive: true });
      }

      const filePath = path.join(LOCAL_DATA_DIRECTORY, `${key}.json`);
      
      let existingData: KVData = {};

      if (fs.existsSync(filePath)) {
        existingData = JSON.parse(fs.readFileSync(filePath, 'utf8')) as KVData;
      }

      const mergedData = { ...existingData, ...data }; // shallow merge, consistent with default Creative Gateway behavior
      
      fs.writeFileSync(filePath, JSON.stringify(mergedData, null, 2), 'utf8');
    } catch (error) {
      ErrorHandler.warning(`PlatformGateway._writeDevGlobalDataLocally(): Failed to write data for key "${key}": ${error as Error}`);
    }
  }
}
