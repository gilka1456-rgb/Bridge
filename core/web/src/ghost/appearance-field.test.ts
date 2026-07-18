import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { OrientationMask } from "../models/types";
import { encodeAppearanceLuma, encodePersonMaskRLE } from "../pose/segmentation";
import {
  attachSpectralAppearanceField,
  smoothSpectralAppearanceValues,
  SPECTRAL_APPEARANCE_SMOOTHING,
  SPECTRAL_APPEARANCE_FIELD_VERSION,
} from "./appearance-field";

function flatView(azimuth: number, luma: number): OrientationMask {
  const width = 4;
  const height = 4;
  return {
    azimuth,
    width,
    height,
    mask: encodePersonMaskRLE(new Uint8Array(width * height).fill(1)),
    appearanceLuma: encodeAppearanceLuma(new Uint8Array(width * height).fill(luma)),
    normalized: true,
  };
}

function foldView(): OrientationMask {
  const width = 9;
  const height = 9;
  const luma = new Uint8Array(width * height).fill(128);
  luma[4 * width + 4] = 208;
  for (const [x, y] of [[2, 4], [6, 4], [4, 2], [4, 6], [2, 2], [6, 2], [2, 6], [6, 6]]) {
    luma[y * width + x] = 48;
  }
  return {
    azimuth: 0,
    width,
    height,
    mask: encodePersonMaskRLE(new Uint8Array(width * height).fill(1)),
    appearanceLuma: encodeAppearanceLuma(luma),
    normalized: true,
  };
}

describe("spectral appearance field", () => {
  it("removes small view seams while preserving strong clothing folds", () => {
    const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
    const seam = new Float32Array([0.42, 0.53, 0.48, 0.57]);
    const beforeRange = Math.max(...seam) - Math.min(...seam);
    const coherent = smoothSpectralAppearanceValues(
      seam,
      indices,
      SPECTRAL_APPEARANCE_SMOOTHING.passes,
      SPECTRAL_APPEARANCE_SMOOTHING.lumaBlend,
      SPECTRAL_APPEARANCE_SMOOTHING.lumaMaxDelta,
    );
    expect(Math.max(...coherent) - Math.min(...coherent)).toBeLessThan(beforeRange * 0.75);

    const fold = new Float32Array([0.12, 0.14, 0.88]);
    const protectedFold = smoothSpectralAppearanceValues(fold, new Uint16Array([0, 1, 2]), 3, 1, 0.18);
    expect(protectedFold[2]).toBeGreaterThan(0.87);
    expect(protectedFold[0]).toBeLessThan(0.15);
  });

  it("selects the photo facing each surface without changing geometry", () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([
      0, 0.5, 0,
      0, 0.5, 0,
      0, 0.5, 0,
    ], 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute([
      0, 0, 1,
      0, 0, -1,
      1, 0, 0,
    ], 3));
    const views = [flatView(0, 64), flatView(180, 192), flatView(90, 128)];
    expect(attachSpectralAppearanceField(geometry, views)).toBe(3);
    const appearance = geometry.getAttribute("bridgeAppearance");
    expect(appearance.getX(0)).toBeLessThan(0.31);
    expect(appearance.getX(1)).toBeGreaterThan(0.69);
    expect(appearance.getX(2)).toBeCloseTo(0.5, 1);
    const relief = geometry.getAttribute("bridgeAppearanceRelief");
    expect(relief.getX(0)).toBeCloseTo(0.5, 2);
    expect(relief.getX(1)).toBeCloseTo(0.5, 2);
    expect(relief.getX(2)).toBeCloseTo(0.5, 2);
    expect(geometry.userData.spectralAppearanceViews).toBe(3);
    expect(geometry.userData.spectralAppearanceFieldVersion).toBe(SPECTRAL_APPEARANCE_FIELD_VERSION);
    expect(geometry.userData.spectralAppearanceSmoothingPasses)
      .toBe(SPECTRAL_APPEARANCE_SMOOTHING.passes);
  });

  it("preserves broad fold relief without changing the shared body mesh", () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, -0.1, 0], 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute([0, 0, 1], 3));
    const before = Array.from(geometry.getAttribute("position").array);
    expect(attachSpectralAppearanceField(geometry, [foldView()])).toBe(1);
    expect(geometry.getAttribute("bridgeAppearance").getX(0)).toBeGreaterThan(0.75);
    expect(geometry.getAttribute("bridgeAppearanceRelief").getX(0)).toBeGreaterThan(0.85);
    expect(Array.from(geometry.getAttribute("position").array)).toEqual(before);
  });

  it("provides a neutral field for legacy scans", () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0], 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute([0, 0, 1], 3));
    expect(attachSpectralAppearanceField(geometry, undefined)).toBe(0);
    expect(geometry.getAttribute("bridgeAppearance").getX(0)).toBe(0.5);
    expect(geometry.getAttribute("bridgeAppearanceRelief").getX(0)).toBe(0.5);
    expect(geometry.userData.spectralAppearanceFieldVersion).toBe(SPECTRAL_APPEARANCE_FIELD_VERSION);
  });
});
