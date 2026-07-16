import * as THREE from "three";
import type { OrientationMask } from "../models/types";
import {
  decodePersonMaskRLE,
  normalizePersonMask,
} from "../pose/segmentation";

export const VISUAL_HULL_ALGORITHM_VERSION = "soft-hull-v2";

export interface VisualHullMeshData {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  occupiedRatio: number;
  triangleCount: number;
}

export type VisualHullFailureCode =
  | "insufficient-views"
  | "invalid-mask"
  | "empty-volume"
  | "mesh-empty"
  | "mesh-invalid";

export type VisualHullBuildResult =
  | { ok: true; mesh: VisualHullMeshData }
  | { ok: false; code: VisualHullFailureCode; message: string };

const GRID_X = 64;
const GRID_Y = 128;
const GRID_Z = 64;

const BOUNDS_X = 0.5;
const BOUNDS_Y = 1;
const BOUNDS_Z = 0.5;

interface DecodedView {
  azimuth: number;
  width: number;
  height: number;
  sdf: Float32Array;
}

function distanceTransform(mask: Uint8Array, width: number, height: number, target: 0 | 1): Float32Array {
  const diagonal = Math.SQRT2;
  const distance = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i += 1) distance[i] = mask[i] === target ? 0 : 1e6;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      let value = distance[index];
      if (x > 0) value = Math.min(value, distance[index - 1] + 1);
      if (y > 0) value = Math.min(value, distance[index - width] + 1);
      if (x > 0 && y > 0) value = Math.min(value, distance[index - width - 1] + diagonal);
      if (x + 1 < width && y > 0) value = Math.min(value, distance[index - width + 1] + diagonal);
      distance[index] = value;
    }
  }
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const index = y * width + x;
      let value = distance[index];
      if (x + 1 < width) value = Math.min(value, distance[index + 1] + 1);
      if (y + 1 < height) value = Math.min(value, distance[index + width] + 1);
      if (x + 1 < width && y + 1 < height) value = Math.min(value, distance[index + width + 1] + diagonal);
      if (x > 0 && y + 1 < height) value = Math.min(value, distance[index + width - 1] + diagonal);
      distance[index] = value;
    }
  }
  return distance;
}

function signedDistance(mask: Uint8Array, width: number, height: number): Float32Array {
  const toInside = distanceTransform(mask, width, height, 1);
  const toOutside = distanceTransform(mask, width, height, 0);
  const result = new Float32Array(mask.length);
  for (let index = 0; index < mask.length; index += 1) {
    result[index] = mask[index] ? toOutside[index] : -toInside[index];
  }
  return result;
}

function voxelCenterToWorld(ix: number, iy: number, iz: number): [number, number, number] {
  const x = ((ix + 0.5) / GRID_X) * 2 * BOUNDS_X - BOUNDS_X;
  const y = ((iy + 0.5) / GRID_Y) * 2 * BOUNDS_Y - BOUNDS_Y;
  const z = ((iz + 0.5) / GRID_Z) * 2 * BOUNDS_Z - BOUNDS_Z;
  return [x, y, z];
}

function gridCornerToWorld(gx: number, gy: number, gz: number): [number, number, number] {
  const x = (gx / GRID_X) * 2 * BOUNDS_X - BOUNDS_X;
  const y = (gy / GRID_Y) * 2 * BOUNDS_Y - BOUNDS_Y;
  const z = (gz / GRID_Z) * 2 * BOUNDS_Z - BOUNDS_Z;
  return [x, y, z];
}

function projectToMaskUV(x: number, y: number, z: number, azimuth: number): [number, number] {
  const angle = ((Math.round(azimuth / 90) * 90) % 360 + 360) % 360;
  let u: number;
  switch (angle) {
    case 0:
      u = x + BOUNDS_X;
      break;
    case 90:
      u = z + BOUNDS_Z;
      break;
    case 180:
      u = BOUNDS_X - x;
      break;
    case 270:
      u = BOUNDS_Z - z;
      break;
    default:
      u = x + BOUNDS_X;
      break;
  }
  const v = (BOUNDS_Y - y) / (2 * BOUNDS_Y);
  return [u, v];
}

