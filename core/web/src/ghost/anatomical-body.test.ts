import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { Landmark, OrientationMask } from "../models/types";
import { encodePersonMaskRLE } from "../pose/segmentation";
import { GHOST_BODY_REGIONS, validateGhostLodContract, validateGhostRigContract } from "./body-model";
import {
  buildAnatomicalGhostBody,
  geometryFromGhostLod,
  SPECTRAL_BODY_ALGORITHM_VERSION,
  SPECTRAL_BODY_LOD_TRIANGLE_BUDGETS,
  SPECTRAL_BODY_LOD_VOXEL_SIZES,
  SPECTRAL_BODY_VOXEL_SIZE,
  SPECTRAL_HUMAN_PROPORTIONS,
  SPECTRAL_HUMAN_LATERAL_PROPORTIONS,
  SPECTRAL_HUMAN_VOLUME_PROPORTIONS,
} from "./anatomical-body";
import { restJointPositions } from "./body-skinning";
import { createPerformancePose } from "./performance-probe";
import { SPECTRAL_BODY_MEASUREMENT_RATIOS } from "./template-body";

function standingLandmarks(): Landmark[] {
  const landmarks = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0 }));
  const set = (index: number, x: number, y: number, z = 0) => {
    landmarks[index] = { x, y, z, visibility: 1 };
  };
  set(0, 0, -0.43, -0.02);
  set(7, -0.045, -0.4);
  set(8, 0.045, -0.4);
  set(11, -0.13, -0.28);
  set(12, 0.13, -0.28);
  set(13, -0.18, -0.04);
  set(14, 0.18, -0.04);
  set(15, -0.19, 0.18);
  set(16, 0.19, 0.18);
  set(23, -0.09, 0.08);
  set(24, 0.09, 0.08);
  set(25, -0.085, 0.3);
  set(26, 0.085, 0.3);
  set(27, -0.08, 0.51);
  set(28, 0.08, 0.51);
  return landmarks;
}

function measurementOutlierLandmarks(mode: "tall-narrow" | "short-wide"): Landmark[] {
  const landmarks = standingLandmarks();
  if (mode === "tall-narrow") {
    landmarks[7] = { x: -0.025, y: -0.57, z: 0, visibility: 1 };
    landmarks[8] = { x: 0.025, y: -0.57, z: 0, visibility: 1 };
    landmarks[11] = { x: -0.035, y: -0.39, z: 0, visibility: 1 };
    landmarks[12] = { x: 0.035, y: -0.39, z: 0, visibility: 1 };
    landmarks[23] = { x: -0.025, y: 0.07, z: 0, visibility: 1 };
    landmarks[24] = { x: 0.025, y: 0.07, z: 0, visibility: 1 };
    landmarks[27] = { x: -0.02, y: 0.65, z: 0, visibility: 1 };
    landmarks[28] = { x: 0.02, y: 0.65, z: 0, visibility: 1 };
  } else {
    landmarks[7] = { x: -0.09, y: -0.15, z: 0, visibility: 1 };
    landmarks[8] = { x: 0.09, y: -0.15, z: 0, visibility: 1 };
    landmarks[11] = { x: -0.32, y: -0.08, z: 0, visibility: 1 };
    landmarks[12] = { x: 0.32, y: -0.08, z: 0, visibility: 1 };
    landmarks[23] = { x: -0.28, y: 0.04, z: 0, visibility: 1 };
    landmarks[24] = { x: 0.28, y: 0.04, z: 0, visibility: 1 };
    landmarks[27] = { x: -0.22, y: 0.22, z: 0, visibility: 1 };
    landmarks[28] = { x: 0.22, y: 0.22, z: 0, visibility: 1 };
  }
  return landmarks;
}

