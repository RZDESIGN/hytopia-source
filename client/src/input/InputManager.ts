import Game from '../Game';
import EventRouter from '../events/EventRouter';
import MobileManager from '../mobile/MobileManager';
import { CameraEventType } from '../core/Camera';
import type { CameraEventPayload } from '../core/Camera';

// Max duration in ms for a tap/click (vs hold)
const INTERACT_TAP_MAX_DURATION_MS = 200;

// Max distance squared in pixels for a drag (vs tap) - 30px radius
const INTERACT_DRAG_CANCEL_MAX_DISTANCE_SQ = 900;
const MOVEMENT_STATE_DIRTY_RESEND_TICKS = 3;
const MOVEMENT_PACKET_MAX_DELTA_S = 1 / 10;

type InputState = {
  w?: boolean;  // w
  a?: boolean;  // a
  s?: boolean;  // s
  d?: boolean;  // d
  q?: boolean;  // q
  e?: boolean;  // e
  r?: boolean;  // r
  f?: boolean;  // f
  z?: boolean;  // z
  x?: boolean;  // x
  c?: boolean;  // c
  v?: boolean;  // v
  u?: boolean;  // u
  i?: boolean;  // i
  o?: boolean;  // o
  j?: boolean;  // j
  k?: boolean;  // k
  l?: boolean;  // l
  n?: boolean;  // n
  m?: boolean;  // m
  '1'?: boolean;  // 1
  '2'?: boolean;  // 2
  '3'?: boolean;  // 3
  '4'?: boolean;  // 4
  '5'?: boolean;  // 5
  '6'?: boolean;  // 6
  '7'?: boolean;  // 7
  '8'?: boolean;  // 8
  '9'?: boolean;  // 9
  '0'?: boolean;  // 0
  sp?: boolean; // space
  sh?: boolean; // shift
  tb?: boolean; // tab
  ml?: boolean; // mouse left
  mr?: boolean; // mouse right
}

type ContinuousInputState = {
  cp?: number; // camera pitch radians
  cy?: number; // camera yaw radians
  jd?: number | null; // joystick direction radians, null signals server to stop joystick movement
}

const CODE_TO_KEY_MAP: { [key: string]: string } = {
  'KeyW': 'w',
  'KeyA': 'a',
  'KeyS': 's',
  'KeyD': 'd',
  'KeyQ': 'q',
  'KeyE': 'e',
  'KeyR': 'r',
  'KeyF': 'f',
  'KeyZ': 'z',
  'KeyX': 'x',
  'KeyC': 'c',
  'KeyV': 'v',
  'KeyU': 'u',
  'KeyI': 'i',
  'KeyO': 'o',
  'KeyJ': 'j',
  'KeyK': 'k',
  'KeyL': 'l',
  'KeyN': 'n',
  'KeyM': 'm',
  'Digit1': '1',
  'Digit2': '2',
  'Digit3': '3',
  'Digit4': '4',
  'Digit5': '5',
  'Digit6': '6',
  'Digit7': '7',
  'Digit8': '8',
  'Digit9': '9',
  'Digit0': '0',
  'Space': 'sp',
  'ShiftLeft': 'shift',
  'ShiftRight': 'shift',
  'Tab': 'tab',
  'Backquote': '`',
  'Backslash': '\\',
  'BracketLeft': '[',
  'BracketRight': ']',
};

const SUPPORTED_INPUT_MAP: { [key: string]: keyof InputState } = {
  'w': 'w',
  'a': 'a',
  's': 's',
  'd': 'd',
  'q': 'q',
  'e': 'e',
  'r': 'r',
  'f': 'f',
  'z': 'z',
  'x': 'x',
  'c': 'c',
  'v': 'v',
  'u': 'u',
  'i': 'i',
  'o': 'o',
  'j': 'j',
  'k': 'k',
  'l': 'l',
  'n': 'n',
  'm': 'm',
  '1': '1',
  '!': '1', // shift + 1
  '2': '2',
  '@': '2', // shift + 2
  '3': '3',
  '#': '3', // shift + 3
  '4': '4',
  '$': '4', // shift + 4
  '5': '5',
  '%': '5', // shift + 5
  '6': '6',
  '^': '6', // shift + 6
  '7': '7',
  '&': '7', // shift + 7
  '8': '8',
  '*': '8', // shift + 8
  '9': '9',
  '(': '9', // shift + 9
  '0': '0',
  ')': '0', // shift + 0
  ' ': 'sp',
  'shift': 'sh',
  'tab': 'tb',
  'mouse0': 'ml',
  'mouse2': 'mr',
};

