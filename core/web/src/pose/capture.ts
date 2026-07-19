import { FilesetResolver, ImageSegmenter, PoseLandmarker } from "@mediapipe/tasks-vision";
import type { Landmark } from "../models/types";
import { landmarksFromResult } from "./landmarks";
import {
  binarizePersonMask,
} from "./segmentation";

export interface OrientationMaskCapture {
  mask: Uint8Array;
  width: number;
  height: number;
}

export interface ImagePoseCapture {
  landmarks: Landmark[] | null;
  segmentation: OrientationMaskCapture | null;
}

export class PoseCaptureService {
  private landmarker: PoseLandmarker | null = null;
  private segmenter: ImageSegmenter | null = null;
  private imageLandmarker: PoseLandmarker | null = null;
  private imageSegmenter: ImageSegmenter | null = null;
  private video: HTMLVideoElement | null = null;
  private stream: MediaStream | null = null;
  private activeDelegate: "GPU" | "CPU" | null = null;

  async init(): Promise<void> {
    if (this.landmarker && this.segmenter) {
      return;
    }

    const vision = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm",
    );

    let lastError: unknown;
    for (const delegate of ["GPU", "CPU"] as const) {
      let landmarker: PoseLandmarker | null = null;
      let segmenter: ImageSegmenter | null = null;
      try {
        landmarker = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath:
              "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
            delegate,
          },
          runningMode: "VIDEO",
          numPoses: 1,
        });
        segmenter = await ImageSegmenter.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath:
              "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite",
            delegate,
          },
          runningMode: "VIDEO",
          outputCategoryMask: true,
        });
        this.landmarker = landmarker;
        this.segmenter = segmenter;
        this.activeDelegate = delegate;
        return;
      } catch (error) {
        landmarker?.close();
        segmenter?.close();
        lastError = error;
      }
    }
    throw new Error(
      `识别模型加载失败，GPU 与 CPU 兼容模式均不可用。${lastError instanceof Error ? ` ${lastError.message}` : ""}`,
    );
  }

  async startVideo(video: HTMLVideoElement, signal?: AbortSignal): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    if (signal?.aborted) {
      stream.getTracks().forEach((track) => track.stop());
      throw new DOMException("扫描页面已关闭。", "AbortError");
    }
    this.stop();
    this.video = video;
    this.stream = stream;
    signal?.addEventListener("abort", () => {
      if (this.stream === stream) {
        this.stop();
      } else {
        stream.getTracks().forEach((track) => track.stop());
      }
    }, { once: true });
    video.srcObject = stream;
    await video.play();
  }

  async initImageMode(): Promise<void> {
    if (this.imageLandmarker && this.imageSegmenter) return;
    const vision = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm",
    );
    let lastError: unknown;
    for (const delegate of ["GPU", "CPU"] as const) {
      let landmarker: PoseLandmarker | null = null;
      let segmenter: ImageSegmenter | null = null;
      try {
        landmarker = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath:
              "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
            delegate,
          },
          runningMode: "IMAGE",
          numPoses: 1,
        });
        segmenter = await ImageSegmenter.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath:
              "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite",
            delegate,
          },
          runningMode: "IMAGE",
          outputCategoryMask: true,
        });
        this.imageLandmarker = landmarker;
        this.imageSegmenter = segmenter;
        this.activeDelegate = delegate;
        return;
      } catch (error) {
        landmarker?.close();
        segmenter?.close();
        lastError = error;
      }
    }
    throw new Error(
      `照片识别模型加载失败。${lastError instanceof Error ? ` ${lastError.message}` : ""}`,
    );
  }

  detectImage(image: HTMLImageElement): ImagePoseCapture {
    if (!this.imageLandmarker || !this.imageSegmenter) {
      throw new Error("照片识别模型尚未初始化。");
    }
    const poseResult = this.imageLandmarker.detect(image);
    const sourceLandmarks = poseResult.landmarks[0];
    const segmentationResult = this.imageSegmenter.segment(image);
    const categoryMask = segmentationResult.categoryMask;
    return {
      landmarks: sourceLandmarks ? landmarksFromResult(sourceLandmarks) : null,
      segmentation: categoryMask ? {
        mask: binarizePersonMask(categoryMask.getAsUint8Array()),
        width: categoryMask.width,
        height: categoryMask.height,
      } : null,
    };
  }

  get delegate(): "GPU" | "CPU" | null {
    return this.activeDelegate;
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
    this.imageLandmarker?.close();
    this.imageLandmarker = null;
    this.imageSegmenter?.close();
    this.imageSegmenter = null;
    this.activeDelegate = null;
  }
}
