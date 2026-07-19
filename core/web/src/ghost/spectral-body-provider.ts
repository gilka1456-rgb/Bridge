import type { AvatarPose, Landmark, OrientationMask } from "../models/types";
import type { GhostBodyModel, GhostLodMesh } from "./body-model";
import { GHOST_RIG_VERSION } from "./body-model";
import {
  buildAnatomicalGhostBody,
  SPECTRAL_BODY_ALGORITHM_VERSION,
  SPECTRAL_BODY_VOXEL_SIZE,
  type AnatomicalBodyBuildRequest,
} from "./anatomical-body";
import { hashOrientationSource } from "./reconstruction-provider";
import { estimateTemplateBodyParams, hashTemplateBodyParams } from "./template-body";
import { bakeGhostLodPose, SPECTRAL_SKINNING_ALGORITHM_VERSION } from "./body-skinning";

export interface SpectralBodyInput {
  landmarks: Landmark[];
  orientations?: OrientationMask[];
  reconstruction?: AvatarPose["reconstruction"];
  avatarId?: string;
}

const bodyCache = new Map<string, GhostBodyModel>();
const bakedLodCache = new Map<string, GhostLodMesh>();
const DB_NAME = "bridge-spectral-body-v3";
const STORE_NAME = "models";

interface StoredGhostLod {
  voxelSize: number;
  vertexCount: number;
  triangleCount: number;
  positions: ArrayBuffer;
  normals: ArrayBuffer;
  indices: ArrayBuffer;
  skinIndices: ArrayBuffer;
  skinWeights: ArrayBuffer;
  canonicalCoords: ArrayBuffer;
  regionAndChain: ArrayBuffer;
}

interface StoredGhostBody {
  key: string;
  version: GhostBodyModel["version"];
  algorithmVersion: string;
  sourceHash: string;
  partial: GhostBodyModel["partial"];
  canonicalBounds: GhostBodyModel["canonicalBounds"];
  quality: GhostBodyModel["quality"];
  measurements: Omit<GhostBodyModel["measurements"], "boneLengths"> & { boneLengths: ArrayBuffer };
  rig: {
    version: GhostBodyModel["rig"]["version"];
    parentIndices: ArrayBuffer;
    restTranslations: ArrayBuffer;
    restRotations: ArrayBuffer;
    inverseBindMatrices: ArrayBuffer;
  };
  lods: StoredGhostLod[];
}

function copyArrayBuffer(view: ArrayBufferView): ArrayBuffer {
  const copy = new Uint8Array(view.byteLength);
  copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  return copy.buffer;
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

function restoreModel(record: StoredGhostBody): GhostBodyModel {
  return {
    version: record.version,
    algorithmVersion: record.algorithmVersion,
    sourceHash: record.sourceHash,
    partial: record.partial,
    canonicalBounds: record.canonicalBounds,
    quality: record.quality,
    measurements: {
      ...record.measurements,
      boneLengths: new Float32Array(record.measurements.boneLengths),
    },
    rig: {
      version: record.rig.version,
      parentIndices: new Int8Array(record.rig.parentIndices),
      restTranslations: new Float32Array(record.rig.restTranslations),
      restRotations: new Float32Array(record.rig.restRotations),
      inverseBindMatrices: new Float32Array(record.rig.inverseBindMatrices),
    },
    lods: record.lods.map((lod) => ({
      voxelSize: lod.voxelSize,
      vertexCount: lod.vertexCount,
      triangleCount: lod.triangleCount,
      positions: new Float32Array(lod.positions),
      normals: new Int16Array(lod.normals),
      indices: new Uint32Array(lod.indices),
      skinIndices: new Uint8Array(lod.skinIndices),
      skinWeights: new Uint8Array(lod.skinWeights),
      canonicalCoords: new Uint16Array(lod.canonicalCoords),
      regionAndChain: new Uint8Array(lod.regionAndChain),
    })),
  };
}

async function readStoredModel(key: string): Promise<GhostBodyModel | null> {
  const database = await openDatabase();
  if (!database) return null;
  return new Promise((resolve) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(key);
    request.onsuccess = () => {
      const record = request.result as StoredGhostBody | undefined;
      resolve(record ? restoreModel(record) : null);
    };
    request.onerror = () => resolve(null);
    transaction.oncomplete = () => database.close();
  });
}

