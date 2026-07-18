import * as THREE from "three";
import type { Landmark } from "../models/types";
import { GHOST_BODY_REGIONS, type GhostLodMesh, type GhostRig } from "./body-model";

const VISIBILITY_MIN = 0.35;
const GHOST_SCALE_X = 2.2;
const GHOST_SCALE_Y = 2.4;
const GHOST_SCALE_Z = 2.2;
const GHOST_FLOOR_OFFSET = -0.1;

export const SPECTRAL_SKINNING_ALGORITHM_VERSION = "linear-blend-bake-v14-stable-torso-palette";
export const SPECTRAL_BONE_LENGTH_SCALE_RANGE = [0.92, 1.08] as const;

const CHILD_BONES = [1, 2, 3, 4, -1, 6, 7, -1, 9, 10, -1, 12, 13, -1, 15, 16, -1] as const;
const TARGET_PARENT_BONES = [-1, 0, 1, 2, 3, 2, 5, 6, 2, 8, 9, 0, 11, 12, 0, 14, 15] as const;

export interface SkinInfluenceSet {
  indices: [number, number, number, number];
  weights: [number, number, number, number];
}

function landmarkVector(landmark: Landmark): THREE.Vector3 {
  return new THREE.Vector3(
    landmark.x * GHOST_SCALE_X,
    -landmark.y * GHOST_SCALE_Y + GHOST_FLOOR_OFFSET,
    -landmark.z * GHOST_SCALE_Z,
  );
}

function visibleLandmark(landmarks: Landmark[], index: number): THREE.Vector3 | null {
  const point = landmarks[index];
  return point && point.visibility >= VISIBILITY_MIN ? landmarkVector(point) : null;
}

function midpoint(a: THREE.Vector3, b: THREE.Vector3): THREE.Vector3 {
  return a.clone().add(b).multiplyScalar(0.5);
}

function visibleCentroid(landmarks: Landmark[], indices: readonly number[]): THREE.Vector3 | null {
  const points = indices
    .map((index) => visibleLandmark(landmarks, index))
    .filter((point): point is THREE.Vector3 => point !== null);
  if (points.length === 0) return null;
  return points.reduce((sum, point) => sum.add(point), new THREE.Vector3()).multiplyScalar(1 / points.length);
}

export function restJointPositions(rig: GhostRig): THREE.Vector3[] {
  const joints: THREE.Vector3[] = [];
  const inverseBind = new THREE.Matrix4();
  for (let index = 0; index < rig.parentIndices.length; index += 1) {
    inverseBind.fromArray(rig.inverseBindMatrices, index * 16).invert();
    joints.push(new THREE.Vector3().setFromMatrixPosition(inverseBind));
  }
  return joints;
}

function distanceSquaredToBone(position: THREE.Vector3, bone: number, joints: THREE.Vector3[]): number {
  const start = joints[bone];
  const child = CHILD_BONES[bone];
  if (child < 0) return position.distanceToSquared(start);
  const end = joints[child];
  const segment = end.clone().sub(start);
  const lengthSquared = segment.lengthSq();
  if (lengthSquared < 1e-9) return position.distanceToSquared(start);
  const t = Math.max(0, Math.min(1, position.clone().sub(start).dot(segment) / lengthSquared));
  return position.distanceToSquared(start.clone().addScaledVector(segment, t));
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - edge0) / Math.max(edge1 - edge0, 1e-6)));
  return t * t * (3 - 2 * t);
}

