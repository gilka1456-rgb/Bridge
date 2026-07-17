import { describe, expect, it } from "vitest";
import type { Landmark } from "../models/types";
import {
  anchorNormalizePersonMask,
  ANCHORED_MASK_HEIGHT,
  ANCHORED_MASK_WIDTH,
  binarizePersonMask,
  decodePersonMaskRLE,
  encodePersonMaskRLE,
  findMaskBounds,
  fuseBinaryMasks,
  keepLargestComponent,
  normalizePersonMask,
  TARGET_ANCHOR_HEIGHT,
  TARGET_PELVIS,
} from "./segmentation";

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
