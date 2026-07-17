import * as THREE from "three";
import { edgeTable, triTable } from "three/examples/jsm/objects/MarchingCubes.js";
import type { Landmark, OrientationMask } from "../models/types";
import {
  GHOST_BODY_MODEL_VERSION,
  GHOST_BODY_REGIONS,
  GHOST_RIG_BONE_NAMES,
  GHOST_RIG_VERSION,
  type BodyMeasurements,
  type GhostBodyModel,
  type GhostBodyQuality,
  type GhostLodMesh,
  type GhostRig,
} from "./body-model";
import { estimateTemplateBodyParams } from "./template-body";
import { createVisualHullSdfSampler } from "./visual-hull";
import { assignProgrammaticSkinWeights } from "./body-skinning";

export const SPECTRAL_BODY_ALGORITHM_VERSION = "anatomical-sdf-v7-continuous-profile";
export const SPECTRAL_BODY_VOXEL_SIZE = 0.018;
export const SPECTRAL_BODY_LOD_VOXEL_SIZES = [0.018, 0.028, 0.042] as const;
export const SPECTRAL_BODY_LOD_TRIANGLE_BUDGETS = [20_000, 8_000, 4_000] as const;
export const SPECTRAL_BODY_REMESH_SCALE = 1.38;

/** Height-normalized adult proportions for the canonical, style-independent body. */
export const SPECTRAL_HUMAN_PROPORTIONS = Object.freeze({
  chestY: 0.22,
  waistY: 0.10,
  pelvisCenterY: 0.05,
  neckY: 0.33,
  headY: 0.42,
  shoulderY: 0.30,
  elbowY: 0.14,
  wristY: -0.02,
  hipJointY: 0.0,
  kneeY: -0.245,
  ankleY: -0.485,
  footY: -0.515,
} as const);

/** Width-normalized lateral joint positions shared by the field and the rig. */
export const SPECTRAL_HUMAN_LATERAL_PROPORTIONS = Object.freeze({
  shoulderX: 0.47,
  elbowX: 0.70,
  wristX: 0.875,
  hipX: 0.34,
  kneeX: 0.34,
  ankleX: 0.275,
} as const);

const HULL_SCALE_X = 2.2 * 0.45;
const HULL_SCALE_Y = 2.4 * 0.5;
const HULL_SCALE_Z = 2.2 * 0.45;
const HULL_FLOOR_OFFSET = -0.1;
const HULL_AVERAGE_SCALE = (HULL_SCALE_X + HULL_SCALE_Y + HULL_SCALE_Z) / 3;
const SMOOTH_UNION_RADIUS = 0.045;
const MAX_GRID_POINTS = 1_200_000;
const MAX_TRIANGLES = 120_000;

type Vec3 = readonly [number, number, number];
type GhostBodyRegion = (typeof GHOST_BODY_REGIONS)[keyof typeof GHOST_BODY_REGIONS];

interface EllipsoidPrimitive {
  kind: "ellipsoid";
  center: Vec3;
  radii: Vec3;
  region: GhostBodyRegion;
  chainT: number;
  blendRadius?: number;
}

interface SegmentPrimitive {
  kind: "segment";
  start: Vec3;
  end: Vec3;
  startWidth: number;
  startDepth: number;
  endWidth: number;
  endDepth: number;
  widthBulge?: number;
  depthBulge?: number;
  region: GhostBodyRegion;
  chainStart: number;
  chainEnd: number;
  blendRadius?: number;
}

interface ProfileSection {
  y: number;
  width: number;
  depth: number;
}

/**
 * A closed, vertically sampled elliptical profile. Unlike overlapping torso
 * ellipsoids it has one continuous waist/rib/pelvis silhouette and therefore
 * cannot expose the old stacked-volume seams under scan-line lighting.
 */
interface ProfilePrimitive {
  kind: "profile";
  centerX: number;
  centerZ: number;
  sections: readonly ProfileSection[];
  region: GhostBodyRegion;
  chainStart: number;
  chainEnd: number;
  blendRadius?: number;
}

type BodyPrimitive = EllipsoidPrimitive | SegmentPrimitive | ProfilePrimitive;

interface FieldSample {
  value: number;
  region: GhostBodyRegion;
  chainT: number;
}

interface GridSpec {
  min: [number, number, number];
  max: [number, number, number];
  nx: number;
  ny: number;
  nz: number;
  voxelSize: number;
}

export interface AnatomicalBodyBuildRequest {
  landmarks: Landmark[];
  orientations?: OrientationMask[];
  sourceHash: string;
  partial?: boolean;
  voxelSize?: number;
}

const CORNERS = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 1, 1],
] as const;

const CUBE_EDGES = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
] as const;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function smoothMaximum(a: number, b: number, radius: number): number {
  const h = clamp(0.5 + (a - b) / (2 * radius), 0, 1);
  return b * (1 - h) + a * h + radius * h * (1 - h);
}

function ellipsoidField(primitive: EllipsoidPrimitive, x: number, y: number, z: number): number {
  const dx = (x - primitive.center[0]) / primitive.radii[0];
  const dy = (y - primitive.center[1]) / primitive.radii[1];
  const dz = (z - primitive.center[2]) / primitive.radii[2];
  return (1 - Math.hypot(dx, dy, dz)) * Math.min(...primitive.radii);
}

function segmentProjection(primitive: SegmentPrimitive, x: number, y: number, z: number): number {
  const ax = primitive.start[0];
  const ay = primitive.start[1];
  const az = primitive.start[2];
  const dx = primitive.end[0] - ax;
  const dy = primitive.end[1] - ay;
  const dz = primitive.end[2] - az;
  const lengthSquared = dx * dx + dy * dy + dz * dz;
  if (lengthSquared < 1e-9) return 0;
  return clamp(((x - ax) * dx + (y - ay) * dy + (z - az) * dz) / lengthSquared, 0, 1);
}

