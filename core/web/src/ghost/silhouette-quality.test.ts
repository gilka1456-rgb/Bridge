import { describe, expect, it } from "vitest";
import type { OrientationMask } from "../models/types";
import { encodePersonMaskRLE } from "../pose/segmentation";
import {
  measureGhostBodySilhouetteEvidence,
  measureMeshSilhouetteIou,
  SPECTRAL_SILHOUETTE_IOU_TARGETS,
} from "./silhouette-quality";

const HULL_SCALE_X = 2.2 * 0.45;
const HULL_SCALE_Y = 2.4 * 0.5;
const HULL_SCALE_Z = 2.2 * 0.45;
const HULL_FLOOR_OFFSET = -0.1;

function boxMesh() {
  const hullVertices = [
    [-0.25, -0.5, -0.1], [0.25, -0.5, -0.1], [0.25, 0.5, -0.1], [-0.25, 0.5, -0.1],
    [-0.25, -0.5, 0.1], [0.25, -0.5, 0.1], [0.25, 0.5, 0.1], [-0.25, 0.5, 0.1],
  ];
  const positions = new Float32Array(hullVertices.flatMap(([x, y, z]) => [
    x * HULL_SCALE_X,
    y * HULL_SCALE_Y + HULL_FLOOR_OFFSET,
    z * HULL_SCALE_Z,
  ]));
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2,
    4, 5, 6, 4, 6, 7,
    0, 4, 7, 0, 7, 3,
    1, 2, 6, 1, 6, 5,
    0, 1, 5, 0, 5, 4,
    3, 7, 6, 3, 6, 2,
  ]);
  return { positions, indices };
}

function rectangularView(
  azimuth: number,
  minX: number,
  maxX: number,
  quality = 0.9,
): OrientationMask {
  const width = 65;
  const height = 65;
  const mask = new Uint8Array(width * height);
  for (let y = 16; y < 48; y += 1) {
    for (let x = minX; x < maxX; x += 1) mask[y * width + x] = 1;
  }
  return {
    azimuth,
    width,
    height,
    mask: encodePersonMaskRLE(mask),
    normalized: true,
    quality,
  };
}

describe("spectral silhouette quality evidence", () => {
  it("measures a matching final mesh projection and distinguishes a narrower capture", () => {
    const mesh = boxMesh();
    const matching = measureMeshSilhouetteIou(mesh.positions, mesh.indices, rectangularView(0, 16, 48));
    const narrow = measureMeshSilhouetteIou(mesh.positions, mesh.indices, rectangularView(0, 26, 38));
    expect(matching).toBeGreaterThan(0.96);
    expect(narrow).toBeLessThan(matching! * 0.5);
  });

  it("maps all four directions and keeps the highest-confidence duplicate", () => {
    const mesh = boxMesh();
    const evidence = measureGhostBodySilhouetteEvidence(mesh, [
      { ...rectangularView(0, 16, 48, 1), mask: "%%%" },
      rectangularView(0, 26, 38, 0.2),
      rectangularView(0, 16, 48, 0.95),
      rectangularView(180, 16, 48),
      rectangularView(90, 26, 38),
      rectangularView(270, 26, 38),
    ]);
    expect(evidence.frontSilhouetteIou).toBeGreaterThan(0.96);
    expect(evidence.backSilhouetteIou).toBeGreaterThan(0.96);
    expect(evidence.rightSilhouetteIou).toBeGreaterThan(0.85);
    expect(evidence.leftSilhouetteIou).toBeGreaterThan(0.85);
    expect(SPECTRAL_SILHOUETTE_IOU_TARGETS).toEqual({
      front: 0.85,
      back: 0.85,
      left: 0.78,
      right: 0.78,
    });
  });

  it("returns no evidence for an invalid or empty mask", () => {
    const mesh = boxMesh();
    expect(measureMeshSilhouetteIou(mesh.positions, mesh.indices, {
      ...rectangularView(0, 16, 48),
      mask: "%%%",
    })).toBeUndefined();
    expect(measureMeshSilhouetteIou(mesh.positions, mesh.indices, {
      ...rectangularView(0, 16, 48),
      mask: encodePersonMaskRLE(new Uint8Array(65 * 65)),
    })).toBeUndefined();
  });
});
