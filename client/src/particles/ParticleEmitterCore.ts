import {
  Box3,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  Euler,
  FrontSide,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix3,
  Matrix4,
  PlaneGeometry,
  ShaderMaterial,
  Sphere,
  Texture,
  Vector3,
} from 'three';

export type ParticleEmitterOrientation = 'billboard' | 'billboardY' | 'fixed' | 'velocity';

// Attribute name constants
const ATTR_INITIAL_POSITION = 'initialPosition';
const ATTR_INITIAL_VELOCITY = 'initialVelocity';
const ATTR_SIZE_VAR = 'sizeVar'; // vec2: x=sizeStart, y=sizeEnd
const ATTR_TIME_VAR = 'timeVar'; // vec2: x=startTime, y=maxLife
const ATTR_OPACITY_VAR = 'opacityVar'; // vec2: x=opacityStart, y=opacityEnd
const ATTR_COLOR_START_VAR = 'colorStartVar';
const ATTR_COLOR_END_VAR = 'colorEndVar';

const UNIFORM_MAP = 'map';
const UNIFORM_TIME = 'time';
const UNIFORM_GRAVITY = 'gravity';
const UNIFORM_ALPHATEST = 'alphaTest';
const UNIFORM_ORIENTATION_MATRIX = 'orientationMatrix';

const DEFINE_USE_ALPHATEST = 'USE_ALPHATEST';
const DEFINE_ORIENTATION_BILLBOARD = 'ORIENTATION_BILLBOARD';
const DEFINE_ORIENTATION_BILLBOARD_Y = 'ORIENTATION_BILLBOARD_Y';
const DEFINE_ORIENTATION_FIXED = 'ORIENTATION_FIXED';
const DEFINE_ORIENTATION_VELOCITY = 'ORIENTATION_VELOCITY';
const DEFINE_LOCK_TO_EMITTER = 'LOCK_TO_EMITTER';

// Working variables
const attributes: InstancedBufferAttribute[] = [];
const tempVector3 = new Vector3();
const tempEuler = new Euler();
const tempMatrix3 = new Matrix3();
const tempMatrix4 = new Matrix4();
const DEG2RAD = Math.PI / 180;

// Helper function to convert orientation to define name
function orientationToDefine(orientation: ParticleEmitterOrientation): string {
  switch (orientation) {
    case 'billboard': return DEFINE_ORIENTATION_BILLBOARD;
    case 'billboardY': return DEFINE_ORIENTATION_BILLBOARD_Y;
    case 'fixed': return DEFINE_ORIENTATION_FIXED;
    case 'velocity': return DEFINE_ORIENTATION_VELOCITY;
    default: return DEFINE_ORIENTATION_BILLBOARD;
  }
}

// Helper function to create rotation matrix from Euler angles in degrees
// Note: Returns tempMatrix3, caller must copy if needed
function createOrientationMatrix(rotationDegrees: Vector3): Matrix3 {
  tempEuler.set(
    rotationDegrees.x * DEG2RAD,
    rotationDegrees.y * DEG2RAD,
    rotationDegrees.z * DEG2RAD,
    'XYZ'
  );
  tempMatrix3.setFromMatrix4(tempMatrix4.makeRotationFromEuler(tempEuler));
  return tempMatrix3;
}

export interface ParticleEmitterCoreOptions {
  alphaTest?: number;

  colorStart?: Color;
  colorEnd?: Color;
  colorStartVariance?: Color;
  colorEndVariance?: Color;
  colorIntensityStart?: number;
  colorIntensityEnd?: number;
  colorIntensityStartVariance?: number;
  colorIntensityEndVariance?: number;

  gravity?: Vector3;

  lifetime?: number;
  lifetimeVariance?: number;

  // When enabled, emitted particles follow the emitter's world position.
  // IMPORTANT: This option cannot be changed after construction because
  // initialPosition attribute stores different coordinate spaces based on this flag:
  // - lockToEmitter=false: initialPosition is in world space
  // - lockToEmitter=true: initialPosition is in local space (relative to emitter)
  // Changing this at runtime would cause existing particles to render incorrectly.
  lockToEmitter?: boolean;

  maxParticles?: number;

  opacityEnd?: number;
  opacityEndVariance?: number;
  opacityStart?: number;
  opacityStartVariance?: number;

  orientation?: ParticleEmitterOrientation;
  orientationFixedRotation?: Vector3;

  position?: Vector3;
  positionVariance?: Vector3;

  rate?: number;
  rateVariance?: number;

  sizeEnd?: number;
  sizeEndVariance?: number;
  sizeStart?: number;
  sizeStartVariance?: number;

  texture?: Texture | null;

  transparent?: boolean;

  velocity?: Vector3;
  velocityVariance?: Vector3;
}

