import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { decodeAppearanceLuma, decodePersonMaskRLE } from "../pose/segmentation";
import {
  createVisualBaselineCaptureViews,
  VISUAL_BASELINE_FIXED_TIME,
  VISUAL_BASELINE_RUNTIME_VERSIONS,
  VISUAL_BASELINE_VERSION,
  resolveVisualBaselineConfig,
  resolveVisualBaselinePoseMode,
  resolveVisualBaselinePostProcessEvidence,
  resolveVisualBaselineTimeMode,
} from "./visual-baseline";
import { SPECTRAL_BODY_ALGORITHM_VERSION } from "./anatomical-body";
import {
  SPECTRAL_CYBER_VERSION,
  SPECTRAL_FANTASY_VERSION,
  SPECTRAL_RENDER_VERSION,
} from "./spectral-renderer";
import { SPECTRAL_POSTPROCESS_VERSION } from "./spectral-postprocess";
import { SPECTRAL_CAMERA_VERSION } from "./renderer";
import { SPECTRAL_APPEARANCE_FIELD_VERSION } from "./appearance-field";
import { createVisualHullSdfSampler } from "./visual-hull";

describe("visual baseline configuration", () => {
  it("uses a deterministic default state", () => {
    expect(VISUAL_BASELINE_VERSION).toBe("spectral-visual-evidence-v5-capture-grounded-hull");
    expect(VISUAL_BASELINE_FIXED_TIME).toBe(2.75);
    expect(resolveVisualBaselineConfig("?visual-baseline=1")).toEqual({
      style: "wraith",
      background: "black",
      angle: 0,
    });
  });

  it("replays the phone scan's anchored hull and compact appearance formats", () => {
    const views = createVisualBaselineCaptureViews();
    expect(views.map((view) => view.azimuth)).toEqual([0, 90, 180, 270]);
    for (const view of views) {
      expect(view).toMatchObject({
        width: 256,
        height: 512,
        appearanceWidth: 64,
        appearanceHeight: 128,
        normalized: true,
        anchor: { pelvis: { x: 128, y: 296 }, anchorHeight: 210 },
      });
      const mask = decodePersonMaskRLE(view.mask, view.width * view.height);
      const occupiedRatio = mask.reduce((sum, value) => sum + value, 0) / mask.length;
      expect(occupiedRatio).toBeGreaterThan(0.12);
      expect(occupiedRatio).toBeLessThan(0.34);
      expect(decodeAppearanceLuma(
        view.appearanceLuma ?? "",
        (view.appearanceWidth ?? 0) * (view.appearanceHeight ?? 0),
      )).not.toBeNull();
    }
    const sampler = createVisualHullSdfSampler(views);
    expect(sampler).not.toBeNull();
    expect(sampler?.(new THREE.Vector3(0, 0, 0))).toBeGreaterThan(0);
    expect(sampler?.(new THREE.Vector3(0, 0.9, 0))).toBeGreaterThan(0);
    expect(sampler?.(new THREE.Vector3(0.75, 0, 0))).toBeLessThan(0);
  });

  it("keeps still captures deterministic and exposes an explicit live evidence clock", () => {
    expect(resolveVisualBaselineTimeMode("?visual-baseline=1")).toEqual({
      fixedTimeSeconds: VISUAL_BASELINE_FIXED_TIME,
      label: "t2.75",
    });
    expect(resolveVisualBaselineTimeMode("?time=99")).toEqual({
      fixedTimeSeconds: 10,
      label: "t10.00",
    });
    expect(resolveVisualBaselineTimeMode("?live-time=1&time=2.75")).toEqual({
      label: "live",
    });
  });

  it("never labels the canonical body as an extreme pose", () => {
    expect(resolveVisualBaselinePoseMode("?pose=extreme")).toEqual({
      variant: "extreme",
      standardPose: false,
    });
    expect(resolveVisualBaselinePoseMode("?pose-bake=1")).toEqual({
      variant: "standing",
      standardPose: false,
    });
    expect(resolveVisualBaselinePoseMode("?visual-baseline=1")).toEqual({
      variant: "standing",
      standardPose: true,
    });
  });

  it("binds every capture to the exact current body, renderer and style builds", () => {
    expect(VISUAL_BASELINE_RUNTIME_VERSIONS).toEqual({
      body: SPECTRAL_BODY_ALGORITHM_VERSION,
      render: SPECTRAL_RENDER_VERSION,
      fantasy: SPECTRAL_FANTASY_VERSION,
      cyber: SPECTRAL_CYBER_VERSION,
      appearance: SPECTRAL_APPEARANCE_FIELD_VERSION,
      postprocess: SPECTRAL_POSTPROCESS_VERSION,
      camera: SPECTRAL_CAMERA_VERSION,
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
