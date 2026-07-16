import type { AvatarPose, Landmark, ScanViewAngle, SilhouettePoint } from "../models/types";

export const POSE_CONNECTIONS: Array<[number, number]> = [
  [11, 12],
  [11, 13],
  [13, 15],
  [12, 14],
  [14, 16],
  [11, 23],
  [12, 24],
  [23, 24],
  [23, 25],
  [25, 27],
  [27, 29],
  [27, 31],
  [29, 31],
  [24, 26],
  [26, 28],
  [28, 30],
  [28, 32],
  [30, 32],
  [0, 1],
  [1, 2],
  [2, 3],
  [0, 4],
  [4, 5],
  [5, 6],
  [3, 7],
  [6, 8],
];

const LIMB_CHAINS: Array<{ indices: [number, number, number]; width: number }> = [
  { indices: [11, 13, 15], width: 22 },
  { indices: [12, 14, 16], width: 22 },
  { indices: [23, 25, 27], width: 28 },
  { indices: [24, 26, 28], width: 28 },
];

export function landmarksFromResult(landmarks: Array<{ x: number; y: number; z: number; visibility?: number }>): Landmark[] {
  return landmarks.map((point) => ({
    x: point.x,
    y: point.y,
    z: point.z,
    visibility: point.visibility ?? 1,
  }));
}

export function normalizeLandmarks(landmarks: Landmark[]): Landmark[] {
  const visible = landmarks.filter((point) => point.visibility > 0.35);
  if (visible.length === 0) {
    return landmarks;
  }

  const xs = visible.map((point) => point.x);
  const ys = visible.map((point) => point.y);
  const zs = visible.map((point) => point.z);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const scale = Math.max(maxX - minX, maxY - minY, 0.25);

  return landmarks.map((point) => ({
    x: (point.x - centerX) / scale,
    y: (point.y - centerY) / scale,
    z: (point.z - centerZ) / scale,
    visibility: point.visibility,
  }));
}

function coverMapping(
  canvasWidth: number,
  canvasHeight: number,
  videoWidth: number,
  videoHeight: number,
): { toX: (nx: number) => number; toY: (ny: number) => number } {
  const safeVideoWidth = videoWidth || canvasWidth;
  const safeVideoHeight = videoHeight || canvasHeight;
  const scale = Math.max(canvasWidth / safeVideoWidth, canvasHeight / safeVideoHeight);
  const drawnWidth = safeVideoWidth * scale;
  const drawnHeight = safeVideoHeight * scale;
  const offsetX = (canvasWidth - drawnWidth) / 2;
  const offsetY = (canvasHeight - drawnHeight) / 2;
  return {
    toX: (nx: number) => offsetX + nx * drawnWidth,
    toY: (ny: number) => offsetY + ny * drawnHeight,
  };
}

function drawThickLimb(
  ctx: CanvasRenderingContext2D,
  landmarks: Landmark[],
  indices: [number, number, number],
  width: number,
  toX: (nx: number) => number,
  toY: (ny: number) => number,
): void {
  const points = indices
    .map((index) => landmarks[index])
    .filter((point) => point && point.visibility >= 0.35);
  if (points.length < 2) {
    return;
  }

  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(toX(points[0]!.x), toY(points[0]!.y));
  for (let index = 1; index < points.length; index += 1) {
    ctx.lineTo(toX(points[index]!.x), toY(points[index]!.y));
  }
  ctx.stroke();
}

