/** Stable Spectral V3 body asset contract. Geometry is style-independent. */
export const GHOST_BODY_MODEL_VERSION = "ghost-body-v3" as const;
export const GHOST_RIG_VERSION = "ghost-rig-17-v1" as const;

export const GHOST_BODY_REGIONS = Object.freeze({
  core: 0,
  head: 1,
  leftArm: 2,
  rightArm: 3,
  leftLeg: 4,
  rightLeg: 5,
} as const);

export const GHOST_RIG_BONE_NAMES = [
  "pelvis",
  "spine",
  "chest",
  "neck",
  "head",
  "l_upperArm",
  "l_foreArm",
  "l_hand",
  "r_upperArm",
  "r_foreArm",
  "r_hand",
  "l_thigh",
  "l_calf",
  "l_foot",
  "r_thigh",
  "r_calf",
  "r_foot",
] as const;

export type GhostBoneName = (typeof GHOST_RIG_BONE_NAMES)[number];

export const GHOST_VERTEX_LAYOUT = Object.freeze({
  position: { components: 3, storage: "float32", bytes: 12 },
  normal: { components: 3, storage: "int16-normalized", bytes: 8 },
  skinIndex: { components: 4, storage: "uint8", bytes: 4 },
  skinWeight: { components: 4, storage: "uint8-normalized", bytes: 4 },
  canonicalCoord: { components: 3, storage: "uint16-normalized", bytes: 6 },
  regionAndChain: { components: 2, storage: "uint8", bytes: 2 },
} as const);

export const GHOST_VERTEX_STRIDE_BYTES = Object.values(GHOST_VERTEX_LAYOUT)
  .reduce((total, attribute) => total + attribute.bytes, 0);

export interface GhostCanonicalBounds {
  min: [number, number, number];
  max: [number, number, number];
}

export interface GhostRig {
  version: typeof GHOST_RIG_VERSION;
  /** One signed parent index per fixed-order bone. pelvis is -1. */
  parentIndices: Int8Array;
  /** Standard-pose local translations, xyz per fixed-order bone. */
  restTranslations: Float32Array;
  /** Standard-pose local rotations, xyzw per fixed-order bone. */
  restRotations: Float32Array;
  /** Inverse bind matrices, 16 floats per fixed-order bone. */
  inverseBindMatrices: Float32Array;
}

export interface BodyMeasurements {
  height: number;
  shoulderWidth: number;
  chestWidth: number;
  waistWidth: number;
  hipWidth: number;
  headDiameter: number;
  /** One measured length per fixed-order bone. */
  boneLengths: Float32Array;
}

export interface GhostLodMesh {
  voxelSize: number;
  vertexCount: number;
  triangleCount: number;
  positions: Float32Array;
  /** Signed normalized xyz. Storage may include two alignment padding bytes per vertex. */
  normals: Int16Array;
  indices: Uint32Array;
  skinIndices: Uint8Array;
  skinWeights: Uint8Array;
  canonicalCoords: Uint16Array;
  /** Interleaved regionId and normalized chainT bytes. */
  regionAndChain: Uint8Array;
}

export interface GhostBodyQuality {
  connectedComponents: number;
  boundaryEdges: number;
  degenerateTriangles: number;
  nonFiniteVertices: number;
  flippedTriangles: number;
  normalCoherencePercent: number;
  frontSilhouetteIou?: number;
  backSilhouetteIou?: number;
  leftSilhouetteIou?: number;
  rightSilhouetteIou?: number;
}

export interface GhostBodyModel {
  version: typeof GHOST_BODY_MODEL_VERSION;
  algorithmVersion: string;
  sourceHash: string;
  rig: GhostRig;
  lods: GhostLodMesh[];
  measurements: BodyMeasurements;
  partial: "full" | "upper";
  canonicalBounds: GhostCanonicalBounds;
  quality: GhostBodyQuality;
}

export function validateGhostRigContract(rig: GhostRig): string[] {
  const errors: string[] = [];
  const count = GHOST_RIG_BONE_NAMES.length;
  if (rig.version !== GHOST_RIG_VERSION) errors.push(`Unsupported rig version: ${rig.version}`);
  if (rig.parentIndices.length !== count) errors.push("parentIndices must contain 17 values.");
  if (rig.restTranslations.length !== count * 3) errors.push("restTranslations must contain 17 vec3 values.");
  if (rig.restRotations.length !== count * 4) errors.push("restRotations must contain 17 quaternions.");
  if (rig.inverseBindMatrices.length !== count * 16) errors.push("inverseBindMatrices must contain 17 mat4 values.");
  if (rig.parentIndices[0] !== -1) errors.push("pelvis must be the only root bone.");
  for (let index = 1; index < Math.min(rig.parentIndices.length, count); index += 1) {
    if (rig.parentIndices[index] < 0 || rig.parentIndices[index] >= index) {
      errors.push(`${GHOST_RIG_BONE_NAMES[index]} must reference an earlier parent bone.`);
    }
  }
  return errors;
}

export function validateGhostLodContract(lod: GhostLodMesh): string[] {
  const errors: string[] = [];
  const vertices = lod.vertexCount;
  if (lod.positions.length !== vertices * 3) errors.push("positions length does not match vertexCount.");
  if (lod.normals.length !== vertices * 3) errors.push("normals length does not match vertexCount.");
  if (lod.skinIndices.length !== vertices * 4) errors.push("skinIndices length does not match vertexCount.");
  if (lod.skinWeights.length !== vertices * 4) errors.push("skinWeights length does not match vertexCount.");
  if (lod.canonicalCoords.length !== vertices * 3) errors.push("canonicalCoords length does not match vertexCount.");
  if (lod.regionAndChain.length !== vertices * 2) errors.push("regionAndChain length does not match vertexCount.");
  if (lod.indices.length !== lod.triangleCount * 3) errors.push("indices length does not match triangleCount.");
  if (lod.positions.some((value) => !Number.isFinite(value))) {
    errors.push("positions contain non-finite values.");
  }
  if (lod.indices.some((value) => value >= vertices)) {
    errors.push("indices reference vertices outside the LOD.");
  }
  return errors;
}
