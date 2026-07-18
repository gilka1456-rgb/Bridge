import type { OrientationMask } from "../models/types";
import {
  decodePersonMaskRLE,
  findMaskBounds,
  normalizePersonMask,
} from "../pose/segmentation";
import type { GhostBodyQuality, GhostLodMesh } from "./body-model";

export const SPECTRAL_SILHOUETTE_IOU_TARGETS = Object.freeze({
  front: 0.85,
  back: 0.85,
  left: 0.78,
  right: 0.78,
} as const);

const HULL_SCALE_X = 2.2 * 0.45;
const HULL_SCALE_Y = 2.4 * 0.5;
const HULL_SCALE_Z = 2.2 * 0.45;
const HULL_FLOOR_OFFSET = -0.1;

type SilhouetteQualityFields = Pick<
  GhostBodyQuality,
  "frontSilhouetteIou" | "backSilhouetteIou" | "leftSilhouetteIou" | "rightSilhouetteIou"
>;

interface DecodedSilhouette {
  azimuth: 0 | 90 | 180 | 270;
  width: number;
  height: number;
  mask: Uint8Array;
  anchor?: OrientationMask["anchor"];
  partialMaxY?: number;
}

function canonicalAzimuth(value: number): 0 | 90 | 180 | 270 {
  const angle = ((Math.round(value / 90) * 90) % 360 + 360) % 360;
  return angle === 90 || angle === 180 || angle === 270 ? angle : 0;
}

function decodeSilhouette(orientation: OrientationMask): DecodedSilhouette | null {
  if (
    !Number.isInteger(orientation.width)
    || !Number.isInteger(orientation.height)
    || orientation.width <= 0
    || orientation.height <= 0
    || !orientation.mask
  ) return null;

  try {
    let width = orientation.width;
    let height = orientation.height;
    let mask = decodePersonMaskRLE(orientation.mask, width * height);
    let anchor = orientation.anchor;
    if (!orientation.normalized) {
      const normalized = normalizePersonMask(mask, width, height);
      if (!normalized) return null;
      mask = normalized.mask;
      width = normalized.width;
      height = normalized.height;
      anchor = normalized.anchor;
    }
    const bounds = findMaskBounds(mask, width, height);
    if (!bounds) return null;
    return {
      azimuth: canonicalAzimuth(orientation.azimuth),
      width,
      height,
      mask,
      anchor,
      ...(orientation.partial ? { partialMaxY: Math.min(height - 1, bounds.maxY + 1) } : {}),
    };
  } catch {
    return null;
  }
}

function projectVertex(
  x: number,
  y: number,
  z: number,
  view: DecodedSilhouette,
): [number, number] {
  const hullX = x / HULL_SCALE_X;
  const hullY = (y - HULL_FLOOR_OFFSET) / HULL_SCALE_Y;
  const hullZ = z / HULL_SCALE_Z;
  let horizontal = hullX;
  if (view.azimuth === 90) horizontal = hullZ;
  if (view.azimuth === 180) horizontal = -hullX;
  if (view.azimuth === 270) horizontal = -hullZ;
  if (view.anchor) {
    return [
      view.anchor.pelvis.x + horizontal * view.anchor.anchorHeight,
      view.anchor.pelvis.y - hullY * view.anchor.anchorHeight,
    ];
  }
  return [
    (horizontal + 0.5) * Math.max(view.width - 1, 1),
    ((1 - hullY) * 0.5) * Math.max(view.height - 1, 1),
  ];
}

function edge(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  px: number,
  py: number,
): number {
  return (px - ax) * (by - ay) - (py - ay) * (bx - ax);
}

