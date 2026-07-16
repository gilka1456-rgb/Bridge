import { describe, expect, it } from "vitest";
import type { OrientationMask } from "../models/types";
import { encodePersonMaskRLE } from "../pose/segmentation";
import { buildVisualHullMeshData } from "./visual-hull";

function syntheticBody(width: number, height: number, centerX: number, bodyWidth: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  const centerY = height * 0.48;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const nx = (x - centerX) / bodyWidth;
      const ny = (y - centerY) / (height * 0.42);
      const torso = nx * nx + ny * ny < 1;
      const head = ((x - centerX) / (bodyWidth * 0.42)) ** 2
        + ((y - height * 0.1) / (height * 0.075)) ** 2 < 1;
      const leftLeg = y > height * 0.68 && Math.abs(x - (centerX - bodyWidth * 0.3)) < bodyWidth * 0.24;
      const rightLeg = y > height * 0.68 && Math.abs(x - (centerX + bodyWidth * 0.3)) < bodyWidth * 0.24;
      if (torso || head || leftLeg || rightLeg) mask[y * width + x] = 1;
    }
  }
  return mask;
}

function view(azimuth: number, centerX: number, bodyWidth: number): OrientationMask {
  const width = 64;
  const height = 96;
  const mask = syntheticBody(width, height, centerX, bodyWidth);
  return { azimuth, width, height, mask: encodePersonMaskRLE(mask) };
}

describe("soft visual hull", () => {
  it("normalizes shifted legacy silhouettes and produces a full 3D volume", () => {
    const result = buildVisualHullMeshData([
      view(0, 20, 15),
      view(90, 36, 9),
      view(180, 28, 14),
      view(270, 42, 10),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mesh.triangleCount).toBeGreaterThan(500);
    expect(result.mesh.triangleCount).toBeLessThan(25_000);
    expect(result.mesh.occupiedRatio).toBeGreaterThan(0.01);
    expect([...result.mesh.positions].every(Number.isFinite)).toBe(true);
  });

  it("returns a diagnostic instead of silently creating a skeleton", () => {
    const result = buildVisualHullMeshData([]);
    expect(result).toMatchObject({ ok: false, code: "insufficient-views" });
  });
});
