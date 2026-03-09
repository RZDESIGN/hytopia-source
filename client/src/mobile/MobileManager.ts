import isMobile from 'is-mobile';
import Game from '../Game';

export const RUN_FORCE_THRESHOLD = 0.75;
export const WALK_FORCE_THRESHOLD = 0.1;
export const MOVE_ZONE_WIDTH_PERCENT = 0.4;

type JoystickPosition = { x: number; y: number };
type NippleJoystick = {
  el?: HTMLElement | null;
  identifier: number;
  position: JoystickPosition;
};
type NippleJoystickOutputData = {
  angle: { degree: number };
  force: number;
  identifier: number;
  raw: { position: JoystickPosition };
};
type NippleJoystickManager = {
  get(id: number): { destroy(): void } | undefined;
  on(event: string, callback: (_evt: unknown, data: unknown) => void): void;
};

export default class MobileManager {
  public static readonly isMobile: boolean = 
    isMobile({ tablet: true, featureDetect: true }) || 
    ('ontouchstart' in window && navigator.maxTouchPoints > 1);
  
  private _game: Game;
  private _joystickManager: NippleJoystickManager | undefined;
  
  public constructor(game: Game) {
    this._game = game;

    if (!MobileManager.isMobile) return;

    document.documentElement.classList.add('mobile');
    document.body.classList.add('mobile');
    void this._loadJoysticks();
  }

  private _isMoveJoystick(position: { x: number; y: number }): boolean {
    return position.x < document.documentElement.clientWidth * MOVE_ZONE_WIDTH_PERCENT;
  }

  private async _loadJoysticks(): Promise<void> {
    try {
      const { default: nipplejs } = await import('nipplejs');

      this._joystickManager = nipplejs.create({
        zone: document.body,
        mode: 'dynamic',
        color: 'white',
        restOpacity: 0,
        size: 100,
        multitouch: true,
        maxNumberOfNipples: 3, // 1 move + 2 camera max
      }) as unknown as NippleJoystickManager;

      this._setupJoysticks();
    } catch (error) {
      console.error('MobileManager: Failed to load joystick controls.', error);
    }
  }

  private _setupJoysticks(): void {
    if (!this._joystickManager) return;

    const releaseMovement = () => {
      this._game.inputManager.setJoystickDirection(null);
      this._game.inputManager.pressInput('shift', false);
    };

    // Track joystick types by ID
    const moveJoystickIds = new Set<number>();
    const cameraJoystickIds = new Set<number>();
    const cameraPositions = new Map<number, { x: number; y: number }>();
    let lastPinchDist: number | null = null;

    const resetAllJoysticks = () => {
      if (!this._joystickManager) return;

      for (const id of moveJoystickIds) {
        this._joystickManager.get(id)?.destroy();
      }
      for (const id of cameraJoystickIds) {
        this._joystickManager.get(id)?.destroy();
      }

      moveJoystickIds.clear();
      cameraJoystickIds.clear();
      cameraPositions.clear();
      lastPinchDist = null;
      releaseMovement();
    };

    this._joystickManager.on('start', (_, data: unknown) => {
      const joystick = data as NippleJoystick;

      if (this._isMoveJoystick(joystick.position)) {
        // If a move joystick is already active, destroy the OLD one first
        // This handles rapid touches on low-end devices that create duplicates
        if (moveJoystickIds.size > 0) {
          for (const id of moveJoystickIds) {
            this._joystickManager?.get(id)?.destroy();
          }
          moveJoystickIds.clear();
          releaseMovement();
        }

        moveJoystickIds.add(joystick.identifier);
      } else {
        cameraJoystickIds.add(joystick.identifier);
        if (joystick.el) joystick.el.style.visibility = 'hidden';
      }

      if (joystick.el) joystick.el.style.pointerEvents = 'none';
    });

    this._joystickManager.on('move', (_, data: unknown) => {
      const joystickData = data as NippleJoystickOutputData;

      if (moveJoystickIds.has(joystickData.identifier)) {
        // Move joystick
        if (joystickData.force < WALK_FORCE_THRESHOLD) return releaseMovement();

        this._game.inputManager.setJoystickDirection((joystickData.angle.degree - 90) * Math.PI / 180);
        this._game.inputManager.pressInput('shift', joystickData.force >= RUN_FORCE_THRESHOLD);
      } else if (cameraJoystickIds.has(joystickData.identifier)) {
        // Camera joystick
        const count = cameraJoystickIds.size;

        if (count === 1) {
          const lastPos = cameraPositions.get(joystickData.identifier);

          if (lastPos) {
            this._game.camera.handleMobileCameraMovement(
              joystickData.raw.position.x - lastPos.x,
              joystickData.raw.position.y - lastPos.y
            );
          }

          cameraPositions.set(joystickData.identifier, joystickData.raw.position);
          lastPinchDist = null;
        } else if (count === 2) {
          cameraPositions.set(joystickData.identifier, joystickData.raw.position);

          if (cameraPositions.size === 2) {
            const iter = cameraPositions.values();
            const p1 = iter.next().value!;
            const p2 = iter.next().value!;
            const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);

            if (lastPinchDist !== null) {
              this._game.camera.handleMobileCameraZoom(lastPinchDist - dist);
            }
            
            lastPinchDist = dist;
          }
        }
      }
    });

    const cleanupJoystick = (id: number) => {
      if (moveJoystickIds.has(id)) {
        moveJoystickIds.delete(id);
        releaseMovement();
      } else if (cameraJoystickIds.has(id)) {
        cameraJoystickIds.delete(id);
        cameraPositions.clear();
        lastPinchDist = null;
      }
    }

    this._joystickManager.on('end', (_, data: unknown) => cleanupJoystick((data as NippleJoystick).identifier));
    this._joystickManager.on('destroyed', (_, data: unknown) => cleanupJoystick((data as NippleJoystick).identifier));

    window.addEventListener('blur', resetAllJoysticks);
    window.addEventListener('pagehide', resetAllJoysticks);
    window.addEventListener('pointercancel', resetAllJoysticks);
    window.addEventListener('touchcancel', resetAllJoysticks);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) resetAllJoysticks();
    });
  }
}
