import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execa } from 'execa';
import { glob } from 'glob';
import { Jimp } from 'jimp';
import AssetsLibrary from '@/assets/AssetsLibrary';
import ErrorHandler from '@/errors/ErrorHandler';
import type { Bitmap } from '@jimp/types';

/** @internal */
const BLOCK_TEXTURE_REGISTRY_CONFIG = {
  ATLAS_DIR: '.atlas',
  ATLAS_PNG_FILE: 'atlas.png',
  ATLAS_KTX2_FILE: 'atlas.ktx2',
  ATLAS_MANIFEST_FILE: 'atlas.json',
  TEXTURE_SIZE: 24,
  TEXTURE_PADDING: 20,
  ALPHA_TEST_THRESHOLD: 0.05,
  DATA_SCHEMA_VERSION: 1,
  DIRECTORIES: [
    AssetsLibrary.assetsLibraryPath && path.join(AssetsLibrary.assetsLibraryPath, 'blocks'),
    path.resolve(process.cwd(), 'assets', 'blocks'),
  ].filter(Boolean) as string[],
} as const;

/**
 * Block texture metadata including UVs and rendering hints.
 *
 * **Category:** Textures
 * @public
 */
export type BlockTextureMetadata = {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  averageRGB: [number, number, number];
  isTransparent: boolean;
  needsAlphaTest: boolean;
  transparencyRatio: number;
}

/** @internal */
type BlockAtlasManifest = {
  version: number;
  textureSize: number;
  padding: number;
  atlasWidth: number;
  atlasHeight: number;
  textures: Record<string, BlockTextureMetadata>;
  sourceHash: string;
}

/** @internal */
type BlockTextureAnalysis = {
  averageRGB: [number, number, number];
  isTransparent: boolean;
  needsAlphaTest: boolean;
  transparencyRatio: number;
}

/**
 * Manages block textures and block texture atlas generation of the game.
 *
 * When to use: querying texture atlas UVs and transparency hints for blocks.
 * Do NOT use for: runtime texture modifications; regenerate atlas offline in dev.
 *
 * @remarks
 * The BlockTextureRegistry is created internally as a global
 * singleton accessible via `BlockTextureRegistry.instance`.
 * The atlas is preloaded during server startup and cached in memory.
 *
 * Pattern: call `BlockTextureRegistry.hasBlockTexture` before lookup to avoid warnings.
 * Anti-pattern: assuming missing textures are silently ignored.
 *
 * @example
 * ```typescript
 * import { BlockTextureRegistry } from 'hytopia';
 *
 * const blockTextureRegistry = BlockTextureRegistry.instance;
 * const metadata = blockTextureRegistry.getBlockTextureMetadata('blocks/stone.png');
 * ```
 *
 * **Category:** Textures
 * @public
 */
export default class BlockTextureRegistry {
  /**
   * The global BlockTextureRegistry instance as a singleton.
   *
   * **Category:** Textures
   */
  public static readonly instance: BlockTextureRegistry = new BlockTextureRegistry();

  /**
   * Whether to generate the atlas if needed.
   *
   * Defaults to `true` in development, `false` in production.
   *
   * **Category:** Textures
   */
  public generate: boolean = process.env.NODE_ENV !== 'production';

  /** @internal */
  private _textureUriMetadata: Map<string, BlockTextureMetadata> = new Map();

  /** @internal */
  private constructor() { }

  /**
   * Checks if a block texture is registered in the atlas.
   *
   * @param textureUri - The URI of the texture (e.g., 'blocks/stone.png' or 'blocks/grass' for cubemaps).
   * @returns Whether the texture is registered.
   *
   * **Requires:** Atlas must be preloaded (server startup).
   *
   * **Category:** Textures
   */
  public hasBlockTexture(textureUri: string): boolean {
    return this._textureUriMetadata.has(textureUri) || [ '+x', '-x', '+y', '-y', '+z', '-z' ].every(face => 
      this._textureUriMetadata.has(`${textureUri}/${face}.png`),
    );
  }

