export const SPECTRAL_NORMAL_COHERENCE_VERSION = "adjacency-normal-v1" as const;
export const SPECTRAL_NORMAL_COHERENCE_MIN_DOT = 0.5;
export const SPECTRAL_NORMAL_COHERENCE_MIN_PERCENT = 95;

export interface SurfaceNormalSmoothingOptions {
  passes?: number;
  blend?: number;
  /** Adjacent normals below this cosine are treated as an intentional crease. */
  minDot?: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

/** Percentage of unique indexed edges whose endpoint normals stay within the smoothness gate. */
export function measureQuantizedNormalCoherence(
  normals: Int16Array,
  indices: Uint16Array | Uint32Array | readonly number[],
  minDot = SPECTRAL_NORMAL_COHERENCE_MIN_DOT,
): number {
  const vertexCount = Math.floor(normals.length / 3);
  if (vertexCount === 0 || indices.length < 3) return 0;
  const threshold = clamp(minDot, -1, 1);
  const edges = new Set<number>();
  let coherent = 0;
  let measured = 0;
  const inspect = (left: number, right: number) => {
    const a = Math.min(left, right);
    const b = Math.max(left, right);
    if (a < 0 || b >= vertexCount || a === b) return;
    const key = a * vertexCount + b;
    if (edges.has(key)) return;
    edges.add(key);
    const ai = a * 3;
    const bi = b * 3;
    const aLength = Math.hypot(normals[ai], normals[ai + 1], normals[ai + 2]);
    const bLength = Math.hypot(normals[bi], normals[bi + 1], normals[bi + 2]);
    if (aLength <= 0 || bLength <= 0) return;
    const dot = (
      normals[ai] * normals[bi]
      + normals[ai + 1] * normals[bi + 1]
      + normals[ai + 2] * normals[bi + 2]
    ) / (aLength * bLength);
    measured += 1;
    if (dot >= threshold) coherent += 1;
  };
  for (let index = 0; index + 2 < indices.length; index += 3) {
    const a = indices[index];
    const b = indices[index + 1];
    const c = indices[index + 2];
    inspect(a, b);
    inspect(b, c);
    inspect(c, a);
  }
  return measured > 0 ? coherent / measured * 100 : 0;
}

/**
 * Reduces high-frequency SDF/pose shading noise without moving a vertex.
 * Adjacency comes from the final indexed surface, while a dot-product gate
 * keeps true folds and disconnected regions from bleeding into each other.
 */
export function smoothQuantizedSurfaceNormals(
  normals: Int16Array,
  indices: Uint16Array | Uint32Array | readonly number[],
  options: SurfaceNormalSmoothingOptions = {},
): Int16Array<ArrayBuffer> {
  const vertexCount = Math.floor(normals.length / 3);
  if (vertexCount === 0 || indices.length < 3) return new Int16Array(normals);

  const passes = Math.max(0, Math.trunc(options.passes ?? 2));
  const blend = clamp(options.blend ?? 0.42, 0, 1);
  const minDot = clamp(options.minDot ?? 0.18, -1, 1);
  if (passes === 0 || blend === 0) return new Int16Array(normals);

  let current = new Float32Array(normals.length);
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const offset = vertex * 3;
    const x = normals[offset] / 32767;
    const y = normals[offset + 1] / 32767;
    const z = normals[offset + 2] / 32767;
    const inverseLength = 1 / (Math.hypot(x, y, z) || 1);
    current[offset] = x * inverseLength;
    current[offset + 1] = y * inverseLength;
    current[offset + 2] = z * inverseLength;
  }

  const selfWeight = 2;
  for (let pass = 0; pass < passes; pass += 1) {
    const sums = new Float32Array(current.length);
    const weights = new Float32Array(vertexCount);
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      const offset = vertex * 3;
      sums[offset] = current[offset] * selfWeight;
      sums[offset + 1] = current[offset + 1] * selfWeight;
      sums[offset + 2] = current[offset + 2] * selfWeight;
      weights[vertex] = selfWeight;
    }

    const addNeighbor = (target: number, neighbor: number) => {
      if (target < 0 || neighbor < 0 || target >= vertexCount || neighbor >= vertexCount) return;
      const targetOffset = target * 3;
      const neighborOffset = neighbor * 3;
      const dot = current[targetOffset] * current[neighborOffset]
        + current[targetOffset + 1] * current[neighborOffset + 1]
        + current[targetOffset + 2] * current[neighborOffset + 2];
      if (dot < minDot) return;
      sums[targetOffset] += current[neighborOffset];
      sums[targetOffset + 1] += current[neighborOffset + 1];
      sums[targetOffset + 2] += current[neighborOffset + 2];
      weights[target] += 1;
    };

    for (let index = 0; index + 2 < indices.length; index += 3) {
      const a = indices[index];
      const b = indices[index + 1];
      const c = indices[index + 2];
      addNeighbor(a, b);
      addNeighbor(a, c);
      addNeighbor(b, a);
      addNeighbor(b, c);
      addNeighbor(c, a);
      addNeighbor(c, b);
    }

    const next = new Float32Array(current.length);
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      const offset = vertex * 3;
      const inverseWeight = 1 / Math.max(weights[vertex], 1);
      const averageX = sums[offset] * inverseWeight;
      const averageY = sums[offset + 1] * inverseWeight;
      const averageZ = sums[offset + 2] * inverseWeight;
      const x = current[offset] + (averageX - current[offset]) * blend;
      const y = current[offset + 1] + (averageY - current[offset + 1]) * blend;
      const z = current[offset + 2] + (averageZ - current[offset + 2]) * blend;
      const inverseLength = 1 / (Math.hypot(x, y, z) || 1);
      next[offset] = x * inverseLength;
      next[offset + 1] = y * inverseLength;
      next[offset + 2] = z * inverseLength;
    }
    current = next;
  }

  const output = new Int16Array(normals.length);
  for (let index = 0; index < current.length; index += 1) {
    output[index] = Math.round(clamp(current[index], -1, 1) * 32767);
  }
  return output;
}