function horizontalSectionComponents(
  positions: Float32Array,
  indices: Uint32Array,
  planeY: number,
  maximumAbsX = Number.POSITIVE_INFINITY,
): number {
  const adjacency = new Map<string, Set<string>>();
  const key = (x: number, z: number) => `${Math.round(x * 10_000)},${Math.round(z * 10_000)}`;
  const connect = (a: string, b: string) => {
    if (a === b) return;
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    if (!adjacency.has(b)) adjacency.set(b, new Set());
    adjacency.get(a)!.add(b);
    adjacency.get(b)!.add(a);
  };
  for (let index = 0; index < indices.length; index += 3) {
    const vertices = [indices[index], indices[index + 1], indices[index + 2]].map((vertex) => ({
      x: positions[vertex * 3],
      y: positions[vertex * 3 + 1],
      z: positions[vertex * 3 + 2],
    }));
    const intersections: Array<{ x: number; z: number }> = [];
    for (const [a, b] of [[0, 1], [1, 2], [2, 0]] as const) {
      const start = vertices[a];
      const end = vertices[b];
      if ((start.y < planeY) === (end.y < planeY) || Math.abs(end.y - start.y) < 1e-8) continue;
      const t = (planeY - start.y) / (end.y - start.y);
      intersections.push({
        x: start.x + (end.x - start.x) * t,
        z: start.z + (end.z - start.z) * t,
      });
    }
    if (intersections.length === 2 && intersections.every((point) => Math.abs(point.x) <= maximumAbsX)) {
      connect(key(intersections[0].x, intersections[0].z), key(intersections[1].x, intersections[1].z));
    }
  }
  const visited = new Set<string>();
  let components = 0;
  adjacency.forEach((_, start) => {
    if (visited.has(start)) return;
    components += 1;
    const stack = [start];
    visited.add(start);
    while (stack.length) {
      const current = stack.pop()!;
      adjacency.get(current)?.forEach((neighbor) => {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          stack.push(neighbor);
        }
      });
    }
  });
  return components;
}

function horizontalSectionProjectedSpan(
  positions: Float32Array,
  indices: Uint32Array,
  planeY: number,
  axis: THREE.Vector3,
): number {
  let minimum = Infinity;
  let maximum = -Infinity;
  for (let index = 0; index < indices.length; index += 3) {
    const vertices = [indices[index], indices[index + 1], indices[index + 2]].map((vertex) => ({
      x: positions[vertex * 3],
      y: positions[vertex * 3 + 1],
      z: positions[vertex * 3 + 2],
    }));
    for (const [a, b] of [[0, 1], [1, 2], [2, 0]] as const) {
      const start = vertices[a];
      const end = vertices[b];
      if ((start.y < planeY) === (end.y < planeY) || Math.abs(end.y - start.y) < 1e-8) continue;
      const t = (planeY - start.y) / (end.y - start.y);
      const x = start.x + (end.x - start.x) * t;
      const projection = x * axis.x
        + planeY * axis.y
        + (start.z + (end.z - start.z) * t) * axis.z;
      minimum = Math.min(minimum, projection);
      maximum = Math.max(maximum, projection);
    }
  }
  return Number.isFinite(minimum) ? maximum - minimum : 0;
}

function horizontalSectionProjectedCenter(
  positions: Float32Array,
  indices: Uint32Array,
  planeY: number,
  axis: THREE.Vector3,
): number {
  let minimum = Infinity;
  let maximum = -Infinity;
  for (let index = 0; index < indices.length; index += 3) {
    const vertices = [indices[index], indices[index + 1], indices[index + 2]].map((vertex) => ({
      x: positions[vertex * 3],
      y: positions[vertex * 3 + 1],
      z: positions[vertex * 3 + 2],
    }));
    for (const [a, b] of [[0, 1], [1, 2], [2, 0]] as const) {
      const start = vertices[a];
      const end = vertices[b];
      if ((start.y < planeY) === (end.y < planeY) || Math.abs(end.y - start.y) < 1e-8) continue;
      const t = (planeY - start.y) / (end.y - start.y);
      const x = start.x + (end.x - start.x) * t;
      const projection = x * axis.x
        + planeY * axis.y
        + (start.z + (end.z - start.z) * t) * axis.z;
      minimum = Math.min(minimum, projection);
      maximum = Math.max(maximum, projection);
    }
  }
  return Number.isFinite(minimum) ? (minimum + maximum) * 0.5 : 0;
}

function generousHullView(azimuth: number): OrientationMask {
  const width = 64;
  const height = 128;
  const mask = new Uint8Array(width * height);
  const horizontalRadius = azimuth === 90 ? 0.25 : 0.43;
  for (let y = 4; y < height - 4; y += 1) {
    const normalizedY = (y / (height - 1) - 0.5) / 0.48;
    for (let x = 0; x < width; x += 1) {
      const normalizedX = (x / (width - 1) - 0.5) / horizontalRadius;
      if (normalizedX * normalizedX + normalizedY * normalizedY <= 1) mask[y * width + x] = 1;
    }
  }
  return {
    azimuth,
    width,
    height,
    mask: encodePersonMaskRLE(mask),
    normalized: true,
    quality: 0.9,
  };
}