class ParticlesMaterial extends ShaderMaterial {
  constructor(lockToEmitter: boolean = false) {
    super({
      uniforms: {
        [UNIFORM_MAP]: { value: null },
        [UNIFORM_TIME]: { value: 0.0 },
        [UNIFORM_GRAVITY]: { value: new Vector3() },
        [UNIFORM_ORIENTATION_MATRIX]: { value: new Matrix3() }
      },
      defines: lockToEmitter ? {
        [DEFINE_LOCK_TO_EMITTER]: '',
        [DEFINE_ORIENTATION_BILLBOARD]: true
      } : { [DEFINE_ORIENTATION_BILLBOARD]: true },
      vertexShader: `
        uniform float ${UNIFORM_TIME};
        uniform vec3 ${UNIFORM_GRAVITY};
        uniform mat3 ${UNIFORM_ORIENTATION_MATRIX};

        attribute vec3 ${ATTR_INITIAL_POSITION};
        attribute vec3 ${ATTR_INITIAL_VELOCITY};
        attribute vec2 ${ATTR_SIZE_VAR};
        attribute vec2 ${ATTR_TIME_VAR};
        attribute vec2 ${ATTR_OPACITY_VAR};
        attribute vec3 ${ATTR_COLOR_START_VAR};
        attribute vec3 ${ATTR_COLOR_END_VAR};

        varying vec2 vUv;
        varying float vLife;
        varying vec2 vOpacityVar;
        varying vec3 vColorStart;
        varying vec3 vColorEnd;

        void main() {
          vUv = uv;

          float age = ${UNIFORM_TIME} - ${ATTR_TIME_VAR}.x;
          vLife = clamp(1.0 - age / ${ATTR_TIME_VAR}.y, 0.0, 1.0);

          // Pass variations to fragment shader
          vOpacityVar = ${ATTR_OPACITY_VAR};
          vColorStart = ${ATTR_COLOR_START_VAR};
          vColorEnd = ${ATTR_COLOR_END_VAR};

          if (vLife <= 0.0) {
            gl_Position = vec4(9999.0, 9999.0, 9999.0, 1.0);
            return;
          }

          // Physics calculation (same for both modes)
          vec3 physics = ${ATTR_INITIAL_POSITION} + ${ATTR_INITIAL_VELOCITY} * age + 0.5 * ${UNIFORM_GRAVITY} * age * age;

          // Calculate world position based on lock mode
          // - LOCK_TO_EMITTER: initialPosition is local, add current emitter world position
          // - Otherwise: initialPosition is already world position
          #ifdef ${DEFINE_LOCK_TO_EMITTER}
            vec3 worldPos = modelMatrix[3].xyz + physics;
          #else
            vec3 worldPos = physics;
          #endif

          // Calculate right and up vectors based on orientation mode
          vec3 particleRight;
          vec3 particleUp;

          #ifdef ${DEFINE_ORIENTATION_BILLBOARD}
            // Billboard: particles always face camera (use camera's right/up directly)
            particleRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
            particleUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
          #elif defined(${DEFINE_ORIENTATION_BILLBOARD_Y})
            // BillboardY: rotate around Y-axis to face camera view direction
            vec3 cameraForward = -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
            vec3 forwardXZ = vec3(cameraForward.x, 0.0, cameraForward.z);
            if (length(forwardXZ) < 1e-4) {
              // Fallback when camera is looking nearly straight up or down
              forwardXZ = vec3(0.0, 0.0, 1.0);
            }
            particleRight = normalize(cross(forwardXZ, vec3(0.0, 1.0, 0.0)));
            particleUp = vec3(0.0, 1.0, 0.0);
          #elif defined(${DEFINE_ORIENTATION_FIXED})
            // Fixed: use orientation matrix
            particleRight = ${UNIFORM_ORIENTATION_MATRIX}[0];
            particleUp = ${UNIFORM_ORIENTATION_MATRIX}[1];
          #elif defined(${DEFINE_ORIENTATION_VELOCITY})
            // Velocity-aligned: particle Y-axis aligns to velocity direction,
            // billboards around that axis to face the camera.
            // v(t) = v0 + g * t
            vec3 currentVelocity = ${ATTR_INITIAL_VELOCITY} + ${UNIFORM_GRAVITY} * age;
            float velLength = length(currentVelocity);
            // When velocity is near zero, orientation is undefined. Skip rendering.
            if (velLength < 1e-7) {
              gl_Position = vec4(9999.0, 9999.0, 9999.0, 1.0);
              return;
            }
            particleUp = currentVelocity / velLength;
            vec3 cameraForward = -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
            vec3 right = cross(cameraForward, particleUp);
            float rightLen = length(right);
            if (rightLen < 1e-4) {
              // Fallback when camera forward is nearly parallel to velocity direction.
              // Choose an arbitrary vector not parallel to particleUp to construct a basis.
              vec3 arbitrary = abs(particleUp.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
              right = cross(arbitrary, particleUp);
            }
            particleRight = normalize(right);
          #endif

          // Interpolate size based on life
          float interpolatedSize = mix(${ATTR_SIZE_VAR}.y, ${ATTR_SIZE_VAR}.x, vLife);

          // Use the vertex position from the plane geometry to create quad
          vec3 quadOffset = (position.x * particleRight + position.y * particleUp) * interpolatedSize;
          vec3 finalPos = worldPos + quadOffset;

          gl_Position = projectionMatrix * viewMatrix * vec4(finalPos, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D ${UNIFORM_MAP};

        #ifdef ${DEFINE_USE_ALPHATEST}
          uniform float ${UNIFORM_ALPHATEST};
        #endif

        varying vec2 vUv;
        varying float vLife;
        varying vec2 vOpacityVar;
        varying vec3 vColorStart;
        varying vec3 vColorEnd;

        void main() {
          vec4 texColor = texture2D(${UNIFORM_MAP}, vUv);

          vec3 color = mix(vColorEnd, vColorStart, vLife);
          float alphaGradient = mix(vOpacityVar.y, vOpacityVar.x, vLife);
          float finalAlpha = texColor.a * alphaGradient;

          #ifdef ${DEFINE_USE_ALPHATEST}
            if (finalAlpha < ${UNIFORM_ALPHATEST}) discard;
          #endif

          gl_FragColor = vec4(texColor.rgb * color, finalAlpha);
        }
      `,
      side: FrontSide,
    });
  }

