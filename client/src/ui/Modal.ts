/**
 * Simple modal system to replace browser alert() and prompt() calls.
 * Returns Promises to handle async user interactions properly.
 */

import QRCode from 'qrcode';

let container: HTMLDivElement | null = null;
const DEFAULT_LOCAL_SERVER_HOSTNAMES = [ 'local.hytopiahosting.com:8080' ];
const DEFAULT_LOCAL_SERVER_PORT = 8080;
const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 1500;

type ModalPromptOptions = {
  showLocalMobileQr?: boolean;
  localServerHostnames?: string[];
  localServerPort?: number;
  localHealthCheckTimeoutMs?: number;
}

type LocalServerDiscoveryResult = {
  joinTarget?: string;
  connectTarget?: string;
  certError?: boolean;
}

function isPrivateIPv4(ip: string): boolean {
  const octets = ip.split('.').map(Number);

  if (octets.length !== 4 || octets.some((octet) => Number.isNaN(octet) || octet < 0 || octet > 255)) {
    return false;
  }

  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

function extractIPv4FromCandidate(candidate: string): string | null {
  const match = candidate.match(/(\d{1,3}(?:\.\d{1,3}){3})/);

  if (!match?.[1]) {
    return null;
  }

  return isPrivateIPv4(match[1]) ? match[1] : null;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function isLikelyLocalHostname(hostname: string): boolean {
  return hostname.endsWith('.local');
}

function withPort(hostname: string, port: number): string {
  if (hostname.includes(':')) {
    return hostname;
  }

  return `${hostname}:${port}`;
}

function privateIpToDnsHostname(ip: string): string {
  return `${ip.replace(/\./g, '-')}.dns-is-boring-we-do-ip-addresses.hytopiahosting.com`;
}

function toCertCompatibleJoinTarget(joinTarget: string, defaultPort: number): string {
  const [hostPart, portPart] = joinTarget.split(':');

  if (!hostPart) {
    return joinTarget;
  }

  const port = Number(portPart) || defaultPort;

  if (isPrivateIPv4(hostPart)) {
    return `${privateIpToDnsHostname(hostPart)}:${port}`;
  }

  return joinTarget;
}

function parseManualJoinTarget(value: string, defaultPort: number): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (isPrivateIPv4(trimmed)) {
    return `${trimmed}:${defaultPort}`;
  }

  if (/^[a-zA-Z0-9.-]+:\d+$/.test(trimmed)) {
    return trimmed;
  }

  if (/^[a-zA-Z0-9.-]+$/.test(trimmed)) {
    return `${trimmed}:${defaultPort}`;
  }

  return null;
}

async function discoverLocalIPv4(timeoutMs = 2500): Promise<string | null> {
  if (isPrivateIPv4(window.location.hostname)) {
    return window.location.hostname;
  }

  if (typeof RTCPeerConnection === 'undefined') {
    return null;
  }

  return new Promise((resolve) => {
    let resolved = false;
    const discovered = new Set<string>();
    const peerConnection = new RTCPeerConnection({ iceServers: [] });

    const finish = (value: string | null): void => {
      if (resolved) {
        return;
      }

      resolved = true;
      clearTimeout(timeoutId);
      peerConnection.close();
      resolve(value);
    };

    const timeoutId = setTimeout(() => {
      finish(discovered.values().next().value ?? null);
    }, timeoutMs);

    peerConnection.onicecandidate = (event) => {
      if (!event.candidate) {
        finish(discovered.values().next().value ?? null);
        return;
      }

      const ip = extractIPv4FromCandidate(event.candidate.candidate);

      if (ip) {
        discovered.add(ip);
        finish(ip);
      }
    };

    peerConnection.createDataChannel('hytopia-local-ip');

    peerConnection.createOffer()
      .then((offer) => peerConnection.setLocalDescription(offer))
      .catch(() => finish(null));
  });
}

async function discoverLocalIPv4FromDevServer(): Promise<string | null> {
  try {
    const response = await fetch('/__hytopia/local-ip', { cache: 'no-store' });
    if (!response.ok) {
      return null;
    }

    const payload = await response.json() as { ip?: unknown };
    return typeof payload.ip === 'string' && isPrivateIPv4(payload.ip) ? payload.ip : null;
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractJoinTargetFromHealthPayload(payload: unknown, port: number): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const candidateAddresses = (payload as { localNetworkAddresses?: unknown }).localNetworkAddresses;
  if (!Array.isArray(candidateAddresses)) {
    return undefined;
  }

  for (const candidate of candidateAddresses) {
    if (typeof candidate === 'string' && isPrivateIPv4(candidate)) {
      return `${candidate}:${port}`;
    }
  }

  return undefined;
}

async function discoverLocalServerJoinTarget(hostnames: string[], timeoutMs: number, port: number): Promise<LocalServerDiscoveryResult> {
  let connectTarget: string | undefined;
  let certError = false;

  for (const hostname of hostnames) {
    try {
      const response = await fetchWithTimeout(`https://${hostname}`, {
        targetAddressSpace: 'loopback',
      } as RequestInit, timeoutMs);

      if (response.ok) {
        connectTarget = hostname;

        const payload = await response.json().catch(() => null);
        const joinTarget = extractJoinTargetFromHealthPayload(payload, port);

        if (joinTarget) {
          return { joinTarget, connectTarget };
        }
      }
    } catch (error) {
      const errorMessage = String(error);

      if (errorMessage.includes('ERR_CERT') || errorMessage.includes('certificate')) {
        certError = true;
      }
      // Try next local hostname candidate.
    }
  }

  return { connectTarget, certError };
}

async function resolveLocalJoinTarget(localPort: number): Promise<string | null> {
  if (isPrivateIPv4(window.location.hostname)) {
    return `${window.location.hostname}:${localPort}`;
  }

  if (isLikelyLocalHostname(window.location.hostname)) {
    return withPort(window.location.hostname, localPort);
  }

  const localIpFromDevServer = await discoverLocalIPv4FromDevServer();
  if (localIpFromDevServer) {
    return `${localIpFromDevServer}:${localPort}`;
  }

  const localIp = await discoverLocalIPv4();
  if (localIp) {
    return `${localIp}:${localPort}`;
  }

  return null;
}

function createMobileJoinUrl(joinTarget: string, localPort: number): string {
  const url = new URL(window.location.href);
  if (isLoopbackHostname(url.hostname)) {
    // Mobile cannot open localhost pages on your dev machine.
    url.protocol = 'https:';
    url.hostname = 'hytopia.com';
    url.port = '';
    url.pathname = '/play/';
  }

  url.searchParams.set('join', toCertCompatibleJoinTarget(joinTarget, localPort));

  return url.toString();
}

function getContainer(): HTMLDivElement {
  if (!container || !container.isConnected) {
    container = document.createElement('div');
    container.className = 'hytopia-modal-container';
    document.body.appendChild(container);
  }
  return container;
}

export function modalAlert(message: string): Promise<void> {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'hytopia-modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'hytopia-modal';

    const msg = document.createElement('div');
    msg.className = 'hytopia-modal-message';
    msg.textContent = message;

    const buttons = document.createElement('div');
    buttons.className = 'hytopia-modal-buttons';

    const ok = document.createElement('button');
    ok.className = 'hytopia-modal-button hytopia-modal-button-ok';
    ok.textContent = 'OK';

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === 'Escape') close();
    };

    const close = () => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve();
    };

    ok.onclick = close;
    document.addEventListener('keydown', onKey);

    buttons.appendChild(ok);
    modal.append(msg, buttons);
    overlay.appendChild(modal);
    getContainer().appendChild(overlay);
    ok.focus();
  });
}

