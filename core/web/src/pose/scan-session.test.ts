import { describe, expect, it } from "vitest";
import type { Landmark } from "../models/types";
import {
  buildCoverageState,
  estimateBodyAzimuth,
  MIN_MASK_QUALITY,
  scoreBinaryMask,
} from "./scan-session";

function shoulders(left: Partial<Landmark>, right: Partial<Landmark>): Landmark[] {
  const landmarks = Array.from({ length: 13 }, () => ({
    x: 0,
    y: 0,
    z: 0,
    visibility: 1,
  }));
  landmarks[11] = { ...landmarks[11], ...left };
  landmarks[12] = { ...landmarks[12], ...right };
  return landmarks;
}

describe("scan coverage", () => {
  it("scores empty and full-height masks", () => {
    expect(scoreBinaryMask(new Uint8Array(16), 4, 4)).toBe(0);
    expect(scoreBinaryMask(new Uint8Array(16).fill(1), 4, 4)).toBeGreaterThan(0.7);
  });

  it("completes after three quality orientations", () => {
    const state = buildCoverageState(
      new Map([
        [0, MIN_MASK_QUALITY],
        [90, MIN_MASK_QUALITY],
        [180, MIN_MASK_QUALITY],
      ]),
    );
    expect(state.capturedCount).toBe(3);
    expect(state.isComplete).toBe(true);
    expect(state.guidance).toContain("信息已足够");
  });

  it("ignores shoulders with poor visibility", () => {
    expect(
      estimateBodyAzimuth(shoulders({ visibility: 0.2 }, { x: 1, visibility: 1 })),
    ).toBeNull();
  });

  it("maps clear shoulder directions to cardinal buckets", () => {
    expect(estimateBodyAzimuth(shoulders({ x: 0 }, { x: 1 }))).toBe(0);
    expect(estimateBodyAzimuth(shoulders({ z: 0 }, { z: 1 }))).toBe(90);
  });
});
