import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { Landmark } from "../models/types";
import { buildAnatomicalGhostBody } from "./anatomical-body";
import { GHOST_BODY_REGIONS } from "./body-model";
import {
  bakeGhostLodPose,
  buildPoseMatrices,
  handEndpointPositions,
  restJointPositions,
  SPECTRAL_BONE_LENGTH_SCALE_RANGE,
  targetJointPositions,
} from "./body-skinning";

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

function extremePose(): Landmark[] {
  const landmarks = standingLandmarks();
  landmarks[13] = { x: -0.22, y: -0.44, z: 0, visibility: 1 };
  landmarks[15] = { x: -0.16, y: -0.62, z: 0, visibility: 1 };
  landmarks[14] = { x: 0.25, y: -0.12, z: -0.04, visibility: 1 };
  landmarks[16] = { x: 0.13, y: -0.28, z: -0.08, visibility: 1 };
  landmarks[25] = { x: -0.16, y: 0.31, z: 0, visibility: 1 };
  landmarks[26] = { x: 0.16, y: 0.31, z: 0, visibility: 1 };
  landmarks[27] = { x: -0.22, y: 0.52, z: 0, visibility: 1 };
  landmarks[28] = { x: 0.22, y: 0.52, z: 0, visibility: 1 };
  landmarks[17] = { x: -0.16, y: -0.76, z: 0, visibility: 1 };
  landmarks[19] = { x: -0.15, y: -0.79, z: 0, visibility: 1 };
  landmarks[21] = { x: -0.14, y: -0.75, z: 0, visibility: 1 };
  return landmarks;
}

function degenerateTriangleCount(positions: Float32Array, indices: Uint32Array): number {
  let count = 0;
  for (let index = 0; index < indices.length; index += 3) {
    const a = indices[index] * 3;
    const b = indices[index + 1] * 3;
    const c = indices[index + 2] * 3;
    const ab = new THREE.Vector3(
      positions[b] - positions[a],
      positions[b + 1] - positions[a + 1],
      positions[b + 2] - positions[a + 2],
    );
    const ac = new THREE.Vector3(
      positions[c] - positions[a],
      positions[c + 1] - positions[a + 1],
      positions[c + 2] - positions[a + 2],
    );
    if (ab.cross(ac).lengthSq() < 1e-12) count += 1;
  }
  return count;
}