async function storeModel(key: string, model: GhostBodyModel): Promise<void> {
  const database = await openDatabase();
  if (!database) return;
  const record: StoredGhostBody = {
    key,
    version: model.version,
    algorithmVersion: model.algorithmVersion,
    sourceHash: model.sourceHash,
    partial: model.partial,
    canonicalBounds: model.canonicalBounds,
    quality: model.quality,
    measurements: {
      ...model.measurements,
      boneLengths: copyArrayBuffer(model.measurements.boneLengths),
    },
    rig: {
      version: model.rig.version,
      parentIndices: copyArrayBuffer(model.rig.parentIndices),
      restTranslations: copyArrayBuffer(model.rig.restTranslations),
      restRotations: copyArrayBuffer(model.rig.restRotations),
      inverseBindMatrices: copyArrayBuffer(model.rig.inverseBindMatrices),
    },
    lods: model.lods.map((lod) => ({
      voxelSize: lod.voxelSize,
      vertexCount: lod.vertexCount,
      triangleCount: lod.triangleCount,
      positions: copyArrayBuffer(lod.positions),
      normals: copyArrayBuffer(lod.normals),
      indices: copyArrayBuffer(lod.indices),
      skinIndices: copyArrayBuffer(lod.skinIndices),
      skinWeights: copyArrayBuffer(lod.skinWeights),
      canonicalCoords: copyArrayBuffer(lod.canonicalCoords),
      regionAndChain: copyArrayBuffer(lod.regionAndChain),
    })),
  };
  await new Promise<void>((resolve) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(record);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  });
  database.close();
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function hashLandmarks(landmarks: Landmark[]): string {
  return fnv1a(landmarks.map((point) => (
    `${point.x.toFixed(5)},${point.y.toFixed(5)},${point.z.toFixed(5)},${point.visibility.toFixed(3)}`
  )).join("|"));
}

export function spectralBodySourceHash(input: SpectralBodyInput): string {
  if (input.reconstruction?.sourceHash) return input.reconstruction.sourceHash;
  if (input.orientations && input.orientations.length >= 2) return hashOrientationSource(input.orientations);
  return `landmarks-${hashLandmarks(input.landmarks)}`;
}

export function spectralBodyCacheKey(input: SpectralBodyInput): string {
  const measurementHash = hashTemplateBodyParams(estimateTemplateBodyParams(input.landmarks));
  return [
    SPECTRAL_BODY_ALGORITHM_VERSION,
    SPECTRAL_SKINNING_ALGORITHM_VERSION,
    GHOST_RIG_VERSION,
    SPECTRAL_BODY_VOXEL_SIZE.toFixed(3),
    spectralBodySourceHash(input),
    measurementHash,
    input.reconstruction?.partial ? "upper" : "full",
  ].join(":");
}

function requestForInput(input: SpectralBodyInput): AnatomicalBodyBuildRequest {
  return {
    landmarks: input.landmarks,
    orientations: input.orientations,
    sourceHash: spectralBodySourceHash(input),
    partial: input.reconstruction?.partial,
  };
}

function runWorker(request: AnatomicalBodyBuildRequest, signal?: AbortSignal): Promise<GhostBodyModel> {
  if (typeof Worker === "undefined") return Promise.resolve(buildAnatomicalGhostBody(request));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./spectral-body.worker.ts", import.meta.url), { type: "module" });
    const id = crypto.randomUUID();
    const abort = () => {
      worker.terminate();
      reject(new DOMException("Spectral body reconstruction cancelled.", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    worker.onmessage = (event: MessageEvent<
      { id: string; ok: true; model: GhostBodyModel }
      | { id: string; ok: false; message: string }
    >) => {
      if (event.data.id !== id) return;
      signal?.removeEventListener("abort", abort);
      worker.terminate();
      if (event.data.ok) resolve(event.data.model);
      else reject(new Error(event.data.message));
    };
    worker.onerror = (event) => {
      signal?.removeEventListener("abort", abort);
      worker.terminate();
      reject(new Error(event.message || "Spectral body worker failed."));
    };
    worker.postMessage({ id, request });
  });
}

export async function prepareSpectralBody(input: SpectralBodyInput, signal?: AbortSignal): Promise<GhostBodyModel> {
  const key = spectralBodyCacheKey(input);
  const cached = bodyCache.get(key);
  if (cached) return cached;
  const stored = await readStoredModel(key);
  if (stored) {
    bodyCache.set(key, stored);
    return stored;
  }
  if (signal?.aborted) throw new DOMException("Spectral body reconstruction cancelled.", "AbortError");
  const model = await runWorker(requestForInput(input), signal);
  bodyCache.set(key, model);
  await storeModel(key, model);
  return model;
}

export function getPreparedSpectralBody(input: SpectralBodyInput): GhostBodyModel | undefined {
  return bodyCache.get(spectralBodyCacheKey(input));
}

export function buildSpectralBodySynchronously(input: SpectralBodyInput): GhostBodyModel {
  const key = spectralBodyCacheKey(input);
  const cached = bodyCache.get(key);
  if (cached) return cached;
  const model = buildAnatomicalGhostBody(requestForInput(input));
  bodyCache.set(key, model);
  return model;
}

export function getBakedSpectralBodyLod(
  model: GhostBodyModel,
  input: SpectralBodyInput,
  lodIndex = 0,
): GhostLodMesh {
  const resolvedIndex = Math.max(0, Math.min(model.lods.length - 1, Math.trunc(lodIndex)));
  const key = `${spectralBodyCacheKey(input)}:lod:${resolvedIndex}:pose:${hashLandmarks(input.landmarks)}`;
  const cached = bakedLodCache.get(key);
  if (cached) return cached;
  const baked = bakeGhostLodPose(model.lods[resolvedIndex], model.rig, input.landmarks);
  bakedLodCache.set(key, baked);
  return baked;
}

export function clearSpectralBodyCache(): void {
  bodyCache.clear();
  bakedLodCache.clear();
}
