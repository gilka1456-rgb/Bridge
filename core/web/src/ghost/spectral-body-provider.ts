import type { AvatarPose, Landmark, OrientationMask } from "../models/types";
import type { GhostBodyModel } from "./body-model";
import { GHOST_RIG_VERSION } from "./body-model";
import {
  buildAnatomicalGhostBody,
  SPECTRAL_BODY_ALGORITHM_VERSION,
  SPECTRAL_BODY_VOXEL_SIZE,
  type AnatomicalBodyBuildRequest,
} from "./anatomical-body";
import { hashOrientationSource } from "./reconstruction-provider";
import { estimateTemplateBodyParams, hashTemplateBodyParams } from "./template-body";

export interface SpectralBodyInput {
  landmarks: Landmark[];
  orientations?: OrientationMask[];
  reconstruction?: AvatarPose["reconstruction"];
  avatarId?: string;
}

const bodyCache = new Map<string, GhostBodyModel>();

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
  if (signal?.aborted) throw new DOMException("Spectral body reconstruction cancelled.", "AbortError");
  const model = await runWorker(requestForInput(input), signal);
  bodyCache.set(key, model);
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

export function clearSpectralBodyCache(): void {
  bodyCache.clear();
}
