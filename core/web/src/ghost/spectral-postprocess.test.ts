import { describe, expect, it } from "vitest";
import {
  resolveSpectralPostProcessProfile,
  SPECTRAL_POSTPROCESS_VERSION,
} from "./spectral-postprocess";

describe("Spectral style-aware post processing", () => {
  it("uses a wider fantasy halo and a tighter cyber projection glow", () => {
    const fantasy = resolveSpectralPostProcessProfile(["wraith"], "high", true);
    const cyber = resolveSpectralPostProcessProfile(["cyber"], "high", true);
    expect(SPECTRAL_POSTPROCESS_VERSION).toContain("style-aware-bloom");
    expect(fantasy.enabled).toBe(true);
    expect(cyber.enabled).toBe(true);
    expect(fantasy.family).toBe("fantasy");
    expect(cyber.family).toBe("cyber");
    expect(fantasy.radius).toBeGreaterThan(cyber.radius * 2);
    expect(fantasy.strength).toBeGreaterThan(cyber.strength);
    expect(fantasy.threshold).toBeLessThan(cyber.threshold);
  });

  it("uses a stable compromise when both style families share a scene", () => {
    const fantasy = resolveSpectralPostProcessProfile(["phantom"], "high", true);
    const cyber = resolveSpectralPostProcessProfile(["quantum"], "high", true);
    const mixed = resolveSpectralPostProcessProfile(["phantom", "quantum"], "high", true);
    expect(mixed.family).toBe("mixed");
    expect(mixed.radius).toBeGreaterThan(cyber.radius);
    expect(mixed.radius).toBeLessThan(fantasy.radius);
    expect(mixed.strength).toBeGreaterThan(cyber.strength);
    expect(mixed.strength).toBeLessThan(fantasy.strength);
  });

  it("reduces fill cost on medium and bypasses bloom on low or transparent output", () => {
    const high = resolveSpectralPostProcessProfile(["wraith"], "high", true);
    const medium = resolveSpectralPostProcessProfile(["wraith"], "medium", true);
    expect(medium.enabled).toBe(true);
    expect(medium.strength).toBeLessThan(high.strength);
    expect(medium.threshold).toBeGreaterThan(high.threshold);
    expect(medium.resolutionScale).toBeLessThan(1);
    expect(resolveSpectralPostProcessProfile(["wraith"], "low", true).enabled).toBe(false);
    expect(resolveSpectralPostProcessProfile(["wraith"], "high", false).enabled).toBe(false);
    expect(resolveSpectralPostProcessProfile([], "high", true).enabled).toBe(false);
  });
});
