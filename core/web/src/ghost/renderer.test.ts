import { describe, expect, it } from "vitest";
import {
  anchoredSpectralGroundLocalY,
  resolveSpectralCameraFit,
  sampleSpectralHoverOffset,
  spectralGroundingOffsetY,
  SPECTRAL_HOVER_AMPLITUDE_METERS,
  SPECTRAL_WORLD_GROUND_Y,
} from "./renderer";

describe("Spectral scene grounding", () => {
  it("keeps the target styles within a millimetre-scale hover envelope", () => {
    for (let step = 0; step <= 64; step += 1) {
      const offset = sampleSpectralHoverOffset(step * 0.125, 0);
      expect(Math.abs(offset)).toBeLessThanOrEqual(SPECTRAL_HOVER_AMPLITUDE_METERS);
    }
    expect(SPECTRAL_HOVER_AMPLITUDE_METERS).toBeLessThan(0.01);
  });

  it("cancels group hover for a world-anchored ground interaction", () => {
    const worldAnchorY = SPECTRAL_WORLD_GROUND_Y;
    const groupOffsetY = spectralGroundingOffsetY(-1.18)
      + sampleSpectralHoverOffset(1.7, 1);
    const localY = anchoredSpectralGroundLocalY(worldAnchorY, groupOffsetY);
    expect(localY + groupOffsetY).toBeCloseTo(worldAnchorY, 8);
  });

  it("grounds variable-height bodies without letting their soles sink below the floor", () => {
    for (const bodyMinimumY of [-0.86, -1.02, -1.28]) {
      const grounding = spectralGroundingOffsetY(bodyMinimumY);
      const lowestSoleY = bodyMinimumY + grounding - SPECTRAL_HOVER_AMPLITUDE_METERS;
      expect(lowestSoleY).toBeCloseTo(SPECTRAL_WORLD_GROUND_Y, 8);
    }
    expect(spectralGroundingOffsetY(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("centres variable-height bodies and fits both height and width", () => {
    const tall = resolveSpectralCameraFit({
      min: [-0.62, -0.895, -0.18],
      max: [0.62, 1.62, 0.24],
    }, 16 / 9);
    expect(tall.target[0]).toBeCloseTo(0, 8);
    expect(tall.target[1]).toBeCloseTo(0.3625, 8);
    expect(tall.position[1]).toBeCloseTo(tall.target[1], 8);
    expect(tall.position[2]).toBeGreaterThan(3.5);

    const narrowViewport = resolveSpectralCameraFit({
      min: [-0.9, -0.895, -0.2],
      max: [0.9, 1.1, 0.2],
    }, 0.5);
    expect(narrowViewport.position[2]).toBeGreaterThan(tall.position[2]);
  });
});
