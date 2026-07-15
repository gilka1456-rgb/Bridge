import type {
  AppSettings,
  AvatarPose,
  BridgeSnapshot,
  CapturedPhoto,
  Comment,
  CommentLike,
  CommentReaction,
  Conversation,
  ChatMessage,
  Friend,
  Placement,
  ReactionKind,
  SceneRecord,
  SceneRecordComment,
} from "../models/types";

const STORAGE_KEY = "bridge-core-snapshot-v1";
const REACTIONS_KEY = "bridge-core-reactions-v1";
const COMMENTS_KEY = "bridge-core-comments-v1";
const COMMENT_REACTIONS_KEY = "bridge-core-comment-reactions-v1";
const COMMENT_LIKES_KEY = "bridge-core-comment-likes-v1";
const AUTHOR_KEY = "bridge-core-author-v1";
const MIGRATED_KEY = "bridge-core-reactions-migrated-v1";
const SETTINGS_KEY = "bridge-core-settings-v1";
const FRIENDS_KEY = "bridge-core-friends-v1";
const PLACEMENT_LIKES_KEY = "bridge-core-placement-likes-v1";
const SCENE_RECORDS_KEY = "bridge-core-scene-records-v1";
const SCENE_RECORD_COMMENTS_KEY = "bridge-core-scene-record-comments-v1";
const SCENE_RECORD_LIKES_KEY = "bridge-core-scene-record-likes-v1";
const CONVERSATIONS_KEY = "bridge-core-conversations-v1";
const CHAT_MESSAGES_KEY = "bridge-core-chat-messages-v1";
const CAPTURED_PHOTOS_KEY = "bridge-core-captured-photos-v1";

export const LOCAL_OWNER_ID = "me";