function rasterizeMeshSilhouette(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  view: DecodedSilhouette,
): Uint8Array | null {
  if (positions.length < 9 || positions.length % 3 !== 0 || indices.length < 3 || indices.length % 3 !== 0) {
    return null;
  }
  const vertexCount = positions.length / 3;
  const projected = new Float32Array(vertexCount * 2);
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const [pixelX, pixelY] = projectVertex(
      Number(positions[vertex * 3]),
      Number(positions[vertex * 3 + 1]),
      Number(positions[vertex * 3 + 2]),
      view,
    );
    if (!Number.isFinite(pixelX) || !Number.isFinite(pixelY)) return null;
    projected[vertex * 2] = pixelX;
    projected[vertex * 2 + 1] = pixelY;
  }

  const result = new Uint8Array(view.width * view.height);
  for (let offset = 0; offset < indices.length; offset += 3) {
    const a = Number(indices[offset]);
    const b = Number(indices[offset + 1]);
    const c = Number(indices[offset + 2]);
    if (
      !Number.isInteger(a) || !Number.isInteger(b) || !Number.isInteger(c)
      || a < 0 || b < 0 || c < 0
      || a >= vertexCount || b >= vertexCount || c >= vertexCount
    ) return null;
    const ax = projected[a * 2];
    const ay = projected[a * 2 + 1];
    const bx = projected[b * 2];
    const by = projected[b * 2 + 1];
    const cx = projected[c * 2];
    const cy = projected[c * 2 + 1];
    const signedArea = edge(ax, ay, bx, by, cx, cy);
    if (Math.abs(signedArea) < 1e-7) continue;
    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx) - 0.5));
    const maxX = Math.min(view.width - 1, Math.ceil(Math.max(ax, bx, cx) - 0.5));
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy) - 0.5));
    const maxY = Math.min(
      view.partialMaxY ?? view.height - 1,
      Math.ceil(Math.max(ay, by, cy) - 0.5),
    );
    if (minX > maxX || minY > maxY) continue;
    const epsilon = Math.abs(signedArea) * 1e-6 + 1e-6;
    for (let y = minY; y <= maxY; y += 1) {
      const py = y + 0.5;
      for (let x = minX; x <= maxX; x += 1) {
        const px = x + 0.5;
        const ab = edge(ax, ay, bx, by, px, py);
        const bc = edge(bx, by, cx, cy, px, py);
        const ca = edge(cx, cy, ax, ay, px, py);
        const hasNegative = ab < -epsilon || bc < -epsilon || ca < -epsilon;
        const hasPositive = ab > epsilon || bc > epsilon || ca > epsilon;
        if (!(hasNegative && hasPositive)) result[y * view.width + x] = 1;
      }
    }
  }
  return result;
}

/** Measures the final indexed body surface against one captured silhouette direction. */
export function measureMeshSilhouetteIou(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  orientation: OrientationMask,
): number | undefined {
  const view = decodeSilhouette(orientation);
  if (!view) return undefined;
  const projected = rasterizeMeshSilhouette(positions, indices, view);
  if (!projected) return undefined;
  const comparisonMaxY = view.partialMaxY ?? view.height - 1;
  let intersection = 0;
  let union = 0;
  let projectedPixels = 0;
  let targetPixels = 0;
  for (let y = 0; y <= comparisonMaxY; y += 1) {
    const row = y * view.width;
    for (let x = 0; x < view.width; x += 1) {
      const predicted = projected[row + x] !== 0;
      const target = view.mask[row + x] !== 0;
      if (predicted) projectedPixels += 1;
      if (target) targetPixels += 1;
      if (predicted && target) intersection += 1;
      if (predicted || target) union += 1;
    }
  }
  if (projectedPixels === 0 || targetPixels === 0 || union === 0) return undefined;
  return intersection / union;
}

/** Records one best-confidence measurement per cardinal direction without enforcing an uncalibrated gate. */
export function measureGhostBodySilhouetteEvidence(
  lod: Pick<GhostLodMesh, "positions" | "indices">,
  orientations: OrientationMask[] | undefined,
): Partial<SilhouetteQualityFields> {
  if (!orientations || orientations.length === 0) return {};
  const selected = new Map<0 | 90 | 180 | 270, {
    iou: number;
    partial: boolean;
    quality: number;
  }>();
  for (const orientation of orientations) {
    const angle = canonicalAzimuth(orientation.azimuth);
    const iou = measureMeshSilhouetteIou(lod.positions, lod.indices, orientation);
    if (iou === undefined) continue;
    const existing = selected.get(angle);
    const quality = Number.isFinite(orientation.quality) ? orientation.quality ?? 0 : 0;
    if (!existing || quality > existing.quality || (quality === existing.quality && existing.partial && !orientation.partial)) {
      selected.set(angle, { iou, partial: orientation.partial === true, quality });
    }
  }
  const result: Partial<SilhouetteQualityFields> = {};
  const fields = {
    0: "frontSilhouetteIou",
    90: "rightSilhouetteIou",
    180: "backSilhouetteIou",
    270: "leftSilhouetteIou",
  } as const;
  selected.forEach((measurement, angle) => {
    result[fields[angle]] = measurement.iou;
  });
  return result;
}