export function modalPrompt(message: string, defaultValue = '', options: ModalPromptOptions = {}): Promise<string | null> {
  if (options.showLocalMobileQr) {
    return new Promise(resolve => {
      let isClosed = false;
      let localConnectTarget: string | undefined;
      let localJoinTarget: string | undefined;

      const localHostnames = options.localServerHostnames || DEFAULT_LOCAL_SERVER_HOSTNAMES;
      const localPort = options.localServerPort || DEFAULT_LOCAL_SERVER_PORT;
      const timeoutMs = options.localHealthCheckTimeoutMs || DEFAULT_HEALTH_CHECK_TIMEOUT_MS;

      const overlay = document.createElement('div');
      overlay.className = 'hytopia-modal-overlay';

      // --- 1. Search State ---
      const searchContainer = document.createElement('div');
      searchContainer.className = 'hytopia-local-search-container';
      
      const searchSpinner = document.createElement('div');
      searchSpinner.className = 'hytopia-local-gradient-spinner';

      const searchStatus = document.createElement('div');
      searchStatus.className = 'hytopia-local-search-status';
      searchStatus.textContent = 'Looking for a local HYTOPIA server...';

      searchContainer.append(searchSpinner, searchStatus);

      // --- 2. Found State (Modal) ---
      const modal = document.createElement('div');
      modal.className = 'hytopia-modal hytopia-modal-local-discovery';
      modal.style.display = 'none'; // Hidden initially

      const foundView = document.createElement('div');
      foundView.className = 'hytopia-local-found-view';

      const foundLayout = document.createElement('div');
      foundLayout.className = 'hytopia-local-found-layout';

      const foundHeader = document.createElement('div');
      foundHeader.className = 'hytopia-local-found-header-left';
      foundHeader.innerHTML = '<div class="hytopia-local-found-title">SERVER<br>FOUND</div><div class="hytopia-local-lets-play">LET\'S PLAY</div>';

      const cardsGrid = document.createElement('div');
      cardsGrid.className = 'hytopia-local-cards-grid';

      const deviceCol = document.createElement('div');
      deviceCol.className = 'hytopia-local-card-col';
      const deviceTitle = document.createElement('div');
      deviceTitle.className = 'hytopia-local-card-title';
      deviceTitle.textContent = 'This Device';
      const deviceCard = document.createElement('div');
      deviceCard.className = 'hytopia-local-card';
      const playButton = document.createElement('button');
      playButton.className = 'hytopia-local-play-button';
      playButton.textContent = 'Play';
      deviceCard.append(playButton);
      deviceCol.append(deviceTitle, deviceCard);

      const mobileCol = document.createElement('div');
      mobileCol.className = 'hytopia-local-card-col';
      const mobileTitle = document.createElement('div');
      mobileTitle.className = 'hytopia-local-card-title';
      mobileTitle.textContent = 'Mobile / Tablet';
      const mobileCard = document.createElement('div');
      mobileCard.className = 'hytopia-local-card';
      const qrCanvas = document.createElement('canvas');
      qrCanvas.className = 'hytopia-local-qr-canvas';
      qrCanvas.style.display = 'none';
      mobileCard.append(qrCanvas);
      mobileCol.append(mobileTitle, mobileCard);

      cardsGrid.append(deviceCol, mobileCol);
      foundLayout.append(foundHeader, cardsGrid);
      foundView.append(foundLayout);

      // --- 3. Manual View ---
      const manualView = document.createElement('div');
      manualView.className = 'hytopia-local-manual-view';
      manualView.style.display = 'none';

      const manualHeader = document.createElement('div');
      manualHeader.className = 'hytopia-local-found-header';
      manualHeader.style.marginBottom = '16px';
      manualHeader.textContent = 'Connect to Address';

      const manualRow = document.createElement('div');
      manualRow.className = 'hytopia-local-manual-row';
      const manualInput = document.createElement('input');
      manualInput.className = 'hytopia-modal-input hytopia-local-manual-input';
      manualInput.placeholder = 'LAN IP or hostname (e.g. 192.168.1.42)';
      const manualConnectButton = document.createElement('button');
      manualConnectButton.type = 'button';
      manualConnectButton.className = 'hytopia-local-play-button';
      manualConnectButton.style.width = 'auto';
      manualConnectButton.style.height = 'auto';
      manualConnectButton.style.padding = '10px 16px';
      manualConnectButton.textContent = 'Connect';

      manualRow.append(manualInput, manualConnectButton);
      manualView.append(manualHeader, manualRow);

      modal.append(foundView, manualView);

      const cornerButton = document.createElement('button');
      cornerButton.className = 'hytopia-local-corner-button';
      cornerButton.textContent = 'Other address';
      cornerButton.style.display = 'block';

      const logo = document.createElement('img');
      logo.className = 'hytopia-local-corner-logo';
      logo.src = '/src/img/logo-square.svg';

      overlay.append(logo, searchContainer, modal, cornerButton);
      getContainer().appendChild(overlay);

      const close = (value: string | null) => {
        isClosed = true;
        document.removeEventListener('keydown', onKey);
        overlay.remove();
        resolve(value);
      };

      const renderQr = async (joinTarget: string): Promise<void> => {
        const mobileJoinUrl = createMobileJoinUrl(joinTarget, localPort);

        await QRCode.toCanvas(qrCanvas, mobileJoinUrl, {
          width: 140,
          margin: 1,
          color: {
            dark: '#ffffff',
            light: '#00000000', // transparent
          }
        });
        if (isClosed) return;
        qrCanvas.style.display = 'block';
      };

      playButton.onclick = () => {
        if (localConnectTarget) close(localConnectTarget);
      };

      cornerButton.onclick = () => {
        if (manualView.style.display === 'none') {
          foundView.style.display = 'none';
          manualView.style.display = 'block';
          cornerButton.innerHTML = '&#8592; Back';
          manualInput.focus();
        } else {
          manualView.style.display = 'none';
          foundView.style.display = 'block';
          cornerButton.textContent = 'Other address';
        }
      };

      manualConnectButton.onclick = () => {
        const manualJoinTarget = parseManualJoinTarget(manualInput.value, localPort);
        if (!manualJoinTarget) {
          manualInput.focus();
          return;
        }
        close(manualJoinTarget);
      };

      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          if (manualView.style.display !== 'none') {
            cornerButton.click();
          } else {
            close(null);
          }
        } else if (e.key === 'Enter' && manualView.style.display !== 'none' && document.activeElement === manualInput) {
          manualConnectButton.click();
        }
      };
      document.addEventListener('keydown', onKey);

      void (async () => {
        while (!isClosed) {
          const discovery = await discoverLocalServerJoinTarget(localHostnames, timeoutMs, localPort);
          localConnectTarget = discovery.connectTarget;
          localJoinTarget = discovery.joinTarget;

          if (!localConnectTarget) {
            searchStatus.textContent = Boolean(discovery.certError)
              ? 'Local cert issue detected. Open https://local.hytopiahosting.com:8080 once and allow it, then retry.'
              : 'Looking for a local HYTOPIA server...';
              
            if (manualView.style.display === 'none') {
              searchContainer.style.display = 'flex';
              modal.style.display = 'none';
              foundView.style.display = 'none';
            }
          } else {
            if (manualView.style.display === 'none' && searchContainer.style.display !== 'none') {
              searchContainer.style.display = 'none';
              modal.style.display = 'block';
              modal.style.animation = 'hytopia-fade-in-up 0.5s ease-out forwards';
              foundView.style.display = 'block';
            }

            if (!localJoinTarget) {
              localJoinTarget = await resolveLocalJoinTarget(localPort) || undefined;
            }

            if (localJoinTarget) {
              try {
                await renderQr(localJoinTarget);
              } catch {
                // Ignore, QR won't show
              }
            }
          }

          await sleep(2000);
        }
      })();
    });
  }

  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'hytopia-modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'hytopia-modal';

    const msg = document.createElement('div');
    msg.className = 'hytopia-modal-message';
    msg.textContent = message;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'hytopia-modal-input';
    input.value = defaultValue;

    const buttons = document.createElement('div');
    buttons.className = 'hytopia-modal-buttons';

    const cancel = document.createElement('button');
    cancel.className = 'hytopia-modal-button hytopia-modal-button-cancel';
    cancel.textContent = 'Cancel';

    const ok = document.createElement('button');
    ok.className = 'hytopia-modal-button hytopia-modal-button-ok';
    ok.textContent = 'OK';

    const close = (value: string | null) => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(value);
    };

    ok.onclick = () => close(input.value);
    cancel.onclick = () => close(null);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') close(input.value);
      else if (e.key === 'Escape') close(null);
    };
    document.addEventListener('keydown', onKey);

    buttons.append(cancel, ok);
    modal.append(msg, input);
    modal.appendChild(buttons);
    overlay.appendChild(modal);
    getContainer().appendChild(overlay);
    input.focus();
    input.select();
  });
}
