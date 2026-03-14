import fs from 'fs';
import http from 'http';
import http2 from 'http2';
import os from 'os';
import path from 'path';
import { setGlobalDispatcher, Agent } from 'undici';
import AssetsLibrary from '@/assets/AssetsLibrary';
import ErrorHandler from '@/errors/ErrorHandler';
import EventRouter from '@/events/EventRouter';
import PerformanceBaseline from '@/metrics/PerformanceBaseline';
import Telemetry from '@/metrics/Telemetry';
import PlayerManager from '@/players/PlayerManager';
import { SSL_CERT, SSL_KEY } from '@/networking/ssl/certs';
import type { Socket as RawSocket } from 'net';
import type { Session } from '@/networking/PlatformGateway';

/**
 * Set the global dispatcher for HTTP requests by libs to prevent overruning network connections.
 * Services like KV, platform gateway, notifications, and more make HTTP requests out.
 * There's probably a more appropriate file for this in the future though from an organizational standpoint.
 */
setGlobalDispatcher(new Agent({
  connections: 50,
  pipelining: 1,
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
  connect: {
    timeout: 10_000,
  },
  headersTimeout: 15_000,
  bodyTimeout: 30_000,
}));

declare module 'http' {
  interface IncomingMessage {
    connectionId: string | undefined;
    connectionParams: URLSearchParams | undefined;
    session: Session | undefined;
  }
}

/**
 * The port the server will run on.
 *
 * **Category:** Networking
 * @public
 */
export const PORT = process.env.PORT ?? 8080 as const;

/**
 * The SDK version of the server.
 *
 * @remarks
 * Replaced during SDK publish. Do not manually change this value.
 *
 * **Category:** Networking
 * @public
 */
export const SDK_VERSION = '__DEV_SDK_VERSION__'; // Replaced during SDK publish. Do not manually change this.

function isPrivateIPv4(address: string): boolean {
  const octets = address.split('.').map(Number);

  if (octets.length !== 4 || octets.some(octet => Number.isNaN(octet) || octet < 0 || octet > 255)) {
    return false;
  }

  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

function getLocalNetworkAddresses(): string[] {
  const addresses = new Set<string>();
  const networkInterfaces = os.networkInterfaces() as Record<string, os.NetworkInterfaceInfo[] | undefined>;

  for (const iface of Object.values(networkInterfaces)) {
    const detailsList: os.NetworkInterfaceInfo[] = iface ?? [];

    for (const details of detailsList) {
      const info = details as { internal?: boolean, family?: string | number, address?: string };

      if (info.internal) {
        continue;
      }

      const family = typeof info.family === 'string' ? info.family : String(info.family);
      if (family !== 'IPv4') {
        continue;
      }

      if (typeof info.address === 'string' && isPrivateIPv4(info.address)) {
        addresses.add(info.address);
      }
    }
  }

  return [...addresses];
}

/**
 * Event types a WebServer can emit.
 *
 * **Category:** Events
 * @internal
 */
export enum WebServerEvent {
  READY   = 'WEBSERVER.READY',
  STOPPED = 'WEBSERVER.STOPPED',
  ERROR   = 'WEBSERVER.ERROR',
  UPGRADE = 'WEBSERVER.UPGRADE',
}

/**
 * Event payloads for WebServer emitted events.
 *
 * **Category:** Events
 * @internal
 */
export interface WebServerEventPayloads {
  [WebServerEvent.READY]:   { };
  [WebServerEvent.STOPPED]: { };
  [WebServerEvent.ERROR]:   { error: globalThis.Error };
  [WebServerEvent.UPGRADE]: { req: http.IncomingMessage, socket: RawSocket, head: Buffer };
}

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, POST, OPTIONS',
  'access-control-allow-headers': '*',
  'access-control-allow-private-network': 'true',
};
const PERF_ENDPOINTS_ENABLED = process.env.HYTOPIA_ENABLE_PERF_ENDPOINTS === 'true' || process.env.NODE_ENV !== 'production';
const MIME: Record<string, string> = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.gltf': 'model/gltf+json', '.glb': 'model/gltf-binary',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.ktx2': 'image/ktx2',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.bin': 'application/octet-stream', '.wasm': 'application/wasm',
};

/**
 * HTTPS/HTTP2 server for serving assets and handling connection upgrades.
 *
 * When to use: internal server runtime only; created by `GameServer`.
 * Do NOT use for: custom API routing; use a separate HTTP server if needed.
 *
 * @remarks
 * Serves static assets from `assets/` and optionally the shared assets library in dev.
 * Emits `WebServerEvent.UPGRADE` for WebSocket upgrades.
 *
 * Pattern: call `WebServer.start` once during server initialization.
 * Anti-pattern: calling `WebServer.start` multiple times or after `WebServer.stop` without reinitialization.
 *
 * **Category:** Networking
 * @internal
 */
export default class WebServer extends EventRouter {
  /**
   * Singleton instance.
   *
   * **Category:** Networking
   */
  public static readonly instance: WebServer = new WebServer();

  private _server: http2.Http2SecureServer | undefined;
  private _assetCache = new Map<string, { size: number; etag: string }>();
  private _assetDirs: string[] = [];

  private constructor() {
    super();

    // Local assets first (higher priority)
    this._assetDirs.push(path.resolve('assets'));

    // Dev: also serve from assets library
    const libPath = AssetsLibrary.assetsLibraryPath;
    if (libPath) {
      this._assetDirs.push(libPath);
    }
  }

