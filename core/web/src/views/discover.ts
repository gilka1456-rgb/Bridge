import type { DiscoverFilter } from "../models/types";
import type { LocalStore } from "../services/store";

export interface DiscoverViewContext {
  store: LocalStore;
  onFilterChange: (filter: DiscoverFilter) => void;
  onShutter: () => void;
  onCameraRetry: (video: HTMLVideoElement) => void;
}

export function buildDiscoverView(context: DiscoverViewContext): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const stage = document.createElement("div");
  stage.className = "discover-stage";
  const filter = context.store.getSettings().discoverFilter;
  const hasPlacements = context.store.getDiscoverPlacements().length > 0;
  const filterLabels = { all: "全部展示", others: "只看别人", mine: "只看自己" } as const;
  stage.innerHTML = `
    <video id="discover-video" autoplay playsinline muted></video>
    <canvas id="discover-canvas" class="three"></canvas>
    <div class="discover-filter" role="group" aria-label="虚像展示范围">
      ${(["all", "others", "mine"] as const).map((value) => `
        <button type="button" data-discover-filter="${value}" class="${filter === value ? "active" : ""}">
          ${filterLabels[value]}
        </button>
      `).join("")}
    </div>
    <p class="discover-camera-status" id="discover-camera-status">正在连接相机…</p>
    <button class="secondary discover-camera-retry" id="discover-camera-retry" type="button" hidden>重试相机</button>
    ${hasPlacements
      ? `<div class="discover-hint-float">点击虚像查看${context.store.isDriftMode() ? "并点赞" : "留言"}</div>`
      : `<div class="discover-empty-note">${filter === "others" ? "附近还没有别人的虚像" : filter === "mine" ? "你还没有在这里放置虚像" : "这里还没有可见虚像"}</div>`}
    <button class="camera-shutter" id="discover-shutter" type="button" aria-label="拍摄当前画面">
      <span></span>
    </button>
  `;

  stage.querySelectorAll<HTMLButtonElement>("[data-discover-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      const next = button.dataset.discoverFilter as DiscoverFilter;
      if (next !== context.store.getSettings().discoverFilter) {
        context.onFilterChange(next);
      }
    });
  });
  stage.querySelector("#discover-shutter")?.addEventListener("click", context.onShutter);
  stage.querySelector("#discover-camera-retry")?.addEventListener("click", () => {
    const video = stage.querySelector<HTMLVideoElement>("#discover-video");
    if (video) {
      context.onCameraRetry(video);
    }
  });
  fragment.append(stage);
  return fragment;
}
