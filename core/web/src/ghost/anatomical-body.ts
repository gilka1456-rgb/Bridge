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
import {
  assignProgrammaticSkinWeights,
  restJointPositions,
  SPECTRAL_ARM_SWEEP_RESPONSE,
} from "./body-skinning";
import {
  measureQuantizedNormalCoherence,
  smoothQuantizedSurfaceNormals,
  SPECTRAL_NORMAL_COHERENCE_MIN_PERCENT,
} from "./surface-normals";
import { measureGhostBodySilhouetteEvidence } from "./silhouette-quality";

export const SPECTRAL_BODY_ALGORITHM_VERSION = "anatomical-sdf-v35-anatomical-neck-shoulder";
export const SPECTRAL_BODY_VOXEL_SIZE = 0.0145;
export const SPECTRAL_BODY_LOD_VOXEL_SIZES = [0.0145, 0.022, 0.037] as const;
export const SPECTRAL_BODY_LOD_TRIANGLE_BUDGETS = [45_000, 20_000, 5_000] as const;
export const SPECTRAL_BODY_LOD_REMESH_SCALES = [1.12, 1.16, 1.40] as const;
export const SPECTRAL_MEDIUM_HAND_REPROJECTION = Object.freeze({
  chainStart: 0.94,
  iterations: 4,
  maximumStepInVoxels: 0.45,
});

/** Height-normalized adult proportions for the canonical, style-independent body. */
export const SPECTRAL_HUMAN_PROPORTIONS = Object.freeze({
  chestY: 0.22,
  waistY: 0.10,
  pelvisCenterY: 0.05,
  neckY: 0.33,
  chinY: 0.352,
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
  shoulderX: 0.42,
  elbowX: 0.70,
  wristX: 0.875,
  hipX: 0.32,
  kneeX: 0.31,
  ankleX: 0.25,
} as const);