  /**
   * Starts the web server and begins serving assets.
   *
   * **Requires:** SSL cert/key must be available via `SSL_CERT` and `SSL_KEY`.
   *
   * **Side effects:** Binds the network port, starts listening, and emits `WebServerEvent.READY`.
   *
   * @see `WebServer.stop`
   *
   * **Category:** Networking
   */
  public start(): void {
    if (this._server) {
      return ErrorHandler.warning('WebServer.start(): already started');
    }

    this._server = http2.createSecureServer({ key: SSL_KEY, cert: SSL_CERT, allowHTTP1: true });
    this._server.on('request', this._onRequest); // Works for both HTTP/1.1 and HTTP/2 (via compat layer)
    this._server.on('upgrade', this._onUpgrade);
    this._server.on('error', this._onError);
    this._server.on('close', this._onStopped);
    this._server.listen(PORT, this._onStarted);

    console.info(`WebServer.start(): Server running on port ${PORT}`);
  }

  /**
   * Stops the web server if it is running.
   *
   * @returns True if the server was stopped, false if it was not running.
   *
   * **Requires:** `WebServer.start` must have been called successfully.
   *
   * **Side effects:** Closes the server and emits `WebServerEvent.STOPPED`.
   *
   * @see `WebServer.start`
   *
   * **Category:** Networking
   */
  public stop(): Promise<boolean> {
    if (!this._server) {
      ErrorHandler.warning('WebServer.stop(): not started');

      return Promise.resolve(false);
    }

    return new Promise((resolve, reject) => {
      this._server!.close(err => (err ? reject(err) : resolve(true)));
    });
  }

  private _onStarted = () => this.emitWithGlobal(WebServerEvent.READY, {});
  private _onStopped = () => this.emitWithGlobal(WebServerEvent.STOPPED, {});

  private _onError = (error: Error) => {
    ErrorHandler.error(`WebServer._onError(): ${error.message}`);
    this.emitWithGlobal(WebServerEvent.ERROR, { error });
  };

  private _onRequest = (req: http.IncomingMessage, res: http.ServerResponse) => {
    res.on('error', () => {}); // NOOP to prevent uncaught exceptions

    const reqPath = req.url || '/';
    const method = req.method || 'GET';
    const isHead = method === 'HEAD';
    const respond = (status: number, hdrs: Record<string, string | number> = {}) => {
      res.writeHead(status, { ...hdrs, ...CORS });
    };

    // CORS / Private Network Access preflight
    if (method === 'OPTIONS') {
      respond(204);
      res.end();

      return;
    }

    // Health check
    if (reqPath === '/') {
      respond(200, { 'content-type': 'application/json' });
      res.end(!isHead ? JSON.stringify({
        status: 'OK',
        version: SDK_VERSION,
        runtime: 'node',
        playerCount: PlayerManager.instance.playerCount,
        localNetworkAddresses: getLocalNetworkAddresses(),
      }) : undefined);

      return;
    }

    if (PERF_ENDPOINTS_ENABLED && reqPath === '/__perf' && method === 'GET') {
      respond(200, { 'content-type': 'application/json' });
      res.end(!isHead ? JSON.stringify({
        playerCount: PlayerManager.instance.playerCount,
        process: Telemetry.getProcessStats(),
        snapshot: PerformanceBaseline.snapshot(),
        version: SDK_VERSION,
      }) : undefined);

      return;
    }

    if (PERF_ENDPOINTS_ENABLED && reqPath === '/__perf/reset' && (method === 'POST' || method === 'DELETE')) {
      PerformanceBaseline.reset();
      respond(204);
      res.end();

      return;
    }

    // Validate path
    const urlPath = decodeURIComponent(reqPath.split('?')[0]);
    if (urlPath.includes('..')) {
      respond(400);
      res.end();

      return;
    }

    // Serve static file
    for (const dir of this._assetDirs) {
      const absoluteFilePath = path.join(dir, urlPath);

      // Prevent various path attacks
      if (!absoluteFilePath.startsWith(dir)) continue;

      // Dev sync from library
      const lib = AssetsLibrary.assetsLibraryPath;
      if (lib && absoluteFilePath.startsWith(lib) && !reqPath.includes('noSync')) {
        AssetsLibrary.instance.syncAsset(absoluteFilePath);
      }

      // Get or compute cached file metadata
      let cached = this._assetCache.get(absoluteFilePath);

      if (!cached) {
        try {
          const stat = fs.statSync(absoluteFilePath);
          if (!stat.isFile()) continue;

          cached = {
            size: stat.size,
            etag: `"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"`,
          };
          this._assetCache.set(absoluteFilePath, cached);
        } catch {
          continue;
        }
      }

      // Check if client has cached version (ETag match)
      if (req.headers['if-none-match'] === cached.etag) {
        respond(304);
        res.end();

        return;
      }

      const responseHeaders = {
        'content-type': MIME[path.extname(absoluteFilePath).toLowerCase()] || 'application/octet-stream',
        'content-length': cached.size,
        'etag': cached.etag,
        'cache-control': 'public, max-age=0, must-revalidate',
      };

      // HEAD request: send headers only
      if (isHead) {
        respond(200, responseHeaders);
        res.end();

        return;
      }

      // GET request: stream file
      respond(200, responseHeaders);

      const fileStream = fs.createReadStream(absoluteFilePath);

      // Destroy file stream if client disconnects mid-transfer
      res.on('close', () => fileStream.destroy());

      // Destroy response if file read fails
      fileStream.on('error', () => res.destroy());

      fileStream.pipe(res);

      return;
    }

    respond(404);
    res.end();
  };

  private _onUpgrade = (req: http.IncomingMessage, socket: RawSocket, head: Buffer) => {
    this.emitWithGlobal(WebServerEvent.UPGRADE, { req, socket, head });
  };
}