function sampleSdf(view: DecodedView, u: number, v: number): number {
  if (u < 0 || u > 1 || v < 0 || v > 1) {
    return -8;
  }
  const fx = Math.min(view.width - 1, Math.max(0, u * (view.width - 1)));
  const fy = Math.min(view.height - 1, Math.max(0, v * (view.height - 1)));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(view.width - 1, x0 + 1);
  const y1 = Math.min(view.height - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const top = view.sdf[y0 * view.width + x0] * (1 - tx) + view.sdf[y0 * view.width + x1] * tx;
  const bottom = view.sdf[y1 * view.width + x0] * (1 - tx) + view.sdf[y1 * view.width + x1] * tx;
  return top * (1 - ty) + bottom * ty;
}

function carveVoxels(views: DecodedView[]): Float32Array {
  const total = GRID_X * GRID_Y * GRID_Z;
  const field = new Float32Array(total);
  const frontal = views.filter((view) => view.azimuth === 0 || view.azimuth === 180);
  const lateral = views.filter((view) => view.azimuth === 90 || view.azimuth === 270);
  const tolerancePixels = 1.25;

  for (let iz = 0; iz < GRID_Z; iz += 1) {
    for (let iy = 0; iy < GRID_Y; iy += 1) {
      for (let ix = 0; ix < GRID_X; ix += 1) {
        const index = ix + iy * GRID_X + iz * GRID_X * GRID_Y;
        const [x, y, z] = voxelCenterToWorld(ix, iy, iz);
        const axisScore = (axisViews: DecodedView[]): number => {
          if (axisViews.length === 0) return -8;
          let best = -1e6;
          for (const view of axisViews) {
            const [u, v] = projectToMaskUV(x, y, z, view.azimuth);
            best = Math.max(best, sampleSdf(view, u, v));
          }
          return best + tolerancePixels;
        };
        if (frontal.length && lateral.length) {
          field[index] = Math.min(axisScore(frontal), axisScore(lateral));
        } else {
          let score = 1e6;
          for (const view of views) {
          const [u, v] = projectToMaskUV(x, y, z, view.azimuth);
            score = Math.min(score, sampleSdf(view, u, v) + tolerancePixels);
          }
          field[index] = score;
        }
      }
    }
  }

  return field;
}

function voxelIndex(ix: number, iy: number, iz: number): number {
  return ix + iy * GRID_X + iz * GRID_X * GRID_Y;
}

function sampleField(field: Float32Array, ix: number, iy: number, iz: number): number {
  if (ix < 0 || iy < 0 || iz < 0 || ix >= GRID_X || iy >= GRID_Y || iz >= GRID_Z) {
    return 0;
  }
  return field[voxelIndex(ix, iy, iz)];
}

// Paul Bourke marching-cubes tables (256 cases).
const EDGE_TABLE = [
  0x0, 0x109, 0x203, 0x30a, 0x406, 0x50f, 0x605, 0x70c, 0x80c, 0x905, 0xa0f, 0xb06, 0xc0a, 0xd03, 0xe09, 0xf00,
  0x190, 0x99, 0x393, 0x29a, 0x596, 0x49f, 0x795, 0x69c, 0x99c, 0x895, 0xb9f, 0xa96, 0xd9a, 0xc93, 0xf9b, 0xe92,
  0x230, 0x339, 0x33, 0x13a, 0x636, 0x73f, 0x435, 0x53c, 0xa3c, 0xb35, 0x83f, 0x936, 0xe3a, 0xf33, 0xc3b, 0xd32,
  0x3a0, 0x2a9, 0x1a3, 0xaa, 0x7a6, 0x6af, 0x5a5, 0x4ac, 0xbac, 0xaa5, 0x9af, 0x8a6, 0xfaa, 0xea3, 0xda9, 0xca0,
  0x460, 0x569, 0x663, 0x76a, 0x66, 0x16f, 0x265, 0x36c, 0xc6c, 0xd65, 0xe6f, 0xf66, 0x86a, 0x963, 0xa69, 0xb60,
  0x5f0, 0x4f9, 0x7f3, 0x6fa, 0x1f6, 0xff, 0x3f5, 0x2fc, 0xdfc, 0xcf5, 0xfff, 0xef6, 0x9fa, 0x8f3, 0xbf9, 0xaf0,
  0x650, 0x759, 0x453, 0x55a, 0x256, 0x35f, 0x55, 0x15c, 0xe5c, 0xf55, 0xc5f, 0xd56, 0xa5a, 0xb53, 0x859, 0x950,
  0x7c0, 0x6c9, 0x5c3, 0x4ca, 0x3c6, 0x2cf, 0x1c5, 0xcc, 0xfcc, 0xec5, 0xdcf, 0xcc6, 0xaca, 0xbc3, 0x8c9, 0x9c0,
  0x8c0, 0x9c9, 0xac3, 0xbca, 0xcc6, 0xdcf, 0xec5, 0xfcc, 0xcc, 0x1c5, 0x2cf, 0x3c6, 0x4ca, 0x5c3, 0x6c9, 0x7c0,
  0x950, 0x859, 0xb53, 0xa5a, 0xd56, 0xc5f, 0xf55, 0xe5c, 0x15c, 0x55, 0x35f, 0x256, 0x55a, 0x453, 0x759, 0x650,
  0xaf0, 0xbf9, 0x8f3, 0x9fa, 0xef6, 0xfff, 0xcf5, 0xdfc, 0x2fc, 0x3f5, 0xff, 0x1f6, 0x6fa, 0x7f3, 0x4f9, 0x5f0,
  0xb60, 0xa69, 0x963, 0x86a, 0xf66, 0xe6f, 0xd65, 0xc6c, 0x36c, 0x265, 0x16f, 0x66, 0x76a, 0x663, 0x569, 0x460,
  0xca0, 0xda9, 0xea3, 0xfaa, 0x8a6, 0x9af, 0xaa5, 0xbac, 0x4ac, 0x5a5, 0x6af, 0x7a6, 0xaa, 0x1a3, 0x2a9, 0x3a0,
  0xd32, 0xc3b, 0xf33, 0xe3a, 0x936, 0x83f, 0xb35, 0xa3c, 0x53c, 0x435, 0x73f, 0x636, 0x13a, 0x33, 0x339, 0x230,
  0xe92, 0xf9b, 0xc93, 0xd9a, 0xa96, 0xb9f, 0x895, 0x99c, 0x69c, 0x795, 0x49f, 0x596, 0x29a, 0x393, 0x99, 0x190,
  0xf00, 0xe09, 0xd03, 0xc0a, 0xb06, 0xa0f, 0x905, 0x80c, 0x70c, 0x605, 0x50f, 0x406, 0x30a, 0x203, 0x109, 0x0,
] as const;

const TRI_TABLE: readonly (readonly number[])[] = [
  [], [0, 8, 3], [0, 1, 9], [1, 8, 3, 9, 8, 1], [1, 2, 10], [0, 8, 3, 1, 2, 10], [9, 2, 10, 0, 2, 9], [2, 8, 3, 2, 10, 8, 10, 9, 8],
  [3, 11, 2], [0, 11, 2, 8, 11, 0], [1, 9, 0, 2, 3, 11], [1, 11, 2, 1, 9, 11, 9, 8, 11], [3, 10, 1, 11, 10, 3], [0, 10, 1, 0, 8, 10, 8, 11, 10],
  [3, 9, 0, 3, 11, 9, 11, 10, 9], [9, 8, 10, 10, 8, 11], [4, 7, 8], [4, 3, 0, 7, 3, 4], [0, 1, 9, 8, 4, 7], [4, 1, 9, 4, 7, 1, 7, 3, 1],
  [1, 2, 10, 8, 4, 7], [3, 4, 7, 3, 0, 4, 1, 2, 10], [9, 2, 10, 9, 0, 2, 8, 4, 7], [2, 10, 9, 2, 9, 7, 2, 7, 3, 7, 9, 4],
  [8, 4, 7, 3, 11, 2], [11, 4, 7, 11, 2, 4, 2, 0, 4], [9, 0, 1, 8, 4, 7, 2, 3, 11], [4, 7, 11, 9, 4, 11, 9, 11, 2, 9, 2, 1],
  [3, 10, 1, 3, 11, 10, 7, 8, 4], [1, 11, 10, 1, 4, 11, 1, 0, 4, 7, 11, 4], [4, 7, 8, 9, 0, 11, 9, 11, 10, 11, 0, 3],
  [4, 7, 11, 4, 11, 9, 9, 11, 10], [9, 5, 4], [9, 5, 4, 0, 8, 3], [0, 5, 4, 1, 5, 0], [8, 5, 4, 8, 3, 5, 3, 1, 5],
  [1, 2, 10, 9, 5, 4], [3, 0, 8, 1, 2, 10, 4, 9, 5], [5, 2, 10, 5, 4, 2, 4, 0, 2], [2, 10, 5, 3, 2, 5, 3, 5, 4, 3, 4, 8],
  [9, 5, 4, 2, 3, 11], [0, 11, 2, 0, 8, 11, 4, 9, 5], [0, 5, 4, 0, 1, 5, 2, 3, 11], [2, 1, 5, 2, 5, 8, 2, 8, 11, 4, 8, 5],
  [10, 3, 11, 10, 1, 3, 9, 5, 4], [4, 9, 5, 0, 8, 1, 8, 10, 1, 8, 11, 10], [5, 4, 0, 5, 0, 11, 5, 11, 10, 11, 0, 3],
  [5, 4, 8, 5, 8, 10, 10, 8, 11], [9, 7, 8, 5, 7, 9], [9, 3, 0, 9, 5, 3, 5, 7, 3], [0, 7, 8, 0, 1, 7, 1, 5, 7],
  [1, 5, 3, 3, 5, 7], [9, 7, 8, 9, 5, 7, 10, 1, 2], [10, 1, 2, 9, 5, 0, 5, 3, 0, 5, 7, 3], [8, 0, 2, 8, 2, 5, 8, 5, 7, 10, 5, 2],
  [2, 10, 5, 2, 5, 3, 3, 5, 7], [7, 9, 5, 7, 8, 9, 3, 11, 2], [9, 5, 7, 9, 7, 2, 9, 2, 0, 2, 7, 11],
  [2, 3, 11, 0, 1, 8, 1, 7, 8, 1, 5, 7], [11, 2, 1, 11, 1, 7, 7, 1, 5], [9, 5, 8, 8, 5, 7, 10, 1, 3, 10, 3, 11],
  [5, 7, 0, 5, 0, 9, 7, 11, 0, 1, 0, 10, 11, 10, 0], [11, 10, 0, 11, 0, 3, 10, 5, 0, 8, 0, 7, 5, 7, 0],
  [11, 10, 5, 7, 11, 5], [10, 6, 5], [0, 8, 3, 5, 10, 6], [9, 0, 1, 5, 10, 6], [1, 8, 3, 1, 9, 8, 5, 10, 6],
  [1, 6, 5, 2, 6, 1], [1, 6, 5, 1, 2, 6, 3, 0, 8], [9, 6, 5, 9, 0, 6, 0, 2, 6], [5, 9, 8, 5, 8, 2, 5, 2, 6, 3, 2, 8],
  [2, 3, 11, 10, 6, 5], [11, 0, 8, 11, 2, 0, 10, 6, 5], [0, 1, 9, 2, 3, 11, 5, 10, 6], [5, 10, 6, 1, 9, 2, 9, 11, 2, 9, 8, 11],
  [6, 3, 11, 6, 5, 3, 5, 1, 3], [0, 8, 11, 0, 11, 5, 0, 5, 1, 5, 11, 6], [3, 11, 6, 0, 3, 6, 0, 6, 5, 0, 5, 9],
  [6, 5, 9, 6, 9, 11, 11, 9, 8], [5, 10, 6, 4, 7, 8], [4, 3, 0, 4, 7, 3, 6, 5, 10], [1, 9, 0, 5, 10, 6, 8, 4, 7],
  [10, 6, 5, 1, 9, 7, 1, 7, 3, 7, 9, 4], [6, 1, 2, 6, 5, 1, 4, 7, 8], [1, 2, 5, 5, 2, 6, 3, 0, 4, 3, 4, 7],
  [8, 4, 7, 9, 0, 5, 0, 6, 5, 0, 2, 6], [7, 3, 9, 7, 9, 4, 3, 2, 9, 5, 9, 6, 2, 6, 9],
  [3, 11, 2, 7, 8, 4, 10, 6, 5], [5, 10, 6, 4, 7, 2, 4, 2, 0, 2, 7, 11], [0, 1, 9, 4, 7, 8, 2, 3, 11, 5, 10, 6],
  [9, 2, 1, 9, 11, 2, 9, 4, 11, 7, 11, 4, 5, 10, 6], [8, 4, 7, 3, 11, 5, 3, 5, 1, 5, 11, 6], [5, 1, 11, 5, 11, 6, 1, 0, 11, 7, 11, 4, 0, 4, 11],
  [0, 5, 9, 0, 6, 5, 0, 3, 6, 11, 6, 3, 8, 4, 7], [6, 5, 9, 6, 9, 11, 4, 7, 9, 7, 11, 9], [10, 4, 9, 6, 4, 10],
  [4, 10, 6, 4, 9, 10, 0, 8, 3], [10, 0, 1, 10, 6, 0, 6, 4, 0], [8, 3, 1, 8, 1, 6, 8, 6, 4, 6, 1, 10],
  [1, 4, 9, 1, 2, 4, 2, 6, 4], [3, 0, 8, 1, 2, 9, 2, 4, 9, 2, 6, 4], [0, 2, 4, 4, 2, 6], [8, 3, 2, 8, 2, 4, 4, 2, 6],
  [10, 4, 9, 10, 6, 4, 11, 2, 3], [0, 8, 2, 2, 8, 11, 4, 9, 10, 4, 10, 6], [3, 11, 2, 0, 1, 6, 0, 6, 4, 6, 1, 10],
  [6, 4, 1, 6, 1, 10, 4, 8, 1, 2, 1, 11, 8, 11, 1], [9, 6, 4, 9, 3, 6, 9, 1, 3, 11, 6, 3], [8, 11, 1, 8, 1, 0, 11, 6, 1, 9, 1, 4, 6, 4, 1],
  [3, 11, 6, 3, 6, 0, 0, 6, 4], [6, 4, 8, 11, 6, 8], [7, 10, 6, 7, 8, 10, 8, 9, 10], [0, 7, 3, 0, 10, 7, 0, 9, 10, 6, 7, 10],
  [10, 6, 7, 1, 10, 7, 1, 7, 8, 1, 8, 0], [10, 6, 7, 10, 7, 1, 1, 7, 3], [1, 2, 6, 1, 6, 8, 1, 8, 9, 8, 6, 7],
  [2, 6, 9, 2, 9, 1, 6, 7, 9, 0, 9, 3, 7, 3, 9], [7, 8, 0, 7, 0, 6, 6, 0, 2], [7, 3, 2, 6, 7, 2],
  [2, 3, 11, 10, 6, 8, 10, 8, 9, 8, 6, 7], [2, 0, 7, 2, 7, 11, 0, 9, 7, 6, 7, 10, 9, 10, 7],
  [1, 8, 0, 1, 7, 8, 1, 10, 7, 6, 7, 10, 2, 3, 11], [11, 2, 1, 11, 1, 7, 10, 6, 1, 6, 7, 1],
  [8, 9, 6, 8, 6, 7, 9, 1, 6, 11, 6, 3, 1, 3, 6], [0, 9, 1, 11, 6, 7], [7, 8, 0, 7, 0, 6, 6, 0, 11],
  [7, 11, 6], [7, 6, 11], [3, 0, 8, 11, 7, 6], [0, 1, 9, 11, 7, 6], [8, 1, 9, 8, 3, 1, 11, 7, 6],
  [10, 1, 2, 6, 11, 7], [1, 2, 10, 3, 0, 8, 6, 11, 7], [2, 9, 0, 2, 10, 9, 6, 11, 7], [6, 11, 7, 2, 10, 3, 10, 8, 3, 10, 9, 8],
  [7, 2, 3, 6, 2, 7], [7, 0, 8, 7, 6, 0, 6, 2, 0], [2, 7, 6, 2, 3, 7, 0, 1, 9], [1, 6, 2, 1, 8, 6, 1, 9, 8, 8, 7, 6],
  [10, 7, 6, 10, 1, 7, 1, 3, 7], [10, 7, 6, 1, 7, 10, 1, 8, 7, 1, 0, 8], [0, 3, 7, 0, 7, 10, 0, 10, 9, 6, 10, 7],
  [7, 6, 10, 7, 10, 8, 8, 10, 9], [6, 8, 4, 11, 8, 6], [3, 6, 11, 3, 0, 6, 0, 4, 6], [8, 6, 11, 8, 4, 6, 9, 0, 1],
  [9, 4, 6, 9, 6, 3, 9, 3, 1, 11, 3, 6], [6, 8, 4, 6, 11, 8, 2, 10, 1], [1, 2, 10, 3, 0, 11, 0, 6, 11, 0, 4, 6],
  [4, 11, 8, 4, 6, 11, 0, 2, 9, 2, 10, 9], [10, 9, 3, 10, 3, 2, 9, 4, 3, 11, 3, 6, 4, 6, 3],
  [8, 2, 3, 8, 4, 2, 4, 6, 2], [0, 4, 2, 4, 6, 2], [1, 9, 0, 2, 3, 4, 2, 4, 6, 4, 3, 8],
  [1, 9, 4, 1, 4, 2, 2, 4, 6], [8, 1, 3, 8, 6, 1, 8, 4, 6, 6, 10, 1], [10, 1, 0, 10, 0, 6, 6, 0, 4],
  [4, 6, 3, 4, 3, 8, 6, 10, 3, 0, 3, 9, 10, 9, 3], [10, 9, 4, 6, 10, 4], [4, 9, 5, 7, 6, 11],
  [0, 8, 3, 4, 9, 5, 11, 7, 6], [5, 0, 1, 5, 4, 0, 7, 6, 11], [11, 7, 6, 8, 3, 4, 3, 5, 4, 3, 1, 5],
  [9, 5, 4, 10, 1, 2, 7, 6, 11], [6, 11, 7, 1, 2, 10, 0, 8, 3, 4, 9, 5], [7, 6, 11, 5, 4, 10, 4, 2, 10, 4, 0, 2],
  [3, 4, 8, 3, 5, 4, 3, 2, 5, 10, 5, 2, 11, 7, 6], [7, 2, 3, 7, 6, 2, 5, 4, 9], [9, 5, 4, 0, 8, 6, 0, 6, 2, 6, 8, 7],
  [3, 6, 2, 3, 7, 6, 1, 5, 0], [6, 2, 8, 6, 8, 7, 2, 1, 8, 4, 8, 5, 1, 5, 8], [9, 5, 4, 10, 1, 6, 1, 7, 6, 1, 3, 7],
  [1, 6, 10, 1, 7, 6, 1, 0, 7, 8, 7, 0, 9, 5, 4], [4, 0, 10, 4, 10, 5, 0, 3, 10, 6, 10, 7, 3, 7, 10],
  [7, 6, 10, 7, 10, 8, 5, 4, 10, 4, 8, 10], [6, 9, 5, 6, 11, 9, 11, 8, 9], [3, 6, 11, 0, 6, 3, 0, 5, 6, 0, 9, 5],
  [0, 11, 8, 0, 5, 11, 0, 1, 5, 5, 6, 11], [6, 11, 3, 6, 3, 5, 5, 3, 1], [1, 2, 10, 9, 5, 11, 9, 11, 8, 11, 5, 6],
  [0, 11, 3, 0, 6, 11, 0, 9, 6, 5, 6, 9, 1, 2, 10], [11, 8, 5, 11, 5, 6, 8, 0, 5, 10, 5, 2, 0, 2, 5],
  [6, 11, 3, 6, 3, 5, 2, 10, 3, 10, 5, 3], [5, 8, 9, 5, 2, 8, 5, 6, 2, 3, 8, 2], [9, 5, 6, 9, 6, 0, 0, 6, 2],
  [1, 5, 8, 1, 8, 0, 5, 6, 8, 3, 8, 2, 6, 2, 8], [1, 5, 6, 2, 1, 6], [1, 5, 6, 1, 6, 2, 3, 0, 8],
  [9, 5, 0, 5, 6, 0], [0, 3, 8, 5, 6, 10], [10, 5, 6], [11, 5, 10, 7, 5, 11], [11, 5, 10, 11, 7, 5, 8, 3, 0],
  [5, 11, 7, 5, 10, 11, 1, 9, 0], [10, 7, 5, 10, 11, 7, 9, 8, 1, 8, 3, 1], [11, 1, 2, 11, 7, 1, 7, 5, 1],
  [0, 8, 3, 1, 2, 7, 1, 7, 5, 7, 2, 11], [9, 7, 5, 9, 2, 7, 9, 0, 2, 2, 11, 7], [7, 5, 2, 7, 2, 11, 5, 9, 2, 3, 2, 8, 9, 8, 2],
  [2, 5, 10, 2, 3, 5, 3, 7, 5], [8, 2, 0, 8, 5, 2, 8, 7, 5, 10, 2, 5], [9, 0, 1, 5, 10, 3, 5, 3, 7, 3, 10, 2],
  [9, 8, 2, 9, 2, 1, 8, 7, 2, 10, 2, 5, 7, 5, 2], [1, 3, 5, 3, 7, 5], [0, 8, 7, 0, 7, 1, 1, 7, 5],
  [9, 0, 3, 9, 3, 5, 5, 3, 7], [9, 8, 7, 5, 9, 7], [5, 8, 4, 5, 10, 8, 10, 11, 8],
  [5, 0, 4, 5, 11, 0, 5, 10, 11, 11, 3, 0], [0, 1, 9, 8, 4, 10, 8, 10, 11, 10, 4, 5],
  [10, 11, 4, 10, 4, 5, 11, 3, 4, 9, 4, 1, 3, 1, 4], [2, 5, 1, 2, 8, 5, 2, 11, 8, 4, 5, 8],
  [0, 4, 11, 0, 11, 3, 4, 5, 11, 2, 11, 1, 5, 1, 11], [0, 2, 5, 0, 5, 9, 2, 11, 5, 4, 5, 8, 11, 8, 5],
  [9, 4, 5, 2, 11, 3], [2, 5, 10, 3, 5, 2, 3, 4, 5, 3, 8, 4], [5, 10, 2, 5, 2, 4, 4, 2, 0],
  [3, 10, 2, 3, 5, 10, 3, 8, 5, 4, 5, 8, 0, 1, 9], [5, 10, 2, 5, 2, 4, 1, 9, 2, 9, 4, 2],
  [8, 4, 5, 8, 5, 3, 3, 5, 1], [0, 4, 1, 4, 5, 1], [8, 4, 5, 8, 5, 3, 9, 0, 5, 0, 3, 5],
  [9, 4, 5], [4, 11, 7, 4, 9, 11, 9, 10, 11], [0, 8, 3, 4, 9, 7, 9, 11, 7, 9, 10, 11],
  [1, 10, 11, 1, 11, 4, 1, 4, 0, 7, 4, 11], [3, 1, 4, 3, 4, 8, 1, 10, 4, 7, 4, 11, 10, 11, 4],
  [4, 11, 7, 9, 11, 4, 9, 2, 11, 9, 1, 2], [9, 7, 4, 9, 11, 7, 9, 1, 11, 2, 11, 1, 0, 8, 3],
  [11, 7, 4, 11, 4, 2, 2, 4, 0], [11, 7, 4, 11, 4, 2, 8, 3, 4, 3, 2, 4], [2, 9, 10, 2, 7, 9, 2, 3, 7, 7, 4, 9],
  [9, 10, 7, 9, 7, 4, 10, 2, 7, 8, 7, 0, 2, 0, 7], [3, 7, 10, 3, 10, 2, 7, 4, 10, 1, 10, 0, 4, 0, 10],
  [1, 10, 0, 4, 10, 1, 4, 11, 10, 4, 7, 11], [4, 11, 7, 9, 11, 4, 9, 2, 11, 9, 1, 2],
  [9, 7, 4, 9, 11, 7, 9, 1, 11, 2, 11, 1, 0, 8, 3], [11, 7, 4, 11, 4, 2, 2, 4, 0],
  [11, 7, 4, 11, 4, 2, 8, 3, 4, 3, 2, 4], [2, 1, 9, 2, 9, 7, 2, 7, 3, 7, 9, 4],
  [9, 7, 4, 9, 4, 1, 1, 4, 0], [3, 8, 1, 3, 1, 2, 8, 7, 1, 4, 1, 0, 7, 0, 1],
  [9, 1, 4, 4, 1, 7], [1, 4, 9, 1, 2, 4, 2, 6, 4], [3, 0, 8, 1, 2, 9, 2, 4, 9, 2, 6, 4],
  [0, 2, 4, 4, 2, 6], [8, 3, 2, 8, 2, 4, 4, 2, 6], [10, 4, 9, 10, 6, 4, 11, 2, 3],
  [0, 8, 2, 2, 8, 11, 4, 9, 10, 4, 10, 6], [3, 11, 2, 0, 1, 6, 0, 6, 4, 6, 1, 10],
  [6, 4, 1, 6, 1, 10, 4, 8, 1, 2, 1, 11, 8, 11, 1], [9, 6, 4, 9, 3, 6, 9, 1, 3, 11, 6, 3],
  [8, 11, 1, 8, 1, 0, 11, 6, 1, 9, 1, 4, 6, 4, 1], [3, 11, 6, 3, 6, 0, 0, 6, 4], [6, 4, 8, 11, 6, 8],
  [7, 10, 6, 7, 8, 10, 8, 9, 10], [0, 7, 3, 0, 10, 7, 0, 9, 10, 6, 7, 10], [10, 6, 7, 1, 10, 7, 1, 7, 8, 1, 8, 0],
  [10, 6, 7, 10, 7, 1, 1, 7, 3], [1, 2, 6, 1, 6, 8, 1, 8, 9, 8, 6, 7], [2, 6, 9, 2, 9, 1, 6, 7, 9, 0, 9, 3, 7, 3, 9],
  [7, 8, 0, 7, 0, 6, 6, 0, 2], [7, 3, 2, 6, 7, 2], [2, 3, 11, 10, 6, 8, 10, 8, 9, 8, 6, 7],
  [2, 0, 7, 2, 7, 11, 0, 9, 7, 6, 7, 10, 9, 10, 7], [1, 8, 0, 1, 7, 8, 1, 10, 7, 6, 7, 10, 2, 3, 11],
  [11, 2, 1, 11, 1, 7, 10, 6, 1, 6, 7, 1], [8, 9, 6, 8, 6, 7, 9, 1, 6, 11, 6, 3, 1, 3, 6],
  [0, 9, 1, 11, 6, 7], [7, 8, 0, 7, 0, 6, 6, 0, 11], [7, 11, 6], [3, 7, 11, 3, 11, 2, 7, 4, 11, 9, 11, 0, 4, 0, 11],
  [9, 0, 1, 3, 7, 11, 3, 11, 2], [7, 4, 11, 1, 11, 9, 4, 9, 11], [4, 7, 8, 9, 11, 1, 9, 2, 11, 9, 4, 2],
  [3, 4, 9, 3, 9, 11, 11, 9, 2], [9, 10, 1, 4, 7, 8], [4, 1, 9, 4, 7, 1, 7, 3, 1], [1, 2, 10, 8, 4, 7],
  [3, 4, 7, 3, 7, 2, 7, 4, 2], [1, 9, 0, 4, 7, 8, 2, 3, 11], [2, 4, 7, 2, 7, 3, 4, 9, 7, 0, 7, 9],
  [4, 0, 9, 4, 2, 0, 2, 11, 0], [11, 2, 3, 4, 9, 5, 4, 5, 8, 5, 9, 0], [5, 4, 0, 5, 0, 11, 5, 11, 10, 11, 0, 3],
  [0, 1, 9, 8, 4, 10, 8, 10, 11, 10, 4, 5], [10, 11, 4, 10, 4, 5, 11, 3, 4, 9, 4, 1, 3, 1, 4],
  [2, 5, 1, 2, 8, 5, 2, 11, 8, 4, 5, 8], [0, 4, 11, 0, 11, 3, 4, 5, 11, 2, 11, 1, 5, 1, 11],
  [0, 2, 5, 0, 5, 9, 2, 11, 5, 4, 5, 8, 11, 8, 5], [9, 4, 5, 2, 11, 3], [2, 5, 10, 3, 5, 2, 3, 4, 5, 3, 8, 4],
  [5, 10, 2, 5, 2, 4, 4, 2, 0], [3, 10, 2, 3, 5, 10, 3, 8, 5, 4, 5, 8, 0, 1, 9], [5, 10, 2, 5, 2, 4, 1, 9, 2, 9, 4, 2],
  [8, 4, 5, 8, 5, 3, 3, 5, 1], [0, 4, 1, 4, 5, 1], [8, 4, 5, 8, 5, 3, 9, 0, 5, 0, 3, 5], [9, 4, 5],
  [4, 11, 7, 4, 9, 11, 9, 10, 11], [0, 8, 3, 4, 9, 7, 9, 11, 7, 9, 10, 11], [1, 10, 11, 1, 11, 4, 1, 4, 0, 7, 4, 11],
  [3, 1, 4, 3, 4, 8, 1, 10, 4, 7, 4, 11, 10, 11, 4], [4, 11, 7, 9, 11, 4, 9, 2, 11, 9, 1, 2],
  [9, 7, 4, 9, 11, 7, 9, 1, 11, 2, 11, 1, 0, 8, 3], [11, 7, 4, 11, 4, 2, 2, 4, 0], [11, 7, 4, 11, 4, 2, 8, 3, 4, 3, 2, 4],
  [2, 9, 10, 2, 7, 9, 2, 3, 7, 7, 4, 9], [9, 10, 7, 9, 7, 4, 10, 2, 7, 8, 7, 0, 2, 0, 7],
  [3, 7, 10, 3, 10, 2, 7, 4, 10, 1, 10, 0, 4, 0, 10], [1, 10, 0, 4, 10, 1, 4, 11, 10, 4, 7, 11],
  [4, 11, 7, 9, 11, 4, 9, 2, 11, 9, 1, 2], [9, 7, 4, 9, 11, 7, 9, 1, 11, 2, 11, 1, 0, 8, 3],
  [11, 7, 4, 11, 4, 2, 2, 4, 0], [11, 7, 4, 11, 4, 2, 8, 3, 4, 3, 2, 4], [2, 1, 9, 2, 9, 7, 2, 7, 3, 7, 9, 4],
  [9, 7, 4, 9, 4, 1, 1, 4, 0], [3, 8, 1, 3, 1, 2, 8, 7, 1, 4, 1, 0, 7, 0, 1], [9, 1, 4, 4, 1, 7],
  [4, 8, 7, 9, 8, 4], [9, 7, 4, 9, 11, 7, 11, 2, 7], [9, 5, 4, 0, 8, 3, 7, 11, 2], [2, 7, 11, 2, 1, 7, 1, 5, 7],
  [9, 5, 4, 9, 1, 5, 9, 11, 1, 7, 1, 11], [5, 1, 11, 5, 11, 6, 1, 0, 11, 7, 11, 4, 0, 4, 11],
  [0, 5, 9, 0, 6, 5, 0, 3, 6, 11, 6, 3, 8, 4, 7], [6, 5, 9, 6, 9, 11, 4, 7, 9, 7, 11, 9],
  [10, 4, 9, 6, 4, 10], [4, 10, 6, 4, 9, 10, 0, 8, 3], [10, 0, 1, 10, 6, 0, 6, 4, 0],
  [8, 3, 1, 8, 1, 6, 8, 6, 4, 6, 1, 10], [1, 4, 9, 1, 2, 4, 2, 6, 4], [3, 0, 8, 1, 2, 9, 2, 4, 9, 2, 6, 4],
  [0, 2, 4, 4, 2, 6], [8, 3, 2, 8, 2, 4, 4, 2, 6], [10, 4, 9, 10, 6, 4, 11, 2, 3],
  [0, 8, 2, 2, 8, 11, 4, 9, 10, 4, 10, 6], [3, 11, 2, 0, 1, 6, 0, 6, 4, 6, 1, 10],
  [6, 4, 1, 6, 1, 10, 4, 8, 1, 2, 1, 11, 8, 11, 1], [9, 6, 4, 9, 3, 6, 9, 1, 3, 11, 6, 3],
  [8, 11, 1, 8, 1, 0, 11, 6, 1, 9, 1, 4, 6, 4, 1], [3, 11, 6, 3, 6, 0, 0, 6, 4], [6, 4, 8, 11, 6, 8],
  [7, 10, 6, 7, 8, 10, 8, 9, 10], [0, 7, 3, 0, 10, 7, 0, 9, 10, 6, 7, 10], [10, 6, 7, 1, 10, 7, 1, 7, 8, 1, 8, 0],
  [10, 6, 7, 10, 7, 1, 1, 7, 3], [1, 2, 6, 1, 6, 8, 1, 8, 9, 8, 6, 7], [2, 6, 9, 2, 9, 1, 6, 7, 9, 0, 9, 3, 7, 3, 9],
  [7, 8, 0, 7, 0, 6, 6, 0, 2], [7, 3, 2, 6, 7, 2], [2, 3, 11, 10, 6, 8, 10, 8, 9, 8, 6, 7],
  [2, 0, 7, 2, 7, 11, 0, 9, 7, 6, 7, 10, 9, 10, 7], [1, 8, 0, 1, 7, 8, 1, 10, 7, 6, 7, 10, 2, 3, 11],
  [11, 2, 1, 11, 1, 7, 10, 6, 1, 6, 7, 1], [8, 9, 6, 8, 6, 7, 9, 1, 6, 11, 6, 3, 1, 3, 6],
  [0, 9, 1, 11, 6, 7], [7, 8, 0, 7, 0, 6, 6, 0, 11], [7, 11, 6],
];

const CORNER_OFFSETS: readonly [number, number, number][] = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 0, 1],
  [0, 0, 1],
  [0, 1, 0],
  [1, 1, 0],
  [1, 1, 1],
  [0, 1, 1],
];

