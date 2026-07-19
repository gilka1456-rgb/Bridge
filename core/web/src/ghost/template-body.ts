import * as THREE from "three";
import type { Landmark } from "../models/types";

const VISIBILITY_MIN = 0.35;
const RADIAL_SEGMENTS = 16;
const GHOST_SCALE_X = 2.2;
const GHOST_SCALE_Y = 2.4;
const GHOST_SCALE_Z = 2.2;
const GHOST_FLOOR_OFFSET = -0.1;

export interface TemplateBodyParams {
  shoulderWidth: number;
  hipWidth: number;
  height: number;
  headDiameter: number;
}

export const SPECTRAL_BODY_MEASUREMENT_RATIOS = Object.freeze({
  shoulderToHeight: Object.freeze({ minimum: 0.22, maximum: 0.265 }),
  hipToHeight: Object.freeze({ minimum: 0.16, maximum: 0.24 }),
  hipToShoulder: Object.freeze({ minimum: 0.69, maximum: 0.96 }),
  headToHeight: Object.freeze({ minimum: 0.085, maximum: 0.13 }),
} as const);

export type HullSdfSampler = (point: THREE.Vector3) => number;

interface RingRadius {
  radial: number;
  depth: number;
}

interface GeometryBuilder {
  positions: number[];
  indices: number[];
  regions: number[];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function landmarkVector(point: Landmark): THREE.Vector3 {
  return new THREE.Vector3(
    point.x * GHOST_SCALE_X,
    -point.y * GHOST_SCALE_Y + GHOST_FLOOR_OFFSET,
    -point.z * GHOST_SCALE_Z,
  );
}

function visibleVector(landmarks: Landmark[], index: number): THREE.Vector3 | null {
  const point = landmarks[index];
  return point && point.visibility >= VISIBILITY_MIN ? landmarkVector(point) : null;
}

function midpoint(a: THREE.Vector3, b: THREE.Vector3): THREE.Vector3 {
  return a.clone().add(b).multiplyScalar(0.5);
}

function finiteDistance(a: THREE.Vector3 | null, b: THREE.Vector3 | null, fallback: number): number {
  if (!a || !b) return fallback;
  const distance = a.distanceTo(b);
  return Number.isFinite(distance) && distance > 1e-4 ? distance : fallback;
}

export function estimateTemplateBodyParams(landmarks: Landmark[]): TemplateBodyParams {
  const leftShoulder = visibleVector(landmarks, 11);
  const rightShoulder = visibleVector(landmarks, 12);
  const leftHip = visibleVector(landmarks, 23);
  const rightHip = visibleVector(landmarks, 24);
  const leftAnkle = visibleVector(landmarks, 27);
  const rightAnkle = visibleVector(landmarks, 28);
  const leftEar = visibleVector(landmarks, 7);
  const rightEar = visibleVector(landmarks, 8);
  const nose = visibleVector(landmarks, 0);

  const measuredShoulderWidth = finiteDistance(leftShoulder, rightShoulder, 0.52);
  const provisionalHeadDiameter = clamp(
    leftEar && rightEar
      ? Math.max(leftEar.distanceTo(rightEar) * 1.25, measuredShoulderWidth * 0.4)
      : measuredShoulderWidth * 0.4,
    0.2,
    0.38,
  );
  const ankleCenter = leftAnkle && rightAnkle ? midpoint(leftAnkle, rightAnkle) : leftAnkle ?? rightAnkle;
  const headCenter = leftEar && rightEar ? midpoint(leftEar, rightEar) : nose;
  const shoulderCenter = leftShoulder && rightShoulder ? midpoint(leftShoulder, rightShoulder) : null;
  const hipCenter = leftHip && rightHip ? midpoint(leftHip, rightHip) : null;
  const upperBodyDerivedHeight = headCenter && hipCenter
    ? headCenter.distanceTo(hipCenter) / 0.46
    : shoulderCenter && hipCenter
      ? shoulderCenter.distanceTo(hipCenter) / 0.3
    : 2.15;
  const measuredHeight = headCenter && ankleCenter
    ? headCenter.y - ankleCenter.y + provisionalHeadDiameter * 0.58
    : upperBodyDerivedHeight;
  const height = clamp(measuredHeight, 1.55, 2.8);
  const shoulderWidth = clamp(
    measuredShoulderWidth,
    Math.max(0.34, height * SPECTRAL_BODY_MEASUREMENT_RATIOS.shoulderToHeight.minimum),
    Math.min(0.82, height * SPECTRAL_BODY_MEASUREMENT_RATIOS.shoulderToHeight.maximum),
  );
  // Hip landmarks describe joint centres rather than the outer body surface.
  // Expand them to an anatomical silhouette and keep detector outliers from
  // combining a valid height with implausibly narrow or broad body widths.
  const measuredHipJoints = finiteDistance(leftHip, rightHip, shoulderWidth * 0.54);
  const hipWidth = clamp(
    Math.max(
      measuredHipJoints * 1.22,
      shoulderWidth * SPECTRAL_BODY_MEASUREMENT_RATIOS.hipToShoulder.minimum,
    ),
    Math.max(
      0.3,
      height * SPECTRAL_BODY_MEASUREMENT_RATIOS.hipToHeight.minimum,
      shoulderWidth * SPECTRAL_BODY_MEASUREMENT_RATIOS.hipToShoulder.minimum,
    ),
    Math.min(
      0.68,
      height * SPECTRAL_BODY_MEASUREMENT_RATIOS.hipToHeight.maximum,
      shoulderWidth * SPECTRAL_BODY_MEASUREMENT_RATIOS.hipToShoulder.maximum,
    ),
  );
  const headDiameter = clamp(
    leftEar && rightEar
      ? Math.max(leftEar.distanceTo(rightEar) * 1.25, shoulderWidth * 0.4)
      : shoulderWidth * 0.4,
    Math.max(0.2, height * SPECTRAL_BODY_MEASUREMENT_RATIOS.headToHeight.minimum),
    Math.min(0.38, height * SPECTRAL_BODY_MEASUREMENT_RATIOS.headToHeight.maximum),
  );
  return { shoulderWidth, hipWidth, height, headDiameter };
}

export function hashTemplateBodyParams(params: TemplateBodyParams): string {
  return [params.shoulderWidth, params.hipWidth, params.height, params.headDiameter]
    .map((value) => value.toFixed(4))
    .join(":");
}

function ringFrame(points: THREE.Vector3[], index: number): [THREE.Vector3, THREE.Vector3] {
  const previous = points[Math.max(0, index - 1)];
  const next = points[Math.min(points.length - 1, index + 1)];
  const tangent = next.clone().sub(previous).normalize();
  const reference = Math.abs(tangent.y) > 0.88
    ? new THREE.Vector3(0, 0, 1)
    : new THREE.Vector3(0, 1, 0);
  const normalA = new THREE.Vector3().crossVectors(tangent, reference).normalize();
  const normalB = new THREE.Vector3().crossVectors(tangent, normalA).normalize();
  return [normalA, normalB];
}

function addTubeChain(
  builder: GeometryBuilder,
  points: THREE.Vector3[],
  radii: RingRadius[],
  regions: number[],
): void {
  if (points.length < 2 || points.length !== radii.length || points.length !== regions.length) return;
  const firstVertex = builder.positions.length / 3;
  points.forEach((point, ringIndex) => {
    const [normalA, normalB] = ringFrame(points, ringIndex);
    for (let segment = 0; segment < RADIAL_SEGMENTS; segment += 1) {
      const angle = (segment / RADIAL_SEGMENTS) * Math.PI * 2;
      const offset = normalA.clone().multiplyScalar(Math.cos(angle) * radii[ringIndex].radial)
        .add(normalB.clone().multiplyScalar(Math.sin(angle) * radii[ringIndex].depth));
      const vertex = point.clone().add(offset);
      builder.positions.push(vertex.x, vertex.y, vertex.z);
      builder.regions.push(regions[ringIndex]);
    }
  });

  for (let ring = 0; ring + 1 < points.length; ring += 1) {
    for (let segment = 0; segment < RADIAL_SEGMENTS; segment += 1) {
      const nextSegment = (segment + 1) % RADIAL_SEGMENTS;
      const a = firstVertex + ring * RADIAL_SEGMENTS + segment;
      const b = firstVertex + ring * RADIAL_SEGMENTS + nextSegment;
      const c = firstVertex + (ring + 1) * RADIAL_SEGMENTS + segment;
      const d = firstVertex + (ring + 1) * RADIAL_SEGMENTS + nextSegment;
      builder.indices.push(a, c, b, b, c, d);
    }
  }

  const addCap = (ringIndex: number, reverse: boolean) => {
    const centerIndex = builder.positions.length / 3;
    const point = points[ringIndex];
    builder.positions.push(point.x, point.y, point.z);
    builder.regions.push(regions[ringIndex]);
    for (let segment = 0; segment < RADIAL_SEGMENTS; segment += 1) {
      const nextSegment = (segment + 1) % RADIAL_SEGMENTS;
      const a = firstVertex + ringIndex * RADIAL_SEGMENTS + segment;
      const b = firstVertex + ringIndex * RADIAL_SEGMENTS + nextSegment;
      builder.indices.push(centerIndex, ...(reverse ? [b, a] : [a, b]));
    }
  };
  addCap(0, true);
  addCap(points.length - 1, false);
}

function standardSkeleton(params: TemplateBodyParams): Record<string, THREE.Vector3> {
  const halfHeight = params.height / 2;
  return {
    head: new THREE.Vector3(0, halfHeight - params.headDiameter * 0.5, 0),
    leftShoulder: new THREE.Vector3(-params.shoulderWidth / 2, halfHeight - params.headDiameter * 1.55, 0),
    rightShoulder: new THREE.Vector3(params.shoulderWidth / 2, halfHeight - params.headDiameter * 1.55, 0),
    leftElbow: new THREE.Vector3(-params.shoulderWidth * 0.72, halfHeight - params.height * 0.4, 0),
    rightElbow: new THREE.Vector3(params.shoulderWidth * 0.72, halfHeight - params.height * 0.4, 0),
    leftWrist: new THREE.Vector3(-params.shoulderWidth * 0.76, halfHeight - params.height * 0.62, 0),
    rightWrist: new THREE.Vector3(params.shoulderWidth * 0.76, halfHeight - params.height * 0.62, 0),
    leftHip: new THREE.Vector3(-params.hipWidth / 2, halfHeight - params.height * 0.5, 0),
    rightHip: new THREE.Vector3(params.hipWidth / 2, halfHeight - params.height * 0.5, 0),
    leftKnee: new THREE.Vector3(-params.hipWidth * 0.42, halfHeight - params.height * 0.72, 0),
    rightKnee: new THREE.Vector3(params.hipWidth * 0.42, halfHeight - params.height * 0.72, 0),
    leftAnkle: new THREE.Vector3(-params.hipWidth * 0.38, -halfHeight + params.headDiameter * 0.12, 0),
    rightAnkle: new THREE.Vector3(params.hipWidth * 0.38, -halfHeight + params.headDiameter * 0.12, 0),
  };
}

function resolvedPoint(
  landmarks: Landmark[],
  index: number,
  fallback: THREE.Vector3,
): THREE.Vector3 {
  return visibleVector(landmarks, index) ?? fallback.clone();
}

/** 程序化低模人体：关节链共享顶点环，所有部位输出为单一 BufferGeometry。 */
export function buildTemplateBodyGeometry(
  landmarks: Landmark[],
  overrides: Partial<TemplateBodyParams> = {},
): THREE.BufferGeometry {
  const params = { ...estimateTemplateBodyParams(landmarks), ...overrides };
  const standard = standardSkeleton(params);
  const leftShoulder = resolvedPoint(landmarks, 11, standard.leftShoulder);
  const rightShoulder = resolvedPoint(landmarks, 12, standard.rightShoulder);
  const leftElbow = resolvedPoint(landmarks, 13, standard.leftElbow);
  const rightElbow = resolvedPoint(landmarks, 14, standard.rightElbow);
  const leftWrist = resolvedPoint(landmarks, 15, standard.leftWrist);
  const rightWrist = resolvedPoint(landmarks, 16, standard.rightWrist);
  const leftHip = resolvedPoint(landmarks, 23, standard.leftHip);
  const rightHip = resolvedPoint(landmarks, 24, standard.rightHip);
  const shoulderCenter = midpoint(leftShoulder, rightShoulder);
  const pelvis = midpoint(leftHip, rightHip);
  const up = shoulderCenter.clone().sub(pelvis);
  if (up.lengthSq() < 1e-6) up.set(0, 1, 0);
  else up.normalize();
  const bodyRight = rightHip.clone().sub(leftHip);
  if (bodyRight.lengthSq() < 1e-6) bodyRight.set(1, 0, 0);
  else bodyRight.normalize();
  const headFallback = standard.head.clone();
  const leftEar = visibleVector(landmarks, 7);
  const rightEar = visibleVector(landmarks, 8);
  const head = leftEar && rightEar
    ? midpoint(leftEar, rightEar)
    : visibleVector(landmarks, 0) ?? headFallback;
  const lowerBodyMissing = [25, 26, 27, 28]
    .some((index) => visibleVector(landmarks, index) === null);
  const upperBodyHeight = head.distanceTo(pelvis) + params.headDiameter * 0.5;
  const standardLegLength = lowerBodyMissing
    ? clamp(Math.max(params.height * 0.47, upperBodyHeight * 1.02), 0.8, 1.55)
    : params.height * 0.47;
  // 缺失下肢必须在当前骨盆坐标系内补全，不能混用以世界原点为中心的标准坐标。
  const standardLeftAnkle = pelvis.clone()
    .addScaledVector(up, -standardLegLength)
    .addScaledVector(bodyRight, -params.hipWidth * 0.38);
  const standardRightAnkle = pelvis.clone()
    .addScaledVector(up, -standardLegLength)
    .addScaledVector(bodyRight, params.hipWidth * 0.38);
  const standardLeftKnee = leftHip.clone().lerp(standardLeftAnkle, 0.47);
  const standardRightKnee = rightHip.clone().lerp(standardRightAnkle, 0.47);
  const leftKnee = resolvedPoint(landmarks, 25, standardLeftKnee);
  const rightKnee = resolvedPoint(landmarks, 26, standardRightKnee);
  const leftAnkle = resolvedPoint(landmarks, 27, standardLeftAnkle);
  const rightAnkle = resolvedPoint(landmarks, 28, standardRightAnkle);
  const waist = pelvis.clone().lerp(shoulderCenter, 0.42);

  const builder: GeometryBuilder = { positions: [], indices: [], regions: [] };
  const headRadius = params.headDiameter / 2;
  addTubeChain(builder, [
    head.clone().addScaledVector(up, headRadius),
    head.clone().addScaledVector(up, headRadius * 0.7),
    head.clone().addScaledVector(up, headRadius * 0.3),
    head.clone().addScaledVector(up, -headRadius * 0.15),
    head.clone().addScaledVector(up, -headRadius * 0.55),
    head.clone().addScaledVector(up, -headRadius * 0.85),
    shoulderCenter.clone().addScaledVector(up, params.headDiameter * 0.22),
    shoulderCenter,
    waist,
    pelvis,
    pelvis.clone().addScaledVector(up, -params.hipWidth * 0.16),
  ], [
    { radial: headRadius * 0.08, depth: headRadius * 0.08 },
    { radial: headRadius * 0.7, depth: headRadius * 0.62 },
    { radial: headRadius * 0.95, depth: headRadius * 0.84 },
    { radial: headRadius, depth: headRadius * 0.9 },
    { radial: headRadius * 0.82, depth: headRadius * 0.76 },
    { radial: headRadius * 0.5, depth: headRadius * 0.46 },
    { radial: params.shoulderWidth * 0.16, depth: params.shoulderWidth * 0.12 },
    { radial: params.shoulderWidth * 0.49, depth: params.shoulderWidth * 0.25 },
    { radial: (params.shoulderWidth + params.hipWidth) * 0.2, depth: params.shoulderWidth * 0.22 },
    { radial: params.hipWidth * 0.52, depth: params.hipWidth * 0.36 },
    { radial: params.hipWidth * 0.43, depth: params.hipWidth * 0.32 },
  ], [0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1]);

  const addArm = (shoulder: THREE.Vector3, elbow: THREE.Vector3, wrist: THREE.Vector3) => {
    const hand = wrist.clone().add(wrist.clone().sub(elbow).multiplyScalar(0.22));
    const upper = Math.max(0.06, params.shoulderWidth * 0.115);
    addTubeChain(builder, [shoulder, elbow, wrist, hand], [
      { radial: upper, depth: upper * 0.86 },
      { radial: upper * 0.82, depth: upper * 0.78 },
      { radial: upper * 0.62, depth: upper * 0.56 },
      { radial: upper * 0.68, depth: upper * 0.44 },
    ], [0, 0, 0, 0]);
  };
  addArm(leftShoulder, leftElbow, leftWrist);
  addArm(rightShoulder, rightElbow, rightWrist);

  const addLeg = (hip: THREE.Vector3, knee: THREE.Vector3, ankle: THREE.Vector3) => {
    const forward = new THREE.Vector3(0, -params.headDiameter * 0.08, params.headDiameter * 0.72);
    const foot = ankle.clone().add(forward);
    const upper = Math.max(0.09, params.hipWidth * 0.3);
    addTubeChain(builder, [hip, knee, ankle, foot], [
      { radial: upper, depth: upper * 0.9 },
      { radial: upper * 0.72, depth: upper * 0.7 },
      { radial: upper * 0.48, depth: upper * 0.46 },
      { radial: upper * 0.62, depth: upper * 0.9 },
    ], [1, 1, 0, 0]);
  };
  addLeg(leftHip, leftKnee, leftAnkle);
  addLeg(rightHip, rightKnee, rightAnkle);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(builder.positions, 3));
  geometry.setAttribute("bridgeRegion", new THREE.Uint8BufferAttribute(builder.regions, 1));
  geometry.setIndex(builder.indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.userData.templateParams = params;
  return geometry;
}

/** 仅对可信部位沿法线做受限外壳包裹，保证头和手臂不会被坏剪影雕掉。 */
export function shrinkWrapToHull(
  templateGeometry: THREE.BufferGeometry,
  hullSdfSampler: HullSdfSampler,
  regionMask?: ArrayLike<number>,
): THREE.BufferGeometry {
  const geometry = templateGeometry.clone();
  if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
  const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
  const normals = geometry.getAttribute("normal") as THREE.BufferAttribute;
  const regions = regionMask ?? (geometry.getAttribute("bridgeRegion") as THREE.BufferAttribute | undefined)?.array;
  const point = new THREE.Vector3();
  const normal = new THREE.Vector3();
  for (let index = 0; index < positions.count; index += 1) {
    if (!regions || Number(regions[index]) < 0.5) continue;
    point.fromBufferAttribute(positions, index);
    normal.fromBufferAttribute(normals, index).normalize();
    const distance = hullSdfSampler(point);
    if (!Number.isFinite(distance)) continue;
    point.addScaledVector(normal, clamp(distance, -0.03, 0.06));
    positions.setXYZ(index, point.x, point.y, point.z);
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}
