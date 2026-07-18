import type {
  BodyProfileSlice,
  Landmark,
  OrientationMaskAnchor,
  SilhouettePoint,
} from "../models/types";

export const PERSON_CATEGORY = 1;
export const NORMALIZED_MASK_WIDTH = 128;
export const NORMALIZED_MASK_HEIGHT = 256;
export const ANCHORED_MASK_WIDTH = 256;
export const ANCHORED_MASK_HEIGHT = 512;
export const TARGET_PELVIS = { x: 128, y: 296 } as const;
export const TARGET_ANCHOR_HEIGHT = 210;
export const APPEARANCE_FIELD_WIDTH = 64;
export const APPEARANCE_FIELD_HEIGHT = 128;

export interface MaskBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  pixelCount: number;
}

export interface NormalizedMask {
  mask: Uint8Array;
  width: number;
  height: number;
  personAspect: number;
  sourceBounds: MaskBounds;
  anchor?: OrientationMaskAnchor;
}

/** 把 MediaPipe 类别 mask 二值化为人体掩码(1=人体,0=背景) */
export function binarizePersonMask(categoryMask: Uint8Array): Uint8Array {
  const binary = new Uint8Array(categoryMask.length);
  for (let i = 0; i < categoryMask.length; i += 1) {
    // selfie_multiclass: 0=背景，1–5 分别为头发/身体/脸/衣服/其他人体区域。
    binary[i] = categoryMask[i] === 0 ? 0 : PERSON_CATEGORY;
  }
  return binary;
}

export function findMaskBounds(mask: Uint8Array, width: number, height: number): MaskBounds | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let pixelCount = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      pixelCount += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return pixelCount > 0 ? { minX, minY, maxX, maxY, pixelCount } : null;
}

/** 只保留最大连通人体，移除分割模型产生的零散噪点。 */
export function keepLargestComponent(mask: Uint8Array, width: number, height: number): Uint8Array {
  const visited = new Uint8Array(mask.length);
  let best: number[] = [];
  const queue: number[] = [];
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;
    const component: number[] = [];
    queue.length = 0;
    queue.push(start);
    visited[start] = 1;
    for (let q = 0; q < queue.length; q += 1) {
      const index = queue[q];
      component.push(index);
      const x = index % width;
      const y = Math.floor(index / width);
      const neighbors = [
        x > 0 ? index - 1 : -1,
        x + 1 < width ? index + 1 : -1,
        y > 0 ? index - width : -1,
        y + 1 < height ? index + width : -1,
      ];
      for (const neighbor of neighbors) {
        if (neighbor >= 0 && mask[neighbor] && !visited[neighbor]) {
          visited[neighbor] = 1;
          queue.push(neighbor);
        }
      }
    }
    if (component.length > best.length) best = component;
  }
  const result = new Uint8Array(mask.length);
  best.forEach((index) => { result[index] = 1; });
  return result;
}

function morphology(mask: Uint8Array, width: number, height: number, mode: "dilate" | "erode"): Uint8Array {
  const result = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let value = mode === "erode" ? 1 : 0;
      for (let oy = -1; oy <= 1; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          const nx = x + ox;
          const ny = y + oy;
          const sample = nx >= 0 && nx < width && ny >= 0 && ny < height
            ? mask[ny * width + nx]
            : 0;
          if (mode === "dilate" && sample) value = 1;
          if (mode === "erode" && !sample) value = 0;
        }
      }
      result[y * width + x] = value;
    }
  }
  return result;
}

export function closeBinaryMask(mask: Uint8Array, width: number, height: number): Uint8Array {
  return morphology(morphology(mask, width, height, "dilate"), width, height, "erode");
}

/** 在源掩码的连续像素坐标中做双线性采样；画布外视为背景。 */
export function sampleBinaryMaskBilinear(
  source: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return 0;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const top = source[y0 * width + x0] * (1 - tx) + source[y0 * width + x1] * tx;
  const bottom = source[y1 * width + x0] * (1 - tx) + source[y1 * width + x1] * tx;
  return top * (1 - ty) + bottom * ty;
}

