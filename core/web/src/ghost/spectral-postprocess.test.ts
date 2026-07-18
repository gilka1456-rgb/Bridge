import { describe, expect, it } from "vitest";
import {
  resolveSpectralPostProcessProfile,
  resolveSpectralPostProcessSamples,
  SPECTRAL_BLOOM_HIGHLIGHT_FLOOR,
  SPECTRAL_POSTPROCESS_VERSION,
} from "./spectral-postprocess";
import { SPECTRAL_HIGHLIGHT_COMPRESSION } from "./spectral-renderer";

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
    expect(SPECTRAL_BLOOM_HIGHLIGHT_FLOOR)
      .toBeGreaterThan(SPECTRAL_HIGHLIGHT_COMPRESSION.threshold);
    expect(fantasy.threshold).toBeGreaterThanOrEqual(SPECTRAL_BLOOM_HIGHLIGHT_FLOOR);
    expect(cyber.threshold).toBeGreaterThanOrEqual(SPECTRAL_BLOOM_HIGHLIGHT_FLOOR);
    expect(fantasy.antiAliasingSamples).toBe(4);
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
    expect(medium.antiAliasingSamples).toBe(2);
    expect(resolveSpectralPostProcessProfile(["wraith"], "low", true).enabled).toBe(false);
    expect(resolveSpectralPostProcessProfile(["wraith"], "high", false).enabled).toBe(false);
    expect(resolveSpectralPostProcessProfile([], "high", true).enabled).toBe(false);
  });

  it("clamps offscreen MSAA to the device and bypasses unsupported one-sample targets", () => {
    expect(resolveSpectralPostProcessSamples(4, 8)).toBe(4);
    expect(resolveSpectralPostProcessSamples(4, 2)).toBe(2);
    expect(resolveSpectralPostProcessSamples(2, 1)).toBe(0);
    expect(resolveSpectralPostProcessSamples(4, Number.NaN)).toBe(0);
  });
});
