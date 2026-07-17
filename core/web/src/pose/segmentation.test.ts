import { describe, expect, it } from "vitest";
import type { Landmark } from "../models/types";
import {
  anchorNormalizePersonMask,
  ANCHORED_MASK_HEIGHT,
  ANCHORED_MASK_WIDTH,
  binarizePersonMask,
  closeBinaryMask,
  decodePersonMaskRLE,
  encodePersonMaskRLE,
  findMaskBounds,
  fuseBinaryMasks,
  keepLargestComponent,
  normalizePersonMask,
  rotateBinaryMask,
  TARGET_ANCHOR_HEIGHT,
  TARGET_PELVIS,
} from "./segmentation";
import { computeBodyTilt, rotateLandmarksInImage } from "./scan-session";

function legacyForwardNormalize(source: Uint8Array, sourceWidth: number, sourceHeight: number): Uint8Array {
  const cleaned = closeBinaryMask(keepLargestComponent(source, sourceWidth, sourceHeight), sourceWidth, sourceHeight);
  const bounds = findMaskBounds(cleaned, sourceWidth, sourceHeight)!;
  const targetWidth = 128;
  const targetHeight = 256;
  const targetBodyHeight = Math.floor(targetHeight * 0.9);
  const scale = (targetBodyHeight - 1) / Math.max(bounds.maxY - bounds.minY, 1);
  const sourceCenterX = (bounds.minX + bounds.maxX) / 2;
  const targetCenterX = (targetWidth - 1) / 2;
  const targetTop = Math.floor((targetHeight - targetBodyHeight) / 2);
  const result = new Uint8Array(targetWidth * targetHeight);
  for (let sy = bounds.minY; sy <= bounds.maxY; sy += 1) {
    for (let sx = bounds.minX; sx <= bounds.maxX; sx += 1) {
      if (!cleaned[sy * sourceWidth + sx]) continue;
      const tx = Math.round(targetCenterX + (sx - sourceCenterX) * scale);
      const ty = Math.round(targetTop + (sy - bounds.minY) * scale);
      if (tx >= 0 && tx < targetWidth && ty >= 0 && ty < targetHeight) result[ty * targetWidth + tx] = 1;
    }
  }
  return closeBinaryMask(result, targetWidth, targetHeight);
}

function edgeSecondDifference(mask: Uint8Array, width: number, height: number): number {
  const edge: number[] = [];
  for (let y = 0; y < height; y += 1) {
    let first = -1;
    for (let x = 0; x < width; x += 1) {
      if (mask[y * width + x]) {
        first = x;
        break;
      }
    }
    if (first >= 0) edge.push(first);
  }
  let total = 0;
  for (let index = 1; index + 1 < edge.length; index += 1) {
    total += Math.abs(edge[index + 1] - 2 * edge[index] + edge[index - 1]);
  }
  return total;
}

function personLandmarks(width: number, height: number): Landmark[] {
  const landmarks = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0 }));
  const set = (index: number, x: number, y: number, visibility = 1) => {
    landmarks[index] = { x: x / (width - 1), y: y / (height - 1), z: 0, visibility };
  };
  set(0, 48, 25);
  set(7, 44, 27, 0);
  set(8, 52, 27, 0);
  set(11, 42, 45);
  set(12, 54, 45);
  set(23, 44, 80);
  set(24, 52, 80);
  return landmarks;
}

function drawSyntheticPerson(raisedHand: boolean): Uint8Array {
  const width = 96;
  const height = 128;
  const mask = new Uint8Array(width * height);
  for (let y = 20; y <= 38; y += 1) {
    for (let x = 42; x <= 54; x += 1) {
      const nx = (x - 48) / 7;
      const ny = (y - 29) / 10;
      if (nx * nx + ny * ny <= 1) mask[y * width + x] = 1;
    }
  }
  for (let y = 36; y <= 88; y += 1) {
    for (let x = 38; x <= 58; x += 1) mask[y * width + x] = 1;
  }
  for (let y = 86; y <= 121; y += 1) {
    for (let x = 40; x <= 47; x += 1) mask[y * width + x] = 1;
    for (let x = 50; x <= 57; x += 1) mask[y * width + x] = 1;
  }
  if (raisedHand) {
    for (let x = 58; x <= 78; x += 1) {
      for (let y = 43; y <= 50; y += 1) mask[y * width + x] = 1;
    }
    for (let x = 74; x <= 81; x += 1) {
      for (let y = 0; y <= 48; y += 1) mask[y * width + x] = 1;
    }
  }
  return mask;
}

