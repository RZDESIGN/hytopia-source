import Assets from '../network/Assets';
import { DeserializedSceneUI } from '../network/Deserializer';
import Game from '../Game';
import EventRouter from '../events/EventRouter';
import Nametag from './templates/Nametag';
import { NetworkManagerEventType } from '../network/NetworkManager';
import SceneUI from './SceneUI';
import SceneUIStats from './SceneUIStats';
import type { NetworkManagerEventPayload } from '../network/NetworkManager';

// Track elements that have click/pointer event listeners attached
// We need this to elegantly detect if an interact click/touch would
// of been captured by a UI element or not. Without this, all UI elements
// would require pointer-events: none on every nested element up the DOM
// path for an interaction. This approach makes it seamless with no dev requirements.
const elementsWithClickListeners = new WeakSet<EventTarget>();
const TRACKED_CLICK_EVENTS = ['click', 'pointerup', 'pointerdown', 'mouseup', 'mousedown', 'touchend', 'touchstart'];

// Monkey-patch addEventListener to track click/pointer listeners
const originalAddEventListener = EventTarget.prototype.addEventListener;
EventTarget.prototype.addEventListener = function(
  type: string,
  listener: EventListenerOrEventListenerObject | null,
  options?: boolean | AddEventListenerOptions
) {
  // Track elements with click/pointer listeners (WeakSet only accepts objects)
  if (listener && TRACKED_CLICK_EVENTS.includes(type) && this && typeof this === 'object') {
    elementsWithClickListeners.add(this);
  }
  return originalAddEventListener.call(this, type, listener!, options);
};

export default class UIManager {
  private _game: Game;
  private _sceneUIs: Map<number, SceneUI> = new Map();
  private _pendingSceneUIs: Map<number, DeserializedSceneUI> = new Map();
  private _uiDiv: HTMLDivElement;
  private _uiLoadPromise: Promise<void>;

  public constructor(game: Game) {
    this._game = game;

    this._uiDiv = document.getElementById('ui-container') as HTMLDivElement;
    this._uiLoadPromise = Promise.resolve();

    this._setupEventListeners();
    this._setupReliableClicks();
    this._initializeTemplates();
  }

  public get uiDiv(): HTMLDivElement {
    return this._uiDiv;
  }

  /** Check if any UI element in the event path (before canvas/body) has a click/pointer listener */
  public eventPathHasClickListener(event: PointerEvent): boolean {
    for (const target of event.composedPath()) {
      if (!(target instanceof HTMLElement)) continue;
      if (target.tagName === 'CANVAS' || target.tagName === 'BODY') return false;
      
      // Check tracked addEventListener listeners
      if (elementsWithClickListeners.has(target)) return true;
      
      // Check inline handlers
      if (target.onclick || target.onpointerup || target.onpointerdown || 
          target.onmouseup || target.onmousedown || target.ontouchend || target.ontouchstart) {
        return true;
      }
    }
    return false;
  }

  private _setupEventListeners(): void {
    EventRouter.instance.on(NetworkManagerEventType.SceneUIsPacket, this._onSceneUIsPacket);
    EventRouter.instance.on(NetworkManagerEventType.UIPacket, this._onUIPacket);
    EventRouter.instance.on(NetworkManagerEventType.UIDatasPacket, this._onUIDatasPacket);
  }

  /**
   * Sets up a reliable click fallback system. In certain browsers (especially Safari/WebKit),
   * click events can stop firing entirely after iframe navigation or context switches due to
   * known bugs. This method uses pointer events (which remain reliable) to detect taps and
   * emits synthetic click events as a fallback when native click events fail to fire.
   * The system is universal and automatically adapts - it only emits synthetic clicks when
   * native clicks don't work, preventing double-click issues.
   */
  private _setupReliableClicks(): void {
    let target: EventTarget | null = null;
    let timeout: NodeJS.Timeout | undefined;
    
    const reset = () => {
      clearTimeout(timeout);
      target = null;
    }
    
    window.addEventListener('pointerdown', e => {
      if (e.button === 0 && e.isPrimary) {
        target = e.target;
      }
    });

    window.addEventListener('pointerup', e => {
      if (e.button === 0 && e.isPrimary && target === e.target) {
        clearTimeout(timeout);
        timeout = setTimeout(() => {
          if (target) {
            target.dispatchEvent(new MouseEvent('click', {
              bubbles: true,
              cancelable: true,
              composed: true,
              view: window,
              detail: 1,
              clientX: e.clientX,
              clientY: e.clientY,
            }));
  
            target = null;
          }
        }, 75); // 75ms to give a buffer in the event of heavy CPU situations.
      }
    });

    window.addEventListener('pointercancel', reset);
    window.addEventListener('click', reset, true); // We must use "true" to ensure we capture the event even if another listener uses stopPropagation()
  }

