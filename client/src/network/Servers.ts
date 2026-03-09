// Minimum supported server version
const MINIMUM_SUPPORTED_SERVER_VERSION = '0.10.0';
const DEV_LOCAL_HOSTNAME = 'local.hytopiahosting.com:8080';
const SERVER_HEALTH_CHECK_TIMEOUT_MS = 8000;

// Compatible client URLs, ordered newest to oldest.
// First entry with version <= server version wins.
// 'LATEST' means the current client (play.hytopia.com) is compatible.
const CLIENT_COMPAT_VERSIONS: { version: string, url: string }[] = [
  { version: '0.15', url: 'LATEST' },
  { version: '0.0',  url: 'https://compat-0-14.play.hytopia.com/' }, // fallback for all lesser versions.
];

// Some poor mobile networks can drop TCP connections silently,
// this can cause no response for our fetch, so we use fetch with a timeout.
const fetchWithTimeout = async (url: string, init: RequestInit, timeoutMs: number): Promise<Response> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, Object.assign({}, init, { signal: controller.signal }));
  } finally {
    clearTimeout(timeoutId);
  }
};

const getModalHelpers = async (): Promise<{
  modalAlert: typeof import('../ui/Modal').modalAlert;
  modalPrompt: typeof import('../ui/Modal').modalPrompt;
}> => import('../ui/Modal');

export default class Servers {
  public static async getServerDetails(): Promise<{ hostname: string, lobbyId: string, version: string }> {
    let hostname = '';
    let lobbyId = '';
    let version = '';

    do {
      const urlParams = new URLSearchParams(window.location.search);
      hostname = urlParams.get('join') || '';
      lobbyId = urlParams.get('lobbyId') || '';

      // Prompt for server hostname if not already present in join query parameter
      if (!hostname) {
        const { modalPrompt } = await getModalHelpers();
        hostname = await modalPrompt(
          'Connect to a HYTOPIA server (leave blank for local dev).\nRecommended: use a Chromium browser (Chrome, Brave, Edge).',
          '',
          {
            showLocalMobileQr: true,
            localServerHostnames: [ DEV_LOCAL_HOSTNAME ],
            localServerPort: 8080,
            localHealthCheckTimeoutMs: SERVER_HEALTH_CHECK_TIMEOUT_MS,
          }
        ) || DEV_LOCAL_HOSTNAME;
        hostname = hostname.replace(/^(wss?|https?):\/\//, '');
      }

      // Validate server connection
      const isLocal = hostname === DEV_LOCAL_HOSTNAME;

      try {
        const candidates = hostname === DEV_LOCAL_HOSTNAME
          ? [ DEV_LOCAL_HOSTNAME ]
          : [ hostname ];

        let response: Response | undefined;

        for (const candidate of candidates) {
          try {
            response = await fetchWithTimeout(`https://${candidate}`, {
              targetAddressSpace: isLocal ? 'loopback' : undefined,
            } as RequestInit, SERVER_HEALTH_CHECK_TIMEOUT_MS);
          } catch { /* ignore network errors (including timeout); try next candidate */ }

          if (response?.ok) {
            hostname = candidate;
            break;
          }
        }

        if (!response?.ok) {
          throw new Error(`Could not connect to server: ${hostname}`);
        }

        const serverDetails = await response.json();
        
        version = serverDetails.version;

        await this._validateServerVersionCompat(version, hostname);
      } catch {
        console.error('Could not connect to server', hostname);
        hostname = '';
        
        const url = new URL(window.location.href);
        if (url.searchParams.has('join')) {
          url.searchParams.delete('join');
          window.history.replaceState({}, '', url.toString());
        }
      }
      
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (!hostname);

    // Append hostname to URL if not already present
    if (!window.location.search.includes('join=')) {      
      let newUrl = `${window.location.pathname}?join=${hostname}`;
      newUrl += window.location.search.includes('debug') ? '&debug' : '';      
      newUrl += window.location.hash;
      
      window.history.pushState({}, '', newUrl);
    }

    return { hostname, lobbyId, version };
  }

  public static async isCurrentServerHealthy(): Promise<boolean> {
    const hostname = (new URLSearchParams(window.location.search)).get('join') || '';

    try {
      const response = await fetchWithTimeout(`https://${hostname}`, { method: 'HEAD' }, SERVER_HEALTH_CHECK_TIMEOUT_MS);

      return response.ok;
    } catch {
      return false;
    }
  }

  public static isCurrentServerProduction(): boolean {
    const hostname = (new URLSearchParams(window.location.search)).get('join') || '';
    return hostname.includes('hytopiahosting.com');
  }

  private static async _validateServerVersionCompat(version: string, hostname: string): Promise<void> {
    if (version.includes('DEV')) {
      return; // SDK dev servers are ignored, ran from the internal hytopia team `server` repo.
    }

    version = version || '0.0.0'; // needs update, legacy servers don't have a version field.

    const [majorServer, minorServer, patchServer] = version.split('.').map(Number);
    const [majorMin, minorMin, patchMin] = MINIMUM_SUPPORTED_SERVER_VERSION.split('.').map(Number);

    if (majorServer < majorMin || 
      (majorServer === majorMin && minorServer < minorMin) ||
      (majorServer === majorMin && minorServer === minorMin && patchServer < patchMin)
    ) {
      const { modalAlert } = await getModalHelpers();
      await modalAlert(
        'This HYTOPIA game is out of date.\n' +
        `It is running SDK version ${version}, which is not supported.\n` +
        `The minimum supported sdk version is >= ${MINIMUM_SUPPORTED_SERVER_VERSION}\n` +
        'You should update your game to the latest sdk version by running the following in your project directory: bun update hytopia\n' +
        'If you are not the developer of this game, please contact the developer to update the sdk version of their game.'
      );

      return;
    }

    // Redirect to compatible client if server is running an older SDK version.
    for (const compat of CLIENT_COMPAT_VERSIONS) {
      const [majorCompat, minorCompat] = compat.version.split('.').map(Number);

      if (majorServer > majorCompat || (majorServer === majorCompat && minorServer >= minorCompat)) {
        if (compat.url !== 'LATEST') {
          const redirectParams = new URLSearchParams(window.location.search);
          redirectParams.set('join', hostname); // handles if user typed url via modal prompt
          window.location.href = `${compat.url}?${redirectParams.toString()}`;
          await new Promise(() => {}); // halt execution during redirect
        }

        break;
      }
    }
  }
}
