import { copyFileSync, mkdirSync } from 'fs';
import os from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * This plugin copies the basis transcoder required by ktx2 loader.
 * It must be served from the equivalent basis/ directory in the public folder.
 * File names must also maintain their original names.
 */
const copyBasisFilesPlugin = () => ({
  name: 'copy-basis-files',
  buildStart() {
    const basisDir = join(__dirname, 'public', 'basis');
    const sourceDir = join(__dirname, 'node_modules', 'three', 'examples', 'jsm', 'libs', 'basis');
    
    mkdirSync(basisDir, { recursive: true });
    
    ['basis_transcoder.js', 'basis_transcoder.wasm'].forEach(file => {
      copyFileSync(join(sourceDir, file), join(basisDir, file));
      console.log(`✓ Copied ${file} from Three.js`);
    });
  }
});

const isPrivateIPv4 = (ip) => {
  const octets = ip.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => Number.isNaN(octet) || octet < 0 || octet > 255)) {
    return false;
  }

  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
};

const getLocalNetworkIp = () => {
  const networkInterfaces = os.networkInterfaces();

  for (const iface of Object.values(networkInterfaces)) {
    for (const details of iface || []) {
      if (details.internal) continue;
      if (details.family !== 'IPv4') continue;
      if (isPrivateIPv4(details.address)) return details.address;
    }
  }

  return null;
};

const localIpEndpointPlugin = () => ({
  name: 'local-ip-endpoint',
  configureServer(server) {
    server.middlewares.use('/__hytopia/local-ip', (_req, res) => {
      const ip = getLocalNetworkIp();
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ip }));
    });
  },
});

const assetProxyTarget = process.env.VITE_ASSET_PROXY_TARGET;

export default {
  server: {
    watch: {
      usePolling: true
    },
    ...(assetProxyTarget && {
      proxy: {
        '/blocks': { target: assetProxyTarget, changeOrigin: true, secure: true },
        '/assets': { target: assetProxyTarget, changeOrigin: true, secure: true },
      },
    }),
  },
  define: {
    'import.meta.env.VITE_VERCEL_ENV': JSON.stringify(process.env.VERCEL_ENV),
    'import.meta.env.VITE_VERCEL_GIT_COMMIT_SHA': JSON.stringify(process.env.VERCEL_GIT_COMMIT_SHA),
  },
  build: {
    sourcemap: true
  },
  worker: {
    format: 'es'
  },
  plugins: [
    copyBasisFilesPlugin(),
    localIpEndpointPlugin(),
  ]
};