  private _initializeTemplates(): void {
    Nametag.initialize();
  }

  public update = (): void => {
    SceneUIStats.count = this._sceneUIs.size;
    SceneUIStats.visibleCount = 0;

    for (const sceneUI of this._sceneUIs.values()) {
      sceneUI.update();
    }
  }

  private _onSceneUIsPacket = (payload: NetworkManagerEventPayload.ISceneUIsPacket): void => {
    for (const deserializedSceneUI of payload.deserializedSceneUIs) {
      this._updateSceneUI(deserializedSceneUI);
    }
  }

  private _onUIPacket = (payload: NetworkManagerEventPayload.IUIPacket): void => {
    const { deserializedUI } = payload;

    if (deserializedUI.htmlUri) {
      this._uiLoadPromise = fetch(Assets.toAssetUri(deserializedUI.htmlUri, true))
        .then(response => response.text())
        .then(html => {
          // cleanup for any previously loaded UI.
          // this load/unload pattern could become problematic or fragicle in the
          // future between dev loaded UI/scenes, and internal UI/scenes such
          // as nametags or other future client data handlers we ship ourselves.
          // Refactoring our pattern for things like nametags or if we use
          // our own .on UI data handlers in the future would be wise.
          hytopia.offAllData();
          hytopia.unregisterLoadedSceneUITemplates();

          html = html.replace(/\{\{CDN_ASSETS_URL\}\}/g, Assets.getCdnBaseUrl());

          this._uiDiv.innerHTML = html;
          this._executeScripts(Array.from(this._uiDiv.getElementsByTagName('script')));
          this._uiDiv.style.display = 'block';
          
          // Process any pending SceneUIs now that templates may be registered
          this._processPendingSceneUIs();
        });
    }

    // Handle appendHtmlUris only after the main htmlUri load has completed.
    // This is to avoid appending and then load clearing the appended UI in the same tick.
    if (deserializedUI.appendHtmlUris) {
      const appendHtmlUris = deserializedUI.appendHtmlUris; // scoped for promise

      this._uiLoadPromise = this._uiLoadPromise.then(async () => {
        for (const htmlUri of appendHtmlUris) {
          const html = await fetch(Assets.toAssetUri(htmlUri, true)).then(response => response.text());
          const wrapper = document.createElement('div');

          wrapper.innerHTML = html.replace(/\{\{CDN_ASSETS_URL\}\}/g, Assets.getCdnBaseUrl());

          const scripts = Array.from(wrapper.getElementsByTagName('script'));
          const fragment = document.createDocumentFragment();

          while (wrapper.firstChild) {
            fragment.appendChild(wrapper.firstChild);
          }

          this._uiDiv.appendChild(fragment);
          this._uiDiv.style.display = 'block';
          this._executeScripts(scripts);
          
          // Process any pending SceneUIs after each append now that templates may be registered
          this._processPendingSceneUIs();
        }
      });
    }

    if (deserializedUI.pointerLock !== undefined) {
      this._game.inputManager.lockPointer(deserializedUI.pointerLock);
      this._game.inputManager.enableInput(deserializedUI.pointerLock);
    }

    if (deserializedUI.pointerLockFrozen !== undefined) {
      this._game.inputManager.freezePointerLock(deserializedUI.pointerLockFrozen);
    }
  }

