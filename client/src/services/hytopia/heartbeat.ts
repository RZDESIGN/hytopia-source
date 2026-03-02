// @mchmatt WIP: should probably be integrated in the game itself instead (and reworked to use WS instead of polling)
/**
 * Matchmaking relies on these heartbeats to be able to drop players out of
 * lobbies if their internet goes down (and etc), without this code all servers
 * will shutdown after roughly 2 minutes of being started
 */

const HEARTBEAT_RETRY_DELAY_MS = 3000;
const HEARTBEAT_INTERVAL_MS = 60000;

type HeartbeatResponse = {
  error?: {
    code: string;
  };
};

async function sendLobbyHeartbeat(gatewayEndpoint: string, authToken: string, lobbyId: string): Promise<HeartbeatResponse> {
  try {
    const response = await fetch(`${gatewayEndpoint}/play/matchmaking/lobbies/heartbeat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ authToken, lobbyId }),
    });

    if (!response.ok) {
      return { error: { code: `http_${response.status}` } };
    }

    return await response.json();
  } catch {
    return { error: { code: 'networkError' } };
  }
}

function start() {
  console.log('Starting HYTOPIA heartbeat');

  const params = new URLSearchParams(window.location.search);
  const authToken = params.get('sessionToken');
  const lobbyId = params.get('lobbyId');
  const providedGatewayEndpoint = params.get('gatewayEndpoint');
  const gatewayEndpoint = providedGatewayEndpoint ? decodeURIComponent(providedGatewayEndpoint) : 'https://prod.mvp.hytopia.com';

  if (!authToken) {
    console.warn(`Couldn't find HYTOPIA auth token in query params - you are likely connected to a dev server, in which case you can ignore this.`);
    return;
  }

  if (!lobbyId) {
    console.warn('Found HYTOPIA auth token, but no lobby. Weird.');
    return;
  }

  const heartbeatPoll = async () => {
    while (true) {
      const response = await sendLobbyHeartbeat(gatewayEndpoint, authToken, lobbyId);

      if (!response.error) {
        await new Promise(resolve => setTimeout(resolve, HEARTBEAT_INTERVAL_MS));
        continue;
      }

      switch (response.error.code) {
        case 'invalidToken':
          console.warn('HYTOPIA auth token seems to have been invalidated, stopping heartbeat loop');
          return;

        case 'notInLobby':
          console.warn('Not connected to lobby anymore, stopping heartbeat loop');
          return;

        default:
          console.warn('Failure sending heartbeat, retrying in 3s. Error code:', response.error.code);
          await new Promise(resolve => setTimeout(resolve, HEARTBEAT_RETRY_DELAY_MS));
      }
    }
  };

  heartbeatPoll();
}

start();