function boneAffinity(region: number, chainT: number, bone: number, position: THREE.Vector3): number {
  const core = bone >= 0 && bone <= 4;
  const leftArm = bone >= 5 && bone <= 7;
  const rightArm = bone >= 8 && bone <= 10;
  const leftLeg = bone >= 11 && bone <= 13;
  const rightLeg = bone >= 14 && bone <= 16;
  switch (region) {
    case GHOST_BODY_REGIONS.head:
      if (bone === 4 || bone === 3) return 1;
      if (bone === 2 || bone === 1) return 0.3;
      return 0.001;
    case GHOST_BODY_REGIONS.leftArm:
      if (leftArm) return 1;
      if (bone === 2) return 0.08 + (1 - smoothstep(0.05, 0.32, chainT)) * 1.5;
      if (bone === 3 || bone === 1) return 0.04;
      return 0.001;
    case GHOST_BODY_REGIONS.rightArm:
      if (rightArm) return 1;
      if (bone === 2) return 0.08 + (1 - smoothstep(0.05, 0.32, chainT)) * 1.5;
      if (bone === 3 || bone === 1) return 0.04;
      return 0.001;
    case GHOST_BODY_REGIONS.leftLeg:
      if (leftLeg) return 1;
      if (bone === 0) return 0.08 + (1 - smoothstep(0.04, 0.3, chainT)) * 1.7;
      if (bone === 1) return 0.035;
      return 0.001;
    case GHOST_BODY_REGIONS.rightLeg:
      if (rightLeg) return 1;
      if (bone === 0) return 0.08 + (1 - smoothstep(0.04, 0.3, chainT)) * 1.7;
      if (bone === 1) return 0.035;
      return 0.001;
    default: {
      if (core) return 1;
      const sideMatch = (position.x < 0 && (leftArm || leftLeg))
        || (position.x >= 0 && (rightArm || rightLeg));
      if ((bone === 5 || bone === 8) && position.y > 0.2) {
        return (sideMatch ? 0.9 : 0.08) * smoothstep(0.2, 0.52, position.y);
      }
      if ((bone === 11 || bone === 14) && position.y < 0.02) {
        return (sideMatch ? 0.9 : 0.08) * (1 - smoothstep(-0.28, 0.02, position.y));
      }
      return 0.001;
    }
  }
}

function attachmentDistanceSquared(
  position: THREE.Vector3,
  region: number,
  chainT: number,
  bone: number,
  joints: THREE.Vector3[],
): number {
  const measured = distanceSquaredToBone(position, bone, joints);
  const armRegion = region === GHOST_BODY_REGIONS.leftArm || region === GHOST_BODY_REGIONS.rightArm;
  if (armRegion && bone === 2) {
    const protectedDistance = 0.018 + chainT * 0.24;
    return Math.min(measured, protectedDistance * protectedDistance);
  }
  const legRegion = region === GHOST_BODY_REGIONS.leftLeg || region === GHOST_BODY_REGIONS.rightLeg;
  if (legRegion && bone === 0) {
    const protectedDistance = 0.015 + chainT * 0.2;
    return Math.min(measured, protectedDistance * protectedDistance);
  }
  return measured;
}

export function computeSkinInfluences(
  position: THREE.Vector3,
  region: number,
  chainT: number,
  joints: THREE.Vector3[],
): SkinInfluenceSet {
  const ranked = joints.map((_, bone) => ({
    bone,
    score: boneAffinity(region, chainT, bone, position)
      / (attachmentDistanceSquared(position, region, chainT, bone, joints) + 0.0036),
  })).sort((a, b) => b.score - a.score).slice(0, 4);
  while (ranked.length < 4) ranked.push({ bone: 0, score: 0 });
  const total = ranked.reduce((sum, item) => sum + item.score, 0) || 1;
  return {
    indices: ranked.map((item) => item.bone) as SkinInfluenceSet["indices"],
    weights: ranked.map((item) => item.score / total) as SkinInfluenceSet["weights"],
  };
}

export function quantizeSkinWeights(weights: SkinInfluenceSet["weights"]): [number, number, number, number] {
  const normalizedTotal = weights.reduce((sum, value) => sum + Math.max(0, value), 0) || 1;
  const exact = weights.map((value) => Math.max(0, value) / normalizedTotal * 255);
  const quantized = exact.map(Math.floor);
  let remainder = 255 - quantized.reduce((sum, value) => sum + value, 0);
  const order = exact.map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction);
  for (let index = 0; index < remainder; index += 1) quantized[order[index].index] += 1;
  remainder = 255 - quantized.reduce((sum, value) => sum + value, 0);
  if (remainder !== 0) quantized[0] += remainder;
  return quantized as [number, number, number, number];
}

