import * as THREE from "three";
import type { OrientationMask } from "../models/types";
import { decodeAppearanceLuma } from "../pose/segmentation";

const HULL_SCALE_X = 2.2 * 0.45;
const HULL_SCALE_Y = 2.4 * 0.5;
const HULL_SCALE_Z = 2.2 * 0.45;
const HULL_FLOOR_OFFSET = -0.1;

interface AppearanceView {
  azimuth: number;
  width: number;
  height: number;
  luma: Uint8Array;
  anchor?: OrientationMask["anchor"];
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
  if (view.anchor) {
    return [
      (view.anchor.pelvis.x + horizontal * view.anchor.anchorHeight) / Math.max(view.width - 1, 1),
      (view.anchor.pelvis.y - point.y * view.anchor.anchorHeight) / Math.max(view.height - 1, 1),
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

/**
 * Bakes the best-facing blurred photo luminance into one scalar vertex channel.
 * The style shaders consume the same channel with different strengths, keeping
 * appearance capture independent from fantasy/cyber rendering.
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
    const luma = decodeAppearanceLuma(
      orientation.appearanceLuma,
      (orientation.appearanceWidth ?? orientation.width)
        * (orientation.appearanceHeight ?? orientation.height),
    );
    return luma ? [{
      azimuth: orientation.azimuth,
      width: orientation.appearanceWidth ?? orientation.width,
      height: orientation.appearanceHeight ?? orientation.height,
      luma,
      anchor: orientation.anchor,
      cameraDirection: cameraDirection(orientation.azimuth),
    }] : [];
  });
  const appearance = new Float32Array(position.count);
  appearance.fill(0.5);
  if (views.length === 0) {
    geometry.setAttribute("bridgeAppearance", new THREE.BufferAttribute(appearance, 1));
    geometry.userData.spectralAppearanceViews = 0;
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
    let totalWeight = 0;
    for (const view of views) {
      const [u, v] = projectToView(nativePoint, view);
      const sampled = sampleView(view, u, v);
      if (sampled === null) continue;
      const facing = Math.max(0, surfaceNormal.dot(view.cameraDirection));
      const weight = 0.015 + facing * facing;
      weightedLuma += sampled * weight;
      totalWeight += weight;
    }
    if (totalWeight > 0) appearance[vertex] = weightedLuma / totalWeight;
  }
  geometry.setAttribute("bridgeAppearance", new THREE.BufferAttribute(appearance, 1));
  geometry.userData.spectralAppearanceViews = views.length;
  return views.length;
}
