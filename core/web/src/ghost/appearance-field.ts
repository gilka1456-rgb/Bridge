import * as THREE from "three";
import type { OrientationMask } from "../models/types";
import { decodeAppearanceLuma } from "../pose/segmentation";

const HULL_SCALE_X = 2.2 * 0.45;
const HULL_SCALE_Y = 2.4 * 0.5;
const HULL_SCALE_Z = 2.2 * 0.45;
const HULL_FLOOR_OFFSET = -0.1;

export const SPECTRAL_APPEARANCE_FIELD_VERSION = "appearance-field-v4-compact-anchor-scaled" as const;
export const SPECTRAL_APPEARANCE_SMOOTHING = Object.freeze({
  passes: 2,
  lumaBlend: 0.38,
  lumaMaxDelta: 0.26,
  reliefBlend: 0.24,
  reliefMaxDelta: 0.18,
});

interface AppearanceView {
  azimuth: number;
  width: number;
  height: number;
  luma: Uint8Array;
  projectionAnchor?: {
    pelvisX: number;
    pelvisY: number;
    horizontalScale: number;
    verticalScale: number;
  };
  cameraDirection: THREE.Vector3;
}

function canonicalAzimuth(value: number): 0 | 90 | 180 | 270 {
  const angle = ((Math.round(value / 90) * 90) % 360 + 360) % 360;
  return angle === 90 || angle === 180 || angle === 270 ? angle : 0;
}

function cameraDirection(azimuth: number): THREE.Vector3 {
  switch (canonicalAzimuth(azimuth)) {
    case 90: return new THREE.Vector3(1, 0, 0);
    case 180: return new THREE.Vector3(0, 0, -1);
    case 270: return new THREE.Vector3(-1, 0, 0);
    default: return new THREE.Vector3(0, 0, 1);
  }
}

function projectToView(
  point: THREE.Vector3,
  view: AppearanceView,
): [number, number] {
  const angle = canonicalAzimuth(view.azimuth);
  const horizontal = angle === 0
    ? point.x
    : angle === 90
      ? point.z
      : angle === 180
        ? -point.x
        : -point.z;
  if (view.projectionAnchor) {
    return [
      (view.projectionAnchor.pelvisX + horizontal * view.projectionAnchor.horizontalScale)
        / Math.max(view.width - 1, 1),
      (view.projectionAnchor.pelvisY - point.y * view.projectionAnchor.verticalScale)
        / Math.max(view.height - 1, 1),
    ];
  }
  return [horizontal + 0.5, (1 - point.y) * 0.5];
}

function sampleView(view: AppearanceView, u: number, v: number): number | null {
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  const fx = u * (view.width - 1);
  const fy = v * (view.height - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(view.width - 1, x0 + 1);
  const y1 = Math.min(view.height - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const top = view.luma[y0 * view.width + x0] * (1 - tx)
    + view.luma[y0 * view.width + x1] * tx;
  const bottom = view.luma[y1 * view.width + x0] * (1 - tx)
    + view.luma[y1 * view.width + x1] * tx;
  return (top * (1 - ty) + bottom * ty) / 255;
}

function sampleBroadRelief(
  view: AppearanceView,
  u: number,
  v: number,
  center: number,
): number {
  const du = 2 / Math.max(view.width - 1, 1);
  const dv = 2 / Math.max(view.height - 1, 1);
  const offsets = [
    [-du, 0], [du, 0], [0, -dv], [0, dv],
    [-du, -dv], [du, -dv], [-du, dv], [du, dv],
  ] as const;
  let surround = 0;
  let samples = 0;
  for (const [offsetU, offsetV] of offsets) {
    const value = sampleView(view, u + offsetU, v + offsetV);
    if (value === null) continue;
    surround += value;
    samples += 1;
  }
  if (samples === 0) return 0.5;
  const highPass = (center - surround / samples) * 2.4;
  return Math.max(0, Math.min(1, 0.5 + highPass));
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - edge0) / Math.max(edge1 - edge0, 1e-6)));
  return t * t * (3 - 2 * t);
}

/**
 * Smooths small view-to-view exposure steps across mesh adjacency. A bilateral
 * value gate prevents real clothing folds from bleeding into their surround.
 */