export function assignProgrammaticSkinWeights(lod: GhostLodMesh, rig: GhostRig): void {
  const joints = restJointPositions(rig);
  const position = new THREE.Vector3();
  for (let vertex = 0; vertex < lod.vertexCount; vertex += 1) {
    position.fromArray(lod.positions, vertex * 3);
    const region = lod.regionAndChain[vertex * 2];
    const chainT = lod.regionAndChain[vertex * 2 + 1] / 255;
    const influences = computeSkinInfluences(position, region, chainT, joints);
    const weights = quantizeSkinWeights(influences.weights);
    lod.skinIndices.set(influences.indices, vertex * 4);
    lod.skinWeights.set(weights, vertex * 4);
  }
  smoothProgrammaticSkinWeights(lod, 18, 0.5);
}

function smoothProgrammaticSkinWeights(lod: GhostLodMesh, passes: number, blend: number): void {
  const boneCount = 17;
  const adjacency = Array.from({ length: lod.vertexCount }, () => new Set<number>());
  for (let index = 0; index < lod.indices.length; index += 3) {
    const a = lod.indices[index];
    const b = lod.indices[index + 1];
    const c = lod.indices[index + 2];
    adjacency[a].add(b).add(c);
    adjacency[b].add(a).add(c);
    adjacency[c].add(a).add(b);
  }
  let dense = new Float32Array(lod.vertexCount * boneCount);
  for (let vertex = 0; vertex < lod.vertexCount; vertex += 1) {
    for (let influence = 0; influence < 4; influence += 1) {
      const bone = lod.skinIndices[vertex * 4 + influence];
      dense[vertex * boneCount + bone] += lod.skinWeights[vertex * 4 + influence] / 255;
    }
  }
  const mix = Math.max(0, Math.min(1, blend));
  for (let pass = 0; pass < passes; pass += 1) {
    const next = dense.slice();
    for (let vertex = 0; vertex < lod.vertexCount; vertex += 1) {
      const neighbors = adjacency[vertex];
      if (neighbors.size === 0) continue;
      for (let bone = 0; bone < boneCount; bone += 1) {
        let average = 0;
        neighbors.forEach((neighbor) => {
          average += dense[neighbor * boneCount + bone];
        });
        average /= neighbors.size;
        next[vertex * boneCount + bone] = dense[vertex * boneCount + bone] * (1 - mix) + average * mix;
      }
    }
    dense = next;
  }
  for (let vertex = 0; vertex < lod.vertexCount; vertex += 1) {
    const region = lod.regionAndChain[vertex * 2];
    const chainT = lod.regionAndChain[vertex * 2 + 1] / 255;
    const leftArmShoulder = region === GHOST_BODY_REGIONS.leftArm && chainT < 0.38;
    const rightArmShoulder = region === GHOST_BODY_REGIONS.rightArm && chainT < 0.38;
    const leftCoreShoulder = region === GHOST_BODY_REGIONS.core
      && dense[vertex * boneCount + 5] > 0.015
      && dense[vertex * boneCount + 5] >= dense[vertex * boneCount + 8];
    const rightCoreShoulder = region === GHOST_BODY_REGIONS.core
      && dense[vertex * boneCount + 8] > 0.015
      && dense[vertex * boneCount + 8] > dense[vertex * boneCount + 5];
    // Dense smoothing keeps weights continuous, but independently truncating
    // every vertex to four bones can still swap pelvis for forearm across one
    // shoulder edge. Use one shared palette through the shoulder cap and upper
    // arm; the forearm enters later, well before the elbow bend.
    const candidateBones = leftArmShoulder || leftCoreShoulder
      ? [5, 2, 1, 3]
      : rightArmShoulder || rightCoreShoulder
        ? [8, 2, 1, 3]
        : region === GHOST_BODY_REGIONS.core
          ? [0, 1, 2, 3]
        : Array.from({ length: boneCount }, (_, bone) => bone);
    const ranked = candidateBones.map((bone) => ({
      bone,
      weight: dense[vertex * boneCount + bone],
    })).sort((a, b) => b.weight - a.weight).slice(0, 4);
    const total = ranked.reduce((sum, item) => sum + item.weight, 0) || 1;
    const weights = quantizeSkinWeights(ranked.map((item) => item.weight / total) as SkinInfluenceSet["weights"]);
    lod.skinIndices.set(ranked.map((item) => item.bone), vertex * 4);
    lod.skinWeights.set(weights, vertex * 4);
  }
}