/** Bilinear sampling for privacy-reduced 8-bit appearance luminance. */
export function sampleByteFieldBilinear(
  source: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return 128;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const top = source[y0 * width + x0] * (1 - tx) + source[y0 * width + x1] * tx;
  const bottom = source[y1 * width + x0] * (1 - tx) + source[y1 * width + x1] * tx;
  return top * (1 - ty) + bottom * ty;
}

export function rasterizeByteField(
  source: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
  targetToSource: (targetX: number, targetY: number) => [number, number],
): Uint8Array {
  const result = new Uint8Array(targetWidth * targetHeight);
  for (let ty = 0; ty < targetHeight; ty += 1) {
    for (let tx = 0; tx < targetWidth; tx += 1) {
      const [sx, sy] = targetToSource(tx, ty);
      result[ty * targetWidth + tx] = Math.round(sampleByteFieldBilinear(
        source,
        sourceWidth,
        sourceHeight,
        sx,
        sy,
      ));
    }
  }
  return result;
}

function boxBlurThreshold(mask: Uint8Array, width: number, height: number): Uint8Array {
  const result = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      let samples = 0;
      for (let oy = -1; oy <= 1; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          const sx = x + ox;
          const sy = y + oy;
          if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
          sum += mask[sy * width + sx];
          samples += 1;
        }
      }
      result[y * width + x] = sum / Math.max(samples, 1) >= 0.5 ? 1 : 0;
    }
  }
  return result;
}

/**
 * 逆向遍历目标像素并反查源坐标，避免正向 round 写入产生空行和重复行。
 * 所有人体归一化及后续旋转校正共用这一条栅格化路径。
 */
export function rasterizeBinaryMask(
  source: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
  targetToSource: (targetX: number, targetY: number) => [number, number],
): Uint8Array {
  const sampled = new Uint8Array(targetWidth * targetHeight);
  for (let ty = 0; ty < targetHeight; ty += 1) {
    for (let tx = 0; tx < targetWidth; tx += 1) {
      const [sx, sy] = targetToSource(tx, ty);
      sampled[ty * targetWidth + tx] = sampleBinaryMaskBilinear(
        source,
        sourceWidth,
        sourceHeight,
        sx,
        sy,
      ) >= 0.5 ? 1 : 0;
    }
  }
  return boxBlurThreshold(sampled, targetWidth, targetHeight);
}

