import type { Landmark, ScanViewAngle } from "../models/types";

/** 视觉外壳需要的四个朝向（度） */
export const AZIMUTH_BUCKETS = [0, 90, 180, 270] as const;
export type AzimuthBucket = (typeof AZIMUTH_BUCKETS)[number];

export const STABLE_CAPTURE_MS = 800;
export const MIN_MASK_QUALITY = 0.38;
export const FRAMES_PER_ORIENTATION = 5;
/** 至少 3 个朝向达到质量阈值即视为信息充分 */
export const MIN_BUCKETS_FOR_COMPLETE = 4;
export const MAX_JOINT_SIGNATURE_DEVIATION = 25;
export const POSE_MISMATCH_GUIDANCE = "姿势和正面不一致，请保持同一姿势转身。";

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
export function scoreBinaryMask(
  mask: Uint8Array,
  width: number,
  height: number,
  allowClipped = false,
): number {
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
  const clipped = minY <= 1 || maxY >= height - 2;
  const score = Math.min(1, verticalSpan * 0.65 + Math.min(areaRatio * 12, 1) * 0.35);
  return clipped && !allowClipped ? score * 0.35 : score;
}

/** A complete frontal/back view plus an orthogonal side view is enough to retain scanned legs. */
export function hasOrthogonalFullBodyCoverage(
  orientations: Array<{ azimuth: number; partial?: boolean }>,
): boolean {
  const complete = new Set(
    orientations
      .filter((orientation) => !orientation.partial)
      .map((orientation) => orientation.azimuth),
  );
  const frontal = complete.has(0) || complete.has(180);
  const lateral = complete.has(90) || complete.has(270);
  return frontal && lateral;
}

interface Vector3 {
  x: number;
  y: number;
  z: number;
}