export function targetJointPositions(landmarks: Landmark[], rest: THREE.Vector3[]): THREE.Vector3[] {
  const observedLeftShoulder = visibleLandmark(landmarks, 11);
  const observedRightShoulder = visibleLandmark(landmarks, 12);
  const observedLeftHip = visibleLandmark(landmarks, 23);
  const observedRightHip = visibleLandmark(landmarks, 24);
  const observedShoulderCenter = observedLeftShoulder && observedRightShoulder
    ? midpoint(observedLeftShoulder, observedRightShoulder)
    : null;
  const observedPelvis = observedLeftHip && observedRightHip
    ? midpoint(observedLeftHip, observedRightHip)
    : null;
  const restShoulderCenter = midpoint(rest[5], rest[8]);
  const restHipCenter = midpoint(rest[11], rest[14]);
  const alignment = observedPelvis
    ? restHipCenter.clone().sub(observedPelvis)
    : observedShoulderCenter
      ? restShoulderCenter.clone().sub(observedShoulderCenter)
      : new THREE.Vector3();
  const aligned = (point: THREE.Vector3 | null) => point?.clone().add(alignment) ?? null;
  const leftShoulder = aligned(observedLeftShoulder);
  const rightShoulder = aligned(observedRightShoulder);
  const leftHip = aligned(observedLeftHip);
  const rightHip = aligned(observedRightHip);
  const shoulderCenter = leftShoulder && rightShoulder ? midpoint(leftShoulder, rightShoulder) : null;
  const pelvis = leftHip && rightHip ? midpoint(leftHip, rightHip) : null;
  const leftEar = aligned(visibleLandmark(landmarks, 7));
  const rightEar = aligned(visibleLandmark(landmarks, 8));
  const nose = aligned(visibleLandmark(landmarks, 0));
  const head = leftEar && rightEar ? midpoint(leftEar, rightEar) : nose;
  const fallback = (index: number) => rest[index].clone();
  const resolvedHipCenter = pelvis ?? fallback(11).clone().lerp(fallback(14), 0.5);
  const resolvedShoulderCenter = shoulderCenter ?? fallback(5).clone().lerp(fallback(8), 0.5);
  const resolvedHead = head ?? fallback(4);
  const torsoAxis = resolvedShoulderCenter.clone().sub(resolvedHipCenter);
  if (torsoAxis.lengthSq() < 1e-8) torsoAxis.set(0, 1, 0);
  const shoulderToHead = resolvedHead.clone().sub(resolvedShoulderCenter);
  const resolvedPelvis = resolvedHipCenter.clone().addScaledVector(torsoAxis, 1 / 6);
  const spine = resolvedHipCenter.clone().addScaledVector(torsoAxis, 1 / 3);
  const resolvedChest = resolvedHipCenter.clone().addScaledVector(torsoAxis, 11 / 15);
  const neck = resolvedShoulderCenter.clone().addScaledVector(shoulderToHead, 0.25);
  const raw = [
    resolvedPelvis,
    spine,
    resolvedChest,
    neck,
    resolvedHead,
    leftShoulder ?? fallback(5),
    aligned(visibleLandmark(landmarks, 13)) ?? fallback(6),
    aligned(visibleLandmark(landmarks, 15)) ?? fallback(7),
    rightShoulder ?? fallback(8),
    aligned(visibleLandmark(landmarks, 14)) ?? fallback(9),
    aligned(visibleLandmark(landmarks, 16)) ?? fallback(10),
    leftHip ?? fallback(11),
    aligned(visibleLandmark(landmarks, 25)) ?? fallback(12),
    aligned(visibleLandmark(landmarks, 27)) ?? fallback(13),
    rightHip ?? fallback(14),
    aligned(visibleLandmark(landmarks, 26)) ?? fallback(15),
    aligned(visibleLandmark(landmarks, 28)) ?? fallback(16),
  ];

  // Preserve observed directions while bounding detector noise and perspective
  // distortion. Rebuilding from each bounded parent keeps every chain joined.
  const bounded = [raw[0].clone()];
  for (let bone = 1; bone < raw.length; bone += 1) {
    const parent = TARGET_PARENT_BONES[bone];
    const restDirection = rest[bone].clone().sub(rest[parent]);
    const observedDirection = raw[bone].clone().sub(raw[parent]);
    const restLength = restDirection.length();
    const observedLength = observedDirection.length();
    if (observedLength < 1e-8 || restLength < 1e-8) observedDirection.copy(restDirection);
    const ratio = THREE.MathUtils.clamp(
      observedLength / Math.max(restLength, 1e-8),
      SPECTRAL_BONE_LENGTH_SCALE_RANGE[0],
      SPECTRAL_BONE_LENGTH_SCALE_RANGE[1],
    );
    bounded.push(
      bounded[parent].clone().add(
        observedDirection.normalize().multiplyScalar(restLength * ratio),
      ),
    );
  }
  return bounded;
}