/** 绕图像中心旋转二值蒙版；逆向采样保证旋转后没有前向映射留下的空洞。 */
export function rotateBinaryMask(
  source: Uint8Array,
  width: number,
  height: number,
  degrees: number,
): Uint8Array {
  const radians = (-degrees * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return rasterizeBinaryMask(
    source,
    width,
    height,
    width,
    height,
    (targetX, targetY) => {
      const x = targetX / Math.max(width - 1, 1) - 0.5;
      const y = targetY / Math.max(height - 1, 1) - 0.5;
      return [
        (0.5 + cosine * x - sine * y) * (width - 1),
        (0.5 + sine * x + cosine * y) * (height - 1),
      ];
    },
  );
}

/** Uses the exact inverse rotation as rotateBinaryMask so pixels stay registered. */
export function rotateByteField(
  source: Uint8Array,
  width: number,
  height: number,
  degrees: number,
): Uint8Array {
  const radians = (-degrees * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return rasterizeByteField(
    source,
    width,
    height,
    width,
    height,
    (targetX, targetY) => {
      const x = targetX / Math.max(width - 1, 1) - 0.5;
      const y = targetY / Math.max(height - 1, 1) - 0.5;
      return [
        (0.5 + cosine * x - sine * y) * (width - 1),
        (0.5 + sine * x + cosine * y) * (height - 1),
      ];
    },
  );
}

/** 把不同站位的人体等比例放入固定 1:2 画布，不拉伸身体宽度。 */
export function normalizePersonMask(
  source: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth = NORMALIZED_MASK_WIDTH,
  targetHeight = NORMALIZED_MASK_HEIGHT,
): NormalizedMask | null {
  const cleaned = closeBinaryMask(keepLargestComponent(source, sourceWidth, sourceHeight), sourceWidth, sourceHeight);
  const bounds = findMaskBounds(cleaned, sourceWidth, sourceHeight);
  if (!bounds || bounds.maxY <= bounds.minY) return null;

  const bodyWidth = bounds.maxX - bounds.minX + 1;
  const bodyHeight = bounds.maxY - bounds.minY + 1;
  const targetBodyHeight = Math.floor(targetHeight * 0.9);
  const scale = (targetBodyHeight - 1) / Math.max(bodyHeight - 1, 1);
  const sourceCenterX = (bounds.minX + bounds.maxX) / 2;
  const targetCenterX = (targetWidth - 1) / 2;
  const targetTop = Math.floor((targetHeight - targetBodyHeight) / 2);
  const result = rasterizeBinaryMask(
    cleaned,
    sourceWidth,
    sourceHeight,
    targetWidth,
    targetHeight,
    (tx, ty) => [
      sourceCenterX + (tx - targetCenterX) / scale,
      bounds.minY + (ty - targetTop) / scale,
    ],
  );

  return {
    mask: result,
    width: targetWidth,
    height: targetHeight,
    personAspect: bodyWidth / bodyHeight,
    sourceBounds: bounds,
  };
}

function isVisible(landmark: Landmark | undefined, threshold = 0.5): landmark is Landmark {
  return Boolean(
    landmark
      && Number.isFinite(landmark.x)
      && Number.isFinite(landmark.y)
      && landmark.visibility >= threshold,
  );
}

interface SourceBodyAnchor {
  pelvisX: number;
  pelvisY: number;
  headTopY: number;
  anchorHeight: number;
  shoulderWidth: number;
}

function resolveSourceBodyAnchor(
  landmarks: Landmark[],
  sourceWidth: number,
  sourceHeight: number,
): SourceBodyAnchor | null {
  const nose = landmarks[0];
  const leftShoulder = landmarks[11];
  const rightShoulder = landmarks[12];
  const leftHip = landmarks[23];
  const rightHip = landmarks[24];
  if (
    !isVisible(nose)
    || !isVisible(leftShoulder)
    || !isVisible(rightShoulder)
    || !isVisible(leftHip)
    || !isVisible(rightHip)
  ) return null;
  const toPixelX = (value: number) => value * Math.max(sourceWidth - 1, 1);
  const toPixelY = (value: number) => value * Math.max(sourceHeight - 1, 1);
  const pelvisX = (toPixelX(leftHip.x) + toPixelX(rightHip.x)) / 2;
  const pelvisY = (toPixelY(leftHip.y) + toPixelY(rightHip.y)) / 2;
  const shoulderY = (toPixelY(leftShoulder.y) + toPixelY(rightShoulder.y)) / 2;
  const noseY = toPixelY(nose.y);
  let headTopY = noseY - 0.35 * Math.abs(noseY - shoulderY);
  const leftEar = landmarks[7];
  const rightEar = landmarks[8];
  if (isVisible(leftEar) && isVisible(rightEar)) {
    const earY = (toPixelY(leftEar.y) + toPixelY(rightEar.y)) / 2;
    headTopY = Math.min(headTopY, earY - 0.5 * Math.abs(shoulderY - earY));
  }
  const anchorHeight = pelvisY - headTopY;
  if (!Number.isFinite(anchorHeight) || anchorHeight <= 1) return null;
  return {
    pelvisX,
    pelvisY,
    headTopY,
    anchorHeight,
    shoulderWidth: Math.abs(toPixelX(leftShoulder.x) - toPixelX(rightShoulder.x)),
  };
}

/**
 * 把人体按骨盆位置与「骨盆→头顶」尺度放入固定 v3 画布。
 * 与整体包围盒不同，举手或分割边缘变化不会移动头、躯干和骨盆。
 */
export function anchorNormalizePersonMask(
  source: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  landmarks: Landmark[],
): NormalizedMask | null {
  const sourceAnchor = resolveSourceBodyAnchor(landmarks, sourceWidth, sourceHeight);
  if (!sourceAnchor) return null;

  const cleaned = closeBinaryMask(
    keepLargestComponent(source, sourceWidth, sourceHeight),
    sourceWidth,
    sourceHeight,
  );
  const bounds = findMaskBounds(cleaned, sourceWidth, sourceHeight);
  if (!bounds) return null;

  const scale = TARGET_ANCHOR_HEIGHT / sourceAnchor.anchorHeight;
  const normalized = rasterizeBinaryMask(
    cleaned,
    sourceWidth,
    sourceHeight,
    ANCHORED_MASK_WIDTH,
    ANCHORED_MASK_HEIGHT,
    (tx, ty) => [
      sourceAnchor.pelvisX + (tx - TARGET_PELVIS.x) / scale,
      sourceAnchor.pelvisY + (ty - TARGET_PELVIS.y) / scale,
    ],
  );
  if (!findMaskBounds(normalized, ANCHORED_MASK_WIDTH, ANCHORED_MASK_HEIGHT)) return null;
  return {
    mask: normalized,
    width: ANCHORED_MASK_WIDTH,
    height: ANCHORED_MASK_HEIGHT,
    personAspect: sourceAnchor.shoulderWidth / sourceAnchor.anchorHeight,
    sourceBounds: bounds,
    anchor: {
      pelvis: { ...TARGET_PELVIS },
      anchorHeight: TARGET_ANCHOR_HEIGHT,
    },
  };
}

/**
 * Aligns a monochrome source frame to its normalized person mask, then removes
 * global exposure and compresses contrast. The result keeps broad clothing and
 * body shading while intentionally discarding color and sharp identity detail.
 */
export function normalizeAppearanceLuma(
  source: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  normalized: NormalizedMask,
  landmarks?: Landmark[],
): Uint8Array | null {
  if (source.length !== sourceWidth * sourceHeight) return null;
  let aligned: Uint8Array;
  if (normalized.anchor) {
    if (!landmarks) return null;
    const sourceAnchor = resolveSourceBodyAnchor(landmarks, sourceWidth, sourceHeight);
    if (!sourceAnchor) return null;
    const scale = TARGET_ANCHOR_HEIGHT / sourceAnchor.anchorHeight;
    aligned = rasterizeByteField(
      source,
      sourceWidth,
      sourceHeight,
      normalized.width,
      normalized.height,
      (tx, ty) => [
        sourceAnchor.pelvisX + (tx - TARGET_PELVIS.x) / scale,
        sourceAnchor.pelvisY + (ty - TARGET_PELVIS.y) / scale,
      ],
    );
  } else {
    const bounds = normalized.sourceBounds;
    const bodyHeight = bounds.maxY - bounds.minY + 1;
    const targetBodyHeight = Math.floor(normalized.height * 0.9);
    const scale = (targetBodyHeight - 1) / Math.max(bodyHeight - 1, 1);
    const sourceCenterX = (bounds.minX + bounds.maxX) / 2;
    const targetCenterX = (normalized.width - 1) / 2;
    const targetTop = Math.floor((normalized.height - targetBodyHeight) / 2);
    aligned = rasterizeByteField(
      source,
      sourceWidth,
      sourceHeight,
      normalized.width,
      normalized.height,
      (tx, ty) => [
        sourceCenterX + (tx - targetCenterX) / scale,
        bounds.minY + (ty - targetTop) / scale,
      ],
    );
  }

  const blurred = new Uint8Array(aligned.length);
  for (let y = 0; y < normalized.height; y += 1) {
    for (let x = 0; x < normalized.width; x += 1) {
      const index = y * normalized.width + x;
      if (!normalized.mask[index]) {
        blurred[index] = 128;
        continue;
      }
      let sum = 0;
      let count = 0;
      for (let oy = -1; oy <= 1; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          const sx = x + ox;
          const sy = y + oy;
          if (sx < 0 || sy < 0 || sx >= normalized.width || sy >= normalized.height) continue;
          const sampleIndex = sy * normalized.width + sx;
          if (!normalized.mask[sampleIndex]) continue;
          sum += aligned[sampleIndex];
          count += 1;
        }
      }
      blurred[index] = count > 0 ? Math.round(sum / count) : 128;
    }
  }

  let count = 0;
  let sum = 0;
  for (let index = 0; index < blurred.length; index += 1) {
    if (!normalized.mask[index]) continue;
    sum += blurred[index];
    count += 1;
  }
  if (count === 0) return null;
  const mean = sum / count;
  let variance = 0;
  for (let index = 0; index < blurred.length; index += 1) {
    if (!normalized.mask[index]) continue;
    variance += (blurred[index] - mean) ** 2;
  }
  const standardDeviation = Math.sqrt(variance / count);
  const contrast = 34 / Math.max(standardDeviation, 18);
  const result = new Uint8Array(blurred.length);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = normalized.mask[index]
      ? Math.round(Math.max(48, Math.min(208, 128 + (blurred[index] - mean) * contrast)))
      : 128;
  }
  return result;
}

