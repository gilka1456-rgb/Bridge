import type {
  AvatarPose,
  OrientationMask,
  ReconstructionProviderId,
} from "../models/types";
import { evictHullGeometryByKey, installHullGeometry, getHullGeometry } from "./hull-cache";
import {
  buildVisualHullMeshData,
  VISUAL_HULL_ALGORITHM_VERSION,
  type VisualHullBuildResult,
  type VisualHullMeshData,
} from "./visual-hull";

const DB_NAME = "bridge-ghost-mesh-v1";
const STORE_NAME = "meshes";
const meshDataCache = new Map<string, VisualHullMeshData>();

export interface ReconstructionProgress {
  stage: "cache" | "carving" | "complete";
  percent: number;
}

export interface ReconstructionRequest {
  orientations: OrientationMask[];
  sourceHash?: string;
}

export interface ReconstructionResult {
  provider: ReconstructionProviderId;
  sourceHash: string;
  meshKey: string;
  quality: number;
  algorithmVersion: string;
  mesh: VisualHullMeshData;
}

export interface ReconstructionProvider {
  reconstruct(
    request: ReconstructionRequest,
    signal?: AbortSignal,
    onProgress?: (progress: ReconstructionProgress) => void,
  ): Promise<ReconstructionResult>;
}

interface StoredMesh {
  key: string;
  positions: ArrayBuffer;
  normals: ArrayBuffer;
  indices: ArrayBuffer;
  occupiedRatio: number;
  triangleCount: number;
}

function copyArrayBuffer(view: ArrayBufferView): ArrayBuffer {
  const copy = new Uint8Array(view.byteLength);
  copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  return copy.buffer;
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function hashOrientationSource(orientations: OrientationMask[]): string {
  const stable = [...orientations]
    .sort((a, b) => a.azimuth - b.azimuth)
    .map((item) => `${item.azimuth}:${item.width}x${item.height}:${item.normalized ? 1 : 0}:${item.mask}`)
    .join("|");
  return fnv1a(stable);
}

export function meshKeyForSource(sourceHash: string): string {
  return `${VISUAL_HULL_ALGORITHM_VERSION}:${sourceHash}`;
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

async function readStoredMesh(key: string): Promise<VisualHullMeshData | null> {
  const database = await openDatabase();
  if (!database) return null;
  return new Promise((resolve) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(key);
    request.onsuccess = () => {
      const record = request.result as StoredMesh | undefined;
      resolve(record ? {
        positions: new Float32Array(record.positions),
        normals: new Float32Array(record.normals),
        indices: new Uint32Array(record.indices),
        occupiedRatio: record.occupiedRatio,
        triangleCount: record.triangleCount,
      } : null);
    };
    request.onerror = () => resolve(null);
    transaction.oncomplete = () => database.close();
  });
}

async function storeMesh(key: string, mesh: VisualHullMeshData): Promise<void> {
  const database = await openDatabase();
  if (!database) return;
  await new Promise<void>((resolve) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put({
      key,
      positions: copyArrayBuffer(mesh.positions),
      normals: copyArrayBuffer(mesh.normals),
      indices: copyArrayBuffer(mesh.indices),
      occupiedRatio: mesh.occupiedRatio,
      triangleCount: mesh.triangleCount,
    } satisfies StoredMesh);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  });
  database.close();
}

function runWorker(orientations: OrientationMask[], signal?: AbortSignal): Promise<VisualHullBuildResult> {
  if (typeof Worker === "undefined") return Promise.resolve(buildVisualHullMeshData(orientations));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./reconstruction.worker.ts", import.meta.url), { type: "module" });
    const id = crypto.randomUUID();
    const abort = () => {
      worker.terminate();
      reject(new DOMException("Reconstruction cancelled.", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    worker.onmessage = (event: MessageEvent<{ id: string; result: VisualHullBuildResult }>) => {
      if (event.data.id !== id) return;
      signal?.removeEventListener("abort", abort);
      worker.terminate();
      resolve(event.data.result);
    };
    worker.onerror = (event) => {
      signal?.removeEventListener("abort", abort);
      worker.terminate();
      reject(new Error(event.message || "Reconstruction worker failed."));
    };
    worker.postMessage({ id, orientations });
  });
}

export class LocalVisualHullProvider implements ReconstructionProvider {
  async reconstruct(
    request: ReconstructionRequest,
    signal?: AbortSignal,
    onProgress?: (progress: ReconstructionProgress) => void,
  ): Promise<ReconstructionResult> {
    const sourceHash = request.sourceHash ?? hashOrientationSource(request.orientations);
    const meshKey = meshKeyForSource(sourceHash);
    onProgress?.({ stage: "cache", percent: 0.05 });

    const inMemory = meshDataCache.get(meshKey);
    if (inMemory && getHullGeometry(meshKey)) {
      return this.finish(sourceHash, meshKey, request.orientations, inMemory, onProgress);
    }
    const stored = await readStoredMesh(meshKey);
    if (stored) return this.finish(sourceHash, meshKey, request.orientations, stored, onProgress);

    if (signal?.aborted) throw new DOMException("Reconstruction cancelled.", "AbortError");
    onProgress?.({ stage: "carving", percent: 0.25 });
    const build = await runWorker(request.orientations, signal);
    if (!build.ok) throw new Error(`${build.code}: ${build.message}`);
    installHullGeometry(meshKey, build.mesh);
    void storeMesh(meshKey, build.mesh);
    return this.finish(sourceHash, meshKey, request.orientations, build.mesh, onProgress);
  }

  private finish(
    sourceHash: string,
    meshKey: string,
    orientations: OrientationMask[],
    mesh: VisualHullMeshData,
    onProgress?: (progress: ReconstructionProgress) => void,
  ): ReconstructionResult {
    meshDataCache.set(meshKey, mesh);
    installHullGeometry(meshKey, mesh);
    const averageInputQuality = orientations.reduce((sum, item) => sum + (item.quality ?? 0.75), 0)
      / Math.max(orientations.length, 1);
    const quality = Math.max(0, Math.min(1, averageInputQuality * 0.75 + Math.min(mesh.occupiedRatio * 4, 1) * 0.25));
    onProgress?.({ stage: "complete", percent: 1 });
    return {
      provider: "local-visual-hull",
      sourceHash,
      meshKey,
      quality,
      algorithmVersion: VISUAL_HULL_ALGORITHM_VERSION,
      mesh,
    };
  }
}

export const localReconstructionProvider = new LocalVisualHullProvider();

export async function deleteReconstructionCache(meshKey: string): Promise<void> {
  meshDataCache.delete(meshKey);
  evictHullGeometryByKey(meshKey);
  const database = await openDatabase();
  if (!database) return;
  await new Promise<void>((resolve) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(meshKey);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  });
  database.close();
}

export async function prepareAvatarReconstruction(pose: AvatarPose, signal?: AbortSignal): Promise<void> {
  if (!pose.orientations || pose.orientations.length < 2) return;
  const meshKey = pose.reconstruction?.meshKey
    ?? meshKeyForSource(hashOrientationSource(pose.orientations));
  if (getHullGeometry(meshKey)) return;
  await localReconstructionProvider.reconstruct({
    orientations: pose.orientations,
    sourceHash: pose.reconstruction?.sourceHash,
  }, signal);
}
