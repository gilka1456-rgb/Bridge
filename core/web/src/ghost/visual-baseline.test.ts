import { describe, expect, it } from "vitest";
import {
  VISUAL_BASELINE_FIXED_TIME,
  VISUAL_BASELINE_RUNTIME_VERSIONS,
  VISUAL_BASELINE_VERSION,
  resolveVisualBaselineConfig,
  resolveVisualBaselinePostProcessEvidence,
} from "./visual-baseline";
import { SPECTRAL_BODY_ALGORITHM_VERSION } from "./anatomical-body";
import {
  SPECTRAL_CYBER_VERSION,
  SPECTRAL_FANTASY_VERSION,
  SPECTRAL_RENDER_VERSION,
} from "./spectral-renderer";
import { SPECTRAL_POSTPROCESS_VERSION } from "./spectral-postprocess";

describe("visual baseline configuration", () => {
  it("uses a deterministic default state", () => {
    expect(VISUAL_BASELINE_VERSION).toBe("spectral-visual-evidence-v1");
    expect(VISUAL_BASELINE_FIXED_TIME).toBe(2.75);
    expect(resolveVisualBaselineConfig("?visual-baseline=1")).toEqual({
      style: "wraith",
      background: "black",
      angle: 0,
    });
  });

  it("binds every capture to the exact current body, renderer and style builds", () => {
    expect(VISUAL_BASELINE_RUNTIME_VERSIONS).toEqual({
      body: SPECTRAL_BODY_ALGORITHM_VERSION,
      render: SPECTRAL_RENDER_VERSION,
      fantasy: SPECTRAL_FANTASY_VERSION,
      cyber: SPECTRAL_CYBER_VERSION,
      postprocess: SPECTRAL_POSTPROCESS_VERSION,
    });
  });

  it("records the actual offscreen anti-aliasing result instead of the requested mode", () => {
    expect(resolveVisualBaselinePostProcessEvidence(true, true, 4))
      .toBe(`${SPECTRAL_POSTPROCESS_VERSION}-msaa4`);
    expect(resolveVisualBaselinePostProcessEvidence(true, false, 0)).toBe("post-off");
    expect(resolveVisualBaselinePostProcessEvidence(false, true, 4)).toBe("post-off");
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
    expect(resolveVisualBaselineConfig("?style=quantum&background=white&angle=90")).toEqual({
      style: "quantum",
      background: "white",
      angle: 90,
    });
    expect(resolveVisualBaselineConfig("?style=unknown&background=red&angle=42")).toEqual({
      style: "wraith",
      background: "black",
      angle: 0,
    });
    expect(resolveVisualBaselineConfig("?style=wraith&tint=%2335D07F")).toEqual({
      style: "wraith",
      background: "black",
      angle: 0,
      tint: "#35d07f",
    });
    expect(resolveVisualBaselineConfig("?style=wraith&tint=green")).toEqual({
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