  public setAlphaTest(alphaTest: number): this {
    if (alphaTest > 0) {
      if (!(UNIFORM_ALPHATEST in this.uniforms)) {
        this.uniforms[UNIFORM_ALPHATEST] = { value: alphaTest };
        this.defines[DEFINE_USE_ALPHATEST] = '';
        this.needsUpdate = true;
      } else {
        this.uniforms[UNIFORM_ALPHATEST].value = alphaTest;
      }
    } else if (alphaTest === 0 && (UNIFORM_ALPHATEST in this.uniforms)) {
      delete this.uniforms[UNIFORM_ALPHATEST];
      delete this.defines[DEFINE_USE_ALPHATEST];
      this.needsUpdate = true;
    }
    return this;
  }

  public setGravity(gravity: Vector3): this {
    this.uniforms[UNIFORM_GRAVITY].value.copy(gravity);
    return this;
  }

  public setOrientation(orientation: ParticleEmitterOrientation): this {
    // Clear all orientation defines
    delete this.defines[DEFINE_ORIENTATION_BILLBOARD];
    delete this.defines[DEFINE_ORIENTATION_BILLBOARD_Y];
    delete this.defines[DEFINE_ORIENTATION_FIXED];
    delete this.defines[DEFINE_ORIENTATION_VELOCITY];
    // Set the new one
    this.defines[orientationToDefine(orientation)] = true;
    // Set side based on orientation mode
    this.side = orientation === 'fixed' ? DoubleSide : FrontSide;
    this.needsUpdate = true;
    return this;
  }

  public setOrientationFixedRotation(rotation: Vector3): this {
    this.uniforms[UNIFORM_ORIENTATION_MATRIX].value.copy(createOrientationMatrix(rotation));
    return this;
  }

  public setTexture(texture: Texture | null): this {
    this.uniforms[UNIFORM_MAP].value = texture;
    this.visible = !!texture;
    return this;
  }

  public setTransparent(transparent: boolean): this {
    if (this.transparent !== transparent) {
      this.needsUpdate = true;
    }
    this.transparent = transparent;
    this.depthWrite = !this.transparent;
    return this;
  }

  public updateTime(time: number): void {
    this.uniforms.time.value = time;
  }
}

const defaults: Required<ParticleEmitterCoreOptions> = {
  alphaTest: 0,
  colorEnd: new Color(1, 1, 1),
  colorEndVariance: new Color(0, 0, 0),
  colorStart: new Color(1, 1, 1),
  colorStartVariance: new Color(0, 0, 0),
  colorIntensityStart: 1.0,
  colorIntensityEnd: 1.0,
  colorIntensityStartVariance: 0,
  colorIntensityEndVariance: 0,
  lifetime: 1.0,
  lifetimeVariance: 0,
  lockToEmitter: false,
  maxParticles: 0, // Will be calculated
  gravity: new Vector3(0, 0, 0),
  opacityEnd: 0,
  opacityEndVariance: 0,
  opacityStart: 1,
  opacityStartVariance: 0,
  orientation: 'billboard',
  orientationFixedRotation: new Vector3(0, 0, 0),
  position: new Vector3(0, 0, 0),
  positionVariance: new Vector3(0, 0, 0),
  rate: 10,
  rateVariance: 0,
  sizeEnd: 1.0,
  sizeEndVariance: 0,
  sizeStart: 1.0,
  sizeStartVariance: 0,
  texture: null,
  transparent: false,
  velocity: new Vector3(0, 0, 0),
  velocityVariance: new Vector3(0, 0, 0),
};

