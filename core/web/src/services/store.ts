import type {
  AvatarPose,
  BridgeSnapshot,
  Comment,
  CommentLike,
  CommentReaction,
  Placement,
  ReactionKind,
} from "../models/types";

const STORAGE_KEY = "bridge-core-snapshot-v1";
const REACTIONS_KEY = "bridge-core-reactions-v1";
const COMMENTS_KEY = "bridge-core-comments-v1";
const COMMENT_REACTIONS_KEY = "bridge-core-comment-reactions-v1";
const COMMENT_LIKES_KEY = "bridge-core-comment-likes-v1";
const AUTHOR_KEY = "bridge-core-author-v1";
const MIGRATED_KEY = "bridge-core-reactions-migrated-v1";

export const LOCAL_OWNER_ID = "me";

export interface CommentReactionCounts {
  useful: number;
  useless: number;
  joyful: number;
}

export interface PlacementEngagement {
  commentCount: number;
  reactionCounts: CommentReactionCounts;
}

export class LocalStore {
  private avatars: AvatarPose[] = [];
  private placements: Placement[] = [];
  private comments: Comment[] = [];
  private commentReactions: CommentReaction[] = [];
  private commentLikes: CommentLike[] = [];
  private authorName = "我";

  constructor() {
    this.load();
  }

  getAvatars(): AvatarPose[] {
    return [...this.avatars];
  }

  getPlacements(): Placement[] {
    return [...this.placements];
  }

  getAvatar(id: string): AvatarPose | undefined {
    return this.avatars.find((avatar) => avatar.id === id);
  }

  getPlacement(id: string): Placement | undefined {
    return this.placements.find((placement) => placement.id === id);
  }

  addAvatar(avatar: AvatarPose): void {
    this.avatars.unshift(avatar);
    this.save();
  }

  deleteAvatar(id: string): void {
    this.avatars = this.avatars.filter((avatar) => avatar.id !== id);
    const removedPlacements = this.placements.filter((placement) => placement.avatarPoseId === id);
    this.placements = this.placements.filter((placement) => placement.avatarPoseId !== id);
    removedPlacements.forEach((placement) => this.purgePlacementEngagement(placement.id));
    this.save();
  }

  addPlacement(placement: Placement): void {
    this.placements.unshift({ ownerId: LOCAL_OWNER_ID, ...placement });
    this.save();
  }

  deletePlacement(id: string): void {
    this.placements = this.placements.filter((placement) => placement.id !== id);
    this.purgePlacementEngagement(id);
    this.save();
  }

  /** 本机单用户：所有放置都视为"我的" */
  getMyPlacements(): Placement[] {
    return this.placements.filter(
      (placement) => (placement.ownerId ?? LOCAL_OWNER_ID) === LOCAL_OWNER_ID,
    );
  }

  // ---- 昵称 ----
  getAuthorName(): string {
    return this.authorName;
  }

  setAuthorName(name: string): void {
    const trimmed = name.trim();
    this.authorName = trimmed || "我";
    localStorage.setItem(AUTHOR_KEY, this.authorName);
  }

  // ---- 评论 ----
  addComment(placementId: string, text: string, parentId: string | null, replyToName?: string): Comment {
    const comment: Comment = {
      id: createId(),
      placementId,
      parentId,
      replyToName,
      authorName: this.authorName,
      text,
      createdAt: new Date().toISOString(),
    };
    this.comments.push(comment);
    this.persistComments();
    return comment;
  }