const DEFAULT_SETTINGS: AppSettings = {
  nickname: "我",
  driftMode: false,
  notifications: false,
  discoverFilter: "all",
};

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
  private friends: Friend[] = [];
  private placementLikes: string[] = [];
  private capturedPhotos: CapturedPhoto[] = [];
  private sceneRecords: SceneRecord[] = [];
  private sceneRecordComments: SceneRecordComment[] = [];
  private sceneRecordLikes: string[] = [];
  private conversations: Conversation[] = [];
  private chatMessages: ChatMessage[] = [];
  private settings: AppSettings = { ...DEFAULT_SETTINGS };

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
    const removedIds = new Set(removedPlacements.map((placement) => placement.id));
    removedPlacements.forEach((placement) => this.purgePlacementEngagement(placement.id));
    this.placementLikes = this.placementLikes.filter((likeId) => !removedIds.has(likeId));
    localStorage.setItem(PLACEMENT_LIKES_KEY, JSON.stringify(this.placementLikes));
    this.save();
  }

  addPlacement(placement: Placement): void {
    this.placements.unshift({ ownerId: LOCAL_OWNER_ID, ...placement });
    this.save();
  }

  deletePlacement(id: string): void {
    this.placements = this.placements.filter((placement) => placement.id !== id);
    this.purgePlacementEngagement(id);
    this.placementLikes = this.placementLikes.filter((likeId) => likeId !== id);
    localStorage.setItem(PLACEMENT_LIKES_KEY, JSON.stringify(this.placementLikes));
    this.save();
  }

  /** 本机单用户：所有放置都视为"我的" */
  getMyPlacements(): Placement[] {
    return this.placements.filter(
      (placement) => (placement.ownerId ?? LOCAL_OWNER_ID) === LOCAL_OWNER_ID,
    );
  }

  // ---- 昵称 / 设置 ----
  getAuthorName(): string {
    return this.settings.nickname;
  }

  setAuthorName(name: string): void {
    this.updateSettings({ nickname: name.trim() || "我" });
  }

  getSettings(): AppSettings {
    return { ...this.settings };
  }

  updateSettings(patch: Partial<AppSettings>): void {
    this.settings = { ...this.settings, ...patch };
    if (!this.settings.nickname.trim()) {
      this.settings.nickname = "我";
    }
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
  }

  // ---- 「看见」快门照片 ----
  getCapturedPhotos(): CapturedPhoto[] {
    return [...this.capturedPhotos].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getCapturedPhoto(id: string): CapturedPhoto | undefined {
    return this.capturedPhotos.find((photo) => photo.id === id);
  }

  addCapturedPhoto(photo: CapturedPhoto): void {
    this.capturedPhotos.unshift(photo);
    localStorage.setItem(CAPTURED_PHOTOS_KEY, JSON.stringify(this.capturedPhotos));
  }

  deleteCapturedPhoto(id: string): void {
    this.capturedPhotos = this.capturedPhotos.filter((photo) => photo.id !== id);
    localStorage.setItem(CAPTURED_PHOTOS_KEY, JSON.stringify(this.capturedPhotos));
  }

  isDriftMode(): boolean {
    return this.settings.driftMode;
  }

  // ---- 好友 ----
  getFriends(): Friend[] {
    return [...this.friends];
  }

  addFriend(name: string, note?: string): Friend | null {
    const trimmed = name.trim();
    if (!trimmed) {
      return null;
    }
    const friend: Friend = {
      id: createId(),
      userId: `local:${createId()}`,
      name: trimmed,
      note: note?.trim() || undefined,
      addedAt: new Date().toISOString(),
    };
    this.friends.unshift(friend);
    localStorage.setItem(FRIENDS_KEY, JSON.stringify(this.friends));
    return friend;
  }

  removeFriend(id: string): void {
    this.friends = this.friends.filter((friend) => friend.id !== id);
    const conversationIds = new Set(
      this.conversations.filter((conversation) => conversation.friendId === id).map((conversation) => conversation.id),
    );
    this.conversations = this.conversations.filter((conversation) => conversation.friendId !== id);
    this.chatMessages = this.chatMessages.filter((message) => !conversationIds.has(message.conversationId));
    localStorage.setItem(FRIENDS_KEY, JSON.stringify(this.friends));
    this.persistChat();
  }

  // ---- 场景记录 ----
  getSceneRecords(): SceneRecord[] {
    return [...this.sceneRecords].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getMySceneRecords(): SceneRecord[] {
    return this.getSceneRecords().filter((record) => record.authorId === LOCAL_OWNER_ID);
  }

  getSceneRecord(id: string): SceneRecord | undefined {
    return this.sceneRecords.find((record) => record.id === id);
  }

  addSceneRecord(record: SceneRecord): void {
    this.sceneRecords.unshift(record);
    try {
      this.persistSceneRecords();
    } catch {
      this.sceneRecords = this.sceneRecords.filter((item) => item.id !== record.id);
      throw new Error("本机记录空间已满，请先删除一些旧记录。");
    }
  }

  setSceneRecordMediaKey(recordId: string, mediaKey: string): void {
    const record = this.sceneRecords.find((item) => item.id === recordId);
    if (!record) {
      return;
    }
    const legacyImage = record.imageDataUrl;
    record.mediaKey = mediaKey;
    delete record.imageDataUrl;
    try {
      this.persistSceneRecords();
    } catch {
      record.imageDataUrl = legacyImage;
      delete record.mediaKey;
    }
  }

  deleteSceneRecord(id: string): void {
    this.sceneRecords = this.sceneRecords.filter((record) => record.id !== id);
    this.sceneRecordComments = this.sceneRecordComments.filter((comment) => comment.recordId !== id);
    this.sceneRecordLikes = this.sceneRecordLikes.filter((recordId) => recordId !== id);
    this.persistSceneRecords();
  }

  toggleSceneRecordLike(recordId: string): void {
    this.sceneRecordLikes = this.sceneRecordLikes.includes(recordId)
      ? this.sceneRecordLikes.filter((id) => id !== recordId)
      : [...this.sceneRecordLikes, recordId];
    this.persistSceneRecords();
  }

  isSceneRecordLiked(recordId: string): boolean {
    return this.sceneRecordLikes.includes(recordId);
  }

  getSceneRecordLikeCount(recordId: string): number {
    return this.isSceneRecordLiked(recordId) ? 1 : 0;
  }

  getSceneRecordComments(recordId: string): SceneRecordComment[] {
    return this.sceneRecordComments
      .filter((comment) => comment.recordId === recordId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  addSceneRecordComment(recordId: string, text: string): SceneRecordComment {
    const comment: SceneRecordComment = {
      id: createId(),
      recordId,
      authorName: this.settings.nickname,
      text,
      createdAt: new Date().toISOString(),
    };
    this.sceneRecordComments.push(comment);
    this.persistSceneRecords();
    return comment;
  }

  // ---- 会话与聊天 ----
  getConversations(): Conversation[] {
    return [...this.conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  conversationForFriend(friendId: string): Conversation {
    const existing = this.conversations.find((conversation) => conversation.friendId === friendId);
    if (existing) {
      return existing;
    }
    const conversation: Conversation = {
      id: createId(),
      friendId,
      updatedAt: new Date().toISOString(),
      unreadCount: 0,
    };
    this.conversations.push(conversation);
    this.persistChat();
    return conversation;
  }

  getChatMessages(conversationId: string): ChatMessage[] {
    return this.chatMessages
      .filter((message) => message.conversationId === conversationId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  sendChatMessage(conversationId: string, text: string): ChatMessage {
    const message: ChatMessage = {
      id: createId(),
      conversationId,
      senderId: LOCAL_OWNER_ID,
      text,
      createdAt: new Date().toISOString(),
      read: true,
    };
    this.chatMessages.push(message);
    const conversation = this.conversations.find((item) => item.id === conversationId);
    if (conversation) {
      conversation.updatedAt = message.createdAt;
    }
    this.persistChat();
    return message;
  }

  markConversationRead(conversationId: string): void {
    const conversation = this.conversations.find((item) => item.id === conversationId);
    if (conversation) {
      conversation.unreadCount = 0;
    }
    this.chatMessages.forEach((message) => {
      if (message.conversationId === conversationId) {
        message.read = true;
      }
    });
    this.persistChat();
  }

  // ---- 放置点赞 ----
  togglePlacementLike(placementId: string): void {
    if (this.placementLikes.includes(placementId)) {
      this.placementLikes = this.placementLikes.filter((id) => id !== placementId);
    } else {
      this.placementLikes.push(placementId);
    }
    localStorage.setItem(PLACEMENT_LIKES_KEY, JSON.stringify(this.placementLikes));
  }

  isPlacementLiked(placementId: string): boolean {
    return this.placementLikes.includes(placementId);
  }

  getPlacementLikeCount(placementId: string): number {
    return this.placementLikes.includes(placementId) ? 1 : 0;
  }

  // ---- 隐藏自己的虚像 ----
  setPlacementHidden(placementId: string, hidden: boolean): void {
    const placement = this.placements.find((item) => item.id === placementId);
    if (placement) {
      placement.hidden = hidden;
      this.save();
    }
  }

  /** 「看见」中可见的放置：排除被隐藏的 */
  getVisiblePlacements(): Placement[] {
    return this.placements.filter((placement) => !placement.hidden);
  }

  /** 「看见」页实际渲染的放置：排除被隐藏项，并应用三档归属筛选。 */
  getDiscoverPlacements(): Placement[] {
    const filter = this.settings.discoverFilter;
    return this.placements.filter(
      (placement) => {
        if (placement.hidden) {
          return false;
        }
        const mine = (placement.ownerId ?? LOCAL_OWNER_ID) === LOCAL_OWNER_ID;
        return filter === "all" || (filter === "mine" ? mine : !mine);
      },
    );
  }

  // ---- 评论 ----
  addComment(placementId: string, text: string, parentId: string | null, replyToName?: string): Comment {
    const comment: Comment = {
      id: createId(),
      placementId,
      parentId,
      replyToName,
      authorName: this.settings.nickname,
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

  private persistSceneRecords(): void {
    localStorage.setItem(SCENE_RECORDS_KEY, JSON.stringify(this.sceneRecords));
    localStorage.setItem(SCENE_RECORD_COMMENTS_KEY, JSON.stringify(this.sceneRecordComments));
    localStorage.setItem(SCENE_RECORD_LIKES_KEY, JSON.stringify(this.sceneRecordLikes));
  }

  private persistChat(): void {
    localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(this.conversations));
    localStorage.setItem(CHAT_MESSAGES_KEY, JSON.stringify(this.chatMessages));
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
    this.friends = readJson<Array<Partial<Friend> & Pick<Friend, "id" | "name" | "addedAt">>>(FRIENDS_KEY, []).map(
      (friend) => ({
        ...friend,
        userId: friend.userId ?? `local:${friend.id}`,
      }),
    );
    this.placementLikes = readJson<string[]>(PLACEMENT_LIKES_KEY, []);
    this.capturedPhotos = readJson<CapturedPhoto[]>(CAPTURED_PHOTOS_KEY, []);
    this.sceneRecords = readJson<SceneRecord[]>(SCENE_RECORDS_KEY, []);
    this.sceneRecordComments = readJson<SceneRecordComment[]>(SCENE_RECORD_COMMENTS_KEY, []);
    this.sceneRecordLikes = readJson<string[]>(SCENE_RECORD_LIKES_KEY, []);
    this.conversations = readJson<Conversation[]>(CONVERSATIONS_KEY, []);
    this.chatMessages = readJson<ChatMessage[]>(CHAT_MESSAGES_KEY, []);

    const storedSettings = readJson<
      (Partial<AppSettings> & { hideOwnInDiscover?: boolean }) | null
    >(SETTINGS_KEY, null);
    const legacyNickname = localStorage.getItem(AUTHOR_KEY) || undefined;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(legacyNickname ? { nickname: legacyNickname } : {}),
      ...(storedSettings ?? {}),
      ...(storedSettings?.discoverFilter
        ? {}
        : { discoverFilter: storedSettings?.hideOwnInDiscover ? "others" : "all" }),
    };

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
