/**
 * 「记录」照片论坛视图。
 *
 * 从 main.ts 抽出的页面模块：列表渲染、卡片、详情 sheet、点赞/评论/分享/删除。
 * 依赖宿主通过 RecordsContext 注入：store、跳转发布、局部重渲染，以及图片
 * 异步加载完成后的回调。媒体缓存（recordImageCache）由本模块持有并导出，
 * 供发布流程写入。
 */

import type { SceneRecord } from "../models/types";
import { createScenePlaceholder, shareSceneRecord } from "../features/records";
import { MESSAGE_MAX_LENGTH, validateMessage } from "../services/moderation";
import { recordMediaStore } from "../services/record-media";
import { LOCAL_OWNER_ID, type LocalStore } from "../services/store";
import { confirmDialog, escapeHtml, formatTime } from "../app/dom";

export interface RecordsContext {
  store: LocalStore;
  openRecordComposer: () => void;
  renderTab: () => void;
  /** 图片异步加载完成时调用，宿主决定是否对可见 tab 做局部重渲染。 */
  onRecordImagesChanged: () => void;
}

export const recordImageCache = new Map<string, string>();
const recordImageLoading = new Set<string>();

export function recordImage(record: SceneRecord): string {
  return (
    recordImageCache.get(record.id) ??
    record.imageDataUrl ??
    createScenePlaceholder(record.title, record.locationLabel)
  );
}

export async function resolveRecordImage(record: SceneRecord): Promise<string> {
  const existing = recordImageCache.get(record.id) ?? record.imageDataUrl;
  if (existing) {
    return existing;
  }
  if (record.mediaKey) {
    const loaded = await recordMediaStore.load(record.mediaKey);
    if (loaded) {
      recordImageCache.set(record.id, loaded);
      return loaded;
    }
  }
  return createScenePlaceholder(record.title, record.locationLabel);
}

export async function ensureRecordImages(records: SceneRecord[], ctx: RecordsContext): Promise<void> {
  let changed = false;
  await Promise.all(
    records.map(async (record) => {
      if (recordImageCache.has(record.id) || recordImageLoading.has(record.id)) {
        return;
      }
      recordImageLoading.add(record.id);
      try {
        if (record.mediaKey) {
          const independentKey = `post:${record.id}`;
          if (record.sourcePhotoId && record.mediaKey !== independentKey) {
            const copied = await recordMediaStore.copy(record.mediaKey, independentKey);
            if (copied) {
              recordImageCache.set(record.id, copied);
              ctx.store.setSceneRecordMediaKey(record.id, independentKey);
              changed = true;
              return;
            }
          }
          const loaded = await recordMediaStore.load(record.mediaKey);
          if (loaded) {
            recordImageCache.set(record.id, loaded);
            changed = true;
          }
          return;
        }
        if (record.imageDataUrl) {
          const migrated = await recordMediaStore.save(record.id, record.imageDataUrl);
          if (migrated) {
            const loaded = await recordMediaStore.load(record.id);
            if (loaded) {
              recordImageCache.set(record.id, loaded);
            }
            ctx.store.setSceneRecordMediaKey(record.id, record.id);
            changed = true;
          }
        }
      } finally {
        recordImageLoading.delete(record.id);
      }
    }),
  );
  if (changed) {
    ctx.onRecordImagesChanged();
  }
}

export function buildRecordsView(ctx: RecordsContext): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const records = ctx.store.getSceneRecords();
  void ensureRecordImages(records, ctx);
  const header = document.createElement("section");
  header.className = "records-heading";
  header.innerHTML = `
    <div>
      <span class="eyebrow">照片论坛</span>
      <h2>记录</h2>
      <p class="hint">发布在「看见」拍下的虚像照片，分享此刻的故事。</p>
    </div>
    <button class="primary" id="record-create" type="button">发布</button>
  `;
  fragment.append(header);

  const feed = document.createElement("section");
  feed.className = "record-feed";
  if (records.length === 0) {
    feed.innerHTML = `
      <div class="empty-state record-empty">
        <strong class="empty-state-title">论坛里还没有照片</strong>
        <span class="empty-state-copy">先去「看见」拍照，再从「我的照片」选择照片发布。</span>
      </div>
    `;
  } else {
    feed.innerHTML = records.map((record) => recordCardHtml(record, ctx)).join("");
  }
  fragment.append(feed);

  queueMicrotask(() => {
    document.querySelector("#record-create")?.addEventListener("click", () => {
      ctx.openRecordComposer();
    });
    document.querySelectorAll<HTMLElement>("[data-open-record]").forEach((card) => {
      card.addEventListener("click", (event) => {
        if ((event.target as HTMLElement).closest("button")) {
          return;
        }
        void openSceneRecordSheet(card.dataset.openRecord!, ctx);
      });
    });
    document.querySelectorAll<HTMLButtonElement>("[data-like-record]").forEach((button) => {
      button.addEventListener("click", () => {
        ctx.store.toggleSceneRecordLike(button.dataset.likeRecord!);
        ctx.renderTab();
      });
    });
  });
  return fragment;
}