function segmentField(primitive: SegmentPrimitive, x: number, y: number, z: number): number {
  const t = segmentProjection(primitive, x, y, z);
  const cx = primitive.start[0] + (primitive.end[0] - primitive.start[0]) * t;
  const cy = primitive.start[1] + (primitive.end[1] - primitive.start[1]) * t;
  const cz = primitive.start[2] + (primitive.end[2] - primitive.start[2]) * t;
  const tx0 = primitive.end[0] - primitive.start[0];
  const ty0 = primitive.end[1] - primitive.start[1];
  const tz0 = primitive.end[2] - primitive.start[2];
  const inverseLength = 1 / Math.max(Math.hypot(tx0, ty0, tz0), 1e-6);
  const tx = tx0 * inverseLength;
  const ty = ty0 * inverseLength;
  const tz = tz0 * inverseLength;
  const reference = Math.abs(tz) < 0.8 ? [0, 0, 1] as const : [1, 0, 0] as const;
  let ux = ty * reference[2] - tz * reference[1];
  let uy = tz * reference[0] - tx * reference[2];
  let uz = tx * reference[1] - ty * reference[0];
  const inverseU = 1 / Math.max(Math.hypot(ux, uy, uz), 1e-6);
  ux *= inverseU;
  uy *= inverseU;
  uz *= inverseU;
  const vx = ty * uz - tz * uy;
  const vy = tz * ux - tx * uz;
  const vz = tx * uy - ty * ux;
  const px = x - cx;
  const py = y - cy;
  const pz = z - cz;
  const midProfile = 4 * t * (1 - t);
  const width = primitive.startWidth + (primitive.endWidth - primitive.startWidth) * t
    + (primitive.widthBulge ?? 0) * midProfile;
  const depth = primitive.startDepth + (primitive.endDepth - primitive.startDepth) * t
    + (primitive.depthBulge ?? 0) * midProfile;
  const lateral = px * ux + py * uy + pz * uz;
  const sagittal = px * vx + py * vy + pz * vz;
  const axial = px * tx + py * ty + pz * tz;
  const normalized = Math.hypot(lateral / width, sagittal / depth, axial / width);
  return (1 - normalized) * Math.min(width, depth);
}

function profileSample(primitive: ProfilePrimitive, y: number): { y: number; width: number; depth: number; t: number } {
  const sections = primitive.sections;
  const first = sections[0];
  const last = sections[sections.length - 1];
  const sampledY = clamp(y, first.y, last.y);
  let upperIndex = 1;
  while (upperIndex < sections.length - 1 && sampledY > sections[upperIndex].y) upperIndex += 1;
  const lower = sections[upperIndex - 1];
  const upper = sections[upperIndex];
  const linearT = clamp((sampledY - lower.y) / Math.max(upper.y - lower.y, 1e-6), 0, 1);
  const easedT = linearT * linearT * (3 - 2 * linearT);
  const span = Math.max(last.y - first.y, 1e-6);
  return {
    y: sampledY,
    width: lower.width + (upper.width - lower.width) * easedT,
    depth: lower.depth + (upper.depth - lower.depth) * easedT,
    t: (sampledY - first.y) / span,
  };
}

function profileField(primitive: ProfilePrimitive, x: number, y: number, z: number): number {
  const sample = profileSample(primitive, y);
  const lateral = (x - primitive.centerX) / sample.width;
  const sagittal = (z - primitive.centerZ) / sample.depth;
  const axial = (y - sample.y) / Math.min(sample.width, sample.depth);
  const normalized = Math.hypot(lateral, sagittal, axial);
  return (1 - normalized) * Math.min(sample.width, sample.depth);
}

function primitiveField(primitive: BodyPrimitive, x: number, y: number, z: number): number {
  if (primitive.kind === "ellipsoid") return ellipsoidField(primitive, x, y, z);
  if (primitive.kind === "segment") return segmentField(primitive, x, y, z);
  return profileField(primitive, x, y, z);
}

function primitiveChainT(primitive: BodyPrimitive, x: number, y: number, z: number): number {
  if (primitive.kind === "ellipsoid") return primitive.chainT;
  const t = primitive.kind === "segment"
    ? segmentProjection(primitive, x, y, z)
    : profileSample(primitive, y).t;
  return primitive.chainStart + (primitive.chainEnd - primitive.chainStart) * t;
}

function sampleAnatomy(
  primitives: BodyPrimitive[],
  x: number,
  y: number,
  z: number,
  output?: FieldSample,
): number {
  let combined = -1e6;
  let strongest = -1e6;
  let strongestPrimitive = primitives[0];
  for (const primitive of primitives) {
    const value = primitiveField(primitive, x, y, z);
    if (value > strongest) {
      strongest = value;
      strongestPrimitive = primitive;
    }
    combined = combined < -1e5
      ? value
      : smoothMaximum(combined, value, primitive.blendRadius ?? SMOOTH_UNION_RADIUS);
  }
  if (output) {
    output.value = combined;
    output.region = strongestPrimitive.region;
    output.chainT = primitiveChainT(strongestPrimitive, x, y, z);
  }
  return combined;
}

function measurementsFromLandmarks(landmarks: Landmark[]): BodyMeasurements {
  const params = estimateTemplateBodyParams(landmarks);
  return {
    height: params.height,
    shoulderWidth: params.shoulderWidth,
    chestWidth: params.shoulderWidth * 0.86,
    waistWidth: (params.shoulderWidth + params.hipWidth) * 0.39,
    hipWidth: params.hipWidth,
    headDiameter: params.headDiameter,
    boneLengths: new Float32Array(GHOST_RIG_BONE_NAMES.length),
  };
}

