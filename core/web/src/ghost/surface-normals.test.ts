import { describe, expect, it } from "vitest";
import { smoothQuantizedSurfaceNormals } from "./surface-normals";

function quantize(values: readonly number[]): Int16Array {
  return new Int16Array(values.map((value) => Math.round(value * 32767)));
}

function edgeVariation(normals: Int16Array, indices: readonly number[]): number {
  const edges = new Set<string>();
  let variation = 0;
  let count = 0;
  const add = (left: number, right: number) => {
    const a = Math.min(left, right);
    const b = Math.max(left, right);
    const key = `${a}:${b}`;
    if (edges.has(key)) return;
    edges.add(key);
    const ai = a * 3;
    const bi = b * 3;
    const dot = (normals[ai] * normals[bi]
      + normals[ai + 1] * normals[bi + 1]
      + normals[ai + 2] * normals[bi + 2]) / (32767 * 32767);
    variation += 1 - dot;
    count += 1;
  };
  for (let index = 0; index + 2 < indices.length; index += 3) {
    add(indices[index], indices[index + 1]);
    add(indices[index + 1], indices[index + 2]);
    add(indices[index + 2], indices[index]);
  }
  return variation / Math.max(count, 1);
}

describe("spectral surface normal coherence", () => {
  it("reduces adjacent shading noise without changing geometry", () => {
    const indices = [0, 1, 2, 0, 2, 3];
    const source = quantize([
      0, 0, 1,
      0.42, 0, 0.9075,
      -0.36, 0.08, 0.9295,
      0.12, -0.31, 0.943,
    ]);
    const smoothed = smoothQuantizedSurfaceNormals(source, indices, {
      passes: 2,
      blend: 0.48,
    });

    expect(edgeVariation(smoothed, indices)).toBeLessThan(edgeVariation(source, indices) * 0.55);
    for (let vertex = 0; vertex < smoothed.length / 3; vertex += 1) {
      const offset = vertex * 3;
      const length = Math.hypot(smoothed[offset], smoothed[offset + 1], smoothed[offset + 2]) / 32767;
      expect(length).toBeCloseTo(1, 3);
    }
  });

  it("does not blur across an intentional hard fold", () => {
    const source = quantize([
      0, 0, 1,
      0, 0, 1,
      1, 0, 0,
    ]);
    const smoothed = smoothQuantizedSurfaceNormals(source, [0, 1, 2], {
      passes: 3,
      blend: 1,
      minDot: 0.25,
    });
    expect(smoothed[2]).toBeGreaterThan(32760);
    expect(smoothed[6]).toBeGreaterThan(32760);
    expect(Math.abs(smoothed[8])).toBeLessThan(8);
  });
});