  /**
   * Retrieves metadata for a block texture. Returns array for cubemaps (6 faces) or standard textures (1 face).
   *
   * @param textureUri - The URI of the texture (e.g., 'blocks/stone.png' or 'blocks/grass').
   * @returns Array of texture metadata, or undefined if not found.
   *
   * **Requires:** Atlas must be preloaded (server startup).
   *
   * **Category:** Textures
   */
  public getBlockTextureMetadata(textureUri: string): BlockTextureMetadata[] | undefined {
    // Check for standard texture
    const standard = this._textureUriMetadata.get(textureUri);
    if (standard) return [ standard ];

    // Check for cubemap (all 6 faces)
    const cubemap = [ '+x', '-x', '+y', '-y', '+z', '-z' ]
      .map(face => this._textureUriMetadata.get(`${textureUri}/${face}.png`))
      .filter(Boolean) as BlockTextureMetadata[];

    return cubemap.length === 6 ? cubemap : undefined;
  }

  /** @internal */
  public async preloadAtlas(): Promise<void> {
    const absoluteTexturePaths = await this._getAbsoluteTexturePaths();
    const outputDir = path.resolve(process.cwd(), 'assets/blocks', BLOCK_TEXTURE_REGISTRY_CONFIG.ATLAS_DIR);
    
    // Try to load cached atlas
    if (this._loadCachedAtlasManifest(absoluteTexturePaths, outputDir)) {
      return console.info(`BlockTextureRegistry.preloadAtlas(): Using cached atlas for ${absoluteTexturePaths.length} block textures`);
    }
    
    // In production, cached atlas is required
    if (!this.generate) {
      ErrorHandler.fatalError('BlockTextureRegistry.preloadAtlas(): No cached atlas found in production. Run development server to generate atlas.');
    }
    
    // Generate new atlas in development
    console.info(`BlockTextureRegistry.preloadAtlas(): Generating atlas for ${absoluteTexturePaths.length} block textures...`);

    const textures = await Promise.all(
      absoluteTexturePaths.map(async absoluteTexturePath => {
        const image = await Jimp.read(absoluteTexturePath);
        const textureUri = this._absoluteTexturePathToTextureUri(absoluteTexturePath);

        if (image.width !== BLOCK_TEXTURE_REGISTRY_CONFIG.TEXTURE_SIZE || image.height !== BLOCK_TEXTURE_REGISTRY_CONFIG.TEXTURE_SIZE) {
          image.resize({ w: BLOCK_TEXTURE_REGISTRY_CONFIG.TEXTURE_SIZE, h: BLOCK_TEXTURE_REGISTRY_CONFIG.TEXTURE_SIZE });
        }

        return { textureUri, image, metadata: this._analyzeTexture(image.bitmap) };
      }),
    );

    // Generate atlas with proper sized grid layout for ideal UVs and GPU friendly dimensions.
    const cellSize = BLOCK_TEXTURE_REGISTRY_CONFIG.TEXTURE_SIZE + BLOCK_TEXTURE_REGISTRY_CONFIG.TEXTURE_PADDING * 2;
    const { cols, rows } = this._calculateGridLayout(textures.length);
    const atlasWidth = cols * cellSize;
    const atlasHeight = rows * cellSize;

    const atlas = new Jimp({ width: atlasWidth, height: atlasHeight, color: 0x00000000 });

    for (let i = 0; i < textures.length; i++) {
      const { textureUri, image, metadata } = textures[i];
      const cellX = (i % cols) * cellSize;
      const cellY = Math.floor(i / cols) * cellSize;
      
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const paddedTexture = this._createPaddedTexture(image);
      atlas.composite(paddedTexture, cellX, cellY);

      // UVs point to the actual texture area (center, excluding padding)
      const textureX = cellX + BLOCK_TEXTURE_REGISTRY_CONFIG.TEXTURE_PADDING;
      const textureY = cellY + BLOCK_TEXTURE_REGISTRY_CONFIG.TEXTURE_PADDING;

      this._textureUriMetadata.set(textureUri, {
        u0: textureX / atlasWidth,
        v0: textureY / atlasHeight,
        u1: (textureX + BLOCK_TEXTURE_REGISTRY_CONFIG.TEXTURE_SIZE) / atlasWidth,
        v1: (textureY + BLOCK_TEXTURE_REGISTRY_CONFIG.TEXTURE_SIZE) / atlasHeight,
        ...metadata,
      });
    }

    fs.mkdirSync(outputDir, { recursive: true });

    const pngPath = path.join(outputDir, BLOCK_TEXTURE_REGISTRY_CONFIG.ATLAS_PNG_FILE);
    const ktx2Path = path.join(outputDir, BLOCK_TEXTURE_REGISTRY_CONFIG.ATLAS_KTX2_FILE);

    // Write the PNG atlas
    await atlas.write(pngPath as `${string}.${string}`);

    // Generate the KTX2 atlas from the PNG atlas
    try {
      await execa('toktx', [
        '--t2', 
        '--encode', 'uastc', 
        '--uastc_quality', '4',
        '--zcmp', '5',
        '--assign_oetf', 'srgb',
        '--genmipmap',
        ktx2Path, 
        pngPath,
      ]);
    } catch (error) {
      console.error(error);
      ErrorHandler.fatalError('BlockTextureRegistry.preloadAtlas(): Error generating KTX2 atlas from PNG atlas. You MUST have the latest KTX software installed from here: https://github.com/KhronosGroup/KTX-Software/releases');
    }

    // Write the atlas manifest file
    fs.writeFileSync(
      path.join(outputDir, BLOCK_TEXTURE_REGISTRY_CONFIG.ATLAS_MANIFEST_FILE),
      JSON.stringify({
        version: BLOCK_TEXTURE_REGISTRY_CONFIG.DATA_SCHEMA_VERSION,
        textureSize: BLOCK_TEXTURE_REGISTRY_CONFIG.TEXTURE_SIZE,
        padding: BLOCK_TEXTURE_REGISTRY_CONFIG.TEXTURE_PADDING,
        atlasWidth,
        atlasHeight,
        textures: Object.fromEntries(this._textureUriMetadata),
        sourceHash: this._calculateSourceHash(absoluteTexturePaths),
      }, null, 2),
    );

    console.info(`BlockTextureRegistry.preloadAtlas(): Successfully created block texture atlas (${atlasWidth}x${atlasHeight})`);
  }

