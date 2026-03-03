import { copyFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadEnv } from 'vite';

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

export default ({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const assetProxyTarget = env.VITE_ASSET_PROXY_TARGET || process.env.VITE_ASSET_PROXY_TARGET;

  let proxySecure = true;
  if (assetProxyTarget) {
    try {
      const parsedTarget = new URL(assetProxyTarget);
      proxySecure = parsedTarget.hostname !== 'localhost' && parsedTarget.hostname !== '127.0.0.1';
    } catch {
      proxySecure = true;
    }
  }

  return {
    server: {
      watch: {
        usePolling: true
      },
      ...(assetProxyTarget && {
        proxy: {
          '/blocks': { target: assetProxyTarget, changeOrigin: true, secure: proxySecure },
          '/assets': { target: assetProxyTarget, changeOrigin: true, secure: proxySecure },
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
    ]
  };
};