import { describe, expect, it } from "vitest";
import {
  VISUAL_BASELINE_FIXED_TIME,
  VISUAL_BASELINE_VERSION,
  resolveVisualBaselineConfig,
} from "./visual-baseline";

describe("visual baseline configuration", () => {
  it("uses a deterministic default state", () => {
    expect(VISUAL_BASELINE_VERSION).toBe("spectral-v3-v0");
    expect(VISUAL_BASELINE_FIXED_TIME).toBe(2.75);
    expect(resolveVisualBaselineConfig("?visual-baseline=1")).toEqual({
      style: "wraith",
      background: "black",
      angle: 0,
    });
  });

  it("accepts only manifest-approved states", () => {
    expect(resolveVisualBaselineConfig("?style=phantom&background=black&angle=180")).toEqual({
      style: "phantom",
      background: "black",
      angle: 180,
    });
    expect(resolveVisualBaselineConfig("?style=cyber&background=white&angle=315")).toEqual({
      style: "cyber",
      background: "white",
      angle: 315,
    });
    expect(resolveVisualBaselineConfig("?style=quantum&background=red&angle=42")).toEqual({
      style: "wraith",
      background: "black",
      angle: 0,
    });
  });

  it("keeps the V3 body feature flag orthogonal to the capture state", () => {
    expect(resolveVisualBaselineConfig("?ghost-body-v3=1&style=cyber&angle=90")).toEqual({
      style: "cyber",
      background: "black",
      angle: 90,
    });
  });
});