export function smoothSpectralAppearanceValues(
  values: Float32Array,
  indices: ArrayLike<number> | undefined,
  passes: number,
  blend: number,
  maxDelta: number,
): Float32Array {
  if (!indices || indices.length < 3 || passes <= 0 || blend <= 0) return new Float32Array(values);
  let current = new Float32Array(values);
  const safeBlend = Math.max(0, Math.min(1, blend));
  const safeMaxDelta = Math.max(maxDelta, 1e-4);
  const selfWeight = 2;

  for (let pass = 0; pass < Math.trunc(passes); pass += 1) {
    const sums = new Float32Array(current.length);
    const weights = new Float32Array(current.length);
    for (let vertex = 0; vertex < current.length; vertex += 1) {
      sums[vertex] = current[vertex] * selfWeight;
      weights[vertex] = selfWeight;
    }
    const addNeighbor = (target: number, neighbor: number) => {
      if (target < 0 || neighbor < 0 || target >= current.length || neighbor >= current.length) return;
      const delta = Math.abs(current[target] - current[neighbor]);
      const bilateralWeight = 1 - smoothstep(safeMaxDelta * 0.45, safeMaxDelta, delta);
      if (bilateralWeight <= 1e-4) return;
      sums[target] += current[neighbor] * bilateralWeight;
      weights[target] += bilateralWeight;
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
    for (let vertex = 0; vertex < current.length; vertex += 1) {
      const average = sums[vertex] / Math.max(weights[vertex], 1);
      next[vertex] = Math.max(0, Math.min(1,
        current[vertex] + (average - current[vertex]) * safeBlend,
      ));
    }
    current = next;
  }
  return current;
}

/**
 * Bakes best-facing blurred photo luminance plus a broad, privacy-safe relief
 * channel. The second channel only compares samples two compact-field pixels
 * apart, so clothing folds survive without restoring sharp identity texture.
 * Both style families consume the same attributes with different strengths.
 */
export function attachSpectralAppearanceField(
  geometry: THREE.BufferGeometry,
  orientations: OrientationMask[] | undefined,
): number {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  if (!position || !normal) return 0;
  const views = (orientations ?? []).flatMap((orientation): AppearanceView[] => {
    if (!orientation.appearanceLuma) return [];
    const width = orientation.appearanceWidth ?? orientation.width;
    const height = orientation.appearanceHeight ?? orientation.height;
    const luma = decodeAppearanceLuma(
      orientation.appearanceLuma,
      width * height,
    );
    const horizontalRatio = (width - 1) / Math.max(orientation.width - 1, 1);
    const verticalRatio = (height - 1) / Math.max(orientation.height - 1, 1);
    return luma ? [{
      azimuth: orientation.azimuth,
      width,
      height,
      luma,
      ...(orientation.anchor ? {
        projectionAnchor: {
          pelvisX: orientation.anchor.pelvis.x * horizontalRatio,
          pelvisY: orientation.anchor.pelvis.y * verticalRatio,
          horizontalScale: orientation.anchor.anchorHeight * horizontalRatio,
          verticalScale: orientation.anchor.anchorHeight * verticalRatio,
        },
      } : {}),
      cameraDirection: cameraDirection(orientation.azimuth),
    }] : [];
  });
  const appearance = new Float32Array(position.count);
  const relief = new Float32Array(position.count);
  appearance.fill(0.5);
  relief.fill(0.5);
  if (views.length === 0) {
    geometry.setAttribute("bridgeAppearance", new THREE.BufferAttribute(appearance, 1));
    geometry.setAttribute("bridgeAppearanceRelief", new THREE.BufferAttribute(relief, 1));
    geometry.userData.spectralAppearanceViews = 0;
    geometry.userData.spectralAppearanceFieldVersion = SPECTRAL_APPEARANCE_FIELD_VERSION;
    return 0;
  }
  const point = new THREE.Vector3();
  const surfaceNormal = new THREE.Vector3();
  const nativePoint = new THREE.Vector3();
  for (let vertex = 0; vertex < position.count; vertex += 1) {
    point.fromBufferAttribute(position, vertex);
    surfaceNormal.fromBufferAttribute(normal, vertex).normalize();
    nativePoint.set(
      point.x / HULL_SCALE_X,
      (point.y - HULL_FLOOR_OFFSET) / HULL_SCALE_Y,
      point.z / HULL_SCALE_Z,
    );
    let weightedLuma = 0;
    let weightedRelief = 0;
    let totalWeight = 0;
    for (const view of views) {
      const [u, v] = projectToView(nativePoint, view);
      const sampled = sampleView(view, u, v);
      if (sampled === null) continue;
      const facing = Math.max(0, surfaceNormal.dot(view.cameraDirection));
      const facingSquared = facing * facing;
      const weight = 0.001 + facingSquared * facingSquared;
      weightedLuma += sampled * weight;
      weightedRelief += sampleBroadRelief(view, u, v, sampled) * weight;
      totalWeight += weight;
    }
    if (totalWeight > 0) {
      appearance[vertex] = weightedLuma / totalWeight;
      relief[vertex] = weightedRelief / totalWeight;
    }
  }
  const meshIndices = geometry.getIndex()?.array;
  const coherentAppearance = smoothSpectralAppearanceValues(
    appearance,
    meshIndices,
    SPECTRAL_APPEARANCE_SMOOTHING.passes,
    SPECTRAL_APPEARANCE_SMOOTHING.lumaBlend,
    SPECTRAL_APPEARANCE_SMOOTHING.lumaMaxDelta,
  );
  const coherentRelief = smoothSpectralAppearanceValues(
    relief,
    meshIndices,
    SPECTRAL_APPEARANCE_SMOOTHING.passes,
    SPECTRAL_APPEARANCE_SMOOTHING.reliefBlend,
    SPECTRAL_APPEARANCE_SMOOTHING.reliefMaxDelta,
  );
  geometry.setAttribute("bridgeAppearance", new THREE.BufferAttribute(coherentAppearance, 1));
  geometry.setAttribute("bridgeAppearanceRelief", new THREE.BufferAttribute(coherentRelief, 1));
  geometry.userData.spectralAppearanceViews = views.length;
  geometry.userData.spectralAppearanceFieldVersion = SPECTRAL_APPEARANCE_FIELD_VERSION;
  geometry.userData.spectralAppearanceSmoothingPasses = SPECTRAL_APPEARANCE_SMOOTHING.passes;
  return views.length;
}
