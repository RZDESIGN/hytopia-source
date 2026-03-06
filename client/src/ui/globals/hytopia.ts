import * as THREE from 'three';
import * as GLTFLoader from 'three/addons/loaders/GLTFLoader.js';
import Game from '../../Game';
import MobileManager from '../../mobile/MobileManager';
import { profanityFilter } from '../../services/hytopia/profanityFilter';
import type { RaycastedBlock } from '../../chunks/ChunkManager';
import type { OnStateCallback } from '../SceneUI';
import type { ArrowCreateData } from '../../arrows/ArrowManager';

declare global {
  var hytopia: HytopiaUI;
}

/**
 * A function that creates and returns an HTML element for a Scene UI template.
 * 
 * @param id - Unique identifier for this Scene UI instance
 * @param onState - Callback to register listeners for state updates specific to this scene ui instance from the server
 * @returns HTML element to display in the scene
 * @public
 */
export type TemplateRenderer = (id: number, onState: (callback: OnStateCallback) => void) => HTMLElement;

/**
 * Global API for interacting with the HYTOPIA game client.
 * Access via the `hytopia` global variable in your client-side HTML UI code.
 * @public
 */
export class HytopiaUI {
  private _onDataCallbacks: Set<(data: object) => void> = new Set();
  private _sceneUITemplateRenderers: Map<string, TemplateRenderer> = new Map();

  /**
   * Detects if the player is on a mobile device. Use this to adjust UI layout or controls, etc.
   * @public
   */
  public get isMobile(): boolean {
    return MobileManager.isMobile;
  }

  /**
   * Maximum render distance of the camera in world units. Objects beyond this distance are not rendered.
   * @public
   */
  public get cameraFar(): number {
    return Game.instance.camera.far;
  }

  /**
   * Minimum render distance of the camera in world units. Objects closer than this distance are not rendered.
   * @public
   */
  public get cameraNear(): number {
    return Game.instance.camera.near;
  }

  /**
   * Gets the entity ID of the current player's entity.
   * Returns undefined if the player entity is not yet initialized.
   * @returns The player's entity ID, or undefined if not available
   * @public
   */
  public getPlayerEntityId(): number | undefined {
    return Game.instance.camera.gameCameraAttachedEntity?.id;
  }

  /**
   * Gets block data for a loaded chunk coordinate on the client.
   * This reflects speculative block predictions too, if one is active.
   * @param globalCoordinate - Global block coordinate in world space
   * @returns The block type id and rotation index, or undefined if the chunk is not loaded
   * @public
   */
  public getBlock(globalCoordinate: THREE.Vector3Like): { blockTypeId: number, blockRotationIndex: number } | undefined {
    const block = Game.instance.chunkManager.getBlock(globalCoordinate);

    if (!block) {
      return undefined;
    }

    return {
      blockTypeId: block.blockId,
      blockRotationIndex: block.blockRotationIndex,
    };
  }

  /**
   * Finds an entity by its name property and returns its ID.
   * If multiple entities have the same name, returns the first one found.
   * @param name - The exact name to search for (case-sensitive)
   * @returns The entity ID if found, undefined otherwise
   * @public
   */
  public getEntityIdByName(name: string): number | undefined {
    return Game.instance.entityManager.findEntityByName(name)?.id;
  }

  /**
   * Raycasts against currently rendered solid chunk meshes on the client.
   * Use this to resolve block break/place targets before sending your gameplay action to the server.
   * @param screenX - Screen X coordinate. Defaults to the viewport center.
   * @param screenY - Screen Y coordinate. Defaults to the viewport center.
   * @param maxDistance - Max raycast distance in world units.
   * @returns Block hit information, or undefined if no solid block was hit
   * @public
   */
  public raycastBlock(
    screenX: number = window.innerWidth / 2,
    screenY: number = window.innerHeight / 2,
    maxDistance: number = 8,
  ): RaycastedBlock | undefined {
    return Game.instance.chunkManager.raycastBlockFromCamera(screenX, screenY, maxDistance);
  }

  /**
   * Creates an arrow between two points or entities.
   * @param source - Source entity ID (number) or position (Vector3Like)
   * @param target - Target entity ID (number) or position (Vector3Like)
   * @param options - Optional arrow properties (color, textureUrl)
   * @returns The arrow ID
   * @public
   */
  public connectArrow(source: number | THREE.Vector3Like, target: number | THREE.Vector3Like, options?: { color?: { r: number, g: number, b: number }, textureUri?: string }): number {
    const data: ArrowCreateData = {};

    if (typeof source === 'number') {
      data.sourceEntityId = source;
    } else {
      data.sourcePosition = source;
    }

    if (typeof target === 'number') {
      data.targetEntityId = target;
    } else {
      data.targetPosition = target;
    }

    if (options?.color) {
      data.color = normalizeRGB255(options.color);
    }

    if (options?.textureUri) {
      data.textureUri = options.textureUri;
    }

    return Game.instance.arrowManager.connectArrow(data);
  }

