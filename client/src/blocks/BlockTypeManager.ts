import type { Vector3Tuple } from 'three';
import BlockType, { BlockTypeData } from './BlockType';
import BlockTypeRegistry from './BlockTypeRegistry';
import { textureUriToTextureUris } from './utils';
import EventRouter from '../events/EventRouter';
import Game from '../Game';
import { NetworkManagerEventType } from '../network/NetworkManager';
import type { DeserializedBlockType } from '../network/Deserializer';
import type { NetworkManagerEventPayload } from '../network/NetworkManager';
import { ChunkWorkerBlockTypeMessage, ChunkWorkerBlockTypeUpdateMessage } from '../workers/ChunkWorkerConstants';
import type { BlockId } from './BlockConstants';

export default class BlockTypeManager {
  private _game: Game;
  private _registry: BlockTypeRegistry = new BlockTypeRegistry();

  public constructor(game: Game) {
    this._game = game;
    this._setupEventListeners();
  }

  public get game(): Game { return this._game; }

  private _setupEventListeners(): void {
    EventRouter.instance.on(
      NetworkManagerEventType.BlockTypesPacket,
      this._onBlockTypesPacket,
    );
  }

  private _onBlockTypesPacket = (payload: NetworkManagerEventPayload.IBlockTypesPacket) => {
    const { deserializedBlockTypes } = payload;

    for (let i = 0; i < deserializedBlockTypes.length; i++) {
      this._updateBlockType(deserializedBlockTypes[i]);
    }
  }

  private _updateBlockType = (deserializedBlockType: DeserializedBlockType) => {
    const blockType = this._registry.getBlockType(deserializedBlockType.id);

    if (!blockType) {
      const blockTypeData: BlockTypeData = {
        id: deserializedBlockType.id,
        isLiquid: deserializedBlockType.isLiquid ?? false,
        name: deserializedBlockType.name ?? 'Unknown',
        textureUris: textureUriToTextureUris(deserializedBlockType.textureUri),
        lightLevel: deserializedBlockType.lightLevel,
        trimeshIndices: deserializedBlockType.trimeshIndices,
        trimeshVertices: deserializedBlockType.trimeshVertices,
      };
      this._registry.registerBlockType(new BlockType(blockTypeData));

      // BlockType is needed in the WebWorker for managing the Block Texture Atlas, so it will be sent.
      const message: ChunkWorkerBlockTypeMessage = {
        type: 'block_type',
        data: blockTypeData,
      };
      this._game.chunkWorkerClient.postMessage(message);
    } else {
      const { name, textureUri } = deserializedBlockType;
      const textureUris = textureUri ? textureUriToTextureUris(textureUri) : undefined;

      if (name) {
        blockType.setName(name);
      }

      if (textureUris) {
        blockType.setTextureUris(textureUris);
      }

      if (name || textureUris) {
        const message: ChunkWorkerBlockTypeUpdateMessage = {
          type: 'block_type_update',
          blockId: blockType.id,
          name,
          textureUris,
        };
        this._game.chunkWorkerClient.postMessage(message);
      }
    }
  }

  public getBlockType(blockTypeId: BlockId): BlockType | undefined {
    return this._registry.getBlockType(blockTypeId);
  }

  // Calculates and returns the RGB color of a block, taking into account both the block's
  // color and the BlockTexture it uses. Ideally, this method or property should exist in
  // BlockType, but BlockTexture strongly depends on BlockTextureAtlas, and its contents are
  // managed in a WebWorker. As a result, it's difficult to retrieve texture color information
  // during BlockType creation, and asynchronous processing is unavoidable.
  // For now, this method is added to BlockTypeManager and is called only when needed.
  public getBlockRGB(blockType: BlockType): Vector3Tuple {
    const sumRGB = [0.0, 0.0, 0.0];

    // For now, it’s calculated every time since it’s used infrequently.
    // If it ends up being called repeatedly and impacts performance, caching the result might be a good idea.
    let count = 0;
    Object.values(blockType.textureUris).forEach(uri => {
      const metadata = this._game.blockTextureAtlasManager.getMetadata(uri);
      if (!metadata) {
        // It's possible that metadata has not yet been received from the WebWorker.
        // In that case, we simply ignore it for now. Given the current use case,
        // a temporary wrong color shouldn't be a major issue as long as
        // the correct color can eventually be retrieved.
        return;
      }
      for (let i = 0; i < sumRGB.length; i++) {
        sumRGB[i] += metadata.averageRGB[i];
      }
      count++;
    });

    return [
      (count > 0 ? sumRGB[0] / count : 1.0) * blockType.color[0],
      (count > 0 ? sumRGB[1] / count : 1.0) * blockType.color[1],
      (count > 0 ? sumRGB[2] / count : 1.0) * blockType.color[2],
    ];
  }
}