// Note:
// - For each emitter core, one InstancedMesh and one Material are created.
//   A large number of particles from a single emitter core are rendered
//   in one draw call.
// - For simplicity, particle appearance is always defined by a texture.
// - InstancedMesh is created synchronously for simplicity.
// - When an emitter core is created, its texture is set to null by default,
//   and can be assigned later. While the texture is null, the emitter
//   remains invisible.
// - Particles are emitted relative to the emitter's world position.
//   After emission, particles do not follow emitter movement.
//
// TODO:
// - If rendering performance becomes an issue when many emitters are
//   created, consider rendering multiple emitters using a single
//   InstancedMesh in one draw call.
export default class ParticleEmitterCore {
  private _options: Required<ParticleEmitterCoreOptions>;
  private _poolIndex: number;
  private _currentTime: number;
  private _emissionAccumulator: number;
  private _isMaxParticlesAutoCalculated: boolean = false;
  private _mesh: InstancedMesh;
  private _paused: boolean = false;

  constructor(options: ParticleEmitterCoreOptions) {
    this._options = { ...defaults };
    
    // Only override defaults with defined values, otherwise if we use spread, options overrides all defaults since it has keys.
    for (const key in options) {
      if (options[key as keyof ParticleEmitterCoreOptions] !== undefined) {
        (this._options as any)[key] = options[key as keyof ParticleEmitterCoreOptions];
      }
    }

    // Auto-calculate maxParticles if needed
    if (!this._options.maxParticles) {
      this._options.maxParticles = this._calculateMaxParticles();
      this._isMaxParticlesAutoCalculated = true;
    }

    // Clone Vector3 and Color instances to avoid shared references
    for (const key in this._options) {
      const value = this._options[key as keyof typeof this._options];
      if (value instanceof Vector3 || value instanceof Color) {
        // TODO: Avoid any if possible
        (this._options as any)[key] = value.clone();
      }
    }

    const geometry = this._createGeometry(this._options.maxParticles);

    this._mesh = new InstancedMesh(
      geometry,
      new ParticlesMaterial(this._options.lockToEmitter)
        .setTexture(this._options.texture)
        .setGravity(this._options.gravity)
        .setTransparent(this._options.transparent)
        .setAlphaTest(this._options.alphaTest)
        .setOrientation(this._options.orientation)
        .setOrientationFixedRotation(this._options.orientationFixedRotation),
      this._options.maxParticles,
    );
    this._mesh.position.copy(this._options.position);

    this._updateBoundingBox();

    this._poolIndex = 0;
    this._currentTime = 0;
    this._emissionAccumulator = 0;
  }

  public get mesh(): InstancedMesh {
    return this._mesh;
  }

  public get paused(): boolean {
    return this._paused;
  }

  public burst(count: number): void {
    // Burst emits particles immediately regardless of pause state

    if (count <= 0) {
      return;
    }

    if (!(this.mesh.material as ParticlesMaterial).visible) {
      return;
    }

    if (this.mesh.matrixWorldAutoUpdate) {
      this.mesh.updateMatrixWorld();
    }

    this._emit(count, this.mesh.matrixWorld);
  }

  public pause(): void {
    this._paused = true;
    // Reset accumulator when pausing to discard fractional particle accumulation
    this._emissionAccumulator = 0;
  }

  public restart(): void {
    this._paused = false;
  }

  private _calculateMaxParticles(): number {
    const maxLife = this._options.lifetime + this._options.lifetimeVariance;
    const theoreticalMax = Math.ceil(this._options.rate * maxLife);
    const safetyMargin = 1.2;  // 20% safety margin
    const calculatedMax = Math.ceil(theoreticalMax * safetyMargin);
    const minimumParticles = 10;  // Minimum particle count
    return Math.max(minimumParticles, calculatedMax);
  }

