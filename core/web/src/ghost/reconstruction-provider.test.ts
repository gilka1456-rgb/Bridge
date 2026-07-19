import { describe, expect, it } from "vitest";
import type { OrientationMask } from "../models/types";
import { encodePersonMaskRLE } from "../pose/segmentation";
import { getHullGeometry } from "./hull-cache";
import {
  hashOrientationSource,
  LocalVisualHullProvider,
  meshKeyForSource,
} from "./reconstruction-provider";

function normalizedView(azimuth: number, halfWidth: number): OrientationMask {
  const width = 32;
  const height = 64;
  const mask = new Uint8Array(width * height);
  for (let y = 3; y < 61; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const torso = ((x - 16) / halfWidth) ** 2 + ((y - 29) / 23) ** 2 < 1;
      const head = ((x - 16) / Math.max(2, halfWidth * 0.42)) ** 2 + ((y - 6) / 4) ** 2 < 1;
      const legs = y > 43 && (
        Math.abs(x - (16 - halfWidth * 0.3)) < Math.max(1.5, halfWidth * 0.22)
        || Math.abs(x - (16 + halfWidth * 0.3)) < Math.max(1.5, halfWidth * 0.22)
      );
      if (torso || head || legs) mask[y * width + x] = 1;
    }
  }
  return {
    azimuth,
    width,
    height,
    mask: encodePersonMaskRLE(mask),
    normalized: true,
    personAspect: (halfWidth * 2 + 1) / 56,
    frameCount: 5,
    quality: 0.82,
  };
}

describe("local reconstruction provider", () => {
  it("uses an order-independent source hash", () => {
    const views = [normalizedView(0, 7), normalizedView(90, 4)];
    expect(hashOrientationSource(views)).toBe(hashOrientationSource([...views].reverse()));
  });

  it("includes v3 alignment and template parameters in cache identity", () => {
    const base = normalizedView(0, 7);
    const anchored = { ...base, anchor: { pelvis: { x: 128, y: 296 }, anchorHeight: 210 } };
    expect(hashOrientationSource([base])).not.toBe(hashOrientationSource([anchored]));
    expect(hashOrientationSource([base])).not.toBe(hashOrientationSource([{ ...base, partial: true }]));
    expect(meshKeyForSource("source", "slim")).not.toBe(meshKeyForSource("source", "broad"));
  });

  it("builds and reuses a complete cached mesh", async () => {
    const views = [
      normalizedView(0, 7),
      normalizedView(90, 4),
      normalizedView(180, 7),
      normalizedView(270, 4),
    ];
    const provider = new LocalVisualHullProvider();
    const progress: number[] = [];
    const first = await provider.reconstruct({ orientations: views }, undefined, (item) => progress.push(item.percent));
    const second = await provider.reconstruct({ orientations: [...views].reverse() });

    expect(first.meshKey).toBe(second.meshKey);
    expect(first.mesh.triangleCount).toBeGreaterThan(100);
    expect(first.quality).toBeGreaterThan(0.5);
    expect(progress.at(-1)).toBe(1);
    expect(getHullGeometry(first.meshKey)).toBeDefined();
  });
});