const EDGE_ENDPOINTS: readonly [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

function interpolateVertex(
  p1: [number, number, number],
  p2: [number, number, number],
  v1: number,
  v2: number,
  iso: number,
): [number, number, number] {
  if (Math.abs(iso - v1) < 1e-6) {
    return p1;
  }
  if (Math.abs(iso - v2) < 1e-6) {
    return p2;
  }
  if (Math.abs(v1 - v2) < 1e-6) {
    return p1;
  }
  const t = (iso - v1) / (v2 - v1);
  return [
    p1[0] + t * (p2[0] - p1[0]),
    p1[1] + t * (p2[1] - p1[1]),
    p1[2] + t * (p2[2] - p1[2]),
  ];
}

function marchingCubes(field: Float32Array): { positions: number[]; normals: number[]; indices: number[] } {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const edgeVertexCache = new Map<string, number>();
  const iso = 0;

  const cornerPos = (ix: number, iy: number, iz: number, corner: number): [number, number, number] => {
    const [dx, dy, dz] = CORNER_OFFSETS[corner];
    return gridCornerToWorld(ix + dx, iy + dy, iz + dz);
  };

  const getEdgeVertex = (ix: number, iy: number, iz: number, edge: number): number => {
    const [c0, c1] = EDGE_ENDPOINTS[edge];
    const [dx0, dy0, dz0] = CORNER_OFFSETS[c0];
    const [dx1, dy1, dz1] = CORNER_OFFSETS[c1];
    const a = `${ix + dx0},${iy + dy0},${iz + dz0}`;
    const b = `${ix + dx1},${iy + dy1},${iz + dz1}`;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    const cached = edgeVertexCache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const v0 = sampleField(field, ix + dx0, iy + dy0, iz + dz0);
    const v1 = sampleField(field, ix + dx1, iy + dy1, iz + dz1);
    const p0 = cornerPos(ix, iy, iz, c0);
    const p1 = cornerPos(ix, iy, iz, c1);
    const vertex = interpolateVertex(p0, p1, v0, v1, iso);

    const index = positions.length / 3;
    positions.push(vertex[0], vertex[1], vertex[2]);
    normals.push(0, 0, 0);
    edgeVertexCache.set(key, index);
    return index;
  };

  for (let iz = 0; iz < GRID_Z - 1; iz += 1) {
    for (let iy = 0; iy < GRID_Y - 1; iy += 1) {
      for (let ix = 0; ix < GRID_X - 1; ix += 1) {
        let cubeIndex = 0;
        for (let corner = 0; corner < 8; corner += 1) {
          const [dx, dy, dz] = CORNER_OFFSETS[corner];
          if (sampleField(field, ix + dx, iy + dy, iz + dz) >= iso) {
            cubeIndex |= 1 << corner;
          }
        }
        if (cubeIndex === 0 || cubeIndex === 255) {
          continue;
        }

        const edgeFlags = EDGE_TABLE[cubeIndex];
        const edgeVerts: number[] = new Array(12).fill(-1);
        for (let edge = 0; edge < 12; edge += 1) {
          if (edgeFlags & (1 << edge)) {
            edgeVerts[edge] = getEdgeVertex(ix, iy, iz, edge);
          }
        }

        const triangles = TRI_TABLE[cubeIndex];
        for (let t = 0; t < triangles.length; t += 3) {
          const a = edgeVerts[triangles[t]];
          const b = edgeVerts[triangles[t + 1]];
          const c = edgeVerts[triangles[t + 2]];
          if (a < 0 || b < 0 || c < 0) {
            continue;
          }
          indices.push(a, b, c);

          const ax = positions[a * 3];
          const ay = positions[a * 3 + 1];
          const az = positions[a * 3 + 2];
          const bx = positions[b * 3];
          const by = positions[b * 3 + 1];
          const bz = positions[b * 3 + 2];
          const cx = positions[c * 3];
          const cy = positions[c * 3 + 1];
          const cz = positions[c * 3 + 2];

          const e1x = bx - ax;
          const e1y = by - ay;
          const e1z = bz - az;
          const e2x = cx - ax;
          const e2y = cy - ay;
          const e2z = cz - az;
          const nx = e1y * e2z - e1z * e2y;
          const ny = e1z * e2x - e1x * e2z;
          const nz = e1x * e2y - e1y * e2x;
          const len = Math.hypot(nx, ny, nz) || 1;
          const fnx = nx / len;
          const fny = ny / len;
          const fnz = nz / len;

          for (const vi of [a, b, c]) {
            normals[vi * 3] += fnx;
            normals[vi * 3 + 1] += fny;
            normals[vi * 3 + 2] += fnz;
          }
        }
      }
    }
  }

  for (let i = 0; i < normals.length; i += 3) {
    const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    normals[i] /= len;
    normals[i + 1] /= len;
    normals[i + 2] /= len;
  }

  return { positions, normals, indices };
}

function smoothPass(
  positions: number[],
  indices: number[],
  factor: number,
): void {
  const vertexCount = positions.length / 3;
  const neighbors: number[][] = Array.from({ length: vertexCount }, () => []);

  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i];
    const b = indices[i + 1];
    const c = indices[i + 2];
    neighbors[a].push(b, c);
    neighbors[b].push(a, c);
    neighbors[c].push(a, b);
  }

  const next = positions.slice();
  for (let v = 0; v < vertexCount; v += 1) {
    const unique = [...new Set(neighbors[v])];
    if (unique.length === 0) {
      continue;
    }
    let ax = 0;
    let ay = 0;
    let az = 0;
    for (const n of unique) {
      ax += positions[n * 3];
      ay += positions[n * 3 + 1];
      az += positions[n * 3 + 2];
    }
    ax /= unique.length;
    ay /= unique.length;
    az /= unique.length;
    next[v * 3] = positions[v * 3] + (ax - positions[v * 3]) * factor;
    next[v * 3 + 1] = positions[v * 3 + 1] + (ay - positions[v * 3 + 1]) * factor;
    next[v * 3 + 2] = positions[v * 3 + 2] + (az - positions[v * 3 + 2]) * factor;
  }

  positions.splice(0, positions.length, ...next);
}

