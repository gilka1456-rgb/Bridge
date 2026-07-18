import * as THREE from "three";
import type { Landmark } from "../models/types";
import { GHOST_RIG_BONE_NAMES, type GhostRig } from "./body-model";
import { buildPoseMatrices, handEndpointPositions, restJointPositions, targetJointPositions } from "./body-skinning";

export const SPECTRAL_RUNTIME_SKINNING_VERSION = "arm-chain-sweep-gpu-v11-continuous-joint-frame" as const;

export interface SpectralRuntimePose {
  restJoints: THREE.Vector3[];
  targetJoints: THREE.Vector3[];
  restHandEnds: [THREE.Vector3, THREE.Vector3];
  targetHandEnds: [THREE.Vector3, THREE.Vector3];
  restHandLaterals: [THREE.Vector3, THREE.Vector3];
  targetHandLaterals: [THREE.Vector3, THREE.Vector3];
  poseMatrices: THREE.Matrix4[];
}

export function createSpectralRuntimePose(rig: GhostRig, landmarks: Landmark[]): SpectralRuntimePose {
  const restJoints = restJointPositions(rig);
  const targetJoints = targetJointPositions(landmarks, restJoints);
  const hands = handEndpointPositions(landmarks, restJoints, targetJoints);
  return {
    restJoints,
    targetJoints,
    restHandEnds: hands.rest,
    targetHandEnds: hands.target,
    restHandLaterals: hands.restLateral,
    targetHandLaterals: hands.targetLateral,
    poseMatrices: buildPoseMatrices(rig, landmarks),
  };
}

export function createGhostSkeleton(rig: GhostRig): THREE.Skeleton {
  const bones = GHOST_RIG_BONE_NAMES.map((name, index) => {
    const bone = new THREE.Bone();
    bone.name = name;
    bone.position.fromArray(rig.restTranslations, index * 3);
    bone.quaternion.fromArray(rig.restRotations, index * 4);
    return bone;
  });
  bones.forEach((bone, index) => {
    const parent = rig.parentIndices[index];
    if (parent >= 0) bones[parent].add(bone);
  });
  const inverses = GHOST_RIG_BONE_NAMES.map((_, index) => (
    new THREE.Matrix4().fromArray(rig.inverseBindMatrices, index * 16)
  ));
  return new THREE.Skeleton(bones, inverses);
}

export function createSpectralSkinnedMesh(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  rig: GhostRig,
): THREE.SkinnedMesh {
  if (!geometry.getAttribute("skinIndex") || !geometry.getAttribute("skinWeight")) {
    throw new Error("Spectral runtime skinning requires four-index and four-weight attributes.");
  }
  const mesh = new THREE.SkinnedMesh(geometry, material);
  const skeleton = createGhostSkeleton(rig);
  mesh.add(skeleton.bones[0]);
  mesh.bind(skeleton, new THREE.Matrix4());
  mesh.userData.spectralRuntimeSkinning = SPECTRAL_RUNTIME_SKINNING_VERSION;
  return mesh;
}