  private _onUIDatasPacket = async (payload: NetworkManagerEventPayload.IUIDatasPacket): Promise<void> => {
    await this._uiLoadPromise;

    for (const data of payload.deserializedUIDatas) {
      hytopia.emitData(data);
    }

  }

  private _updateSceneUI = (deserializedSceneUI: DeserializedSceneUI): void => {
    let sceneUI = this._sceneUIs.get(deserializedSceneUI.id);

    if (!sceneUI) {
      if (deserializedSceneUI.removed) {
        this._pendingSceneUIs.delete(deserializedSceneUI.id);
        return;
      }

      // Check if update to pending SceneUI
      const pending = this._pendingSceneUIs.get(deserializedSceneUI.id);
      if (pending) {
        // we may want to alter Deserializer to check for key in object rather than a bunch of undefined properties
        // which in this case require us to filter them to prevent undefined overwrites.
        Object.assign(pending, Object.fromEntries(Object.entries(deserializedSceneUI).filter(([, v]) => v !== undefined)));
        return;
      }

      // Queue if template not available yet
      if (deserializedSceneUI.templateId && !hytopia.hasSceneUITemplateRenderer(deserializedSceneUI.templateId)) {
        this._pendingSceneUIs.set(deserializedSceneUI.id, { ...deserializedSceneUI });
        return;
      }

      // Validate required fields for creation
      if (
        deserializedSceneUI.id === undefined ||
        deserializedSceneUI.templateId === undefined ||
        (deserializedSceneUI.attachedToEntityId === undefined && deserializedSceneUI.position === undefined)
      ) {
        return console.info(`UIManager._updateSceneUI(): SceneUI ${deserializedSceneUI.id} not yet created, this can be safely ignored if no gameplay bugs are experienced.`, deserializedSceneUI);
      }

      sceneUI = new SceneUI(this._game, {
        id: deserializedSceneUI.id,
        attachedToEntityId: deserializedSceneUI.attachedToEntityId,
        offset: deserializedSceneUI.offset,
        position: deserializedSceneUI.position,
        state: deserializedSceneUI.state,
        templateId: deserializedSceneUI.templateId,
        templateRenderer: hytopia.getSceneUITemplateRenderer(deserializedSceneUI.templateId)!,
        viewDistance: deserializedSceneUI.viewDistance,
      });

      this._sceneUIs.set(sceneUI.id, sceneUI);

      sceneUI.addToScene();
    } else {
      if (deserializedSceneUI.removed) {
        sceneUI.removeFromScene();
        this._sceneUIs.delete(sceneUI.id);
        return;
      }

      if (deserializedSceneUI.attachedToEntityId !== undefined) {
        sceneUI.setAttachedToEntityId(deserializedSceneUI.attachedToEntityId);
      }

      if (deserializedSceneUI.offset) {
        sceneUI.setOffset(deserializedSceneUI.offset);
      }

      if (deserializedSceneUI.position) {
        sceneUI.setPosition(deserializedSceneUI.position);
      }

      if (deserializedSceneUI.state) {
        sceneUI.setState(deserializedSceneUI.state);
      }

      if (deserializedSceneUI.viewDistance) {
        sceneUI.setViewDistance(deserializedSceneUI.viewDistance);
      }
    }
  }

  /** Process pending SceneUIs whose templates are now registered. FIFO order. */
  private _processPendingSceneUIs(): void {
    for (const [id, pending] of this._pendingSceneUIs) {
      if (!pending.templateId) continue;
      if (hytopia.hasSceneUITemplateRenderer(pending.templateId)) {
        this._pendingSceneUIs.delete(id);
        this._updateSceneUI(pending);
      }
    }
  }

  private _executeScripts(scripts: HTMLScriptElement[]): void {
    scripts.forEach(oldScript => {
      const newScript = document.createElement('script');
      Array.from(oldScript.attributes).forEach(attr => newScript.setAttribute(attr.name, attr.value));
      newScript.textContent = `(function(){${oldScript.textContent}})();`;
      oldScript.parentNode?.replaceChild(newScript, oldScript);
    });
  }
}