export interface SpectralHandEndpoints {
  rest: [THREE.Vector3, THREE.Vector3];
  target: [THREE.Vector3, THREE.Vector3];
}

/**
 * The compact rig ends at each wrist, while MediaPipe still provides thumb,
 * index and pinky landmarks. Their centroid steers the terminal hand volume
 * independently from the forearm so an open raised palm stays rounded instead
 * of turning into a long spike.
 */
export function handEndpointPositions(
  landmarks: Landmark[],
  rest: THREE.Vector3[],
  target: THREE.Vector3[],
): SpectralHandEndpoints {
  const sides = [
    { elbow: 6, wrist: 7, landmarkWrist: 15, palm: [17, 19, 21] as const },
    { elbow: 9, wrist: 10, landmarkWrist: 16, palm: [18, 20, 22] as const },
  ] as const;
  const restEnds: THREE.Vector3[] = [];
  const targetEnds: THREE.Vector3[] = [];
  sides.forEach(({ elbow, wrist, landmarkWrist, palm }) => {
    const restDirection = rest[wrist].clone().sub(rest[elbow]);
    const restLength = Math.max(restDirection.length() * 0.3, 1e-5);
    const restEnd = rest[wrist].clone().add(restDirection.normalize().multiplyScalar(restLength));
    const observedWrist = visibleLandmark(landmarks, landmarkWrist);
    const observedPalm = visibleCentroid(landmarks, palm);
    const observedDirection = observedWrist && observedPalm
      ? observedPalm.clone().sub(observedWrist)
      : target[wrist].clone().sub(target[elbow]);
    if (observedDirection.lengthSq() < 1e-8) observedDirection.copy(restDirection);
    const targetEnd = target[wrist].clone().add(observedDirection.normalize().multiplyScalar(restLength));
    restEnds.push(restEnd);
    targetEnds.push(targetEnd);
  });
  return {
    rest: restEnds as [THREE.Vector3, THREE.Vector3],
    target: targetEnds as [THREE.Vector3, THREE.Vector3],
  };
}