function footClippedHullView(azimuth: number): OrientationMask {
  const width = 64;
  const height = 128;
  const mask = new Uint8Array(width * height);
  const horizontalRadius = azimuth === 90 || azimuth === 270 ? 0.25 : 0.43;
  for (let y = 4; y < height - 18; y += 1) {
    const normalizedY = (y / (height - 1) - 0.5) / 0.48;
    for (let x = 0; x < width; x += 1) {
      const normalizedX = (x / (width - 1) - 0.5) / horizontalRadius;
      if (normalizedX * normalizedX + normalizedY * normalizedY <= 1) mask[y * width + x] = 1;
    }
  }
  return {
    azimuth,
    width,
    height,
    mask: encodePersonMaskRLE(mask),
    normalized: true,
    quality: 0.84,
    partial: true,
  };
}

function meshBounds(positions: Float32Array): number[] {
  const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index += 3) {
    bounds[0] = Math.min(bounds[0], positions[index]);
    bounds[1] = Math.min(bounds[1], positions[index + 1]);
    bounds[2] = Math.min(bounds[2], positions[index + 2]);
    bounds[3] = Math.max(bounds[3], positions[index]);
    bounds[4] = Math.max(bounds[4], positions[index + 1]);
    bounds[5] = Math.max(bounds[5], positions[index + 2]);
  }
  return bounds;
}