function createPrimitives(measurements: BodyMeasurements): BodyPrimitive[] {
  const scale = measurements.height / 2.15;
  const height = measurements.height;
  const shoulderHalf = measurements.shoulderWidth * 0.5;
  const hipHalf = measurements.hipWidth * 0.5;
  const chestHalf = measurements.chestWidth * 0.5;
  const waistHalf = measurements.waistWidth * 0.5;
  const headX = measurements.headDiameter * 0.48;
  const headY = measurements.headDiameter * 0.62;
  const headZ = measurements.headDiameter * 0.52;
  const pelvisY = SPECTRAL_HUMAN_PROPORTIONS.pelvisCenterY * height;
  const shoulderY = SPECTRAL_HUMAN_PROPORTIONS.shoulderY * height;
  const elbowY = SPECTRAL_HUMAN_PROPORTIONS.elbowY * height;
  const wristY = SPECTRAL_HUMAN_PROPORTIONS.wristY * height;
  const hipJointY = SPECTRAL_HUMAN_PROPORTIONS.hipJointY * height;
  const kneeY = SPECTRAL_HUMAN_PROPORTIONS.kneeY * height;
  const ankleY = SPECTRAL_HUMAN_PROPORTIONS.ankleY * height;
  const footY = SPECTRAL_HUMAN_PROPORTIONS.footY * height;
  const leftShoulder: Vec3 = [-measurements.shoulderWidth * SPECTRAL_HUMAN_LATERAL_PROPORTIONS.shoulderX, shoulderY, 0];
  const rightShoulder: Vec3 = [measurements.shoulderWidth * SPECTRAL_HUMAN_LATERAL_PROPORTIONS.shoulderX, shoulderY, 0];
  const leftClavicle: Vec3 = [-height * 0.045, shoulderY + height * 0.012, -height * 0.008];
  const rightClavicle: Vec3 = [height * 0.045, shoulderY + height * 0.012, -height * 0.008];
  const leftElbow: Vec3 = [-measurements.shoulderWidth * SPECTRAL_HUMAN_LATERAL_PROPORTIONS.elbowX, elbowY, 0.004];
  const rightElbow: Vec3 = [measurements.shoulderWidth * SPECTRAL_HUMAN_LATERAL_PROPORTIONS.elbowX, elbowY, 0.004];
  const leftWrist: Vec3 = [-measurements.shoulderWidth * SPECTRAL_HUMAN_LATERAL_PROPORTIONS.wristX, wristY, 0.012];
  const rightWrist: Vec3 = [measurements.shoulderWidth * SPECTRAL_HUMAN_LATERAL_PROPORTIONS.wristX, wristY, 0.012];
  const armUpper = clamp(measurements.shoulderWidth * 0.145, 0.062, 0.092);
  const forearm = armUpper * 0.76;
  const thigh = clamp(measurements.hipWidth * 0.275, 0.085, 0.13);
  const calf = thigh * 0.72;
  const leftHip: Vec3 = [-measurements.hipWidth * SPECTRAL_HUMAN_LATERAL_PROPORTIONS.hipX, hipJointY, 0];
  const rightHip: Vec3 = [measurements.hipWidth * SPECTRAL_HUMAN_LATERAL_PROPORTIONS.hipX, hipJointY, 0];
  // Keep the mid-thighs as two distinct volumes. A narrow inward knee axis plus
  // a global smooth-union radius otherwise creates a skirt-like bridge.
  const leftKnee: Vec3 = [-measurements.hipWidth * SPECTRAL_HUMAN_LATERAL_PROPORTIONS.kneeX, kneeY, 0.018];
  const rightKnee: Vec3 = [measurements.hipWidth * SPECTRAL_HUMAN_LATERAL_PROPORTIONS.kneeX, kneeY, 0.018];
  const leftAnkle: Vec3 = [-measurements.hipWidth * SPECTRAL_HUMAN_LATERAL_PROPORTIONS.ankleX, ankleY, 0.012];
  const rightAnkle: Vec3 = [measurements.hipWidth * SPECTRAL_HUMAN_LATERAL_PROPORTIONS.ankleX, ankleY, 0.012];
  const handLength = height * 0.105;
  const leftForearmLength = Math.max(
    Math.hypot(leftWrist[0] - leftElbow[0], leftWrist[1] - leftElbow[1], leftWrist[2] - leftElbow[2]),
    1e-6,
  );
  const rightForearmLength = Math.max(
    Math.hypot(rightWrist[0] - rightElbow[0], rightWrist[1] - rightElbow[1], rightWrist[2] - rightElbow[2]),
    1e-6,
  );
  const leftHandEnd: Vec3 = [
    leftWrist[0] + (leftWrist[0] - leftElbow[0]) / leftForearmLength * handLength,
    leftWrist[1] + (leftWrist[1] - leftElbow[1]) / leftForearmLength * handLength,
    leftWrist[2] + (leftWrist[2] - leftElbow[2]) / leftForearmLength * handLength,
  ];
  const rightHandEnd: Vec3 = [
    rightWrist[0] + (rightWrist[0] - rightElbow[0]) / rightForearmLength * handLength,
    rightWrist[1] + (rightWrist[1] - rightElbow[1]) / rightForearmLength * handLength,
    rightWrist[2] + (rightWrist[2] - rightElbow[2]) / rightForearmLength * handLength,
  ];
  const torsoSections: readonly ProfileSection[] = [
    { y: height * 0.005, width: hipHalf * 0.72, depth: hipHalf * 0.62 },
    { y: pelvisY, width: hipHalf * 1.06, depth: hipHalf * 0.84 },
    { y: height * 0.105, width: waistHalf * 0.96, depth: waistHalf * 0.76 },
    { y: height * 0.155, width: waistHalf * 0.93, depth: waistHalf * 0.73 },
    { y: height * 0.215, width: chestHalf * 0.98, depth: chestHalf * 0.70 },
    { y: height * 0.272, width: chestHalf * 0.96, depth: chestHalf * 0.67 },
    { y: height * 0.315, width: height * 0.058, depth: height * 0.047 },
  ];
  return [
    { kind: "profile", centerX: 0, centerZ: 0, sections: torsoSections, region: GHOST_BODY_REGIONS.core, chainStart: 0.22, chainEnd: 0.88, blendRadius: 0.04 },
    { kind: "segment", start: leftClavicle, end: leftShoulder, startWidth: height * 0.055, startDepth: height * 0.046, endWidth: armUpper * 0.94, endDepth: armUpper * 0.84, region: GHOST_BODY_REGIONS.leftArm, chainStart: 0, chainEnd: 0.08, blendRadius: 0.036 },
    { kind: "segment", start: rightClavicle, end: rightShoulder, startWidth: height * 0.055, startDepth: height * 0.046, endWidth: armUpper * 0.94, endDepth: armUpper * 0.84, region: GHOST_BODY_REGIONS.rightArm, chainStart: 0, chainEnd: 0.08, blendRadius: 0.036 },
    { kind: "ellipsoid", center: [0, SPECTRAL_HUMAN_PROPORTIONS.neckY * height, 0], radii: [height * 0.038, height * 0.052, height * 0.034], region: GHOST_BODY_REGIONS.head, chainT: 0.1, blendRadius: 0.032 },
    { kind: "ellipsoid", center: [0, (SPECTRAL_HUMAN_PROPORTIONS.headY + 0.018) * height, -0.01 * scale], radii: [headX, headY * 0.82, headZ], region: GHOST_BODY_REGIONS.head, chainT: 0.72, blendRadius: 0.026 },
    { kind: "ellipsoid", center: [0, (SPECTRAL_HUMAN_PROPORTIONS.headY - 0.035) * height, 0.018 * scale], radii: [headX * 0.80, headY * 0.62, headZ * 0.84], region: GHOST_BODY_REGIONS.head, chainT: 0.56, blendRadius: 0.024 },
    { kind: "segment", start: leftShoulder, end: leftElbow, startWidth: armUpper * 0.94, startDepth: armUpper * 0.84, endWidth: forearm * 1.03, endDepth: forearm * 0.88, widthBulge: armUpper * 0.08, depthBulge: armUpper * 0.06, region: GHOST_BODY_REGIONS.leftArm, chainStart: 0, chainEnd: 0.52, blendRadius: 0.052 },
    { kind: "segment", start: leftElbow, end: leftWrist, startWidth: forearm * 1.03, startDepth: forearm * 0.9, endWidth: forearm * 0.7, endDepth: forearm * 0.64, widthBulge: forearm * 0.10, depthBulge: forearm * 0.08, region: GHOST_BODY_REGIONS.leftArm, chainStart: 0.52, chainEnd: 0.9, blendRadius: 0.032 },
    { kind: "segment", start: leftWrist, end: leftHandEnd, startWidth: forearm * 0.58, startDepth: forearm * 0.50, endWidth: forearm * 0.40, endDepth: forearm * 0.32, widthBulge: forearm * 0.34, depthBulge: forearm * 0.24, region: GHOST_BODY_REGIONS.leftArm, chainStart: 0.9, chainEnd: 1, blendRadius: 0.024 },
    { kind: "segment", start: rightShoulder, end: rightElbow, startWidth: armUpper * 0.94, startDepth: armUpper * 0.84, endWidth: forearm * 1.03, endDepth: forearm * 0.88, widthBulge: armUpper * 0.08, depthBulge: armUpper * 0.06, region: GHOST_BODY_REGIONS.rightArm, chainStart: 0, chainEnd: 0.52, blendRadius: 0.052 },
    { kind: "segment", start: rightElbow, end: rightWrist, startWidth: forearm * 1.03, startDepth: forearm * 0.9, endWidth: forearm * 0.7, endDepth: forearm * 0.64, widthBulge: forearm * 0.10, depthBulge: forearm * 0.08, region: GHOST_BODY_REGIONS.rightArm, chainStart: 0.52, chainEnd: 0.9, blendRadius: 0.032 },
    { kind: "segment", start: rightWrist, end: rightHandEnd, startWidth: forearm * 0.58, startDepth: forearm * 0.50, endWidth: forearm * 0.40, endDepth: forearm * 0.32, widthBulge: forearm * 0.34, depthBulge: forearm * 0.24, region: GHOST_BODY_REGIONS.rightArm, chainStart: 0.9, chainEnd: 1, blendRadius: 0.024 },
    { kind: "segment", start: leftHip, end: leftKnee, startWidth: thigh, startDepth: thigh * 0.88, endWidth: calf * 1.08, endDepth: calf * 0.96, widthBulge: thigh * 0.08, depthBulge: thigh * 0.06, region: GHOST_BODY_REGIONS.leftLeg, chainStart: 0, chainEnd: 0.5, blendRadius: 0.026 },
    { kind: "segment", start: leftKnee, end: leftAnkle, startWidth: calf * 1.06, startDepth: calf, endWidth: calf * 0.55, endDepth: calf * 0.52, widthBulge: calf * 0.13, depthBulge: calf * 0.11, region: GHOST_BODY_REGIONS.leftLeg, chainStart: 0.5, chainEnd: 0.9, blendRadius: 0.03 },
    { kind: "segment", start: leftAnkle, end: [leftAnkle[0], footY, 0.2 * scale], startWidth: calf * 0.62, startDepth: calf * 0.58, endWidth: calf * 0.72, endDepth: calf * 0.82, region: GHOST_BODY_REGIONS.leftLeg, chainStart: 0.9, chainEnd: 1, blendRadius: 0.025 },
    { kind: "segment", start: rightHip, end: rightKnee, startWidth: thigh, startDepth: thigh * 0.88, endWidth: calf * 1.08, endDepth: calf * 0.96, widthBulge: thigh * 0.08, depthBulge: thigh * 0.06, region: GHOST_BODY_REGIONS.rightLeg, chainStart: 0, chainEnd: 0.5, blendRadius: 0.026 },
    { kind: "segment", start: rightKnee, end: rightAnkle, startWidth: calf * 1.06, startDepth: calf, endWidth: calf * 0.55, endDepth: calf * 0.52, widthBulge: calf * 0.13, depthBulge: calf * 0.11, region: GHOST_BODY_REGIONS.rightLeg, chainStart: 0.5, chainEnd: 0.9, blendRadius: 0.03 },
    { kind: "segment", start: rightAnkle, end: [rightAnkle[0], footY, 0.2 * scale], startWidth: calf * 0.62, startDepth: calf * 0.58, endWidth: calf * 0.72, endDepth: calf * 0.82, region: GHOST_BODY_REGIONS.rightLeg, chainStart: 0.9, chainEnd: 1, blendRadius: 0.025 },
  ];
}

