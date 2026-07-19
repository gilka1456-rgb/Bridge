export const GHOST_QUALITY_WINDOW_FRAMES = 120;
export const GHOST_QUALITY_DEGRADE_P95_MS = 40;
export const GHOST_QUALITY_UPGRADE_P95_MS = 27;
export const GHOST_QUALITY_SLOW_FRAME_MS = 1_000 / 30;
export const GHOST_QUALITY_DEGRADE_SLOW_PERCENT = 5;
export const GHOST_QUALITY_UPGRADE_HOLD_MS = 5_000;
export const GHOST_QUALITY_SWITCH_COOLDOWN_MS = 3_000;

export type GhostQualityTier = "high" | "medium" | "low";

const QUALITY_TIERS: readonly GhostQualityTier[] = ["high", "medium", "low"];

export interface GhostFrameWindow {
  frameCount: number;
  p95FrameMs: number;
  slowFramePercent: number;
}

export interface GhostQualityRecommendation {
  atMs: number;
  from: GhostQualityTier;
  to: GhostQualityTier;
  reason: "p95" | "slow-frames" | "stable-headroom";
}

export interface GhostQualitySnapshot extends GhostFrameWindow {
  activeTier: GhostQualityTier;
  recommendedTier: GhostQualityTier;
  automaticSwitching: boolean;
  distanceLod: number;
  activeLod: number;
  recommendations: readonly GhostQualityRecommendation[];
}

export interface GhostQualityControllerOptions {
  initialTier?: GhostQualityTier;
  automaticSwitching?: boolean;
}

function percentile95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}

export function summarizeGhostFrameWindow(intervals: number[]): GhostFrameWindow {
  const window = intervals
    .filter((interval) => Number.isFinite(interval) && interval >= 0)
    .slice(-GHOST_QUALITY_WINDOW_FRAMES);
  if (window.length === 0) return { frameCount: 0, p95FrameMs: 0, slowFramePercent: 0 };
  const slowFrames = window.filter((interval) => interval > GHOST_QUALITY_SLOW_FRAME_MS).length;
  return {
    frameCount: window.length,
    p95FrameMs: percentile95(window),
    slowFramePercent: slowFrames / window.length * 100,
  };
}

export function qualityTierLodIndex(tier: GhostQualityTier): number {
  return QUALITY_TIERS.indexOf(tier);
}

function adjacentTier(tier: GhostQualityTier, delta: -1 | 1): GhostQualityTier {
  return QUALITY_TIERS[Math.max(0, Math.min(QUALITY_TIERS.length - 1, qualityTierLodIndex(tier) + delta))];
}

export function resolveDistanceLodIndex(
  distanceMeters: number,
  currentLod: number,
  availableLods: number,
): number {
  const maximum = Math.max(0, availableLods - 1);
  const distance = Math.max(0, distanceMeters);
  let resolved = Math.max(0, Math.min(maximum, Math.trunc(currentLod)));
  if (resolved === 0 && distance > 4.4) resolved = 1;
  else if (resolved === 1 && distance < 3.6) resolved = 0;
  else if (resolved === 1 && distance > 8.6) resolved = 2;
  else if (resolved === 2 && distance < 7.4) resolved = 1;
  return Math.min(maximum, resolved);
}

/**
 * Records recommendations first. Automatic switching remains opt-in until real
 * iPhone evidence proves that the thresholds are stable.
 */
export class GhostQualityController {
  private readonly automaticSwitching: boolean;
  private readonly intervals: number[] = [];
  private readonly recommendationLog: GhostQualityRecommendation[] = [];
  private lastTimestamp: number | null = null;
  private lastRecommendationAt = -Infinity;
  private stableHeadroomSince: number | null = null;
  private activeTier: GhostQualityTier;
  private recommendedTier: GhostQualityTier;
  private distanceLod = 0;
  private activeLod = 0;

  constructor(options: GhostQualityControllerOptions = {}) {
    this.activeTier = options.initialTier ?? "high";
    this.recommendedTier = this.activeTier;
    this.automaticSwitching = options.automaticSwitching ?? false;
  }

  recordFrame(timestampMs: number): GhostQualitySnapshot {
    if (this.lastTimestamp !== null) {
      const interval = timestampMs - this.lastTimestamp;
      if (Number.isFinite(interval) && interval >= 0 && interval < 1_000) {
        this.intervals.push(interval);
        if (this.intervals.length > GHOST_QUALITY_WINDOW_FRAMES) this.intervals.shift();
      }
    }
    this.lastTimestamp = timestampMs;
    const summary = summarizeGhostFrameWindow(this.intervals);
    if (summary.frameCount >= GHOST_QUALITY_WINDOW_FRAMES) {
      const cooldownReady = timestampMs - this.lastRecommendationAt >= GHOST_QUALITY_SWITCH_COOLDOWN_MS;
      const p95Pressure = summary.p95FrameMs > GHOST_QUALITY_DEGRADE_P95_MS;
      const slowPressure = summary.slowFramePercent > GHOST_QUALITY_DEGRADE_SLOW_PERCENT;
      if ((p95Pressure || slowPressure) && cooldownReady) {
        this.stableHeadroomSince = null;
        this.recommend(adjacentTier(this.recommendedTier, 1), timestampMs, p95Pressure ? "p95" : "slow-frames");
      } else if (
        summary.p95FrameMs < GHOST_QUALITY_UPGRADE_P95_MS
        && summary.slowFramePercent < 1
      ) {
        this.stableHeadroomSince ??= timestampMs;
        if (
          timestampMs - this.stableHeadroomSince >= GHOST_QUALITY_UPGRADE_HOLD_MS
          && cooldownReady
        ) {
          this.recommend(adjacentTier(this.recommendedTier, -1), timestampMs, "stable-headroom");
          this.stableHeadroomSince = timestampMs;
        }
      } else {
        this.stableHeadroomSince = null;
      }
    }
    return this.snapshot();
  }

  resolveLodIndex(distanceMeters: number, availableLods: number, forcedLod?: number): number {
    const maximum = Math.max(0, availableLods - 1);
    if (forcedLod !== undefined) {
      this.activeLod = Math.max(0, Math.min(maximum, Math.trunc(forcedLod)));
      return this.activeLod;
    }
    this.distanceLod = resolveDistanceLodIndex(distanceMeters, this.distanceLod, availableLods);
    this.activeLod = Math.min(maximum, Math.max(this.distanceLod, qualityTierLodIndex(this.activeTier)));
    return this.activeLod;
  }

  snapshot(): GhostQualitySnapshot {
    return {
      ...summarizeGhostFrameWindow(this.intervals),
      activeTier: this.activeTier,
      recommendedTier: this.recommendedTier,
      automaticSwitching: this.automaticSwitching,
      distanceLod: this.distanceLod,
      activeLod: this.activeLod,
      recommendations: this.recommendationLog.slice(),
    };
  }

  private recommend(to: GhostQualityTier, atMs: number, reason: GhostQualityRecommendation["reason"]): void {
    if (to === this.recommendedTier) return;
    const from = this.recommendedTier;
    this.recommendedTier = to;
    this.lastRecommendationAt = atMs;
    this.recommendationLog.push({ atMs, from, to, reason });
    if (this.automaticSwitching) this.activeTier = to;
  }
}
