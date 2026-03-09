import {
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Material,
  Mesh,
  RepeatWrapping,
  ShaderMaterial,
  Texture,
  Vector3,
  Vector3Like,
} from 'three';
import { ArrowId, DEFAULT_ARROW_IMAGE_PATH } from './ArrowConstants';
import ArrowStats from './ArrowStats';
import { EntityId } from '../entities/EntityConstants';
import Entity from '../entities/Entity';
import type Game from '../Game';
import Assets from '../network/Assets';
import { CustomTextureWrapper } from '../textures/CustomTextureManager';
import { findArrowPath } from './ArrowPathfinder';

export interface ArrowData {
  id: ArrowId;
  sourceEntityId?: EntityId;
  sourcePosition?: Vector3Like;
  targetEntityId?: EntityId;
  targetPosition?: Vector3Like;
  waypoints?: Vector3Like[];
  color?: { r: number, g: number, b: number };
  textureUri?: string;
}

const ARROW_WIDTH = 0.5;
const ARROW_UNIT_SIZE = 0.5; // World units per arrow pattern
const ANIMATION_SPEED = '2.0';
const ARROW_HOVER_HEIGHT = 0.18;
const BLOCK_CLEARANCE_SAMPLE_SPACING = 0.2;
const CORNER_SAMPLES = 4;
const CURVE_SURFACE_OFFSET = 0.08;
const MAX_CORNER_RADIUS = 0.35;
const MIN_ARROW_LENGTH = 0.05;
const PATH_POINT_SPACING = 0.3;
const PATH_REBUILD_INTERVAL_MS = 100;
const PATH_REBUILD_THRESHOLD_SQ = 0.1 * 0.1;
const UNIFORM_COLOR = 'color';
const UNIFORM_TIME = 'time';
const UNIFORM_LENGTH = 'length';
const UNIFORM_TEXTURE = 'map';
const SHADOW_GROUND_SCAN_DEPTH = 10;
const SHADOW_WIDTH = 0.78;
const SHADOW_Y_OFFSET = 0.03;
const UNIFORM_SHADOW_OPACITY = 'shadowOpacity';

// Working variables
const curveDirection = new Vector3();
const curvePoint = new Vector3();
const curveSide = new Vector3();
const curveUp = new Vector3(0, 1, 0);
const curveWorkA = new Vector3();
const curveWorkB = new Vector3();
const curveWorkC = new Vector3();
const curveWorkD = new Vector3();
const curveWorkE = new Vector3();
const curveWorkF = new Vector3();

// This is intended mainly for guidance or onboarding, showing players which
// direction to move.
// Note: Assume that the texture image represents an upward-pointing arrow.
//       Also, regions with alpha values below 0.5 are cut out by alpha testing.
export class Arrow {
  private _game: Game;
  private _id: ArrowId;

  private _sourceEntityId?: number;
  private _sourcePosition?: Vector3Like;
  private _targetEntityId?: number;
  private _targetPosition?: Vector3Like;
  private _waypoints: Vector3[] | null = null;
  private _color: Color = new Color(0xffffff);
  private _texture: Texture | null = null;
  private _texturePromise: Promise<CustomTextureWrapper> | null = null;
  private _textureWrapper: CustomTextureWrapper | null = null;
  private _textureUri: string = DEFAULT_ARROW_IMAGE_PATH;
  private _mesh: Mesh<BufferGeometry, ShaderMaterial>;
  private _shadowMesh: Mesh<BufferGeometry, ShaderMaterial>;
  private _lastResolvedSource: Vector3 = new Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
  private _lastResolvedTarget: Vector3 = new Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
  private _lastPathBuildAtMs: number = -Number.POSITIVE_INFINITY;
  private _pathLength: number = 0;

