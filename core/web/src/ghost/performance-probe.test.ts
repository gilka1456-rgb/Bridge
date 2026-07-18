import { describe, expect, it } from "vitest";
import {
  createPerformancePose,
  PHONE_FPS_SAMPLE_MS,
  PHONE_FPS_SINGLE_AVATAR_MS,
  PHONE_FPS_TARGET,
  PHONE_FPS_THERMAL_MS,
  PHONE_FPS_THREE_AVATAR_MS,
  PHONE_PERFORMANCE_MODES,
  resolvePhonePerformanceMode,
  summarizeFrameTimestamps,
  summarizeRenderPerformanceSamples,
  type GhostRenderPerformanceStats,
} from "./performance-probe";

describe("phone performance probe", () => {
  it("passes a stable 60 FPS sample", () => {
    const timestamps = Array.from({ length: 301 }, (_, index) => index * (1_000 / 60));
    const summary = summarizeFrameTimestamps(timestamps);
    expect(summary.fps).toBeCloseTo(60, 1);
    expect(summary.passed).toBe(true);
    expect(summary.slowFramePercent).toBe(0);
    expect(summary.p95FrameMs).toBeCloseTo(1_000 / 60, 5);
    expect(summary.p95WindowFrames).toBe(120);
  });

  it("fails a sample below the 30 FPS task-card target", () => {
    const timestamps = Array.from({ length: 101 }, (_, index) => index * 40);
    const summary = summarizeFrameTimestamps(timestamps);
    expect(summary.fps).toBeLessThan(PHONE_FPS_TARGET);
    expect(summary.passed).toBe(false);
    expect(summary.slowFramePercent).toBe(100);
    expect(summary.p95FrameMs).toBe(40);
  });

  it("exposes quick, formal, crowd, and thermal phone runs", () => {
    expect(PHONE_PERFORMANCE_MODES.quick).toMatchObject({ durationMs: PHONE_FPS_SAMPLE_MS, avatarCount: 1 });
    expect(PHONE_PERFORMANCE_MODES.single).toMatchObject({ durationMs: PHONE_FPS_SINGLE_AVATAR_MS, avatarCount: 1 });
    expect(PHONE_PERFORMANCE_MODES.triple).toMatchObject({ durationMs: PHONE_FPS_THREE_AVATAR_MS, avatarCount: 3 });
    expect(PHONE_PERFORMANCE_MODES.thermal).toMatchObject({ durationMs: PHONE_FPS_THERMAL_MS, avatarCount: 3 });
    expect(resolvePhonePerformanceMode("thermal").id).toBe("thermal");
    expect(resolvePhonePerformanceMode("unknown").id).toBe("quick");
    expect(resolvePhonePerformanceMode(null).id).toBe("quick");
  });

  it("preserves optional peak memory and summarizes quality degradation", () => {
    const timestamps = Array.from({ length: 181 }, (_, index) => index * (1_000 / 60));
    const sample = (lodIndex: number, pixelRatio: number, qualityTier: "high" | "medium" | "low"): GhostRenderPerformanceStats => ({
      drawCalls: 8,
      triangles: 24_000,
      pixelRatio,
      qualityTier,
      recommendedTier: qualityTier,
      lodIndex,
      postProcessing: {
        enabled: true,
        family: "cyber",
        strength: 0.5,
        resolutionScale: 1,
        antiAliasingSamples: 2,
        version: "test",
      },
    });
    const samples = [sample(0, 2, "high"), sample(1, 1.5, "medium"), sample(2, 1, "low")];
    const envelope = summarizeRenderPerformanceSamples(samples);
    const summary = summarizeFrameTimestamps(timestamps, samples[2], 123_456, envelope);
    expect(summary.peakMemoryBytes).toBe(123_456);
    expect(summary.renderEnvelope).toMatchObject({
      sampleCount: 3,
      maximumLodIndex: 2,
      minimumPixelRatio: 1,
      qualityTiersSeen: ["high", "medium", "low"],
    });
    expect(summary.renderEnvelope?.lod2SamplePercent).toBeCloseTo(100 / 3, 8);
  });

  it("creates the same complete template pose used by the renderer", () => {
    const pose = createPerformancePose("cyber");
    expect(pose.style).toBe("cyber");
    expect(pose.landmarks).toHaveLength(33);
    expect([0, 11, 12, 23, 24, 27, 28].every((index) => pose.landmarks[index].visibility === 1)).toBe(true);
  });

  it("provides a deterministic extreme pose for skinning regression", () => {
    const pose = createPerformancePose("wraith", "extreme");
    expect(pose.landmarks[15].y).toBeLessThan(pose.landmarks[0].y);
    expect(pose.landmarks[27].x).toBeLessThan(-0.2);
    expect(pose.landmarks[28].x).toBeGreaterThan(0.2);
  });
});