function primitiveBounds(primitives: BodyPrimitive[], margin: number): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const primitive of primitives) {
    const centers: readonly Vec3[] = primitive.kind === "ellipsoid"
      ? [primitive.center]
      : primitive.kind === "segment"
      ? [primitive.start, primitive.end]
      : primitive.sections.map((section) => [primitive.centerX, section.y, primitive.centerZ] as const);
    const radius = primitive.kind === "ellipsoid"
      ? Math.max(...primitive.radii)
      : primitive.kind === "segment"
      ? Math.max(
        primitive.startWidth,
        primitive.startDepth,
        primitive.endWidth,
        primitive.endDepth,
      ) + Math.max(primitive.widthBulge ?? 0, primitive.depthBulge ?? 0)
      : Math.max(...primitive.sections.flatMap((section) => [section.width, section.depth]));
    centers.forEach((center) => {
      for (let axis = 0; axis < 3; axis += 1) {
        min[axis] = Math.min(min[axis], center[axis] - radius - margin);
        max[axis] = Math.max(max[axis], center[axis] + radius + margin);
      }
    });
  }
  return { min, max };
}

function createGrid(primitives: BodyPrimitive[], voxelSize: number): GridSpec {
  const bounds = primitiveBounds(primitives, voxelSize * 2.5);
  const dimensions = bounds.max.map((value, axis) => Math.ceil((value - bounds.min[axis]) / voxelSize) + 1);
  const [nx, ny, nz] = dimensions;
  if (nx * ny * nz > MAX_GRID_POINTS) {
    throw new Error(`Spectral body grid exceeds safety budget (${nx}x${ny}x${nz}).`);
  }
  return {
    min: bounds.min,
    max: [
      bounds.min[0] + (nx - 1) * voxelSize,
      bounds.min[1] + (ny - 1) * voxelSize,
      bounds.min[2] + (nz - 1) * voxelSize,
    ],
    nx,
    ny,
    nz,
    voxelSize,
  };
}

