/// <reference lib="webworker" />
import {
  buildAnatomicalGhostBody,
  type AnatomicalBodyBuildRequest,
} from "./anatomical-body";

interface WorkerRequest {
  id: string;
  request: AnatomicalBodyBuildRequest;
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { id, request } = event.data;
  try {
    const model = buildAnatomicalGhostBody(request);
    const buffers: ArrayBuffer[] = [
      model.rig.parentIndices.buffer as ArrayBuffer,
      model.rig.restTranslations.buffer as ArrayBuffer,
      model.rig.restRotations.buffer as ArrayBuffer,
      model.rig.inverseBindMatrices.buffer as ArrayBuffer,
      model.measurements.boneLengths.buffer as ArrayBuffer,
    ];
    model.lods.forEach((lod) => buffers.push(
      lod.positions.buffer as ArrayBuffer,
      lod.normals.buffer as ArrayBuffer,
      lod.indices.buffer as ArrayBuffer,
      lod.skinIndices.buffer as ArrayBuffer,
      lod.skinWeights.buffer as ArrayBuffer,
      lod.canonicalCoords.buffer as ArrayBuffer,
      lod.regionAndChain.buffer as ArrayBuffer,
    ));
    self.postMessage({ id, ok: true, model }, { transfer: buffers });
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

export {};