export function buildPoseMatrices(rig: GhostRig, landmarks: Landmark[]): THREE.Matrix4[] {
  const rest = restJointPositions(rig);
  const target = targetJointPositions(landmarks, rest);
  const hands = handEndpointPositions(landmarks, rest, target);
  return rest.map((restJoint, bone) => {
    const child = CHILD_BONES[bone];
    const parent = rig.parentIndices[bone];
    const directionBone = child >= 0 ? child : parent;
    const restHandEnd = bone === 7 ? hands.rest[0] : bone === 10 ? hands.rest[1] : null;
    const targetHandEnd = bone === 7 ? hands.target[0] : bone === 10 ? hands.target[1] : null;
    const restDirection = restHandEnd
      ? restHandEnd.clone().sub(restJoint)
      : directionBone >= 0
        ? rest[directionBone].clone().sub(restJoint)
        : new THREE.Vector3(0, 1, 0);
    const targetDirection = targetHandEnd
      ? targetHandEnd.clone().sub(target[bone])
      : directionBone >= 0
        ? target[directionBone].clone().sub(target[bone])
        : restDirection.clone();
    if (!restHandEnd && child < 0 && parent >= 0) {
      restDirection.negate();
      targetDirection.negate();
    }
    const rotation = new THREE.Quaternion();
    const axialScale = new THREE.Matrix4();
    if (restDirection.lengthSq() > 1e-9 && targetDirection.lengthSq() > 1e-9) {
      const restLength = restDirection.length();
      const targetLength = targetDirection.length();
      const restAxis = restDirection.clone().multiplyScalar(1 / restLength);
      rotation.setFromUnitVectors(restAxis, targetDirection.clone().multiplyScalar(1 / targetLength));
      const ratio = child >= 0
        ? THREE.MathUtils.clamp(
          targetLength / restLength,
          SPECTRAL_BONE_LENGTH_SCALE_RANGE[0],
          SPECTRAL_BONE_LENGTH_SCALE_RANGE[1],
        )
        : 1;
      const gain = ratio - 1;
      axialScale.set(
        1 + gain * restAxis.x * restAxis.x,
        gain * restAxis.x * restAxis.y,
        gain * restAxis.x * restAxis.z,
        0,
        gain * restAxis.y * restAxis.x,
        1 + gain * restAxis.y * restAxis.y,
        gain * restAxis.y * restAxis.z,
        0,
        gain * restAxis.z * restAxis.x,
        gain * restAxis.z * restAxis.y,
        1 + gain * restAxis.z * restAxis.z,
        0,
        0,
        0,
        0,
        1,
      );
    } else {
      axialScale.identity();
    }
    return new THREE.Matrix4()
      .makeTranslation(target[bone].x, target[bone].y, target[bone].z)
      .multiply(new THREE.Matrix4().makeRotationFromQuaternion(rotation))
      .multiply(axialScale)
      .multiply(new THREE.Matrix4().makeTranslation(-restJoint.x, -restJoint.y, -restJoint.z));
  });
}

function stabilizeCollapsedFaces(
  positions: Float32Array,
  normals: Int16Array,
  indices: Uint32Array,
  nudgeDistance: number,
): void {
  for (let pass = 0; pass < 12; pass += 1) {
    let repairs = 0;
    for (let index = 0; index < indices.length; index += 3) {
      const a = indices[index] * 3;
      const b = indices[index + 1] * 3;
      const c = indices[index + 2] * 3;
      const abx = positions[b] - positions[a];
      const aby = positions[b + 1] - positions[a + 1];
      const abz = positions[b + 2] - positions[a + 2];
      const acx = positions[c] - positions[a];
      const acy = positions[c + 1] - positions[a + 1];
      const acz = positions[c + 2] - positions[a + 2];
      const crossX = aby * acz - abz * acy;
      const crossY = abz * acx - abx * acz;
      const crossZ = abx * acy - aby * acx;
      if (crossX * crossX + crossY * crossY + crossZ * crossZ >= 1e-12) continue;
      let nx = normals[c] / 32767;
      let ny = normals[c + 1] / 32767;
      let nz = normals[c + 2] / 32767;
      let normalLength = Math.hypot(nx, ny, nz);
      if (normalLength < 1e-6) {
        // A deterministic perpendicular fallback for the unlikely zero-normal case.
        nx = -aby;
        ny = abx;
        nz = 0;
        normalLength = Math.hypot(nx, ny, nz);
        if (normalLength < 1e-6) {
          nx = 0;
          ny = -abz;
          nz = aby;
          normalLength = Math.hypot(nx, ny, nz) || 1;
        }
      }
      positions[c] += nx / normalLength * nudgeDistance;
      positions[c + 1] += ny / normalLength * nudgeDistance;
      positions[c + 2] += nz / normalLength * nudgeDistance;
      repairs += 1;
    }
    if (repairs === 0) return;
  }
}