function recordCardHtml(record: SceneRecord, ctx: RecordsContext): string {
  const liked = ctx.store.isSceneRecordLiked(record.id);
  const comments = ctx.store.getSceneRecordComments(record.id).length;
  return `
    <article class="record-card" data-open-record="${record.id}">
      <img src="${escapeHtml(recordImage(record))}" alt="${escapeHtml(record.title)}" loading="lazy" />
      <div class="record-card-body">
        <strong>${escapeHtml(record.title)}</strong>
        ${record.caption ? `<p>${escapeHtml(record.caption)}</p>` : ""}
        <div class="record-card-meta">
          <span>${escapeHtml(record.authorName)} · ${escapeHtml(record.locationLabel)}</span>
          <button class="record-like ${liked ? "liked" : ""}" data-like-record="${record.id}" type="button">
            ${liked ? "♥" : "♡"} ${ctx.store.getSceneRecordLikeCount(record.id)}
          </button>
          ${ctx.store.isDriftMode() ? "" : `<span>💬 ${comments}</span>`}
        </div>
      </div>
    </article>
  `;
}

export async function openSceneRecordSheet(recordId: string, ctx: RecordsContext): Promise<void> {
  const record = ctx.store.getSceneRecord(recordId);
  if (!record) {
    return;
  }
  const imageUrl = await resolveRecordImage(record);
  const drift = ctx.store.isDriftMode();
  const comments = ctx.store.getSceneRecordComments(record.id);
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet record-detail" role="dialog" aria-modal="true">
      <div class="sheet-handle"></div>
      <div class="sheet-header">
        <span class="sheet-title">${escapeHtml(record.title)}</span>
        <button class="sheet-close" data-close aria-label="关闭">✕</button>
      </div>
      <img class="record-detail-image" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(record.title)}" />
      <div class="record-detail-copy">
        <div class="hint">${escapeHtml(record.authorName)} · ${escapeHtml(record.locationLabel)} · ${formatTime(record.createdAt)}</div>
        ${record.caption ? `<p>${escapeHtml(record.caption)}</p>` : ""}
      </div>
      <div class="actions">
        <button class="like-btn ${ctx.store.isSceneRecordLiked(record.id) ? "liked" : ""}" data-detail-like type="button">
          ${ctx.store.isSceneRecordLiked(record.id) ? "♥ 已赞" : "♡ 点赞"} ${ctx.store.getSceneRecordLikeCount(record.id)}
        </button>
        <button class="secondary" data-share-record type="button">分享</button>
        ${record.authorId === LOCAL_OWNER_ID ? `<button class="secondary danger-text" data-delete-published type="button">删除发布</button>` : ""}
      </div>
      <p class="status" data-share-status></p>
      ${
        drift
          ? `<p class="hint">漂流模式下只点赞、不评论。</p>`
          : `
            <div class="record-comments">
              <h3>评论</h3>
              ${comments.length ? comments.map((comment) => `
                <div class="record-comment">
                  <strong>${escapeHtml(comment.authorName)}</strong>
                  <span>${escapeHtml(comment.text)}</span>
                </div>
              `).join("") : `<p class="hint">还没有评论。</p>`}
              <div class="comment-compose">
                <input class="comment-input" data-record-comment-input maxlength="${MESSAGE_MAX_LENGTH}" placeholder="写下你的感受…" />
                <button class="primary" data-send-record-comment type="button">发送</button>
              </div>
              <p class="status" data-record-comment-error></p>
            </div>
          `
      }
    </div>
  `;

  const cleanup = () => overlay.remove();
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      cleanup();
    }
  });
  overlay.querySelector("[data-close]")?.addEventListener("click", cleanup);
  overlay.querySelector("[data-detail-like]")?.addEventListener("click", () => {
    ctx.store.toggleSceneRecordLike(record.id);
    cleanup();
    void openSceneRecordSheet(record.id, ctx);
  });
  overlay.querySelector("[data-share-record]")?.addEventListener("click", async () => {
    const status = overlay.querySelector<HTMLElement>("[data-share-status]");
    try {
      const result = await shareSceneRecord(imageUrl, record.title, record.caption);
      if (status) {
        status.textContent = result === "shared" ? "已打开分享。" : "图片已下载，文字已复制。";
      }
    } catch (error) {
      if (status && !(error instanceof DOMException && error.name === "AbortError")) {
        status.textContent = "暂时无法分享，请稍后再试。";
      }
    }
  });
  overlay.querySelector("[data-delete-published]")?.addEventListener("click", async () => {
    const ok = await confirmDialog("删除发布", "只会从记录论坛移除，保留「我的照片」中的原照片。", {
      confirmLabel: "删除发布",
      danger: true,
    });
    if (!ok) {
      return;
    }
    const ownsMedia =
      record.mediaKey &&
      (!record.sourcePhotoId || record.mediaKey === `post:${record.id}`);
    ctx.store.deleteSceneRecord(record.id);
    if (ownsMedia && record.mediaKey) {
      await recordMediaStore.delete(record.mediaKey);
    }
    recordImageCache.delete(record.id);
    cleanup();
    ctx.renderTab();
  });
  overlay.querySelector("[data-send-record-comment]")?.addEventListener("click", () => {
    const input = overlay.querySelector<HTMLInputElement>("[data-record-comment-input]");
    const error = overlay.querySelector<HTMLElement>("[data-record-comment-error]");
    try {
      const text = validateMessage(input?.value ?? "");
      ctx.store.addSceneRecordComment(record.id, text);
      cleanup();
      void openSceneRecordSheet(record.id, ctx);
    } catch (cause) {
      if (error) {
        error.textContent = cause instanceof Error ? cause.message : "评论失败。";
      }
    }
  });
  document.body.append(overlay);
}