function drawTorso(
  ctx: CanvasRenderingContext2D,
  landmarks: Landmark[],
  toX: (nx: number) => number,
  toY: (ny: number) => number,
  fill: string,
): void {
  const leftShoulder = landmarks[11];
  const rightShoulder = landmarks[12];
  const leftHip = landmarks[23];
  const rightHip = landmarks[24];
  if (
    !leftShoulder ||
    !rightShoulder ||
    !leftHip ||
    !rightHip ||
    [leftShoulder, rightShoulder, leftHip, rightHip].some((point) => point.visibility < 0.35)
  ) {
    return;
  }

  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.moveTo(toX(leftShoulder.x), toY(leftShoulder.y));
  ctx.lineTo(toX(rightShoulder.x), toY(rightShoulder.y));
  ctx.lineTo(toX(rightHip.x), toY(rightHip.y));
  ctx.lineTo(toX(leftHip.x), toY(leftHip.y));
  ctx.closePath();
  ctx.fill();
}

function drawHead(
  ctx: CanvasRenderingContext2D,
  landmarks: Landmark[],
  toX: (nx: number) => number,
  toY: (ny: number) => number,
  fill: string,
  scale: number,
): void {
  const nose = landmarks[0];
  const leftEar = landmarks[7];
  const rightEar = landmarks[8];
  let centerX = nose?.x;
  let centerY = nose?.y;
  let radius = 18;

  if (leftEar && rightEar && leftEar.visibility >= 0.35 && rightEar.visibility >= 0.35) {
    centerX = (leftEar.x + rightEar.x) / 2;
    centerY = (leftEar.y + rightEar.y) / 2;
    radius = Math.hypot(leftEar.x - rightEar.x, leftEar.y - rightEar.y) * 0.55;
  } else if (!nose || nose.visibility < 0.35) {
    return;
  }

  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(toX(centerX!), toY(centerY!), Math.max(radius * scale, 12), 0, Math.PI * 2);
  ctx.fill();
}

/** 扫描预览：人体外形轮廓叠加（非骨架线） */
export function drawSilhouetteOverlay(
  ctx: CanvasRenderingContext2D,
  landmarks: Landmark[],
  canvasWidth: number,
  canvasHeight: number,
  videoWidth: number,
  videoHeight: number,
  tint: string,
): void {
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);
  const { toX, toY } = coverMapping(canvasWidth, canvasHeight, videoWidth, videoHeight);
  const scale = Math.abs(toX(1) - toX(0)) || 1;

  ctx.strokeStyle = tint;
  ctx.fillStyle = tint;

  ctx.globalAlpha = 0.3;
  drawTorso(ctx, landmarks, toX, toY, tint);
  drawHead(ctx, landmarks, toX, toY, tint, scale);
  ctx.globalAlpha = 0.65;

  for (const chain of LIMB_CHAINS) {
    drawThickLimb(ctx, landmarks, chain.indices, chain.width, toX, toY);
  }

  ctx.globalAlpha = 1;
}

/** @deprecated 使用 drawSilhouetteOverlay */
export function drawPoseOverlay(
  ctx: CanvasRenderingContext2D,
  landmarks: Landmark[],
  canvasWidth: number,
  canvasHeight: number,
  videoWidth: number,
  videoHeight: number,
  tint: string,
): void {
  drawSilhouetteOverlay(ctx, landmarks, canvasWidth, canvasHeight, videoWidth, videoHeight, tint);
}

const VIS = 0.35;

export function validateFullBody(landmarks: Landmark[]): { ok: boolean; message: string } {
  const head = landmarks[0];
  const leftAnkle = landmarks[27];
  const rightAnkle = landmarks[28];
  const leftShoulder = landmarks[11];
  const rightShoulder = landmarks[12];

  const required = [head, leftAnkle, rightAnkle, leftShoulder, rightShoulder];
  if (required.some((point) => !point || point.visibility < 0.35)) {
    return { ok: false, message: "未检测到完整全身，请后退并保证头脚都在画面中。" };
  }

  const visibleCount = landmarks.filter((point) => point.visibility >= 0.35).length;
  if (visibleCount < 20) {
    return { ok: false, message: "可见关键点不足，请调整光线与站位。" };
  }

  return { ok: true, message: "全身轮廓检测良好。" };
}

