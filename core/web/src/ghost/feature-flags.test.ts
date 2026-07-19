import { describe, expect, it } from "vitest";
import { DEFAULT_GHOST_FEATURE_FLAGS, resolveGhostFeatureFlags } from "./feature-flags";

describe("Spectral V3 feature flags", () => {
  it("uses the continuous body and current style renderers by default", () => {
    expect(resolveGhostFeatureFlags()).toEqual(DEFAULT_GHOST_FEATURE_FLAGS);
  });

  it("allows each path to be rolled back independently", () => {
    expect(resolveGhostFeatureFlags("?ghost-body-v3=0")).toEqual({ bodyV3: false, renderV3: true, fantasyV5: true, cyberV6: true });
    expect(resolveGhostFeatureFlags("?ghost-render-v3=false")).toEqual({ bodyV3: true, renderV3: false, fantasyV5: true, cyberV6: true });
    expect(resolveGhostFeatureFlags("?ghost-fantasy-v5=0")).toEqual({ bodyV3: true, renderV3: true, fantasyV5: false, cyberV6: true });
    expect(resolveGhostFeatureFlags("?ghost-cyber-v6=false")).toEqual({ bodyV3: true, renderV3: true, fantasyV5: true, cyberV6: false });
  });

  it("ignores malformed rollback values", () => {
    expect(resolveGhostFeatureFlags("?ghost-body-v3=maybe")).toEqual(DEFAULT_GHOST_FEATURE_FLAGS);
  });
});