function worldHullSampler(orientations: OrientationMask[] | undefined): ((x: number, y: number, z: number) => number) | null {
  if (!orientations || orientations.length < 2) return null;
  const sampler = createVisualHullSdfSampler(orientations);
  if (!sampler) return null;
  const point = new THREE.Vector3();
  return (x, y, z) => {
    point.set(x / HULL_SCALE_X, (y - HULL_FLOOR_OFFSET) / HULL_SCALE_Y, z / HULL_SCALE_Z);
    return sampler(point) * HULL_AVERAGE_SCALE;
  };
}

function regionHullConfidence(region: GhostBodyRegion): number {
  switch (region) {
    case GHOST_BODY_REGIONS.core: return 0.78;
    case GHOST_BODY_REGIONS.leftLeg:
    case GHOST_BODY_REGIONS.rightLeg: return 0.62;
    case GHOST_BODY_REGIONS.leftArm:
    case GHOST_BODY_REGIONS.rightArm: return 0.34;
    case GHOST_BODY_REGIONS.head: return 0.18;
  }
}

function blurredHullField(
  sampler: (x: number, y: number, z: number) => number,
  x: number,
  y: number,
  z: number,
  radius: number,
): number {
  let sum = 0;
  for (let dz = -1; dz <= 1; dz += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        sum += sampler(x + dx * radius, y + dy * radius, z + dz * radius);
      }
    }
  }
  return sum / 27;
}

function sampleFinalField(
  primitives: BodyPrimitive[],
  hullSampler: ReturnType<typeof worldHullSampler>,
  x: number,
  y: number,
  z: number,
  blurRadius: number,
  sample: FieldSample,
): number {
  const anatomy = sampleAnatomy(primitives, x, y, z, sample);
  if (!hullSampler || Math.abs(anatomy) > 0.09) return anatomy;
  const hull = clamp(blurredHullField(hullSampler, x, y, z, blurRadius), -0.04, 0.04);
  return anatomy + hull * regionHullConfidence(sample.region);
}

function gridIndex(grid: GridSpec, x: number, y: number, z: number): number {
  return x + y * grid.nx + z * grid.nx * grid.ny;
}

function fillField(
  grid: GridSpec,
  primitives: BodyPrimitive[],
  hullSampler: ReturnType<typeof worldHullSampler>,
): Float32Array {
  const field = new Float32Array(grid.nx * grid.ny * grid.nz);
  const sample: FieldSample = { value: 0, region: GHOST_BODY_REGIONS.core, chainT: 0 };
  for (let z = 0; z < grid.nz; z += 1) {
    const pz = grid.min[2] + z * grid.voxelSize;
    for (let y = 0; y < grid.ny; y += 1) {
      const py = grid.min[1] + y * grid.voxelSize;
      for (let x = 0; x < grid.nx; x += 1) {
        const px = grid.min[0] + x * grid.voxelSize;
        field[gridIndex(grid, x, y, z)] = sampleFinalField(
          primitives,
          hullSampler,
          px,
          py,
          pz,
          grid.voxelSize,
          sample,
        );
      }
    }
  }
  return field;
}

function decodeGridPoint(grid: GridSpec, pointIndex: number): [number, number, number] {
  const plane = grid.nx * grid.ny;
  const z = Math.floor(pointIndex / plane);
  const remainder = pointIndex - z * plane;
  const y = Math.floor(remainder / grid.nx);
  const x = remainder - y * grid.nx;
  return [
    grid.min[0] + x * grid.voxelSize,
    grid.min[1] + y * grid.voxelSize,
    grid.min[2] + z * grid.voxelSize,
  ];
}

function polygonize(
  grid: GridSpec,
  field: Float32Array,
): { positions: number[]; indices: number[] } {
  const positions: number[] = [];
  const indices: number[] = [];
  const edgeVertices = new Map<number, number>();
  const totalPoints = field.length;

  const edgeVertex = (a: number, b: number): number => {
    const low = Math.min(a, b);
    const high = Math.max(a, b);
    const key = low * totalPoints + high;
    const cached = edgeVertices.get(key);
    if (cached !== undefined) return cached;
    const va = field[a];
    const vb = field[b];
    const t = clamp(va / (va - vb), 0, 1);
    const pa = decodeGridPoint(grid, a);
    const pb = decodeGridPoint(grid, b);
    const vertex = positions.length / 3;
    positions.push(
      pa[0] + (pb[0] - pa[0]) * t,
      pa[1] + (pb[1] - pa[1]) * t,
      pa[2] + (pb[2] - pa[2]) * t,
    );
    edgeVertices.set(key, vertex);
    return vertex;
  };

  for (let z = 0; z < grid.nz - 1; z += 1) {
    for (let y = 0; y < grid.ny - 1; y += 1) {
      for (let x = 0; x < grid.nx - 1; x += 1) {
        const cube = CORNERS.map(([dx, dy, dz]) => gridIndex(grid, x + dx, y + dy, z + dz));
        let cubeIndex = 0;
        for (let corner = 0; corner < cube.length; corner += 1) {
          if (field[cube[corner]] >= 0) cubeIndex |= 1 << corner;
        }
        const activeEdges = edgeTable[cubeIndex];
        if (activeEdges === 0) continue;
        const cubeVertices = new Int32Array(CUBE_EDGES.length);
        cubeVertices.fill(-1);
        for (let edge = 0; edge < CUBE_EDGES.length; edge += 1) {
          if ((activeEdges & (1 << edge)) === 0) continue;
          const [start, end] = CUBE_EDGES[edge];
          cubeVertices[edge] = edgeVertex(cube[start], cube[end]);
        }
        const tableOffset = cubeIndex * 16;
        for (let triangle = 0; triangle < 16 && triTable[tableOffset + triangle] !== -1; triangle += 3) {
          indices.push(
            cubeVertices[triTable[tableOffset + triangle]],
            cubeVertices[triTable[tableOffset + triangle + 1]],
            cubeVertices[triTable[tableOffset + triangle + 2]],
          );
        }
      }
    }
  }
  return { positions, indices };
}

