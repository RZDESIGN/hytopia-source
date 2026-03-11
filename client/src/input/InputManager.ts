import Game from '../Game';
import EventRouter from '../events/EventRouter';
import MobileManager from '../mobile/MobileManager';
import {
  DEFAULT_ROLLBACK_PREDICTED_INPUT_SET,
  type RollbackPredictedInputSnapshot,
  type RollbackPredictableInput,
} from '@gameplay-shared/InputContract';
import { CameraEventType } from '../core/Camera';
import type { CameraEventPayload } from '../core/Camera';
import type { NetworkManagerEventPayload } from '../network/NetworkEventPayloads';
import { NetworkManagerEventType } from '../network/NetworkEvents';

// Max duration in ms for a tap/click (vs hold)
const INTERACT_TAP_MAX_DURATION_MS = 200;

// Max distance squared in pixels for a drag (vs tap) - 30px radius
const INTERACT_DRAG_CANCEL_MAX_DISTANCE_SQ = 900;
const MOVEMENT_STATE_DIRTY_RESEND_TICKS = 3;
const MOVEMENT_PACKET_MIN_DELTA_S = 1 / 240;
const MOVEMENT_PACKET_MAX_DELTA_S = 1 / 10;
const MOBILE_INPUT_UPDATE_HZ = 30;
const DESKTOP_INPUT_UPDATE_HZ = 60;
const MAX_FIRST_PERSON_INPUT_UPDATE_HZ = 120;
const GAMEPAD_LEFT_STICK_DEADZONE = 0.18;
const GAMEPAD_RIGHT_STICK_DEADZONE = 0.12;
const GAMEPAD_RUN_THRESHOLD = 0.7;
const GAMEPAD_TRIGGER_THRESHOLD = 0.45;

const GAMEPAD_BUTTON_BINDINGS = [
  [0, 'sp'],
  [6, 'mr'],
  [7, 'ml'],
] as const;

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

type InputSource = 'hardware' | 'virtual' | 'gamepad';
type InputSourceState = Record<InputSource, InputState>;
type JoystickInputSource = 'virtual' | 'gamepad';
type InteractPointerState = {
  sentInteract: boolean;
  time: number;
  x: number;
  y: number;
};
type StickState = {
  x: number;
  y: number;
  magnitude: number;
};

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

const SUPPORTED_INPUTS = new Set(Object.values(SUPPORTED_INPUT_MAP));

export enum InputManagerEventType {
  MovementPacketSent = 'INPUT_MANAGER.MOVEMENT_PACKET_SENT',
}

export namespace InputManagerEventPayload {
  export interface IMovementPacketSent {
    sequenceNumber: number;
    deltaTimeS: number;
    yaw: number;
    joystickDirection: number | null;
    rollbackInputs: Readonly<RollbackPredictedInputSnapshot>;
    w: boolean;
    a: boolean;
    s: boolean;
    d: boolean;
    sp: boolean;
    sh: boolean;
    c: boolean;
  }
}

export default class InputManager {
  private _game: Game;
  private _isPointerLocked = false;
  private _isPointerLockFrozen = false;
  private _inputEnabled: boolean = true;
  private _inputState: InputState = {};
  private _inputStateBySource: InputSourceState = {
    hardware: {},
    virtual: {},
    gamepad: {},
  };
  private _joystickDirection: number | null = null;
  private _wasMovementInputPressed: boolean = false;
  private _movementStateDirtyResendTicks: number = 0;
  private _networkedInputEnabled: boolean = true;
  private _continuousInputState: ContinuousInputState = {};
  private _joystickDirectionBySource: Partial<Record<JoystickInputSource, number | null>> = {};
  private _onPressCallback: Map<string, () => void> = new Map();
  private _pointerLockRequested = !MobileManager.isMobile;
  private _pointerLockRequestedDecoupleInput: boolean = false;
  private _preferredGamepadIndex: number | undefined;
  private _moveStickState: StickState = { x: 0, y: 0, magnitude: 0 };
  private _lookStickState: StickState = { x: 0, y: 0, magnitude: 0 };
  private _lastMovementPacketTickTimeS: number = 0;
  private _movementPacketTimerId: number | undefined;
  private _movementPacketImmediateFlushScheduled: boolean = false;
  private _serverMovementTickHz: number | undefined;

