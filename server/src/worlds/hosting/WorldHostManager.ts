import InlineWorldHostClient from '@/worlds/hosting/InlineWorldHostClient';
import type WorldHostClient from '@/worlds/hosting/WorldHostClient';

/**
 * Global access point for the active world host client.
 *
 * The default implementation is in-process. A later process-backed runtime can
 * replace the client without changing world or player routing call sites.
 *
 * **Category:** Networking
 * @internal
 */
export default class WorldHostManager {
  public static readonly instance = new WorldHostManager();

  private _client: WorldHostClient = InlineWorldHostClient.instance;

  private constructor() {}

  public get client(): WorldHostClient {
    return this._client;
  }

  public setClient(client: WorldHostClient): void {
    this._client = client;
  }
}