function resampleField(
  sourceGrid: GridSpec,
  sourceField: Float32Array,
  voxelSize: number,
): { grid: GridSpec; field: Float32Array } {
  const nx = Math.floor((sourceGrid.max[0] - sourceGrid.min[0]) / voxelSize) + 1;
  const ny = Math.floor((sourceGrid.max[1] - sourceGrid.min[1]) / voxelSize) + 1;
  const nz = Math.floor((sourceGrid.max[2] - sourceGrid.min[2]) / voxelSize) + 1;
  const grid: GridSpec = {
    min: [...sourceGrid.min],
    max: [
      sourceGrid.min[0] + (nx - 1) * voxelSize,
      sourceGrid.min[1] + (ny - 1) * voxelSize,
      sourceGrid.min[2] + (nz - 1) * voxelSize,
    ],
    nx,
    ny,
    nz,
    voxelSize,
  };
  const field = new Float32Array(nx * ny * nz);
  const sampleAxis = (value: number, minimum: number, count: number) => {
    const coordinate = clamp((value - minimum) / sourceGrid.voxelSize, 0, count - 1);
    const low = Math.min(count - 2, Math.floor(coordinate));
    return { low, t: coordinate - low };
  };
  for (let z = 0; z < nz; z += 1) {
    const worldZ = grid.min[2] + z * voxelSize;
    const sz = sampleAxis(worldZ, sourceGrid.min[2], sourceGrid.nz);
    for (let y = 0; y < ny; y += 1) {
      const worldY = grid.min[1] + y * voxelSize;
      const sy = sampleAxis(worldY, sourceGrid.min[1], sourceGrid.ny);
      for (let x = 0; x < nx; x += 1) {
        const worldX = grid.min[0] + x * voxelSize;
        const sx = sampleAxis(worldX, sourceGrid.min[0], sourceGrid.nx);
        const c000 = sourceField[gridIndex(sourceGrid, sx.low, sy.low, sz.low)];
        const c100 = sourceField[gridIndex(sourceGrid, sx.low + 1, sy.low, sz.low)];
        const c010 = sourceField[gridIndex(sourceGrid, sx.low, sy.low + 1, sz.low)];
        const c110 = sourceField[gridIndex(sourceGrid, sx.low + 1, sy.low + 1, sz.low)];
        const c001 = sourceField[gridIndex(sourceGrid, sx.low, sy.low, sz.low + 1)];
        const c101 = sourceField[gridIndex(sourceGrid, sx.low + 1, sy.low, sz.low + 1)];
        const c011 = sourceField[gridIndex(sourceGrid, sx.low, sy.low + 1, sz.low + 1)];
        const c111 = sourceField[gridIndex(sourceGrid, sx.low + 1, sy.low + 1, sz.low + 1)];
        const x00 = c000 + (c100 - c000) * sx.t;
        const x10 = c010 + (c110 - c010) * sx.t;
        const x01 = c001 + (c101 - c001) * sx.t;
        const x11 = c011 + (c111 - c011) * sx.t;
        const y0 = x00 + (x10 - x00) * sy.t;
        const y1 = x01 + (x11 - x01) * sy.t;
        field[gridIndex(grid, x, y, z)] = y0 + (y1 - y0) * sz.t;
      }
    }
  }
  return { grid, field };
}

function smoothPass(positions: number[], neighbors: number[][], factor: number): void {
  const next = positions.slice();
  for (let vertex = 0; vertex < neighbors.length; vertex += 1) {
    const adjacent = neighbors[vertex];
    if (adjacent.length === 0) continue;
    let x = 0;
    let y = 0;
    let z = 0;
    for (const neighbor of adjacent) {
      x += positions[neighbor * 3];
      y += positions[neighbor * 3 + 1];
      z += positions[neighbor * 3 + 2];
    }
    const inverse = 1 / adjacent.length;
    next[vertex * 3] += (x * inverse - positions[vertex * 3]) * factor;
    next[vertex * 3 + 1] += (y * inverse - positions[vertex * 3 + 1]) * factor;
    next[vertex * 3 + 2] += (z * inverse - positions[vertex * 3 + 2]) * factor;
  }
  for (let index = 0; index < positions.length; index += 1) positions[index] = next[index];
}

function taubinSmooth(positions: number[], indices: number[], iterations = 2): void {
  const sets = Array.from({ length: positions.length / 3 }, () => new Set<number>());
  for (let index = 0; index < indices.length; index += 3) {
    const a = indices[index];
    const b = indices[index + 1];
    const c = indices[index + 2];
    sets[a].add(b).add(c);
    sets[b].add(a).add(c);
    sets[c].add(a).add(b);
  }
  const neighbors = sets.map((set) => [...set]);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    smoothPass(positions, neighbors, 0.5);
    smoothPass(positions, neighbors, -0.53);
  }
}

function fieldGradient(
  primitives: BodyPrimitive[],
  hullSampler: ReturnType<typeof worldHullSampler>,
  x: number,
  y: number,
  z: number,
  epsilon: number,
  blurRadius: number,
  sample: FieldSample,
): [number, number, number] {
  const dx = sampleFinalField(primitives, hullSampler, x + epsilon, y, z, blurRadius, sample)
    - sampleFinalField(primitives, hullSampler, x - epsilon, y, z, blurRadius, sample);
  const dy = sampleFinalField(primitives, hullSampler, x, y + epsilon, z, blurRadius, sample)
    - sampleFinalField(primitives, hullSampler, x, y - epsilon, z, blurRadius, sample);
  const dz = sampleFinalField(primitives, hullSampler, x, y, z + epsilon, blurRadius, sample)
    - sampleFinalField(primitives, hullSampler, x, y, z - epsilon, blurRadius, sample);
  const inverse = 1 / Math.max(Math.hypot(dx, dy, dz), 1e-8);
  // The positive field points inward; negate its gradient for outward normals.
  return [-dx * inverse, -dy * inverse, -dz * inverse];
}