  private _calculateBoundingBox(): Box3 {
    const maxLife = this._options.lifetime + this._options.lifetimeVariance;
    // Calculate maximum possible size considering both start and end sizes
    const maxSizeStart = this._options.sizeStart + this._options.sizeStartVariance;
    const maxSizeEnd = this._options.sizeEnd + this._options.sizeEndVariance;
    const maxSize = Math.max(maxSizeStart, maxSizeEnd);

    // Maximum initial position range
    const posVar = this._options.positionVariance;

    // Maximum velocity (per axis)
    const maxVelX = Math.abs(this._options.velocity.x) + this._options.velocityVariance.x;
    const maxVelY = Math.abs(this._options.velocity.y) + this._options.velocityVariance.y;
    const maxVelZ = Math.abs(this._options.velocity.z) + this._options.velocityVariance.z;

    // Maximum displacement due to gravity
    const gravityDisplacement = new Vector3(
      0.5 * Math.abs(this._options.gravity.x) * maxLife * maxLife,
      0.5 * Math.abs(this._options.gravity.y) * maxLife * maxLife,
      0.5 * Math.abs(this._options.gravity.z) * maxLife * maxLife,
    );

    // Maximum displacement due to velocity
    const velocityDisplacement = new Vector3(
      maxVelX * maxLife,
      maxVelY * maxLife,
      maxVelZ * maxLife,
    );

    // Calculate overall maximum range
    const maxRange = new Vector3(
      posVar.x + velocityDisplacement.x + gravityDisplacement.x + maxSize,
      posVar.y + velocityDisplacement.y + gravityDisplacement.y + maxSize,
      posVar.z + velocityDisplacement.z + gravityDisplacement.z + maxSize,
    );

    // Create bounding box
    const min = new Vector3(-maxRange.x, -maxRange.y, -maxRange.z);
    const max = new Vector3(maxRange.x, maxRange.y, maxRange.z);

    // Adjust based on velocity direction
    ((this._options.velocity.x > 0) ? max : min).x += this._options.velocity.x * maxLife;
    ((this._options.velocity.y > 0) ? max : min).y += this._options.velocity.y * maxLife;
    ((this._options.velocity.z > 0) ? max : min).z += this._options.velocity.z * maxLife;

    return new Box3(min, max);
  }

  private _updateBoundingBox(): void {
    const boundingBox = this._calculateBoundingBox();
    this.mesh.geometry.boundingBox = boundingBox;

    // Also calculate bounding sphere
    const center = new Vector3();
    boundingBox.getCenter(center);
    const radius = boundingBox.getSize(new Vector3()).length() * 0.5;
    this.mesh.geometry.boundingSphere = new Sphere(center, radius);
  }