const SUPPORTED_INPUTS = Object.values(SUPPORTED_INPUT_MAP);
const NETWORKED_MOVEMENT_INPUT_KEYS: (keyof InputState)[] = [ 'w', 'a', 's', 'd', 'sp', 'sh', 'c' ];
const NETWORKED_MOVEMENT_INPUT_KEY_SET = new Set<keyof InputState>(NETWORKED_MOVEMENT_INPUT_KEYS);

export enum InputManagerEventType {
  MovementPacketSent = 'INPUT_MANAGER.MOVEMENT_PACKET_SENT',
}

export namespace InputManagerEventPayload {
  export interface IMovementPacketSent {
    sequenceNumber: number;
    deltaTimeS: number;
    yaw: number;
    joystickDirection: number | null;
    w: boolean;
    a: boolean;
    s: boolean;
    d: boolean;
    sh: boolean;
  }
}

export default class InputManager {
  private _game: Game;
  private _isPointerLocked = false;
  private _isPointerLockFrozen = false;
  private _inputEnabled: boolean = true;
  private _inputState: InputState = {};
  private _joystickDirection: number | null = null;
  private _wasMovementInputPressed: boolean = false;
  private _movementStateDirtyResendTicks: number = 0;
  private _networkedInputEnabled: boolean = true;
  private _continuousInputState: ContinuousInputState = {};
  private _onPressCallback: Map<string, () => void> = new Map();
  private _pointerLockRequested = !MobileManager.isMobile;
  private _pointerLockRequestedDecoupleInput: boolean = false;

  // Interact tracking - Map by pointerId to support multitouch
  private _interactPointers: Map<number, { x: number; y: number; time: number }> = new Map();

  public constructor(game: Game) {
    this._game = game;

    this._setupEventListeners();
    this._setupInputListeners();
    this._setupPacketQueue();
  }

  public get inputEnabled(): boolean { return this._inputEnabled; }
  public get inputState(): Readonly<InputState> { return this._inputState; }
  public get isPointerLocked(): boolean { return this._isPointerLocked; }
  public get joystickDirection(): number | null { return this._joystickDirection; }

  public enableInput(enabled: boolean): void {
    if (!enabled) {
      Object.keys(this._inputState).forEach((key) => {
        if (this._inputState[key as keyof InputState]) {
          this._onInputChange(key, false);
        }
      });
    }
    
    this._inputEnabled = enabled;
  }

  public enableNetworkedInput(enabled: boolean): void {
    this._networkedInputEnabled = enabled;

    if (!enabled) {
      this._movementStateDirtyResendTicks = 0;
      this._wasMovementInputPressed = false;
      this._continuousInputState = {};
    }
  }

  public freezePointerLock(freeze: boolean): void {
    this._isPointerLockFrozen = freeze;
  }

  public lockPointer(lock: boolean, decoupleInput: boolean = false): void {
    if (MobileManager.isMobile) {
      return;
    }

    this._pointerLockRequestedDecoupleInput = decoupleInput;

    if (lock) {
      this._pointerLockRequested = true;
      this.requestPointerLock();
    } else {
      this._pointerLockRequested = false;
      document.exitPointerLock();
     
      // exitPointLock breaks breaks the event flow for mouseDown -> mouseUp.
      // If we exit pointer lock while the mouse is down, we need to manually
      // dispatch the mouse up event.
      window.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
      window.dispatchEvent(new MouseEvent('mouseup', { button: 2 }));
    }
  }

  public pressInput(input: string, pressed: boolean): void {
    this._onInputChange(input, pressed);
  }

  public setJoystickDirection(radians: number | null): void {
    if (this._joystickDirection !== radians) {
      this._movementStateDirtyResendTicks = MOVEMENT_STATE_DIRTY_RESEND_TICKS;
    }

    this._joystickDirection = radians;
    this._continuousInputState.jd = radians;
  }

  public requestPointerLock(): void {
    if (this._isPointerLockFrozen) {
      this._pointerLockRequested = false;
      return;
    }

    try {
      document.body.requestPointerLock({ unadjustedMovement: true }).catch(() => {
        // Linux browsers will throw a DOM exception with unadjustedMovement: true,
        // so we need to request without it as a fallback.
        document.body.requestPointerLock().catch(error => {
          console.warn('Failed to request pointer lock:', error);
        });
      });
    } catch (error) {
      console.warn('Failed to request pointer lock:', error);
    }
  }

