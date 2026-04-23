import { SRGBColorSpace, Texture } from 'three';
import Assets from "../network/Assets";

type CustomTextureEntry = {
  texture: Texture | null;
  texturePromise: Promise<Texture>;
  wrappedTexturePromiseSet: Set<Promise<CustomTextureWrapper>>;
  wrappedTextureSet: Set<CustomTextureWrapper>;
  uri: string;
};

export type CustomTextureWrapper = {
  texture: Texture;
};

export default class CustomTextureManager {
  private readonly _uriToEntry: Map<string, CustomTextureEntry> = new Map();
  private readonly _textureToEntry: Map<CustomTextureWrapper | Promise<CustomTextureWrapper>, CustomTextureEntry> = new Map();

  constructor() {
  }

  private _createEntry(uri: string): void {
    const entry: CustomTextureEntry = {
      texture: null,
      texturePromise: Assets.textureLoader.loadAsync(uri),
      wrappedTexturePromiseSet: new Set(),
      wrappedTextureSet: new Set(),
      uri,
    };
    this._uriToEntry.set(uri, entry);
  }

  private _releaseEntry(entry: CustomTextureEntry): void {
    if (entry.texture) {
      entry.texture.dispose();
    }
    this._uriToEntry.delete(entry.uri);

    // To prevent memory leaks caused by circular references.
    entry.wrappedTexturePromiseSet.clear();
    entry.wrappedTextureSet.clear();
    entry.texture = null;
  }

  public async load(uri: string): Promise<CustomTextureWrapper> {
    if (!this._uriToEntry.has(uri)) {
      this._createEntry(uri);
    }

    const entry = this._uriToEntry.get(uri)!;
    const texturePromise = entry.texturePromise;

    const wrappedTexturePromise = new Promise<CustomTextureWrapper>((resolve, reject) => {
      texturePromise.then(texture => {
        texture.colorSpace = SRGBColorSpace;

        this._textureToEntry.delete(wrappedTexturePromise);

        // If this request has already been canceled, nothing to do.
        if (!entry.wrappedTexturePromiseSet.has(wrappedTexturePromise)) {
          return;
        }

        entry.wrappedTexturePromiseSet.delete(wrappedTexturePromise);

        entry.texture = texture;

        // One option is to return the Texture object directly and manage its usage with reference counting,
        // but instead, we create and return a wrapper object around the texture for each call. This approach
        // makes it easier to investigate issues if any bugs occur.
        const wrappedTexture = { texture };

        entry.wrappedTextureSet.add(wrappedTexture);
        this._textureToEntry.set(wrappedTexture, entry);

        resolve(wrappedTexture);
      }).catch(error => {
        this._textureToEntry.delete(wrappedTexturePromise);

        const wasPending = entry.wrappedTexturePromiseSet.has(wrappedTexturePromise);
        entry.wrappedTexturePromiseSet.delete(wrappedTexturePromise);

        if (!wasPending) {
          return;
        }

        if (entry.wrappedTextureSet.size === 0 && entry.wrappedTexturePromiseSet.size === 0) {
          this._releaseEntry(entry);
        }

        reject(error);
      });
    });

    entry.wrappedTexturePromiseSet.add(wrappedTexturePromise)
    this._textureToEntry.set(wrappedTexturePromise, entry);

    return wrappedTexturePromise;
  }

  public cancel(wrappedTexturePromise: Promise<CustomTextureWrapper>, quiet?: boolean): boolean {
    if (!this._textureToEntry.has(wrappedTexturePromise)) {
      // TODO: Better error handling?
      if (quiet !== true) {
        console.warn(`Already resolved or Unknown Texture Promise.`, wrappedTexturePromise);
      }
      return false;
    }
  
    const entry = this._textureToEntry.get(wrappedTexturePromise)!;
    entry.wrappedTexturePromiseSet.delete(wrappedTexturePromise);
  
    if (entry.wrappedTextureSet.size === 0 && entry.wrappedTexturePromiseSet.size === 0) {
      this._releaseEntry(entry);
    }
  
    return true;
  }

  public release(wrappedTexture: CustomTextureWrapper): boolean {
    if (!this._textureToEntry.has(wrappedTexture)) {
      // TODO: Better error handling?
      console.warn(`Unknown Texture.`, wrappedTexture);
      return false;
    }

    const entry = this._textureToEntry.get(wrappedTexture)!;

    entry.wrappedTextureSet.delete(wrappedTexture);

    if (entry.wrappedTextureSet.size === 0 && entry.wrappedTexturePromiseSet.size === 0) {
      this._releaseEntry(entry);
    }

    return true;
  }
}