  private _emit(count: number, worldMatrix: Matrix4): void {
    const geometry = this.mesh.geometry;
    const initialPositionAttr = geometry.getAttribute(ATTR_INITIAL_POSITION) as InstancedBufferAttribute;
    const initialVelocityAttr = geometry.getAttribute(ATTR_INITIAL_VELOCITY) as InstancedBufferAttribute;
    const sizeVarAttr = geometry.getAttribute(ATTR_SIZE_VAR) as InstancedBufferAttribute;
    const timeVarAttr = geometry.getAttribute(ATTR_TIME_VAR) as InstancedBufferAttribute;
    const opacityVarAttr = geometry.getAttribute(ATTR_OPACITY_VAR) as InstancedBufferAttribute;
    const colorStartVarAttr = geometry.getAttribute(ATTR_COLOR_START_VAR) as InstancedBufferAttribute;
    const colorEndVarAttr = geometry.getAttribute(ATTR_COLOR_END_VAR) as InstancedBufferAttribute;

    // Track the range of indices that need updating
    const startIndex = this._poolIndex;
    let actualEmitCount = 0;

    for (let i = 0; i < count; i++) {
      // Generate local position variance
      const localPosX = (Math.random() - 0.5) * 2 * this._options.positionVariance.x;
      const localPosY = (Math.random() - 0.5) * 2 * this._options.positionVariance.y;
      const localPosZ = (Math.random() - 0.5) * 2 * this._options.positionVariance.z;

      tempVector3.set(localPosX, localPosY, localPosZ);

      // When lockToEmitter is enabled, store local position.
      // Otherwise, transform to world space.
      if (!this._options.lockToEmitter) {
        tempVector3.applyMatrix4(worldMatrix);
      }

      const velX = this._options.velocity.x + (Math.random() - 0.5) * 2 * this._options.velocityVariance.x;
      const velY = this._options.velocity.y + (Math.random() - 0.5) * 2 * this._options.velocityVariance.y;
      const velZ = this._options.velocity.z + (Math.random() - 0.5) * 2 * this._options.velocityVariance.z;

      const maxLife = this._options.lifetime + (Math.random() - 0.5) * 2 * this._options.lifetimeVariance;

      const sizeStart = Math.max(0, this._options.sizeStart + (Math.random() - 0.5) * 2 * this._options.sizeStartVariance);
      const sizeEnd = Math.max(0, this._options.sizeEnd + (Math.random() - 0.5) * 2 * this._options.sizeEndVariance);

      const opacityStart = Math.max(0, Math.min(1, this._options.opacityStart + (Math.random() - 0.5) * 2 * this._options.opacityStartVariance));
      const opacityEnd = Math.max(0, Math.min(1, this._options.opacityEnd + (Math.random() - 0.5) * 2 * this._options.opacityEndVariance));

      const intensityStart = Math.max(0, this._options.colorIntensityStart + (Math.random() - 0.5) * 2 * this._options.colorIntensityStartVariance);
      const intensityEnd = Math.max(0, this._options.colorIntensityEnd + (Math.random() - 0.5) * 2 * this._options.colorIntensityEndVariance);

      const colorStartR = Math.max(0, this._options.colorStart.r + (Math.random() - 0.5) * 2 * this._options.colorStartVariance.r) * intensityStart;
      const colorStartG = Math.max(0, this._options.colorStart.g + (Math.random() - 0.5) * 2 * this._options.colorStartVariance.g) * intensityStart;
      const colorStartB = Math.max(0, this._options.colorStart.b + (Math.random() - 0.5) * 2 * this._options.colorStartVariance.b) * intensityStart;

      const colorEndR = Math.max(0, this._options.colorEnd.r + (Math.random() - 0.5) * 2 * this._options.colorEndVariance.r) * intensityEnd;
      const colorEndG = Math.max(0, this._options.colorEnd.g + (Math.random() - 0.5) * 2 * this._options.colorEndVariance.g) * intensityEnd;
      const colorEndB = Math.max(0, this._options.colorEnd.b + (Math.random() - 0.5) * 2 * this._options.colorEndVariance.b) * intensityEnd;

      initialPositionAttr.setXYZ(this._poolIndex, tempVector3.x, tempVector3.y, tempVector3.z);
      initialVelocityAttr.setXYZ(this._poolIndex, velX, velY, velZ);
      sizeVarAttr.setXY(this._poolIndex, sizeStart, sizeEnd);
      timeVarAttr.setXY(this._poolIndex, this._currentTime, maxLife);
      opacityVarAttr.setXY(this._poolIndex, opacityStart, opacityEnd);
      colorStartVarAttr.setXYZ(this._poolIndex, colorStartR, colorStartG, colorStartB);
      colorEndVarAttr.setXYZ(this._poolIndex, colorEndR, colorEndG, colorEndB);

      this._poolIndex = (this._poolIndex + 1) % this._options.maxParticles;
      actualEmitCount++;
    }

    attributes.push(initialPositionAttr);
    attributes.push(initialVelocityAttr);
    attributes.push(sizeVarAttr);
    attributes.push(timeVarAttr);
    attributes.push(opacityVarAttr);
    attributes.push(colorStartVarAttr);
    attributes.push(colorEndVarAttr);

    // Update only the range that was modified
    if (actualEmitCount > 0) {
      attributes.forEach(attribute => attribute.clearUpdateRanges());

      if (startIndex + actualEmitCount <= this._options.maxParticles) {
        // Simple case: no wrap-around
        attributes.forEach(attribute => attribute.addUpdateRange(startIndex * attribute.itemSize, actualEmitCount * attribute.itemSize));
      } else {
        // Wrap-around case: update in two parts
        const firstPartCount = this._options.maxParticles - startIndex;
        const secondPartCount = actualEmitCount - firstPartCount;

        attributes.forEach(attribute => {
          // Update first part (from startIndex to end)
          attribute.addUpdateRange(startIndex * attribute.itemSize, firstPartCount * attribute.itemSize);
          // Update second part (from 0 to wrap point)
          attribute.addUpdateRange(0, secondPartCount * attribute.itemSize);
        });
      }

      attributes.forEach(attribute => attribute.needsUpdate = true);
    }

    attributes.length = 0;
  }

  private _getCurrentRate(): number {
    if (this._options.rateVariance === 0) {
      return this._options.rate;
    }

    // Apply random variation to rate
    const variance = (Math.random() - 0.5) * 2 * this._options.rateVariance;

    // Ensure rate doesn't go negative
    return Math.max(0, this._options.rate + variance);
  }

  public update(deltaTimeS: number): void {
    // Clamp deltaTime to prevent large jumps
    const clampedDeltaTime = Math.min(deltaTimeS, 0.1);

    this._currentTime += deltaTimeS;  // Track actual time accurately
    (this.mesh.material as ParticlesMaterial).updateTime(this._currentTime);

    if (!(this.mesh.material as ParticlesMaterial).visible) {
      return;
    }

    if (this._paused) {
      return;
    }

    // Get current rate (with variance applied)
    const currentRate = this._getCurrentRate();

    // Accumulate using clamped deltaTime
    this._emissionAccumulator += currentRate * clampedDeltaTime;

    // Calculate and limit particles to emit
    const particlesToEmit = Math.floor(this._emissionAccumulator);

    if (particlesToEmit > 0) {
      if (this.mesh.matrixWorldAutoUpdate) {
        this.mesh.updateMatrixWorld();
      }
      this._emit(particlesToEmit, this.mesh.matrixWorld);
      this._emissionAccumulator -= particlesToEmit;
    }
  }

