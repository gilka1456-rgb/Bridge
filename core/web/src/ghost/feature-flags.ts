export interface GhostFeatureFlags {
  bodyV3: boolean;
  renderV3: boolean;
  fantasyV5: boolean;
  cyberV6: boolean;
}

export const DEFAULT_GHOST_FEATURE_FLAGS: Readonly<GhostFeatureFlags> = Object.freeze({
  bodyV3: false,
  renderV3: false,
  fantasyV5: false,
  cyberV6: false,
});

function enabled(value: string | null): boolean {
  return value === "1" || value === "true";
}

/** Development-only query flags. Production behavior stays on the proven V2 path by default. */
export function resolveGhostFeatureFlags(search = ""): GhostFeatureFlags {
  const params = new URLSearchParams(search);
  return {
    bodyV3: enabled(params.get("ghost-body-v3")),
    renderV3: enabled(params.get("ghost-render-v3")),
    fantasyV5: enabled(params.get("ghost-fantasy-v5")),
    cyberV6: enabled(params.get("ghost-cyber-v6")),
  };
}
