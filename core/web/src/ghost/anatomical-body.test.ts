import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { Landmark, OrientationMask } from "../models/types";
import { encodePersonMaskRLE } from "../pose/segmentation";
import { validateGhostLodContract, validateGhostRigContract } from "./body-model";
import {
  buildAnatomicalGhostBody,
  geometryFromGhostLod,
  SPECTRAL_BODY_ALGORITHM_VERSION,
  SPECTRAL_BODY_LOD_TRIANGLE_BUDGETS,
  SPECTRAL_BODY_LOD_VOXEL_SIZES,
  SPECTRAL_BODY_VOXEL_SIZE,
  SPECTRAL_HUMAN_PROPORTIONS,
} from "./anatomical-body";
import { restJointPositions } from "./body-skinning";
import { createPerformancePose } from "./performance-probe";

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
    const armLength = joints[5].distanceTo(joints[7]) / height;

    expect(SPECTRAL_HUMAN_PROPORTIONS.hipJointY).toBeGreaterThanOrEqual(0);
    expect(torsoLength).toBeGreaterThanOrEqual(0.28);
    expect(torsoLength).toBeLessThanOrEqual(0.32);
    expect(legLength).toBeGreaterThanOrEqual(0.46);
    expect(legLength).toBeLessThanOrEqual(0.49);
    expect(armLength).toBeGreaterThanOrEqual(0.39);
    expect(armLength).toBeLessThanOrEqual(0.43);
    expect(legLength / torsoLength).toBeGreaterThan(1.45);
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
    expect(model.quality).toEqual({
      connectedComponents: 1,
      boundaryEdges: 0,
      degenerateTriangles: 0,
    });
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

  it("uses the production 1.8 cm field and preserves human torso/leg section topology", () => {
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
    model.lods.slice(1).forEach((item) => {
      const bounds = meshBounds(item.positions);
      expect(Math.max(...bounds.map((value, index) => Math.abs(value - primaryBounds[index])))).toBeLessThan(0.055);
    });
    expect(model.lods.every((item) => validateGhostLodContract(item).length === 0)).toBe(true);
    expect(model.lods[0].triangleCount).toBeGreaterThan(model.lods[1].triangleCount);
    expect(model.lods[1].triangleCount).toBeGreaterThan(model.lods[2].triangleCount);
    expect(model.lods[2].triangleCount).toBeLessThan(model.lods[0].triangleCount * 0.35);
    expect(model.quality.connectedComponents).toBe(1);
    expect(model.quality.boundaryEdges).toBe(0);
    expect(horizontalSectionComponents(lod.positions, lod.indices, 0.15, 0.4)).toBe(1);
    expect(horizontalSectionComponents(lod.positions, lod.indices, -0.52)).toBe(2);
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
  }, 30_000);
});