  public updateParameters(updates: Partial<ParticleEmitterCoreOptions>): void {
    const material = this.mesh.material as ParticlesMaterial;

    let boundingBoxNeedsUpdate = false;
    let needsAutomaticResize = false;

    if (updates.alphaTest !== undefined) {
      this._options.alphaTest = updates.alphaTest;
      material.setAlphaTest(this._options.alphaTest);
    }

    if (updates.colorEnd !== undefined) {
      this._options.colorEnd.copy(updates.colorEnd);
    }

    if (updates.colorEndVariance !== undefined) {
      this._options.colorEndVariance.copy(updates.colorEndVariance);
    }

    if (updates.colorStart !== undefined) {
      this._options.colorStart.copy(updates.colorStart);
    }

    if (updates.colorStartVariance !== undefined) {
      this._options.colorStartVariance.copy(updates.colorStartVariance);
    }

    if (updates.colorIntensityStart !== undefined) {
      this._options.colorIntensityStart = updates.colorIntensityStart;
    }

    if (updates.colorIntensityEnd !== undefined) {
      this._options.colorIntensityEnd = updates.colorIntensityEnd;
    }

    if (updates.colorIntensityStartVariance !== undefined) {
      this._options.colorIntensityStartVariance = updates.colorIntensityStartVariance;
    }

    if (updates.colorIntensityEndVariance !== undefined) {
      this._options.colorIntensityEndVariance = updates.colorIntensityEndVariance;
    }

    if (updates.gravity !== undefined) {
      this._options.gravity.copy(updates.gravity);
      material.setGravity(this._options.gravity);
    }

    if (updates.lifetime !== undefined && this._options.lifetime !== updates.lifetime) {
      this._options.lifetime = updates.lifetime;
      boundingBoxNeedsUpdate = true;
      needsAutomaticResize = true;
    }

    if (updates.lifetimeVariance !== undefined && this._options.lifetimeVariance !== updates.lifetimeVariance) {
      this._options.lifetimeVariance = updates.lifetimeVariance;
      boundingBoxNeedsUpdate = true;
      needsAutomaticResize = true;
    }

    if (updates.opacityEnd !== undefined) {
      this._options.opacityEnd = updates.opacityEnd;
    }

    if (updates.opacityEndVariance !== undefined) {
      this._options.opacityEndVariance = updates.opacityEndVariance;
    }

    if (updates.opacityStart !== undefined) {
      this._options.opacityStart = updates.opacityStart;
    }

    if (updates.opacityStartVariance !== undefined) {
      this._options.opacityStartVariance = updates.opacityStartVariance;
    }

    if (updates.position !== undefined) {
      this._options.position.copy(updates.position);
      this.mesh.position.copy(this._options.position);
    }

    if (updates.positionVariance !== undefined && !this._options.positionVariance.equals(updates.positionVariance)) {
      this._options.positionVariance.copy(updates.positionVariance);
      boundingBoxNeedsUpdate = true;
    }

    if (updates.rate !== undefined) {
      if (this._options.rate !== updates.rate) {
        needsAutomaticResize = true;
      }
      this._options.rate = updates.rate;
    }

    if (updates.rateVariance !== undefined) {
      this._options.rateVariance = updates.rateVariance;
    }

    if (updates.sizeEnd !== undefined && this._options.sizeEnd !== updates.sizeEnd) {
      this._options.sizeEnd = updates.sizeEnd;
      boundingBoxNeedsUpdate = true;
    }

    if (updates.sizeEndVariance !== undefined && this._options.sizeEndVariance !== updates.sizeEndVariance) {
      this._options.sizeEndVariance = updates.sizeEndVariance;
      boundingBoxNeedsUpdate = true;
    }

    if (updates.sizeStart !== undefined && this._options.sizeStart !== updates.sizeStart) {
      this._options.sizeStart = updates.sizeStart;
      boundingBoxNeedsUpdate = true;
    }

    if (updates.sizeStartVariance !== undefined && this._options.sizeStartVariance !== updates.sizeStartVariance) {
      this._options.sizeStartVariance = updates.sizeStartVariance;
      boundingBoxNeedsUpdate = true;
    }

    if (updates.orientation !== undefined) {
      this._options.orientation = updates.orientation;
      material.setOrientation(this._options.orientation);
    }

    if (updates.orientationFixedRotation !== undefined) {
      this._options.orientationFixedRotation = updates.orientationFixedRotation;
      material.setOrientationFixedRotation(this._options.orientationFixedRotation);
    }

    if (updates.texture !== undefined) {
      this._options.texture = updates.texture;
      material.setTexture(this._options.texture);
    }

    if (updates.transparent !== undefined) {
      this._options.transparent = updates.transparent;
      material.setTransparent(this._options.transparent);
    }

    if (updates.velocity !== undefined && !this._options.velocity.equals(updates.velocity)) {
      this._options.velocity.copy(updates.velocity);
      boundingBoxNeedsUpdate = true;
    }

    if (updates.velocityVariance !== undefined && !this._options.velocityVariance.equals(updates.velocityVariance)) {
      this._options.velocityVariance.copy(updates.velocityVariance);
      boundingBoxNeedsUpdate = true;
    }

    const oldMaxParticles = this._options.maxParticles;

    if (updates.maxParticles !== undefined && updates.maxParticles > 0) {
      this._options.maxParticles = updates.maxParticles;
      this._isMaxParticlesAutoCalculated = false;
    } else if (updates.maxParticles === 0 || (this._isMaxParticlesAutoCalculated && needsAutomaticResize)) {
      this._options.maxParticles = this._calculateMaxParticles();
      this._isMaxParticlesAutoCalculated = true;
    }

    if (this._options.maxParticles !== oldMaxParticles) {
      this._resize();
    }

    if (boundingBoxNeedsUpdate) {
      this._updateBoundingBox();
    }
  }

