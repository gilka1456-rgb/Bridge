import { FilesetResolver, ImageSegmenter, PoseLandmarker } from "@mediapipe/tasks-vision";
import type { Landmark } from "../models/types";
import { landmarksFromResult } from "./landmarks";
import {
  binarizePersonMask,
  extractSegmentationCapture,
  type SegmentationCapture,
} from "./segmentation";

export interface OrientationMaskCapture {
  mask: Uint8Array;
  width: number;
  height: number;
}

export class PoseCaptureService {
  private landmarker: PoseLandmarker | null = null;
  private segmenter: ImageSegmenter | null = null;
  private video: HTMLVideoElement | null = null;
  private stream: MediaStream | null = null;

  async init(): Promise<void> {
    if (this.landmarker && this.segmenter) {
      return;
    }

    const vision = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm",
    );

    if (!this.landmarker) {
      this.landmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
          delegate: "GPU",
        },
        runningMode: "VIDEO",
        numPoses: 1,
      });
    }

    if (!this.segmenter) {
      this.segmenter = await ImageSegmenter.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite",
          delegate: "GPU",
        },
        runningMode: "VIDEO",
        outputCategoryMask: true,
      });
    }
  }

  async startVideo(video: HTMLVideoElement): Promise<void> {
    this.video = video;
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = this.stream;
    await video.play();
  }

  detectForVideoFrame(timestampMs: number): Landmark[] | null {
    if (!this.landmarker || !this.video || this.video.readyState < 2) {
      return null;
    }

    const result = this.landmarker.detectForVideo(this.video, timestampMs);
    const landmarks = result.landmarks[0];
    if (!landmarks) {
      return null;
    }

    return landmarksFromResult(landmarks);
  }

  captureSegmentation(timestampMs: number): SegmentationCapture | null {
    if (!this.segmenter || !this.video || this.video.readyState < 2) {
      return null;
    }

    const result = this.segmenter.segmentForVideo(this.video, timestampMs);
    const mask = result.categoryMask;
    if (!mask) {
      return null;
    }

    return extractSegmentationCapture(mask.getAsUint8Array(), mask.width, mask.height);
  }

  /** 采集当前帧的全高人体二值 mask + 尺寸（视觉外壳重建输入） */
  captureOrientationMask(timestampMs: number): OrientationMaskCapture | null {
    if (!this.segmenter || !this.video || this.video.readyState < 2) {
      return null;
    }
    const result = this.segmenter.segmentForVideo(this.video, timestampMs);
    const categoryMask = result.categoryMask;
    if (!categoryMask) {
      return null;
    }
    return {
      mask: binarizePersonMask(categoryMask.getAsUint8Array()),
      width: categoryMask.width,
      height: categoryMask.height,
    };
  }

  get videoSize(): { width: number; height: number } {
    return {
      width: this.video?.videoWidth ?? 0,
      height: this.video?.videoHeight ?? 0,
    };
  }

  stop(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video = null;
  }

  dispose(): void {
    this.stop();
    this.landmarker?.close();
    this.landmarker = null;
    this.segmenter?.close();
    this.segmenter = null;
  }
}