function invalidEdgeCount(indices: Uint32Array): number {
  const counts = new Map<string, number>();
  for (let offset = 0; offset < indices.length; offset += 3) {
    const triangle = [indices[offset], indices[offset + 1], indices[offset + 2]];
    for (const [a, b] of [[triangle[0], triangle[1]], [triangle[1], triangle[2]], [triangle[2], triangle[0]]] as const) {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return Array.from(counts.values()).filter((count) => count !== 2).length;
}

function chainBandCentroid(
  lod: { positions: Float32Array; regionAndChain: Uint8Array },
  region: number,
  minimum: number,
  maximum: number,
): THREE.Vector3 | null {
  const centroid = new THREE.Vector3();
  let count = 0;
  for (let vertex = 0; vertex < lod.positions.length / 3; vertex += 1) {
    const chainT = lod.regionAndChain[vertex * 2 + 1] / 255;
    if (lod.regionAndChain[vertex * 2] !== region || chainT < minimum || chainT >= maximum) continue;
    centroid.x += lod.positions[vertex * 3];
    centroid.y += lod.positions[vertex * 3 + 1];
    centroid.z += lod.positions[vertex * 3 + 2];
    count += 1;
  }
  return count > 0 ? centroid.multiplyScalar(1 / count) : null;
}

function chainBandDepth(
  lod: { positions: Float32Array; regionAndChain: Uint8Array },
  region: number,
  minimum: number,
  maximum: number,
): number {
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let vertex = 0; vertex < lod.positions.length / 3; vertex += 1) {
    const chainT = lod.regionAndChain[vertex * 2 + 1] / 255;
    if (lod.regionAndChain[vertex * 2] !== region || chainT < minimum || chainT >= maximum) continue;
    minZ = Math.min(minZ, lod.positions[vertex * 3 + 2]);
    maxZ = Math.max(maxZ, lod.positions[vertex * 3 + 2]);
  }
  return Number.isFinite(minZ) ? maxZ - minZ : 0;
}

function chainBandProjectedSpan(
  lod: { positions: Float32Array; regionAndChain: Uint8Array },
  region: number,
  minimum: number,
  maximum: number,
  axis: THREE.Vector3,
): number {
  let minimumProjection = Infinity;
  let maximumProjection = -Infinity;
  for (let vertex = 0; vertex < lod.positions.length / 3; vertex += 1) {
    const chainT = lod.regionAndChain[vertex * 2 + 1] / 255;
    if (lod.regionAndChain[vertex * 2] !== region || chainT < minimum || chainT >= maximum) continue;
    const projection = lod.positions[vertex * 3] * axis.x
      + lod.positions[vertex * 3 + 1] * axis.y
      + lod.positions[vertex * 3 + 2] * axis.z;
    minimumProjection = Math.min(minimumProjection, projection);
    maximumProjection = Math.max(maximumProjection, projection);
  }
  return Number.isFinite(minimumProjection) ? maximumProjection - minimumProjection : 0;
}

describe("Spectral V3 anatomical body", () => {
  it("keeps the browser performance pose on the anatomical path at every LOD", () => {
    const model = buildAnatomicalGhostBody({
      landmarks: createPerformancePose("cyber", "extreme").landmarks,
      sourceHash: "browser-performance-pose",
    });
    expect(model.lods).toHaveLength(3);
    model.lods.forEach((lod, index) => {
      expect(lod.triangleCount).toBeLessThanOrEqual(SPECTRAL_BODY_LOD_TRIANGLE_BUDGETS[index]);
    });
    expect(model.quality.connectedComponents).toBe(1);
  }, 30_000);

  it("keeps adult torso, arm and leg proportions in the shared canonical rig", () => {
    const model = buildAnatomicalGhostBody({
      landmarks: standingLandmarks(),
      sourceHash: "adult-proportion-contract",
      voxelSize: 0.04,
    });
    const joints = restJointPositions(model.rig);
    const height = model.measurements.height;
    const torsoLength = Math.abs(joints[5].y - joints[11].y) / height;
    const legLength = joints[11].distanceTo(joints[13]) / height;
    const shoulderToWrist = joints[5].distanceTo(joints[7]) / height;
    const shoulderToHandEnd = shoulderToWrist + SPECTRAL_HUMAN_VOLUME_PROPORTIONS.handLengthToHeight;
    const thighLength = joints[11].distanceTo(joints[12]) / height;
    const calfLength = joints[12].distanceTo(joints[13]) / height;

    expect(SPECTRAL_HUMAN_PROPORTIONS.hipJointY).toBeGreaterThanOrEqual(0);
    expect(model.measurements.hipWidth / model.measurements.shoulderWidth).toBeGreaterThanOrEqual(0.69);
    expect(model.measurements.waistWidth / model.measurements.shoulderWidth)
      .toBeGreaterThanOrEqual(SPECTRAL_HUMAN_VOLUME_PROPORTIONS.minimumWaistToShoulder);
    expect(model.measurements.waistWidth / model.measurements.chestWidth).toBeGreaterThan(0.8);
    expect(torsoLength).toBeGreaterThanOrEqual(0.28);
    expect(torsoLength).toBeLessThanOrEqual(0.32);
    expect(legLength).toBeGreaterThanOrEqual(0.46);
    expect(legLength).toBeLessThanOrEqual(0.49);
    expect(shoulderToWrist).toBeGreaterThanOrEqual(0.33);
    expect(shoulderToWrist).toBeLessThanOrEqual(0.36);
    expect(shoulderToHandEnd).toBeGreaterThanOrEqual(0.43);
    expect(shoulderToHandEnd).toBeLessThanOrEqual(0.47);
    expect(Math.abs(thighLength - calfLength)).toBeLessThan(0.015);
    expect(legLength / torsoLength).toBeGreaterThan(1.5);
    expect(joints[5].x).toBeCloseTo(
      -model.measurements.shoulderWidth * SPECTRAL_HUMAN_LATERAL_PROPORTIONS.shoulderX,
      6,
    );
    expect(joints[6].x).toBeCloseTo(
      -model.measurements.shoulderWidth * SPECTRAL_HUMAN_LATERAL_PROPORTIONS.elbowX,
      6,
    );
    expect(joints[7].x).toBeCloseTo(
      -model.measurements.shoulderWidth * SPECTRAL_HUMAN_LATERAL_PROPORTIONS.wristX,
      6,
    );
    expect(joints[11].x).toBeCloseTo(
      -model.measurements.hipWidth * SPECTRAL_HUMAN_LATERAL_PROPORTIONS.hipX,
      6,
    );
  }, 20_000);

  it("extracts one continuous, watertight A-pose body with compact canonical attributes", () => {
    const model = buildAnatomicalGhostBody({
      landmarks: standingLandmarks(),
      sourceHash: "contract-test",
      voxelSize: 0.035,
    });
    const lod = model.lods[0];
    expect(model.algorithmVersion).toBe(SPECTRAL_BODY_ALGORITHM_VERSION);
    expect(validateGhostRigContract(model.rig)).toEqual([]);
    expect(validateGhostLodContract(lod)).toEqual([]);
    expect(model.quality).toMatchObject({
      connectedComponents: 1,
      boundaryEdges: 0,
      degenerateTriangles: 0,
      nonFiniteVertices: 0,
      flippedTriangles: 0,
    });
    expect(model.quality.normalCoherencePercent).toBeGreaterThanOrEqual(95);
    expect(lod.triangleCount).toBeGreaterThan(4_000);
    expect(lod.triangleCount).toBeLessThan(120_000);
    expect(new Set(Array.from(lod.regionAndChain.filter((_, index) => index % 2 === 0))).size).toBe(6);

    const geometry = geometryFromGhostLod(lod);
    geometry.computeBoundingBox();
    const size = new THREE.Vector3();
    geometry.boundingBox!.getSize(size);
    expect(size.y).toBeGreaterThan(1.8);
    expect(size.x).toBeGreaterThan(1.1);
    expect(size.z).toBeGreaterThan(0.25);
    geometry.dispose();
  }, 20_000);

  it("uses the production 1.45 cm field and preserves human torso/leg section topology", () => {
    const model = buildAnatomicalGhostBody({
      landmarks: standingLandmarks(),
      sourceHash: "production-grid-test",
    });
    const lod = model.lods[0];
    expect(lod.voxelSize).toBe(SPECTRAL_BODY_VOXEL_SIZE);
    expect(model.lods.map((item) => item.voxelSize)).toEqual(SPECTRAL_BODY_LOD_VOXEL_SIZES);
    model.lods.forEach((item, index) => {
      expect(item.triangleCount).toBeLessThanOrEqual(SPECTRAL_BODY_LOD_TRIANGLE_BUDGETS[index]);
      expect(invalidEdgeCount(item.indices)).toBe(0);
    });
    const primaryBounds = meshBounds(model.lods[0].positions);
    expect(Math.abs(primaryBounds[0] + primaryBounds[3])).toBeLessThan(0.03);
    expect(Math.abs(primaryBounds[2] + primaryBounds[5])).toBeLessThan(0.10);
    model.lods.slice(1).forEach((item) => {
      const bounds = meshBounds(item.positions);
      const differences = bounds.map((value, index) => Math.abs(value - primaryBounds[index]));
      expect(Math.max(...differences)).toBeLessThan(0.06);
    });
    expect(model.lods.every((item) => validateGhostLodContract(item).length === 0)).toBe(true);
    expect(model.lods[0].triangleCount).toBeGreaterThan(model.lods[1].triangleCount);
    expect(model.lods[1].triangleCount).toBeGreaterThan(model.lods[2].triangleCount);
    expect(model.lods[2].triangleCount).toBeLessThan(model.lods[0].triangleCount * 0.35);
    expect(model.quality.connectedComponents).toBe(1);
    expect(model.quality.boundaryEdges).toBe(0);
    expect(horizontalSectionComponents(lod.positions, lod.indices, 0.15, 0.28)).toBe(1);
    expect(horizontalSectionComponents(lod.positions, lod.indices, -0.52)).toBe(2);
    const height = model.measurements.height;
    const finalBounds = meshBounds(lod.positions);
    const finalHeight = finalBounds[4] - finalBounds[1];
    const finalHeightToMeasurement = finalHeight / height;
    const finalHipHeight = (SPECTRAL_HUMAN_PROPORTIONS.hipJointY * height - finalBounds[1]) / finalHeight;
    const finalShoulderHeight = (SPECTRAL_HUMAN_PROPORTIONS.shoulderY * height - finalBounds[1]) / finalHeight;
    const finalHeadHeight = (
      finalBounds[4] - height * SPECTRAL_HUMAN_PROPORTIONS.chinY
    ) / finalHeight;
    const finalHandDirection = restJointPositions(model.rig)[7]
      .clone().sub(restJointPositions(model.rig)[6]).normalize();
    const finalHandLength = chainBandProjectedSpan(
      lod,
      GHOST_BODY_REGIONS.leftArm,
      0.90,
      1.001,
      finalHandDirection,
    ) / finalHeight;
    expect(finalHeightToMeasurement).toBeGreaterThan(0.98);
    expect(finalHeightToMeasurement).toBeLessThan(1.05);
    expect(finalHipHeight).toBeGreaterThan(0.49);
    expect(finalHipHeight).toBeLessThan(0.54);
    expect(finalShoulderHeight).toBeGreaterThan(0.79);
    expect(finalShoulderHeight).toBeLessThan(0.83);
    expect(finalHeadHeight).toBeGreaterThan(0.13);
    expect(finalHeadHeight).toBeLessThan(0.155);
    expect(finalHandLength).toBeGreaterThan(0.085);
    expect(finalHandLength).toBeLessThan(0.115);
    expect(horizontalSectionComponents(lod.positions, lod.indices, height * -0.08, 0.3)).toBe(2);
    expect(horizontalSectionComponents(lod.positions, lod.indices, height * -0.15, 0.3)).toBe(2);
    expect(horizontalSectionComponents(lod.positions, lod.indices, height * SPECTRAL_HUMAN_PROPORTIONS.kneeY, 0.3)).toBe(2);

    const legAxis = new THREE.Vector3(1, 0, 0);
    const verticalAxis = new THREE.Vector3(0, 1, 0);
    const sagittalAxis = new THREE.Vector3(0, 0, 1);
    const chinWidth = horizontalSectionProjectedSpan(
      lod.positions,
      lod.indices,
      height * 0.360,
      legAxis,
    );
    const jawWidth = horizontalSectionProjectedSpan(lod.positions, lod.indices, height * 0.378, legAxis);
    const craniumWidth = horizontalSectionProjectedSpan(lod.positions, lod.indices, height * 0.435, legAxis);
    const crownWidth = horizontalSectionProjectedSpan(lod.positions, lod.indices, height * 0.475, legAxis);
    const craniumDepth = horizontalSectionProjectedSpan(lod.positions, lod.indices, height * 0.435, sagittalAxis);
    const pelvisSagittalCenter = horizontalSectionProjectedCenter(
      lod.positions,
      lod.indices,
      height * 0.035,
      sagittalAxis,
    );
    const waistSagittalCenter = horizontalSectionProjectedCenter(
      lod.positions,
      lod.indices,
      height * 0.155,
      sagittalAxis,
    );
    const chestSagittalCenter = horizontalSectionProjectedCenter(
      lod.positions,
      lod.indices,
      height * 0.215,
      sagittalAxis,
    );
    const thighCentroid = chainBandCentroid(lod, GHOST_BODY_REGIONS.leftLeg, 0.18, 0.42);
    const calfCentroid = chainBandCentroid(lod, GHOST_BODY_REGIONS.leftLeg, 0.58, 0.82);
    const upperArmCentroid = chainBandCentroid(lod, GHOST_BODY_REGIONS.leftArm, 0.16, 0.42);
    const shoulderNeckWidths = [0.286, 0.300, 0.312, 0.324, 0.338].map((heightRatio) => (
      horizontalSectionProjectedSpan(lod.positions, lod.indices, height * heightRatio, legAxis)
    ));
    expect(chinWidth / craniumWidth).toBeGreaterThan(0.5);
    expect(chinWidth / craniumWidth).toBeLessThan(0.85);
    expect(jawWidth / craniumWidth).toBeGreaterThan(0.62);
    expect(jawWidth / craniumWidth).toBeLessThan(0.94);
    expect(crownWidth / craniumWidth).toBeGreaterThan(0.55);
    expect(crownWidth / craniumWidth).toBeLessThan(0.96);
    expect(craniumDepth / craniumWidth).toBeGreaterThan(0.82);
    expect(craniumDepth / craniumWidth).toBeLessThan(1.22);
    expect(pelvisSagittalCenter).toBeLessThan(waistSagittalCenter);
    expect(waistSagittalCenter).toBeLessThan(chestSagittalCenter);
    expect((chestSagittalCenter - pelvisSagittalCenter) / height).toBeGreaterThan(0.012);
    expect((chestSagittalCenter - pelvisSagittalCenter) / height).toBeLessThan(0.03);
    expect(Math.abs(pelvisSagittalCenter) / height).toBeLessThan(0.025);
    expect(Math.abs(chestSagittalCenter) / height).toBeLessThan(0.02);
    expect(thighCentroid).not.toBeNull();
    expect(calfCentroid).not.toBeNull();
    expect(upperArmCentroid).not.toBeNull();
    expect((thighCentroid!.z - calfCentroid!.z) / height).toBeGreaterThan(0.004);
    expect((thighCentroid!.z - calfCentroid!.z) / height).toBeLessThan(0.012);
    expect(upperArmCentroid!.z / height).toBeGreaterThan(0.001);
    expect(upperArmCentroid!.z / height).toBeLessThan(0.008);
    expect(shoulderNeckWidths.every((width) => width > 0)).toBe(true);
    for (let index = 1; index < shoulderNeckWidths.length; index += 1) {
      expect(shoulderNeckWidths[index]).toBeLessThan(shoulderNeckWidths[index - 1] + height * 0.012);
    }
    const outerShoulderToHeight = shoulderNeckWidths[1] / height;
    const neckToOuterShoulder = shoulderNeckWidths[4] / shoulderNeckWidths[1];
    expect(outerShoulderToHeight).toBeGreaterThan(0.24);
    expect(outerShoulderToHeight).toBeLessThan(0.30);
    expect(neckToOuterShoulder).toBeGreaterThan(0.42);
    expect(neckToOuterShoulder).toBeLessThan(0.65);

    const kneeWidth = chainBandProjectedSpan(lod, GHOST_BODY_REGIONS.leftLeg, 0.46, 0.58, legAxis);
    const calfWidth = chainBandProjectedSpan(lod, GHOST_BODY_REGIONS.leftLeg, 0.58, 0.82, legAxis);
    const hipDepth = chainBandDepth(lod, GHOST_BODY_REGIONS.leftLeg, 0.02, 0.16);
    const thighDepth = chainBandDepth(lod, GHOST_BODY_REGIONS.leftLeg, 0.18, 0.42);
    const kneeDepth = chainBandDepth(lod, GHOST_BODY_REGIONS.leftLeg, 0.46, 0.58);
    const calfDepth = chainBandDepth(lod, GHOST_BODY_REGIONS.leftLeg, 0.58, 0.82);
    const ankleDepth = chainBandDepth(lod, GHOST_BODY_REGIONS.leftLeg, 0.84, 0.92);
    const footHeight = chainBandProjectedSpan(lod, GHOST_BODY_REGIONS.leftLeg, 0.92, 1.01, verticalAxis);
    const footLength = chainBandProjectedSpan(lod, GHOST_BODY_REGIONS.leftLeg, 0.92, 1.01, sagittalAxis);
    const footWidth = chainBandProjectedSpan(lod, GHOST_BODY_REGIONS.leftLeg, 0.92, 1.01, legAxis);
    expect(calfWidth / kneeWidth).toBeGreaterThan(0.9);
    expect(calfWidth / kneeWidth).toBeLessThan(1.12);
    expect(hipDepth / thighDepth).toBeGreaterThan(0.92);
    expect(hipDepth / thighDepth).toBeLessThan(1.15);
    expect(kneeDepth / thighDepth).toBeGreaterThan(0.78);
    expect(kneeDepth / thighDepth).toBeLessThan(1.05);
    expect(ankleDepth / calfDepth).toBeGreaterThan(0.55);
    expect(ankleDepth / calfDepth).toBeLessThan(0.78);
    expect(footLength / footHeight).toBeGreaterThan(2.7);
    expect(footLength / footHeight).toBeLessThan(3.5);
    expect(footLength / height).toBeGreaterThan(0.13);
    expect(footLength / height).toBeLessThan(0.18);
    expect(footWidth / height).toBeGreaterThan(0.05);
    expect(footWidth / height).toBeLessThan(0.09);

    const shoulder = restJointPositions(model.rig)[5];
    const armCentroids = Array.from({ length: 8 }, (_, index) => (
      chainBandCentroid(lod, GHOST_BODY_REGIONS.leftArm, index / 8, (index + 1) / 8)
    ));
    expect(armCentroids.every(Boolean)).toBe(true);
    const armDistances = armCentroids.map((point) => point!.distanceTo(shoulder));
    for (let index = 1; index < armDistances.length; index += 1) {
      expect(armDistances[index]).toBeGreaterThan(armDistances[index - 1] - 0.02);
    }
    const wristDepth = chainBandDepth(lod, GHOST_BODY_REGIONS.leftArm, 0.87, 0.91);
    const shoulderDepth = chainBandDepth(lod, GHOST_BODY_REGIONS.leftArm, 0.04, 0.14);
    const upperArmDepth = chainBandDepth(lod, GHOST_BODY_REGIONS.leftArm, 0.16, 0.42);
    const elbowDepth = chainBandDepth(lod, GHOST_BODY_REGIONS.leftArm, 0.46, 0.58);
    const forearmDepth = chainBandDepth(lod, GHOST_BODY_REGIONS.leftArm, 0.58, 0.78);
    const palmDepth = chainBandDepth(lod, GHOST_BODY_REGIONS.leftArm, 0.93, 0.965);
    const fingertipDepth = chainBandDepth(lod, GHOST_BODY_REGIONS.leftArm, 0.985, 1.001);
    const handDirection = restJointPositions(model.rig)[7].clone().sub(restJointPositions(model.rig)[6]).normalize();
    const palmLateral = new THREE.Vector3(-handDirection.y, handDirection.x, 0).normalize();
    const openPalmSpan = chainBandProjectedSpan(
      lod,
      GHOST_BODY_REGIONS.leftArm,
      0.925,
      0.986,
      palmLateral,
    );
    expect(wristDepth).toBeGreaterThan(0);
    expect(shoulderDepth / upperArmDepth).toBeGreaterThan(1.05);
    expect(shoulderDepth / upperArmDepth).toBeLessThan(1.45);
    expect(elbowDepth / upperArmDepth).toBeGreaterThan(0.82);
    expect(elbowDepth / upperArmDepth).toBeLessThan(1.08);
    expect(forearmDepth / upperArmDepth).toBeGreaterThan(0.72);
    expect(forearmDepth / upperArmDepth).toBeLessThan(0.96);
    expect(palmDepth).toBeGreaterThan(0);
    expect(palmDepth / wristDepth).toBeGreaterThan(0.55);
    expect(palmDepth).toBeLessThan(wristDepth * 0.95);
    expect(fingertipDepth / palmDepth).toBeGreaterThan(0.45);
    expect(fingertipDepth).toBeLessThan(palmDepth);
    expect(openPalmSpan / height).toBeGreaterThan(0.055);
    expect(openPalmSpan).toBeGreaterThan(palmDepth * 1.5);
  }, 30_000);

  it("smooths and fuses silhouette evidence without moving the anatomical envelope over four centimeters", () => {
    const landmarks = standingLandmarks();
    const anatomy = buildAnatomicalGhostBody({ landmarks, sourceHash: "anatomy", voxelSize: 0.04 });
    const fused = buildAnatomicalGhostBody({
      landmarks,
      orientations: [
        generousHullView(0),
        generousHullView(90),
        generousHullView(180),
        generousHullView(270),
      ],
      sourceHash: "fused",
      voxelSize: 0.04,
    });
    const anatomyBounds = meshBounds(anatomy.lods[0].positions);
    const fusedBounds = meshBounds(fused.lods[0].positions);
    const deltas = anatomyBounds.map((value, index) => Math.abs(value - fusedBounds[index]));
    expect(Math.max(...deltas)).toBeLessThanOrEqual(0.041);
    expect(Math.max(...deltas)).toBeGreaterThan(0.001);
    expect(fused.quality.connectedComponents).toBe(1);
    expect(fused.quality.boundaryEdges).toBe(0);
    const silhouetteEvidence = [
      fused.quality.frontSilhouetteIou,
      fused.quality.backSilhouetteIou,
      fused.quality.leftSilhouetteIou,
      fused.quality.rightSilhouetteIou,
    ];
    expect(silhouetteEvidence.every((iou) => iou !== undefined && iou >= 0 && iou <= 1)).toBe(true);
  }, 30_000);

  it("keeps final watertight bodies in adult proportions when width landmarks disagree with height", () => {
    for (const mode of ["tall-narrow", "short-wide"] as const) {
      const model = buildAnatomicalGhostBody({
        landmarks: measurementOutlierLandmarks(mode),
        sourceHash: `measurement-${mode}`,
        voxelSize: 0.045,
      });
      const { height, shoulderWidth, hipWidth, headDiameter } = model.measurements;
      expect(shoulderWidth / height)
        .toBeGreaterThanOrEqual(SPECTRAL_BODY_MEASUREMENT_RATIOS.shoulderToHeight.minimum - 1e-9);
      expect(shoulderWidth / height)
        .toBeLessThanOrEqual(SPECTRAL_BODY_MEASUREMENT_RATIOS.shoulderToHeight.maximum + 1e-9);
      expect(hipWidth / height)
        .toBeGreaterThanOrEqual(SPECTRAL_BODY_MEASUREMENT_RATIOS.hipToHeight.minimum - 1e-9);
      expect(hipWidth / height)
        .toBeLessThanOrEqual(SPECTRAL_BODY_MEASUREMENT_RATIOS.hipToHeight.maximum + 1e-9);
      expect(headDiameter / height)
        .toBeGreaterThanOrEqual(SPECTRAL_BODY_MEASUREMENT_RATIOS.headToHeight.minimum - 1e-9);
      expect(headDiameter / height)
        .toBeLessThanOrEqual(SPECTRAL_BODY_MEASUREMENT_RATIOS.headToHeight.maximum + 1e-9);
      const finalBounds = meshBounds(model.lods[0].positions);
      expect((finalBounds[4] - finalBounds[1]) / height).toBeGreaterThan(0.98);
      expect((finalBounds[4] - finalBounds[1]) / height).toBeLessThan(1.05);
      const shoulderSpan = horizontalSectionProjectedSpan(
        model.lods[0].positions,
        model.lods[0].indices,
        height * 0.30,
        new THREE.Vector3(1, 0, 0),
      );
      expect(shoulderSpan / height).toBeGreaterThan(0.22);
      expect(shoulderSpan / height).toBeLessThan(0.31);
      expect(model.quality).toMatchObject({
        connectedComponents: 1,
        boundaryEdges: 0,
        degenerateTriangles: 0,
        nonFiniteVertices: 0,
        flippedTriangles: 0,
      });
    }
  }, 30_000);

  it("keeps heels attached when imported photos clip the bottom of both feet", () => {
    const model = buildAnatomicalGhostBody({
      landmarks: standingLandmarks(),
      orientations: [0, 90, 180, 270].map(footClippedHullView),
      sourceHash: "foot-clipped-fusion",
    });
    expect(model.quality.connectedComponents).toBe(1);
    expect(model.quality.boundaryEdges).toBe(0);
    expect(model.quality.degenerateTriangles).toBe(0);
    model.lods.forEach((lod) => expect(invalidEdgeCount(lod.indices)).toBe(0));
  }, 30_000);
});
