import * as THREE from "three";
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

export const SPECTRAL_BODY_ALGORITHM_VERSION = "anatomical-sdf-v1";
export const SPECTRAL_BODY_VOXEL_SIZE = 0.018;

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
}

interface SegmentPrimitive {
  kind: "segment";
  start: Vec3;
  end: Vec3;
  startWidth: number;
  startDepth: number;
  endWidth: number;
  endDepth: number;
  region: GhostBodyRegion;
  chainStart: number;
  chainEnd: number;
}

type BodyPrimitive = EllipsoidPrimitive | SegmentPrimitive;

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

const TETRAHEDRA = [
  [0, 5, 1, 6],
  [0, 1, 2, 6],
  [0, 2, 3, 6],
  [0, 3, 7, 6],
  [0, 7, 4, 6],
  [0, 4, 5, 6],
] as const;

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
  const width = primitive.startWidth + (primitive.endWidth - primitive.startWidth) * t;
  const depth = primitive.startDepth + (primitive.endDepth - primitive.startDepth) * t;
  const lateral = px * ux + py * uy + pz * uz;
  const sagittal = px * vx + py * vy + pz * vz;
  const axial = px * tx + py * ty + pz * tz;
  const normalized = Math.hypot(lateral / width, sagittal / depth, axial / width);
  return (1 - normalized) * Math.min(width, depth);
}

function primitiveField(primitive: BodyPrimitive, x: number, y: number, z: number): number {
  return primitive.kind === "ellipsoid"
    ? ellipsoidField(primitive, x, y, z)
    : segmentField(primitive, x, y, z);
}

