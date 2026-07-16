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
const SCHEMA_VERSION_KEY = "bridge-core-schema-version";
const CURRENT_SCHEMA_VERSION = 2;

export const LOCAL_OWNER_ID = "me";

export class StoragePersistenceError extends Error {
  constructor(message = "本机存储空间不足或不可用，请清理浏览器存储后重试。") {
    super(message);
    this.name = "StoragePersistenceError";
  }
}

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

interface MutableStoreState {
  avatars: AvatarPose[];
  placements: Placement[];
  comments: Comment[];
  commentReactions: CommentReaction[];
  commentLikes: CommentLike[];
  friends: Friend[];
  placementLikes: string[];
  capturedPhotos: CapturedPhoto[];
  sceneRecords: SceneRecord[];
  sceneRecordComments: SceneRecordComment[];
  sceneRecordLikes: string[];
  conversations: Conversation[];
  chatMessages: ChatMessage[];
  settings: AppSettings;
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
    try {
      this.save();
    } catch (error) {
      this.avatars = this.avatars.filter((item) => item.id !== avatar.id);
      throw asPersistenceError(error);
    }
  }

  deleteAvatar(id: string): void {
    const previous = this.captureMutableState();
    this.avatars = this.avatars.filter((avatar) => avatar.id !== id);
    const removedPlacements = this.placements.filter((placement) => placement.avatarPoseId === id);
    this.placements = this.placements.filter((placement) => placement.avatarPoseId !== id);
    const removedIds = new Set(removedPlacements.map((placement) => placement.id));
    removedPlacements.forEach((placement) => this.purgePlacementEngagement(placement.id, false));
    this.placementLikes = this.placementLikes.filter((likeId) => !removedIds.has(likeId));
    this.capturedPhotos = this.capturedPhotos.map((photo) => ({
      ...photo,
      placementIds: photo.placementIds.filter((placementId) => !removedIds.has(placementId)),
    }));
    this.sceneRecords = this.sceneRecords.map((record) => ({
      ...record,
      ...(record.avatarPoseId === id ? { avatarPoseId: undefined } : {}),
      ...(record.placementId && removedIds.has(record.placementId) ? { placementId: undefined } : {}),
    }));
    try {
      this.persistAll();
    } catch (error) {
      this.restoreMutableState(previous);
      throw asPersistenceError(error);
    }
  }

  addPlacement(placement: Placement): void {
    this.placements.unshift({ ownerId: LOCAL_OWNER_ID, ...placement });
    try {
      this.save();
    } catch (error) {
      this.placements = this.placements.filter((item) => item.id !== placement.id);
      throw asPersistenceError(error);
    }
  }

  deletePlacement(id: string): void {
    const previous = this.captureMutableState();
    this.placements = this.placements.filter((placement) => placement.id !== id);
    this.purgePlacementEngagement(id, false);
    this.placementLikes = this.placementLikes.filter((likeId) => likeId !== id);
    this.capturedPhotos = this.capturedPhotos.map((photo) => ({
      ...photo,
      placementIds: photo.placementIds.filter((placementId) => placementId !== id),
    }));
    this.sceneRecords = this.sceneRecords.map((record) => (
      record.placementId === id ? { ...record, placementId: undefined } : record
    ));
    try {
      this.persistAll();
    } catch (error) {
      this.restoreMutableState(previous);
      throw asPersistenceError(error);
    }
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

  getReferencedMediaKeys(): Set<string> {
    return new Set(
      [
        this.settings.profileAvatarMediaKey,
        ...this.capturedPhotos.map((photo) => photo.mediaKey),
        ...this.sceneRecords.map((record) => record.mediaKey),
      ].filter((key): key is string => Boolean(key)),
    );
  }

  updateSettings(patch: Partial<AppSettings>): void {
    const previous = this.settings;
    this.settings = { ...this.settings, ...patch };
    if (!this.settings.nickname.trim()) {
      this.settings.nickname = "我";
    }
    try {
      writeJsonEntries([[SETTINGS_KEY, this.settings]]);
    } catch (error) {
      this.settings = previous;
      throw asPersistenceError(error);
    }
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
    try {
      writeJsonEntries([[CAPTURED_PHOTOS_KEY, this.capturedPhotos]]);
    } catch (error) {
      this.capturedPhotos = this.capturedPhotos.filter((item) => item.id !== photo.id);
      throw asPersistenceError(error);
    }
  }

  deleteCapturedPhoto(id: string): void {
    const previous = this.capturedPhotos;
    this.capturedPhotos = this.capturedPhotos.filter((photo) => photo.id !== id);
    try {
      writeJsonEntries([[CAPTURED_PHOTOS_KEY, this.capturedPhotos]]);
    } catch (error) {
      this.capturedPhotos = previous;
      throw asPersistenceError(error);
    }
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
    try {
      writeJsonEntries([[FRIENDS_KEY, this.friends]]);
    } catch (error) {
      this.friends = this.friends.filter((item) => item.id !== friend.id);
      throw asPersistenceError(error);
    }
    return friend;
  }

  removeFriend(id: string): void {
    const previous = this.captureMutableState();
    this.friends = this.friends.filter((friend) => friend.id !== id);
    const conversationIds = new Set(
      this.conversations.filter((conversation) => conversation.friendId === id).map((conversation) => conversation.id),
    );
    this.conversations = this.conversations.filter((conversation) => conversation.friendId !== id);
    this.chatMessages = this.chatMessages.filter((message) => !conversationIds.has(message.conversationId));
    try {
      writeJsonEntries([
        [FRIENDS_KEY, this.friends],
        [CONVERSATIONS_KEY, this.conversations],
        [CHAT_MESSAGES_KEY, this.chatMessages],
      ]);
    } catch (error) {
      this.restoreMutableState(previous);
      throw asPersistenceError(error);
    }
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
    if (!record.sourcePhotoId || !this.capturedPhotos.some((photo) => photo.id === record.sourcePhotoId)) {
      throw new Error("发布记录必须来自「我的照片」。");
    }
    if (this.sceneRecords.some((item) => item.sourcePhotoId === record.sourcePhotoId)) {
      throw new Error("这张照片已经发布过。");
    }
    this.sceneRecords.unshift(record);
    try {
      this.persistSceneRecords();
    } catch (error) {
      this.sceneRecords = this.sceneRecords.filter((item) => item.id !== record.id);
      throw asPersistenceError(error, "本机记录空间已满，请先删除一些旧记录。");
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
    const previous = this.captureMutableState();
    this.sceneRecords = this.sceneRecords.filter((record) => record.id !== id);
    this.sceneRecordComments = this.sceneRecordComments.filter((comment) => comment.recordId !== id);
    this.sceneRecordLikes = this.sceneRecordLikes.filter((recordId) => recordId !== id);
    try {
      this.persistSceneRecords();
    } catch (error) {
      this.restoreMutableState(previous);
      throw asPersistenceError(error);
    }
  }

  toggleSceneRecordLike(recordId: string): void {
    const previous = this.sceneRecordLikes;
    this.sceneRecordLikes = this.sceneRecordLikes.includes(recordId)
      ? this.sceneRecordLikes.filter((id) => id !== recordId)
      : [...this.sceneRecordLikes, recordId];
    try {
      this.persistSceneRecords();
    } catch (error) {
      this.sceneRecordLikes = previous;
      throw asPersistenceError(error);
    }
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
    if (this.settings.driftMode) {
      throw new Error("漂流模式下不能发表评论。");
    }
    if (!this.sceneRecords.some((record) => record.id === recordId)) {
      throw new Error("记录不存在或已删除。");
    }
    const comment: SceneRecordComment = {
      id: createId(),
      recordId,
      authorName: this.settings.nickname,
      text,
      createdAt: new Date().toISOString(),
    };
    this.sceneRecordComments.push(comment);
    try {
      this.persistSceneRecords();
    } catch (error) {
      this.sceneRecordComments = this.sceneRecordComments.filter((item) => item.id !== comment.id);
      throw asPersistenceError(error);
    }
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
    try {
      this.persistChat();
    } catch (error) {
      this.conversations = this.conversations.filter((item) => item.id !== conversation.id);
      throw asPersistenceError(error);
    }
    return conversation;
  }

  getChatMessages(conversationId: string): ChatMessage[] {
    return this.chatMessages
      .filter((message) => message.conversationId === conversationId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  sendChatMessage(conversationId: string, text: string): ChatMessage {
    const previous = this.captureMutableState();
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
    try {
      this.persistChat();
    } catch (error) {
      this.restoreMutableState(previous);
      throw asPersistenceError(error);
    }
    return message;
  }

  markConversationRead(conversationId: string): void {
    const previous = this.captureMutableState();
    const conversation = this.conversations.find((item) => item.id === conversationId);
    if (conversation) {
      conversation.unreadCount = 0;
    }
    this.chatMessages.forEach((message) => {
      if (message.conversationId === conversationId) {
        message.read = true;
      }
    });
    try {
      this.persistChat();
    } catch (error) {
      this.restoreMutableState(previous);
      throw asPersistenceError(error);
    }
  }

  // ---- 放置点赞 ----
  togglePlacementLike(placementId: string): void {
    const previous = [...this.placementLikes];
    if (this.placementLikes.includes(placementId)) {
      this.placementLikes = this.placementLikes.filter((id) => id !== placementId);
    } else {
      this.placementLikes.push(placementId);
    }
    try {
      writeJsonEntries([[PLACEMENT_LIKES_KEY, this.placementLikes]]);
    } catch (error) {
      this.placementLikes = previous;
      throw asPersistenceError(error);
    }
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
      const previous = placement.hidden;
      placement.hidden = hidden;
      try {
        this.save();
      } catch (error) {
        placement.hidden = previous;
        throw asPersistenceError(error);
      }
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
    if (this.settings.driftMode) {
      throw new Error("漂流模式下不能发表评论。");
    }
    if (!this.placements.some((placement) => placement.id === placementId)) {
      throw new Error("虚像放置不存在或已删除。");
    }
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
    try {
      this.persistComments();
    } catch (error) {
      this.comments = this.comments.filter((item) => item.id !== comment.id);
      throw asPersistenceError(error);
    }
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
    const previous = this.captureMutableState();
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
    try {
      this.persistComments();
    } catch (error) {
      this.restoreMutableState(previous);
      throw asPersistenceError(error);
    }
  }

  // ---- 一级评论三态评价 ----
  setCommentReaction(commentId: string, kind: ReactionKind): void {
    const previous = this.commentReactions;
    const existing = this.commentReactions.find((item) => item.commentId === commentId);
    if (existing && existing.kind === kind) {
      // 再次点击同一评价 → 取消。
      this.commentReactions = this.commentReactions.filter((item) => item.commentId !== commentId);
    } else {
      this.commentReactions = this.commentReactions.filter((item) => item.commentId !== commentId);
      this.commentReactions.push({ commentId, kind });
    }
    try {
      writeJsonEntries([[COMMENT_REACTIONS_KEY, this.commentReactions]]);
    } catch (error) {
      this.commentReactions = previous;
      throw asPersistenceError(error);
    }
  }

  getCommentReaction(commentId: string): ReactionKind | undefined {
    return this.commentReactions.find((item) => item.commentId === commentId)?.kind;
  }

  // ---- 二级回复点赞 ----
  toggleCommentLike(commentId: string): void {
    const previous = [...this.commentLikes];
    const liked = this.commentLikes.some((item) => item.commentId === commentId);
    if (liked) {
      this.commentLikes = this.commentLikes.filter((item) => item.commentId !== commentId);
    } else {
      this.commentLikes.push({ commentId });
    }
    try {
      writeJsonEntries([[COMMENT_LIKES_KEY, this.commentLikes]]);
    } catch (error) {
      this.commentLikes = previous;
      throw asPersistenceError(error);
    }
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

  private purgePlacementEngagement(placementId: string, persist = true): void {
    const removedIds = new Set(
      this.comments.filter((comment) => comment.placementId === placementId).map((comment) => comment.id),
    );
    this.comments = this.comments.filter((comment) => comment.placementId !== placementId);
    this.commentReactions = this.commentReactions.filter((item) => !removedIds.has(item.commentId));
    this.commentLikes = this.commentLikes.filter((item) => !removedIds.has(item.commentId));
    if (persist) {
      this.persistComments();
    }
  }

  private persistComments(): void {
    writeJsonEntries([
      [COMMENTS_KEY, this.comments],
      [COMMENT_REACTIONS_KEY, this.commentReactions],
      [COMMENT_LIKES_KEY, this.commentLikes],
    ]);
  }

  private persistSceneRecords(): void {
    writeJsonEntries([
      [SCENE_RECORDS_KEY, this.sceneRecords],
      [SCENE_RECORD_COMMENTS_KEY, this.sceneRecordComments],
      [SCENE_RECORD_LIKES_KEY, this.sceneRecordLikes],
    ]);
  }

  private persistChat(): void {
    writeJsonEntries([
      [CONVERSATIONS_KEY, this.conversations],
      [CHAT_MESSAGES_KEY, this.chatMessages],
    ]);
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
    if (this.sanitizeReferences() || localStorage.getItem(SCHEMA_VERSION_KEY) !== String(CURRENT_SCHEMA_VERSION)) {
      try {
        this.persistAll();
      } catch {
        // Loading must remain possible even when storage is full or read-only.
      }
    }
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
    writeStorageEntries([
      [REACTIONS_KEY, null],
      [MIGRATED_KEY, "1"],
    ]);
  }

  private save(): void {
    const snapshot: BridgeSnapshot = {
      avatars: this.avatars,
      placements: this.placements,
    };
    writeJsonEntries([[STORAGE_KEY, snapshot]]);
  }

  private persistAll(): void {
    const snapshot: BridgeSnapshot = {
      avatars: this.avatars,
      placements: this.placements,
    };
    writeJsonEntries([
      [STORAGE_KEY, snapshot],
      [COMMENTS_KEY, this.comments],
      [COMMENT_REACTIONS_KEY, this.commentReactions],
      [COMMENT_LIKES_KEY, this.commentLikes],
      [SETTINGS_KEY, this.settings],
      [FRIENDS_KEY, this.friends],
      [PLACEMENT_LIKES_KEY, this.placementLikes],
      [CAPTURED_PHOTOS_KEY, this.capturedPhotos],
      [SCENE_RECORDS_KEY, this.sceneRecords],
      [SCENE_RECORD_COMMENTS_KEY, this.sceneRecordComments],
      [SCENE_RECORD_LIKES_KEY, this.sceneRecordLikes],
      [CONVERSATIONS_KEY, this.conversations],
      [CHAT_MESSAGES_KEY, this.chatMessages],
      [SCHEMA_VERSION_KEY, CURRENT_SCHEMA_VERSION],
    ]);
  }

  private captureMutableState(): MutableStoreState {
    return structuredClone({
      avatars: this.avatars,
      placements: this.placements,
      comments: this.comments,
      commentReactions: this.commentReactions,
      commentLikes: this.commentLikes,
      friends: this.friends,
      placementLikes: this.placementLikes,
      capturedPhotos: this.capturedPhotos,
      sceneRecords: this.sceneRecords,
      sceneRecordComments: this.sceneRecordComments,
      sceneRecordLikes: this.sceneRecordLikes,
      conversations: this.conversations,
      chatMessages: this.chatMessages,
      settings: this.settings,
    });
  }

  private restoreMutableState(state: MutableStoreState): void {
    this.avatars = state.avatars;
    this.placements = state.placements;
    this.comments = state.comments;
    this.commentReactions = state.commentReactions;
    this.commentLikes = state.commentLikes;
    this.friends = state.friends;
    this.placementLikes = state.placementLikes;
    this.capturedPhotos = state.capturedPhotos;
    this.sceneRecords = state.sceneRecords;
    this.sceneRecordComments = state.sceneRecordComments;
    this.sceneRecordLikes = state.sceneRecordLikes;
    this.conversations = state.conversations;
    this.chatMessages = state.chatMessages;
    this.settings = state.settings;
  }

  private sanitizeReferences(): boolean {
    let changed = false;
    const avatarIds = new Set(this.avatars.map((avatar) => avatar.id));
    const validPlacements = this.placements.filter((placement) => avatarIds.has(placement.avatarPoseId));
    if (validPlacements.length !== this.placements.length) {
      this.placements = validPlacements;
      changed = true;
    }
    const placementIds = new Set(this.placements.map((placement) => placement.id));
    const comments = this.comments.filter((comment) => placementIds.has(comment.placementId));
    if (comments.length !== this.comments.length) {
      this.comments = comments;
      changed = true;
    }
    const commentIds = new Set(this.comments.map((comment) => comment.id));
    const reactions = this.commentReactions.filter((reaction) => commentIds.has(reaction.commentId));
    const likes = this.commentLikes.filter((like) => commentIds.has(like.commentId));
    if (reactions.length !== this.commentReactions.length || likes.length !== this.commentLikes.length) {
      this.commentReactions = reactions;
      this.commentLikes = likes;
      changed = true;
    }
    const placementLikes = this.placementLikes.filter((id) => placementIds.has(id));
    if (placementLikes.length !== this.placementLikes.length) {
      this.placementLikes = placementLikes;
      changed = true;
    }
    this.capturedPhotos = this.capturedPhotos.map((photo) => {
      const validIds = photo.placementIds.filter((id) => placementIds.has(id));
      if (validIds.length === photo.placementIds.length) {
        return photo;
      }
      changed = true;
      return { ...photo, placementIds: validIds };
    });
    const photoIds = new Set(this.capturedPhotos.map((photo) => photo.id));
    this.sceneRecords = this.sceneRecords.map((record) => {
      const updates: Partial<SceneRecord> = {};
      if (record.placementId && !placementIds.has(record.placementId)) updates.placementId = undefined;
      if (record.avatarPoseId && !avatarIds.has(record.avatarPoseId)) updates.avatarPoseId = undefined;
      if (record.sourcePhotoId && !photoIds.has(record.sourcePhotoId)) updates.sourcePhotoId = undefined;
      if (Object.keys(updates).length === 0) return record;
      changed = true;
      return { ...record, ...updates };
    });
    const recordIds = new Set(this.sceneRecords.map((record) => record.id));
    const recordComments = this.sceneRecordComments.filter((comment) => recordIds.has(comment.recordId));
    const recordLikes = this.sceneRecordLikes.filter((id) => recordIds.has(id));
    if (recordComments.length !== this.sceneRecordComments.length || recordLikes.length !== this.sceneRecordLikes.length) {
      this.sceneRecordComments = recordComments;
      this.sceneRecordLikes = recordLikes;
      changed = true;
    }
    const friendIds = new Set(this.friends.map((friend) => friend.id));
    const conversations = this.conversations.filter((conversation) => friendIds.has(conversation.friendId));
    if (conversations.length !== this.conversations.length) {
      this.conversations = conversations;
      changed = true;
    }
    const conversationIds = new Set(this.conversations.map((conversation) => conversation.id));
    const messages = this.chatMessages.filter((message) => conversationIds.has(message.conversationId));
    if (messages.length !== this.chatMessages.length) {
      this.chatMessages = messages;
      changed = true;
    }
    return changed;
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

function writeJsonEntries(entries: Array<[string, unknown]>): void {
  writeStorageEntries(entries.map(([key, value]) => [key, JSON.stringify(value)]));
}

function writeStorageEntries(entries: Array<[string, string | null]>): void {
  const previous = new Map<string, string | null>();
  try {
    entries.forEach(([key, value]) => {
      previous.set(key, localStorage.getItem(key));
      if (value === null) {
        localStorage.removeItem(key);
      } else {
        localStorage.setItem(key, value);
      }
    });
  } catch (error) {
    previous.forEach((value, key) => {
      try {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      } catch {
        // Best effort: preserve the original error and in-memory rollback.
      }
    });
    throw error;
  }
}

function asPersistenceError(error: unknown, message?: string): StoragePersistenceError {
  if (error instanceof StoragePersistenceError) {
    return error;
  }
  return new StoragePersistenceError(message);
}
