import { describe, expect, it } from "vitest";
import {
  GhostQualityController,
  summarizeGhostFrameWindow,
} from "./quality-controller";

describe("Spectral V4 quality controller", () => {
  it("reports a 120-frame P95 and slow-frame percentage", () => {
    const intervals = [...Array.from({ length: 114 }, () => 16), ...Array.from({ length: 6 }, () => 45)];
    const summary = summarizeGhostFrameWindow(intervals);
    expect(summary.frameCount).toBe(120);
    expect(summary.p95FrameMs).toBe(16);
    expect(summary.slowFramePercent).toBe(5);
  });

  it("uses distance hysteresis instead of oscillating around four and eight metres", () => {
    const controller = new GhostQualityController();
    expect(controller.resolveLodIndex(4.1, 3)).toBe(0);
    expect(controller.resolveLodIndex(4.5, 3)).toBe(1);
    expect(controller.resolveLodIndex(4.0, 3)).toBe(1);
    expect(controller.resolveLodIndex(3.5, 3)).toBe(0);
    expect(controller.resolveLodIndex(8.7, 3)).toBe(1);
    expect(controller.resolveLodIndex(8.7, 3)).toBe(2);
    expect(controller.resolveLodIndex(8.0, 3)).toBe(2);
    expect(controller.resolveLodIndex(7.3, 3)).toBe(1);
  });

  it("records degradation advice without enabling automatic switching", () => {
    const controller = new GhostQualityController();
    for (let frame = 0; frame <= 120; frame += 1) controller.recordFrame(frame * 45);
    const snapshot = controller.snapshot();
    expect(snapshot.recommendedTier).toBe("medium");
    expect(snapshot.activeTier).toBe("high");
    expect(snapshot.automaticSwitching).toBe(false);
    expect(snapshot.recommendations.at(-1)?.reason).toBe("p95");
  });

  it("can apply the same recommendation when explicitly enabled", () => {
    const controller = new GhostQualityController({ automaticSwitching: true });
    for (let frame = 0; frame <= 120; frame += 1) controller.recordFrame(frame * 45);
    expect(controller.snapshot().activeTier).toBe("medium");
    expect(controller.resolveLodIndex(2, 3)).toBe(1);
    expect(controller.resolveLodIndex(2, 3, 2)).toBe(2);
  });

  it("recovers only after sustained headroom without cascading to low", () => {
    const controller = new GhostQualityController({ automaticSwitching: true });
    let timestamp = 0;
    for (let frame = 0; frame <= 120; frame += 1) {
      controller.recordFrame(timestamp);
      timestamp += 45;
    }
    expect(controller.snapshot().activeTier).toBe("medium");

    for (let frame = 0; frame < 520; frame += 1) {
      controller.recordFrame(timestamp);
      timestamp += 16;
    }
    const recovered = controller.snapshot();
    expect(recovered.activeTier).toBe("high");
    expect(recovered.recommendations.map((entry) => entry.to)).toEqual(["medium", "high"]);
  });
});
