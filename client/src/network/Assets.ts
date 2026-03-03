import { AudioLoader, Cache, CubeTextureLoader, TextureLoader } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import Game from '../Game';

const TRANSCODER_PATH = '/basis/';

Cache.enabled = true;

const ErrorCache: Map<string, Promise<boolean>> = new Map();

export default class Assets {
  public static readonly audioLoader: AudioLoader = new AudioLoader();
  public static readonly cache = Cache;
  public static readonly textureLoader: TextureLoader = new TextureLoader();
  public static readonly cubeTextureLoader: CubeTextureLoader = new CubeTextureLoader();
  public static readonly ktx2Loader: KTX2Loader = new KTX2Loader().setTranscoderPath(TRANSCODER_PATH);
  public static readonly gltfLoader: GLTFLoader = new GLTFLoader().setKTX2Loader(Assets.ktx2Loader);

  public static getCdnBaseUrl(): string {
    return `https://${Game.instance.networkManager.serverHostname}`;
  }

  public static toAssetUri(assetUri: string, cacheBreak = false): string {
    if (assetUri.startsWith('https://')) {
      return assetUri;
    }

    return `${Assets.getCdnBaseUrl()}/${assetUri}${cacheBreak ? `?t=${Date.now()}` : ''}`; 
  }

  // The Game Server optimizes glTF files at startup and serves them using URLs
  // that follow a specific pattern. The URL structure is as follows:
  //
  // Example: If the unoptimized original glTF file URL is:
  // https://path/foo.gltf
  //
  // The optimized glTF file URL (always output as .glb as of sdk 0.10.47):
  // https://path/.optimized/foo/foo.glb
  //
  // The optimized glTF file without merging named nodes:
  // https://path/.optimized/foo/foo-named-nodes.glb
  //
  // The optimized glTF file (including named nodes merge) without animation:
  // https://path/.optimized/foo/foo-no-animations.glb
  //
  // Note: This naming convention may change, so this code should be updated
  // along with the Game Server specifications.
  //
  // The optimization process attempts to merge Nodes and Meshes whenever possible
  // to reduce draw calls and prevent the scene tree from becoming too large.
  // However, some Entity APIs provide functionality that processes using node names.
  // Merging all Nodes and Meshes may cause these features to malfunction.
  //
  // To address this issue, the Game Server also generates an optimized model file
  // that does not merge named Nodes and Meshes. Since this version is less optimized,
  // it should only be used when necessary.
  public static async getEffectiveGLTFlUri(uri: string, namedNodes?: boolean, noAnimations?: boolean): Promise<string> {
    const suffix = namedNodes ? '-named-nodes' : 
                   noAnimations ? '-no-animations' : '';
    
    // Check .optimized models in priority order.
    // We check for .glb version first which is preferred optimized version.
    // If it doesn't exist, such as for an old sdk, fallback to optimized .gltf version.
    const candidateUris = [
      uri.replace(/([^/]+)\.([^.]+)$/, `.optimized/$1/$1${suffix}.glb`), // Prefer target suffix type and .glb
      uri.replace(/([^/]+)\.([^.]+)$/, `.optimized/$1/$1${suffix}.$2`),  // Fallback to target suffix type and original extension
    ];

    // We need these fallbacks below such as if a SDK doesn't support a specific suffix optimization
    // or is missing it all together, we should fallback to the next most optimized model which
    // is the base .optimized model.
    if (suffix === '-no-animations') {
      candidateUris.push(uri.replace(/([^/]+)\.([^.]+)$/, `.optimized/$1/$1.glb`)); // Fallback to base model and .glb
      candidateUris.push(uri.replace(/([^/]+)\.([^.]+)$/, `.optimized/$1/$1.$2`)); // Fallback to base model and original extension
    }

    for (const candidateUri of candidateUris) {
      if (await Assets.urlExists(candidateUri)) {
        return candidateUri;
      }
    }

    // Return unoptimized uri if no optimized candidate exists.
    return uri;
  }

  public static async urlExists(url: string): Promise<boolean> {
    if (!ErrorCache.has(url)) {
      ErrorCache.set(url, new Promise(async (resolve, reject) => {
        try {
          // TODO: Is there a way to suppress the console error log?
          const res = await fetch(url, { method: 'head' });
          if (res.ok) {
            resolve(true);
          } else {
            // We check 403 as well, since the cosmetics CDN returns a 403 for non-existent files
            resolve(res.status !== 404 && res.status !== 403); 
          }
        } catch (e) {
          reject(e);
        }
      }));
    }
    return await ErrorCache.get(url)!;
  }
}