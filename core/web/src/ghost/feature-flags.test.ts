import { describe, expect, it } from "vitest";
import { DEFAULT_GHOST_FEATURE_FLAGS, resolveGhostFeatureFlags } from "./feature-flags";

describe("Spectral V3 feature flags", () => {
  it("keeps both new paths off by default", () => {
    expect(resolveGhostFeatureFlags()).toEqual(DEFAULT_GHOST_FEATURE_FLAGS);
  });

  it("allows geometry and rendering to be enabled independently", () => {
    expect(resolveGhostFeatureFlags("?ghost-body-v3=1")).toEqual({ bodyV3: true, renderV3: false });
    expect(resolveGhostFeatureFlags("?ghost-render-v3=true")).toEqual({ bodyV3: false, renderV3: true });
  });
});