function recomputeQuantizedNormals(
  positions: Float32Array,
  indices: Uint32Array,
): Int16Array<ArrayBuffer> {
  const accumulated = new Float32Array(positions.length);
  for (let index = 0; index < indices.length; index += 3) {
    const a = indices[index] * 3;
    const b = indices[index + 1] * 3;
    const c = indices[index + 2] * 3;
    const abx = positions[b] - positions[a];
    const aby = positions[b + 1] - positions[a + 1];
    const abz = positions[b + 2] - positions[a + 2];
    const acx = positions[c] - positions[a];
    const acy = positions[c + 1] - positions[a + 1];
    const acz = positions[c + 2] - positions[a + 2];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    for (const vertex of [a, b, c]) {
      accumulated[vertex] += nx;
      accumulated[vertex + 1] += ny;
      accumulated[vertex + 2] += nz;
    }
  }
  const normals = new Int16Array(positions.length);
  for (let index = 0; index < accumulated.length; index += 3) {
    const inverse = 1 / Math.max(Math.hypot(
      accumulated[index],
      accumulated[index + 1],
      accumulated[index + 2],
    ), 1e-8);
    normals[index] = Math.round(accumulated[index] * inverse * 32767);
    normals[index + 1] = Math.round(accumulated[index + 1] * inverse * 32767);
    normals[index + 2] = Math.round(accumulated[index + 2] * inverse * 32767);
  }
  return normals;
}

export function bakeGhostLodPose(lod: GhostLodMesh, rig: GhostRig, landmarks: Landmark[]): GhostLodMesh {
  const poseMatrices = buildPoseMatrices(rig, landmarks);
  const positions = new Float32Array(lod.positions.length);
  let normals: Int16Array<ArrayBuffer> = new Int16Array(lod.normals.length);
  const sourcePosition = new THREE.Vector3();
  const mappedPosition = new THREE.Vector3();
  const transformed = new THREE.Vector3();
  for (let vertex = 0; vertex < lod.vertexCount; vertex += 1) {
    sourcePosition.fromArray(lod.positions, vertex * 3);
    transformed.set(0, 0, 0);
    for (let influence = 0; influence < 4; influence += 1) {
      const bone = lod.skinIndices[vertex * 4 + influence];
      const weight = lod.skinWeights[vertex * 4 + influence] / 255;
      if (weight <= 0) continue;
      mappedPosition.copy(sourcePosition).applyMatrix4(poseMatrices[bone]);
      transformed.addScaledVector(mappedPosition, weight);
    }
    positions.set([transformed.x, transformed.y, transformed.z], vertex * 3);
  }
  // Large pose changes can make a handful of chain-transition triangles numerically
  // collinear. A sub-millimetre normal nudge preserves topology and prevents NaNs
  // in later normal/tangent generation without changing the visible silhouette.
  stabilizeCollapsedFaces(positions, normals, lod.indices, lod.voxelSize * 0.025);
  normals = recomputeQuantizedNormals(positions, lod.indices);
  return {
    ...lod,
    positions,
    normals,
    indices: lod.indices.slice(),
    skinIndices: lod.skinIndices.slice(),
    skinWeights: lod.skinWeights.slice(),
    canonicalCoords: lod.canonicalCoords.slice(),
    regionAndChain: lod.regionAndChain.slice(),
  };
}