  /** @internal */
  private _loadCachedAtlasManifest(absoluteTexturePaths: string[], outputDir: string): boolean {
    const manifestPath = path.join(outputDir, BLOCK_TEXTURE_REGISTRY_CONFIG.ATLAS_MANIFEST_FILE);
    const pngPath = path.join(outputDir, BLOCK_TEXTURE_REGISTRY_CONFIG.ATLAS_PNG_FILE);
    const ktx2Path = path.join(outputDir, BLOCK_TEXTURE_REGISTRY_CONFIG.ATLAS_KTX2_FILE);

    if (!fs.existsSync(manifestPath) || !fs.existsSync(pngPath) || !fs.existsSync(ktx2Path)) return false;

    try {
      const raw = fs.readFileSync(manifestPath, 'utf8');
      const manifest = JSON.parse(raw) as BlockAtlasManifest;

      if (manifest?.version !== BLOCK_TEXTURE_REGISTRY_CONFIG.DATA_SCHEMA_VERSION) return false;
      
      // In development, validate atlas is up to date
      if (this.generate) {
        if (Object.keys(manifest.textures).length !== absoluteTexturePaths.length) return false;
        if (manifest.sourceHash !== this._calculateSourceHash(absoluteTexturePaths)) return false;
      }

      for (const [ textureUri, metadata ] of Object.entries(manifest.textures)) {
        this._textureUriMetadata.set(textureUri, metadata);
      }

      return true;
    } catch {
      return false;
    }
  }

  /** @internal */
  private _calculateSourceHash(absoluteTexturePaths: string[]): string {
    const hash = crypto.createHash('sha256');

    // Paths are already sorted by URI in _getAbsoluteTexturePaths()
    for (const absolutePath of absoluteTexturePaths) {
      const textureUri = this._absoluteTexturePathToTextureUri(absolutePath);
      const fileContent = fs.readFileSync(absolutePath);
      
      hash.update(textureUri);
      hash.update(Uint8Array.from(fileContent));
    }

    return hash.digest('hex');
  }