function torsoColumnTop(mask: Uint8Array, width: number, height: number): number {
  const lowerXs: number[] = [];
  for (let y = Math.floor(height * 0.55); y < Math.floor(height * 0.82); y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (mask[y * width + x]) lowerXs.push(x);
    }
  }
  const centerX = Math.round(lowerXs.reduce((sum, value) => sum + value, 0) / lowerXs.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = Math.max(0, centerX - 3); x <= Math.min(width - 1, centerX + 3); x += 1) {
      if (mask[y * width + x]) return y;
    }
  }
  return height;
}

function drawSquareStandingPerson(size: number): { mask: Uint8Array; landmarks: Landmark[] } {
  const mask = new Uint8Array(size * size);
  const fillRect = (minX: number, minY: number, maxX: number, maxY: number) => {
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) mask[y * size + x] = 1;
    }
  };
  for (let y = 18; y <= 42; y += 1) {
    for (let x = 68; x <= 92; x += 1) {
      const nx = (x - 80) / 13;
      const ny = (y - 30) / 13;
      if (nx * nx + ny * ny <= 1) mask[y * size + x] = 1;
    }
  }
  fillRect(62, 43, 98, 100);
  fillRect(46, 48, 61, 98);
  fillRect(99, 48, 114, 98);
  fillRect(65, 101, 78, 145);
  fillRect(82, 101, 95, 145);

  const landmarks = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }));
  const set = (index: number, x: number, y: number) => {
    landmarks[index] = { x: x / (size - 1), y: y / (size - 1), z: 0, visibility: 1 };
  };
  set(0, 80, 30);
  set(11, 65, 50);
  set(12, 95, 50);
  set(23, 70, 98);
  set(24, 90, 98);
  return { mask, landmarks };
}

function intersectionOverUnion(left: Uint8Array, right: Uint8Array): number {
  let intersection = 0;
  let union = 0;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] || right[index]) union += 1;
    if (left[index] && right[index]) intersection += 1;
  }
  return intersection / Math.max(union, 1);
}

