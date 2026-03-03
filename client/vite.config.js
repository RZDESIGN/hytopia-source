import { copyFileSync, mkdirSync } from 'fs';
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

export default {
  server: {
    watch: {
      usePolling: true
    }
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