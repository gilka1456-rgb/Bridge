import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { OrientationMask } from "../models/types";
import { encodeAppearanceLuma, encodePersonMaskRLE } from "../pose/segmentation";
import { attachSpectralAppearanceField } from "./appearance-field";

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

describe("spectral appearance field", () => {
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
    expect(geometry.userData.spectralAppearanceViews).toBe(3);
  });

  it("provides a neutral field for legacy scans", () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0], 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute([0, 0, 1], 3));
    expect(attachSpectralAppearanceField(geometry, undefined)).toBe(0);
    expect(geometry.getAttribute("bridgeAppearance").getX(0)).toBe(0.5);
  });
});
