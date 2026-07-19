export interface GhostFeatureFlags {
  bodyV3: boolean;
  renderV3: boolean;
  fantasyV5: boolean;
  cyberV6: boolean;
}

export const DEFAULT_GHOST_FEATURE_FLAGS: Readonly<GhostFeatureFlags> = Object.freeze({
  bodyV3: true,
  renderV3: true,
  fantasyV5: true,
  cyberV6: true,
});

function resolved(value: string | null, fallback: boolean): boolean {
  if (value === null) return fallback;
  if (value === "0" || value === "false") return false;
  if (value === "1" || value === "true") return true;
  return fallback;
}

/** Production defaults to the continuous body. Query flags remain as an emergency rollback. */
export function resolveGhostFeatureFlags(search = ""): GhostFeatureFlags {
  const params = new URLSearchParams(search);
  return {
    bodyV3: resolved(params.get("ghost-body-v3"), DEFAULT_GHOST_FEATURE_FLAGS.bodyV3),
    renderV3: resolved(params.get("ghost-render-v3"), DEFAULT_GHOST_FEATURE_FLAGS.renderV3),
    fantasyV5: resolved(params.get("ghost-fantasy-v5"), DEFAULT_GHOST_FEATURE_FLAGS.fantasyV5),
    cyberV6: resolved(params.get("ghost-cyber-v6"), DEFAULT_GHOST_FEATURE_FLAGS.cyberV6),
  };
}