describe("person mask processing", () => {
  it("binarizes MediaPipe category masks", () => {
    expect([...binarizePersonMask(new Uint8Array([0, 1, 2, 1]))]).toEqual([0, 1, 0, 1]);
  });

  it.each([
    [[]],
    [[0]],
    [[1]],
    [[0, 0, 1, 1, 0, 1]],
    [[1, 1, 0, 0, 1, 0, 1]],
  ] satisfies Array<[number[]]>)("round trips %j", (values) => {
    const mask = new Uint8Array(values);
    expect([...decodePersonMaskRLE(encodePersonMaskRLE(mask), mask.length)]).toEqual(values);
  });

  it("keeps the largest connected person and removes isolated noise", () => {
    const mask = new Uint8Array([
      1, 0, 0, 0,
      0, 1, 1, 0,
      0, 1, 1, 0,
      0, 0, 0, 1,
    ]);
    const cleaned = keepLargestComponent(mask, 4, 4);
    expect(findMaskBounds(cleaned, 4, 4)).toMatchObject({
      minX: 1, minY: 1, maxX: 2, maxY: 2, pixelCount: 4,
    });
  });

  it("centers shifted people on a common 1:2 canvas without changing proportions", () => {
    const source = new Uint8Array(20 * 20);
    for (let y = 2; y <= 17; y += 1) {
      for (let x = 12; x <= 15; x += 1) source[y * 20 + x] = 1;
    }
    const normalized = normalizePersonMask(source, 20, 20);
    expect(normalized).not.toBeNull();
    expect(normalized?.width).toBe(128);
    expect(normalized?.height).toBe(256);
    expect(normalized?.personAspect).toBeCloseTo(0.25);
    const bounds = normalized && findMaskBounds(normalized.mask, normalized.width, normalized.height);
    expect(bounds && (bounds.minX + bounds.maxX) / 2).toBeCloseTo(63.5, 0);
    expect(bounds && bounds.maxY - bounds.minY).toBeGreaterThan(220);
  });

  it("keeps head alignment stable when a raised hand changes the whole-person bounds", () => {
    const width = 96;
    const height = 128;
    const baseMask = drawSyntheticPerson(false);
    const raisedMask = drawSyntheticPerson(true);
    const landmarks = personLandmarks(width, height);
    const boxedBase = normalizePersonMask(baseMask, width, height)!;
    const boxedRaised = normalizePersonMask(raisedMask, width, height)!;
    const anchoredBase = anchorNormalizePersonMask(baseMask, width, height, landmarks)!;
    const anchoredRaised = anchorNormalizePersonMask(raisedMask, width, height, landmarks)!;

    const boxedOffset = Math.abs(
      torsoColumnTop(boxedBase.mask, boxedBase.width, boxedBase.height)
      - torsoColumnTop(boxedRaised.mask, boxedRaised.width, boxedRaised.height),
    ) / boxedBase.height;
    const anchoredOffset = Math.abs(
      torsoColumnTop(anchoredBase.mask, anchoredBase.width, anchoredBase.height)
      - torsoColumnTop(anchoredRaised.mask, anchoredRaised.width, anchoredRaised.height),
    ) / anchoredBase.height;

    expect(boxedOffset).toBeGreaterThan(0.1);
    expect(anchoredOffset).toBeLessThan(0.02);
    expect(anchoredBase).toMatchObject({
      width: ANCHORED_MASK_WIDTH,
      height: ANCHORED_MASK_HEIGHT,
      anchor: { pelvis: TARGET_PELVIS, anchorHeight: TARGET_ANCHOR_HEIGHT },
    });
  });

  it("reduces diagonal edge stair-stepping by at least half", () => {
    const width = 40;
    const height = 50;
    const source = new Uint8Array(width * height);
    for (let y = 4; y < height - 4; y += 1) {
      const left = Math.round(4 + y * 0.2);
      for (let x = left; x <= Math.min(width - 2, left + 11); x += 1) source[y * width + x] = 1;
    }
    const legacy = legacyForwardNormalize(source, width, height);
    const normalized = normalizePersonMask(source, width, height)!;
    const legacyRoughness = edgeSecondDifference(legacy, 128, 256);
    const smoothRoughness = edgeSecondDifference(normalized.mask, normalized.width, normalized.height);
    expect(smoothRoughness).toBeLessThanOrEqual(legacyRoughness * 0.5);
  });

  it("restores a lying 90 degree mask to the standing anchored frame", () => {
    const size = 160;
    const standing = drawSquareStandingPerson(size);
    const lyingLandmarks = rotateLandmarksInImage(standing.landmarks, 90);
    const lyingMask = rotateBinaryMask(standing.mask, size, size, 90);
    const tilt = computeBodyTilt(lyingLandmarks);
    const correctedLandmarks = rotateLandmarksInImage(lyingLandmarks, -tilt);
    const correctedMask = rotateBinaryMask(lyingMask, size, size, -tilt);
    const expected = anchorNormalizePersonMask(standing.mask, size, size, standing.landmarks)!;
    const actual = anchorNormalizePersonMask(correctedMask, size, size, correctedLandmarks)!;

    expect(tilt).toBeCloseTo(90, 5);
    expect(intersectionOverUnion(actual.mask, expected.mask)).toBeGreaterThanOrEqual(0.85);
  });

  it("returns null when required anchor landmarks are not visible", () => {
    const landmarks = personLandmarks(96, 128);
    landmarks[0].visibility = 0.1;
    expect(anchorNormalizePersonMask(drawSyntheticPerson(false), 96, 128, landmarks)).toBeNull();
  });

  it("uses multi-frame voting to preserve a temporarily missing limb", () => {
    const full = new Uint8Array([0, 1, 1, 0]);
    const missing = new Uint8Array([0, 1, 0, 0]);
    expect([...fuseBinaryMasks([full, full, missing, full, missing])]).toEqual([0, 1, 1, 0]);
  });
});