  private _resize(): void {
    const oldGeometry = this.mesh.geometry as PlaneGeometry;
    const newGeometry = this._createGeometry(this._options.maxParticles);

    // Copy existing particle data if possible
    if (this._poolIndex > 0) {
      const copyCount = Math.min(this._poolIndex, this._options.maxParticles);
      this._copyParticleData(oldGeometry, newGeometry, copyCount);
    }

    newGeometry.boundingBox = oldGeometry.boundingBox;
    newGeometry.boundingSphere = oldGeometry.boundingSphere;

    // Don't know if switching a geometry in InstancedMesh to a new one is a good design.
    this.mesh.geometry = newGeometry;
    // TODO: Maybe updating InstancedMesh.count would be hacky. Switch to more elegant way.
    this.mesh.count = this._options.maxParticles;
    oldGeometry.dispose();

    // Adjust pool index if needed
    if (this._poolIndex >= this._options.maxParticles) {
      this._poolIndex = 0;
    }
  }

  private _createGeometry(maxParticles: number): PlaneGeometry {
    return new PlaneGeometry(1, 1)
      .setAttribute(ATTR_INITIAL_POSITION, new InstancedBufferAttribute(new Float32Array(maxParticles * 3), 3).setUsage(DynamicDrawUsage))
      .setAttribute(ATTR_INITIAL_VELOCITY, new InstancedBufferAttribute(new Float32Array(maxParticles * 3), 3).setUsage(DynamicDrawUsage))
      .setAttribute(ATTR_SIZE_VAR, new InstancedBufferAttribute(new Float32Array(maxParticles * 2), 2).setUsage(DynamicDrawUsage))
      .setAttribute(ATTR_TIME_VAR, new InstancedBufferAttribute(new Float32Array(maxParticles * 2), 2).setUsage(DynamicDrawUsage))
      .setAttribute(ATTR_OPACITY_VAR, new InstancedBufferAttribute(new Float32Array(maxParticles * 2), 2).setUsage(DynamicDrawUsage))
      .setAttribute(ATTR_COLOR_START_VAR, new InstancedBufferAttribute(new Float32Array(maxParticles * 3), 3).setUsage(DynamicDrawUsage))
      .setAttribute(ATTR_COLOR_END_VAR, new InstancedBufferAttribute(new Float32Array(maxParticles * 3), 3).setUsage(DynamicDrawUsage))
      .deleteAttribute('normal');
  }

  private _copyParticleData(oldGeometry: PlaneGeometry, newGeometry: PlaneGeometry, count: number): void {
    this._copyAttribute(oldGeometry, newGeometry, ATTR_INITIAL_POSITION, count);
    this._copyAttribute(oldGeometry, newGeometry, ATTR_INITIAL_VELOCITY, count);
    this._copyAttribute(oldGeometry, newGeometry, ATTR_SIZE_VAR, count);
    this._copyAttribute(oldGeometry, newGeometry, ATTR_TIME_VAR, count);
    this._copyAttribute(oldGeometry, newGeometry, ATTR_OPACITY_VAR, count);
    this._copyAttribute(oldGeometry, newGeometry, ATTR_COLOR_START_VAR, count);
    this._copyAttribute(oldGeometry, newGeometry, ATTR_COLOR_END_VAR, count);
  }

  private _copyAttribute(oldGeometry: PlaneGeometry, newGeometry: PlaneGeometry, attrName: string, count: number): void {
    const oldAttr = oldGeometry.getAttribute(attrName) as InstancedBufferAttribute;
    const newAttr = newGeometry.getAttribute(attrName) as InstancedBufferAttribute;

    const copySize = count * oldAttr.itemSize;
    const oldArray = oldAttr.array as Float32Array;
    const newArray = newAttr.array as Float32Array;

    for (let i = 0; i < copySize; i++) {
      newArray[i] = oldArray[i];
    }

    newAttr.needsUpdate = true;
  }

  public dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as ParticlesMaterial).dispose();
  }
}
