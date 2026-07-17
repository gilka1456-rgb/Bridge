import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { Landmark } from "../models/types";
import { buildAnatomicalGhostBody, geometryFromGhostLod } from "./anatomical-body";
import {
  createSpectralRuntimePose,
  createSpectralSkinnedMesh,
  SPECTRAL_RUNTIME_SKINNING_VERSION,
} from "./spectral-skinned-mesh";

function landmarks(extreme = false): Landmark[] {
  const result = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0 }));
  const set = (index: number, x: number, y: number) => {
    result[index] = { x, y, z: 0, visibility: 1 };
  };
  set(0, 0, -0.43);
  set(7, -0.045, -0.4);
  set(8, 0.045, -0.4);
  set(11, -0.13, -0.28);
  set(12, 0.13, -0.28);
  set(13, extreme ? -0.22 : -0.2, extreme ? -0.44 : -0.03);
  set(14, 0.2, -0.03);
  set(15, extreme ? -0.16 : -0.2, extreme ? -0.62 : 0.19);
  set(16, 0.2, 0.19);
  set(23, -0.09, 0.08);
  set(24, 0.09, 0.08);
  set(25, -0.085, 0.3);
  set(26, 0.085, 0.3);
  set(27, -0.08, 0.51);
  set(28, 0.08, 0.51);
  return result;
}

describe("Spectral V4 runtime SkinnedMesh", () => {
  it("binds the fixed 17-bone rig to compact skin attributes", () => {
    const model = buildAnatomicalGhostBody({ landmarks: landmarks(), sourceHash: "skinned", voxelSize: 0.04 });
    const geometry = geometryFromGhostLod(model.lods[0]);
    const mesh = createSpectralSkinnedMesh(geometry, new THREE.MeshBasicMaterial(), model.rig);
    expect(mesh).toBeInstanceOf(THREE.SkinnedMesh);
    expect(mesh.skeleton.bones).toHaveLength(17);
    expect(mesh.skeleton.boneInverses).toHaveLength(17);
    expect(mesh.userData.spectralRuntimeSkinning).toBe(SPECTRAL_RUNTIME_SKINNING_VERSION);
    expect(geometry.getAttribute("skinIndex").itemSize).toBe(4);
    expect(geometry.getAttribute("skinWeight").normalized).toBe(true);
  }, 20_000);

  it("produces stable rest and target joints for a runtime pose", () => {
    const model = buildAnatomicalGhostBody({ landmarks: landmarks(), sourceHash: "pose", voxelSize: 0.04 });
    const pose = createSpectralRuntimePose(model.rig, landmarks(true));
    expect(pose.restJoints).toHaveLength(17);
    expect(pose.targetJoints).toHaveLength(17);
    expect(pose.targetJoints[7].y).toBeGreaterThan(pose.restJoints[7].y);
    expect(pose.targetJoints.every((joint) => Number.isFinite(joint.lengthSq()))).toBe(true);
  }, 20_000);
});