  /** @internal */
  private _absoluteTexturePathToTextureUri(absoluteTexturePath: string): string {
    const normalizedPath = path.normalize(absoluteTexturePath);
    const parts = normalizedPath.split(path.sep);
    const blocksIndex = parts.indexOf('blocks');
    
    if (blocksIndex !== -1) {
      // Return everything from 'blocks/' onwards (e.g., 'blocks/stone.png')
      return parts.slice(blocksIndex).join('/');
    }

    return path.basename(normalizedPath);
  }

  /** @internal */
  private _createPaddedTexture(image: any): any {
    const size = BLOCK_TEXTURE_REGISTRY_CONFIG.TEXTURE_SIZE;
    const pad = BLOCK_TEXTURE_REGISTRY_CONFIG.TEXTURE_PADDING;
    const padded = new Jimp({ width: size + pad * 2, height: size + pad * 2, color: 0x00000000 });
    
    padded.composite(image, pad, pad);

    // Extend edges by copying outermost pixels
    const { data, width } = padded.bitmap;
    const copy = (sx: number, sy: number, dx: number, dy: number) => {
      const si = (sy * width + sx) * 4;
      const di = (dy * width + dx) * 4;
      data[di] = data[si]; data[di + 1] = data[si + 1]; data[di + 2] = data[si + 2]; data[di + 3] = data[si + 3];
    };

    for (let y = 0; y < width; y++) {
      for (let x = 0; x < width; x++) {
        if (y < pad || y >= pad + size || x < pad || x >= pad + size) {
          const srcX = Math.max(pad, Math.min(pad + size - 1, x));
          const srcY = Math.max(pad, Math.min(pad + size - 1, y));
          copy(srcX, srcY, x, y);
        }
      }
    }

    return padded;
  }

  /** @internal */
  private _analyzeTexture(bitmap: Bitmap): BlockTextureAnalysis {
    const { width, height, data } = bitmap;
    const pixelCount = width * height;
    const sumRGB = [ 0, 0, 0 ];
    const alphaThreshold = 255 * BLOCK_TEXTURE_REGISTRY_CONFIG.ALPHA_TEST_THRESHOLD;

    let isTransparent = false;
    let needsAlphaTest = false;
    let transparencySum = 0;

    for (let i = 0; i < data.length; i += 4) {
      sumRGB[0] += data[i];
      sumRGB[1] += data[i + 1];
      sumRGB[2] += data[i + 2];

      const alpha = data[i + 3];
      isTransparent ||= alpha < 255 && alpha >= alphaThreshold;
      needsAlphaTest ||= alpha < alphaThreshold;

      if (alpha < alphaThreshold) {
        transparencySum += 1;
      } else {
        transparencySum += (255 - alpha) / 255;
      }
    }

    return {
      averageRGB: sumRGB.map(val => val / pixelCount / 255) as [number, number, number],
      isTransparent,
      needsAlphaTest,
      transparencyRatio: transparencySum / pixelCount,
    };
  }

  /** @internal */
  private _calculateGridLayout(textureCount: number): { cols: number; rows: number } {
    const powerOfTwo = (n: number) => 2 ** Math.ceil(Math.log2(n));
    const sqrt = Math.ceil(Math.sqrt(textureCount));
    const cols = powerOfTwo(sqrt);
    const rows = powerOfTwo(Math.ceil(textureCount / cols));
    
    return { cols, rows };
  }

  /** @internal */
  private async _getAbsoluteTexturePaths(): Promise<string[]> {
    const uriToPath = new Map<string, string>();

    for (const dir of BLOCK_TEXTURE_REGISTRY_CONFIG.DIRECTORIES) {
      if (!fs.existsSync(dir)) continue;

      const files = await glob('**/*.png', { cwd: dir, follow: true });
      for (const file of files) {
        const absolutePath = path.join(dir, file);
        const textureUri = this._absoluteTexturePathToTextureUri(absolutePath);

        uriToPath.set(textureUri, absolutePath);
      }
    }

    // Sort by URI for cross-platform consistency
    const sortedUris = Array.from(uriToPath.keys()).sort();

    return sortedUris.map(uri => uriToPath.get(uri)!);
  }
}
