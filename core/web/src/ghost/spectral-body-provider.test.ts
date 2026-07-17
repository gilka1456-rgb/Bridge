import * as THREE from "three";
import { beforeEach, describe, expect, it } from "vitest";
import type { Landmark } from "../models/types";
import { buildBodySilhouetteGroup } from "./body-silhouette";
import {
  clearSpectralBodyCache,
  getBakedSpectralBodyLod,
  prepareSpectralBody,
  spectralBodyCacheKey,
} from "./spectral-body-provider";

function standingLandmarks(): Landmark[] {
  const landmarks = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0 }));
  const set = (index: number, x: number, y: number) => {
    landmarks[index] = { x, y, z: 0, visibility: 1 };
  };
  set(0, 0, -0.43);
  set(7, -0.045, -0.4);
  set(8, 0.045, -0.4);
  set(11, -0.13, -0.28);
  set(12, 0.13, -0.28);
  set(13, -0.18, -0.04);
  set(14, 0.18, -0.04);
  set(15, -0.19, 0.18);
  set(16, 0.19, 0.18);
  set(23, -0.09, 0.08);
  set(24, 0.09, 0.08);
  set(25, -0.085, 0.3);
  set(26, 0.085, 0.3);
  set(27, -0.08, 0.51);
  set(28, 0.08, 0.51);
  return landmarks;
}

describe("Spectral body provider", () => {
  beforeEach(() => clearSpectralBodyCache());

  it("uses a style-independent cache identity and exposes the prepared continuous body", async () => {
    const landmarks = standingLandmarks();
    const firstInput = { landmarks, avatarId: "fantasy-preview" };
    const secondInput = { landmarks, avatarId: "cyber-preview" };
    expect(spectralBodyCacheKey(firstInput)).toBe(spectralBodyCacheKey(secondInput));
    const widerLandmarks = standingLandmarks();
    widerLandmarks[11].x -= 0.03;
    widerLandmarks[12].x += 0.03;
    expect(spectralBodyCacheKey({ landmarks: widerLandmarks })).not.toBe(spectralBodyCacheKey(firstInput));

    const first = await prepareSpectralBody(firstInput);
    const second = await prepareSpectralBody(secondInput);
    expect(second).toBe(first);
    const firstBake = getBakedSpectralBodyLod(first, firstInput);
    const secondBake = getBakedSpectralBodyLod(second, secondInput);
    expect(secondBake).toBe(firstBake);

    const group = buildBodySilhouetteGroup(landmarks, "cyber", {
      avatarId: "cyber-preview",
      spectralBodyV3: true,
    });
    const body = group.getObjectByName("spectral-v3-anatomical") as THREE.Mesh | undefined;
    expect(body).toBeDefined();
    expect(body!.geometry.userData.templateMode).toBe("spectral-v3-anatomical");

    clearSpectralBodyCache();
    const restored = await prepareSpectralBody(secondInput);
    expect(restored).not.toBe(first);
    expect(restored.sourceHash).toBe(first.sourceHash);
    expect(restored.lods[0].skinWeights).toEqual(first.lods[0].skinWeights);
  }, 30_000);
});
