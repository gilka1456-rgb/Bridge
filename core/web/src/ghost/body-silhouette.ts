import * as THREE from "three";
import type { BodyBuildOptions, GhostStyleId, Landmark } from "../models/types";
import { profileScaleAtY } from "../pose/segmentation";
import { createHolographicMaterial } from "./ghost-shader";
import { GHOST_STYLES } from "./styles";
import { buildVisualHullGeometry } from "./visual-hull";

const VISIBILITY_MIN = 0.35;

const GHOST_SCALE_X = 2.2;
const GHOST_SCALE_Y = 2.4;
const GHOST_SCALE_Z = 2.2;
const GHOST_FLOOR_OFFSET = -0.1;

const HULL_SCALE_X = GHOST_SCALE_X * 0.45;
const HULL_SCALE_Y = GHOST_SCALE_Y * 0.5;
const HULL_SCALE_Z = GHOST_SCALE_Z * 0.45;

const hullGeometryCache = new Map<string, THREE.BufferGeometry>();

export function evictHullGeometry(avatarId: string): void {
  const geometry = hullGeometryCache.get(avatarId);
  geometry?.dispose();
  hullGeometryCache.delete(avatarId);
}

export function clearHullGeometryCache(): void {
  hullGeometryCache.forEach((geometry) => geometry.dispose());
  hullGeometryCache.clear();
}

export function landmarkToVector(point: Landmark): THREE.Vector3 {
  return new THREE.Vector3(
    point.x * GHOST_SCALE_X,
    -point.y * GHOST_SCALE_Y + GHOST_FLOOR_OFFSET,
    -point.z * GHOST_SCALE_Z,
  );
}

function getVector(landmarks: Landmark[], index: number): THREE.Vector3 | null {
  const point = landmarks[index];
  if (!point || point.visibility < VISIBILITY_MIN) {
    return null;
  }
  return landmarkToVector(point);
}

function midpoint(a: THREE.Vector3, b: THREE.Vector3): THREE.Vector3 {
  return a.clone().add(b).multiplyScalar(0.5);
}

function createBodyMaterial(styleId: GhostStyleId, options?: { brighter?: boolean }): THREE.Material {
  const style = GHOST_STYLES[styleId];
  if (style.holographic) {
    return createHolographicMaterial(styleId);
  }

  const brighter = options?.brighter ?? false;
  const emissiveIntensity = style.emissive * (brighter ? 1.15 : 1);
  const material = new THREE.MeshStandardMaterial({
    color: style.color,
    transparent: true,
    opacity: brighter ? Math.min(style.opacity + 0.12, 0.75) : style.opacity,
    emissive: new THREE.Color(style.color),
    emissiveIntensity,
    metalness: style.metalness,
    roughness: style.roughness,
    wireframe: style.wireframe ?? false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  material.userData = { baseEmissive: emissiveIntensity };
  return material;
}

function radiusScale(options: BodyBuildOptions | undefined, landmark: Landmark, fallback: number): number {
  if (!options?.bodyProfile?.length) {
    return fallback;
  }
  const imageY = landmark.y;
  return fallback * profileScaleAtY(options.bodyProfile, imageY, 1);
}

function addCapsuleLimb(
  parent: THREE.Group,
  start: THREE.Vector3,
  end: THREE.Vector3,
  radius: number,
  material: THREE.Material,
): void {
  const direction = new THREE.Vector3().subVectors(end, start);
  const length = Math.max(direction.length() - radius * 2, 0.04);
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, length, 6, 12), material);
  mesh.position.copy(start).add(end).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  parent.add(mesh);
}

function addTorso(
  parent: THREE.Group,
  leftShoulder: THREE.Vector3,
  rightShoulder: THREE.Vector3,
  leftHip: THREE.Vector3,
  rightHip: THREE.Vector3,
  material: THREE.Material,
  scale = 1,
): void {
  const shoulderCenter = midpoint(leftShoulder, rightShoulder);
  const hipCenter = midpoint(leftHip, rightHip);
  const shoulderWidth = leftShoulder.distanceTo(rightShoulder);
  const hipWidth = leftHip.distanceTo(rightHip);
  const torsoHeight = shoulderCenter.distanceTo(hipCenter);
  const width = Math.max(shoulderWidth, hipWidth) * 0.72 * scale;
  const depth = width * 0.48;

  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(width, torsoHeight, depth, 1, 1, 1),
    material,
  );
  mesh.position.copy(shoulderCenter).add(hipCenter).multiplyScalar(0.5);
  parent.add(mesh);
}

