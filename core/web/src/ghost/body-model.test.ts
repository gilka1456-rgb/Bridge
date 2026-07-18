import { describe, expect, it } from "vitest";
import {
  GHOST_RIG_BONE_NAMES,
  GHOST_RIG_VERSION,
  GHOST_VERTEX_STRIDE_BYTES,
  validateGhostLodContract,
  validateGhostRigContract,
  type GhostLodMesh,
  type GhostRig,
} from "./body-model";

function validRig(): GhostRig {
  return {
    version: GHOST_RIG_VERSION,
    parentIndices: new Int8Array([-1, 0, 1, 2, 3, 2, 5, 6, 2, 8, 9, 0, 11, 12, 0, 14, 15]),
    restTranslations: new Float32Array(17 * 3),
    restRotations: new Float32Array(17 * 4),
    inverseBindMatrices: new Float32Array(17 * 16),
  };
}

function validLod(): GhostLodMesh {
  return {
    voxelSize: 0.018,
    vertexCount: 4,
    triangleCount: 2,
    positions: new Float32Array(12),
    normals: new Int16Array(12),
    indices: new Uint32Array(6),
    skinIndices: new Uint8Array(16),
    skinWeights: new Uint8Array(16),
    canonicalCoords: new Uint16Array(12),
    regionAndChain: new Uint8Array(8),
  };
}

describe("Spectral V3 body contract", () => {
  it("locks the cross-client 17-bone order and compact vertex stride", () => {
    expect(GHOST_RIG_BONE_NAMES).toEqual([
      "pelvis", "spine", "chest", "neck", "head",
      "l_upperArm", "l_foreArm", "l_hand",
      "r_upperArm", "r_foreArm", "r_hand",
      "l_thigh", "l_calf", "l_foot",
      "r_thigh", "r_calf", "r_foot",
    ]);
    expect(GHOST_VERTEX_STRIDE_BYTES).toBe(36);
    expect(validateGhostRigContract(validRig())).toEqual([]);
  });

  it("rejects rig order/shape drift", () => {
    const rig = validRig();
    rig.parentIndices[6] = 16;
    expect(validateGhostRigContract(rig)).toContain("l_foreArm must reference an earlier parent bone.");
  });

  it("validates every per-vertex array against the declared vertex count", () => {
    expect(validateGhostLodContract(validLod())).toEqual([]);
    const broken = validLod();
    broken.skinWeights = new Uint8Array(15);
    expect(validateGhostLodContract(broken)).toContain("skinWeights length does not match vertexCount.");
  });

  it("rejects non-finite positions and out-of-range triangle indices", () => {
    const nonFinite = validLod();
    nonFinite.positions[0] = Number.NaN;
    expect(validateGhostLodContract(nonFinite)).toContain("positions contain non-finite values.");

    const outOfRange = validLod();
    outOfRange.indices[0] = outOfRange.vertexCount;
    expect(validateGhostLodContract(outOfRange)).toContain("indices reference vertices outside the LOD.");
  });
});