  constructor(game: Game, data: ArrowData) {
    if (
      (data.sourceEntityId === undefined && data.sourcePosition === undefined) ||
      (data.sourceEntityId !== undefined && data.sourcePosition !== undefined)
    ) {
      throw new Error(`Arrow: Either sourceEntityId or targetEntityId must be specified.`);
    }

    if (
      (data.targetEntityId === undefined && data.targetPosition === undefined) ||
      (data.targetEntityId !== undefined && data.targetPosition !== undefined)
    ) {
      throw new Error(`Arrow: Either targetEntityId or targetEntityId must be specified.`);
    }

    this._game = game;
    this._id = data.id;

    this._sourceEntityId = data.sourceEntityId;
    this._sourcePosition = data.sourcePosition;
    this._targetEntityId = data.targetEntityId;
    this._targetPosition = data.targetPosition;
    this._waypoints = data.waypoints?.map((waypoint) => new Vector3(waypoint.x, waypoint.y, waypoint.z)) ?? null;

    if (data.color) {
      this._color.setRGB(data.color.r, data.color.g, data.color.b);
    }

    if (data.textureUri) {
      this._textureUri = Assets.toAssetUri(data.textureUri);
    }

    this._shadowMesh = this._createShadowMesh();
    this._game.renderer.addToScene(this._shadowMesh);
    this._mesh = this._createMesh();
    this._game.renderer.addToScene(this._mesh);
  }

  get id(): number {
    return this._id;
  }

  private async _loadTexture(): Promise<void> {
    this._texturePromise = this._game.customTextureManager.load(this._textureUri);
    const textureWrapper = await this._texturePromise;

    if (this._texturePromise === null) {
      this._game.customTextureManager.release(textureWrapper);
      return;
    }

    this._texturePromise = null;
    this._textureWrapper = textureWrapper;
    this._texture = this._textureWrapper.texture.clone();
    this._texture.wrapT = RepeatWrapping;
    this._texture.flipY = false;

    this._mesh.material.uniforms[UNIFORM_TEXTURE].value = this._texture;
    this._mesh.material.visible = true;
  }

  private _createMesh(): Mesh<BufferGeometry, ShaderMaterial> {
    const geometry = new BufferGeometry();

    const material = new ShaderMaterial({
      uniforms: {
        [UNIFORM_COLOR]: { value: this._color },
        [UNIFORM_TIME]: { value: 0.0 },
        [UNIFORM_LENGTH]: { value: 1.0 },
        [UNIFORM_TEXTURE]: { value: this._texture },
      },
      vertexShader: `
        varying vec2 vUv;

        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 ${UNIFORM_COLOR};
        uniform float ${UNIFORM_TIME};
        uniform float ${UNIFORM_LENGTH};
        uniform sampler2D ${UNIFORM_TEXTURE};
        varying vec2 vUv;

        void main() {
          float repeatCount = ${UNIFORM_LENGTH} / ${ARROW_UNIT_SIZE};
          vec2 animatedUv = vec2(vUv.x, vUv.y * repeatCount + ${UNIFORM_TIME} * ${ANIMATION_SPEED});
          vec4 texColor = texture2D(${UNIFORM_TEXTURE}, animatedUv);
          if (texColor.a < 0.5) discard;
          gl_FragColor = vec4(texColor.rgb * ${UNIFORM_COLOR}, texColor.a);
        }
      `,
      // Limitation: There would likely be strong demand for making the arrow transparent, but it is
      // kept opaque to avoid common rendering issues with transparent objects.
      transparent: false,
      side: DoubleSide,
      // Make it visible only after the texture becomes ready. We might consider
      // showing a placeholder until it is ready.
      visible: false,
    });

    // For now, the number of arrows used at once is assumed to be small, so each
    // arrow has its own mesh. If arrows end up being used in large quantities, we
    // may need to consider an InstancedMesh approach.
    const mesh = new Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldAutoUpdate = false;
    mesh.matrix.identity();
    mesh.matrixWorld.identity();
    mesh.renderOrder = 2;

    this._loadTexture();

    return mesh;
  }