  public onPress(input: string, callback: () => void): void {
    this._onPressCallback.set(input, callback);
  }

  private _setupEventListeners(): void {
    document.addEventListener('pointerlockchange', () => {
      this._isPointerLocked = document.pointerLockElement === document.body;

      if (!this._pointerLockRequestedDecoupleInput) {
        this.enableInput(this._isPointerLocked);
      }

      this._pointerLockRequestedDecoupleInput = false;

      if (this._isPointerLocked) {
        window.focus();
      }
    });
    document.addEventListener('pointerlockerror', (event) => console.warn('Pointer lock error', event));
    document.addEventListener('contextmenu', e => e.preventDefault()); // Disable right-click context menu
    document.addEventListener('click', () => {
      if (this._pointerLockRequested && !document.pointerLockElement && this._game.networkManager.worldPacketReceived) {
        this.requestPointerLock();
      }
    });

    EventRouter.instance.on(
      CameraEventType.GameCameraOrientationChange,
      this._onGameCameraOrientationChange,
    );
  }

  private _setupInputListeners(): void {
    window.addEventListener('keydown', (event) => this._onKeyboardInputChange(event.code, true));
    window.addEventListener('keyup', (event) => this._onKeyboardInputChange(event.code, false));
    window.addEventListener('mousedown', (event) => this._onInputChange(`mouse${event.button}`, true));
    window.addEventListener('mouseup', (event) => this._onInputChange(`mouse${event.button}`, false));
    window.addEventListener('pointerdown', (event) => this._onPointerDown(event));
    window.addEventListener('pointerup', (event) => this._onPointerUp(event));
    window.addEventListener('pointercancel', (event) => this._onPointerCancel(event));
    window.addEventListener('pointerleave', (event) => this._onPointerCancel(event));
  }

  private _setupPacketQueue(): void {
    // this could probably be just 30 in general...
    // twitch-inputs on desktop if not 60 might feel bad though.
    // we can change this to 30 when we have client prediction.
    const inputUpdateHz = MobileManager.isMobile ? 30 : 60;
    let previousQueueTickTimeS = performance.now() / 1000;
    
    setInterval(() => {
      const nowS = performance.now() / 1000;
      const queueDeltaS = Math.min(
        Math.max(nowS - previousQueueTickTimeS, 1 / 240),
        MOVEMENT_PACKET_MAX_DELTA_S,
      );
      previousQueueTickTimeS = nowS;

      if (!this._networkedInputEnabled) {
        this._continuousInputState = {};
        this._movementStateDirtyResendTicks = 0;
        this._wasMovementInputPressed = false;
        return;
      }

      const hasCameraOrientationChanges =
        this._continuousInputState.cp !== undefined ||
        this._continuousInputState.cy !== undefined;

      const hasMovementInputPressed =
        !!this._inputState.w ||
        !!this._inputState.a ||
        !!this._inputState.s ||
        !!this._inputState.d ||
        !!this._inputState.sp ||
        !!this._inputState.sh ||
        !!this._inputState.c ||
        this._joystickDirection !== null;

      const shouldResendMovementState = this._movementStateDirtyResendTicks > 0;
      const shouldSendMovementState = hasMovementInputPressed || shouldResendMovementState;
      const becameIdle = this._wasMovementInputPressed && !hasMovementInputPressed;

      if (!hasCameraOrientationChanges && !shouldSendMovementState) {
        this._wasMovementInputPressed = hasMovementInputPressed;
        return;
      }

      const inputPacket: Record<string, any> = {};

      if (shouldSendMovementState) {
        inputPacket.w = !!this._inputState.w;
        inputPacket.a = !!this._inputState.a;
        inputPacket.s = !!this._inputState.s;
        inputPacket.d = !!this._inputState.d;
        inputPacket.sp = !!this._inputState.sp;
        inputPacket.sh = !!this._inputState.sh;
        inputPacket.c = !!this._inputState.c;

        if (this._joystickDirection !== null || shouldResendMovementState) {
          inputPacket.jd = this._joystickDirection;
        }
      }

      if (this._continuousInputState.cp !== undefined) {
        inputPacket.cp = this._continuousInputState.cp;
      }

      if (this._continuousInputState.cy !== undefined) {
        inputPacket.cy = this._continuousInputState.cy;
      }

      const sequenceNumber = this._game.networkManager.sendInputPacket(
        inputPacket,
        becameIdle && shouldSendMovementState,
      );

      if (shouldSendMovementState && sequenceNumber !== undefined) {
        EventRouter.instance.emit(InputManagerEventType.MovementPacketSent, {
          sequenceNumber,
          deltaTimeS: queueDeltaS,
          yaw: this._game.camera.gameCameraYaw,
          joystickDirection: this._joystickDirection,
          w: !!this._inputState.w,
          a: !!this._inputState.a,
          s: !!this._inputState.s,
          d: !!this._inputState.d,
          sh: !!this._inputState.sh,
        });
      }

      this._continuousInputState = {};
      this._wasMovementInputPressed = hasMovementInputPressed;

      if (this._movementStateDirtyResendTicks > 0) {
        this._movementStateDirtyResendTicks--;
      }
    }, 1000 / inputUpdateHz);
  }