describe("Spectral V3 body skinning", () => {
  it("keeps observed torso and leg targets connected inside adult proportions", () => {
    const model = buildAnatomicalGhostBody({
      landmarks: standingLandmarks(),
      sourceHash: "bounded-target-proportions",
      voxelSize: 0.04,
    });
    const rest = restJointPositions(model.rig);
    const target = targetJointPositions(standingLandmarks(), rest);
    const shoulderCenter = target[5].clone().lerp(target[8], 0.5);
    const hipCenter = target[11].clone().lerp(target[14], 0.5);
    const ankleCenter = target[13].clone().lerp(target[16], 0.5);
    const torsoLength = shoulderCenter.distanceTo(hipCenter);
    const legLength = hipCenter.distanceTo(ankleCenter);

    expect(target[0].y).toBeGreaterThan(hipCenter.y);
    expect(torsoLength / legLength).toBeGreaterThan(0.5);
    expect(torsoLength / legLength).toBeLessThan(0.8);
    expect(target[1].y).toBeGreaterThan(target[0].y);
    expect(target[2].y).toBeGreaterThan(target[1].y);
  }, 20_000);

  it("maps bone endpoints toward observed lengths with a bounded axial scale", () => {
    const model = buildAnatomicalGhostBody({
      landmarks: standingLandmarks(),
      sourceHash: "bounded-length-pose",
      voxelSize: 0.04,
    });
    const pose = extremePose();
    const rest = restJointPositions(model.rig);
    const target = targetJointPositions(pose, rest);
    const matrices = buildPoseMatrices(model.rig, pose);
    const mappedElbow = rest[6].clone().applyMatrix4(matrices[5]);
    const rawRatio = target[5].distanceTo(target[6]) / rest[5].distanceTo(rest[6]);
    const expectedRatio = THREE.MathUtils.clamp(
      rawRatio,
      SPECTRAL_BONE_LENGTH_SCALE_RANGE[0],
      SPECTRAL_BONE_LENGTH_SCALE_RANGE[1],
    );

    expect(mappedElbow.distanceTo(target[5]) / rest[5].distanceTo(rest[6])).toBeCloseTo(expectedRatio, 5);
    expect(mappedElbow.distanceTo(target[6])).toBeLessThan(0.01);
  }, 20_000);

  it("ignores arbitrary photo framing offsets and anchors the pose to the canonical pelvis", () => {
    const model = buildAnatomicalGhostBody({
      landmarks: standingLandmarks(),
      sourceHash: "pelvis-anchor-invariance",
      voxelSize: 0.04,
    });
    const rest = restJointPositions(model.rig);
    const base = standingLandmarks();
    const shifted = base.map((point) => ({
      ...point,
      x: point.x + 0.31,
      y: point.y - 0.27,
      z: point.z + 0.14,
    }));
    const baseTargets = targetJointPositions(base, rest);
    const shiftedTargets = targetJointPositions(shifted, rest);
    shiftedTargets.forEach((joint, index) => {
      expect(joint.distanceTo(baseTargets[index])).toBeLessThan(1e-6);
    });
  }, 20_000);

  it("uses palm landmarks to steer a raised hand independently from its forearm", () => {
    const model = buildAnatomicalGhostBody({
      landmarks: standingLandmarks(),
      sourceHash: "palm-directed-hand",
      voxelSize: 0.04,
    });
    const pose = extremePose();
    const rest = restJointPositions(model.rig);
    const target = targetJointPositions(pose, rest);
    const hands = handEndpointPositions(pose, rest, target);
    const forearmDirection = target[7].clone().sub(target[6]).normalize();
    const handDirection = hands.target[0].clone().sub(target[7]).normalize();

    expect(handDirection.y).toBeGreaterThan(0.95);
    expect(handDirection.angleTo(forearmDirection)).toBeGreaterThan(0.2);
  }, 20_000);

  it("assigns smoothed four-bone weights and bounds raised-arm seam stretch", () => {
    const model = buildAnatomicalGhostBody({
      landmarks: standingLandmarks(),
      sourceHash: "skin-weights",
      voxelSize: 0.04,
    });
    const lod = model.lods[0];
    let protectedArmpitVertices = 0;
    let stableTorsoVertices = 0;
    for (let vertex = 0; vertex < lod.vertexCount; vertex += 1) {
      const weights = Array.from(lod.skinWeights.slice(vertex * 4, vertex * 4 + 4));
      const indices = Array.from(lod.skinIndices.slice(vertex * 4, vertex * 4 + 4));
      expect(weights.reduce((sum, value) => sum + value, 0)).toBe(255);
      expect(Math.max(...indices)).toBeLessThan(17);
      const region = lod.regionAndChain[vertex * 2];
      const chainT = lod.regionAndChain[vertex * 2 + 1] / 255;
      if ((region === GHOST_BODY_REGIONS.leftArm || region === GHOST_BODY_REGIONS.rightArm) && chainT < 0.12) {
        const chestSlot = indices.indexOf(2);
        if (chestSlot >= 0 && weights[chestSlot] >= 16) protectedArmpitVertices += 1;
      }
      if (region === GHOST_BODY_REGIONS.core) {
        const corePalette = indices.every((bone) => bone >= 0 && bone <= 3);
        const leftShoulderPalette = indices.includes(5)
          && indices.every((bone) => [1, 2, 3, 5].includes(bone));
        const rightShoulderPalette = indices.includes(8)
          && indices.every((bone) => [1, 2, 3, 8].includes(bone));
        expect(corePalette || leftShoulderPalette || rightShoulderPalette).toBe(true);
        stableTorsoVertices += 1;
      }
    }
    expect(protectedArmpitVertices).toBeGreaterThan(0);
    expect(stableTorsoVertices).toBeGreaterThan(0);

    const seamBaked = bakeGhostLodPose(lod, model.rig, extremePose());
    let maximumSeamStretch = 0;
    for (let index = 0; index < lod.indices.length; index += 3) {
      const vertices = [lod.indices[index], lod.indices[index + 1], lod.indices[index + 2]];
      const regions = vertices.map((vertex) => lod.regionAndChain[vertex * 2]);
      if (!regions.includes(GHOST_BODY_REGIONS.core)
        || !regions.some((region) => region === GHOST_BODY_REGIONS.leftArm || region === GHOST_BODY_REGIONS.rightArm)) continue;
      for (const [aSlot, bSlot] of [[0, 1], [1, 2], [2, 0]] as const) {
        const a = vertices[aSlot];
        const b = vertices[bSlot];
        if (regions[aSlot] === regions[bSlot]) continue;
        const restLength = new THREE.Vector3().fromArray(lod.positions, a * 3)
          .distanceTo(new THREE.Vector3().fromArray(lod.positions, b * 3));
        const posedLength = new THREE.Vector3().fromArray(seamBaked.positions, a * 3)
          .distanceTo(new THREE.Vector3().fromArray(seamBaked.positions, b * 3));
        const stretch = posedLength / Math.max(restLength, 1e-6);
        maximumSeamStretch = Math.max(maximumSeamStretch, stretch);
      }
    }
    expect(maximumSeamStretch).toBeLessThan(2.7);
  }, 30_000);

  it("bakes raised arms, bent elbows and separated legs without NaN or collapsed faces", () => {
    const model = buildAnatomicalGhostBody({
      landmarks: standingLandmarks(),
      sourceHash: "pose-bake",
      voxelSize: 0.04,
    });
    const baked = bakeGhostLodPose(model.lods[0], model.rig, extremePose());
    expect([...baked.positions].every(Number.isFinite)).toBe(true);
    expect([...baked.normals].every(Number.isFinite)).toBe(true);
    expect(degenerateTriangleCount(baked.positions, baked.indices)).toBe(0);
    expect(baked.indices).toEqual(model.lods[0].indices);

    let raisedHandY = -Infinity;
    let leftFootX = Infinity;
    let rightFootX = -Infinity;
    for (let vertex = 0; vertex < baked.vertexCount; vertex += 1) {
      const region = baked.regionAndChain[vertex * 2];
      const chainT = baked.regionAndChain[vertex * 2 + 1] / 255;
      if (region === GHOST_BODY_REGIONS.leftArm && chainT > 0.9) {
        raisedHandY = Math.max(raisedHandY, baked.positions[vertex * 3 + 1]);
      }
      if (region === GHOST_BODY_REGIONS.leftLeg && chainT > 0.85) {
        leftFootX = Math.min(leftFootX, baked.positions[vertex * 3]);
      }
      if (region === GHOST_BODY_REGIONS.rightLeg && chainT > 0.85) {
        rightFootX = Math.max(rightFootX, baked.positions[vertex * 3]);
      }
    }
    expect(raisedHandY).toBeGreaterThan(1.35);
    expect(rightFootX - leftFootX).toBeGreaterThan(0.7);
  }, 30_000);
});
