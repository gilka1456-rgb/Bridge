/// <reference lib="webworker" />
import type { OrientationMask } from "../models/types";
import { buildVisualHullMeshData } from "./visual-hull";

interface WorkerRequest {
  id: string;
  orientations: OrientationMask[];
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { id, orientations } = event.data;
  const result = buildVisualHullMeshData(orientations);
  if (!result.ok) {
    self.postMessage({ id, result });
    return;
  }
  const { positions, normals, indices } = result.mesh;
  self.postMessage(
    { id, result },
    { transfer: [positions.buffer, normals.buffer, indices.buffer] },
  );
};

export {};
