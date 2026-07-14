import type { BodyProfileSlice, SilhouettePoint } from "../models/types";

export const PERSON_CATEGORY = 1;

/** 把 MediaPipe 类别 mask 二值化为人体掩码(1=人体,0=背景) */
export function binarizePersonMask(categoryMask: Uint8Array): Uint8Array {
  const binary = new Uint8Array(categoryMask.length);
  for (let i = 0; i < categoryMask.length; i += 1) {
    binary[i] = categoryMask[i] === PERSON_CATEGORY ? 1 : 0;
  }
  return binary;
}

/** 行程编码(RLE) + base64：压缩存储二值 mask。runs 以 0 值段起始 */
export function encodePersonMaskRLE(mask: Uint8Array): string {
  const runs: number[] = [];
  let current = 0;
  let count = 0;
  for (let i = 0; i < mask.length; i += 1) {
    const value = mask[i] ? 1 : 0;
    if (value === current) {
      count += 1;
    } else {
      runs.push(count);
      current = value;
      count = 1;
    }
  }
  runs.push(count);

  const bytes = new Uint8Array(new Uint32Array(runs).buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** RLE base64 解码回二值 mask */
export function decodePersonMaskRLE(encoded: string, length: number): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  const runs = new Uint32Array(bytes.buffer);
  const mask = new Uint8Array(length);
  let index = 0;
  let value = 0;
  for (let r = 0; r < runs.length; r += 1) {
    const count = runs[r];
    if (value === 1) {
      mask.fill(1, index, Math.min(index + count, length));
    }
    index += count;
    value ^= 1;
  }
  return mask;
}

export interface SegmentationCapture {
  contour: SilhouettePoint[];
  bodyProfile: BodyProfileSlice[];
}

/** 从 MediaPipe 分割 mask 提取人物外轮廓与垂直宽度 profile */
export function extractSegmentationCapture(
  mask: Uint8Array,
  width: number,
  height: number,
): SegmentationCapture | null {
  const contour = traceOuterContour(mask, width, height);
  if (contour.length < 12) {
    return null;
  }
  const simplified = simplifyContour(contour, 0.004);
  const bodyProfile = computeBodyProfile(mask, width, height);
  return { contour: simplified, bodyProfile };
}

function traceOuterContour(mask: Uint8Array, width: number, height: number): SilhouettePoint[] {
  const isPerson = (x: number, y: number) => mask[y * width + x] === PERSON_CATEGORY;

  let startX = -1;
  let startY = -1;
  outer: for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      if (isPerson(x, y) && !isPerson(x, y - 1)) {
        startX = x;
        startY = y;
        break outer;
      }
    }
  }

  if (startX < 0) {
    return [];
  }

  const dirs = [
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1],
  ];

  const points: SilhouettePoint[] = [];
  let x = startX;
  let y = startY;
  let dir = 0;
  const maxSteps = width * height * 2;
  let steps = 0;

  do {
    points.push({ x: x / width, y: y / height });
    let found = false;
    for (let offset = 0; offset < 8; offset += 1) {
      const checkDir = (dir + offset + 5) % 8;
      const nx = x + dirs[checkDir][0];
      const ny = y + dirs[checkDir][1];
      if (nx >= 0 && nx < width && ny >= 0 && ny < height && isPerson(nx, ny)) {
        x = nx;
        y = ny;
        dir = checkDir;
        found = true;
        break;
      }
    }
    if (!found) {
      break;
    }
    steps += 1;
  } while ((x !== startX || y !== startY || points.length < 3) && steps < maxSteps);

  return downsamplePoints(points, 3);
}

function downsamplePoints(points: SilhouettePoint[], step: number): SilhouettePoint[] {
  if (points.length <= step) {
    return points;
  }
  return points.filter((_, index) => index % step === 0);
}

function simplifyContour(points: SilhouettePoint[], tolerance: number): SilhouettePoint[] {
  if (points.length <= 8) {
    return points;
  }
  const simplified: SilhouettePoint[] = [];
  const stride = Math.max(1, Math.floor(points.length / 64));
  for (let index = 0; index < points.length; index += stride) {
    simplified.push(points[index]);
  }
  if (tolerance > 0 && simplified.length > 4) {
    return simplified.filter((point, index) => {
      const prev = simplified[(index - 1 + simplified.length) % simplified.length];
      return Math.hypot(point.x - prev.x, point.y - prev.y) > tolerance;
    });
  }
  return simplified;
}

function computeBodyProfile(mask: Uint8Array, width: number, height: number): BodyProfileSlice[] {
  const slices: BodyProfileSlice[] = [];
  const rows = 24;
  for (let row = 0; row < rows; row += 1) {
    const y = Math.floor((row / (rows - 1)) * (height - 1));
    let minX = width;
    let maxX = -1;
    for (let x = 0; x < width; x += 1) {
      if (mask[y * width + x] === PERSON_CATEGORY) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
      }
    }
    if (maxX >= minX) {
      slices.push({
        y: y / height,
        halfWidth: (maxX - minX) / 2 / width,
      });
    }
  }
  return slices;
}

export function profileScaleAtY(profile: BodyProfileSlice[] | undefined, y: number, fallback = 1): number {
  if (!profile?.length) {
    return fallback;
  }
  let closest = profile[0];
  let minDist = Math.abs(closest.y - y);
  for (const slice of profile) {
    const dist = Math.abs(slice.y - y);
    if (dist < minDist) {
      minDist = dist;
      closest = slice;
    }
  }
  return Math.max(0.65, Math.min(1.45, closest.halfWidth * 3.2));
}