  /**
   * Removes an arrow by its ID.
   * @param arrowId - The arrow ID to remove
   * @throws Error if the arrow ID does not exist
   * @public
   */
  public disconnectArrow(arrowId: number): void {
    Game.instance.arrowManager.disconnectArrow(arrowId);
  }

  /**
   * Access to a THREE.js GLTFLoader instance for loading 3D models, useful if you want to render models in your UI.
   * @public
   */
  public get gltfLoader(): typeof GLTFLoader {
    return GLTFLoader;
  }

  /**
   * Access to the THREE.js library for advanced 3D rendering. Use for custom visual effects in your UI.
   * @public
   */
  public get three(): typeof THREE {
    return THREE;
  }

  /** @internal */
  public emitData(data: object): void {
    for (const callback of this._onDataCallbacks) {
      callback(data);
    }
  }

  /**
   * Freezes or unfreezes the pointer lock state. Preventing player inputs from automatically locking
   * or unlocking the pointer. Esc key will still unlock the pointer - this is a system level feature
   * that cannot be overriden. Pointer lock only affects Desktop devices.
   * @param freeze - When `true`, the pointer lock will be frozen in the current state, preventing changes until `false` is passed again or player.ui.freezePointerLock(false) is called by the server.
   */
  public freezePointerLock(freeze: boolean): void {
    Game.instance.inputManager.freezePointerLock(freeze);
  }

  /**
   * Applies an owner-only speculative block change on the client.
   * The normal authoritative block sync from the server reconciles or overrides it.
   * @param globalCoordinate - Global block coordinate in world space
   * @param blockTypeId - Block id to display locally. Use 0 for air/removal.
   * @param blockRotationIndex - Optional rotation index
   * @param timeoutMs - Optional rollback timeout if the server never confirms the change
   * @returns Whether the prediction was applied locally
   * @public
   */
  public predictBlock(
    globalCoordinate: THREE.Vector3Like,
    blockTypeId: number,
    blockRotationIndex?: number,
    timeoutMs?: number,
  ): boolean {
    return Game.instance.chunkManager.predictBlock(
      globalCoordinate,
      blockTypeId,
      blockRotationIndex,
      timeoutMs,
    );
  }

  /**
   * Rolls back a previously predicted block change at the given coordinate.
   * @param globalCoordinate - Global block coordinate in world space
   * @returns Whether a speculative block was rolled back
   * @public
   */
  public rollbackPredictedBlock(globalCoordinate: THREE.Vector3Like): boolean {
    return Game.instance.chunkManager.rollbackPredictedBlock(globalCoordinate);
  }

  /**
   * Sends data from your UI to the game server. The server receives this via `player.ui.on(PlayerUIEvent.DATA, callback)`.
   * Use this to notify the server of player actions taken in your custom UI.
   * @param data - Data object to send to the server
   * @public
   */
  public sendData(data: object): void {
    Game.instance.networkManager.sendUIDataPacket(data);
  }

  /**
   * Removes all registered data event listeners. 
   * @public
   */
  public offAllData(): void {
    this._onDataCallbacks.clear();
  }

  /**
   * Removes a specific data event listener. Pass the same callback function used in `onData()`.
   * @param callback - The callback function to remove
   * @public
   */
  public offData(callback: (data: object) => void): void {
    this._onDataCallbacks.delete(callback);
  }

  /**
   * Registers a listener for data received by the server from `player.ui.sendData()`.
   * @param callback - Function to call when data is received from the server.
   * @public
   */
  public onData(callback: (data: object) => void): void {
    this._onDataCallbacks.add(callback);
  }

  /**
   * Controls pointer lock for your UI. When locked, the cursor is hidden and mouse movement controls the camera.
   * Call with `true` when hiding your UI so players can control the camera, `false` when showing UI that needs cursor interaction.
   * Pointer lock only affects Desktop devices.
   * @param lock - `true` to lock pointer and hide cursor, `false` to unlock and show cursor
   * @param maintainInput - When `true`, keyboard movement/inputs for gameplay still work while pointer is unlocked (default: `false`)
   * @public
   */
  public lockPointer(lock: boolean, maintainInput: boolean = false): void {
    Game.instance.inputManager.lockPointer(lock, maintainInput);
  }

  /**
   * Simulates player input programmatically. Useful for creating custom UI controls that trigger game actions, such as for mobile UI buttons.
   * @param input - Input name (e.g., 'forward', 'backward', 'left', 'right', 'jump', 'sprint')
   * @param pressed - `true` to press and hold the input, `false` to release it
   * @public
   */
  public pressInput(input: string, pressed: boolean): void {
    Game.instance.inputManager.pressInput(input, pressed);
  }