function addHead(
  parent: THREE.Group,
  landmarks: Landmark[],
  material: THREE.Material,
  options?: BodyBuildOptions,
): void {
  const nose = landmarks[0];
  const leftEar = landmarks[7];
  const rightEar = landmarks[8];
  const leftShoulder = landmarks[11];
  const rightShoulder = landmarks[12];

  const noseVec = nose ? getVector(landmarks, 0) : null;
  const leftEarVec = leftEar ? getVector(landmarks, 7) : null;
  const rightEarVec = rightEar ? getVector(landmarks, 8) : null;
  const leftShoulderVec = leftShoulder ? getVector(landmarks, 11) : null;
  const rightShoulderVec = rightShoulder ? getVector(landmarks, 12) : null;

  let center: THREE.Vector3 | null = null;
  if (leftEarVec && rightEarVec) {
    center = midpoint(leftEarVec, rightEarVec);
  } else if (noseVec && leftShoulderVec && rightShoulderVec) {
    const shoulderCenter = midpoint(leftShoulderVec, rightShoulderVec);
    center = noseVec.clone().lerp(shoulderCenter, 0.35);
  } else if (noseVec) {
    center = noseVec;
  }

  if (!center) {
    return;
  }

  let radius = 0.11;
  if (leftEarVec && rightEarVec) {
    radius = Math.max(leftEarVec.distanceTo(rightEarVec) * 0.55, 0.08);
  } else if (leftShoulderVec && rightShoulderVec) {
    radius = leftShoulderVec.distanceTo(rightShoulderVec) * 0.22;
  }

  if (nose) {
    radius *= radiusScale(options, nose, 1);
  }

  const head = new THREE.Mesh(new THREE.SphereGeometry(radius, 14, 12), material);
  head.position.copy(center);
  parent.add(head);
}

function addLimbChain(
  parent: THREE.Group,
  landmarks: Landmark[],
  indices: [number, number, number],
  radii: [number, number, number],
  material: THREE.Material,
  options?: BodyBuildOptions,
): void {
  const points = indices.map((index) => getVector(landmarks, index));
  if (points.some((point) => !point)) {
    return;
  }

  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index]!;
    const end = points[index + 1]!;
    const landmark = landmarks[indices[index]];
    const baseRadius = (radii[index] + radii[index + 1]) / 2;
    const radius = radiusScale(options, landmark, baseRadius);
    addCapsuleLimb(parent, start, end, radius, material);
  }
}

function addSegmentationShell(
  parent: THREE.Group,
  landmarks: Landmark[],
  contour: BodyBuildOptions["silhouetteContour"],
  material: THREE.Material,
): void {
  if (!contour?.length) {
    return;
  }

  const visible = landmarks.filter((point) => point.visibility >= VISIBILITY_MIN);
  if (visible.length < 4) {
    return;
  }

  const ys = visible.map((point) => point.y);
  const xs = visible.map((point) => point.x);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;

  const shape = new THREE.Shape();
  const first = contour[0];
  shape.moveTo(
    (first.x - centerX) * GHOST_SCALE_X * 2.2,
    -(first.y - centerY) * GHOST_SCALE_Y * 2.2 + GHOST_FLOOR_OFFSET,
  );
  for (let index = 1; index < contour.length; index += 1) {
    const point = contour[index];
    shape.lineTo(
      (point.x - centerX) * GHOST_SCALE_X * 2.2,
      -(point.y - centerY) * GHOST_SCALE_Y * 2.2 + GHOST_FLOOR_OFFSET,
    );
  }
  shape.closePath();

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 0.12,
    bevelEnabled: false,
    curveSegments: 1,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.z = -0.06;
  parent.add(mesh);
}