function primitiveChainT(primitive: BodyPrimitive, x: number, y: number, z: number): number {
  if (primitive.kind === "ellipsoid") return primitive.chainT;
  const t = segmentProjection(primitive, x, y, z);
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
    combined = combined < -1e5 ? value : smoothMaximum(combined, value, SMOOTH_UNION_RADIUS);
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
  const shoulderHalf = measurements.shoulderWidth * 0.5;
  const hipHalf = measurements.hipWidth * 0.5;
  const chestHalf = measurements.chestWidth * 0.5;
  const waistHalf = measurements.waistWidth * 0.5;
  const headX = measurements.headDiameter * 0.48;
  const headY = measurements.headDiameter * 0.62;
  const headZ = measurements.headDiameter * 0.52;
  const pelvisY = -0.18 * scale;
  const shoulderY = 0.52 * scale;
  const elbowY = 0.25 * scale;
  const wristY = -0.01 * scale;
  const kneeY = -0.61 * scale;
  const ankleY = -0.96 * scale;
  const footY = -1.01 * scale;
  const leftShoulder: Vec3 = [-shoulderHalf * 0.94, shoulderY, 0];
  const rightShoulder: Vec3 = [shoulderHalf * 0.94, shoulderY, 0];
  const leftElbow: Vec3 = [-shoulderHalf * 1.78, elbowY, 0.004];
  const rightElbow: Vec3 = [shoulderHalf * 1.78, elbowY, 0.004];
  const leftWrist: Vec3 = [-shoulderHalf * 2.28, wristY, 0.012];
  const rightWrist: Vec3 = [shoulderHalf * 2.28, wristY, 0.012];
  const armUpper = clamp(measurements.shoulderWidth * 0.145, 0.062, 0.092);
  const forearm = armUpper * 0.76;
  const thigh = clamp(measurements.hipWidth * 0.31, 0.095, 0.145);
  const calf = thigh * 0.72;
  const leftHip: Vec3 = [-hipHalf * 0.62, pelvisY - 0.05 * scale, 0];
  const rightHip: Vec3 = [hipHalf * 0.62, pelvisY - 0.05 * scale, 0];
  // Keep the mid-thighs as two distinct volumes. A narrow inward knee axis plus
  // a global smooth-union radius otherwise creates a skirt-like bridge.
  const leftKnee: Vec3 = [-hipHalf * 0.68, kneeY, 0.018];
  const rightKnee: Vec3 = [hipHalf * 0.68, kneeY, 0.018];
  const leftAnkle: Vec3 = [-hipHalf * 0.55, ankleY, 0.012];
  const rightAnkle: Vec3 = [hipHalf * 0.55, ankleY, 0.012];
  return [
    { kind: "ellipsoid", center: [0, 0.31 * scale, 0], radii: [chestHalf, 0.34 * scale, chestHalf * 0.57], region: GHOST_BODY_REGIONS.core, chainT: 0.72 },
    { kind: "ellipsoid", center: [0, 0.02 * scale, 0], radii: [waistHalf, 0.31 * scale, waistHalf * 0.61], region: GHOST_BODY_REGIONS.core, chainT: 0.5 },
    { kind: "ellipsoid", center: [0, pelvisY, 0], radii: [hipHalf * 1.03, 0.21 * scale, hipHalf * 0.67], region: GHOST_BODY_REGIONS.core, chainT: 0.34 },
    { kind: "ellipsoid", center: [0, 0.68 * scale, 0], radii: [0.085 * scale, 0.17 * scale, 0.08 * scale], region: GHOST_BODY_REGIONS.head, chainT: 0.08 },
    { kind: "ellipsoid", center: [0, 0.88 * scale, -0.006 * scale], radii: [headX, headY, headZ], region: GHOST_BODY_REGIONS.head, chainT: 0.72 },
    { kind: "segment", start: leftShoulder, end: leftElbow, startWidth: armUpper, startDepth: armUpper * 0.86, endWidth: forearm * 1.03, endDepth: forearm * 0.88, region: GHOST_BODY_REGIONS.leftArm, chainStart: 0, chainEnd: 0.52 },
    { kind: "segment", start: leftElbow, end: leftWrist, startWidth: forearm * 1.05, startDepth: forearm * 0.9, endWidth: forearm * 0.7, endDepth: forearm * 0.64, region: GHOST_BODY_REGIONS.leftArm, chainStart: 0.52, chainEnd: 0.9 },
    { kind: "ellipsoid", center: [leftWrist[0] - armUpper * 0.72, leftWrist[1] - armUpper * 0.72, leftWrist[2] + 0.008], radii: [armUpper * 0.76, armUpper * 1.08, armUpper * 0.48], region: GHOST_BODY_REGIONS.leftArm, chainT: 1 },
    { kind: "segment", start: rightShoulder, end: rightElbow, startWidth: armUpper, startDepth: armUpper * 0.86, endWidth: forearm * 1.03, endDepth: forearm * 0.88, region: GHOST_BODY_REGIONS.rightArm, chainStart: 0, chainEnd: 0.52 },
    { kind: "segment", start: rightElbow, end: rightWrist, startWidth: forearm * 1.05, startDepth: forearm * 0.9, endWidth: forearm * 0.7, endDepth: forearm * 0.64, region: GHOST_BODY_REGIONS.rightArm, chainStart: 0.52, chainEnd: 0.9 },
    { kind: "ellipsoid", center: [rightWrist[0] + armUpper * 0.72, rightWrist[1] - armUpper * 0.72, rightWrist[2] + 0.008], radii: [armUpper * 0.76, armUpper * 1.08, armUpper * 0.48], region: GHOST_BODY_REGIONS.rightArm, chainT: 1 },
    { kind: "segment", start: leftHip, end: leftKnee, startWidth: thigh, startDepth: thigh * 0.88, endWidth: calf * 1.08, endDepth: calf * 0.96, region: GHOST_BODY_REGIONS.leftLeg, chainStart: 0, chainEnd: 0.5 },
    { kind: "segment", start: leftKnee, end: leftAnkle, startWidth: calf * 1.08, startDepth: calf, endWidth: calf * 0.55, endDepth: calf * 0.52, region: GHOST_BODY_REGIONS.leftLeg, chainStart: 0.5, chainEnd: 0.9 },
    { kind: "segment", start: leftAnkle, end: [leftAnkle[0], footY, 0.2 * scale], startWidth: calf * 0.62, startDepth: calf * 0.58, endWidth: calf * 0.72, endDepth: calf * 0.82, region: GHOST_BODY_REGIONS.leftLeg, chainStart: 0.9, chainEnd: 1 },
    { kind: "segment", start: rightHip, end: rightKnee, startWidth: thigh, startDepth: thigh * 0.88, endWidth: calf * 1.08, endDepth: calf * 0.96, region: GHOST_BODY_REGIONS.rightLeg, chainStart: 0, chainEnd: 0.5 },
    { kind: "segment", start: rightKnee, end: rightAnkle, startWidth: calf * 1.08, startDepth: calf, endWidth: calf * 0.55, endDepth: calf * 0.52, region: GHOST_BODY_REGIONS.rightLeg, chainStart: 0.5, chainEnd: 0.9 },
    { kind: "segment", start: rightAnkle, end: [rightAnkle[0], footY, 0.2 * scale], startWidth: calf * 0.62, startDepth: calf * 0.58, endWidth: calf * 0.72, endDepth: calf * 0.82, region: GHOST_BODY_REGIONS.rightLeg, chainStart: 0.9, chainEnd: 1 },
  ];
}

