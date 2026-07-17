import { describe, expect, it } from "vitest";
import {
  createPerformancePose,
  PHONE_FPS_TARGET,
  summarizeFrameTimestamps,
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