function buildBodyCore(
  landmarks: Landmark[],
  material: THREE.Material,
  options?: BodyBuildOptions,
): THREE.Group {
  const group = new THREE.Group();

  const leftShoulder = getVector(landmarks, 11);
  const rightShoulder = getVector(landmarks, 12);
  const leftHip = getVector(landmarks, 23);
  const rightHip = getVector(landmarks, 24);

  const torsoScale = landmarks[11] ? profileScaleAtY(options?.bodyProfile, landmarks[11].y, 1) : 1;

  if (leftShoulder && rightShoulder && leftHip && rightHip) {
    addTorso(group, leftShoulder, rightShoulder, leftHip, rightHip, material, torsoScale);
  }

  addHead(group, landmarks, material, options);

  addLimbChain(group, landmarks, [11, 13, 15], [0.048, 0.04, 0.034], material, options);
  addLimbChain(group, landmarks, [12, 14, 16], [0.048, 0.04, 0.034], material, options);
  addLimbChain(group, landmarks, [23, 25, 27], [0.062, 0.05, 0.038], material, options);
  addLimbChain(group, landmarks, [24, 26, 28], [0.062, 0.05, 0.038], material, options);

  return group;
}

function getCachedHullGeometry(options: BodyBuildOptions): THREE.BufferGeometry | null {
  if (!options.avatarId || !options.orientations || options.orientations.length < 2) {
    return null;
  }

  const cached = hullGeometryCache.get(options.avatarId);
  if (cached) {
    return cached;
  }

  const geometry = buildVisualHullGeometry(options.orientations);
  if (geometry) {
    geometry.userData.bridgeSharedGeometry = true;
    hullGeometryCache.set(options.avatarId, geometry);
  }
  return geometry;
}

function applyHullTransform(mesh: THREE.Mesh): void {
  mesh.scale.set(HULL_SCALE_X, HULL_SCALE_Y, HULL_SCALE_Z);
  mesh.position.y = GHOST_FLOOR_OFFSET;
}

function tryAddVisualHull(
  group: THREE.Group,
  styleId: GhostStyleId,
  options?: BodyBuildOptions,
): boolean {
  if (!options) {
    return false;
  }

  const geometry = getCachedHullGeometry(options);
  if (!geometry) {
    return false;
  }

  const style = GHOST_STYLES[styleId];
  const material = style.holographic ? createHolographicMaterial(styleId) : createBodyMaterial(styleId);
  const hullMesh = new THREE.Mesh(geometry, material);
  hullMesh.name = "visual-hull";
  applyHullTransform(hullMesh);
  group.add(hullMesh);

  if (style.rimGlow > 0 && !style.holographic) {
    const glowMaterial = createBodyMaterial(styleId, { brighter: true });
    const glowMesh = new THREE.Mesh(geometry, glowMaterial);
    glowMesh.name = "visual-hull-glow";
    applyHullTransform(glowMesh);
    glowMesh.scale.multiplyScalar(1.06);
    group.add(glowMesh);
  }

  return true;
}

export function buildBodySilhouetteGroup(
  landmarks: Landmark[],
  styleId: GhostStyleId,
  options?: BodyBuildOptions,
): THREE.Group {
  const group = new THREE.Group();
  group.name = "body-silhouette";

  if (tryAddVisualHull(group, styleId, options)) {
    return group;
  }

  const bodyMaterial = createBodyMaterial(styleId);
  group.add(buildBodyCore(landmarks, bodyMaterial, options));

  if (options?.silhouetteContour?.length) {
    const shellMaterial = GHOST_STYLES[styleId].holographic
      ? createHolographicMaterial(styleId)
      : createBodyMaterial(styleId, { brighter: true });
    addSegmentationShell(group, landmarks, options.silhouetteContour, shellMaterial);
  }

  const style = GHOST_STYLES[styleId];
  if (style.rimGlow > 0 && !style.holographic) {
    const glowMaterial = createBodyMaterial(styleId, { brighter: true });
    const glowShell = buildBodyCore(landmarks, glowMaterial, options);
    glowShell.scale.setScalar(1.06);
    group.add(glowShell);
  }

  return group;
}
