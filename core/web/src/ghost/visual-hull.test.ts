import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { OrientationMask } from "../models/types";
import { decodePersonMaskRLE, encodePersonMaskRLE } from "../pose/segmentation";
import { buildVisualHullMeshData, createVisualHullSdfSampler } from "./visual-hull";

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

function anchoredView(azimuth: number, lateral: boolean): OrientationMask {
  const width = 256;
  const height = 512;
  const centerX = 128;
  const mask = new Uint8Array(width * height);
  const fillEllipse = (cx: number, cy: number, rx: number, ry: number) => {
    for (let y = Math.max(0, Math.floor(cy - ry)); y <= Math.min(height - 1, Math.ceil(cy + ry)); y += 1) {
      for (let x = Math.max(0, Math.floor(cx - rx)); x <= Math.min(width - 1, Math.ceil(cx + rx)); x += 1) {
        if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) mask[y * width + x] = 1;
      }
    }
  };
  const fillRect = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) mask[y * width + x] = 1;
    }
  };

  fillEllipse(centerX, 103, lateral ? 22 : 28, 34);
  fillRect(centerX - (lateral ? 9 : 11), 130, centerX + (lateral ? 9 : 11), 164);
  fillEllipse(centerX, 235, lateral ? 31 : 48, 88);
  fillEllipse(centerX, 306, lateral ? 29 : 40, 45);
  fillRect(centerX - (lateral ? 23 : 32), 300, centerX - (lateral ? 5 : 8), 488);
  fillRect(centerX + (lateral ? 5 : 8), 300, centerX + (lateral ? 23 : 32), 488);

  return {
    azimuth,
    width,
    height,
    mask: encodePersonMaskRLE(mask),
    normalized: true,
    anchor: { pelvis: { x: 128, y: 296 }, anchorHeight: 210 },
  };
}

function partialAnchoredView(azimuth: number, lateral: boolean): OrientationMask {
  const full = anchoredView(azimuth, lateral);
  const mask = decodePersonMaskRLE(full.mask, full.width * full.height);
  for (let y = 330; y < full.height; y += 1) {
    mask.fill(0, y * full.width, (y + 1) * full.width);
  }
  return { ...full, mask: encodePersonMaskRLE(mask), partial: true };
}

describe("soft visual hull", () => {
  it("normalizes shifted legacy silhouettes and produces a full 3D volume", () => {
    const result = buildVisualHullMeshData([
      view(0, 20, 14),
      view(90, 36, 8.5),
      view(180, 28, 13),
      view(270, 42, 9),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mesh.triangleCount).toBeGreaterThan(500);
    expect(result.mesh.triangleCount).toBeLessThan(25_000);
    expect(result.mesh.occupiedRatio).toBeGreaterThan(0.01);
    expect([...result.mesh.positions].every(Number.isFinite)).toBe(true);
  });

  it("keeps v2 normalized masks without anchors on the legacy projection path", () => {
    const result = buildVisualHullMeshData([
      { ...view(0, 32, 14), normalized: true },
      { ...view(90, 32, 9), normalized: true },
      { ...view(180, 32, 14), normalized: true },
      { ...view(270, 32, 9), normalized: true },
    ]);
    expect(result.ok).toBe(true);
  });

  it("returns a diagnostic instead of silently creating a skeleton", () => {
    const result = buildVisualHullMeshData([]);
    expect(result).toMatchObject({ ok: false, code: "insufficient-views" });
  });

  it("preserves an independently rounded head above the anchored neck", () => {
    const result = buildVisualHullMeshData([
      anchoredView(0, false),
      anchoredView(90, true),
      anchoredView(180, false),
      anchoredView(270, true),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const layerExtentX = (minY: number, maxY: number) => {
      const xs: number[] = [];
      for (let index = 0; index < result.mesh.positions.length; index += 3) {
        const y = result.mesh.positions[index + 1];
        if (y >= minY && y <= maxY) xs.push(result.mesh.positions[index]);
      }
      return xs.length > 0 ? Math.max(...xs) - Math.min(...xs) : 0;
    };
    const headWidth = layerExtentX(0.82, 1);
    const neckWidth = layerExtentX(0.73, 0.76);
    expect(headWidth).toBeGreaterThan(0.12);
    expect(headWidth).toBeGreaterThan(neckWidth * 1.3);
  });

  it("leaves the missing lower region of partial views neutral for template completion", () => {
    const sampler = createVisualHullSdfSampler([
      partialAnchoredView(0, false),
      partialAnchoredView(90, true),
    ]);
    expect(sampler).not.toBeNull();
    expect(sampler?.(new THREE.Vector3(0, -0.65, 0))).toBeCloseTo(0, 5);
    expect(Math.abs(sampler?.(new THREE.Vector3(0, 0.2, 0)) ?? 0)).toBeGreaterThan(0.005);
  });
});
