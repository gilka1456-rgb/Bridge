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
  /**
   * Optional base64 8-bit luminance field aligned pixel-for-pixel with mask.
   * It stores blurred lighting structure only, never the source photo color.
   */
  appearanceLuma?: string;
  appearanceWidth?: number;
  appearanceHeight?: number;
  /** 新扫描已对齐到统一人体坐标；缺失表示旧版整帧掩码。 */
  normalized?: boolean;
  /** v3 起为肩宽 / 骨盆到头顶锚高；旧数据仍可能是人体包围盒宽高比。 */
  personAspect?: number;
  /** v3 人体坐标锚点；存在时骨盆为雕刻世界坐标原点。 */
  anchor?: OrientationMaskAnchor;
  /** 八个关节角签名，供跨方位姿势一致性检查。 */
  jointSignature?: number[];
  /** 本方向参与融合的稳定帧数。 */
  frameCount?: number;
  /** 0-1 的方向质量分。 */
  quality?: number;
  /** 输入只可靠覆盖上半身；缺失区域不得参与雕刻，由标准模板补全。 */
  partial?: boolean;
}

export interface OrientationMaskAnchor {
  /** 归一化画布中的骨盆中点，单位为像素。 */
  pelvis: { x: number; y: number };
  /** 归一化画布中骨盆到头顶的像素高度。 */
  anchorHeight: number;
}

export type ReconstructionProviderId = "local-visual-hull" | "cloud";

export interface AvatarReconstruction {
  version: 2;
  provider: ReconstructionProviderId;
  status: "ready" | "failed";
  sourceHash: string;
  meshKey: string;
  quality: number;
  viewCount: number;
  algorithmVersion: string;
  failureReason?: string;
  /** 至少一个输入方向由半身照片补全。 */
  partial?: boolean;
}

export interface AvatarPose {
  id: string;
  label: string;
  style: GhostStyleId;
  /** 与风格家族解耦的用户自选灵体颜色，使用 #RRGGBB。 */
  spectralTint?: string;
  landmarks: Landmark[];
  views: PoseView[];
  /** 逐朝向全高分割 mask，供视觉外壳(visual hull)重建；可选，旧数据没有 */
  orientations?: OrientationMask[];
  /** 完整人体网格来源；缺失表示旧版头像。 */
  reconstruction?: AvatarReconstruction;
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
  /** 隐藏自己的虚像：隐藏后不在「看见」中出现 */
  hidden?: boolean;
}

export interface BridgeSnapshot {
  avatars: AvatarPose[];
  placements: Placement[];
}

export type ScanMode = "guided" | "assisted";

export type TabId = "discover" | "avatars" | "place" | "records" | "mine";

/** 好友（本机原型：本地存储，无后端） */
export interface Friend {
  id: string;
  /** 未来由 CloudKit 提供；本机原型使用 local:<uuid> */
  userId: string;
  name: string;
  note?: string;
  addedAt: string;
}

export type DiscoverFilter = "all" | "others" | "mine";

/** 在「看见」中用快门拍下、尚未必发布到论坛的照片 */
export interface CapturedPhoto {
  id: string;
  mediaKey: string;
  placementIds: string[];
  locationLabel: string;
  discoverFilter: DiscoverFilter;
  createdAt: string;
}

export interface SceneRecord {
  id: string;
  /** 新发布必须来自「看见」快门照片；旧记录可能没有该字段 */
  sourcePhotoId?: string;
  placementId?: string;
  avatarPoseId?: string;
  title: string;
  caption: string;
  locationLabel: string;
  /** 新记录图片存于 IndexedDB；旧数据仍可能内嵌 data URL */
  mediaKey?: string;
  imageDataUrl?: string;
  authorId: string;
  authorName: string;
  createdAt: string;
}

export interface SceneRecordComment {
  id: string;
  recordId: string;
  authorName: string;
  text: string;
  createdAt: string;
}

export interface Conversation {
  id: string;
  friendId: string;
  updatedAt: string;
  unreadCount: number;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  senderId: string;
  text: string;
  createdAt: string;
  read: boolean;
}

export type PermissionState = "unknown" | "granted" | "denied";

/**
 * 应用设置。driftMode（漂流模式）：只收赞、只能点赞，无评论、无社交界面。
 * 评论系统本身照常运行，未开漂流的人仍可评论你的虚像。
 */
export interface AppSettings {
  nickname: string;
  /** 头像二进制存于 IndexedDB，仅保存媒体键 */
  profileAvatarMediaKey?: string;
  driftMode: boolean;
  notifications: boolean;
  /** 「看见」中展示全部、只看别人或只看自己的虚像 */
  discoverFilter: DiscoverFilter;
}

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
  /** Optional deterministic appearance-only views; geometry still uses orientations. */
  spectralAppearanceViews?: OrientationMask[];
  avatarId?: string;
  reconstruction?: AvatarReconstruction;
  /** Spectral V3 连续人体实验路径；默认关闭，失败时回退旧模板。 */
  spectralBodyV3?: boolean;
  /** Spectral V3 共享透明渲染内核；独立开关，关闭时沿用旧 shader。 */
  spectralRenderV3?: boolean;
  /** V4 GPU 链式笼形蒙皮；设为 false 可回滚到 CPU 姿势烘焙。 */
  spectralRuntimeSkinning?: boolean;
  /** V4 回归/调试专用：强制 0、1 或 2 档 LOD。 */
  spectralForcedLod?: 0 | 1 | 2;
  /** V5 奇幻灵体风格钩子；颜色独立配置，复用 V4 人体、深度和 LOD。 */
  spectralFantasyV5?: boolean;
  /** V6 赛博人物投影风格钩子；复用 V4 人体、深度和 LOD。 */
  spectralCyberV6?: boolean;
  /** 透明相机合成时压低 additive 能量，1 表示普通不透明场景。 */
  spectralCompositeAttenuation?: number;
  /** 用户自选的灵体主色；渲染器会自动派生暗部、轮廓色和赛博辅色。 */
  spectralTintHex?: string;
  /** 视觉回归专用：保留标准 A-pose，不烘焙回扫描姿势。 */
  spectralStandardPose?: boolean;
  /** 单人物审查构图：一次性计算姿势后的边界，不修改 GPU 渲染网格。 */
  spectralComputePoseBounds?: boolean;
}