export function compactAppearanceLuma(
  source: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth = APPEARANCE_FIELD_WIDTH,
  targetHeight = APPEARANCE_FIELD_HEIGHT,
): Uint8Array | null {
  if (source.length !== sourceWidth * sourceHeight) return null;
  return rasterizeByteField(
    source,
    sourceWidth,
    sourceHeight,
    targetWidth,
    targetHeight,
    (x, y) => [
      (x + 0.5) * sourceWidth / targetWidth - 0.5,
      (y + 0.5) * sourceHeight / targetHeight - 0.5,
    ],
  );
}

export function encodeAppearanceLuma(luma: Uint8Array): string {
  const packed = new Uint8Array(Math.ceil(luma.length / 2));
  for (let index = 0; index < luma.length; index += 2) {
    const low = Math.round(luma[index] / 17) & 0x0f;
    const high = index + 1 < luma.length ? Math.round(luma[index + 1] / 17) & 0x0f : 0;
    packed[index >> 1] = low | (high << 4);
  }
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < packed.length; offset += chunkSize) {
    binary += String.fromCharCode(...packed.subarray(offset, offset + chunkSize));
  }
  return `q4:${btoa(binary)}`;
}

export function decodeAppearanceLuma(encoded: string, expectedLength: number): Uint8Array | null {
  try {
    const quantized = encoded.startsWith("q4:");
    const binary = atob(quantized ? encoded.slice(3) : encoded);
    if (quantized && binary.length !== Math.ceil(expectedLength / 2)) return null;
    if (!quantized && binary.length !== expectedLength) return null;
    const result = new Uint8Array(expectedLength);
    for (let index = 0; index < expectedLength; index += 1) {
      if (!quantized) {
        result[index] = binary.charCodeAt(index);
        continue;
      }
      const packed = binary.charCodeAt(index >> 1);
      result[index] = ((index & 1) === 0 ? packed & 0x0f : packed >> 4) * 17;
    }
    return result;
  } catch {
    return null;
  }
}

/** 多帧多数投票；略低于 50% 可避免偶发分割缺口切断手脚。 */
export function fuseBinaryMasks(masks: Uint8Array[]): Uint8Array {
  if (masks.length === 0) return new Uint8Array();
  const length = masks[0].length;
  if (masks.some((mask) => mask.length !== length)) {
    throw new Error("Mask dimensions must match before fusion.");
  }
  const threshold = Math.max(1, Math.ceil(masks.length * 0.4));
  const result = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    let votes = 0;
    for (const mask of masks) votes += mask[index] ? 1 : 0;
    result[index] = votes >= threshold ? 1 : 0;
  }
  return result;
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
