import { describe, expect, it } from "vitest";
import {
  binarizePersonMask,
  decodePersonMaskRLE,
  encodePersonMaskRLE,
  findMaskBounds,
  fuseBinaryMasks,
  keepLargestComponent,
  normalizePersonMask,
} from "./segmentation";

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

  it("uses multi-frame voting to preserve a temporarily missing limb", () => {
    const full = new Uint8Array([0, 1, 1, 0]);
    const missing = new Uint8Array([0, 1, 0, 0]);
    expect([...fuseBinaryMasks([full, full, missing, full, missing])]).toEqual([0, 1, 1, 0]);
  });
});
