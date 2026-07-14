export type GhostStyleId = "wraith" | "phantom" | "cyber" | "quantum";

export interface GhostStyle {
  id: GhostStyleId;
  name: string;
  color: number;
  opacity: number;
  emissive: number;
  metalness: number;
  roughness: number;
  rimGlow: number;
  wireframe?: boolean;
  /** 是否使用全息扫描线 shader */
  holographic?: boolean;
}

export interface Landmark {
  x: number;
  y: number;
  z: number;
  visibility: number;
}

/** 分割轮廓点（归一化 0-1 图像坐标） */
export interface SilhouettePoint {
  x: number;
  y: number;
}

/** 按高度切片的人体宽度，用于轮廓塑形 */
export interface BodyProfileSlice {
  y: number;
  halfWidth: number;
}

export type SkeletonSchema = "mediapipe-33" | "arkit";

export type ScanViewAngle = "front" | "left" | "right" | "back" | "gesture";

export interface PoseView {
  angle: ScanViewAngle;
  landmarks: Landmark[];
  /** 摄像头人物分割外轮廓 */
  silhouetteContour?: SilhouettePoint[];
  /** 垂直切片宽度 profile */
  bodyProfile?: BodyProfileSlice[];
  capturedAt: string;
}

/**
 * 单个朝向的全高人体分割二值 mask（视觉外壳重建输入）。
 * mask 为 base64(RLE) 编码的逐像素 0/1 人体掩码。
 */
export interface OrientationMask {
  /** 方位角：正 0 / 右 90 / 背 180 / 左 270 */
  azimuth: number;
  width: number;
  height: number;
  mask: string;
}

export interface AvatarPose {
  id: string;
  label: string;
  style: GhostStyleId;
  landmarks: Landmark[];
  views: PoseView[];
  /** 逐朝向全高分割 mask，供视觉外壳(visual hull)重建；可选，旧数据没有 */
  orientations?: OrientationMask[];
  schema: SkeletonSchema;
  createdAt: string;
}

export interface Placement {
  id: string;
  avatarPoseId: string;
  message: string;
  locationLabel: string;
  rotationY: number;
  offsetX: number;
  offsetZ: number;
  createdAt: string;
  /** 放置者标识；本机单用户默认 "me"，为将来联网预留 */
  ownerId?: string;
}

export interface BridgeSnapshot {
  avatars: AvatarPose[];
  placements: Placement[];
}

export type ScanMode = "guided" | "assisted";

export type TabId = "discover" | "scan" | "place" | "mine" | "avatars";

export type ReactionKind = "useful" | "useless" | "joyful";

export interface ReactionRecord {
  placementId: string;
  kind: ReactionKind;
}

/**
 * 小黑盒式评论：一级评论 parentId=null，可被三态评价(useful/useless/joyful)+回复；
 * 二级回复挂在某条一级评论下(parentId=一级评论 id)，扁平结构，仅支持点赞+回复(@)。
 */
export interface Comment {
  id: string;
  placementId: string;
  parentId: string | null;
  replyToName?: string;
  authorName: string;
  text: string;
  createdAt: string;
}

/** 对一级评论的三态评价，每设备每条评论仅一条 */
export interface CommentReaction {
  commentId: string;
  kind: ReactionKind;
}

/** 对二级回复的点赞（布尔切换） */
export interface CommentLike {
  commentId: string;
}

export interface BodyBuildOptions {
  silhouetteContour?: SilhouettePoint[];
  bodyProfile?: BodyProfileSlice[];
  /** 视觉外壳重建输入；由 renderer 从 AvatarPose 注入 */
  orientations?: OrientationMask[];
  avatarId?: string;
}
