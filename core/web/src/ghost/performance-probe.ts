import type { AvatarPose, GhostStyleId, Landmark } from "../models/types";
import { summarizeGhostFrameWindow, type GhostQualityTier } from "./quality-controller";

export const PHONE_FPS_TARGET = 30;
export const PHONE_FPS_SAMPLE_MS = 5_000;

export interface FrameRateSummary {
  fps: number;
  frameCount: number;
  durationMs: number;
  slowFramePercent: number;
  p95FrameMs: number;
  p95WindowFrames: number;
  renderStats?: GhostRenderPerformanceStats;
  passed: boolean;
}

export interface GhostRenderPerformanceStats {
  drawCalls: number;
  triangles: number;
  pixelRatio: number;
  qualityTier: GhostQualityTier;
  recommendedTier: GhostQualityTier;
  lodIndex: number;
  postProcessing: {
    enabled: boolean;
    family: "none" | "fantasy" | "cyber" | "mixed";
    strength: number;
    resolutionScale: number;
    antiAliasingSamples: number;
    version: string;
  };
}

export function summarizeFrameTimestamps(
  timestamps: number[],
  renderStats?: GhostRenderPerformanceStats,
): FrameRateSummary {
  if (timestamps.length < 2) {
    return {
      fps: 0,
      frameCount: timestamps.length,
      durationMs: 0,
      slowFramePercent: 100,
      p95FrameMs: 0,
      p95WindowFrames: 0,
      renderStats,
      passed: false,
    };
  }
  const durationMs = timestamps[timestamps.length - 1] - timestamps[0];
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return {
      fps: 0,
      frameCount: timestamps.length,
      durationMs: 0,
      slowFramePercent: 100,
      p95FrameMs: 0,
      p95WindowFrames: 0,
      renderStats,
      passed: false,
    };
  }
  const intervals = timestamps.slice(1).map((timestamp, index) => timestamp - timestamps[index]);
  const frameWindow = summarizeGhostFrameWindow(intervals);
  const fps = ((timestamps.length - 1) * 1_000) / durationMs;
  return {
    fps,
    frameCount: timestamps.length - 1,
    durationMs,
    slowFramePercent: frameWindow.slowFramePercent,
    p95FrameMs: frameWindow.p95FrameMs,
    p95WindowFrames: frameWindow.frameCount,
    renderStats,
    passed: fps >= PHONE_FPS_TARGET
      && frameWindow.p95FrameMs <= 40
      && frameWindow.slowFramePercent <= 5,
  };
}

export function measureAnimationFrameRate(
  durationMs = PHONE_FPS_SAMPLE_MS,
  signal?: AbortSignal,
  onProgress?: (progress: number) => void,
  renderStats?: () => GhostRenderPerformanceStats,
): Promise<FrameRateSummary> {
  return new Promise((resolve, reject) => {
    const timestamps: number[] = [];
    let firstTimestamp: number | null = null;
    let animationFrame = 0;
    const cleanup = () => {
      if (animationFrame) cancelAnimationFrame(animationFrame);
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(new DOMException("FPS test cancelled.", "AbortError"));
    };
    const sample = (timestamp: number) => {
      if (signal?.aborted) {
        abort();
        return;
      }
      firstTimestamp ??= timestamp;
      timestamps.push(timestamp);
      const elapsed = timestamp - firstTimestamp;
      onProgress?.(Math.min(1, elapsed / Math.max(durationMs, 1)));
      if (elapsed >= durationMs) {
        cleanup();
        resolve(summarizeFrameTimestamps(timestamps, renderStats?.()));
        return;
      }
      animationFrame = requestAnimationFrame(sample);
    };
    signal?.addEventListener("abort", abort, { once: true });
    animationFrame = requestAnimationFrame(sample);
  });
}

function performanceLandmarks(variant: "standing" | "extreme" = "standing"): Landmark[] {
  const landmarks = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0 }));
  const set = (index: number, x: number, y: number, z = 0) => {
    landmarks[index] = { x, y, z, visibility: 1 };
  };
  set(0, 0, -0.43, -0.02);
  set(7, -0.045, -0.4);
  set(8, 0.045, -0.4);
  set(11, -0.13, -0.28);
  set(12, 0.13, -0.28);
  set(13, -0.2, -0.03);
  set(14, 0.2, -0.03);
  set(15, -0.2, 0.19);
  set(16, 0.2, 0.19);
  set(23, -0.09, 0.015);
  set(24, 0.09, 0.015);
  set(25, -0.085, 0.27);
  set(26, 0.085, 0.27);
  set(27, -0.08, 0.51);
  set(28, 0.08, 0.51);
  set(17, -0.2, 0.27);
  set(19, -0.2, 0.3);
  set(21, -0.19, 0.28);
  set(18, 0.2, 0.27);
  set(20, 0.2, 0.3);
  set(22, 0.19, 0.28);
  if (variant === "extreme") {
    set(13, -0.22, -0.44);
    set(15, -0.16, -0.62);
    set(14, 0.25, -0.12, -0.04);
    set(16, 0.13, -0.28, -0.08);
    set(25, -0.16, 0.31);
    set(26, 0.16, 0.31);
    set(27, -0.22, 0.52);
    set(28, 0.22, 0.52);
    set(17, -0.16, -0.76);
    set(19, -0.15, -0.79);
    set(21, -0.14, -0.75);
    set(18, 0.08, -0.38, -0.08);
    set(20, 0.06, -0.41, -0.08);
    set(22, 0.09, -0.4, -0.08);
  }
  return landmarks;
}

export function createPerformancePose(
  style: GhostStyleId = "wraith",
  variant: "standing" | "extreme" = "standing",
): AvatarPose {
  return {
    id: `phone-fps-${style}-${variant}`,
    label: "手机性能验收",
    style,
    landmarks: performanceLandmarks(variant),
    views: [],
    schema: "mediapipe-33",
    createdAt: "2026-07-17T00:00:00.000Z",
  };
}
