// CSS2DRenderer appears to be a major performance bottleneck.
// To optimize it, we copied the code from Three.js addons and applied
// several optimizations, including ones based on Hytopia Client assumptions.
// Additionally, we rewrote the code from JavaScript to TypeScript.
// Concern: Reduced maintainability. When upgrading Three.js,
// we may need to manually check and apply updates to CSS2DRenderer.

import {
  Camera,
  Matrix4,
  Object3D,
  Scene,
  Vector2,
  Vector3,
} from 'three';
import { isAngleVisibilityCullingEnabled } from '../core/VisibilityCulling';

// Working variables
const tmpEl = document.createElement('div');
tmpEl.style.display = 'none';

export class CSS2DObject extends Object3D {
  private _element: HTMLElement = document.createElement('div');
  public distanceToCameraSquared: number = 0;
  public readonly center: Vector2 = new Vector2(0.5, 0.5); // ( 0, 0 ) is the lower left; ( 1, 1 ) is the top right
  public readonly isCSS2DObject: boolean = true;

  public get element(): HTMLElement {
    return this._element;
  }

  constructor() {
    super();

    this._element.style.position = 'absolute';
    this._element.style.userSelect = 'none';

    // As an optimization, set properties that are likely to be updated frequently.
    this._element.style.willChange = 'transform, display, zIndex';

    this._element.setAttribute('draggable', 'false');

    this.addEventListener('removed', () => {
      this.traverse(object => {
        if (object instanceof CSS2DObject) {
          object.element.parentNode?.removeChild(object.element);
        }
      });
    });
  }

  copy(source: CSS2DObject, recursive?: boolean): this {
    super.copy(source, recursive);
    this._element = source.element.cloneNode(true) as HTMLElement;
    this.center.copy(source.center);
    return this;
  }
}

// Working variables

const _vector = new Vector3();
const _a = new Vector3();

export type CSS2DParameters = {
  element?: HTMLElement;
};

export class CSS2DRenderer {
  public readonly domElement: HTMLElement;

  private _width: number = 2;
  private _height: number = 2;
  private _widthHalf: number = 1;
  private _heightHalf: number = 1;
  private _viewMatrix = new Matrix4();
  private _viewProjectionMatrix = new Matrix4();
  private _visibleObjects: CSS2DObject[] = [];

  public setSize(width: number, height: number): void {
    this._width = width;
    this._height = height;

    this._widthHalf = width / 2;
    this._heightHalf = height / 2;

    this.domElement.style.width = width + 'px';
    this.domElement.style.height = height + 'px';
  }

  constructor(parameters: CSS2DParameters = {}) {
    this.domElement = parameters.element !== undefined ? parameters.element : document.createElement('div');
    this.domElement.style.overflow = 'hidden';
  }

  public getSize(target: Vector2): Vector2 {
    return target.set(this._width, this._height);
  }

  public render(scene: Scene, camera: Camera): void {
    this._viewMatrix.copy(camera.matrixWorldInverse);
    this._viewProjectionMatrix.multiplyMatrices(camera.projectionMatrix, this._viewMatrix);
    _a.setFromMatrixPosition(camera.matrixWorld);

    // Assumes all the children are CSS2DObjects that don't have children
    for (let i = 0; i < scene.children.length; i++) {
      this._renderObject(scene.children[i] as CSS2DObject);
    }

    if (this._visibleObjects.length > 1) {
      this._zOrder();
    } else if (this._visibleObjects.length === 1) {
      const element = this._visibleObjects[0].element;
      if (element.style.zIndex !== '1') {
        element.style.zIndex = '1';
      }
    }

    this._visibleObjects.length = 0;
  }

  private _hideObject(object: CSS2DObject): void {
    // Since updating styles can sometimes cause side effects even if the value doesn’t change,
    // optimize by setting the value only when there is a difference.
    if (object.element.style.display !== 'none') {
      object.element.style.display = 'none';
    }
  }

  private _showObject(object: CSS2DObject): void {
    if (object.element.style.display !== '') {
      object.element.style.display = '';
    }
  }

  private _renderObject(object: CSS2DObject): void {
    if (!object.visible) {
      this._hideObject(object);
      return;
    }

    const matrixWorld = object.matrixWorld.elements;
    const worldX = matrixWorld[12];
    const worldY = matrixWorld[13];
    const worldZ = matrixWorld[14];

    _vector.set(worldX, worldY, worldZ);
    _vector.applyMatrix4(this._viewProjectionMatrix);

    // As an optimization, make CSS2DObjects outside the viewport invisible similar to Frustum culling.
    // TODO: There is no fast way to get an entire HTMLElement’s width and height,
    // so we cannot quickly and accurately tell whether any part of the element is
    // on-screen. .getBoundingClientRect() returns the size, but may trigger a reflow
    // and hurt performance. We could capture the size once when the CSS2DObject is
    // created, yet detecting subsequent size changes would be hard. For now we add
    // a margin to the x and y coordinates and decide visibility by the element’s
    // center. This is imperfect: if the center lies off-screen, a large element
    // whose edge is on-screen may be misclassified as off-screen. We should seek a
    // better method that balances performance and accuracy; if the overhead is not
    // significant, simply ignoring the x and y checks might be another option.
    const visible = isAngleVisibilityCullingEnabled()
      ? (_vector.x >= -1.25 && _vector.x <= 1.25) &&
        (_vector.y >= -1.25 && _vector.y <= 1.25) &&
        (_vector.z >= -1 && _vector.z <= 1)
      : (_vector.z >= -1 && _vector.z <= 1);

    if (!visible) {
      this._hideObject(object);
      return;
    }

    this._showObject(object);
    this._visibleObjects.push(object);

    const element = object.element;

    // Since strings assigned to style.transform are formatted by the browser, assign
    // the value to the style.transform of an invisible temporary element first and
    // then compare it.
    // Use translate3d instead of translate to force GPU compositing and avoid CPU style recalc
    tmpEl.style.transform = 'translate3d(' + (-100 * object.center.x) + '%,' + (-100 * object.center.y) + '%, 0)' + 'translate3d(' + (_vector.x * this._widthHalf + this._widthHalf) + 'px,' + (-_vector.y * this._heightHalf + this._heightHalf) + 'px, 0)';

    if (element.style.transform !== tmpEl.style.transform) {
      element.style.transform = tmpEl.style.transform;
    }

    const deltaX = _a.x - worldX;
    const deltaY = _a.y - worldY;
    const deltaZ = _a.z - worldZ;
    object.distanceToCameraSquared = deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ;
  };

  private _zOrder(): void {
    this._visibleObjects.sort((a: CSS2DObject, b: CSS2DObject) => {
      return a.distanceToCameraSquared - b.distanceToCameraSquared;
    });

    const zMax = this._visibleObjects.length;

    for (let i = 0; i < zMax; i++) {
      const newZIndex = `${zMax - i}`;
      if (this._visibleObjects[i].element.style.zIndex !== newZIndex) {
        this._visibleObjects[i].element.style.zIndex = newZIndex;
      }
    }
  }
}