function orientTriangles(positions: number[], indices: number[], normals: Int16Array): void {
  for (let index = 0; index < indices.length; index += 3) {
    const ai = indices[index] * 3;
    const bi = indices[index + 1] * 3;
    const ci = indices[index + 2] * 3;
    const abx = positions[bi] - positions[ai];
    const aby = positions[bi + 1] - positions[ai + 1];
    const abz = positions[bi + 2] - positions[ai + 2];
    const acx = positions[ci] - positions[ai];
    const acy = positions[ci + 1] - positions[ai + 1];
    const acz = positions[ci + 2] - positions[ai + 2];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    const normalX = normals[ai] + normals[bi] + normals[ci];
    const normalY = normals[ai + 1] + normals[bi + 1] + normals[ci + 1];
    const normalZ = normals[ai + 2] + normals[bi + 2] + normals[ci + 2];
    if (nx * normalX + ny * normalY + nz * normalZ < 0) {
      const swap = indices[index + 1];
      indices[index + 1] = indices[index + 2];
      indices[index + 2] = swap;
    }
  }
}

function buildAttributes(
  positions: number[],
  primitives: BodyPrimitive[],
  hullSampler: ReturnType<typeof worldHullSampler>,
  bounds: { min: [number, number, number]; max: [number, number, number] },
  epsilon: number,
  blurRadius: number,
): Pick<GhostLodMesh, "normals" | "skinIndices" | "skinWeights" | "canonicalCoords" | "regionAndChain"> {
  const vertexCount = positions.length / 3;
  const normals = new Int16Array(vertexCount * 3);
  const skinIndices = new Uint8Array(vertexCount * 4);
  const skinWeights = new Uint8Array(vertexCount * 4);
  const canonicalCoords = new Uint16Array(vertexCount * 3);
  const regionAndChain = new Uint8Array(vertexCount * 2);
  const sample: FieldSample = { value: 0, region: GHOST_BODY_REGIONS.core, chainT: 0 };
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const x = positions[vertex * 3];
    const y = positions[vertex * 3 + 1];
    const z = positions[vertex * 3 + 2];
    const normal = fieldGradient(primitives, hullSampler, x, y, z, epsilon, blurRadius, sample);
    normals[vertex * 3] = Math.round(clamp(normal[0], -1, 1) * 32767);
    normals[vertex * 3 + 1] = Math.round(clamp(normal[1], -1, 1) * 32767);
    normals[vertex * 3 + 2] = Math.round(clamp(normal[2], -1, 1) * 32767);
    for (let axis = 0; axis < 3; axis += 1) {
      const range = Math.max(bounds.max[axis] - bounds.min[axis], 1e-6);
      canonicalCoords[vertex * 3 + axis] = Math.round(clamp((positions[vertex * 3 + axis] - bounds.min[axis]) / range, 0, 1) * 65535);
    }
    sampleAnatomy(primitives, x, y, z, sample);
    regionAndChain[vertex * 2] = sample.region;
    regionAndChain[vertex * 2 + 1] = Math.round(clamp(sample.chainT, 0, 1) * 255);
    // V2 replaces this rigid pelvis placeholder with normalized four-bone capsule weights.
    skinIndices[vertex * 4] = 0;
    skinWeights[vertex * 4] = 255;
  }
  return { normals, skinIndices, skinWeights, canonicalCoords, regionAndChain };
}

