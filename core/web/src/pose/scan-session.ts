import type { Landmark, ScanViewAngle } from "../models/types";

/** 视觉外壳需要的四个朝向（度） */
export const AZIMUTH_BUCKETS = [0, 90, 180, 270] as const;
export type AzimuthBucket = (typeof AZIMUTH_BUCKETS)[number];

export const STABLE_CAPTURE_MS = 800;
export const MIN_MASK_QUALITY = 0.38;
/** 至少 3 个朝向达到质量阈值即视为信息充分 */
export const MIN_BUCKETS_FOR_COMPLETE = 3;

const BUCKET_LABELS: Record<AzimuthBucket, string> = {
  0: "正面",
  90: "右侧",
  180: "背面",
  270: "左侧",
};

export interface CoverageSlot {
  azimuth: AzimuthBucket;
  label: string;
  quality: number;
  captured: boolean;
}

export interface ScanCoverageState {
  slots: CoverageSlot[];
  overallPercent: number;
  capturedCount: number;
  isComplete: boolean;
  guidance: string;
}

export function azimuthToScanAngle(azimuth: AzimuthBucket): ScanViewAngle {
  switch (azimuth) {
    case 0:
      return "front";
    case 90:
      return "right";
    case 180:
      return "back";
    case 270:
      return "left";
    default:
      return "front";
  }
}

/** 由双肩相对深度估计身体朝向，映射到 0/90/180/270 */
export function estimateBodyAzimuth(landmarks: Landmark[]): AzimuthBucket | null {
  const left = landmarks[11];
  const right = landmarks[12];
  if (!left || !right || left.visibility < 0.35 || right.visibility < 0.35) {
    return null;
  }

  const dx = right.x - left.x;
  const dz = right.z - left.z;
  let deg = (Math.atan2(dz, dx) * 180) / Math.PI;
  deg = ((deg + 360) % 360);

  let best: AzimuthBucket = 0;
  let minDist = 999;
  for (const bucket of AZIMUTH_BUCKETS) {
    const dist = Math.abs(((deg - bucket + 180) % 360) - 180);
    if (dist < minDist) {
      minDist = dist;
      best = bucket;
    }
  }

  // 朝向与桶偏差过大时不采信，避免斜角误记
  if (minDist > 42) {
    return null;
  }
  return best;
}

/** 二值 mask 质量：垂直覆盖 + 面积占比 */
export function scoreBinaryMask(mask: Uint8Array, width: number, height: number): number {
  let minY = height;
  let maxY = 0;
  let count = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (mask[y * width + x]) {
        count += 1;
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }
  if (count === 0) {
    return 0;
  }
  const verticalSpan = (maxY - minY) / height;
  const areaRatio = count / (width * height);
  return Math.min(1, verticalSpan * 0.65 + Math.min(areaRatio * 12, 1) * 0.35);
}

export function buildCoverageState(qualities: Map<AzimuthBucket, number>): ScanCoverageState {
  const slots: CoverageSlot[] = AZIMUTH_BUCKETS.map((azimuth) => {
    const quality = qualities.get(azimuth) ?? 0;
    return {
      azimuth,
      label: BUCKET_LABELS[azimuth],
      quality,
      captured: quality >= MIN_MASK_QUALITY,
    };
  });

  const capturedCount = slots.filter((slot) => slot.captured).length;
  const overallPercent = Math.round(
    (slots.reduce((sum, slot) => sum + Math.min(slot.quality / MIN_MASK_QUALITY, 1), 0) / slots.length) * 100,
  );

  const isComplete = capturedCount >= MIN_BUCKETS_FOR_COMPLETE;
  const guidance = computeGuidance(slots, capturedCount);

  return { slots, overallPercent, capturedCount, isComplete, guidance };
}

function computeGuidance(slots: CoverageSlot[], capturedCount: number): string {
  if (capturedCount >= MIN_BUCKETS_FOR_COMPLETE) {
    return "轮廓信息已足够，正在生成虚像…";
  }

  const missing = slots.filter((slot) => !slot.captured).map((slot) => slot.label);
  if (capturedCount === 0) {
    return "请面对镜头站立，后退一步让头到脚都在画面中，然后缓慢转身一周。";
  }
  if (missing.length > 0) {
    return `请转向：${missing.join("、")}，保持全身在画面内，不必站定倒计时。`;
  }
  return "继续缓慢转身，补全尚未覆盖的朝向。";
}