  /**
   * Registers a custom Scene UI template that will instantiate when a SceneUI on the server for the given templateId is loaded.
   * Templates define how your UI should render for each Scene UI instance created by the server.
   * @param templateId - Unique identifier for this template (must match the templateId used server-side when creating a SceneUI)
   * @param templateRenderer - Function that creates and returns the HTML element for this UI. This is effectively the factory function.
   * @public
   */
  public registerSceneUITemplate(templateId: string, templateRenderer: TemplateRenderer): void {
    this._sceneUITemplateRenderers.set(templateId, templateRenderer);
  }

  /**
   * Adjusts the user's base mouse sensitivity for camera rotation. Values above 1.0 increase sensitivity, below 1.0 decrease it.
   * Useful for providing sensitivity settings in your UI options menu.
   * @param multiplier - Sensitivity multiplier (`1.0` = default, `2.0` = twice as sensitive, `0.5` = half as sensitive)
   * @public
   */
  public setMouseSensitivityMultiplier(multiplier: number): void {
    Game.instance.camera.setMouseSensitivityMultiplier(multiplier);
  }

  /**
   * Inverts vertical camera look for mouse, touch, and controller input.
   * Useful for exposing an invert-Y toggle in your UI options menu.
   * @param invert - `true` to invert vertical look, `false` for standard look controls
   * @public
   */
  public setInvertVerticalLook(invert: boolean): void {
    Game.instance.settingsManager.setInvertVerticalLook(invert);
  }

  /**
   * Applies color tint to an entity on the client only (does not affect other players' view).
   * Use for client-side visual effects like highlighting, damage indicators, or team colors.
   * @param entityId - ID of the entity to tint
   * @param color - RGB color multiplier (0-1 range per channel), or `undefined` to remove tint
   * @public
   */
  public setEntityColorCorrection(entityId: number, color: {r: number, g: number, b: number} | undefined): void {
    const entity = Game.instance.entityManager.getEntity(entityId);

    if (!entity) {
      console.warn(`Entity with id ${entityId} not found`);
      return;
    }

    entity.setClientColorCorrection(color !== undefined ? normalizeRGB255(color) : undefined);
  }

  /**
   * Removes a registered Scene UI template. The template will no longer be available for new Scene UI instances.
   * Existing instances using this template are not affected.
   * @param templateId - Template identifier to remove
   * @public
   */
  public unregisterSceneUITemplate(templateId: string): void {
    this._sceneUITemplateRenderers.delete(templateId);
  }

  /**
   * Removes all custom Scene UI templates. Built-in HYTOPIA templates (prefixed with `hytopia:`) are preserved.
   * Use this when cleaning up your game code on disconnect or world change.
   * @public
   */
  public unregisterLoadedSceneUITemplates(): void {
    for (const [templateId] of this._sceneUITemplateRenderers) {
      if (!templateId.startsWith('hytopia:')) {
        this._sceneUITemplateRenderers.delete(templateId);
      }
    }
  }

  /**
   * Retrieves a registered Scene UI template renderer function.
   * @param templateId - Template identifier to look up
   * @returns Template renderer function if found, `undefined` otherwise
   * @public
   */
  public getSceneUITemplateRenderer(templateId: string): TemplateRenderer | undefined {
    return this._sceneUITemplateRenderers.get(templateId);
  }

  /**
   * Checks whether a Scene UI template is currently registered.
   * @param templateId - Template identifier to check
   * @returns `true` if the template is registered, `false` otherwise
   * @public
   */
  public hasSceneUITemplateRenderer(templateId: string): boolean {
    return this._sceneUITemplateRenderers.has(templateId);
  }

  /**
   * Filters inappropriate language from text by replacing profanity with asterisks.
   * Use this to sanitize user-generated content displayed in your UI (e.g., chat messages, usernames).
   * @param text - Text to filter
   * @returns Filtered text with profanity replaced by asterisks
   * @public
   */
  public filterProfanity(text: string): string {
    return profanityFilter.clean(text);
  }

  /**
   * Checks if text contains inappropriate language. Useful for validating input before sending to the server.
   * @param text - Text to check
   * @returns `true` if profanity is detected, `false` otherwise
   * @public
   */
  public hasProfanity(text: string): boolean {
    return profanityFilter.hasProfanity(text);
  }
}

const normalizeRGB255 = (color: {r: number, g: number, b: number}): { r: number, g: number, b: number } => {
  return { r: color.r / 255.0, g: color.g / 255.0, b: color.b / 255.0 };
};

globalThis.hytopia = new HytopiaUI();