/** Radius and width ratios for the shared anatomical volume, independent of style. */
export const SPECTRAL_HUMAN_VOLUME_PROPORTIONS = Object.freeze({
  minimumWaistToShoulder: 0.72,
  headVerticalRadiusToHeight: 0.064,
  upperArmRadiusToShoulder: 0.115,
  minimumUpperArmRadiusToHeight: 0.026,
  maximumUpperArmRadiusToHeight: 0.038,
  minimumShoulderAttachmentRadiusToHeight: 0.030,
  minimumWristWidthRadiusToHeight: 0.020,
  minimumWristDepthRadiusToHeight: 0.0175,
  minimumThighRadiusToHeight: 0.045,
  maximumThighRadiusToHeight: 0.062,
  noseBridgeYToHeight: 0.411,
  noseBridgeZToHeight: 0.043,
  noseTipYToHeight: 0.393,
  noseTipZToHeight: 0.058,
  noseBridgeWidthRadiusToHeight: 0.010,
  noseBridgeDepthRadiusToHeight: 0.008,
  noseTipWidthRadiusToHeight: 0.0075,
  noseTipDepthRadiusToHeight: 0.0065,
  earCenterYToHeight: 0.405,
  earLateralRadiusToHeight: 0.0055,
  earVerticalRadiusToHeight: 0.014,
  earDepthRadiusToHeight: 0.0045,
  handLengthToHeight: 0.100,
  palmWidthRadiusToHeight: 0.024,
  palmDepthRadiusToHeight: 0.012,
  fingertipWidthRadiusToHeight: 0.0085,
  fingertipDepthRadiusToHeight: 0.0074,
  fingerSpacingToHeight: 0.0115,
  fingerBedStartToHand: 0.46,
  fingerBedEndToHand: 0.76,
  fingerBedStartWidthToPalm: 0.92,
  fingerBedEndWidthToPalm: 0.70,
  fingerBedStartDepthToPalm: 0.86,
  fingerBedEndDepthToPalm: 0.62,
  thumbLengthToHand: 0.44,
  thumbLateralReachToLength: 0.72,
  thumbWidthRadiusToHeight: 0.0108,
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
  sagittalCenterBulge?: number;
  region: GhostBodyRegion;
  chainStart: number;
  chainEnd: number;
  blendRadius?: number;
  preserveAtMediumLod?: boolean;
  omitAtMediumLod?: boolean;
  capLengthScale?: number;
  fieldExponent?: number;
}

interface ProfileSection {
  y: number;
  width: number;
  depth: number;
  centerZ?: number;
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
  widthTangents: readonly number[];
  depthTangents: readonly number[];
  centerZTangents: readonly number[];
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
  const midProfile = 4 * t * (1 - t);
  const width = primitive.startWidth + (primitive.endWidth - primitive.startWidth) * t
    + (primitive.widthBulge ?? 0) * midProfile;
  const depth = primitive.startDepth + (primitive.endDepth - primitive.startDepth) * t
    + (primitive.depthBulge ?? 0) * midProfile;
  // Human limbs are not centered capsules in side view. A small signed shift
  // along the sagittal basis preserves the same thickness while giving upper
  // limbs an anterior muscle belly and calves a posterior one.
  const sagittalCenter = (primitive.sagittalCenterBulge ?? 0) * midProfile;
  const px = x - (cx + vx * sagittalCenter);
  const py = y - (cy + vy * sagittalCenter);
  const pz = z - (cz + vz * sagittalCenter);
  const lateral = px * ux + py * uy + pz * uz;
  const sagittal = px * vx + py * vy + pz * vz;
  const axial = px * tx + py * ty + pz * tz;
  const exponent = primitive.fieldExponent ?? 2;
  const axialRadius = width * (primitive.capLengthScale ?? 1);
  const normalized = (
    Math.abs(lateral / width) ** exponent
    + Math.abs(sagittal / depth) ** exponent
    + Math.abs(axial / axialRadius) ** exponent
  ) ** (1 / exponent);
  return (1 - normalized) * Math.min(width, depth);
}

function monotoneProfileTangents(
  sections: readonly ProfileSection[],
  property: "width" | "depth" | "centerZ",
  fallback = 0,
): number[] {
  const value = (section: ProfileSection) => property === "centerZ"
    ? section.centerZ ?? fallback
    : section[property];
  return sections.map((section, index) => {
    if (index === 0) {
      return (value(sections[1]) - value(section))
        / Math.max(sections[1].y - section.y, 1e-6);
    }
    if (index === sections.length - 1) {
      const previous = sections[index - 1];
      return (value(section) - value(previous))
        / Math.max(section.y - previous.y, 1e-6);
    }
    const previous = sections[index - 1];
    const next = sections[index + 1];
    const left = (value(section) - value(previous))
      / Math.max(section.y - previous.y, 1e-6);
    const right = (value(next) - value(section))
      / Math.max(next.y - section.y, 1e-6);
    if (left * right <= 0) return 0;
    return 2 * left * right / (left + right);
  });
}

function profileSample(
  primitive: ProfilePrimitive,
  y: number,
): { y: number; width: number; depth: number; centerZ: number; t: number } {
  const sections = primitive.sections;
  const first = sections[0];
  const last = sections[sections.length - 1];
  const sampledY = clamp(y, first.y, last.y);
  let upperIndex = 1;
  while (upperIndex < sections.length - 1 && sampledY > sections[upperIndex].y) upperIndex += 1;
  const lower = sections[upperIndex - 1];
  const upper = sections[upperIndex];
  const linearT = clamp((sampledY - lower.y) / Math.max(upper.y - lower.y, 1e-6), 0, 1);
  const hermite = (property: "width" | "depth" | "centerZ"): number => {
    const spanY = Math.max(upper.y - lower.y, 1e-6);
    const t2 = linearT * linearT;
    const t3 = t2 * linearT;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + linearT;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    const tangents = property === "width"
      ? primitive.widthTangents
      : property === "depth"
      ? primitive.depthTangents
      : primitive.centerZTangents;
    const lowerValue = property === "centerZ" ? lower.centerZ ?? primitive.centerZ : lower[property];
    const upperValue = property === "centerZ" ? upper.centerZ ?? primitive.centerZ : upper[property];
    return h00 * lowerValue
      + h10 * spanY * tangents[upperIndex - 1]
      + h01 * upperValue
      + h11 * spanY * tangents[upperIndex];
  };
  const span = Math.max(last.y - first.y, 1e-6);
  return {
    y: sampledY,
    width: hermite("width"),
    depth: hermite("depth"),
    centerZ: hermite("centerZ"),
    t: (sampledY - first.y) / span,
  };
}

function profileField(primitive: ProfilePrimitive, x: number, y: number, z: number): number {
  const sample = profileSample(primitive, y);
  const lateral = (x - primitive.centerX) / sample.width;
  const sagittal = (z - sample.centerZ) / sample.depth;
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
    waistWidth: Math.max(
      (params.shoulderWidth + params.hipWidth) * 0.39,
      params.shoulderWidth * SPECTRAL_HUMAN_VOLUME_PROPORTIONS.minimumWaistToShoulder,
    ),
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
  const headX = measurements.headDiameter * 0.52;
  const headY = Math.max(
    measurements.headDiameter * 0.508,
    height * SPECTRAL_HUMAN_VOLUME_PROPORTIONS.headVerticalRadiusToHeight,
  );
  const headZ = measurements.headDiameter * 0.50;
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
  const leftClavicle: Vec3 = [-height * 0.040, height * 0.312, -height * 0.006];
  const rightClavicle: Vec3 = [height * 0.040, height * 0.312, -height * 0.006];
  const leftElbow: Vec3 = [-measurements.shoulderWidth * SPECTRAL_HUMAN_LATERAL_PROPORTIONS.elbowX, elbowY, 0.004];
  const rightElbow: Vec3 = [measurements.shoulderWidth * SPECTRAL_HUMAN_LATERAL_PROPORTIONS.elbowX, elbowY, 0.004];
  const leftWrist: Vec3 = [-measurements.shoulderWidth * SPECTRAL_HUMAN_LATERAL_PROPORTIONS.wristX, wristY, 0.012];
  const rightWrist: Vec3 = [measurements.shoulderWidth * SPECTRAL_HUMAN_LATERAL_PROPORTIONS.wristX, wristY, 0.012];
  const armUpper = clamp(
    measurements.shoulderWidth * SPECTRAL_HUMAN_VOLUME_PROPORTIONS.upperArmRadiusToShoulder,
    height * SPECTRAL_HUMAN_VOLUME_PROPORTIONS.minimumUpperArmRadiusToHeight,
    height * SPECTRAL_HUMAN_VOLUME_PROPORTIONS.maximumUpperArmRadiusToHeight,
  );
  const forearm = armUpper * 0.80;
  const shoulderAttachment = Math.max(
    armUpper * 0.80,
    height * SPECTRAL_HUMAN_VOLUME_PROPORTIONS.minimumShoulderAttachmentRadiusToHeight,
  );
  const wristWidth = Math.max(
    forearm * 0.68,
    height * SPECTRAL_HUMAN_VOLUME_PROPORTIONS.minimumWristWidthRadiusToHeight,
  );
  const wristDepth = Math.max(
    forearm * 0.62,
    height * SPECTRAL_HUMAN_VOLUME_PROPORTIONS.minimumWristDepthRadiusToHeight,
  );
  const thigh = clamp(
    measurements.hipWidth * 0.275,
    height * SPECTRAL_HUMAN_VOLUME_PROPORTIONS.minimumThighRadiusToHeight,
    height * SPECTRAL_HUMAN_VOLUME_PROPORTIONS.maximumThighRadiusToHeight,
  );
  const calf = thigh * 0.76;
  const leftHip: Vec3 = [-measurements.hipWidth * SPECTRAL_HUMAN_LATERAL_PROPORTIONS.hipX, hipJointY, 0];
  const rightHip: Vec3 = [measurements.hipWidth * SPECTRAL_HUMAN_LATERAL_PROPORTIONS.hipX, hipJointY, 0];
  // Keep the mid-thighs as two distinct volumes. A narrow inward knee axis plus
  // a global smooth-union radius otherwise creates a skirt-like bridge.
  const leftKnee: Vec3 = [-measurements.hipWidth * SPECTRAL_HUMAN_LATERAL_PROPORTIONS.kneeX, kneeY, 0.018];
  const rightKnee: Vec3 = [measurements.hipWidth * SPECTRAL_HUMAN_LATERAL_PROPORTIONS.kneeX, kneeY, 0.018];
  const leftAnkle: Vec3 = [-measurements.hipWidth * SPECTRAL_HUMAN_LATERAL_PROPORTIONS.ankleX, ankleY, 0.012];
  const rightAnkle: Vec3 = [measurements.hipWidth * SPECTRAL_HUMAN_LATERAL_PROPORTIONS.ankleX, ankleY, 0.012];
  const handLength = height * SPECTRAL_HUMAN_VOLUME_PROPORTIONS.handLengthToHeight;
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
  const palmWidth = height * SPECTRAL_HUMAN_VOLUME_PROPORTIONS.palmWidthRadiusToHeight;
  const palmDepth = height * SPECTRAL_HUMAN_VOLUME_PROPORTIONS.palmDepthRadiusToHeight;
  const fingertipWidth = height * SPECTRAL_HUMAN_VOLUME_PROPORTIONS.fingertipWidthRadiusToHeight;
  const fingertipDepth = height * SPECTRAL_HUMAN_VOLUME_PROPORTIONS.fingertipDepthRadiusToHeight;
  const handStartWidth = wristWidth;
  const handStartDepth = wristDepth;
  const palmEndWidth = palmWidth * 0.78;
  const palmEndDepth = palmDepth * 0.72;
  const handWidthBulge = Math.max(0, palmWidth - (handStartWidth + palmEndWidth) * 0.5);
  const handDepthBulge = Math.max(0, palmDepth - (handStartDepth + palmEndDepth) * 0.5);
  const thumbPrimitive = (wrist: Vec3, handEnd: Vec3, side: -1 | 1): SegmentPrimitive => {
    const dx = handEnd[0] - wrist[0];
    const dy = handEnd[1] - wrist[1];
    const dz = handEnd[2] - wrist[2];
    const inverseLength = 1 / Math.max(Math.hypot(dx, dy, dz), 1e-6);
    const direction: Vec3 = [dx * inverseLength, dy * inverseLength, dz * inverseLength];
    let palmSideX = -direction[1];
    let palmSideY = direction[0];
    // In the capture pose the open palm faces the camera, so the visible
    // thumb opens toward the torso rather than extending the total arm span.
    if (palmSideX * side > 0) {
      palmSideX *= -1;
      palmSideY *= -1;
    }
    const startT = 0.18;
    const thumbLength = handLength * SPECTRAL_HUMAN_VOLUME_PROPORTIONS.thumbLengthToHand;
    const start: Vec3 = [
      wrist[0] + direction[0] * handLength * startT,
      wrist[1] + direction[1] * handLength * startT,
      wrist[2] + direction[2] * handLength * startT,
    ];
    const end: Vec3 = [
      start[0] + direction[0] * thumbLength * 0.62
        + palmSideX * thumbLength * SPECTRAL_HUMAN_VOLUME_PROPORTIONS.thumbLateralReachToLength,
      start[1] + direction[1] * thumbLength * 0.62
        + palmSideY * thumbLength * SPECTRAL_HUMAN_VOLUME_PROPORTIONS.thumbLateralReachToLength,
      start[2] + direction[2] * thumbLength * 0.58,
    ];
    const thumbRadius = height * SPECTRAL_HUMAN_VOLUME_PROPORTIONS.thumbWidthRadiusToHeight;
    return {
      kind: "segment",
      start,
      end,
      startWidth: thumbRadius * 1.25,
      startDepth: thumbRadius * 0.92,
      endWidth: thumbRadius * 0.78,
      endDepth: thumbRadius * 0.64,
      region: side < 0 ? GHOST_BODY_REGIONS.leftArm : GHOST_BODY_REGIONS.rightArm,
      chainStart: 0.925,
      chainEnd: 0.985,
      blendRadius: 0.028,
      omitAtMediumLod: true,
    };
  };
  const handPrimitives = (wrist: Vec3, handEnd: Vec3, side: -1 | 1): BodyPrimitive[] => {
    const dx = handEnd[0] - wrist[0];
    const dy = handEnd[1] - wrist[1];
    const dz = handEnd[2] - wrist[2];
    const inverseLength = 1 / Math.max(Math.hypot(dx, dy, dz), 1e-6);
    const direction: Vec3 = [dx * inverseLength, dy * inverseLength, dz * inverseLength];
    const lateral: Vec3 = [-direction[1], direction[0], 0];
    const region = side < 0 ? GHOST_BODY_REGIONS.leftArm : GHOST_BODY_REGIONS.rightArm;
    const point = (along: number, across: number): Vec3 => [
      wrist[0] + direction[0] * handLength * along + lateral[0] * across,
      wrist[1] + direction[1] * handLength * along + lateral[1] * across,
      wrist[2] + direction[2] * handLength * along,
    ];
    const palmEnd = point(0.60, 0);
    const palm: SegmentPrimitive = {
      kind: "segment",
      start: wrist,
      end: palmEnd,
      startWidth: handStartWidth,
      startDepth: handStartDepth,
      endWidth: palmEndWidth,
      endDepth: palmEndDepth,
      widthBulge: handWidthBulge,
      depthBulge: handDepthBulge,
      region,
      chainStart: 0.9,
      chainEnd: 0.965,
      blendRadius: 0.022,
    };
    const fingerBed: SegmentPrimitive = {
      kind: "segment",
      start: point(SPECTRAL_HUMAN_VOLUME_PROPORTIONS.fingerBedStartToHand, 0),
      end: point(SPECTRAL_HUMAN_VOLUME_PROPORTIONS.fingerBedEndToHand, 0),
      startWidth: palmWidth * SPECTRAL_HUMAN_VOLUME_PROPORTIONS.fingerBedStartWidthToPalm,
      startDepth: palmDepth * SPECTRAL_HUMAN_VOLUME_PROPORTIONS.fingerBedStartDepthToPalm,
      endWidth: palmWidth * SPECTRAL_HUMAN_VOLUME_PROPORTIONS.fingerBedEndWidthToPalm,
      endDepth: palmDepth * SPECTRAL_HUMAN_VOLUME_PROPORTIONS.fingerBedEndDepthToPalm,
      widthBulge: palmWidth * 0.04,
      depthBulge: palmDepth * 0.03,
      region,
      chainStart: 0.952,
      chainEnd: 0.985,
      blendRadius: height * 0.004,
    };
    // The capture does not contain enough resolution for four stable finger
    // tubes. A single rounded crown preserves the blurred open-hand mass and
    // lets the thumb carry direction without turning a raised hand into a
    // star, trident or a cluster of marching-cubes spikes.
    const fingerCrown: SegmentPrimitive = {
      kind: "segment",
      start: point(0.64, 0),
      end: point(1, 0),
      startWidth: Math.max(palmWidth * 0.74, fingertipWidth * 2.0),
      startDepth: Math.max(palmDepth * 0.68, fingertipDepth * 1.02),
      endWidth: Math.max(palmWidth * 0.54, fingertipWidth * 1.5),
      endDepth: Math.max(palmDepth * 0.48, fingertipDepth * 0.78),
      widthBulge: palmWidth * 0.035,
      depthBulge: palmDepth * 0.025,
      region,
      chainStart: 0.95,
      chainEnd: 1,
      blendRadius: height * 0.0065,
      preserveAtMediumLod: true,
    };
    return [palm, fingerBed, fingerCrown, thumbPrimitive(wrist, handEnd, side)];
  };
  const footPrimitives = (ankle: Vec3, region: GhostBodyRegion): BodyPrimitive[] => {
    const heel: Vec3 = [
      ankle[0],
      footY + height * 0.025,
      -height * 0.012,
    ];
    const soleStart: Vec3 = [
      ankle[0],
      footY + height * 0.018,
      -height * 0.020,
    ];
    const toe: Vec3 = [
      ankle[0],
      footY + height * 0.014,
      height * 0.108,
    ];
    return [
      {
        kind: "ellipsoid",
        center: heel,
        radii: [height * 0.033, height * 0.028, height * 0.030],
        region,
        chainT: 0.93,
        blendRadius: 0.026,
      },
      {
        kind: "segment",
        start: soleStart,
        end: toe,
        // A near-sagittal segment uses width as vertical thickness and depth
        // as lateral breadth. Keeping those axes distinct avoids capsule feet.
        startWidth: height * 0.024,
        startDepth: height * 0.034,
        endWidth: height * 0.015,
        endDepth: height * 0.028,
        widthBulge: height * 0.003,
        depthBulge: height * 0.006,
        region,
        chainStart: 0.93,
        chainEnd: 1,
        blendRadius: 0.022,
      },
    ];
  };
  const headSections: readonly ProfileSection[] = [
    // The head profile begins at the actual neck instead of using a
    // shoulder-width lower cap. This preserves a readable neck and jaw while
    // the torso profile and clavicle segments independently form the sloping
    // trapezius/shoulder transition.
    { y: height * 0.312, width: height * 0.041, depth: height * 0.035, centerZ: height * -0.006 },
    { y: height * 0.336, width: height * 0.037, depth: height * 0.0335, centerZ: height * -0.004 },
    { y: height * SPECTRAL_HUMAN_PROPORTIONS.chinY, width: headX * 0.66, depth: headZ * 0.62, centerZ: height * 0.002 },
    { y: height * 0.373, width: headX * 0.88, depth: headZ * 0.82, centerZ: height * 0.004 },
    { y: height * 0.405, width: headX, depth: headZ * 0.98, centerZ: 0 },
    { y: height * 0.435, width: headX * 1.02, depth: headZ, centerZ: height * -0.004 },
    { y: height * 0.447, width: headX * 0.94, depth: headZ * 0.92, centerZ: height * -0.006 },
  ];
  const torsoSections: readonly ProfileSection[] = [
    { y: height * 0.005, width: hipHalf * 0.78, depth: hipHalf * 0.62, centerZ: height * -0.010 },
    { y: pelvisY, width: hipHalf * 1.04, depth: hipHalf * 0.84, centerZ: height * -0.012 },
    { y: height * 0.105, width: waistHalf, depth: waistHalf * 0.76, centerZ: height * -0.004 },
    { y: height * 0.155, width: waistHalf * 0.98, depth: waistHalf * 0.73, centerZ: 0 },
    { y: height * 0.215, width: chestHalf * 0.98, depth: chestHalf * 0.70, centerZ: height * 0.006 },
    { y: height * 0.258, width: chestHalf * 0.95, depth: chestHalf * 0.68, centerZ: height * 0.004 },
    { y: height * 0.286, width: Math.max(chestHalf * 0.88, shoulderHalf * 0.80), depth: chestHalf * 0.63, centerZ: 0 },
    { y: height * 0.300, width: shoulderHalf * 0.72, depth: chestHalf * 0.56, centerZ: height * -0.002 },
    { y: height * 0.312, width: Math.max(height * 0.052, shoulderHalf * 0.56), depth: Math.max(height * 0.046, chestHalf * 0.49), centerZ: height * -0.003 },
    { y: height * 0.318, width: Math.max(height * 0.040, shoulderHalf * 0.38), depth: Math.max(height * 0.035, chestHalf * 0.34), centerZ: height * -0.004 },
  ];
  return [
    {
      kind: "profile",
      centerX: 0,
      centerZ: 0,
      sections: torsoSections,
      widthTangents: monotoneProfileTangents(torsoSections, "width"),
      depthTangents: monotoneProfileTangents(torsoSections, "depth"),
      centerZTangents: monotoneProfileTangents(torsoSections, "centerZ", 0),
      region: GHOST_BODY_REGIONS.core,
      chainStart: 0.22,
      chainEnd: 0.88,
      blendRadius: 0.04,
    },
    { kind: "segment", start: leftClavicle, end: leftShoulder, startWidth: height * 0.018, startDepth: height * 0.024, endWidth: shoulderAttachment, endDepth: shoulderAttachment, region: GHOST_BODY_REGIONS.leftArm, chainStart: 0, chainEnd: 0.08, blendRadius: height * 0.006 },
    { kind: "segment", start: rightClavicle, end: rightShoulder, startWidth: height * 0.018, startDepth: height * 0.024, endWidth: shoulderAttachment, endDepth: shoulderAttachment, region: GHOST_BODY_REGIONS.rightArm, chainStart: 0, chainEnd: 0.08, blendRadius: height * 0.006 },
    {
      kind: "profile",
      centerX: 0,
      centerZ: -0.006 * scale,
      sections: headSections,
      widthTangents: monotoneProfileTangents(headSections, "width"),
      depthTangents: monotoneProfileTangents(headSections, "depth"),
      centerZTangents: monotoneProfileTangents(headSections, "centerZ", -0.006 * scale),
      region: GHOST_BODY_REGIONS.head,
      chainStart: 0.05,
      chainEnd: 1,
      blendRadius: 0.014,
    },
    {
      kind: "ellipsoid",
      center: [0, height * 0.410, 0.030 * scale],
      radii: [headX * 0.70, headY * 0.50, headZ * 0.60],
      region: GHOST_BODY_REGIONS.head,
      chainT: 0.62,
      blendRadius: 0.016,
    },
    // A low-frequency nose bridge and ear pair give the blurred head a clear
    // front/back reading without storing identity-bearing facial texture.
    // Their radii remain broad enough to survive the production field while
    // staying below the detail level of recognisable facial features.
    {
      kind: "segment",
      start: [
        0,
        height * SPECTRAL_HUMAN_VOLUME_PROPORTIONS.noseBridgeYToHeight,
        height * SPECTRAL_HUMAN_VOLUME_PROPORTIONS.noseBridgeZToHeight,
      ],
      end: [
        0,
        height * SPECTRAL_HUMAN_VOLUME_PROPORTIONS.noseTipYToHeight,
        height * SPECTRAL_HUMAN_VOLUME_PROPORTIONS.noseTipZToHeight,
      ],
      startWidth: height * SPECTRAL_HUMAN_VOLUME_PROPORTIONS.noseBridgeWidthRadiusToHeight,
      startDepth: height * SPECTRAL_HUMAN_VOLUME_PROPORTIONS.noseBridgeDepthRadiusToHeight,
      endWidth: height * SPECTRAL_HUMAN_VOLUME_PROPORTIONS.noseTipWidthRadiusToHeight,
      endDepth: height * SPECTRAL_HUMAN_VOLUME_PROPORTIONS.noseTipDepthRadiusToHeight,
      region: GHOST_BODY_REGIONS.head,
      chainStart: 0.54,
      chainEnd: 0.60,
      blendRadius: height * 0.006,
    },
    ...([-1, 1] as const).map((side): EllipsoidPrimitive => ({
      kind: "ellipsoid",
      center: [
        side * headX * 0.98,
        height * SPECTRAL_HUMAN_VOLUME_PROPORTIONS.earCenterYToHeight,
        -height * 0.003,
      ],
      radii: [
        height * SPECTRAL_HUMAN_VOLUME_PROPORTIONS.earLateralRadiusToHeight,
        height * SPECTRAL_HUMAN_VOLUME_PROPORTIONS.earVerticalRadiusToHeight,
        height * SPECTRAL_HUMAN_VOLUME_PROPORTIONS.earDepthRadiusToHeight,
      ],
      region: GHOST_BODY_REGIONS.head,
      chainT: 0.60,
      blendRadius: height * 0.005,
    })),
    { kind: "segment", start: leftShoulder, end: leftElbow, startWidth: armUpper * 0.96, startDepth: armUpper * 0.86, endWidth: forearm * 1.02, endDepth: forearm * 0.90, widthBulge: armUpper * 0.10, depthBulge: armUpper * 0.07, sagittalCenterBulge: -armUpper * 0.06, region: GHOST_BODY_REGIONS.leftArm, chainStart: 0, chainEnd: 0.52, blendRadius: 0.052 },
    { kind: "segment", start: leftElbow, end: leftWrist, startWidth: forearm * 1.02, startDepth: forearm * 0.92, endWidth: wristWidth, endDepth: wristDepth, widthBulge: forearm * 0.14, depthBulge: forearm * 0.10, sagittalCenterBulge: -forearm * 0.04, region: GHOST_BODY_REGIONS.leftArm, chainStart: 0.52, chainEnd: 0.9, blendRadius: 0.034 },
    ...handPrimitives(leftWrist, leftHandEnd, -1),
    { kind: "segment", start: rightShoulder, end: rightElbow, startWidth: armUpper * 0.96, startDepth: armUpper * 0.86, endWidth: forearm * 1.02, endDepth: forearm * 0.90, widthBulge: armUpper * 0.10, depthBulge: armUpper * 0.07, sagittalCenterBulge: -armUpper * 0.06, region: GHOST_BODY_REGIONS.rightArm, chainStart: 0, chainEnd: 0.52, blendRadius: 0.052 },
    { kind: "segment", start: rightElbow, end: rightWrist, startWidth: forearm * 1.02, startDepth: forearm * 0.92, endWidth: wristWidth, endDepth: wristDepth, widthBulge: forearm * 0.14, depthBulge: forearm * 0.10, sagittalCenterBulge: -forearm * 0.04, region: GHOST_BODY_REGIONS.rightArm, chainStart: 0.52, chainEnd: 0.9, blendRadius: 0.034 },
    ...handPrimitives(rightWrist, rightHandEnd, 1),
    { kind: "segment", start: leftHip, end: leftKnee, startWidth: thigh, startDepth: thigh * 0.88, endWidth: calf * 1.08, endDepth: calf * 0.96, widthBulge: thigh * 0.08, depthBulge: thigh * 0.06, sagittalCenterBulge: -thigh * 0.04, region: GHOST_BODY_REGIONS.leftLeg, chainStart: 0, chainEnd: 0.5, blendRadius: 0.026 },
    { kind: "segment", start: leftKnee, end: leftAnkle, startWidth: calf * 1.02, startDepth: calf * 0.94, endWidth: calf * 0.52, endDepth: calf * 0.48, widthBulge: calf * 0.20, depthBulge: calf * 0.16, sagittalCenterBulge: calf * 0.16, region: GHOST_BODY_REGIONS.leftLeg, chainStart: 0.5, chainEnd: 0.9, blendRadius: 0.03 },
    ...footPrimitives(leftAnkle, GHOST_BODY_REGIONS.leftLeg),
    { kind: "segment", start: rightHip, end: rightKnee, startWidth: thigh, startDepth: thigh * 0.88, endWidth: calf * 1.08, endDepth: calf * 0.96, widthBulge: thigh * 0.08, depthBulge: thigh * 0.06, sagittalCenterBulge: -thigh * 0.04, region: GHOST_BODY_REGIONS.rightLeg, chainStart: 0, chainEnd: 0.5, blendRadius: 0.026 },
    { kind: "segment", start: rightKnee, end: rightAnkle, startWidth: calf * 1.02, startDepth: calf * 0.94, endWidth: calf * 0.52, endDepth: calf * 0.48, widthBulge: calf * 0.20, depthBulge: calf * 0.16, sagittalCenterBulge: calf * 0.16, region: GHOST_BODY_REGIONS.rightLeg, chainStart: 0.5, chainEnd: 0.9, blendRadius: 0.03 },
    ...footPrimitives(rightAnkle, GHOST_BODY_REGIONS.rightLeg),
  ];
}

function primitivesForLod(
  primitives: BodyPrimitive[],
  lodIndex: number,
  effectiveVoxelSize: number,
): BodyPrimitive[] {
  if (lodIndex !== 1) return primitives;
  return primitives.flatMap((primitive) => {
    if (primitive.kind === "segment" && primitive.omitAtMediumLod) return [];
    if (primitive.kind !== "segment" || !primitive.preserveAtMediumLod) return primitive;
    // The medium body is the normal portrait-distance model. Its previous
    // 3.35 cm remesh cell was wider than the blurred fingertip depth, reducing
    // the entire crown to a handful of triangles. Keep at least one stable
    // cross-section through that cell without increasing resolution across the
    // rest of the body.
    return {
      ...primitive,
      startWidth: Math.max(primitive.startWidth, effectiveVoxelSize * 0.85),
      startDepth: Math.max(primitive.startDepth, effectiveVoxelSize * 0.62),
      endWidth: Math.max(primitive.endWidth, effectiveVoxelSize * 0.82),
      endDepth: Math.max(primitive.endDepth, effectiveVoxelSize * 0.58),
      // A regular ellipsoidal segment ends in one axial pole. At medium LOD
      // that pole occupies only one or two marching-cubes cells and becomes a
      // triangular spike after the hand is raised. A superelliptic cap keeps
      // the same continuous field while holding a broad, rounded mitten
      // silhouette almost to the endpoint.
      capLengthScale: 1,
      fieldExponent: 4,
    };
  });
}

function primitiveBounds(primitives: BodyPrimitive[], margin: number): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const primitive of primitives) {
    const centers: readonly Vec3[] = primitive.kind === "ellipsoid"
      ? [primitive.center]
      : primitive.kind === "segment"
      ? [primitive.start, primitive.end]
      : primitive.sections.map((section) => [
        primitive.centerX,
        section.y,
        section.centerZ ?? primitive.centerZ,
      ] as const);
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

function regionHullConfidence(region: GhostBodyRegion, chainT: number): number {
  switch (region) {
    case GHOST_BODY_REGIONS.core: return 0.78;
    case GHOST_BODY_REGIONS.leftLeg:
    case GHOST_BODY_REGIONS.rightLeg: {
      // Feet occupy few pixels and are frequently clipped by the photo floor.
      // Let the anatomical field dominate below the ankle so an incomplete
      // silhouette cannot detach the heel into a separate component.
      const t = clamp((chainT - 0.78) / 0.16, 0, 1);
      const eased = t * t * (3 - 2 * t);
      return 0.62 - eased * 0.58;
    }
    case GHOST_BODY_REGIONS.leftArm:
    case GHOST_BODY_REGIONS.rightArm: {
      // The connected palm and finger clusters now provide a reliable safety
      // volume. Preserve enough four-view evidence at the distal hand to cut
      // a blurred fingertip silhouette instead of forcing every scan into the
      // same rounded mitten, while still keeping anatomy dominant.
      const t = clamp((chainT - 0.65) / 0.27, 0, 1);
      const eased = t * t * (3 - 2 * t);
      return 0.34 - eased * 0.12;
    }
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
  const distalHand = (sample.region === GHOST_BODY_REGIONS.leftArm
      || sample.region === GHOST_BODY_REGIONS.rightArm)
    && sample.chainT > 0.88;
  const hullBlurRadius = distalHand ? blurRadius * 0.60 : blurRadius;
  const hull = clamp(blurredHullField(hullSampler, x, y, z, hullBlurRadius), -0.032, 0.032);
  return anatomy + hull * regionHullConfidence(sample.region, sample.chainT);
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

/**
 * Marching Cubes can emit a one-cell satellite when a sub-voxel fingertip or
 * thumb cap lands exactly on an isovalue. Keep the actual body component, but
 * fail loudly if a meaningful anatomical part ever becomes detached.
 */
function removeTinyDisconnectedIslands(
  mesh: { positions: number[]; indices: number[] },
): { positions: number[]; indices: number[] } {
  const vertexCount = mesh.positions.length / 3;
  const parent = new Int32Array(vertexCount);
  for (let vertex = 0; vertex < vertexCount; vertex += 1) parent[vertex] = vertex;
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
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    union(mesh.indices[offset], mesh.indices[offset + 1]);
    union(mesh.indices[offset + 1], mesh.indices[offset + 2]);
  }
  const triangleCounts = new Map<number, number>();
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const root = find(mesh.indices[offset]);
    triangleCounts.set(root, (triangleCounts.get(root) ?? 0) + 1);
  }
  if (triangleCounts.size <= 1) return mesh;
  const [largestRoot, largestTriangles] = Array.from(triangleCounts.entries())
    .reduce((largest, entry) => entry[1] > largest[1] ? entry : largest);
  const totalTriangles = mesh.indices.length / 3;
  if (largestTriangles / totalTriangles < 0.995) {
    const [detachedRoot, detachedTriangles] = Array.from(triangleCounts.entries())
      .filter(([root]) => root !== largestRoot)
      .reduce((largest, entry) => entry[1] > largest[1] ? entry : largest);
    const detachedCenter: [number, number, number] = [0, 0, 0];
    let detachedSamples = 0;
    for (let offset = 0; offset < mesh.indices.length; offset += 3) {
      if (find(mesh.indices[offset]) !== detachedRoot) continue;
      for (let corner = 0; corner < 3; corner += 1) {
        const vertex = mesh.indices[offset + corner];
        detachedCenter[0] += mesh.positions[vertex * 3];
        detachedCenter[1] += mesh.positions[vertex * 3 + 1];
        detachedCenter[2] += mesh.positions[vertex * 3 + 2];
        detachedSamples += 1;
      }
    }
    const center = detachedCenter.map((value) => value / Math.max(detachedSamples, 1));
    throw new Error(
      `Spectral body field produced a detached anatomical component (${detachedTriangles} triangles near ${center.map((value) => value.toFixed(3)).join(", ")}).`,
    );
  }
  const remap = new Int32Array(vertexCount);
  remap.fill(-1);
  const positions: number[] = [];
  const indices: number[] = [];
  const mappedVertex = (source: number): number => {
    const cached = remap[source];
    if (cached >= 0) return cached;
    const target = positions.length / 3;
    positions.push(
      mesh.positions[source * 3],
      mesh.positions[source * 3 + 1],
      mesh.positions[source * 3 + 2],
    );
    remap[source] = target;
    return target;
  };
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    if (find(mesh.indices[offset]) !== largestRoot) continue;
    indices.push(
      mappedVertex(mesh.indices[offset]),
      mappedVertex(mesh.indices[offset + 1]),
      mappedVertex(mesh.indices[offset + 2]),
    );
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

function smoothMediumHandCrown(
  positions: number[],
  indices: number[],
  regionAndChain: Uint8Array,
  iterations = 3,
): void {
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
  const weights = new Float32Array(positions.length / 3);
  for (let vertex = 0; vertex < weights.length; vertex += 1) {
    const region = regionAndChain[vertex * 2];
    const arm = region === GHOST_BODY_REGIONS.leftArm || region === GHOST_BODY_REGIONS.rightArm;
    if (!arm) continue;
    const chainT = regionAndChain[vertex * 2 + 1] / 255;
    const t = clamp((chainT - 0.945) / 0.04, 0, 1);
    weights[vertex] = t * t * (3 - 2 * t);
  }
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const next = positions.slice();
    for (let vertex = 0; vertex < neighbors.length; vertex += 1) {
      const weight = weights[vertex];
      const adjacent = neighbors[vertex];
      if (weight <= 0 || adjacent.length === 0) continue;
      let x = 0;
      let y = 0;
      let z = 0;
      for (const neighbor of adjacent) {
        x += positions[neighbor * 3];
        y += positions[neighbor * 3 + 1];
        z += positions[neighbor * 3 + 2];
      }
      const inverse = 1 / adjacent.length;
      const factor = 0.30 * weight;
      next[vertex * 3] += (x * inverse - positions[vertex * 3]) * factor;
      next[vertex * 3 + 1] += (y * inverse - positions[vertex * 3 + 1]) * factor;
      next[vertex * 3 + 2] += (z * inverse - positions[vertex * 3 + 2]) * factor;
    }
    for (let index = 0; index < positions.length; index += 1) positions[index] = next[index];
  }
}

function reprojectMediumHandCrown(
  positions: number[],
  regionAndChain: Uint8Array,
  primitives: BodyPrimitive[],
  hullSampler: ReturnType<typeof worldHullSampler>,
  voxelSize: number,
): void {
  const epsilon = voxelSize * 0.20;
  const blurRadius = voxelSize * 0.45;
  const maximumStep = voxelSize * SPECTRAL_MEDIUM_HAND_REPROJECTION.maximumStepInVoxels;
  for (let iteration = 0; iteration < SPECTRAL_MEDIUM_HAND_REPROJECTION.iterations; iteration += 1) {
    for (let vertex = 0; vertex < positions.length / 3; vertex += 1) {
      const region = regionAndChain[vertex * 2];
      const arm = region === GHOST_BODY_REGIONS.leftArm || region === GHOST_BODY_REGIONS.rightArm;
      const chainT = regionAndChain[vertex * 2 + 1] / 255;
      if (!arm || chainT < SPECTRAL_MEDIUM_HAND_REPROJECTION.chainStart) continue;
      const offset = vertex * 3;
      const x = positions[offset];
      const y = positions[offset + 1];
      const z = positions[offset + 2];
      const sample: FieldSample = { value: 0, region, chainT };
      const distance = sampleFinalField(primitives, hullSampler, x, y, z, blurRadius, sample);
      if (!Number.isFinite(distance) || Math.abs(distance) <= 1e-5) continue;
      const normal = fieldGradient(
        primitives, hullSampler, x, y, z, epsilon, blurRadius, sample,
      );
      const step = clamp(distance, -maximumStep, maximumStep) * 0.88;
      positions[offset] += normal[0] * step;
      positions[offset + 1] += normal[1] * step;
      positions[offset + 2] += normal[2] * step;
    }
  }
}

function refineMediumHandCrown(
  positions: number[],
  indices: number[],
  regionAndChain: Uint8Array,
): { positions: number[]; indices: number[] } {
  const edgeKey = (a: number, b: number): string => a < b ? `${a}:${b}` : `${b}:${a}`;
  const splitEdges = new Set<string>();
  const distalArm = (vertex: number): boolean => {
    const region = regionAndChain[vertex * 2];
    const arm = region === GHOST_BODY_REGIONS.leftArm || region === GHOST_BODY_REGIONS.rightArm;
    return arm && regionAndChain[vertex * 2 + 1] / 255 >= 0.94;
  };
  for (let index = 0; index < indices.length; index += 3) {
    const a = indices[index];
    const b = indices[index + 1];
    const c = indices[index + 2];
    if (!distalArm(a) && !distalArm(b) && !distalArm(c)) continue;
    splitEdges.add(edgeKey(a, b));
    splitEdges.add(edgeKey(b, c));
    splitEdges.add(edgeKey(c, a));
  }
  if (splitEdges.size === 0) return { positions, indices };

  const refinedPositions = positions.slice();
  const refinedIndices: number[] = [];
  const midpoints = new Map<string, number>();
  const midpoint = (a: number, b: number): number | undefined => {
    const key = edgeKey(a, b);
    if (!splitEdges.has(key)) return undefined;
    const cached = midpoints.get(key);
    if (cached !== undefined) return cached;
    const vertex = refinedPositions.length / 3;
    refinedPositions.push(
      (positions[a * 3] + positions[b * 3]) * 0.5,
      (positions[a * 3 + 1] + positions[b * 3 + 1]) * 0.5,
      (positions[a * 3 + 2] + positions[b * 3 + 2]) * 0.5,
    );
    midpoints.set(key, vertex);
    return vertex;
  };
  for (let index = 0; index < indices.length; index += 3) {
    const a = indices[index];
    const b = indices[index + 1];
    const c = indices[index + 2];
    const ab = midpoint(a, b);
    const bc = midpoint(b, c);
    const ca = midpoint(c, a);
    if (ab !== undefined && bc !== undefined && ca !== undefined) {
      refinedIndices.push(
        a, ab, ca,
        ab, b, bc,
        bc, c, ca,
        ab, bc, ca,
      );
      continue;
    }
    if (ab !== undefined && bc !== undefined) {
      refinedIndices.push(ab, b, bc, a, ab, c, ab, bc, c);
      continue;
    }
    if (bc !== undefined && ca !== undefined) {
      refinedIndices.push(a, b, bc, bc, c, ca, a, bc, ca);
      continue;
    }
    if (ca !== undefined && ab !== undefined) {
      refinedIndices.push(a, ab, ca, ab, b, c, ab, c, ca);
      continue;
    }
    if (ab !== undefined) {
      refinedIndices.push(a, ab, c, ab, b, c);
      continue;
    }
    if (bc !== undefined) {
      refinedIndices.push(a, b, bc, a, bc, c);
      continue;
    }
    if (ca !== undefined) {
      refinedIndices.push(a, b, ca, b, c, ca);
      continue;
    }
    refinedIndices.push(a, b, c);
  }
  return { positions: refinedPositions, indices: refinedIndices };
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
  rig: GhostRig,
  measurements: BodyMeasurements,
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
  const joints = restJointPositions(rig);
  const handLength = measurements.height * SPECTRAL_HUMAN_VOLUME_PROPORTIONS.handLengthToHeight;
  const stabilizeArm = (region: number, shoulder: number, elbow: number, wrist: number): void => {
    const handEnd = joints[wrist].clone().addScaledVector(
      joints[wrist].clone().sub(joints[elbow]).normalize(),
      handLength,
    );
    const points = [joints[shoulder], joints[elbow], joints[wrist], handEnd];
    const chains = [0, SPECTRAL_ARM_SWEEP_RESPONSE.elbowChain, SPECTRAL_ARM_SWEEP_RESPONSE.wristChain, 1];
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      if (regionAndChain[vertex * 2] !== region) continue;
      const point = new THREE.Vector3().fromArray(positions, vertex * 3);
      let closestDistance = Number.POSITIVE_INFINITY;
      let closestChain = 0;
      for (let segment = 0; segment < 3; segment += 1) {
        const start = points[segment];
        const delta = points[segment + 1].clone().sub(start);
        const lengthSquared = Math.max(delta.lengthSq(), 1e-8);
        const local = clamp(point.clone().sub(start).dot(delta) / lengthSquared, 0, 1);
        const distance = point.distanceToSquared(start.clone().addScaledVector(delta, local));
        if (distance >= closestDistance) continue;
        closestDistance = distance;
        closestChain = chains[segment] + (chains[segment + 1] - chains[segment]) * local;
      }
      regionAndChain[vertex * 2 + 1] = Math.round(clamp(closestChain, 0, 1) * 255);
    }
  };
  stabilizeArm(GHOST_BODY_REGIONS.leftArm, 5, 6, 7);
  stabilizeArm(GHOST_BODY_REGIONS.rightArm, 8, 9, 10);
  return { normals, skinIndices, skinWeights, canonicalCoords, regionAndChain };
}