  getTopLevelComments(placementId: string): Comment[] {
    return this.comments
      .filter((comment) => comment.placementId === placementId && comment.parentId === null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getReplies(commentId: string): Comment[] {
    return this.comments
      .filter((comment) => comment.parentId === commentId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  deleteComment(id: string): void {
    // 删除评论及其所有回复。
    const toRemove = new Set<string>([id]);
    this.comments.forEach((comment) => {
      if (comment.parentId === id) {
        toRemove.add(comment.id);
      }
    });
    this.comments = this.comments.filter((comment) => !toRemove.has(comment.id));
    this.commentReactions = this.commentReactions.filter((item) => !toRemove.has(item.commentId));
    this.commentLikes = this.commentLikes.filter((item) => !toRemove.has(item.commentId));
    this.persistComments();
  }

  // ---- 一级评论三态评价 ----
  setCommentReaction(commentId: string, kind: ReactionKind): void {
    const existing = this.commentReactions.find((item) => item.commentId === commentId);
    if (existing && existing.kind === kind) {
      // 再次点击同一评价 → 取消。
      this.commentReactions = this.commentReactions.filter((item) => item.commentId !== commentId);
    } else {
      this.commentReactions = this.commentReactions.filter((item) => item.commentId !== commentId);
      this.commentReactions.push({ commentId, kind });
    }
    localStorage.setItem(COMMENT_REACTIONS_KEY, JSON.stringify(this.commentReactions));
  }

  getCommentReaction(commentId: string): ReactionKind | undefined {
    return this.commentReactions.find((item) => item.commentId === commentId)?.kind;
  }

  // ---- 二级回复点赞 ----
  toggleCommentLike(commentId: string): void {
    const liked = this.commentLikes.some((item) => item.commentId === commentId);
    if (liked) {
      this.commentLikes = this.commentLikes.filter((item) => item.commentId !== commentId);
    } else {
      this.commentLikes.push({ commentId });
    }
    localStorage.setItem(COMMENT_LIKES_KEY, JSON.stringify(this.commentLikes));
  }

  isCommentLiked(commentId: string): boolean {
    return this.commentLikes.some((item) => item.commentId === commentId);
  }

  /** 放置的互动汇总：评论总数（含回复）+ 一级评论三态评价合计 */
  getPlacementEngagement(placementId: string): PlacementEngagement {
    const placementComments = this.comments.filter((comment) => comment.placementId === placementId);
    const topLevelIds = new Set(
      placementComments.filter((comment) => comment.parentId === null).map((comment) => comment.id),
    );
    const reactionCounts: CommentReactionCounts = { useful: 0, useless: 0, joyful: 0 };
    this.commentReactions.forEach((reaction) => {
      if (topLevelIds.has(reaction.commentId)) {
        reactionCounts[reaction.kind] += 1;
      }
    });
    return { commentCount: placementComments.length, reactionCounts };
  }

  private purgePlacementEngagement(placementId: string): void {
    const removedIds = new Set(
      this.comments.filter((comment) => comment.placementId === placementId).map((comment) => comment.id),
    );
    this.comments = this.comments.filter((comment) => comment.placementId !== placementId);
    this.commentReactions = this.commentReactions.filter((item) => !removedIds.has(item.commentId));
    this.commentLikes = this.commentLikes.filter((item) => !removedIds.has(item.commentId));
    this.persistComments();
  }

  private persistComments(): void {
    localStorage.setItem(COMMENTS_KEY, JSON.stringify(this.comments));
    localStorage.setItem(COMMENT_REACTIONS_KEY, JSON.stringify(this.commentReactions));
    localStorage.setItem(COMMENT_LIKES_KEY, JSON.stringify(this.commentLikes));
  }

  private load(): void {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        const snapshot = JSON.parse(raw) as BridgeSnapshot;
        this.avatars = (snapshot.avatars ?? []).map((avatar) => {
          const views =
            avatar.views ??
            (avatar.landmarks?.length
              ? [{ angle: "front" as const, landmarks: avatar.landmarks, capturedAt: avatar.createdAt }]
              : []);
          return {
            ...avatar,
            schema: avatar.schema ?? "mediapipe-33",
            views,
            landmarks: avatar.landmarks?.length ? avatar.landmarks : views[0]?.landmarks ?? [],
          };
        });
        this.placements = (snapshot.placements ?? []).map((placement) => ({
          ownerId: LOCAL_OWNER_ID,
          ...placement,
        }));
      } catch {
        this.avatars = [];
        this.placements = [];
      }
    }

    this.comments = readJson<Comment[]>(COMMENTS_KEY, []);
    this.commentReactions = readJson<CommentReaction[]>(COMMENT_REACTIONS_KEY, []);
    this.commentLikes = readJson<CommentLike[]>(COMMENT_LIKES_KEY, []);
    this.authorName = localStorage.getItem(AUTHOR_KEY) || "我";

    this.migrateLegacyReactions();
  }

  /**
   * 旧版本把 有用/无用/欢乐 直接挂在放置上。新模型迁移为：为每个有旧评价的放置
   * 生成一条系统一级评论，并把旧评价转成对该评论的评价，从而并入评论体系。
   */
  private migrateLegacyReactions(): void {
    if (localStorage.getItem(MIGRATED_KEY) === "1") {
      return;
    }
    const legacyReactions = readJson<Array<{ placementId: string; kind: ReactionKind }>>(REACTIONS_KEY, []);
    if (legacyReactions.length > 0) {
      for (const record of legacyReactions) {
        if (!this.placements.some((placement) => placement.id === record.placementId)) {
          continue;
        }
        const seed: Comment = {
          id: createId(),
          placementId: record.placementId,
          parentId: null,
          authorName: "历史评价",
          text: "（迁移自旧版评价）",
          createdAt: new Date().toISOString(),
        };
        this.comments.push(seed);
        this.commentReactions.push({ commentId: seed.id, kind: record.kind });
      }
      this.persistComments();
    }
    localStorage.removeItem(REACTIONS_KEY);
    localStorage.setItem(MIGRATED_KEY, "1");
  }

  private save(): void {
    const snapshot: BridgeSnapshot = {
      avatars: this.avatars,
      placements: this.placements,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  }
}

function readJson<T>(key: string, fallback: T): T {
  const raw = localStorage.getItem(key);
  if (!raw) {
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function createId(): string {
  return crypto.randomUUID();
}