function taubinSmooth(positions: number[], indices: number[], iterations = 3): void {
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    smoothPass(positions, indices, 0.5);
    smoothPass(positions, indices, -0.53);
  }
}

function recomputeNormals(positions: number[], indices: number[]): number[] {
  const normals = new Array<number>(positions.length).fill(0);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;
    const abx = positions[b] - positions[a];
    const aby = positions[b + 1] - positions[a + 1];
    const abz = positions[b + 2] - positions[a + 2];
    const acx = positions[c] - positions[a];
    const acy = positions[c + 1] - positions[a + 1];
    const acz = positions[c + 2] - positions[a + 2];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    for (const vertex of [a, b, c]) {
      normals[vertex] += nx;
      normals[vertex + 1] += ny;
      normals[vertex + 2] += nz;
    }
  }
  for (let index = 0; index < normals.length; index += 3) {
    const length = Math.hypot(normals[index], normals[index + 1], normals[index + 2]) || 1;
    normals[index] /= length;
    normals[index + 1] /= length;
    normals[index + 2] /= length;
  }
  return normals;
}

function hasOccupiedVoxels(field: Float32Array): boolean {
  for (let i = 0; i < field.length; i += 1) {
    if (field[i] >= 0) {
      return true;
    }
  }
  return false;
}