function meshQuality(
  vertexCount: number,
  indices: number[],
  positions: number[],
  normals: Int16Array,
): GhostBodyQuality {
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
  let flippedTriangles = 0;
  let nonFiniteVertices = 0;
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const offset = vertex * 3;
    if (
      !Number.isFinite(positions[offset])
      || !Number.isFinite(positions[offset + 1])
      || !Number.isFinite(positions[offset + 2])
    ) {
      nonFiniteVertices += 1;
    }
  }
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
    if (!Number.isFinite(area2) || area2 < 1e-10) {
      degenerateTriangles += 1;
    } else {
      const normalX = normals[ai] + normals[bi] + normals[ci];
      const normalY = normals[ai + 1] + normals[bi + 1] + normals[ci + 1];
      const normalZ = normals[ai + 2] + normals[bi + 2] + normals[ci + 2];
      const faceNormalX = aby * acz - abz * acy;
      const faceNormalY = abz * acx - abx * acz;
      const faceNormalZ = abx * acy - aby * acx;
      if (faceNormalX * normalX + faceNormalY * normalY + faceNormalZ * normalZ < 0) {
        flippedTriangles += 1;
      }
    }
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
    nonFiniteVertices,
    flippedTriangles,
    normalCoherencePercent: measureQuantizedNormalCoherence(normals, indices),
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
    const remeshScale = request.voxelSize === undefined
      ? SPECTRAL_BODY_LOD_REMESH_SCALES[lodIndex]
      : 1;
    const lodPrimitives = primitivesForLod(primitives, lodIndex, voxelSize * remeshScale);
    const grid = createGrid(lodPrimitives, voxelSize);
    const field = fillField(grid, lodPrimitives, hull);
    const triangleBudget = request.voxelSize === undefined
      ? SPECTRAL_BODY_LOD_TRIANGLE_BUDGETS[lodIndex]
      : MAX_TRIANGLES;
    const remesh = request.voxelSize === undefined
      ? resampleField(grid, field, voxelSize * remeshScale)
      : { grid, field };
    let mesh = removeTinyDisconnectedIslands(polygonize(remesh.grid, remesh.field));
    if (mesh.indices.length < 3) throw new Error(`Spectral body LOD${lodIndex} field produced no surface.`);
    taubinSmooth(mesh.positions, mesh.indices, 4);
    const triangleCount = mesh.indices.length / 3;
    if (triangleCount > triangleBudget) {
      throw new Error(`Spectral body LOD${lodIndex} exceeded triangle budget (${triangleCount}/${triangleBudget}).`);
    }
    let attributes = buildAttributes(
      mesh.positions, lodPrimitives, hull, grid, voxelSize * 0.45, voxelSize, rig, measurements,
    );
    if (lodIndex === 1) {
      // Split the crown and one conforming neighbor ring before smoothing. The
      // shared edge map prevents T-junctions, keeping the body closed while
      // giving the rounded cap enough local topology to survive an extreme
      // raised-hand silhouette.
      mesh = refineMediumHandCrown(mesh.positions, mesh.indices, attributes.regionAndChain);
      attributes = buildAttributes(
        mesh.positions, lodPrimitives, hull, grid, voxelSize * 0.45, voxelSize, rig, measurements,
      );
      smoothMediumHandCrown(mesh.positions, mesh.indices, attributes.regionAndChain, 5);
      // Subdivision midpoints initially lie on straight triangle chords and
      // Laplacian smoothing draws them farther inside the continuous SDF.
      // Reproject only the distal crown so its extra topology describes the
      // rounded field rather than exposing inset terraces in a side view.
      reprojectMediumHandCrown(
        mesh.positions,
        attributes.regionAndChain,
        lodPrimitives,
        hull,
        voxelSize,
      );
      attributes = buildAttributes(
        mesh.positions, lodPrimitives, hull, grid, voxelSize * 0.45, voxelSize, rig, measurements,
      );
    }
    const finalTriangleCount = mesh.indices.length / 3;
    if (finalTriangleCount > triangleBudget) {
      throw new Error(`Spectral body LOD${lodIndex} exceeded triangle budget after hand refinement (${finalTriangleCount}/${triangleBudget}).`);
    }
    const coherentNormals = smoothQuantizedSurfaceNormals(attributes.normals, mesh.indices);
    orientTriangles(mesh.positions, mesh.indices, coherentNormals);
    const lod: GhostLodMesh = {
      voxelSize,
      vertexCount: mesh.positions.length / 3,
      triangleCount: finalTriangleCount,
      positions: new Float32Array(mesh.positions),
      normals: coherentNormals,
      indices: new Uint32Array(mesh.indices),
      skinIndices: attributes.skinIndices,
      skinWeights: attributes.skinWeights,
      canonicalCoords: attributes.canonicalCoords,
      regionAndChain: attributes.regionAndChain,
    };
    assignProgrammaticSkinWeights(lod, rig);
    const lodQuality = meshQuality(lod.vertexCount, mesh.indices, mesh.positions, coherentNormals);
    if (
      lodQuality.connectedComponents !== 1
      || lodQuality.boundaryEdges !== 0
      || lodQuality.degenerateTriangles !== 0
      || lodQuality.nonFiniteVertices !== 0
      || lodQuality.flippedTriangles !== 0
      || lodQuality.normalCoherencePercent < SPECTRAL_NORMAL_COHERENCE_MIN_PERCENT
    ) {
      throw new Error(`Spectral body LOD${lodIndex} failed quality gates (${JSON.stringify(lodQuality)}).`);
    }
    if (lodIndex === 0) {
      primaryGrid = grid;
      quality = lodQuality;
    }
    return lod;
  });
  if (!primaryGrid || !quality) throw new Error("Spectral body did not produce a primary LOD.");
  Object.assign(quality, measureGhostBodySilhouetteEvidence(lods[0], request.orientations));
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
