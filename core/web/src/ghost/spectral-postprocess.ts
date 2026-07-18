import type { GhostStyleId } from "../models/types";
import type { GhostQualityTier } from "./quality-controller";

export const SPECTRAL_POSTPROCESS_VERSION = "spectral-post-v1-1-msaa-style-aware-bloom" as const;

export interface SpectralPostProcessProfile {
  enabled: boolean;
  family: "none" | "fantasy" | "cyber" | "mixed";
  strength: number;
  radius: number;
  threshold: number;
  resolutionScale: number;
  antiAliasingSamples: number;
}

const DISABLED_PROFILE: SpectralPostProcessProfile = Object.freeze({
  enabled: false,
  family: "none",
  strength: 0,
  radius: 0,
  threshold: 1,
  resolutionScale: 1,
  antiAliasingSamples: 0,
});

const HIGH_QUALITY_PROFILES: Readonly<Record<"fantasy" | "cyber" | "mixed", SpectralPostProcessProfile>> = Object.freeze({
  fantasy: Object.freeze({
    enabled: true,
    family: "fantasy",
    strength: 0.34,
    radius: 0.68,
    threshold: 0.64,
    resolutionScale: 1,
    antiAliasingSamples: 4,
  }),
  cyber: Object.freeze({
    enabled: true,
    family: "cyber",
    strength: 0.22,
    radius: 0.22,
    threshold: 0.72,
    resolutionScale: 1,
    antiAliasingSamples: 4,
  }),
  mixed: Object.freeze({
    enabled: true,
    family: "mixed",
    strength: 0.28,
    radius: 0.44,
    threshold: 0.68,
    resolutionScale: 1,
    antiAliasingSamples: 4,
  }),
});

function resolveFamily(styles: readonly GhostStyleId[]): SpectralPostProcessProfile["family"] {
  const fantasy = styles.some((style) => style === "wraith" || style === "phantom");
  const cyber = styles.some((style) => style === "cyber" || style === "quantum");
  if (fantasy && cyber) return "mixed";
  if (fantasy) return "fantasy";
  if (cyber) return "cyber";
  return "none";
}

/**
 * The glow is deliberately restrained: materials still own form and color,
 * while post processing only softens energy that is already bright. Opaque
 * output is required because UnrealBloom's mip composite does not preserve a
 * camera-feed alpha channel reliably.
 */
export function resolveSpectralPostProcessProfile(
  styles: readonly GhostStyleId[],
  qualityTier: GhostQualityTier,
  opaqueOutput: boolean,
): SpectralPostProcessProfile {
  const family = resolveFamily(styles);
  if (!opaqueOutput || qualityTier === "low" || family === "none") return DISABLED_PROFILE;
  const high = HIGH_QUALITY_PROFILES[family];
  if (qualityTier === "high") return high;
  return {
    ...high,
    strength: high.strength * 0.68,
    threshold: Math.min(0.9, high.threshold + 0.06),
    resolutionScale: 0.72,
    antiAliasingSamples: 2,
  };
}

export function resolveSpectralPostProcessSamples(
  requestedSamples: number,
  deviceMaximumSamples: number,
): number {
  const requested = Math.max(0, Math.trunc(Number.isFinite(requestedSamples) ? requestedSamples : 0));
  const maximum = Math.max(0, Math.trunc(Number.isFinite(deviceMaximumSamples) ? deviceMaximumSamples : 0));
  const resolved = Math.min(requested, maximum);
  return resolved >= 2 ? resolved : 0;
}
