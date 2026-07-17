import { describe, expect, it } from "vitest";
import {
  anchoredSpectralGroundLocalY,
  sampleSpectralHoverOffset,
  SPECTRAL_HOVER_AMPLITUDE_METERS,
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
    const worldAnchorY = -0.895;
    const groupOffsetY = sampleSpectralHoverOffset(1.7, 1);
    const localY = anchoredSpectralGroundLocalY(worldAnchorY, groupOffsetY);
    expect(localY + groupOffsetY).toBeCloseTo(worldAnchorY, 8);
  });
});