  // Interact tracking - Map by pointerId to support multitouch
  private _interactPointers: Map<number, InteractPointerState> = new Map();

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
      this._clearInputSource('hardware');
      this._clearInputSource('virtual');
      this._clearInputSource('gamepad');
      this._setJoystickDirectionForSource('virtual', undefined);
      this._setJoystickDirectionForSource('gamepad', undefined);
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
    this._onInputChange(input, pressed, 'virtual');
  }

  public setJoystickDirection(radians: number | null): void {
    this._setJoystickDirectionForSource('virtual', radians);
  }

  public update(frameDeltaS: number): void {
    this._updateGamepadInput(frameDeltaS);
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

    EventRouter.instance.on(
      NetworkManagerEventType.WorldPacket,
      this._onWorldPacket,
    );
  }

  private _setupInputListeners(): void {
    window.addEventListener('keydown', (event) => {
      if (!event.repeat) {
        this._onKeyboardInputChange(event.code, true);
      }
    });
    window.addEventListener('keyup', (event) => this._onKeyboardInputChange(event.code, false));
    window.addEventListener('mousedown', (event) => {
      this._maybePredictDefaultBlockEditFromMouseDown(event);
      this._onInputChange(`mouse${event.button}`, true, 'hardware');
    });
    window.addEventListener('mouseup', (event) => this._onInputChange(`mouse${event.button}`, false, 'hardware'));
    window.addEventListener('pointerdown', (event) => this._onPointerDown(event));
    window.addEventListener('pointerup', (event) => this._onPointerUp(event));
    window.addEventListener('pointercancel', (event) => this._onPointerCancel(event));
    window.addEventListener('pointerleave', (event) => this._onPointerCancel(event));
  }

  private _setupPacketQueue(): void {
    this._lastMovementPacketTickTimeS = performance.now() / 1000;
    this._scheduleNextMovementPacketTick();
  }

  private _scheduleNextMovementPacketTick(): void {
    this._movementPacketTimerId = window.setTimeout(
      this._tickMovementPacketQueue,
      1000 / this._getMovementPacketUpdateHz(),
    );
  }

  private _tickMovementPacketQueue = (): void => {
    this._drainPacketQueue(this._consumeMovementPacketQueueDeltaS());
    this._scheduleNextMovementPacketTick();
  }

  private _consumeMovementPacketQueueDeltaS(): number {
    const nowS = performance.now() / 1000;
    const queueDeltaS = Math.min(
      Math.max(nowS - this._lastMovementPacketTickTimeS, MOVEMENT_PACKET_MIN_DELTA_S),
      MOVEMENT_PACKET_MAX_DELTA_S,
    );
    this._lastMovementPacketTickTimeS = nowS;

    return queueDeltaS;
  }

  private _scheduleImmediateMovementPacketFlush(): void {
    if (
      this._movementPacketImmediateFlushScheduled ||
      !this._networkedInputEnabled
    ) {
      return;
    }

    this._movementPacketImmediateFlushScheduled = true;
    queueMicrotask(() => {
      this._movementPacketImmediateFlushScheduled = false;

      if (!this._networkedInputEnabled) {
        return;
      }

      if (this._movementPacketTimerId !== undefined) {
        window.clearTimeout(this._movementPacketTimerId);
        this._movementPacketTimerId = undefined;
      }

      this._drainPacketQueue(this._consumeMovementPacketQueueDeltaS());
      this._scheduleNextMovementPacketTick();
    });
  }

  private _getRollbackPredictedInputSet(): ReadonlySet<RollbackPredictableInput> {
    return this._game.entityManager?.localRollbackPredictedInputSet ?? DEFAULT_ROLLBACK_PREDICTED_INPUT_SET;
  }

  private _hasRollbackPredictedInputPressed(
    rollbackPredictedInputSet: ReadonlySet<RollbackPredictableInput>,
  ): boolean {
    for (const input of rollbackPredictedInputSet) {
      if (input === 'jd') {
        if (this._joystickDirection !== null) {
          return true;
        }

        continue;
      }

      if (this._inputState[input as keyof InputState]) {
        return true;
      }
    }

    return false;
  }

  private _createRollbackPredictedInputSnapshot(
    rollbackPredictedInputSet: ReadonlySet<RollbackPredictableInput>,
  ): RollbackPredictedInputSnapshot {
    const snapshot: RollbackPredictedInputSnapshot = {};

    for (const input of rollbackPredictedInputSet) {
      if (input === 'jd') {
        snapshot.jd = this._joystickDirection;
        continue;
      }

      snapshot[input] = !!this._inputState[input as keyof InputState];
    }

    return snapshot;
  }

  private _drainPacketQueue(queueDeltaS: number): void {
    if (!this._networkedInputEnabled) {
      this._continuousInputState = {};
      this._movementStateDirtyResendTicks = 0;
      this._wasMovementInputPressed = false;
      return;
    }

    const hasCameraOrientationChanges =
      this._continuousInputState.cp !== undefined ||
      this._continuousInputState.cy !== undefined;
    const rollbackPredictedInputSet = this._getRollbackPredictedInputSet();

    const hasMovementInputPressed = this._hasRollbackPredictedInputPressed(
      rollbackPredictedInputSet,
    );

    const shouldResendMovementState = this._movementStateDirtyResendTicks > 0;
    const shouldSendMovementState = hasMovementInputPressed || shouldResendMovementState;
    const becameIdle = this._wasMovementInputPressed && !hasMovementInputPressed;

    if (!hasCameraOrientationChanges && !shouldSendMovementState) {
      this._wasMovementInputPressed = hasMovementInputPressed;
      return;
    }

    const inputPacket: Record<string, any> = {};
    const rollbackInputs = shouldSendMovementState
      ? this._createRollbackPredictedInputSnapshot(rollbackPredictedInputSet)
      : undefined;

    if (shouldSendMovementState) {
      for (const input of rollbackPredictedInputSet) {
        if (input === 'jd') {
          if (rollbackInputs?.jd !== undefined) {
            inputPacket.jd = rollbackInputs.jd;
          }

          continue;
        }

        inputPacket[input] = rollbackInputs?.[input] ?? false;
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
        rollbackInputs: rollbackInputs ?? {},
        w: !!this._inputState.w,
        a: !!this._inputState.a,
        s: !!this._inputState.s,
        d: !!this._inputState.d,
        sp: !!this._inputState.sp,
        sh: !!this._inputState.sh,
        c: !!this._inputState.c,
      });
    }

    this._continuousInputState = {};
    this._wasMovementInputPressed = hasMovementInputPressed;

    if (this._movementStateDirtyResendTicks > 0) {
      this._movementStateDirtyResendTicks--;
    }
  }

  private _shouldImmediatelyFlushSequencedMovement(): boolean {
    // The server consumes queued movement state once per fixed world tick,
    // regardless of camera mode. Immediate mid-tick flushes create extra local
    // replay snapshots that the server never simulates, which shows up as
    // buffered jitter during rapid movement/direction changes.
    return this._serverMovementTickHz === undefined;
  }

  private _getMovementPacketUpdateHz(): number {
    const serverTickHz = this._serverMovementTickHz;
    if (MobileManager.isMobile) {
      return serverTickHz !== undefined
        ? Math.min(MOBILE_INPUT_UPDATE_HZ, serverTickHz)
        : MOBILE_INPUT_UPDATE_HZ;
    }

    let desiredHz = DESKTOP_INPUT_UPDATE_HZ;

    if (!this._game.camera?.isFirstPersonGameCameraActive) {
      return serverTickHz !== undefined
        ? Math.min(desiredHz, serverTickHz)
        : desiredHz;
    }

    const refreshRate = this._game.performanceMetricsManager.refreshRate;
    if (refreshRate && Number.isFinite(refreshRate)) {
      desiredHz = Math.min(
        MAX_FIRST_PERSON_INPUT_UPDATE_HZ,
        Math.max(DESKTOP_INPUT_UPDATE_HZ, refreshRate),
      );
    }

    return serverTickHz !== undefined
      ? Math.min(desiredHz, serverTickHz)
      : desiredHz;
  }

  private _onWorldPacket = (payload: NetworkManagerEventPayload.IWorldPacket): void => {
    const timestepS = payload.deserializedWorld.timestep;
    if (
      typeof timestepS !== 'number' ||
      !Number.isFinite(timestepS) ||
      timestepS <= 0
    ) {
      return;
    }

    // The server consumes queued sequenced movement input once per world tick,
    // so sending faster than the fixed tick rate only creates extra client-side
    // replay states that the server never simulates.
    this._serverMovementTickHz = Math.min(
      MAX_FIRST_PERSON_INPUT_UPDATE_HZ,
      Math.max(1, 1 / timestepS),
    );
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
      this._onInputChange(mappedInput, isPressed, 'hardware');
    }
  }

  private _onInputChange = (input: string, isPressed: boolean, source: InputSource): void => {
    if (!this._inputEnabled) { return; }

    const onPressCallback = this._onPressCallback.get(input);

    if (isPressed && onPressCallback) {
      onPressCallback();
    }

    let mappedInput = SUPPORTED_INPUT_MAP[input];

    if (!mappedInput && SUPPORTED_INPUTS.has(input as keyof InputState)) {
      mappedInput = input as keyof InputState;
    }

    if (!mappedInput) {
      return;
    }

    const wasMergedPressed = !!this._inputState[mappedInput];

    const sourceState = this._inputStateBySource[source];

    if (!!sourceState[mappedInput] === isPressed) {
      return;
    }

    if (isPressed) {
      sourceState[mappedInput] = true;
    } else {
      delete sourceState[mappedInput];
    }

    this._syncMergedInput(mappedInput);

    if (
      source === 'gamepad' &&
      isPressed &&
      !wasMergedPressed &&
      (mappedInput === 'ml' || mappedInput === 'mr')
    ) {
      this._predictDefaultBlockEdit(mappedInput);
    }
  }

  private _syncMergedInput(input: keyof InputState): void {
    const isPressed =
      !!this._inputStateBySource.hardware[input] ||
      !!this._inputStateBySource.virtual[input] ||
      !!this._inputStateBySource.gamepad[input];

    if (!!this._inputState[input] === isPressed) {
      return;
    }

    if (isPressed) {
      this._inputState[input] = true;
    } else {
      delete this._inputState[input];
    }

    if (this._networkedInputEnabled) {
      if (this._getRollbackPredictedInputSet().has(input as RollbackPredictableInput)) {
        this._movementStateDirtyResendTicks = MOVEMENT_STATE_DIRTY_RESEND_TICKS;
        if (this._shouldImmediatelyFlushSequencedMovement()) {
          this._scheduleImmediateMovementPacketFlush();
        }
      } else {
        this._game.networkManager.sendInputPacket({ [input]: isPressed });
      }
    }
  }

  private _maybePredictDefaultBlockEditFromMouseDown(event: MouseEvent): void {
    if (event.button !== 0 && event.button !== 2) {
      return;
    }

    if (
      !this._isPointerLocked &&
      this._game.uiManager.eventPathHasClickListener(event as unknown as PointerEvent)
    ) {
      return;
    }

    const screenX = this._isPointerLocked ? window.innerWidth / 2 : event.clientX;
    const screenY = this._isPointerLocked ? window.innerHeight / 2 : event.clientY;
    this._predictDefaultBlockEdit(event.button === 0 ? 'ml' : 'mr', screenX, screenY);
  }

  private _predictDefaultBlockEdit(
    input: 'ml' | 'mr',
    screenX: number = window.innerWidth / 2,
    screenY: number = window.innerHeight / 2,
  ): boolean {
    if (
      !this._game.camera.isGameCameraActive ||
      !this._game.networkManager.serverFeatures.supportsDefaultBlockEditPrediction
    ) {
      return false;
    }

    const predictionConfig = this._game.networkManager.defaultBlockEditPredictionConfig;
    const hit = this._game.chunkManager.raycastBlockFromCamera(
      screenX,
      screenY,
      predictionConfig.maxDistance,
    );

    if (!hit) {
      return false;
    }

    const hitBlockType = this._game.blockTypeManager.getBlockType(hit.blockId);

    if (input === 'ml') {
      if (hitBlockType?.isLiquid) {
        return false;
      }

      return this._game.chunkManager.submitPredictedBlocks([
        {
          globalCoordinate: hit.globalCoordinate,
          blockId: 0,
        },
      ]) !== undefined;
    }

    if (predictionConfig.placeBlockTypeId <= 0) {
      return false;
    }

    const placementCoordinate = hitBlockType?.isLiquid
      ? hit.globalCoordinate
      : hit.neighborGlobalCoordinate;

    return this._game.chunkManager.submitPredictedBlocks([
      {
        globalCoordinate: placementCoordinate,
        blockId: predictionConfig.placeBlockTypeId,
        blockRotationIndex: predictionConfig.placeBlockRotationIndex,
      },
    ]) !== undefined;
  }

  private _clearInputSource(source: InputSource): void {
    const sourceState = this._inputStateBySource[source];
    const activeInputs = Object.keys(sourceState) as (keyof InputState)[];

    if (activeInputs.length === 0) {
      return;
    }

    this._inputStateBySource[source] = {};

    activeInputs.forEach((input) => this._syncMergedInput(input));
  }

  private _setJoystickDirectionForSource(source: JoystickInputSource, radians: number | null | undefined): void {
    const previousDirection = this._joystickDirection;

    if (radians === undefined) {
      delete this._joystickDirectionBySource[source];
    } else {
      this._joystickDirectionBySource[source] = radians;
    }

    const nextDirection = this._getMergedJoystickDirection() ?? null;

    if (previousDirection !== nextDirection) {
      this._joystickDirection = nextDirection;
      this._movementStateDirtyResendTicks = MOVEMENT_STATE_DIRTY_RESEND_TICKS;
      this._continuousInputState.jd = nextDirection;
      if (this._shouldImmediatelyFlushSequencedMovement()) {
        this._scheduleImmediateMovementPacketFlush();
      }
    }
  }

  private _getMergedJoystickDirection(): number | null | undefined {
    if (this._joystickDirectionBySource.virtual !== undefined) {
      return this._joystickDirectionBySource.virtual;
    }

    return this._joystickDirectionBySource.gamepad;
  }

  private _updateGamepadInput(frameDeltaS: number): void {
    if (!this._inputEnabled) {
      this._clearGamepadState();
      return;
    }

    const gamepads = navigator.getGamepads?.();

    if (!gamepads?.length) {
      this._preferredGamepadIndex = undefined;
      this._clearGamepadState();
      return;
    }

    const gamepad = this._getActiveGamepad(gamepads);

    if (!gamepad) {
      this._preferredGamepadIndex = undefined;
      this._clearGamepadState();
      return;
    }

    this._preferredGamepadIndex = gamepad.index;

    const hasMoveStick = this._normalizeStick(
      gamepad.axes[0] ?? 0,
      gamepad.axes[1] ?? 0,
      GAMEPAD_LEFT_STICK_DEADZONE,
      this._moveStickState,
    );
    const hasLookStick = this._normalizeStick(
      gamepad.axes[2] ?? 0,
      gamepad.axes[3] ?? 0,
      GAMEPAD_RIGHT_STICK_DEADZONE,
      this._lookStickState,
    );

    if (hasLookStick) {
      this._game.camera.handleGamepadCameraMovement(this._lookStickState.x, this._lookStickState.y, frameDeltaS);
    }

    if (this._game.camera.isGameCameraActive && hasMoveStick) {
      // Keep gamepad movement aligned with the existing mobile joystick convention used by the server.
      this._setJoystickDirectionForSource('gamepad', Math.atan2(-this._moveStickState.x, -this._moveStickState.y));
      this._onInputChange('shift', this._moveStickState.magnitude >= GAMEPAD_RUN_THRESHOLD, 'gamepad');
    } else {
      this._setJoystickDirectionForSource('gamepad', undefined);
      this._onInputChange('shift', false, 'gamepad');
    }

    for (const [buttonIndex, input] of GAMEPAD_BUTTON_BINDINGS) {
      const button = gamepad.buttons[buttonIndex];
      const pressed = !!button && (button.pressed || button.value >= GAMEPAD_TRIGGER_THRESHOLD);
      this._onInputChange(input, pressed, 'gamepad');
    }
  }

  private _getActiveGamepad(gamepads: readonly (Gamepad | null)[]): Gamepad | undefined {
    if (this._preferredGamepadIndex !== undefined) {
      const preferredGamepad = gamepads[this._preferredGamepadIndex];
      if (preferredGamepad?.connected) {
        return preferredGamepad;
      }
    }

    for (const gamepad of gamepads) {
      if (gamepad?.connected) {
        return gamepad;
      }
    }

    return undefined;
  }

  private _normalizeStick(x: number, y: number, deadzone: number, target: StickState): boolean {
    const magnitude = Math.hypot(x, y);

    if (magnitude <= deadzone) {
      target.x = 0;
      target.y = 0;
      target.magnitude = 0;
      return false;
    }

    const normalizedMagnitude = Math.min(1, (magnitude - deadzone) / (1 - deadzone));
    const scale = normalizedMagnitude / magnitude;

    target.x = x * scale;
    target.y = y * scale;
    target.magnitude = normalizedMagnitude;

    return true;
  }

  private _clearGamepadState(): void {
    this._clearInputSource('gamepad');
    this._setJoystickDirectionForSource('gamepad', undefined);
  }

  private _onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;

    const screenX = this._isPointerLocked ? window.innerWidth / 2 : event.clientX;
    const screenY = this._isPointerLocked ? window.innerHeight / 2 : event.clientY;
    const pointerState: InteractPointerState = {
      sentInteract: false,
      time: performance.now(),
      x: screenX,
      y: screenY,
    };

    this._interactPointers.set(event.pointerId, pointerState);

    if (
      this._isPointerLocked &&
      event.pointerType === 'mouse' &&
      !this._game.uiManager.eventPathHasClickListener(event)
    ) {
      pointerState.sentInteract = this._sendSceneInteract(screenX, screenY);
    }
  }

  private _sendSceneInteract(screenX: number, screenY: number): boolean {
    if (!this._game.networkManager.serverFeatures.supportsSceneInteract) {
      return false;
    }

    const ray = this._game.camera.rayForInteract(screenX, screenY);

    this._game.networkManager.sendInputPacket({
      ird: [ ray.direction.x, ray.direction.y, ray.direction.z ],
      iro: [ ray.origin.x, ray.origin.y, ray.origin.z ],
    });

    return true;
  }

  private _onPointerUp = (event: PointerEvent) => {
    if (event.button !== 0) return;

    const pointerData = this._interactPointers.get(event.pointerId);
    this._interactPointers.delete(event.pointerId);

    if (!pointerData || pointerData.sentInteract) return;

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
    
    this._sendSceneInteract(screenX, screenY);
  }

  private _onPointerCancel = (event: PointerEvent) => {
    this._interactPointers.delete(event.pointerId);
  }
}
