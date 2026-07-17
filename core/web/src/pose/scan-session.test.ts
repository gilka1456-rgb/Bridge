import { describe, expect, it } from "vitest";
import type { Landmark } from "../models/types";
import {
  buildCoverageState,
  computeBodyTilt,
  computeJointSignature,
  computePhotoPoseSignature,
  computeUpperBodyJointSignature,
  countVisibleLandmarks,
  estimateBodyAzimuth,
  hasOrthogonalFullBodyCoverage,
  MAX_JOINT_SIGNATURE_DEVIATION,
  MIN_MASK_QUALITY,
  POSE_MISMATCH_GUIDANCE,
  scoreBinaryMask,
  signatureDeviation,
  rotateLandmarksInImage,
} from "./scan-session";

function shoulders(left: Partial<Landmark>, right: Partial<Landmark>): Landmark[] {
  const landmarks = Array.from({ length: 13 }, () => ({ x: 0, y: 0, z: 0, visibility: 1 }));
  landmarks[11] = { ...landmarks[11], ...left };
  landmarks[12] = { ...landmarks[12], ...right };
  return landmarks;
}

function fullBodyPose(leftWrist: { x: number; y: number }): Landmark[] {
  const landmarks = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }));
  const set = (index: number, x: number, y: number) => {
    landmarks[index] = { x, y, z: 0, visibility: 1 };
  };
  set(11, 0.4, 0.3);
  set(12, 0.6, 0.3);
  set(13, 0.4, 0.45);
  set(14, 0.6, 0.45);
  set(15, leftWrist.x, leftWrist.y);
  set(16, 0.6, 0.6);
  set(23, 0.45, 0.6);
  set(24, 0.55, 0.6);
  set(25, 0.45, 0.78);
  set(26, 0.55, 0.78);
  set(27, 0.45, 0.96);
  set(28, 0.55, 0.96);
  return landmarks;
}

describe("scan coverage", () => {
  it("rejects empty and edge-clipped masks", () => {
    expect(scoreBinaryMask(new Uint8Array(16), 4, 4)).toBe(0);
    expect(scoreBinaryMask(new Uint8Array(16).fill(1), 4, 4)).toBeLessThan(MIN_MASK_QUALITY);
    expect(scoreBinaryMask(new Uint8Array(16).fill(1), 4, 4, true)).toBeGreaterThan(MIN_MASK_QUALITY);
  });

  it("requires all four quality orientations", () => {
    const partial = buildCoverageState(new Map([
      [0, MIN_MASK_QUALITY], [90, MIN_MASK_QUALITY], [180, MIN_MASK_QUALITY],
    ]));
    expect(partial.capturedCount).toBe(3);
    expect(partial.isComplete).toBe(false);

    const complete = buildCoverageState(new Map([
      [0, MIN_MASK_QUALITY], [90, MIN_MASK_QUALITY], [180, MIN_MASK_QUALITY], [270, MIN_MASK_QUALITY],
    ]));
    expect(complete.isComplete).toBe(true);
  });

  it("keeps real lower-body evidence when weak frames have an orthogonal complete pair", () => {
    expect(hasOrthogonalFullBodyCoverage([
      { azimuth: 0, partial: true },
      { azimuth: 90, partial: true },
      { azimuth: 180 },
      { azimuth: 270 },
    ])).toBe(true);
    expect(hasOrthogonalFullBodyCoverage([
      { azimuth: 0 },
      { azimuth: 180 },
      { azimuth: 90, partial: true },
      { azimuth: 270, partial: true },
    ])).toBe(false);
  });

  it("ignores shoulders with poor visibility", () => {
    expect(estimateBodyAzimuth(shoulders({ visibility: 0.2 }, { x: 1, visibility: 1 }))).toBeNull();
  });

  it("maps clear shoulder directions to cardinal buckets", () => {
    expect(estimateBodyAzimuth(shoulders({ x: 0 }, { x: 1 }))).toBe(0);
    expect(estimateBodyAzimuth(shoulders({ z: 0 }, { z: 1 }))).toBe(90);
  });

  it("corrects a 90 degree body tilt without changing the estimated azimuth", () => {
    const standing = fullBodyPose({ x: 0.4, y: 0.6 });
    standing[11].z = 0;
    standing[12].z = 0.2;
    const lying = rotateLandmarksInImage(standing, 90);
    const tilt = computeBodyTilt(lying);
    const corrected = rotateLandmarksInImage(lying, -tilt);

    expect(computeBodyTilt(standing)).toBeCloseTo(0, 5);
    expect(tilt).toBeCloseTo(90, 5);
    expect(computeBodyTilt(corrected)).toBeCloseTo(0, 5);
    expect(estimateBodyAzimuth(corrected)).toBe(estimateBodyAzimuth(standing));
  });

  it("requires at least 20 visible landmarks", () => {
    const landmarks = fullBodyPose({ x: 0.4, y: 0.6 });
    landmarks.slice(0, 14).forEach((point) => { point.visibility = 0; });
    expect(countVisibleLandmarks(landmarks)).toBe(19);
  });

  it("rejects a 90 degree elbow pose change and allows small jitter", () => {
    const baseline = computeJointSignature(fullBodyPose({ x: 0.4, y: 0.6 }));
    const bentElbow = computeJointSignature(fullBodyPose({ x: 0.25, y: 0.45 }));
    const jitter = computeJointSignature(fullBodyPose({ x: 0.39, y: 0.6 }));
    expect(baseline).toHaveLength(8);
    expect(signatureDeviation(baseline, bentElbow)).toBeGreaterThan(MAX_JOINT_SIGNATURE_DEVIATION);
    expect(signatureDeviation(baseline, jitter)).toBeLessThan(10);
  });

  it("keeps an upper-body signature when cropped ankles are unavailable", () => {
    const partial = fullBodyPose({ x: 0.4, y: 0.6 });
    partial[27].visibility = 0.1;
    partial[28].visibility = 0.1;
    expect(computeJointSignature(partial)).toEqual([]);
    expect(computeUpperBodyJointSignature(partial)).toHaveLength(4);
  });

  it("compares imported-photo poses without depending on mirrored left/right labels", () => {
    const baseline = fullBodyPose({ x: 0.25, y: 0.45 });
    const mirrored = baseline.map((point) => ({ ...point, x: 1 - point.x }));
    for (const [left, right] of [[11, 12], [13, 14], [15, 16], [23, 24]] as const) {
      [mirrored[left], mirrored[right]] = [mirrored[right], mirrored[left]];
    }
    expect(signatureDeviation(
      computePhotoPoseSignature(baseline),
      computePhotoPoseSignature(mirrored),
    )).toBeCloseTo(0, 5);
  });

  it("still rejects a raised-arm change in an imported photo", () => {
    const down = computePhotoPoseSignature(fullBodyPose({ x: 0.4, y: 0.6 }));
    const raised = computePhotoPoseSignature(fullBodyPose({ x: 0.25, y: 0.25 }));
    expect(signatureDeviation(down, raised)).toBeGreaterThan(MAX_JOINT_SIGNATURE_DEVIATION);
  });

  it("exposes the same pose guidance used by the text and voice pipeline", () => {
    expect(buildCoverageState(new Map()).guidance).toContain("双臂自然下垂或微微张开");
    expect(POSE_MISMATCH_GUIDANCE).toBe("姿势和正面不一致，请保持同一姿势转身。");
  });
});