  private _createShadowMesh(): Mesh<BufferGeometry, ShaderMaterial> {
    const geometry = new BufferGeometry();

    const material = new ShaderMaterial({
      uniforms: {
        [UNIFORM_SHADOW_OPACITY]: { value: 0.22 },
      },
      vertexShader: `
        varying vec2 vUv;

        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float ${UNIFORM_SHADOW_OPACITY};
        varying vec2 vUv;

        void main() {
          float edgeDistance = abs(vUv.x - 0.5) * 2.0;
          float widthMask = 1.0 - smoothstep(0.2, 1.0, edgeDistance);
          float lengthMask = smoothstep(0.0, 0.08, vUv.y) * smoothstep(0.0, 0.08, 1.0 - vUv.y);
          float alpha = ${UNIFORM_SHADOW_OPACITY} * widthMask * lengthMask;

          if (alpha < 0.01) discard;

          gl_FragColor = vec4(0.0, 0.0, 0.0, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      visible: true,
    });

    const mesh = new Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldAutoUpdate = false;
    mesh.matrix.identity();
    mesh.matrixWorld.identity();
    mesh.renderOrder = 1;
    mesh.visible = false;

    return mesh;
  }

  private _areGroundShadowsEnabled(): boolean {
    const quality = this._game.settingsManager.qualityPerfTradeoff;
    return (quality.blobShadows?.enabled ?? false) && !(quality.shadows?.enabled ?? false);
  }

  public update(deltaTimeS: number): void {
    const sourceEntity: Entity | undefined = this._sourceEntityId !== undefined ? this._game.entityManager.getEntity(this._sourceEntityId) : undefined;
    const targetEntity: Entity | undefined = this._targetEntityId !== undefined ? this._game.entityManager.getEntity(this._targetEntityId) : undefined;

    if (
      (this._sourceEntityId !== undefined && sourceEntity === undefined) ||
      (this._targetEntityId !== undefined && targetEntity === undefined)
    ) {
      // The attached entities are not found, so make the arrow invisible.
      // TODO: Should we issue a warning?
      this._mesh.visible = false;
      this._shadowMesh.visible = false;
      return;
    }

    if (sourceEntity && !sourceEntity.visible && targetEntity && !targetEntity.visible) {
      // Since both attached entities are invisible, make the arrow invisible as well.
      this._mesh.visible = false;
      this._shadowMesh.visible = false;
      return;
    }

    const source = this._sourcePosition || sourceEntity!.position;
    const target = this._targetPosition || targetEntity!.position;
    this._ensurePathGeometry(source, target);
    const length = this._pathLength;

    if (length < MIN_ARROW_LENGTH) {
      this._mesh.visible = false;
      this._shadowMesh.visible = false;
      return;
    }

    this._mesh.visible = true;
    this._shadowMesh.visible = this._areGroundShadowsEnabled();
    ArrowStats.visibleCount++;
    this._mesh.material.uniforms.time.value += deltaTimeS;
    this._mesh.material.uniforms.length.value = length;
  }

  private _ensurePathGeometry(start: Vector3Like, end: Vector3Like): void {
    curveWorkA.set(start.x, start.y, start.z);
    curveWorkB.set(end.x, end.y, end.z);

    const now = performance.now();
    const shouldRebuildPath = now - this._lastPathBuildAtMs >= PATH_REBUILD_INTERVAL_MS
      || curveWorkA.distanceToSquared(this._lastResolvedSource) > PATH_REBUILD_THRESHOLD_SQ
      || curveWorkB.distanceToSquared(this._lastResolvedTarget) > PATH_REBUILD_THRESHOLD_SQ;

    if (!shouldRebuildPath) {
      return;
    }

    this._lastPathBuildAtMs = now;
    this._lastResolvedSource.copy(curveWorkA);
    this._lastResolvedTarget.copy(curveWorkB);

    const points = this._waypoints
      ? this._buildCurvePointsFromWaypoints(curveWorkA, curveWorkB, this._waypoints)
      : this._buildCurvePointsFromBlocks(curveWorkA, curveWorkB, findArrowPath(this._game.chunkManager, start, end));
    this._pathLength = this._rebuildRibbonGeometry(this._mesh.geometry, this._liftCurvePoints(points), ARROW_WIDTH);

    if (this._areGroundShadowsEnabled()) {
      this._rebuildRibbonGeometry(this._shadowMesh.geometry, this._projectCurvePointsToGround(points), SHADOW_WIDTH);
    } else {
      this._clearRibbonGeometry(this._shadowMesh.geometry);
    }
  }

  private _buildCurvePointsFromWaypoints(start: Vector3, end: Vector3, waypoints: Vector3[]): Vector3[] {
    const routedPoints = this._trimWaypointsToSource(start, end, waypoints);

    return this._smoothCurvePoints(routedPoints, false);
  }

  private _trimWaypointsToSource(start: Vector3, end: Vector3, waypoints: Vector3[]): Vector3[] {
    const anchors = [...waypoints.map((waypoint) => waypoint.clone()), new Vector3(end.x, end.y, end.z)];

    if (anchors.length === 0) {
      return [new Vector3(start.x, start.y, start.z), new Vector3(end.x, end.y, end.z)];
    }

    if (anchors.length === 1) {
      return [new Vector3(start.x, start.y, start.z), anchors[0]];
    }

    let closestSegmentIndex = 0;
    let closestDistanceSquared = Number.POSITIVE_INFINITY;
    const closestPoint = new Vector3();

    for (let i = 0; i < anchors.length - 1; i++) {
      const segmentStart = anchors[i];
      const segmentEnd = anchors[i + 1];
      const projectedPoint = this._projectPointOntoSegment(start, segmentStart, segmentEnd);
      const distanceSquared = projectedPoint.distanceToSquared(start);

      if (distanceSquared < closestDistanceSquared) {
        closestDistanceSquared = distanceSquared;
        closestSegmentIndex = i;
        closestPoint.copy(projectedPoint);
      }
    }

    const trimmedRoute: Vector3[] = [new Vector3(start.x, start.y, start.z)];
    const nextAnchor = anchors[closestSegmentIndex + 1];

    if (trimmedRoute[0].distanceToSquared(closestPoint) > 0.0001) {
      trimmedRoute.push(closestPoint.clone());
    }

    if (!trimmedRoute.some((point) => point.distanceToSquared(nextAnchor) <= 0.0001)) {
      trimmedRoute.push(nextAnchor.clone());
    }

    for (let i = closestSegmentIndex + 2; i < anchors.length; i++) {
      const anchor = anchors[i];

      if (trimmedRoute[trimmedRoute.length - 1].distanceToSquared(anchor) <= 0.0001) {
        continue;
      }

      trimmedRoute.push(anchor.clone());
    }

    return trimmedRoute;
  }

  private _projectPointOntoSegment(point: Vector3, segmentStart: Vector3, segmentEnd: Vector3): Vector3 {
    curveWorkA.subVectors(segmentEnd, segmentStart);
    const segmentLengthSquared = curveWorkA.lengthSq();

    if (segmentLengthSquared <= 0.0001) {
      return curveWorkF.copy(segmentStart);
    }

    curveWorkB.subVectors(point, segmentStart);
    const t = Math.max(0, Math.min(1, curveWorkB.dot(curveWorkA) / segmentLengthSquared));

    return curveWorkF.copy(segmentStart).addScaledVector(curveWorkA, t);
  }

  private _buildCurvePointsFromBlocks(start: Vector3, end: Vector3, path: { x: number; y: number; z: number }[] | null): Vector3[] {
    const routedPoints: Vector3[] = [];

    if (path && path.length > 0) {
      for (let i = 0; i < path.length; i++) {
        const waypoint = path[i];
        routedPoints.push(new Vector3(
          waypoint.x + 0.5,
          waypoint.y + CURVE_SURFACE_OFFSET,
          waypoint.z + 0.5,
        ));
      }

      routedPoints[0].set(start.x, routedPoints[0].y, start.z);
      routedPoints[routedPoints.length - 1].set(end.x, routedPoints[routedPoints.length - 1].y, end.z);

      if (routedPoints.length === 1) {
        routedPoints.push(new Vector3(end.x, routedPoints[0].y, end.z));
      }
    } else {
      routedPoints.push(new Vector3(start.x, start.y, start.z));
      routedPoints.push(new Vector3(end.x, end.y, end.z));
    }

    return this._smoothCurvePoints(routedPoints, true);
  }

  private _smoothCurvePoints(routedPoints: Vector3[], validateAgainstBlocks: boolean): Vector3[] {
    if (routedPoints.length < 3) {
      return routedPoints;
    }

    const anchorPoints = this._simplifyCurvePoints(routedPoints);
    const roundedPoints = this._buildRoundedCurvePoints(anchorPoints);

    if (!validateAgainstBlocks) {
      return roundedPoints;
    }

    return this._isCurvePointSequenceClear(roundedPoints) ? roundedPoints : routedPoints;
  }

  private _simplifyCurvePoints(points: Vector3[]): Vector3[] {
    if (points.length < 3) {
      return points.map((point) => point.clone());
    }

    const simplified: Vector3[] = [points[0].clone()];

    for (let i = 1; i < points.length - 1; i++) {
      const previous = simplified[simplified.length - 1];
      const current = points[i];
      const next = points[i + 1];

      curveWorkA.subVectors(current, previous);
      curveWorkB.subVectors(next, current);

      if (curveWorkA.lengthSq() <= 0.0001 || curveWorkB.lengthSq() <= 0.0001) {
        continue;
      }

      curveWorkA.normalize();
      curveWorkB.normalize();

      if (curveWorkA.dot(curveWorkB) > 0.999) {
        continue;
      }

      simplified.push(current.clone());
    }

    simplified.push(points[points.length - 1].clone());

    return simplified;
  }

  private _buildRoundedCurvePoints(points: Vector3[]): Vector3[] {
    if (points.length < 3) {
      return this._densifyCurvePoints(points);
    }

    const rounded: Vector3[] = [points[0].clone()];

    for (let i = 1; i < points.length - 1; i++) {
      const previous = points[i - 1];
      const current = points[i];
      const next = points[i + 1];

      curveWorkA.subVectors(current, previous);
      curveWorkB.subVectors(next, current);

      const incomingLength = curveWorkA.length();
      const outgoingLength = curveWorkB.length();

      if (incomingLength <= 0.0001 || outgoingLength <= 0.0001) {
        continue;
      }

      curveWorkA.divideScalar(incomingLength);
      curveWorkB.divideScalar(outgoingLength);

      const radius = Math.min(
        MAX_CORNER_RADIUS,
        incomingLength * 0.35,
        outgoingLength * 0.35,
      );

      if (radius <= 0.001 || curveWorkA.dot(curveWorkB) > 0.999) {
        rounded.push(current.clone());
        continue;
      }

      const entry = current.clone().addScaledVector(curveWorkA, -radius);
      const exit = current.clone().addScaledVector(curveWorkB, radius);

      if (rounded[rounded.length - 1].distanceToSquared(entry) > 0.0001) {
        rounded.push(entry);
      }

      for (let sampleIndex = 1; sampleIndex <= CORNER_SAMPLES; sampleIndex++) {
        const t = sampleIndex / (CORNER_SAMPLES + 1);
        const oneMinusT = 1 - t;

        curveWorkC.copy(entry).multiplyScalar(oneMinusT * oneMinusT);
        curveWorkD.copy(current).multiplyScalar(2 * oneMinusT * t);
        curveWorkE.copy(exit).multiplyScalar(t * t);

        rounded.push(curveWorkC.add(curveWorkD).add(curveWorkE).clone());
      }

      rounded.push(exit);
    }

    rounded.push(points[points.length - 1].clone());

    return this._densifyCurvePoints(rounded);
  }

  private _densifyCurvePoints(points: Vector3[]): Vector3[] {
    if (points.length < 2) {
      return points.map((point) => point.clone());
    }

    const densified: Vector3[] = [points[0].clone()];

    for (let i = 1; i < points.length; i++) {
      const previous = points[i - 1];
      const current = points[i];
      const distance = previous.distanceTo(current);
      const steps = Math.max(1, Math.ceil(distance / PATH_POINT_SPACING));

      for (let step = 1; step <= steps; step++) {
        densified.push(previous.clone().lerp(current, step / steps));
      }
    }

    return densified;
  }

  private _isCurvePointSequenceClear(points: Vector3[]): boolean {
    if (points.length < 2) {
      return true;
    }

    for (let i = 1; i < points.length; i++) {
      const previous = points[i - 1];
      const current = points[i];
      const distance = previous.distanceTo(current);
      const steps = Math.max(1, Math.ceil(distance / BLOCK_CLEARANCE_SAMPLE_SPACING));

      for (let step = 0; step <= steps; step++) {
        curveWorkA.copy(previous).lerp(current, step / steps);

        if (this._isCurvePointBlocked(curveWorkA)) {
          return false;
        }
      }
    }

    return true;
  }

  private _isCurvePointBlocked(point: Vector3): boolean {
    const block = this._game.chunkManager.getBlock({
      x: Math.floor(point.x),
      y: Math.floor(point.y),
      z: Math.floor(point.z),
    });

    return !!block && block.blockId !== 0;
  }

  private _liftCurvePoints(points: Vector3[]): Vector3[] {
    return points.map((point) => point.clone().setY(point.y + ARROW_HOVER_HEIGHT));
  }

  private _projectCurvePointsToGround(points: Vector3[]): Vector3[] {
    const projected: Vector3[] = [];
    let lastGroundY: number | null = null;

    for (let i = 0; i < points.length; i++) {
      const point = points[i];
      const groundY: number | null = this._findGroundYBelowPoint(point) ?? lastGroundY;

      if (groundY === null) {
        projected.push(new Vector3(point.x, point.y - Math.max(ARROW_HOVER_HEIGHT * 0.75, CURVE_SURFACE_OFFSET), point.z));
        continue;
      }

      lastGroundY = groundY;
      projected.push(new Vector3(point.x, groundY + SHADOW_Y_OFFSET, point.z));
    }

    return projected;
  }

  private _findGroundYBelowPoint(point: Vector3): number | null {
    const blockX = Math.floor(point.x);
    const blockZ = Math.floor(point.z);
    const scanStartY = Math.floor(point.y + ARROW_HOVER_HEIGHT + 1);

    for (let i = 0; i <= SHADOW_GROUND_SCAN_DEPTH; i++) {
      const blockY = scanStartY - i;
      const block = this._game.chunkManager.getBlock({ x: blockX, y: blockY, z: blockZ });
      if (!block || block.blockId === 0) {
        continue;
      }

      const blockType = this._game.blockTypeManager.getBlockType(block.blockId);
      if (!blockType || blockType.isLiquid) {
        continue;
      }

      return blockY + 1;
    }

    return null;
  }

  private _clearRibbonGeometry(geometry: BufferGeometry): void {
    geometry.setAttribute('position', new Float32BufferAttribute([], 3));
    geometry.setAttribute('uv', new Float32BufferAttribute([], 2));
    geometry.setIndex([]);
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
  }

  private _rebuildRibbonGeometry(geometry: BufferGeometry, points: Vector3[], width: number): number {
    if (points.length < 2) {
      this._clearRibbonGeometry(geometry);
      return 0;
    }

    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const distances: number[] = [0];

    let totalLength = 0;
    for (let i = 1; i < points.length; i++) {
      totalLength += points[i - 1].distanceTo(points[i]);
      distances.push(totalLength);
    }

    if (totalLength < MIN_ARROW_LENGTH) {
      this._clearRibbonGeometry(geometry);
      return 0;
    }

    curveSide.set(1, 0, 0);

    // The mesh is authored directly in world space so the arrow can follow a routed path.
    // Roll the ribbon around the travel direction onto the alternate local axis.
    for (let i = 0; i < points.length; i++) {
      const point = points[i];
      const previousPoint = points[Math.max(0, i - 1)];
      const nextPoint = points[Math.min(points.length - 1, i + 1)];

      curveDirection.subVectors(nextPoint, previousPoint);

      if (curveDirection.lengthSq() > 0.0001) {
        curveDirection.normalize();
        curveSide.crossVectors(curveUp, curveDirection);

        if (curveSide.lengthSq() <= 0.0001) {
          curveWorkD.subVectors(this._game.camera.activeCamera.position, point);
          curveSide.crossVectors(curveWorkD, curveDirection);
        }

        if (curveSide.lengthSq() > 0.0001) {
          curveSide.normalize();
        }
      }

      curveWorkC.copy(curveSide).multiplyScalar(width * 0.5);
      const v = 1 - (distances[i] / totalLength);

      curvePoint.copy(point).sub(curveWorkC);
      positions.push(curvePoint.x, curvePoint.y, curvePoint.z);
      uvs.push(0, v);

      curvePoint.copy(point).add(curveWorkC);
      positions.push(curvePoint.x, curvePoint.y, curvePoint.z);
      uvs.push(1, v);

      if (i < points.length - 1) {
        const baseIndex = i * 2;
        indices.push(
          baseIndex,
          baseIndex + 1,
          baseIndex + 2,
          baseIndex + 1,
          baseIndex + 3,
          baseIndex + 2,
        );
      }
    }

    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();

    return totalLength;
  }

  public dispose(): void {
    this._game.renderer.removeFromScene(this._shadowMesh);
    this._shadowMesh.geometry.dispose();
    (this._shadowMesh.material as Material).dispose();

    this._game.renderer.removeFromScene(this._mesh);
    this._mesh.geometry.dispose();
    (this._mesh.material as Material).dispose();

    if (this._texturePromise) {
      this._game.customTextureManager.cancel(this._texturePromise, true);
      this._texturePromise = null;
    }

    if (this._textureWrapper) {
      this._game.customTextureManager.release(this._textureWrapper);
      this._textureWrapper = null;
    }

    if (this._texture) {
      this._texture.dispose();
      this._texture = null;
    }
  }
}
