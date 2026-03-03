import { Box3, Color, Mesh, Quaternion, Vector3, type Vector3Like } from 'three';

// Threshold for determining whether the result of lerp or slerp is close enough to the target
// value. This value wasn't chosen based on strong evidence, so it may need to be reconsidered.
const EPSILON = 0.000001;

// working variables
const vec3 = new Vector3();
const box3 = new Box3();

export type Vector3LikeMutable = {
  x: number;
  y: number;
  z: number;
};

// In Three.js, lerp and slerp often fail to exactly match the target value, especially when
// the second argument is not 1. To address this, we provide utility functions that copy the
// target value once it's within a certain threshold and return true when that happens.
// These utilities make it easier to perform interpolations where a value gradually
// approaches a target, and stop updating once it's close enough.
export const lerp = (v1: Vector3, v2: Vector3, alpha: number): boolean => {
  v1.lerp(v2, alpha);
  if (
    Math.abs(v1.x - v2.x) <= EPSILON &&
    Math.abs(v1.y - v2.y) <= EPSILON &&
    Math.abs(v1.z - v2.z) <= EPSILON
  ) {
    v1.copy(v2);
    return true;
  }
  return false;
};

export const slerp = (q1: Quaternion, q2: Quaternion, t: number): boolean => {
  q1.slerp(q2, t);
  if (
    Math.abs(q1.x - q2.x) <= EPSILON &&
    Math.abs(q1.y - q2.y) <= EPSILON &&
    Math.abs(q1.z - q2.z) <= EPSILON &&
    Math.abs(q1.w - q2.w) <= EPSILON
  ) {
    q1.copy(q2);
    return true;
  }
  return false;
};

export const lerpColor = (c1: Color, c2: Color, alpha: number): boolean => {
  c1.lerp(c2, alpha);
  if (
    Math.abs(c1.r - c2.r) <= EPSILON &&
    Math.abs(c1.g - c2.g) <= EPSILON &&
    Math.abs(c1.b - c2.b) <= EPSILON
  ) {
    c1.copy(c2);
    return true;
  }
  return false;
};

export const toVector3 = (v: Vector3Like | undefined): Vector3 | undefined => {
  return v ? new Vector3().copy(v) : undefined;
};

// Transparent Sort for detemining render order

type TransparentSortData = {
  center: Vector3;
  halfSize: Vector3;
  key: number;
  frame: number;
};

const TRANSPARENT_SORT_DATA = 'TransparentSortData';

// For optimization purposes, the design explicitly requires calling the AABB update function when the world matrix is updated.
export const updateAABB = (mesh: Mesh): void => {
  if (!(TRANSPARENT_SORT_DATA in mesh.userData)) {
    const data: TransparentSortData = {
      center: new Vector3(),
      halfSize: new Vector3(),
      key: -1,
      frame: -1,
    };
    mesh.userData[TRANSPARENT_SORT_DATA] = data;
  }

  if (mesh.geometry.boundingBox === null) {
    mesh.geometry.computeBoundingBox();
  }

  const { center, halfSize } = mesh.userData[TRANSPARENT_SORT_DATA] as TransparentSortData;
  box3.copy(mesh.geometry.boundingBox!).applyMatrix4(mesh.matrixWorld);
  box3.getCenter(center);
  box3.getSize(halfSize).multiplyScalar(0.5);
};

const calculateDistanceKey = (center: Vector3, halfSize: Vector3, cameraPos: Vector3, viewDir: Vector3): number => {
  const centerDist = vec3.copy(center).sub(cameraPos).dot(viewDir);
  const projRadius = halfSize.dot(vec3.set(Math.abs(viewDir.x), Math.abs(viewDir.y), Math.abs(viewDir.z)));
  return centerDist + projRadius;
};

// Use the farthest point of the AABB as the reference for determining the
// rendering order of transparent objects. In our usecase, this seems to
// provide better accuracy than using the center point.
export const getTransparentSortKey = (mesh: Mesh, cameraPos: Vector3, viewDir: Vector3, frame: number): number => {
  if (!(TRANSPARENT_SORT_DATA in mesh.userData)) {
    throw new Error(`getTransparentSortKey(): ${TRANSPARENT_SORT_DATA} is not found in Mesh.userData ${mesh.uuid}.`);
  }

  const data = mesh.userData[TRANSPARENT_SORT_DATA] as TransparentSortData;

  if (data.frame !== frame) {
    data.key = calculateDistanceKey(data.center, data.halfSize, cameraPos, viewDir);
    data.frame = frame;
  }

  return data.key;
};