export function pickPrimaryLandmarks(views: Array<{ angle: ScanViewAngle; landmarks: Landmark[] }>): Landmark[] {
  const gesture = views.find((view) => view.angle === "gesture");
  if (gesture) {
    return gesture.landmarks;
  }
  const front = views.find((view) => view.angle === "front");
  if (front) {
    return front.landmarks;
  }
  return views[0]?.landmarks ?? [];
}

export function getFrontViewData(avatar: AvatarPose): {
  landmarks: Landmark[];
  silhouetteContour?: SilhouettePoint[];
  bodyProfile?: AvatarPose["views"][number]["bodyProfile"];
} {
  const front = avatar.views?.find((view) => view.angle === "front");
  const fallback = avatar.views?.[0];
  const source = front ?? fallback;
  return {
    landmarks: source?.landmarks ?? avatar.landmarks,
    silhouetteContour: source?.silhouetteContour,
    bodyProfile: source?.bodyProfile,
  };
}

/** 根据旋转角度选取最接近的已录方位数据 */
export function getPreviewDataForRotation(avatar: AvatarPose, rotationY: number): {
  landmarks: Landmark[];
  silhouetteContour?: SilhouettePoint[];
  bodyProfile?: AvatarPose["views"][number]["bodyProfile"];
  angle: ScanViewAngle;
} {
  const normalized = ((rotationY % 360) + 360) % 360;
  let angle: ScanViewAngle = "front";
  if (normalized >= 45 && normalized < 135) {
    angle = "right";
  } else if (normalized >= 135 && normalized < 225) {
    angle = "back";
  } else if (normalized >= 225 && normalized < 315) {
    angle = "left";
  }

  const matched = avatar.views?.find((view) => view.angle === angle);
  const front = avatar.views?.find((view) => view.angle === "front");
  const source = matched ?? front ?? avatar.views?.[0];
  return {
    landmarks: source?.landmarks ?? avatar.landmarks,
    silhouetteContour: source?.silhouetteContour,
    bodyProfile: source?.bodyProfile,
    angle: source?.angle ?? "front",
  };
}

export function drawSegmentationContour(
  ctx: CanvasRenderingContext2D,
  contour: SilhouettePoint[],
  canvasWidth: number,
  canvasHeight: number,
  videoWidth: number,
  videoHeight: number,
  tint: string,
): void {
  if (contour.length < 3) {
    return;
  }
  const { toX, toY } = coverMapping(canvasWidth, canvasHeight, videoWidth, videoHeight);
  ctx.strokeStyle = tint;
  ctx.lineWidth = 2;
  ctx.globalAlpha = 0.85;
  ctx.beginPath();
  ctx.moveTo(toX(contour[0].x), toY(contour[0].y));
  for (let index = 1; index < contour.length; index += 1) {
    ctx.lineTo(toX(contour[index].x), toY(contour[index].y));
  }
  ctx.closePath();
  ctx.stroke();
  ctx.globalAlpha = 1;
}

export function getDisplayViewData(avatar: AvatarPose): {
  landmarks: Landmark[];
  silhouetteContour?: SilhouettePoint[];
  bodyProfile?: AvatarPose["views"][number]["bodyProfile"];
} {
  const gesture = avatar.views?.find((view) => view.angle === "gesture");
  const front = avatar.views?.find((view) => view.angle === "front");
  const source = gesture ?? front ?? avatar.views?.[0];
  return {
    landmarks: source?.landmarks ?? avatar.landmarks,
    silhouetteContour: source?.silhouetteContour,
    bodyProfile: source?.bodyProfile,
  };
}

export function scanViewLabel(angle: ScanViewAngle): string {
  switch (angle) {
    case "front":
      return "正面";
    case "left":
      return "左侧";
    case "right":
      return "右侧";
    case "back":
      return "背面";
    case "gesture":
      return "建言";
  }
}

export const SCAN_VIEW_ANGLES: ScanViewAngle[] = ["front", "left", "right", "back", "gesture"];