function vector(from: Landmark, to: Landmark): Vector3 {
  return { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
}

function angleBetween(a: Vector3, b: Vector3): number {
  const aLength = Math.hypot(a.x, a.y, a.z);
  const bLength = Math.hypot(b.x, b.y, b.z);
  if (aLength < 1e-6 || bLength < 1e-6) return Number.NaN;
  const cosine = Math.max(-1, Math.min(1, (a.x * b.x + a.y * b.y + a.z * b.z) / (aLength * bLength)));
  return (Math.acos(cosine) * 180) / Math.PI;
}

function visibleJoint(landmarks: Landmark[], index: number): Landmark | null {
  const landmark = landmarks[index];
  return landmark && landmark.visibility >= 0.35 ? landmark : null;
}

/**
 * 关节顺序：左/右肩外展、左/右肘弯、左/右髋外展、左/右膝弯。
 * 直臂直腿为 0° 弯曲，贴近身体的肩/髋外展为 0°。
 */
export function computeJointSignature(landmarks: Landmark[]): number[] {
  const upper = computeUpperBodyJointSignature(landmarks);
  if (upper.length !== 4) return [];
  const required = [11, 12, 23, 24, 25, 26, 27, 28]
    .map((index) => visibleJoint(landmarks, index));
  if (required.some((landmark) => landmark === null)) return [];

  const [leftShoulder, rightShoulder, leftHip, rightHip,
    leftKnee, rightKnee, leftAnkle, rightAnkle] = required as Landmark[];
  const neck: Landmark = {
    x: (leftShoulder.x + rightShoulder.x) / 2,
    y: (leftShoulder.y + rightShoulder.y) / 2,
    z: (leftShoulder.z + rightShoulder.z) / 2,
    visibility: Math.min(leftShoulder.visibility, rightShoulder.visibility),
  };
  const pelvis: Landmark = {
    x: (leftHip.x + rightHip.x) / 2,
    y: (leftHip.y + rightHip.y) / 2,
    z: (leftHip.z + rightHip.z) / 2,
    visibility: Math.min(leftHip.visibility, rightHip.visibility),
  };
  const bodyDown = vector(neck, pelvis);
  const signature = [
    ...upper,
    angleBetween(bodyDown, vector(leftHip, leftKnee)),
    angleBetween(bodyDown, vector(rightHip, rightKnee)),
    jointFlexion(leftHip, leftKnee, leftAnkle),
    jointFlexion(rightHip, rightKnee, rightAnkle),
  ];
  return signature.every(Number.isFinite) ? signature : [];
}

function jointFlexion(proximal: Landmark, joint: Landmark, distal: Landmark): number {
  return 180 - angleBetween(vector(joint, proximal), vector(joint, distal));
}

/** 上半身可见时使用的四角签名，供半身照片继续执行姿势一致性门。 */
export function computeUpperBodyJointSignature(landmarks: Landmark[]): number[] {
  const required = [11, 12, 13, 14, 15, 16, 23, 24]
    .map((index) => visibleJoint(landmarks, index));
  if (required.some((landmark) => landmark === null)) return [];
  const [leftShoulder, rightShoulder, leftElbow, rightElbow, leftWrist, rightWrist,
    leftHip, rightHip] = required as Landmark[];
  const neck: Landmark = {
    x: (leftShoulder.x + rightShoulder.x) / 2,
    y: (leftShoulder.y + rightShoulder.y) / 2,
    z: (leftShoulder.z + rightShoulder.z) / 2,
    visibility: Math.min(leftShoulder.visibility, rightShoulder.visibility),
  };
  const pelvis: Landmark = {
    x: (leftHip.x + rightHip.x) / 2,
    y: (leftHip.y + rightHip.y) / 2,
    z: (leftHip.z + rightHip.z) / 2,
    visibility: Math.min(leftHip.visibility, rightHip.visibility),
  };
  const bodyDown = vector(neck, pelvis);
  const signature = [
    angleBetween(bodyDown, vector(leftShoulder, leftElbow)),
    angleBetween(bodyDown, vector(rightShoulder, rightElbow)),
    jointFlexion(leftShoulder, leftElbow, leftWrist),
    jointFlexion(rightShoulder, rightElbow, rightWrist),
  ];
  return signature.every(Number.isFinite) ? signature : [];
}

/**
 * 照片可能由前后镜像或侧面透视导致左右肢体标签互换、肩角被压缩。
 * 因此用手腕相对肩/髋的抬手等级配合肘部弯曲，并将左右排序。
 * 这仍能拦截抬手/弯肘变化，但不会误判同一姿势的侧视图。
 */
export function computePhotoPoseSignature(landmarks: Landmark[]): number[] {
  const signature = computeUpperBodyJointSignature(landmarks);
  if (signature.length !== 4) return [];
  const required = [11, 12, 15, 16, 23, 24]
    .map((index) => visibleJoint(landmarks, index));
  if (required.some((landmark) => landmark === null)) return [];
  const [leftShoulder, rightShoulder, leftWrist, rightWrist, leftHip, rightHip] = required as Landmark[];
  const elevation = (shoulder: Landmark, wrist: Landmark, hip: Landmark): number => {
    if (wrist.y < shoulder.y) return 90;
    if (wrist.y < hip.y) return 45;
    return 0;
  };
  const elevationLevels = [
    elevation(leftShoulder, leftWrist, leftHip),
    elevation(rightShoulder, rightWrist, rightHip),
  ].sort((a, b) => a - b);
  const elbowAngles = signature.slice(2, 4).sort((a, b) => a - b);
  return [...elevationLevels, ...elbowAngles];
}

/** 最大关节角差；签名缺失或长度不一致视为不可比较。 */
export function signatureDeviation(reference: number[], candidate: number[]): number {
  if (reference.length === 0 || reference.length !== candidate.length) return Number.POSITIVE_INFINITY;
  return reference.reduce((maximum, angle, index) => (
    Math.max(maximum, Math.abs(angle - candidate[index]))
  ), 0);
}

/** 身体主轴相对画面竖直向上的有符号夹角；向右倾为正。 */
export function computeBodyTilt(landmarks: Landmark[]): number {
  const leftShoulder = visibleJoint(landmarks, 11);
  const rightShoulder = visibleJoint(landmarks, 12);
  const leftHip = visibleJoint(landmarks, 23);
  const rightHip = visibleJoint(landmarks, 24);
  if (!leftShoulder || !rightShoulder || !leftHip || !rightHip) return Number.NaN;
  const neckX = (leftShoulder.x + rightShoulder.x) / 2;
  const neckY = (leftShoulder.y + rightShoulder.y) / 2;
  const pelvisX = (leftHip.x + rightHip.x) / 2;
  const pelvisY = (leftHip.y + rightHip.y) / 2;
  const axisX = neckX - pelvisX;
  const axisY = neckY - pelvisY;
  if (Math.hypot(axisX, axisY) < 1e-6) return Number.NaN;
  return (Math.atan2(axisX, -axisY) * 180) / Math.PI;
}

/** 绕归一化图像中心旋转关键点；z 与可见度保持不变。 */
export function rotateLandmarksInImage(landmarks: Landmark[], degrees: number): Landmark[] {
  const radians = (degrees * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return landmarks.map((landmark) => {
    const x = landmark.x - 0.5;
    const y = landmark.y - 0.5;
    return {
      ...landmark,
      x: 0.5 + cosine * x - sine * y,
      y: 0.5 + sine * x + cosine * y,
    };
  });
}

export function countVisibleLandmarks(landmarks: Landmark[], threshold = 0.35): number {
  return landmarks.filter((landmark) => landmark.visibility >= threshold).length;
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
    return "双臂自然下垂或微微张开，扫描全程保持不动。请面对镜头站立，后退一步让头到脚都在画面中，然后缓慢转身一周。";
  }
  if (missing.length > 0) {
    return `请转向：${missing.join("、")}，保持全身在画面内，不必站定倒计时。`;
  }
  return "继续缓慢转身，补全尚未覆盖的朝向。";
}