function primitiveBounds(primitives: BodyPrimitive[], margin: number): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const primitive of primitives) {
    const centers = primitive.kind === "ellipsoid" ? [primitive.center] : [primitive.start, primitive.end];
    const radius = primitive.kind === "ellipsoid"
      ? Math.max(...primitive.radii)
      : Math.max(primitive.startWidth, primitive.startDepth, primitive.endWidth, primitive.endDepth);
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

  const addTetrahedron = (points: readonly number[]) => {
    const inside = points.filter((point) => field[point] >= 0);
    if (inside.length === 0 || inside.length === 4) return;
    const outside = points.filter((point) => field[point] < 0);
    if (inside.length === 1) {
      indices.push(
        edgeVertex(inside[0], outside[0]),
        edgeVertex(inside[0], outside[1]),
        edgeVertex(inside[0], outside[2]),
      );
      return;
    }
    if (inside.length === 3) {
      indices.push(
        edgeVertex(outside[0], inside[0]),
        edgeVertex(outside[0], inside[1]),
        edgeVertex(outside[0], inside[2]),
      );
      return;
    }
    const a = edgeVertex(inside[0], outside[0]);
    const b = edgeVertex(inside[0], outside[1]);
    const c = edgeVertex(inside[1], outside[0]);
    const d = edgeVertex(inside[1], outside[1]);
    indices.push(a, b, c, b, d, c);
  };

  for (let z = 0; z < grid.nz - 1; z += 1) {
    for (let y = 0; y < grid.ny - 1; y += 1) {
      for (let x = 0; x < grid.nx - 1; x += 1) {
        const cube = CORNERS.map(([dx, dy, dz]) => gridIndex(grid, x + dx, y + dy, z + dz));
        for (const tetrahedron of TETRAHEDRA) {
          addTetrahedron(tetrahedron.map((corner) => cube[corner]));
        }
      }
    }
  }
  return { positions, indices };
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
  const scale = measurements.height / 2.15;
  const shoulderHalf = measurements.shoulderWidth * 0.47;
  const hipJointX = measurements.hipWidth * 0.31;
  const kneeX = measurements.hipWidth * 0.34;
  const ankleX = measurements.hipWidth * 0.275;
  const world: Vec3[] = [
    [0, -0.18 * scale, 0], [0, 0.02 * scale, 0], [0, 0.31 * scale, 0], [0, 0.67 * scale, 0], [0, 0.88 * scale, 0],
    [-shoulderHalf, 0.52 * scale, 0], [-shoulderHalf * 1.78, 0.25 * scale, 0], [-shoulderHalf * 2.28, -0.01 * scale, 0],
    [shoulderHalf, 0.52 * scale, 0], [shoulderHalf * 1.78, 0.25 * scale, 0], [shoulderHalf * 2.28, -0.01 * scale, 0],
    [-hipJointX, -0.23 * scale, 0], [-kneeX, -0.61 * scale, 0.018], [-ankleX, -0.96 * scale, 0.012],
    [hipJointX, -0.23 * scale, 0], [kneeX, -0.61 * scale, 0.018], [ankleX, -0.96 * scale, 0.012],
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
  const voxelSize = request.voxelSize ?? SPECTRAL_BODY_VOXEL_SIZE;
  const grid = createGrid(primitives, voxelSize);
  const hull = worldHullSampler(request.orientations);
  const field = fillField(grid, primitives, hull);
  const mesh = polygonize(grid, field);
  if (mesh.indices.length < 3) throw new Error("Spectral body field produced no surface.");
  taubinSmooth(mesh.positions, mesh.indices, 2);
  const triangleCount = mesh.indices.length / 3;
  if (triangleCount > MAX_TRIANGLES) throw new Error(`Spectral body exceeded triangle budget (${triangleCount}).`);
  const attributes = buildAttributes(mesh.positions, primitives, hull, grid, voxelSize * 0.45, voxelSize);
  orientTriangles(mesh.positions, mesh.indices, attributes.normals);
  const quality = meshQuality(mesh.positions.length / 3, mesh.indices, mesh.positions);
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
  const rig = createRig(measurements);
  assignProgrammaticSkinWeights(lod, rig);
  return {
    version: GHOST_BODY_MODEL_VERSION,
    algorithmVersion: SPECTRAL_BODY_ALGORITHM_VERSION,
    sourceHash: request.sourceHash,
    rig,
    lods: [lod],
    measurements,
    partial: request.partial ? "upper" : "full",
    canonicalBounds: { min: grid.min, max: grid.max },
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
  geometry.setIndex(new THREE.BufferAttribute(lod.indices, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}