  private _onGameCameraOrientationChange = (payload: CameraEventPayload.GameCameraOrientationChange): void => {
    this._continuousInputState.cp = payload.pitch;
    this._continuousInputState.cy = payload.yaw;
  }

  private _onKeyboardInputChange = (code: string, isPressed: boolean): void => {
    // We use code instead of key to ensure consistent control based on key positions,
    // regardless of keyboard type or layout.
    const mappedInput = CODE_TO_KEY_MAP[code];
    if (mappedInput) {
      this._onInputChange(mappedInput, isPressed);
    }
  }

  private _onInputChange = (input: string, isPressed: boolean): void => {
    if (!this._inputEnabled) { return; }

    const onPressCallback = this._onPressCallback.get(input);

    if (isPressed && onPressCallback) {
      onPressCallback();
    }

    let mappedInput = SUPPORTED_INPUT_MAP[input];

    if (!mappedInput && SUPPORTED_INPUTS.includes(input as keyof InputState)) {
      mappedInput = input as keyof InputState;
    }

    if (mappedInput && this._inputState[mappedInput] !== isPressed) {
      this._inputState[mappedInput] = isPressed;
      
      if (this._networkedInputEnabled) {
        if (NETWORKED_MOVEMENT_INPUT_KEY_SET.has(mappedInput)) {
          this._movementStateDirtyResendTicks = MOVEMENT_STATE_DIRTY_RESEND_TICKS;
        } else {
          this._game.networkManager.sendInputPacket({ [mappedInput]: isPressed });
        }
      }
    }
  }

  private _onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;

    this._interactPointers.set(event.pointerId, {
      x: this._isPointerLocked ? window.innerWidth / 2 : event.clientX,
      y: this._isPointerLocked ? window.innerHeight / 2 : event.clientY,
      time: performance.now(),
    });
  }

  private _onPointerUp = (event: PointerEvent) => {
    if (event.button !== 0) return;

    const pointerData = this._interactPointers.get(event.pointerId);
    this._interactPointers.delete(event.pointerId);

    if (!pointerData) return;

    // Check if any UI element in the event path has a click/pointer listener
    if (this._game.uiManager.eventPathHasClickListener(event)) return;

    // Must be a quick click/tap
    const duration = performance.now() - pointerData.time;
    if (duration > INTERACT_TAP_MAX_DURATION_MS) return;

    const screenX = this._isPointerLocked ? window.innerWidth / 2 : event.clientX;
    const screenY = this._isPointerLocked ? window.innerHeight / 2 : event.clientY;

    // Must not be a click/tap & drag
    const dx = screenX - pointerData.x;
    const dy = screenY - pointerData.y;
    const distanceSq = dx * dx + dy * dy;
    if (distanceSq > INTERACT_DRAG_CANCEL_MAX_DISTANCE_SQ) return;
    
    const ray = this._game.camera.rayForInteract(screenX, screenY);

    if (this._game.networkManager.serverFeatures.supportsSceneInteract) {
      this._game.networkManager.sendInputPacket({
        ird: [ ray.direction.x, ray.direction.y, ray.direction.z ],
        iro: [ ray.origin.x, ray.origin.y, ray.origin.z ],
      });
    }
  }

  private _onPointerCancel = (event: PointerEvent) => {
    this._interactPointers.delete(event.pointerId);
  }
}