function decodeViews(orientations: OrientationMask[]): DecodedView[] | null {
  const views: DecodedView[] = [];
  for (const orientation of orientations) {
    if (orientation.width <= 0 || orientation.height <= 0 || !orientation.mask) return null;
    let mask: Uint8Array;
    try {
      mask = decodePersonMaskRLE(orientation.mask, orientation.width * orientation.height);
    } catch {
      return null;
    }
    let width = orientation.width;
    let height = orientation.height;
    if (!orientation.normalized) {
      const normalized = normalizePersonMask(mask, width, height);
      if (!normalized) return null;
      mask = normalized.mask;
      width = normalized.width;
      height = normalized.height;
    }
    views.push({
      azimuth: ((Math.round(orientation.azimuth / 90) * 90) % 360 + 360) % 360,
      width,
      height,
      sdf: signedDistance(mask, width, height),
    });
  }
  return views;
}

export function buildVisualHullMeshData(orientations: OrientationMask[]): VisualHullBuildResult {
  if (orientations.length < 2) {
    return { ok: false, code: "insufficient-views", message: "At least two silhouette directions are required." };
  }

  const views = decodeViews(orientations);
  if (!views) return { ok: false, code: "invalid-mask", message: "A silhouette mask could not be decoded or normalized." };

  const field = carveVoxels(views);
  if (!hasOccupiedVoxels(field)) {
    return { ok: false, code: "empty-volume", message: "The aligned silhouettes have no shared body volume." };
  }

  const mesh = marchingCubes(field);
  if (mesh.indices.length < 3) {
    return { ok: false, code: "mesh-empty", message: "Marching Cubes did not produce a surface." };
  }

  taubinSmooth(mesh.positions, mesh.indices);
  const normals = recomputeNormals(mesh.positions, mesh.indices);
  const occupied = field.reduce((count, value) => count + (value >= 0 ? 1 : 0), 0);
  const triangleCount = mesh.indices.length / 3;
  const hasInvalidPosition = mesh.positions.some((value) => !Number.isFinite(value));
  if (triangleCount > 25_000 || hasInvalidPosition) {
    return {
      ok: false,
      code: "mesh-invalid",
      message: `The generated surface exceeded safety limits (${triangleCount} triangles, invalid=${hasInvalidPosition}).`,
    };
  }
  return {
    ok: true,
    mesh: {
      positions: new Float32Array(mesh.positions),
      normals: new Float32Array(normals),
      indices: new Uint32Array(mesh.indices),
      occupiedRatio: occupied / field.length,
      triangleCount,
    },
  };
}

export function geometryFromMeshData(mesh: VisualHullMeshData): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
  geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

export function buildVisualHullGeometry(orientations: OrientationMask[]): THREE.BufferGeometry | null {
  const result = buildVisualHullMeshData(orientations);
  if (!result.ok) {
    console.warn(`[Bridge visual hull] ${result.code}: ${result.message}`);
    return null;
  }

  return geometryFromMeshData(result.mesh);
}