function meshQuality(vertexCount: number, indices: number[], positions: number[]): GhostBodyQuality {
  const parent = new Int32Array(vertexCount);
  for (let index = 0; index < vertexCount; index += 1) parent[index] = index;
  const find = (value: number): number => {
    let root = value;
    while (parent[root] !== root) root = parent[root];
    while (parent[value] !== value) {
      const next = parent[value];
      parent[value] = root;
      value = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };
  const edgeCounts = new Map<number, number>();
  let degenerateTriangles = 0;
  const edgeKey = (a: number, b: number) => Math.min(a, b) * vertexCount + Math.max(a, b);
  for (let index = 0; index < indices.length; index += 3) {
    const a = indices[index];
    const b = indices[index + 1];
    const c = indices[index + 2];
    union(a, b);
    union(b, c);
    for (const [u, v] of [[a, b], [b, c], [c, a]] as const) {
      const key = edgeKey(u, v);
      edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
    }
    const ai = a * 3;
    const bi = b * 3;
    const ci = c * 3;
    const abx = positions[bi] - positions[ai];
    const aby = positions[bi + 1] - positions[ai + 1];
    const abz = positions[bi + 2] - positions[ai + 2];
    const acx = positions[ci] - positions[ai];
    const acy = positions[ci + 1] - positions[ai + 1];
    const acz = positions[ci + 2] - positions[ai + 2];
    const area2 = Math.hypot(
      aby * acz - abz * acy,
      abz * acx - abx * acz,
      abx * acy - aby * acx,
    );
    if (area2 < 1e-10) degenerateTriangles += 1;
  }
  const usedRoots = new Set<number>();
  indices.forEach((vertex) => usedRoots.add(find(vertex)));
  let boundaryEdges = 0;
  edgeCounts.forEach((count) => {
    if (count !== 2) boundaryEdges += 1;
  });
  return {
    connectedComponents: usedRoots.size,
    boundaryEdges,
    degenerateTriangles,
  };
}

function createRig(measurements: BodyMeasurements): GhostRig {
  const height = measurements.height;
  const shoulderX = measurements.shoulderWidth * SPECTRAL_HUMAN_LATERAL_PROPORTIONS.shoulderX;
  const elbowX = measurements.shoulderWidth * SPECTRAL_HUMAN_LATERAL_PROPORTIONS.elbowX;
  const wristX = measurements.shoulderWidth * SPECTRAL_HUMAN_LATERAL_PROPORTIONS.wristX;
  const hipJointX = measurements.hipWidth * SPECTRAL_HUMAN_LATERAL_PROPORTIONS.hipX;
  const kneeX = measurements.hipWidth * SPECTRAL_HUMAN_LATERAL_PROPORTIONS.kneeX;
  const ankleX = measurements.hipWidth * SPECTRAL_HUMAN_LATERAL_PROPORTIONS.ankleX;
  const world: Vec3[] = [
    [0, SPECTRAL_HUMAN_PROPORTIONS.pelvisCenterY * height, 0],
    [0, SPECTRAL_HUMAN_PROPORTIONS.waistY * height, 0],
    [0, SPECTRAL_HUMAN_PROPORTIONS.chestY * height, 0],
    [0, SPECTRAL_HUMAN_PROPORTIONS.neckY * height, 0],
    [0, SPECTRAL_HUMAN_PROPORTIONS.headY * height, 0],
    [-shoulderX, SPECTRAL_HUMAN_PROPORTIONS.shoulderY * height, 0],
    [-elbowX, SPECTRAL_HUMAN_PROPORTIONS.elbowY * height, 0],
    [-wristX, SPECTRAL_HUMAN_PROPORTIONS.wristY * height, 0],
    [shoulderX, SPECTRAL_HUMAN_PROPORTIONS.shoulderY * height, 0],
    [elbowX, SPECTRAL_HUMAN_PROPORTIONS.elbowY * height, 0],
    [wristX, SPECTRAL_HUMAN_PROPORTIONS.wristY * height, 0],
    [-hipJointX, SPECTRAL_HUMAN_PROPORTIONS.hipJointY * height, 0],
    [-kneeX, SPECTRAL_HUMAN_PROPORTIONS.kneeY * height, 0.018],
    [-ankleX, SPECTRAL_HUMAN_PROPORTIONS.ankleY * height, 0.012],
    [hipJointX, SPECTRAL_HUMAN_PROPORTIONS.hipJointY * height, 0],
    [kneeX, SPECTRAL_HUMAN_PROPORTIONS.kneeY * height, 0.018],
    [ankleX, SPECTRAL_HUMAN_PROPORTIONS.ankleY * height, 0.012],
  ];
  const parents = new Int8Array([-1, 0, 1, 2, 3, 2, 5, 6, 2, 8, 9, 0, 11, 12, 0, 14, 15]);
  const translations = new Float32Array(world.length * 3);
  const rotations = new Float32Array(world.length * 4);
  const inverseBindMatrices = new Float32Array(world.length * 16);
  world.forEach((position, index) => {
    const parent = parents[index];
    const base = parent >= 0 ? world[parent] : [0, 0, 0];
    translations.set([position[0] - base[0], position[1] - base[1], position[2] - base[2]], index * 3);
    rotations[index * 4 + 3] = 1;
    const inverse = new THREE.Matrix4().makeTranslation(-position[0], -position[1], -position[2]);
    inverseBindMatrices.set(inverse.elements, index * 16);
    measurements.boneLengths[index] = parent < 0 ? 0 : Math.hypot(
      position[0] - base[0], position[1] - base[1], position[2] - base[2],
    );
  });
  return {
    version: GHOST_RIG_VERSION,
    parentIndices: parents,
    restTranslations: translations,
    restRotations: rotations,
    inverseBindMatrices,
  };
}

export function buildAnatomicalGhostBody(request: AnatomicalBodyBuildRequest): GhostBodyModel {
  const measurements = measurementsFromLandmarks(request.landmarks);
  const primitives = createPrimitives(measurements);
  const hull = worldHullSampler(request.orientations);
  const rig = createRig(measurements);
  const voxelSizes = request.voxelSize === undefined
    ? SPECTRAL_BODY_LOD_VOXEL_SIZES
    : [request.voxelSize];
  let primaryGrid: GridSpec | undefined;
  let quality: GhostBodyQuality | undefined;
  const lods = voxelSizes.map((voxelSize, lodIndex): GhostLodMesh => {
    const grid = createGrid(primitives, voxelSize);
    const field = fillField(grid, primitives, hull);
    const triangleBudget = request.voxelSize === undefined
      ? SPECTRAL_BODY_LOD_TRIANGLE_BUDGETS[lodIndex]
      : MAX_TRIANGLES;
    const remesh = request.voxelSize === undefined
      ? resampleField(grid, field, voxelSize * SPECTRAL_BODY_REMESH_SCALE)
      : { grid, field };
    const mesh = polygonize(remesh.grid, remesh.field);
    if (mesh.indices.length < 3) throw new Error(`Spectral body LOD${lodIndex} field produced no surface.`);
    taubinSmooth(mesh.positions, mesh.indices, 4);
    const triangleCount = mesh.indices.length / 3;
    if (triangleCount > triangleBudget) {
      throw new Error(`Spectral body LOD${lodIndex} exceeded triangle budget (${triangleCount}/${triangleBudget}).`);
    }
    const attributes = buildAttributes(mesh.positions, primitives, hull, grid, voxelSize * 0.45, voxelSize);
    orientTriangles(mesh.positions, mesh.indices, attributes.normals);
    const lod: GhostLodMesh = {
      voxelSize,
      vertexCount: mesh.positions.length / 3,
      triangleCount,
      positions: new Float32Array(mesh.positions),
      normals: attributes.normals,
      indices: new Uint32Array(mesh.indices),
      skinIndices: attributes.skinIndices,
      skinWeights: attributes.skinWeights,
      canonicalCoords: attributes.canonicalCoords,
      regionAndChain: attributes.regionAndChain,
    };
    assignProgrammaticSkinWeights(lod, rig);
    if (lodIndex === 0) {
      primaryGrid = grid;
      quality = meshQuality(lod.vertexCount, mesh.indices, mesh.positions);
    }
    return lod;
  });
  if (!primaryGrid || !quality) throw new Error("Spectral body did not produce a primary LOD.");
  return {
    version: GHOST_BODY_MODEL_VERSION,
    algorithmVersion: SPECTRAL_BODY_ALGORITHM_VERSION,
    sourceHash: request.sourceHash,
    rig,
    lods,
    measurements,
    partial: request.partial ? "upper" : "full",
    canonicalBounds: { min: primaryGrid.min, max: primaryGrid.max },
    quality,
  };
}

export function geometryFromGhostLod(lod: GhostLodMesh): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(lod.positions, 3));
  const normals = new Float32Array(lod.vertexCount * 3);
  for (let index = 0; index < normals.length; index += 1) normals[index] = lod.normals[index] / 32767;
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute("bridgeCanonical", new THREE.BufferAttribute(lod.canonicalCoords, 3, true));
  geometry.setAttribute("bridgeRegionChain", new THREE.BufferAttribute(lod.regionAndChain, 2, true));
  geometry.setAttribute("skinIndex", new THREE.BufferAttribute(lod.skinIndices, 4));
  geometry.setAttribute("skinWeight", new THREE.BufferAttribute(lod.skinWeights, 4, true));
  geometry.setIndex(new THREE.BufferAttribute(lod.indices, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}
