import "./styles.css";
import type {
  AvatarPose,
  AvatarReconstruction,
  CapturedPhoto,
  Comment,
  Conversation,
  Friend,
  GhostStyleId,
  OrientationMask,
  Placement,
  PoseView,
  ReactionKind,
  SceneRecord,
  TabId,
} from "./models/types";
import { bottomNavHtml } from "./features/bottom-nav";
import { chatMessageHtml } from "./features/chat";
import { iconSvg } from "./features/icons";
import { loadImageFile, resizeImageFile } from "./features/image-file";
import { createScenePlaceholder, shareSceneRecord } from "./features/records";
import {
  buildRecordsView,
  recordImageCache,
  type RecordsContext,
} from "./views/records";
import { buildDiscoverView as buildDiscoverPageView } from "./views/discover";
import {
  anchorNormalizePersonMask,
  APPEARANCE_FIELD_HEIGHT,
  APPEARANCE_FIELD_WIDTH,
  compactAppearanceLuma,
  decodePersonMaskRLE,
  encodeAppearanceLuma,
  encodePersonMaskRLE,
  extractSegmentationCapture,
  fuseBinaryMasks,
  keepLargestComponent,
  normalizePersonMask,
  normalizeAppearanceLuma,
  rotateBinaryMask,
  rotateByteField,
  type NormalizedMask,
} from "./pose/segmentation";
import { GHOST_STYLE_LIST } from "./ghost/styles";
import type { GhostScene, GhostSceneOptions } from "./ghost/renderer";
import type { OrientationMaskCapture, PoseCaptureService } from "./pose/capture";
import {
  drawSegmentationContour,
  drawSilhouetteOverlay,
  getDisplayViewData,
  getPreviewDataForRotation,
  pickPrimaryLandmarks,
  scanViewLabel,
  normalizeLandmarks,
  validateFullBody,
} from "./pose/landmarks";
import type { AzimuthBucket } from "./pose/scan-session";
import {
  AZIMUTH_BUCKETS,
  azimuthToScanAngle,
  buildCoverageState,
  computeBodyTilt,
  computeJointSignature,
  computePhotoPoseSignature,
  computeUpperBodyJointSignature,
  countVisibleLandmarks,
  estimateBodyAzimuth,
  FRAMES_PER_ORIENTATION,
  hasOrthogonalFullBodyCoverage,
  MAX_JOINT_SIGNATURE_DEVIATION,
  MIN_MASK_QUALITY,
  POSE_MISMATCH_GUIDANCE,
  scoreBinaryMask,
  signatureDeviation,
  STABLE_CAPTURE_MS,
  rotateLandmarksInImage,
} from "./pose/scan-session";
import { validateMessage, MESSAGE_MAX_LENGTH } from "./services/moderation";
import { recordMediaStore } from "./services/record-media";
import { createId, LOCAL_OWNER_ID, LocalStore } from "./services/store";
import {
  bindDialogBehavior,
  confirmDialog,
  escapeHtml,
  formatTime,
  initialOf,
  panel,
  showToast,
} from "./app/dom";
import { defaultPublicLocation, validatePublicLocation } from "./app/privacy";
import { PageScope } from "./app/page-scope";

const store = new LocalStore();
let poseService: PoseCaptureService | null = null;
let poseServicePromise: Promise<PoseCaptureService> | null = null;

function loadPoseService(): Promise<PoseCaptureService> {
  poseServicePromise ??= import("./pose/capture").then(({ PoseCaptureService: Service }) => {
    poseService ??= new Service();
    return poseService;
  });
  return poseServicePromise;
}

async function createGhostScene(
  canvas: HTMLCanvasElement,
  transparentBackground = false,
  options: Omit<GhostSceneOptions, "transparentBackground"> = {},
): Promise<GhostScene> {
  const { GhostScene: Scene } = await import("./ghost/renderer");
  return new Scene(canvas, { transparentBackground, ...options });
}

type VoiceStyleId = "standard" | "gentle" | "deep" | "robot";

const VOICE_STYLES: Record<VoiceStyleId, { name: string; rate: number; pitch: number; sample: string }> = {
  standard: { name: "标准", rate: 0.95, pitch: 1, sample: "我是标准语音，请缓慢转身，让我看清你的轮廓。" },
  gentle: { name: "温柔", rate: 0.82, pitch: 1.25, sample: "我是温柔语音，请放松，慢慢转一圈就好。" },
  deep: { name: "低沉", rate: 0.9, pitch: 0.7, sample: "我是低沉语音，后退一步拍全全身，然后缓慢转身。" },
  robot: { name: "机械", rate: 1.12, pitch: 0.45, sample: "我是机械语音。保持全身在画面内，缓慢转身即可。" },
};

type ScanPhase = "idle" | "initializing" | "scanning" | "reconstructing" | "preview";

let activeTab: TabId = "discover";
let utilityPage: "friends" | "settings" | null = null;
let avatarScanOpen = false;
let activeConversationId: string | null = null;
let mineSection: "placements" | "records" = "placements";
let selectedStyle: GhostStyleId = "wraith";
let selectedSpectralTint = "#c9ddff";
let latestLandmarks: ReturnType<typeof normalizeLandmarks> | null = null;
let latestRawLandmarks: ReturnType<typeof normalizeLandmarks> | null = null;
let latestMaskCapture: OrientationMaskCapture | null = null;
let capturedViews: PoseView[] = [];
let capturedOrientations: OrientationMask[] = [];
let scanReconstruction: AvatarReconstruction | undefined;

let scanLoopId = 0;
let scanPhase: ScanPhase = "idle";
let voiceEnabled = true;
let voiceStyle: VoiceStyleId = "standard";

let bucketQualities = new Map<AzimuthBucket, number>();
interface BufferedScanFrame {
  normalized: NormalizedMask;
  appearanceLuma?: Uint8Array;
  quality: number;
  landmarks: AvatarPose["landmarks"];
  jointSignature: number[];
  capturedAt: string;
}
interface ImportedPhotoCapture {
  id: string;
  fileName: string;
  detectedAzimuth: AzimuthBucket;
  assignedAzimuth: AzimuthBucket;
  normalized: NormalizedMask;
  appearanceLuma?: Uint8Array;
  quality: number;
  landmarks: AvatarPose["landmarks"];
  jointSignature: number[];
  signatureDeviation: number;
  partial: boolean;
  capturedAt: string;
}
let bucketFrames = new Map<AzimuthBucket, BufferedScanFrame[]>();
let baselineJointSignature: number[] | null = null;
let scanReconstructionDebug: { failureCode?: string; elapsedMs?: number } = {};
let importedPhotoCaptures: ImportedPhotoCapture[] = [];
let photoImportErrors: string[] = [];
let photoImportBusy = false;
let photoImportProgress = "";
let stableCaptureSince = 0;
let lastMaskSampleAt = 0;
let lastSpokenGuidance = "";
let scanPreviewScene: GhostScene | null = null;

function captureAppearanceLuma(
  source: CanvasImageSource,
  width: number,
  height: number,
): Uint8Array | null {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(source, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    const luma = new Uint8Array(width * height);
    for (let index = 0; index < luma.length; index += 1) {
      const offset = index * 4;
      luma[index] = Math.round(
        pixels[offset] * 0.2126 + pixels[offset + 1] * 0.7152 + pixels[offset + 2] * 0.0722,
      );
    }
    return luma;
  } catch {
    return null;
  }
}

function fuseAppearanceFrames(
  frames: BufferedScanFrame[],
  mask: Uint8Array,
): Uint8Array | undefined {
  const available = frames.flatMap((frame) => frame.appearanceLuma ? [frame.appearanceLuma] : []);
  if (available.length === 0 || available.some((item) => item.length !== mask.length)) return undefined;
  const result = new Uint8Array(mask.length);
  for (let index = 0; index < result.length; index += 1) {
    if (!mask[index]) {
      result[index] = 128;
      continue;
    }
    let sum = 0;
    for (const item of available) sum += item[index];
    result[index] = Math.round(sum / available.length);
  }
  return result;
}

let selectedAvatarId: string | null = null;
let selectedPlaceAvatarId: string | null = null;
let placeStep: 1 | 2 | 3 = 1;
let placeRotationY = 0;
let placeDraft = { locationLabel: "", message: "" };
let previewRotationY = 0;

let scanVideo: HTMLVideoElement | null = null;
let scanOverlay: HTMLCanvasElement | null = null;
let ghostScene: GhostScene | null = null;
let discoverStream: MediaStream | null = null;
const capturedPhotoCache = new Map<string, string>();
const capturedPhotoLoading = new Set<string>();
const PROFILE_AVATAR_MEDIA_KEY = "profile-avatar";
let profileAvatarUrl: string | null = null;

void recordMediaStore.purgeOrphans(store.getReferencedMediaKeys());

function capturedPhotoImage(photo: CapturedPhoto): string {
  return capturedPhotoCache.get(photo.id) ?? createScenePlaceholder("看见照片", photo.locationLabel);
}

async function resolveCapturedPhotoImage(photo: CapturedPhoto): Promise<string | null> {
  const cached = capturedPhotoCache.get(photo.id);
  if (cached) {
    return cached;
  }
  const loaded = await recordMediaStore.load(photo.mediaKey);
  if (loaded) {
    capturedPhotoCache.set(photo.id, loaded);
  }
  return loaded;
}

async function ensureCapturedPhotoImages(photos: CapturedPhoto[]): Promise<void> {
  let changed = false;
  await Promise.all(
    photos.map(async (photo) => {
      if (capturedPhotoCache.has(photo.id) || capturedPhotoLoading.has(photo.id)) {
        return;
      }
      capturedPhotoLoading.add(photo.id);
      try {
        const loaded = await recordMediaStore.load(photo.mediaKey);
        if (loaded) {
          capturedPhotoCache.set(photo.id, loaded);
          changed = true;
        }
      } finally {
        capturedPhotoLoading.delete(photo.id);
      }
    }),
  );
  if (changed && utilityPage === null && (activeTab === "records" || activeTab === "mine")) {
    renderTab();
  }
}

function profileAvatarHtml(nickname: string): string {
  return profileAvatarUrl
    ? `<img class="profile-avatar-image" src="${escapeHtml(profileAvatarUrl)}" alt="" />`
    : escapeHtml(initialOf(nickname));
}

async function ensureProfileAvatar(): Promise<void> {
  const mediaKey = store.getSettings().profileAvatarMediaKey;
  if (!mediaKey || profileAvatarUrl) {
    return;
  }
  const loaded = await recordMediaStore.load(mediaKey);
  if (loaded) {
    profileAvatarUrl = loaded;
    if (activeTab === "mine" && utilityPage === null) {
      renderTab();
    }
  }
}

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("Missing #app root");
}

let mountedShellKey: string | null = null;
let mountedPageKey: string | null = null;
let activePageScope = new PageScope();
const phoneFpsTestMode = new URLSearchParams(window.location.search).has("fps-test");
const visualBaselineMode = new URLSearchParams(window.location.search).has("visual-baseline");
let phoneFpsScene: GhostScene | null = null;
let visualBaselineScene: GhostScene | null = null;

render();

function shellKey(): string {
  return `${activeTab}|${utilityPage ?? ""}|${store.isDriftMode() ? "d" : ""}`;
}

function pageKey(): string {
  if (utilityPage) return `util:${utilityPage}`;
  if (activeTab === "avatars" && avatarScanOpen) return "scan";
  return `tab:${activeTab}`;
}

function render(): void {
  if (visualBaselineMode) {
    renderVisualBaseline();
    return;
  }
  if (phoneFpsTestMode) {
    renderPhoneFpsTest();
    return;
  }
  const drift = store.isDriftMode();
  if (drift && utilityPage === "friends") {
    utilityPage = null;
  }

  if (shellKey() !== mountedShellKey) {
    app!.innerHTML = `
      <header>
        <div class="app-brand">
          <h1 class="brand-title">Bridge</h1>
        </div>
        <div class="header-actions">
          ${drift ? `<span class="drift-badge">漂流中</span>` : ""}
          ${drift ? "" : `<button class="icon-btn" id="header-friends" title="好友与消息" aria-label="好友与消息">${iconSvg("message")}</button>`}
          <button class="icon-btn" id="header-settings" title="设置" aria-label="设置">${iconSvg("settings")}</button>
        </div>
      </header>
      <main id="content"></main>
      <nav class="bottom-nav" aria-label="主要导航">
        ${bottomNavHtml(activeTab)}
      </nav>
    `;

    app!.querySelectorAll<HTMLButtonElement>(".bottom-nav [data-tab]").forEach((button) => {
      button.addEventListener("click", () => {
        const tab = button.getAttribute("data-tab") as TabId;
        void switchTab(tab);
      });
    });

    app!.querySelector("#header-settings")?.addEventListener("click", () => {
      void openUtilityPage("settings");
    });
    app!.querySelector("#header-friends")?.addEventListener("click", () => {
      void openUtilityPage("friends");
    });

    mountedShellKey = shellKey();
  }

  renderTab();
}

async function openUtilityPage(page: "friends" | "settings"): Promise<void> {
  if (avatarScanOpen && hasUnsavedScan()) {
    const proceed = await confirmDialog(
      "扫描尚未保存",
      "离开将丢失本次扫描数据。确定要离开吗？",
      { confirmLabel: "离开", danger: true },
    );
    if (!proceed) {
      return;
    }
  }
  avatarScanOpen = false;
  utilityPage = page;
  render();
}

async function switchTab(tab: TabId): Promise<void> {
  if (tab === activeTab && utilityPage === null) {
    return;
  }
  if (avatarScanOpen && hasUnsavedScan()) {
    const proceed = await confirmDialog(
      "扫描尚未保存",
      "离开将丢失本次扫描数据。确定要离开吗？",
      { confirmLabel: "离开", danger: true },
    );
    if (!proceed) {
      return;
    }
  }
  avatarScanOpen = false;
  utilityPage = null;
  activeTab = tab;
  render();
}

/**
 * Release resources owned by the page currently mounted in #content.
 * Called automatically by renderTab() whenever the page key changes, so
 * switchTab/openUtilityPage no longer need to remember to clean up —
 * forgetting a manual closeActiveScenes() call can no longer leak a camera
 * or a 3D scene.
 */
function disposeActivePage(): void {
  activePageScope.dispose();
  if (mountedPageKey === "tab:place") {
    resetPlaceFlow();
  }
  if (mountedPageKey === "tab:avatars") {
    selectedAvatarId = null;
  }
  stopScanLoop();
  window.speechSynthesis.cancel();
  scanPhase = "idle";
  poseService?.stop();
  scanPreviewScene?.dispose();
  scanPreviewScene = null;
  ghostScene?.dispose();
  ghostScene = null;
  phoneFpsScene?.dispose();
  phoneFpsScene = null;
  visualBaselineScene?.dispose();
  visualBaselineScene = null;
  delete document.body.dataset.visualBaselineReady;
  discoverStream?.getTracks().forEach((track) => track.stop());
  discoverStream = null;
  scanVideo = null;
  scanOverlay = null;
}

function resetPlaceFlow(): void {
  selectedPlaceAvatarId = null;
  placeStep = 1;
  placeRotationY = 0;
  placeDraft = { locationLabel: "", message: "" };
}

function hasUnsavedScan(): boolean {
  return scanPhase === "scanning" || scanPhase === "preview";
}

function renderTab(): void {
  const content = document.querySelector<HTMLDivElement>("#content");
  if (!content) {
    return;
  }

  const nextKey = pageKey();
  if (nextKey !== mountedPageKey) {
    disposeActivePage();
    activePageScope = new PageScope();
    mountedPageKey = nextKey;
  }
  const scope = activePageScope;

  if (utilityPage) {
    content.replaceChildren(buildUtilityView(utilityPage));
    return;
  }

  if (activeTab === "avatars" && avatarScanOpen) {
    content.replaceChildren(buildScanView());
    startScanView(scope);
    void loadPoseService()
      .then((service) => service.init())
      .catch((error) => {
        scope.runIfActive(() => {
          const status = document.querySelector<HTMLElement>("#scan-status");
          if (status) {
            status.textContent = error instanceof Error ? error.message : "识别模型加载失败。";
          }
        });
      });
    return;
  }

  if (activeTab === "place") {
    content.replaceChildren(buildPlaceView());
    void initPlaceScene(scope);
    return;
  }

  if (activeTab === "discover") {
    content.replaceChildren(buildDiscoverPageView({
      store,
      onFilterChange: (filter) => {
        store.updateSettings({ discoverFilter: filter });
        mountedPageKey = null;
        renderTab();
      },
      onShutter: () => void captureDiscoverPhoto(),
      onCameraRetry: (video) => void startDiscoverCamera(video, activePageScope),
    }));
    void initDiscoverScene(scope);
    return;
  }

  if (activeTab === "mine") {
    content.replaceChildren(buildMineView());
    return;
  }

  if (activeTab === "records") {
    content.replaceChildren(buildRecordsView(recordsContext));
    return;
  }

  if (activeTab === "avatars") {
    content.replaceChildren(buildAvatarsView());
    return;
  }
}

function buildUtilityView(page: "friends" | "settings"): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const bar = document.createElement("div");
  bar.className = "utility-bar";
  bar.innerHTML = `<button class="secondary" id="utility-close" type="button">← 返回</button>`;
  const view = page === "friends" ? buildSocialView() : buildSettingsView();
  view.querySelector(".panel")?.classList.add("utility-content");
  fragment.append(bar, view);
  queueMicrotask(() => {
    document.querySelector("#utility-close")?.addEventListener("click", () => {
      utilityPage = null;
      activeConversationId = null;
      render();
    });
  });
  return fragment;
}

function buildScanView(): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const wrapper = document.createElement("div");
  wrapper.className = "scan-page";

  const stage = document.createElement("div");
  stage.className = "stage scan-stage";
  stage.innerHTML = `
    <video id="scan-video" autoplay playsinline muted></video>
    <canvas id="scan-overlay" class="overlay"></canvas>
    <div class="coverage-overlay" id="scan-coverage"></div>
  `;
  wrapper.append(stage);

  const coverage = buildCoverageState(bucketQualities);
  const showPreview = scanPhase === "preview";
  wrapper.classList.toggle("scan-preview-mode", showPreview);

  wrapper.append(
    panel(
      "扫描虚像",
      `
      <button class="secondary scan-back" id="scan-back-to-avatars" type="button">← 返回虚像</button>
      <div id="scan-active" class="${showPreview ? "hidden" : ""}">
        <div class="scan-options">
          <span class="hint">完整人体模式：请确保头顶到双脚始终在画面内</span>
          <label class="inline-toggle">
            <input type="checkbox" id="scan-voice-enabled" ${voiceEnabled ? "checked" : ""} />
            语音提示
          </label>
          <div class="voice-picker">
            <select id="scan-voice-style">
              ${Object.entries(VOICE_STYLES)
                .map(
                  ([id, style]) =>
                    `<option value="${id}" ${voiceStyle === id ? "selected" : ""}>${style.name}</option>`,
                )
                .join("")}
            </select>
            <button type="button" class="secondary" id="scan-voice-preview">试听</button>
          </div>
        </div>
        <div class="coverage-bar" aria-hidden="true">
          <div class="coverage-fill" id="scan-coverage-fill" style="width:${coverage.overallPercent}%"></div>
        </div>
        <div class="coverage-chips" id="scan-coverage-chips">
          ${coverage.slots
            .map(
              (slot) =>
                `<span class="coverage-chip ${slot.captured ? "done" : ""}">${slot.label}${slot.captured ? " ✓" : ""}</span>`,
            )
            .join("")}
        </div>
        <p class="status scan-instruction" id="scan-instruction">${escapeHtml(coverage.guidance)}</p>
        <p class="status" id="scan-status">${scanPhase === "initializing" ? "正在加载识别模型…" : "准备好后点击「扫描」。"}</p>
        <button class="primary scan-action" id="scan-action" type="button" ${scanPhase === "scanning" || scanPhase === "initializing" ? "disabled" : ""}>
          ${scanPhase === "initializing" ? "加载中…" : scanPhase === "scanning" ? "扫描中…" : "扫描"}
        </button>
        <section class="photo-import">
          <div class="photo-import-divider"><span>或</span></div>
          <label class="secondary photo-import-picker" for="scan-photo-files">从照片创建</label>
          <input class="visually-hidden" id="scan-photo-files" type="file" accept="image/*" multiple />
          <p class="hint" id="photo-import-status">选择 2–4 张全身照片；原图只在内存中识别，不会保存。</p>
          <div id="photo-import-board"></div>
          <button class="primary hidden" id="photo-import-build" type="button">使用照片生成虚像</button>
        </section>
      </div>
      <div id="scan-preview" class="scan-preview ${showPreview ? "" : "hidden"}">
        <p class="hint" id="scan-preview-status">${scanReconstruction?.status === "ready"
          ? `完整人体外壳已生成 · 本地质量 ${Math.round(scanReconstruction.quality * 100)}%${scanReconstruction.partial ? " · partial：标准下肢已补全" : ""}`
          : "完成四方向扫描，或导入 2–4 张照片后，系统将在本机生成完整人体。"}</p>
        <div class="stage scan-preview-stage">
          <canvas id="scan-preview-canvas" class="three rotatable"></canvas>
        </div>
        <div class="field">
          <label>姿势名称</label>
          <input id="pose-label" value="站立" />
        </div>
        <div class="field">
          <label>风格</label>
          <select id="pose-style">
            ${GHOST_STYLE_LIST.filter((style) => style.id === "wraith" || style.id === "cyber")
              .map((style) => `<option value="${style.id}" ${selectedStyle === style.id ? "selected" : ""}>${style.name}</option>`)
              .join("")}
          </select>
        </div>
        <div class="field">
          <label for="pose-tint">灵体颜色</label>
          <input id="pose-tint" type="color" value="${selectedSpectralTint}" />
        </div>
        <button class="primary" id="scan-save" type="button">保存虚像</button>
        <p class="status" id="scan-save-status"></p>
      </div>
      <details class="scan-debug" id="scan-debug">
        <summary>调试</summary>
        <div id="scan-debug-content"></div>
      </details>
    `,
    ),
  );

  fragment.append(wrapper);
  return fragment;
}

function startScanView(scope: PageScope): void {
  scanVideo = document.querySelector<HTMLVideoElement>("#scan-video");
  scanOverlay = document.querySelector<HTMLCanvasElement>("#scan-overlay");
  updateScanDebugUi();
  updatePhotoImportUi();

  document.querySelector<HTMLInputElement>("#scan-voice-enabled")?.addEventListener("change", (event) => {
    voiceEnabled = (event.target as HTMLInputElement).checked;
    if (!voiceEnabled) {
      window.speechSynthesis.cancel();
    }
  });

  document.querySelector<HTMLSelectElement>("#scan-voice-style")?.addEventListener("change", (event) => {
    voiceStyle = (event.target as HTMLSelectElement).value as VoiceStyleId;
  });

  document.querySelector("#scan-voice-preview")?.addEventListener("click", () => {
    speakVoiceSample(voiceStyle);
  });

  document.querySelector("#scan-action")?.addEventListener("click", () => {
    void beginScanSession(scope);
  });

  document.querySelector<HTMLInputElement>("#scan-photo-files")?.addEventListener("change", (event) => {
    const input = event.target as HTMLInputElement;
    void importPhotoFiles(Array.from(input.files ?? []), scope);
    input.value = "";
  });

  document.querySelector("#photo-import-build")?.addEventListener("click", () => {
    void reconstructImportedPhotos();
  });

  document.querySelector("#scan-back-to-avatars")?.addEventListener("click", () => {
    void closeAvatarScan();
  });

  document.querySelector("#scan-save")?.addEventListener("click", () => {
    saveAvatarFromPreview();
  });

  document.querySelector<HTMLSelectElement>("#pose-style")?.addEventListener("change", (event) => {
    selectedStyle = (event.target as HTMLSelectElement).value as GhostStyleId;
    updateScanPreviewScene();
  });

  document.querySelector<HTMLInputElement>("#pose-tint")?.addEventListener("input", (event) => {
    selectedSpectralTint = (event.target as HTMLInputElement).value;
    updateScanPreviewScene();
  });

  if (scanPhase === "scanning") {
    startScanLoop();
  }
  if (scanPhase === "preview") {
    void initScanPreviewScene(scope);
  }
}

function resetScanCaptureState(): void {
  bucketQualities = new Map();
  bucketFrames = new Map();
  baselineJointSignature = null;
  stableCaptureSince = 0;
  lastMaskSampleAt = 0;
  lastSpokenGuidance = "";
  latestRawLandmarks = null;
  latestMaskCapture = null;
  capturedViews = [];
  capturedOrientations = [];
  scanReconstruction = undefined;
  scanReconstructionDebug = {};
  importedPhotoCaptures = [];
  photoImportErrors = [];
  photoImportBusy = false;
  photoImportProgress = "";
}

function renderPhoneFpsTest(): void {
  disposeActivePage();
  activePageScope = new PageScope();
  mountedPageKey = "phone-fps-test";
  mountedShellKey = "phone-fps-test";
  app!.innerHTML = `
    <header>
      <div class="app-brand"><h1 class="brand-title">Bridge</h1></div>
      <span class="drift-badge">手机性能验收</span>
    </header>
    <main class="phone-fps-page">
      <section class="panel phone-fps-panel">
        <h2>灵体 30 FPS 真机测试</h2>
        <p class="hint">保持此页面在前台，系统会用正式灵体渲染器和最重的赛博材质测量 5 秒。建议关闭低电量模式后重测一次。</p>
        <div class="stage phone-fps-stage"><canvas id="phone-fps-canvas" class="three"></canvas></div>
        <div class="phone-fps-meter" aria-live="polite">
          <strong id="phone-fps-score">准备中…</strong>
          <span id="phone-fps-detail">正在加载同一套模板、赛博材质与洋葱壳。</span>
          <div class="coverage-bar"><div class="coverage-fill" id="phone-fps-progress" style="width:0%"></div></div>
        </div>
        <button class="primary" id="phone-fps-retry" type="button">重新测 5 秒</button>
        <p class="hint">通过标准：平均帧率 ≥ 30 FPS。请把结果数字或截图发给我完成最终验收。</p>
      </section>
    </main>
  `;
  document.querySelector("#phone-fps-retry")?.addEventListener("click", () => {
    void startPhoneFpsTest(activePageScope);
  });
  void startPhoneFpsTest(activePageScope);
}

function renderVisualBaseline(): void {
  if (mountedPageKey === "visual-baseline") return;
  disposeActivePage();
  activePageScope = new PageScope();
  mountedPageKey = "visual-baseline";
  mountedShellKey = "visual-baseline";
  void import("./ghost/visual-baseline")
    .then(({ mountVisualBaseline }) => mountVisualBaseline(app!, window.location.search))
    .then((scene) => {
      if (mountedPageKey !== "visual-baseline") {
        scene.dispose();
        return;
      }
      visualBaselineScene = scene;
    })
    .catch((error) => {
      app!.innerHTML = `<main class="visual-baseline-error"><h1>视觉基线加载失败</h1><pre></pre></main>`;
      const output = app!.querySelector("pre");
      if (output) output.textContent = error instanceof Error ? error.message : String(error);
    });
}

async function startPhoneFpsTest(scope: PageScope): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>("#phone-fps-canvas");
  const score = document.querySelector<HTMLElement>("#phone-fps-score");
  const detail = document.querySelector<HTMLElement>("#phone-fps-detail");
  const progress = document.querySelector<HTMLElement>("#phone-fps-progress");
  const retry = document.querySelector<HTMLButtonElement>("#phone-fps-retry");
  if (!canvas || !score || !detail || !progress || !retry) return;
  retry.disabled = true;
  score.className = "";
  score.textContent = "准备中…";
  detail.textContent = "正在加载同一套模板、赛博材质与洋葱壳。";
  progress.style.width = "0%";
  try {
    const { createPerformancePose, measureAnimationFrameRate, PHONE_FPS_SAMPLE_MS } = await import("./ghost/performance-probe");
    const stressStyle = new URLSearchParams(window.location.search).get("fps-style");
    const fantasyStress = stressStyle === "fantasy";
    const cyberV6Stress = stressStyle === "cyber-v6";
    if (!phoneFpsScene) {
      phoneFpsScene = await createGhostScene(canvas);
      if (!scope.active || !canvas.isConnected) {
        phoneFpsScene.dispose();
        phoneFpsScene = null;
        return;
      }
      await phoneFpsScene.setPoses([{
        pose: createPerformancePose(fantasyStress ? "wraith" : "cyber"),
        bodyOptions: {
          spectralBodyV3: true,
          spectralRenderV3: true,
          spectralRuntimeSkinning: true,
          spectralFantasyV5: fantasyStress,
          spectralCyberV6: cyberV6Stress,
        },
      }]);
      phoneFpsScene.resize();
    }
    detail.textContent = "正在预热渲染器…";
    await new Promise((resolve) => setTimeout(resolve, 750));
    if (!scope.active) return;
    score.textContent = "测量中…";
    detail.textContent = "请保持页面在前台，不要切换 App。";
    const result = await measureAnimationFrameRate(
      PHONE_FPS_SAMPLE_MS,
      scope.signal,
      (value) => {
        progress.style.width = `${Math.round(value * 100)}%`;
      },
      () => phoneFpsScene!.getPerformanceSnapshot(),
    );
    score.textContent = `${result.fps.toFixed(1)} FPS · ${result.passed ? "通过" : "未通过"}`;
    score.className = result.passed ? "passed" : "failed";
    const render = result.renderStats;
    detail.textContent = `${(result.durationMs / 1_000).toFixed(1)} 秒 / ${result.frameCount} 帧 / P95 ${result.p95FrameMs.toFixed(1)}ms / 慢帧 ${result.slowFramePercent.toFixed(1)}%${render ? ` / ${render.qualityTier}→${render.recommendedTier} / LOD${render.lodIndex} / ${render.drawCalls} draw / ${render.triangles} tri` : ""}`;
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError")) {
      score.textContent = "测试失败";
      score.className = "failed";
      detail.textContent = error instanceof Error ? error.message : "无法读取动画帧率。";
    }
  } finally {
    if (scope.active) retry.disabled = false;
  }
}

async function beginScanSession(scope: PageScope): Promise<void> {
  if (scanPhase === "scanning" || scanPhase === "initializing") {
    return;
  }

  const status = document.querySelector<HTMLElement>("#scan-status");
  const action = document.querySelector<HTMLButtonElement>("#scan-action");

  if (!window.isSecureContext) {
    if (status) {
      status.textContent = "摄像头需要 HTTPS。请用手机 Safari 打开局域网 https 地址。";
    }
    return;
  }

  scanPhase = "initializing";
  resetScanCaptureState();
  if (action) {
    action.disabled = true;
    action.textContent = "加载中…";
  }
  if (status) {
    status.textContent = "正在加载识别模型与摄像头…";
  }

  try {
    const service = await loadPoseService();
    await service.init();
    if (!scope.active) {
      return;
    }
    if (scanVideo) {
      await service.startVideo(scanVideo, scope.signal);
    }
    if (!scope.active) {
      return;
    }
    scanPhase = "scanning";
    if (action) {
      action.textContent = "扫描中…";
    }
    if (status) {
      status.textContent = service.delegate === "CPU"
        ? "已启用 CPU 兼容模式。请缓慢转身，系统会自动采集完整轮廓。"
        : "请缓慢转身，系统会在轮廓充分时自动采集。";
    }
    updateScanCoverageUi();
    speak(buildCoverageState(bucketQualities).guidance);
    startScanLoop();
  } catch (error) {
    if (!scope.active || (error instanceof DOMException && error.name === "AbortError")) {
      return;
    }
    scanPhase = "idle";
    if (status) {
      status.textContent = error instanceof Error ? error.message : "无法启动扫描。";
    }
    if (action) {
      action.disabled = false;
      action.textContent = "扫描";
    }
  }
}

function startScanLoop(): void {
  stopScanLoop();
  let lastTimestamp = -1;

  const tick = () => {
    if (!scanVideo || !scanOverlay || scanPhase !== "scanning") {
      return;
    }

    const timestamp = performance.now();
    if (timestamp !== lastTimestamp) {
      lastTimestamp = timestamp;
      const rawLandmarks = poseService?.detectForVideoFrame(timestamp) ?? null;
      const ctx = scanOverlay.getContext("2d");
      if (rawLandmarks) {
        latestRawLandmarks = rawLandmarks;
        latestLandmarks = normalizeLandmarks(rawLandmarks);
        latestMaskCapture = poseService?.captureOrientationMask(timestamp) ?? null;
        scanOverlay.width = scanOverlay.clientWidth;
        scanOverlay.height = scanOverlay.clientHeight;
        if (ctx) {
          drawSilhouetteOverlay(
            ctx,
            rawLandmarks,
            scanOverlay.width,
            scanOverlay.height,
            scanVideo.videoWidth,
            scanVideo.videoHeight,
            "#9ec5ff",
          );
          const segmentation = latestMaskCapture
            ? extractSegmentationCapture(latestMaskCapture.mask, latestMaskCapture.width, latestMaskCapture.height)
            : null;
          if (segmentation?.contour.length) {
            drawSegmentationContour(
              ctx,
              segmentation.contour,
              scanOverlay.width,
              scanOverlay.height,
              scanVideo.videoWidth,
              scanVideo.videoHeight,
              "#66ffd6",
            );
          }
        }
      } else {
        latestLandmarks = null;
        latestRawLandmarks = null;
        latestMaskCapture = null;
      }

      handleQualityScan(timestamp);
    }

    scanLoopId = requestAnimationFrame(tick);
  };

  scanLoopId = requestAnimationFrame(tick);
}

function handleQualityScan(now: number): void {
  if (scanPhase !== "scanning" || !latestLandmarks || !latestRawLandmarks) {
    stableCaptureSince = 0;
    return;
  }

  if (countVisibleLandmarks(latestRawLandmarks) < 20) {
    stableCaptureSince = 0;
    setScanGuidance("可见关键点不足，请调整光线、站位并确保全身无遮挡。");
    updateScanCoverageUi();
    return;
  }

  // 只允许摄像头真实识别出的头、肩和脚通过；推断关键点不能用于完整人体扫描。
  const bodyCheck = validateFullBody(latestRawLandmarks);

  if (!bodyCheck.ok) {
    stableCaptureSince = 0;
    setScanGuidance(bodyCheck.message);
    updateScanCoverageUi();
    return;
  }

  const maskCapture = latestMaskCapture;
  if (!maskCapture) {
    stableCaptureSince = 0;
    return;
  }

  const tilt = computeBodyTilt(latestRawLandmarks);
  const shouldCorrectTilt = Number.isFinite(tilt) && Math.abs(tilt) > 15;
  const lyingPoseCorrected = shouldCorrectTilt && Math.abs(tilt) > 60;
  const alignedRawLandmarks = shouldCorrectTilt
    ? rotateLandmarksInImage(latestRawLandmarks, -tilt)
    : latestRawLandmarks;
  const alignedLandmarks = shouldCorrectTilt
    ? normalizeLandmarks(alignedRawLandmarks)
    : latestLandmarks;
  const alignedMask = shouldCorrectTilt
    ? rotateBinaryMask(maskCapture.mask, maskCapture.width, maskCapture.height, -tilt)
    : maskCapture.mask;
  const setAlignedGuidance = (message: string): void => {
    setScanGuidance(lyingPoseCorrected ? `检测到躺姿，已自动校正。${message}` : message);
  };

  const bucket = estimateBodyAzimuth(alignedRawLandmarks);
  if (bucket === null) {
    stableCaptureSince = 0;
    setAlignedGuidance("请缓慢转身，让肩部和全身保持在画面内。");
    updateScanCoverageUi();
    return;
  }

  const quality = scoreBinaryMask(alignedMask, maskCapture.width, maskCapture.height);
  if (quality < MIN_MASK_QUALITY) {
    stableCaptureSince = 0;
    setAlignedGuidance("人物轮廓不够完整，请后退一步或上下移动相机以拍全全身。");
    updateScanCoverageUi();
    return;
  }

  const jointSignature = computeJointSignature(alignedRawLandmarks);
  if (jointSignature.length !== 8) {
    stableCaptureSince = 0;
    setAlignedGuidance("请让双臂、手腕和双腿保持清晰可见，再继续转身。");
    updateScanCoverageUi();
    return;
  }
  if (
    baselineJointSignature
    && signatureDeviation(baselineJointSignature, jointSignature) > MAX_JOINT_SIGNATURE_DEVIATION
  ) {
    stableCaptureSince = 0;
    setAlignedGuidance(POSE_MISMATCH_GUIDANCE);
    updateScanCoverageUi();
    return;
  }

  if ((bucketQualities.get(bucket) ?? 0) >= MIN_MASK_QUALITY) {
    stableCaptureSince = 0;
  } else {
    if (stableCaptureSince === 0) stableCaptureSince = now;
    if (now - stableCaptureSince >= STABLE_CAPTURE_MS && now - lastMaskSampleAt >= 120) {
      const normalized = anchorNormalizePersonMask(
        alignedMask,
        maskCapture.width,
        maskCapture.height,
        alignedRawLandmarks,
      ) ?? normalizePersonMask(alignedMask, maskCapture.width, maskCapture.height);
      if (!normalized) {
        stableCaptureSince = 0;
        return;
      }
      lastMaskSampleAt = now;
      baselineJointSignature ??= [...jointSignature];
      const frames = bucketFrames.get(bucket) ?? [];
      if (
        frames.length > 0
        && (frames[0].normalized.width !== normalized.width
          || frames[0].normalized.height !== normalized.height
          || Boolean(frames[0].normalized.anchor) !== Boolean(normalized.anchor))
      ) {
        frames.length = 0;
      }
      const sourceAppearance = scanVideo
        ? captureAppearanceLuma(scanVideo, maskCapture.width, maskCapture.height)
        : null;
      const alignedAppearance = sourceAppearance && shouldCorrectTilt
        ? rotateByteField(sourceAppearance, maskCapture.width, maskCapture.height, -tilt)
        : sourceAppearance;
      const appearanceLuma = alignedAppearance
        ? normalizeAppearanceLuma(
            alignedAppearance,
            maskCapture.width,
            maskCapture.height,
            normalized,
            alignedRawLandmarks,
          ) ?? undefined
        : undefined;
      frames.push({
        normalized,
        appearanceLuma,
        quality,
        landmarks: alignedLandmarks.map((point) => ({ ...point })),
        jointSignature: [...jointSignature],
        capturedAt: new Date().toISOString(),
      });
      bucketFrames.set(bucket, frames);
      if (frames.length >= FRAMES_PER_ORIENTATION) {
        applyBucketCapture(bucket, frames.slice(-FRAMES_PER_ORIENTATION));
        stableCaptureSince = 0;
      } else {
        setAlignedGuidance(`保持当前方向，正在融合轮廓 ${frames.length}/${FRAMES_PER_ORIENTATION}。`);
      }
    }
  }

  const updated = buildCoverageState(bucketQualities);
  const bufferedCount = bucketFrames.get(bucket)?.length ?? 0;
  setAlignedGuidance(
    bufferedCount > 0 && !bucketQualities.has(bucket)
      ? `保持当前方向，正在融合轮廓 ${bufferedCount}/${FRAMES_PER_ORIENTATION}。`
      : updated.guidance,
  );
  updateScanCoverageUi();

  if (updated.isComplete) {
    void finishScanSession();
  }
}

function applyBucketCapture(
  bucket: AzimuthBucket,
  frames: BufferedScanFrame[],
): void {
  if (frames.length === 0) return;
  const width = frames[0].normalized.width;
  const height = frames[0].normalized.height;
  const fusedMask = fuseBinaryMasks(frames.map((frame) => frame.normalized.mask));
  const appearanceLuma = fuseAppearanceFrames(frames, fusedMask);
  const compactAppearance = appearanceLuma
    ? compactAppearanceLuma(appearanceLuma, width, height) ?? undefined
    : undefined;
  const quality = frames.reduce((sum, frame) => sum + frame.quality, 0) / frames.length;
  const personAspect = frames.reduce((sum, frame) => sum + frame.normalized.personAspect, 0) / frames.length;
  const jointSignature = Array.from({ length: 8 }, (_, index) => (
    frames.reduce((sum, frame) => sum + frame.jointSignature[index], 0) / frames.length
  ));
  const anchors = frames.flatMap((frame) => frame.normalized.anchor ? [frame.normalized.anchor] : []);
  const anchor = anchors.length === frames.length
    ? {
        pelvis: {
          x: anchors.reduce((sum, item) => sum + item.pelvis.x, 0) / anchors.length,
          y: anchors.reduce((sum, item) => sum + item.pelvis.y, 0) / anchors.length,
        },
        anchorHeight: anchors.reduce((sum, item) => sum + item.anchorHeight, 0) / anchors.length,
      }
    : undefined;
  const lastFrame = frames[frames.length - 1];
  bucketQualities.set(bucket, quality);
  const angle = azimuthToScanAngle(bucket);
  const segmentation = extractSegmentationCapture(fusedMask, width, height);

  const snapshot: PoseView = {
    angle,
    landmarks: lastFrame.landmarks,
    silhouetteContour: segmentation?.contour,
    bodyProfile: segmentation?.bodyProfile,
    capturedAt: lastFrame.capturedAt,
  };

  capturedViews = capturedViews.filter((view) => view.angle !== angle);
  capturedViews.push(snapshot);

  capturedOrientations = capturedOrientations.filter((item) => item.azimuth !== bucket);
  capturedOrientations.push({
    azimuth: bucket,
    width,
    height,
    mask: encodePersonMaskRLE(fusedMask),
    ...(compactAppearance ? {
      appearanceLuma: encodeAppearanceLuma(compactAppearance),
      appearanceWidth: APPEARANCE_FIELD_WIDTH,
      appearanceHeight: APPEARANCE_FIELD_HEIGHT,
    } : {}),
    normalized: true,
    personAspect,
    ...(anchor ? { anchor } : {}),
    jointSignature,
    frameCount: frames.length,
    quality,
  });
  updateScanDebugUi();
}

function setScanGuidance(text: string): void {
  const instruction = document.querySelector<HTMLElement>("#scan-instruction");
  if (instruction) {
    instruction.textContent = text;
  }
  if (voiceEnabled && text !== lastSpokenGuidance && scanPhase === "scanning") {
    lastSpokenGuidance = text;
    speak(text);
  }
}

function updateScanCoverageUi(): void {
  const coverage = buildCoverageState(bucketQualities);
  const fill = document.querySelector<HTMLElement>("#scan-coverage-fill");
  if (fill) {
    fill.style.width = `${coverage.overallPercent}%`;
  }
  const chips = document.querySelector<HTMLElement>("#scan-coverage-chips");
  if (chips) {
    chips.innerHTML = coverage.slots
      .map(
        (slot) =>
          `<span class="coverage-chip ${slot.captured ? "done" : ""}">${slot.label}${slot.captured ? " ✓" : ""}</span>`,
      )
      .join("");
  }
  const overlay = document.querySelector<HTMLElement>("#scan-coverage");
  if (overlay) {
    overlay.textContent = `${coverage.overallPercent}%`;
  }
}

function scanDebugLabel(azimuth: AzimuthBucket): string {
  return azimuth === 0 ? "正面" : azimuth === 90 ? "右侧" : azimuth === 180 ? "背面" : "左侧";
}

function paintBinaryMaskCanvas(
  canvas: HTMLCanvasElement,
  mask: Uint8Array | null,
  sourceWidth: number,
  sourceHeight: number,
): void {
  const context = canvas.getContext("2d");
  if (!context) return;
  context.fillStyle = "#07111d";
  context.fillRect(0, 0, canvas.width, canvas.height);
  if (!mask) return;
  const image = context.createImageData(canvas.width, canvas.height);
  for (let y = 0; y < canvas.height; y += 1) {
    const sourceY = Math.min(sourceHeight - 1, Math.floor((y + 0.5) * sourceHeight / canvas.height));
    for (let x = 0; x < canvas.width; x += 1) {
      const sourceX = Math.min(sourceWidth - 1, Math.floor((x + 0.5) * sourceWidth / canvas.width));
      const targetIndex = (y * canvas.width + x) * 4;
      if (mask[sourceY * sourceWidth + sourceX]) {
        image.data[targetIndex] = 174;
        image.data[targetIndex + 1] = 203;
        image.data[targetIndex + 2] = 235;
        image.data[targetIndex + 3] = 235;
      } else {
        image.data[targetIndex] = 7;
        image.data[targetIndex + 1] = 17;
        image.data[targetIndex + 2] = 29;
        image.data[targetIndex + 3] = 255;
      }
    }
  }
  context.putImageData(image, 0, 0);
}

function updateScanDebugUi(): void {
  const content = document.querySelector<HTMLElement>("#scan-debug-content");
  if (!content) return;
  content.innerHTML = `
    <div class="scan-debug-grid">
      ${AZIMUTH_BUCKETS.map((azimuth) => {
        const orientation = capturedOrientations.find((item) => item.azimuth === azimuth);
        const deviation = baselineJointSignature && orientation?.jointSignature
          ? signatureDeviation(baselineJointSignature, orientation.jointSignature)
          : null;
        return `
          <article class="scan-debug-slot">
            <strong>${scanDebugLabel(azimuth)}</strong>
            <canvas width="96" height="144" data-scan-debug-azimuth="${azimuth}" aria-label="${scanDebugLabel(azimuth)}归一化蒙版"></canvas>
            <dl>
              <div><dt>质量</dt><dd>${orientation?.quality === undefined ? "--" : `${Math.round(orientation.quality * 100)}%`}</dd></div>
              <div><dt>姿势偏差</dt><dd>${deviation === null ? "--" : `${deviation.toFixed(1)}°`}</dd></div>
              <div><dt>锚点</dt><dd>${orientation ? `${orientation.anchor ? "有" : "无"}${orientation.partial ? " · partial" : ""}` : "--"}</dd></div>
            </dl>
          </article>
        `;
      }).join("")}
    </div>
    <div class="scan-debug-reconstruction">
      <span>重建失败码：${escapeHtml(scanReconstructionDebug.failureCode ?? "--")}</span>
      <span>重建耗时：${scanReconstructionDebug.elapsedMs === undefined ? "--" : `${scanReconstructionDebug.elapsedMs} ms`}</span>
    </div>
  `;

  content.querySelectorAll<HTMLCanvasElement>("canvas[data-scan-debug-azimuth]").forEach((canvas) => {
    const azimuth = Number(canvas.dataset.scanDebugAzimuth);
    const orientation = capturedOrientations.find((item) => item.azimuth === azimuth);
    if (!orientation) {
      paintBinaryMaskCanvas(canvas, null, 1, 1);
      return;
    }
    try {
      const mask = decodePersonMaskRLE(orientation.mask, orientation.width * orientation.height);
      paintBinaryMaskCanvas(canvas, mask, orientation.width, orientation.height);
    } catch {
      const context = canvas.getContext("2d");
      if (!context) return;
      context.fillStyle = "#ffb4ab";
      context.font = "12px sans-serif";
      context.fillText("蒙版解码失败", 8, 22);
    }
  });
}

function reconstructionFailureCode(error: unknown): string {
  if (error instanceof Error) {
    const match = /^([A-Z][A-Z0-9_]+):/.exec(error.message);
    if (match) return match[1];
    if (error.name && error.name !== "Error") return error.name.toUpperCase();
  }
  return "RECONSTRUCTION_FAILED";
}

function photoAzimuthFromFileName(fileName: string): AzimuthBucket | null {
  const normalized = fileName.toLowerCase();
  if (/(^|[._\-\s])(front|正面|前面)([._\-\s]|$)/u.test(normalized)) return 0;
  if (/(^|[._\-\s])(right|右侧|右面)([._\-\s]|$)/u.test(normalized)) return 90;
  if (/(^|[._\-\s])(back|rear|背面|后面)([._\-\s]|$)/u.test(normalized)) return 180;
  if (/(^|[._\-\s])(left|左侧|左面)([._\-\s]|$)/u.test(normalized)) return 270;
  return null;
}

function suggestPhotoAzimuth(
  landmarks: AvatarPose["landmarks"],
  fileName: string,
): AzimuthBucket | null {
  const named = photoAzimuthFromFileName(fileName);
  if (named !== null) return named;
  const estimated = estimateBodyAzimuth(landmarks);
  if (estimated === null) return null;
  if (estimated !== 0 && estimated !== 180) return estimated;
  const faceIndices = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const faceVisibility = faceIndices.reduce((sum, index) => sum + (landmarks[index]?.visibility ?? 0), 0)
    / faceIndices.length;
  return faceVisibility < 0.45 ? 180 : 0;
}

function availablePhotoAzimuth(
  detected: AzimuthBucket,
  used: Set<AzimuthBucket>,
): AzimuthBucket | null {
  const opposite: Record<AzimuthBucket, AzimuthBucket> = { 0: 180, 90: 270, 180: 0, 270: 90 };
  const preferences = [detected, opposite[detected], ...AZIMUTH_BUCKETS];
  return preferences.find((azimuth) => !used.has(azimuth)) ?? null;
}

function moveImportedPhoto(id: string, target: AzimuthBucket): void {
  const moving = importedPhotoCaptures.find((item) => item.id === id);
  if (!moving || moving.assignedAzimuth === target) return;
  const previous = moving.assignedAzimuth;
  const occupied = importedPhotoCaptures.find((item) => item.assignedAzimuth === target);
  moving.assignedAzimuth = target;
  if (occupied) occupied.assignedAzimuth = previous;
  updatePhotoImportUi();
}

function updatePhotoImportUi(): void {
  const status = document.querySelector<HTMLElement>("#photo-import-status");
  const board = document.querySelector<HTMLElement>("#photo-import-board");
  const build = document.querySelector<HTMLButtonElement>("#photo-import-build");
  if (status) {
    const summary = photoImportBusy
      ? photoImportProgress || "正在本机识别照片…"
      : importedPhotoCaptures.length > 0
        ? `已通过 ${importedPhotoCaptures.length} 张。可拖动卡片或用下拉菜单纠正方向。`
        : "选择 2–4 张全身照片；原图只在内存中识别，不会保存。";
    status.innerHTML = `${escapeHtml(summary)}${photoImportErrors.length > 0
      ? `<br><span class="photo-import-errors">${photoImportErrors.map(escapeHtml).join("<br>")}</span>`
      : ""}`;
  }
  if (build) {
    build.classList.toggle("hidden", importedPhotoCaptures.length < 2);
    build.disabled = photoImportBusy || importedPhotoCaptures.length < 2;
  }
  if (!board) return;
  if (importedPhotoCaptures.length === 0) {
    board.replaceChildren();
    return;
  }

  board.innerHTML = `<div class="photo-direction-grid">
    ${AZIMUTH_BUCKETS.map((azimuth) => {
      const item = importedPhotoCaptures.find((capture) => capture.assignedAzimuth === azimuth);
      return `<section class="photo-direction-slot" data-photo-drop-azimuth="${azimuth}">
        <strong>${scanDebugLabel(azimuth)}</strong>
        ${item ? `<article class="photo-result-card" draggable="true" data-photo-id="${item.id}">
          <canvas width="96" height="144" data-photo-mask-id="${item.id}" aria-label="${escapeHtml(item.fileName)} 的归一化蒙版"></canvas>
          <span title="${escapeHtml(item.fileName)}">${escapeHtml(item.fileName)}</span>
          <small>质量 ${Math.round(item.quality * 100)}% · 偏差 ${item.signatureDeviation.toFixed(1)}° · ${item.normalized.anchor ? "有锚点" : "无锚点"}${item.partial ? " · partial 补全" : ""}</small>
          <label>方向
            <select data-photo-direction-id="${item.id}">
              ${AZIMUTH_BUCKETS.map((value) => `<option value="${value}" ${value === item.assignedAzimuth ? "selected" : ""}>${scanDebugLabel(value)}</option>`).join("")}
            </select>
          </label>
        </article>` : `<span class="photo-direction-empty">拖到这里</span>`}
      </section>`;
    }).join("")}
  </div>`;

  board.querySelectorAll<HTMLElement>("[draggable=true][data-photo-id]").forEach((card) => {
    card.addEventListener("dragstart", (event) => {
      event.dataTransfer?.setData("text/plain", card.dataset.photoId ?? "");
    });
  });
  board.querySelectorAll<HTMLElement>("[data-photo-drop-azimuth]").forEach((slot) => {
    slot.addEventListener("dragover", (event) => event.preventDefault());
    slot.addEventListener("drop", (event) => {
      event.preventDefault();
      const id = event.dataTransfer?.getData("text/plain");
      const azimuth = Number(slot.dataset.photoDropAzimuth) as AzimuthBucket;
      if (id && AZIMUTH_BUCKETS.includes(azimuth)) moveImportedPhoto(id, azimuth);
    });
  });
  board.querySelectorAll<HTMLSelectElement>("select[data-photo-direction-id]").forEach((select) => {
    select.addEventListener("change", () => {
      const azimuth = Number(select.value) as AzimuthBucket;
      if (AZIMUTH_BUCKETS.includes(azimuth)) moveImportedPhoto(select.dataset.photoDirectionId ?? "", azimuth);
    });
  });
  board.querySelectorAll<HTMLCanvasElement>("canvas[data-photo-mask-id]").forEach((canvas) => {
    const item = importedPhotoCaptures.find((capture) => capture.id === canvas.dataset.photoMaskId);
    if (item) paintBinaryMaskCanvas(canvas, item.normalized.mask, item.normalized.width, item.normalized.height);
  });
}

function hasReliablePartialAnchors(landmarks: AvatarPose["landmarks"]): boolean {
  return [0, 11, 12, 23, 24].every((index) => (
    landmarks[index] && landmarks[index].visibility >= 0.35
  ));
}

function pickScanPrimaryLandmarks(): AvatarPose["landmarks"] {
  const partialAngles = new Set(
    capturedOrientations
      .filter((orientation) => orientation.partial)
      .map((orientation) => azimuthToScanAngle(orientation.azimuth as AzimuthBucket)),
  );
  return pickPrimaryLandmarks(capturedViews, partialAngles);
}

function normalizeImportedPhotoLandmarks(landmarks: AvatarPose["landmarks"]): AvatarPose["landmarks"] {
  const normalized = normalizeLandmarks(landmarks);
  const leftHip = normalized[23];
  const rightHip = normalized[24];
  if (!leftHip || !rightHip || leftHip.visibility < 0.35 || rightHip.visibility < 0.35) return normalized;
  const pelvisX = (leftHip.x + rightHip.x) / 2;
  return normalized.map((landmark) => ({
    ...landmark,
    x: landmark.x - pelvisX,
    // 四向蒙版负责三维厚度；单张照片的关节 z 容易把抬手投影成前后穿插。
    z: 0,
  }));
}

async function importPhotoFiles(files: File[], scope: PageScope): Promise<void> {
  if (photoImportBusy) return;
  if (files.length < 2 || files.length > 4) {
    photoImportErrors = [];
    photoImportErrors.push("请一次选择 2–4 张图片。");
    updatePhotoImportUi();
    return;
  }

  resetScanCaptureState();
  photoImportBusy = true;
  photoImportProgress = "正在加载照片识别模型…";
  updatePhotoImportUi();
  poseService?.stop();
  try {
    const service = await loadPoseService();
    await service.initImageMode();
    if (!scope.active) return;
    let referenceSignature: number[] | null = null;
    const used = new Set<AzimuthBucket>();
    for (let index = 0; index < files.length; index += 1) {
      if (!scope.active || scope.signal.aborted) throw new DOMException("照片导入已取消。", "AbortError");
      const file = files[index];
      photoImportProgress = `正在识别第 ${index + 1}/${files.length} 张：${file.name}`;
      updatePhotoImportUi();
      try {
        const image = await loadImageFile(file);
        const capture = service.detectImage(image);
        if (!capture.landmarks) throw new Error("未识别到人体，请换一张背景更干净的全身照。");
        if (countVisibleLandmarks(capture.landmarks) < 20) {
          throw new Error("可见关键点少于 20 个，请确保头、手臂和双脚没有被裁切。");
        }
        const bodyCheck = validateFullBody(capture.landmarks);
        const partial = !bodyCheck.ok;
        if (partial && !hasReliablePartialAnchors(capture.landmarks)) throw new Error(bodyCheck.message);
        if (!capture.segmentation) throw new Error("未识别到完整人物轮廓，请提高人物与背景的对比度。");

        const tilt = computeBodyTilt(capture.landmarks);
        const shouldCorrectTilt = Number.isFinite(tilt) && Math.abs(tilt) > 15;
        const alignedRawLandmarks = shouldCorrectTilt
          ? rotateLandmarksInImage(capture.landmarks, -tilt)
          : capture.landmarks;
        const cleanedMask = keepLargestComponent(
          capture.segmentation.mask,
          capture.segmentation.width,
          capture.segmentation.height,
        );
        const alignedMask = shouldCorrectTilt
          ? rotateBinaryMask(
              cleanedMask,
              capture.segmentation.width,
              capture.segmentation.height,
              -tilt,
            )
          : cleanedMask;
        const quality = scoreBinaryMask(
          alignedMask,
          capture.segmentation.width,
          capture.segmentation.height,
          true,
        );
        if (quality < MIN_MASK_QUALITY) {
          throw new Error("人物轮廓质量不足，请使用头脚完整、人物更大且无遮挡的照片。");
        }
        const upperBodySignature = computeUpperBodyJointSignature(alignedRawLandmarks);
        if (upperBodySignature.length !== 4) {
          throw new Error("肩、肘或手腕关节不清楚，请换一张双臂完整可见的照片。");
        }
        const photoPoseSignature = computePhotoPoseSignature(alignedRawLandmarks);
        const deviation = referenceSignature ? signatureDeviation(referenceSignature, photoPoseSignature) : 0;
        if (referenceSignature && deviation > MAX_JOINT_SIGNATURE_DEVIATION) {
          throw new Error(`${POSE_MISMATCH_GUIDANCE}（最大关节偏差 ${deviation.toFixed(1)}°）`);
        }
        const fullJointSignature = computeJointSignature(alignedRawLandmarks);
        const jointSignature = fullJointSignature.length === 8
          ? fullJointSignature
          : [...upperBodySignature, 0, 0, 0, 0];
        const normalized = anchorNormalizePersonMask(
          alignedMask,
          capture.segmentation.width,
          capture.segmentation.height,
          alignedRawLandmarks,
        ) ?? normalizePersonMask(alignedMask, capture.segmentation.width, capture.segmentation.height);
        if (!normalized) throw new Error("人物轮廓无法归一化，请换一张全身居中的照片。");
        const sourceAppearance = captureAppearanceLuma(
          image,
          capture.segmentation.width,
          capture.segmentation.height,
        );
        const alignedAppearance = sourceAppearance && shouldCorrectTilt
          ? rotateByteField(
              sourceAppearance,
              capture.segmentation.width,
              capture.segmentation.height,
              -tilt,
            )
          : sourceAppearance;
        const appearanceLuma = alignedAppearance
          ? normalizeAppearanceLuma(
              alignedAppearance,
              capture.segmentation.width,
              capture.segmentation.height,
              normalized,
              alignedRawLandmarks,
            ) ?? undefined
          : undefined;
        const detectedAzimuth = suggestPhotoAzimuth(alignedRawLandmarks, file.name);
        if (detectedAzimuth === null) throw new Error("肩部方向不清楚，无法判断正背或左右方向。");
        const assignedAzimuth = availablePhotoAzimuth(detectedAzimuth, used);
        if (assignedAzimuth === null) throw new Error("没有可用的方向槽位。");
        used.add(assignedAzimuth);
        referenceSignature ??= [...photoPoseSignature];
        importedPhotoCaptures.push({
          id: createId(),
          fileName: file.name,
          detectedAzimuth,
          assignedAzimuth,
          normalized,
          appearanceLuma,
          quality,
          landmarks: normalizeImportedPhotoLandmarks(alignedRawLandmarks),
          jointSignature,
          signatureDeviation: deviation,
          partial,
          capturedAt: new Date().toISOString(),
        });
      } catch (error) {
        photoImportErrors.push(`${file.name}：${error instanceof Error ? error.message : "识别失败。"}`);
      }
    }
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError")) {
      photoImportErrors.push(error instanceof Error ? error.message : "照片导入失败。");
    }
  } finally {
    photoImportBusy = false;
    photoImportProgress = "";
    if (scope.active) updatePhotoImportUi();
  }
}

async function reconstructImportedPhotos(): Promise<void> {
  if (photoImportBusy || importedPhotoCaptures.length < 2) return;
  capturedViews = [];
  capturedOrientations = [];
  bucketQualities = new Map();
  baselineJointSignature = [...importedPhotoCaptures[0].jointSignature];
  for (const item of importedPhotoCaptures) {
    const segmentation = extractSegmentationCapture(
      item.normalized.mask,
      item.normalized.width,
      item.normalized.height,
    );
    const compactAppearance = item.appearanceLuma
      ? compactAppearanceLuma(
          item.appearanceLuma,
          item.normalized.width,
          item.normalized.height,
        ) ?? undefined
      : undefined;
    capturedViews.push({
      angle: azimuthToScanAngle(item.assignedAzimuth),
      landmarks: item.landmarks.map((landmark) => ({ ...landmark })),
      silhouetteContour: segmentation?.contour,
      bodyProfile: segmentation?.bodyProfile,
      capturedAt: item.capturedAt,
    });
    capturedOrientations.push({
      azimuth: item.assignedAzimuth,
      width: item.normalized.width,
      height: item.normalized.height,
      mask: encodePersonMaskRLE(item.normalized.mask),
      ...(compactAppearance ? {
        appearanceLuma: encodeAppearanceLuma(compactAppearance),
        appearanceWidth: APPEARANCE_FIELD_WIDTH,
        appearanceHeight: APPEARANCE_FIELD_HEIGHT,
      } : {}),
      normalized: true,
      personAspect: item.normalized.personAspect,
      ...(item.normalized.anchor ? { anchor: item.normalized.anchor } : {}),
      jointSignature: [...item.jointSignature],
      frameCount: 1,
      quality: item.quality,
      ...(item.partial ? { partial: true } : {}),
    });
    bucketQualities.set(item.assignedAzimuth, item.quality);
  }
  scanPhase = "scanning";
  updateScanCoverageUi();
  updateScanDebugUi();
  await finishScanSession();
}

async function finishScanSession(): Promise<void> {
  if (scanPhase !== "scanning") {
    return;
  }
  scanPhase = "reconstructing";
  stopScanLoop();
  poseService?.stop();

  const status = document.querySelector<HTMLElement>("#scan-status");
  if (status) status.textContent = "正在设备本地生成完整人体网格…";
  const reconstructionStartedAt = performance.now();
  scanReconstructionDebug = {};
  updateScanDebugUi();
  try {
    const { localReconstructionProvider } = await import("./ghost/reconstruction-provider");
    const result = await localReconstructionProvider.reconstruct(
      {
        orientations: capturedOrientations,
        landmarks: pickScanPrimaryLandmarks(),
      },
      activePageScope.signal,
      (progress) => {
        if (status && progress.stage === "carving") status.textContent = "正在雕刻和平滑人体表面…";
      },
    );
    scanReconstruction = {
      version: 2,
      provider: result.provider,
      status: "ready",
      sourceHash: result.sourceHash,
      meshKey: result.meshKey,
      quality: result.quality,
      viewCount: capturedOrientations.length,
      algorithmVersion: result.algorithmVersion,
      // One weak frame must not discard valid legs from the opposite and orthogonal views.
      // Fall back to standard lower limbs only when no complete frontal+lateral pair exists.
      partial: !hasOrthogonalFullBodyCoverage(capturedOrientations),
    };
    const previewStatus = document.querySelector<HTMLElement>("#scan-preview-status");
    if (previewStatus) {
      previewStatus.textContent = `完整人体外壳已生成 · 本地质量 ${Math.round(scanReconstruction.quality * 100)}%${scanReconstruction.partial ? " · partial：标准下肢已补全" : ""}`;
    }
    scanReconstructionDebug = { elapsedMs: Math.round(performance.now() - reconstructionStartedAt) };
    updateScanDebugUi();
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    scanReconstructionDebug = {
      failureCode: reconstructionFailureCode(error),
      elapsedMs: Math.round(performance.now() - reconstructionStartedAt),
    };
    updateScanDebugUi();
    scanPhase = "idle";
    if (status) {
      status.textContent = `完整人体生成失败，请调整站位后重新扫描。${error instanceof Error ? ` ${error.message}` : ""}`;
    }
    const action = document.querySelector<HTMLButtonElement>("#scan-action");
    if (action) {
      action.disabled = false;
      action.textContent = "重新扫描";
    }
    return;
  }

  scanPhase = "preview";
  speak("完整人体已经生成。请为你的灵体命名并选择风格。");

  const active = document.querySelector<HTMLElement>("#scan-active");
  const preview = document.querySelector<HTMLElement>("#scan-preview");
  active?.classList.add("hidden");
  preview?.classList.remove("hidden");
  document.querySelector(".scan-page")?.classList.add("scan-preview-mode");
  document.querySelector(".scan-stage")?.classList.add("hidden");

  if (status) {
    status.textContent = "";
  }

  await initScanPreviewScene(activePageScope);
}

async function initScanPreviewScene(scope: PageScope): Promise<void> {
  scanPreviewScene?.dispose();
  const canvas = document.querySelector<HTMLCanvasElement>("#scan-preview-canvas");
  if (!canvas || capturedViews.length === 0) {
    return;
  }
  const scene = await createGhostScene(canvas, false, {
    cameraPosition: [0, 0, 3.25],
    cameraTarget: [0, 0, 0],
    autoFrameSpectralBody: true,
  });
  if (!scope.active || !canvas.isConnected) {
    scene.dispose();
    return;
  }
  scanPreviewScene = scene;
  updateScanPreviewScene();
  scanPreviewScene.resize();
}

function updateScanPreviewScene(): void {
  if (!scanPreviewScene || capturedViews.length === 0) {
    return;
  }
  const primaryLandmarks = pickScanPrimaryLandmarks();
  const frontView = capturedViews.find((view) => view.angle === "front") ?? capturedViews[0];
  const draft: AvatarPose = {
    id: "scan-preview",
    label: "预览",
    style: selectedStyle,
    spectralTint: selectedSpectralTint,
    landmarks: primaryLandmarks,
    views: capturedViews,
    orientations: capturedOrientations.length ? [...capturedOrientations] : undefined,
    reconstruction: scanReconstruction,
    schema: "mediapipe-33",
    createdAt: new Date().toISOString(),
  };
  scanPreviewScene.setPoses([
    {
      pose: draft,
      bodyOptions: {
        silhouetteContour: frontView.silhouetteContour,
        bodyProfile: frontView.bodyProfile,
      },
    },
  ]);
}

function saveAvatarFromPreview(): void {
  const status = document.querySelector<HTMLElement>("#scan-save-status");
  if (capturedViews.length < 2 || capturedOrientations.length < 2 || scanReconstruction?.status !== "ready") {
    if (status) {
      status.textContent = "轮廓信息不足，请重新扫描。";
    }
    return;
  }

  const labelInput = document.querySelector<HTMLInputElement>("#pose-label");
  const primaryLandmarks = pickScanPrimaryLandmarks();
  const avatar: AvatarPose = {
    id: createId(),
    label: labelInput?.value.trim() || "未命名虚像",
    style: selectedStyle,
    spectralTint: selectedSpectralTint,
    landmarks: primaryLandmarks,
    views: capturedViews,
    orientations: capturedOrientations.length ? [...capturedOrientations] : undefined,
    reconstruction: scanReconstruction,
    schema: "mediapipe-33",
    createdAt: new Date().toISOString(),
  };

  store.addAvatar(avatar);
  scanPreviewScene?.dispose();
  scanPreviewScene = null;
  scanPhase = "idle";
  avatarScanOpen = false;
  resetScanCaptureState();
  if (status) {
    status.textContent = `已保存「${avatar.label}」。`;
  }
  render();
}

async function closeAvatarScan(): Promise<void> {
  if (hasUnsavedScan()) {
    const proceed = await confirmDialog(
      "扫描尚未保存",
      "离开将丢失本次扫描数据。确定要返回虚像吗？",
      { confirmLabel: "返回", danger: true },
    );
    if (!proceed) {
      return;
    }
  }
  avatarScanOpen = false;
  render();
}

function stopScanLoop(): void {
  cancelAnimationFrame(scanLoopId);
}

function speak(text: string): void {
  speakWithStyle(text, voiceStyle, false);
}

function speakVoiceSample(styleId: VoiceStyleId): void {
  speakWithStyle(VOICE_STYLES[styleId].sample, styleId, true);
}

function speakWithStyle(text: string, styleId: VoiceStyleId, force: boolean): void {
  if (!force && !voiceEnabled) {
    return;
  }
  window.speechSynthesis.cancel();
  const preset = VOICE_STYLES[styleId];
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "zh-CN";
  utterance.rate = preset.rate;
  utterance.pitch = preset.pitch;
  const zhVoice = window.speechSynthesis.getVoices().find((voice) => voice.lang.toLowerCase().startsWith("zh"));
  if (zhVoice) {
    utterance.voice = zhVoice;
  }
  window.speechSynthesis.speak(utterance);
}

function buildPlaceView(): DocumentFragment {
  const avatars = store.getAvatars();
  if (selectedPlaceAvatarId && !avatars.some((avatar) => avatar.id === selectedPlaceAvatarId)) {
    resetPlaceFlow();
  }
  const selectedAvatar = selectedPlaceAvatarId ? store.getAvatar(selectedPlaceAvatarId) : undefined;
  const fragment = document.createDocumentFragment();
  const steps = `
    <div class="place-steps" aria-label="放置步骤">
      <span class="${placeStep >= 1 ? "active" : ""}">1 选择虚像</span>
      <span class="${placeStep >= 2 ? "active" : ""}">2 调整空间</span>
      <span class="${placeStep >= 3 ? "active" : ""}">3 确认信息</span>
    </div>
  `;
  fragment.append(
    panel(
      "放置虚像",
      `
      <p class="hint">选择虚像并在真实空间中放置，保存后可在「我的」中查看。</p>
      ${steps}
      ${
        avatars.length === 0
          ? `<p class="hint">请先在「虚像」中扫描并创建一个虚像。</p>`
          : placeStep === 1
            ? `
              <div class="field">
                <label>先选择要放置的虚像</label>
                <select id="place-avatar">
                  <option value="">请选择虚像</option>
                  ${avatars.map((avatar) => `<option value="${avatar.id}">${escapeHtml(avatar.label)}</option>`).join("")}
                </select>
              </div>
              <div class="empty-state compact"><span class="hint">选择后才会打开空间预览。</span></div>
            `
            : selectedAvatar && placeStep === 2
              ? `
                <div class="place-selected-summary">已选择：<strong>${escapeHtml(selectedAvatar.label)}</strong></div>
                <div class="field">
                  <label>调整朝向 <span id="place-rotation-label">${placeRotationY}°</span></label>
                  <input id="place-rotation" type="range" min="0" max="359" value="${placeRotationY}" />
                </div>
                <p class="hint">在真实空间中移动手机并调整虚像位置，满意后继续。</p>
                <div class="actions">
                  <button class="secondary" id="place-change-avatar" type="button">重新选择</button>
                  <button class="primary" id="place-next" type="button">位置满意，继续</button>
                </div>
              `
              : selectedAvatar
                ? `
                  <div class="place-selected-summary">放置：<strong>${escapeHtml(selectedAvatar.label)}</strong> · 朝向 ${placeRotationY}°</div>
                  <div class="field">
                    <label>位置标签</label>
                    <input id="place-location" value="${escapeHtml(placeDraft.locationLabel)}" placeholder="例如：窗边、路口、书店门口" />
                  </div>
                  <div class="field">
                    <label>留言（实用提示也可以）</label>
                    <textarea id="place-message" maxlength="${MESSAGE_MAX_LENGTH}" placeholder="例如：此处晚风很好，适合站一会儿。">${escapeHtml(placeDraft.message)}</textarea>
                  </div>
                  <div class="actions">
                    <button class="secondary" id="place-back-adjust" type="button">返回调整</button>
                    <button class="primary" id="place-save" type="button">确认并保存</button>
                  </div>
                  <p class="status" id="place-status"></p>
                `
                : ""
      }
    `,
    ),
  );

  if (selectedAvatar && placeStep >= 2) {
    const stage = document.createElement("div");
    stage.className = "stage";
    stage.innerHTML = `<canvas id="place-canvas" class="three"></canvas>`;
    fragment.append(stage);
  }
  return fragment;
}

async function initPlaceScene(scope: PageScope): Promise<void> {
  ghostScene?.dispose();
  document.querySelector<HTMLSelectElement>("#place-avatar")?.addEventListener("change", (event) => {
    selectedPlaceAvatarId = (event.target as HTMLSelectElement).value || null;
    placeStep = selectedPlaceAvatarId ? 2 : 1;
    placeRotationY = 0;
    renderTab();
  });

  document.querySelector("#place-change-avatar")?.addEventListener("click", () => {
    resetPlaceFlow();
    renderTab();
  });
  document.querySelector("#place-next")?.addEventListener("click", () => {
    placeStep = 3;
    renderTab();
  });
  document.querySelector("#place-back-adjust")?.addEventListener("click", () => {
    placeStep = 2;
    renderTab();
  });
  document.querySelector<HTMLInputElement>("#place-location")?.addEventListener("input", (event) => {
    placeDraft.locationLabel = (event.target as HTMLInputElement).value;
  });
  document.querySelector<HTMLTextAreaElement>("#place-message")?.addEventListener("input", (event) => {
    placeDraft.message = (event.target as HTMLTextAreaElement).value;
  });
  document.querySelector("#place-save")?.addEventListener("click", () => {
    const status = document.querySelector<HTMLParagraphElement>("#place-status");
    try {
      const avatar = selectedPlaceAvatarId ? store.getAvatar(selectedPlaceAvatarId) : undefined;
      if (!avatar) {
        throw new Error("请选择虚像。");
      }
      const message = validateMessage(placeDraft.message);
      const locationLabel = placeDraft.locationLabel.trim() || "未命名位置";
      store.addPlacement({
        id: createId(),
        avatarPoseId: avatar.id,
        message,
        locationLabel,
        rotationY: placeRotationY,
        offsetX: 0,
        offsetZ: 0,
        createdAt: new Date().toISOString(),
      });
      resetPlaceFlow();
      activeTab = "mine";
      render();
    } catch (error) {
      if (status) {
        status.textContent = error instanceof Error ? error.message : "保存失败。";
      }
    }
  });

  const canvas = document.querySelector<HTMLCanvasElement>("#place-canvas");
  if (!canvas) {
    return;
  }

  const scene = await createGhostScene(canvas);
  if (!scope.active || !canvas.isConnected) {
    scene.dispose();
    return;
  }
  ghostScene = scene;
  const updatePreview = () => {
    const avatar = selectedPlaceAvatarId ? store.getAvatar(selectedPlaceAvatarId) : undefined;
    if (avatar) {
      const display = getDisplayViewData(avatar);
      ghostScene?.setPoses([
        {
          pose: { ...avatar, landmarks: display.landmarks },
          bodyOptions: {
            silhouetteContour: display.silhouetteContour,
            bodyProfile: display.bodyProfile,
          },
          placement: { rotationY: placeRotationY, offsetX: 0, offsetZ: 0 },
        },
      ]);
    }
  };

  document.querySelector("#place-rotation")?.addEventListener("input", (event) => {
    const value = Number((event.target as HTMLInputElement).value);
    placeRotationY = value;
    const label = document.querySelector("#place-rotation-label");
    if (label) {
      label.textContent = `${value}°`;
    }
    updatePreview();
  });

  updatePreview();
}

/** 「看见」页当前渲染顺序对应的放置，用于点击拾取 */
let discoverPlacements: Placement[] = [];

async function initDiscoverScene(scope: PageScope): Promise<void> {
  ghostScene?.dispose();

  const canvas = document.querySelector<HTMLCanvasElement>("#discover-canvas");
  const video = document.querySelector<HTMLVideoElement>("#discover-video");
  if (!canvas || !video) {
    return;
  }

  void startDiscoverCamera(video, scope);
  const scene = await createGhostScene(canvas, true);
  if (!scope.active || !canvas.isConnected) {
    scene.dispose();
    return;
  }
  ghostScene = scene;
  const placements = store.getDiscoverPlacements();

  discoverPlacements = [];
  const poseEntries = placements.flatMap((placement, index) => {
    const avatar = store.getAvatar(placement.avatarPoseId);
    if (!avatar) {
      return [];
    }
    discoverPlacements.push(placement);
    const display = getDisplayViewData(avatar);
    return [
      {
        pose: { ...avatar, landmarks: display.landmarks },
        bodyOptions: {
          silhouetteContour: display.silhouetteContour,
          bodyProfile: display.bodyProfile,
        },
        placement: {
          rotationY: placement.rotationY,
          offsetX: (index % 3) - 1,
          offsetZ: Math.floor(index / 3) - 1,
        },
      },
    ];
  });

  ghostScene.setPoses(poseEntries);
  ghostScene.resize();

  canvas.addEventListener("ghost-pick", ((event: CustomEvent<{ index: number }>) => {
    const placement = discoverPlacements[event.detail.index];
    if (placement) {
      openPlacementSheet(placement.id);
    }
  }) as EventListener);
}

async function startDiscoverCamera(video: HTMLVideoElement, scope: PageScope): Promise<void> {
  const status = document.querySelector<HTMLElement>("#discover-camera-status");
  const retry = document.querySelector<HTMLButtonElement>("#discover-camera-retry");
  if (status) status.textContent = "正在连接相机…";
  if (retry) retry.hidden = true;
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("当前设备不支持相机。");
    }
    discoverStream?.getTracks().forEach((track) => track.stop());
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false,
    });
    if (!scope.active || !video.isConnected) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    scope.signal.addEventListener("abort", () => {
      stream.getTracks().forEach((track) => track.stop());
      if (discoverStream === stream) {
        discoverStream = null;
      }
    }, { once: true });
    discoverStream = stream;
    video.srcObject = stream;
    await video.play();
    if (status) {
      status.textContent = "";
    }
  } catch (error) {
    if (!scope.active) {
      return;
    }
    if (status) {
      status.textContent =
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "请允许相机权限后拍摄。"
          : error instanceof Error
            ? error.message
            : "相机暂时不可用。";
    }
    if (retry) retry.hidden = false;
  }
}

async function captureDiscoverPhoto(): Promise<void> {
  const video = document.querySelector<HTMLVideoElement>("#discover-video");
  const overlayCanvas = document.querySelector<HTMLCanvasElement>("#discover-canvas");
  const status = document.querySelector<HTMLElement>("#discover-camera-status");
  if (!video || !overlayCanvas || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    if (status) {
      status.textContent = "相机尚未准备好，请稍后再拍。";
    }
    return;
  }
  const stage = video.closest<HTMLElement>(".discover-stage");
  stage?.classList.add("capturing");
  window.setTimeout(() => stage?.classList.remove("capturing"), 180);
  navigator.vibrate?.(30);
  const aspect = stage ? stage.clientWidth / Math.max(stage.clientHeight, 1) : 3 / 4;
  const width = 900;
  const height = Math.min(1200, Math.max(600, Math.round(width / aspect)));
  const output = document.createElement("canvas");
  output.width = width;
  output.height = height;
  const context = output.getContext("2d");
  if (!context) {
    return;
  }
  drawCover(context, video, width, height);
  context.drawImage(overlayCanvas, 0, 0, width, height);
  openCapturedPhotoPreview(output.toDataURL("image/jpeg", 0.86));
  showToast("已拍摄，可预览后保存。");
}

function drawCover(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  width: number,
  height: number,
): void {
  const sourceRatio = video.videoWidth / Math.max(video.videoHeight, 1);
  const targetRatio = width / height;
  let sourceWidth = video.videoWidth;
  let sourceHeight = video.videoHeight;
  let sourceX = 0;
  let sourceY = 0;
  if (sourceRatio > targetRatio) {
    sourceWidth = video.videoHeight * targetRatio;
    sourceX = (video.videoWidth - sourceWidth) / 2;
  } else {
    sourceHeight = video.videoWidth / targetRatio;
    sourceY = (video.videoHeight - sourceHeight) / 2;
  }
  context.drawImage(
    video,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    width,
    height,
  );
}

function openCapturedPhotoPreview(imageDataUrl: string): void {
  let savedPhoto: CapturedPhoto | null = null;
  const placements = store.getDiscoverPlacements();
  const locationLabel = placements[0]?.locationLabel ?? "当前位置";
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet record-composer" role="dialog" aria-modal="true">
      <div class="sheet-handle"></div>
      <div class="sheet-header">
        <span class="sheet-title">照片预览</span>
        <button class="sheet-close" data-close aria-label="关闭">✕</button>
      </div>
      <img class="record-composer-image" src="${escapeHtml(imageDataUrl)}" alt="刚刚拍摄的虚像照片" />
      <p class="hint">照片会先保存到「我的照片」，之后可选择发布到记录论坛。</p>
      <div class="actions">
        <button class="secondary" data-close type="button">重拍</button>
        <button class="primary" data-save-photo type="button">保存到我的照片</button>
        <button class="secondary" data-publish-photo type="button" hidden>去发布</button>
      </div>
      <p class="status" data-photo-status></p>
    </div>
  `;
  let releaseDialog: () => void = () => undefined;
  const cleanup = () => {
    releaseDialog();
    overlay.remove();
  };
  releaseDialog = bindDialogBehavior(overlay, cleanup);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      cleanup();
    }
  });
  overlay.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", cleanup));
  overlay.querySelector("[data-save-photo]")?.addEventListener("click", async () => {
    const button = overlay.querySelector<HTMLButtonElement>("[data-save-photo]");
    const publish = overlay.querySelector<HTMLButtonElement>("[data-publish-photo]");
    const status = overlay.querySelector<HTMLElement>("[data-photo-status]");
    button?.setAttribute("disabled", "");
    const id = createId();
    const mediaKey = `capture:${id}`;
    try {
      if (!(await recordMediaStore.save(mediaKey, imageDataUrl))) {
        throw new Error("照片保存失败，请检查浏览器存储权限。");
      }
      savedPhoto = {
        id,
        mediaKey,
        placementIds: placements.map((placement) => placement.id),
        locationLabel,
        discoverFilter: store.getSettings().discoverFilter,
        createdAt: new Date().toISOString(),
      };
      store.addCapturedPhoto(savedPhoto);
      const loaded = await recordMediaStore.load(mediaKey);
      if (loaded) {
        capturedPhotoCache.set(id, loaded);
      }
      if (status) {
        status.textContent = "已保存到「我的照片」。";
      }
      if (button) {
        button.textContent = "已保存";
      }
      if (publish) {
        publish.hidden = false;
      }
    } catch (error) {
      button?.removeAttribute("disabled");
      await recordMediaStore.delete(mediaKey);
      if (status) {
        status.textContent = error instanceof Error ? error.message : "照片保存失败。";
      }
    }
  });
  overlay.querySelector("[data-publish-photo]")?.addEventListener("click", () => {
    if (savedPhoto) {
      cleanup();
      void openRecordComposer(savedPhoto.id);
    }
  });
  document.body.append(overlay);
}

/** 点击虚像后弹出的详情（留言 / 漂流模式仅点赞） */
function openPlacementSheet(placementId: string): void {
  const placement = store.getPlacement(placementId);
  if (!placement) {
    return;
  }
  const avatar = store.getAvatar(placement.avatarPoseId);
  const drift = store.isDriftMode();

  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="sheet-handle"></div>
      <div class="sheet-header">
        <span class="sheet-title">${escapeHtml(avatar?.label ?? "未知虚像")}</span>
        <button class="sheet-close" data-close aria-label="关闭">✕</button>
      </div>
      <div class="hint">${escapeHtml(placement.locationLabel)}</div>
      <div class="message-card">${escapeHtml(placement.message)}</div>
      <div class="actions">
        <button class="like-btn ${store.isPlacementLiked(placement.id) ? "liked" : ""}" data-like-placement>
          ${store.isPlacementLiked(placement.id) ? "♥ 已赞" : "♡ 点赞"}
          <span class="like-count">${store.getPlacementLikeCount(placement.id)}</span>
        </button>
      </div>
      ${
        drift
          ? `<p class="hint">漂流模式下，你只点赞、不打扰。别人仍可留言，但不会打扰到你。</p>`
          : `<div class="comment-thread" data-thread="${placement.id}"></div>`
      }
    </div>
  `;

  let releaseDialog: () => void = () => undefined;
  const cleanup = () => {
    releaseDialog();
    overlay.remove();
  };
  releaseDialog = bindDialogBehavior(overlay, cleanup);

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      cleanup();
    }
  });
  overlay.querySelector("[data-close]")?.addEventListener("click", cleanup);

  const likeBtn = overlay.querySelector<HTMLButtonElement>("[data-like-placement]");
  likeBtn?.addEventListener("click", () => {
    store.togglePlacementLike(placement.id);
    const liked = store.isPlacementLiked(placement.id);
    likeBtn.classList.toggle("liked", liked);
    likeBtn.innerHTML = `${liked ? "♥ 已赞" : "♡ 点赞"}<span class="like-count">${store.getPlacementLikeCount(placement.id)}</span>`;
  });

  if (!drift) {
    const thread = overlay.querySelector<HTMLElement>(".comment-thread");
    if (thread) {
      refreshThread(thread, placement.id);
    }
  }

  document.body.append(overlay);
}

async function openRecordComposer(preselectedPhotoId?: string): Promise<void> {
  const photos = store.getCapturedPhotos();
  if (!photos.length) {
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `
      <div class="sheet" role="dialog" aria-modal="true">
        <div class="sheet-handle"></div>
        <div class="sheet-header">
          <span class="sheet-title">发布记录</span>
          <button class="sheet-close" data-close aria-label="关闭">✕</button>
        </div>
        <div class="empty-state">
          <strong class="empty-state-title">还没有可发布的照片</strong>
          <span class="empty-state-copy">先到「看见」用快门拍一张虚像照片，它会保存在「我的照片」。</span>
        </div>
        <button class="primary" data-go-discover type="button">去看见拍照</button>
      </div>
    `;
    let releaseDialog: () => void = () => undefined;
    const cleanup = () => {
      releaseDialog();
      overlay.remove();
    };
    releaseDialog = bindDialogBehavior(overlay, cleanup);
    overlay.querySelector("[data-close]")?.addEventListener("click", cleanup);
    overlay.querySelector("[data-go-discover]")?.addEventListener("click", () => {
      cleanup();
      void switchTab("discover");
    });
    document.body.append(overlay);
    return;
  }
  await ensureCapturedPhotoImages(photos);
  let selectedPhotoId =
    preselectedPhotoId && photos.some((photo) => photo.id === preselectedPhotoId)
      ? preselectedPhotoId
      : photos[0].id;
  const selectedPhoto = () => photos.find((photo) => photo.id === selectedPhotoId)!;
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet record-composer" role="dialog" aria-modal="true">
      <div class="sheet-handle"></div>
      <div class="sheet-header">
        <span class="sheet-title">发布记录</span>
        <button class="sheet-close" data-close aria-label="关闭">✕</button>
      </div>
      <div class="field">
        <label>从「我的照片」选择照片</label>
        <div class="record-photo-picker">
          ${photos.map((photo) => `
            <button type="button" data-select-record-photo="${photo.id}" class="${photo.id === selectedPhotoId ? "active" : ""}">
              <img src="${escapeHtml(capturedPhotoImage(photo))}" alt="${escapeHtml(formatTime(photo.createdAt))}" />
            </button>
          `).join("")}
        </div>
      </div>
      <img class="record-composer-image" id="record-selected-image" src="${escapeHtml(capturedPhotoImage(selectedPhoto()))}" alt="准备发布的照片" />
      <div class="field">
        <label>标题</label>
        <input id="record-title" maxlength="36" placeholder="给这张照片写个标题" />
      </div>
      <div class="field">
        <label>正文</label>
        <textarea id="record-caption" maxlength="240" placeholder="分享照片背后的故事…"></textarea>
      </div>
      <div class="field">
        <label for="record-public-location">公开地点</label>
        <input
          id="record-public-location"
          maxlength="24"
          value="${escapeHtml(defaultPublicLocation(selectedPhoto().locationLabel))}"
          placeholder="例如：滨江公园（请勿填写门牌）"
        />
        <span class="hint">照片保留在本机；论坛只公开这里填写的模糊地点。发布前请确认画面中没有不愿出镜的人。</span>
      </div>
      <div class="hint" id="record-location">拍摄于 ${formatTime(selectedPhoto().createdAt)}</div>
      <button class="primary" id="record-publish" type="button">发布</button>
      <p class="status" id="record-publish-status"></p>
    </div>
  `;

  let releaseDialog: () => void = () => undefined;
  const cleanup = () => {
    releaseDialog();
    overlay.remove();
  };
  releaseDialog = bindDialogBehavior(overlay, cleanup);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      cleanup();
    }
  });
  overlay.querySelector("[data-close]")?.addEventListener("click", cleanup);
  overlay.querySelectorAll<HTMLButtonElement>("[data-select-record-photo]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedPhotoId = button.dataset.selectRecordPhoto!;
      overlay.querySelectorAll("[data-select-record-photo]").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      const photo = selectedPhoto();
      const image = overlay.querySelector<HTMLImageElement>("#record-selected-image");
      const location = overlay.querySelector<HTMLElement>("#record-location");
      const publicLocation = overlay.querySelector<HTMLInputElement>("#record-public-location");
      if (image) {
        image.src = capturedPhotoImage(photo);
      }
      if (location) {
        location.textContent = `拍摄于 ${formatTime(photo.createdAt)}`;
      }
      if (publicLocation) {
        publicLocation.value = defaultPublicLocation(photo.locationLabel);
      }
    });
  });
  overlay.querySelector("#record-publish")?.addEventListener("click", async () => {
    const title = overlay.querySelector<HTMLInputElement>("#record-title")?.value.trim() ?? "";
    const caption = overlay.querySelector<HTMLTextAreaElement>("#record-caption")?.value.trim() ?? "";
    const publicLocationValue =
      overlay.querySelector<HTMLInputElement>("#record-public-location")?.value ?? "";
    const status = overlay.querySelector<HTMLElement>("#record-publish-status");
    const publishButton = overlay.querySelector<HTMLButtonElement>("#record-publish");
    if (!title) {
      if (status) {
        status.textContent = "请写一个标题。";
      }
      return;
    }
    const recordId = createId();
    const postMediaKey = `post:${recordId}`;
    const photo = selectedPhoto();
    let postAssetCreated = false;
    try {
      const publicLocation = validatePublicLocation(publicLocationValue);
      publishButton?.setAttribute("disabled", "");
      const imageUrl = await resolveCapturedPhotoImage(photo);
      if (!imageUrl) {
        throw new Error("无法读取所选照片，请重新拍摄。");
      }
      const copied = await recordMediaStore.copy(photo.mediaKey, postMediaKey);
      if (!copied) {
        throw new Error("照片复制失败，请重新拍摄后再发布。");
      }
      postAssetCreated = true;
      recordImageCache.set(recordId, copied);
      const placementId = photo.placementIds.length === 1 ? photo.placementIds[0] : undefined;
      const placement = placementId ? store.getPlacement(placementId) : undefined;
      store.addSceneRecord({
        id: recordId,
        sourcePhotoId: photo.id,
        placementId,
        avatarPoseId: placement?.avatarPoseId,
        title,
        caption,
        locationLabel: publicLocation,
        mediaKey: postMediaKey,
        authorId: LOCAL_OWNER_ID,
        authorName: store.getAuthorName(),
        createdAt: new Date().toISOString(),
      });
      cleanup();
      activeTab = "records";
      utilityPage = null;
      mountedPageKey = null;
      render();
    } catch (error) {
      if (postAssetCreated) {
        await recordMediaStore.delete(postMediaKey);
      }
      recordImageCache.delete(recordId);
      publishButton?.removeAttribute("disabled");
      if (status) {
        status.textContent = error instanceof Error ? error.message : "保存记录失败。";
      }
    }
  });
  document.body.append(overlay);
}

const recordsContext: RecordsContext = {
  store,
  openRecordComposer: () => void openRecordComposer(),
  renderTab,
  onRecordImagesChanged: () => {
    if (utilityPage === null && (activeTab === "records" || activeTab === "mine")) {
      renderTab();
    }
  },
};

const REACTION_META: Record<ReactionKind, string> = {
  useful: "有用",
  useless: "无用",
  joyful: "欢乐",
};

function refreshThread(thread: HTMLElement, placementId: string): void {
  thread.innerHTML = buildThreadInner(placementId);
  wireThread(thread, placementId);
  updateEngagementSummary(placementId);
}

function updateEngagementSummary(placementId: string): void {
  const summary = document
    .querySelector(`[data-thread="${placementId}"]`)
    ?.parentElement?.querySelector<HTMLElement>(".engagement-summary");
  if (!summary) {
    return;
  }
  const engagement = store.getPlacementEngagement(placementId);
  summary.textContent = `💬 ${engagement.commentCount} · 有用 ${engagement.reactionCounts.useful} · 无用 ${engagement.reactionCounts.useless} · 欢乐 ${engagement.reactionCounts.joyful}`;
}

function buildThreadInner(placementId: string): string {
  const topComments = store.getTopLevelComments(placementId);
  const commentsHtml = topComments.length
    ? topComments.map((comment) => buildTopComment(comment)).join("")
    : `<p class="hint comment-empty">还没有评论，来说两句。</p>`;

  return `
    ${commentsHtml}
    <div class="comment-compose" data-compose="${placementId}">
      <input class="comment-input" placeholder="写下你的评价…" maxlength="${MESSAGE_MAX_LENGTH}" />
      <button class="primary comment-send" data-send-top="${placementId}">评论</button>
    </div>
    <p class="status comment-error" data-error="${placementId}"></p>
  `;
}

function buildTopComment(comment: Comment): string {
  const myReaction = store.getCommentReaction(comment.id);
  const replies = store.getReplies(comment.id);
  const reactionButtons = (Object.keys(REACTION_META) as ReactionKind[])
    .map((kind) => {
      const active = myReaction === kind ? "active" : "";
      const count = myReaction === kind ? 1 : 0;
      return `<button class="chip creact ${active}" data-creact="${comment.id}" data-kind="${kind}">${REACTION_META[kind]} ${count}</button>`;
    })
    .join("");

  const repliesHtml = replies.map((reply) => buildReply(reply, comment.id)).join("");

  return `
    <div class="comment" data-comment="${comment.id}">
      <div class="comment-head">
        <span class="comment-author">${escapeHtml(comment.authorName)}</span>
        <span class="comment-time">${formatTime(comment.createdAt)}</span>
      </div>
      <div class="comment-body">${escapeHtml(comment.text)}</div>
      <div class="comment-actions">
        ${reactionButtons}
        <button class="chip" data-reply="${comment.id}" data-reply-to="${escapeHtml(comment.authorName)}">回复</button>
        <button class="chip danger-text" data-del-comment="${comment.id}">删除</button>
      </div>
      <div class="replies">${repliesHtml}</div>
    </div>
  `;
}

function buildReply(reply: Comment, topId: string): string {
  const liked = store.isCommentLiked(reply.id);
  const at = reply.replyToName ? `<span class="reply-at">回复 @${escapeHtml(reply.replyToName)}</span>` : "";
  return `
    <div class="comment reply" data-comment="${reply.id}">
      <div class="comment-head">
        <span class="comment-author">${escapeHtml(reply.authorName)}</span>
        ${at}
        <span class="comment-time">${formatTime(reply.createdAt)}</span>
      </div>
      <div class="comment-body">${escapeHtml(reply.text)}</div>
      <div class="comment-actions">
        <button class="chip clike ${liked ? "active" : ""}" data-like="${reply.id}">${liked ? "已赞" : "赞"}</button>
        <button class="chip" data-reply="${topId}" data-reply-to="${escapeHtml(reply.authorName)}">回复</button>
        <button class="chip danger-text" data-del-comment="${reply.id}">删除</button>
      </div>
    </div>
  `;
}

function wireThread(thread: HTMLElement, placementId: string): void {
  const errorEl = thread.querySelector<HTMLElement>(`[data-error="${placementId}"]`);
  const showError = (message: string) => {
    if (errorEl) {
      errorEl.textContent = message;
    }
  };

  // 一级评论三态评价
  thread.querySelectorAll<HTMLButtonElement>("button[data-creact]").forEach((button) => {
    button.addEventListener("click", () => {
      store.setCommentReaction(button.dataset.creact!, button.dataset.kind as ReactionKind);
      refreshThread(thread, placementId);
    });
  });

  // 二级回复点赞
  thread.querySelectorAll<HTMLButtonElement>("button[data-like]").forEach((button) => {
    button.addEventListener("click", () => {
      store.toggleCommentLike(button.dataset.like!);
      refreshThread(thread, placementId);
    });
  });

  // 回复：内联输入框
  thread.querySelectorAll<HTMLButtonElement>("button[data-reply]").forEach((button) => {
    button.addEventListener("click", () => {
      openReplyBox(thread, placementId, button.dataset.reply!, button.dataset.replyTo || undefined);
    });
  });

  // 删除评论/回复（带确认）
  thread.querySelectorAll<HTMLButtonElement>("button[data-del-comment]").forEach((button) => {
    button.addEventListener("click", async () => {
      const ok = await confirmDialog("删除评论", "确定删除这条评论吗？其下的回复也会一并删除。", {
        confirmLabel: "删除",
        danger: true,
      });
      if (ok) {
        store.deleteComment(button.dataset.delComment!);
        refreshThread(thread, placementId);
      }
    });
  });

  // 发表一级评论
  const sendTop = thread.querySelector<HTMLButtonElement>(`button[data-send-top="${placementId}"]`);
  const input = thread.querySelector<HTMLInputElement>(".comment-compose .comment-input");
  const submitTop = () => {
    if (!input) {
      return;
    }
    try {
      const text = validateMessage(input.value);
      store.addComment(placementId, text, null);
      refreshThread(thread, placementId);
    } catch (error) {
      showError(error instanceof Error ? error.message : "评论失败。");
    }
  };
  sendTop?.addEventListener("click", submitTop);
  input?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submitTop();
    }
  });
}

function openReplyBox(
  thread: HTMLElement,
  placementId: string,
  topCommentId: string,
  replyToName?: string,
): void {
  thread.querySelectorAll(".inline-reply-box").forEach((el) => el.remove());
  const anchor = thread.querySelector<HTMLElement>(`[data-comment="${topCommentId}"] .replies`);
  const host = anchor ?? thread.querySelector<HTMLElement>(`[data-comment="${topCommentId}"]`);
  if (!host) {
    return;
  }
  const box = document.createElement("div");
  box.className = "inline-reply-box";
  box.innerHTML = `
    <input class="comment-input" placeholder="${replyToName ? `回复 @${escapeHtml(replyToName)}` : "回复…"}" maxlength="${MESSAGE_MAX_LENGTH}" />
    <button class="primary" data-send-reply>发送</button>
    <button class="secondary" data-cancel-reply>取消</button>
    <p class="status inline-reply-error"></p>
  `;
  host.append(box);
  const input = box.querySelector<HTMLInputElement>(".comment-input");
  const errorEl = box.querySelector<HTMLElement>(".inline-reply-error");
  input?.focus();

  const submit = () => {
    if (!input) {
      return;
    }
    try {
      const text = validateMessage(input.value);
      store.addComment(placementId, text, topCommentId, replyToName);
      refreshThread(thread, placementId);
    } catch (error) {
      if (errorEl) {
        errorEl.textContent = error instanceof Error ? error.message : "回复失败。";
      }
    }
  };
  box.querySelector<HTMLButtonElement>("[data-send-reply]")?.addEventListener("click", submit);
  box.querySelector<HTMLButtonElement>("[data-cancel-reply]")?.addEventListener("click", () => box.remove());
  input?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
    }
  });
}

async function openCapturedPhotoSheet(photoId: string): Promise<void> {
  const photo = store.getCapturedPhoto(photoId);
  if (!photo) {
    return;
  }
  const imageUrl = await resolveCapturedPhotoImage(photo);
  if (!imageUrl) {
    return;
  }
  const published = store.getMySceneRecords().some((record) => record.sourcePhotoId === photo.id);
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet record-detail" role="dialog" aria-modal="true">
      <div class="sheet-handle"></div>
      <div class="sheet-header">
        <span class="sheet-title">我的照片</span>
        <button class="sheet-close" data-close aria-label="关闭">✕</button>
      </div>
      <img class="record-detail-image" src="${escapeHtml(imageUrl)}" alt="在看见中拍摄的照片" />
      <p class="hint">${escapeHtml(photo.locationLabel)} · ${formatTime(photo.createdAt)}</p>
      <div class="actions">
        <button class="primary" data-publish-photo type="button" ${published ? "disabled" : ""}>
          ${published ? "已发布到论坛" : "发布到记录"}
        </button>
        <button class="secondary" data-share-photo type="button">分享照片</button>
      </div>
      <p class="status" data-photo-detail-status></p>
    </div>
  `;
  let releaseDialog: () => void = () => undefined;
  const cleanup = () => {
    releaseDialog();
    overlay.remove();
  };
  releaseDialog = bindDialogBehavior(overlay, cleanup);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      cleanup();
    }
  });
  overlay.querySelector("[data-close]")?.addEventListener("click", cleanup);
  overlay.querySelector("[data-publish-photo]")?.addEventListener("click", () => {
    cleanup();
    void openRecordComposer(photo.id);
  });
  overlay.querySelector("[data-share-photo]")?.addEventListener("click", async () => {
    const status = overlay.querySelector<HTMLElement>("[data-photo-detail-status]");
    try {
      await shareSceneRecord(imageUrl, "Bridge 看见照片", `${photo.locationLabel} · ${formatTime(photo.createdAt)}`);
      if (status) {
        status.textContent = "已打开分享。";
      }
    } catch (error) {
      if (status && !(error instanceof DOMException && error.name === "AbortError")) {
        status.textContent = "暂时无法分享。";
      }
    }
  });
  document.body.append(overlay);
}

function buildMineView(): DocumentFragment {
  const placements = store.getMyPlacements();
  const photos = store.getCapturedPhotos();
  const publishedRecords = store.getMySceneRecords();
  void ensureCapturedPhotoImages(photos);
  const drift = store.isDriftMode();
  const fragment = document.createDocumentFragment();
  const settings = store.getSettings();
  void ensureProfileAvatar();
  const profile = document.createElement("section");
  profile.className = "mine-profile";
  profile.innerHTML = `
    <button class="friend-avatar profile-avatar-button" id="mine-edit-avatar" type="button" aria-label="更换头像">
      ${profileAvatarHtml(settings.nickname)}
    </button>
    <div class="mine-profile-copy">
      <h2>${escapeHtml(settings.nickname)}</h2>
      <p class="hint">${placements.length} 个放置 · ${photos.length} 张照片 · ${store.getFriends().length} 位好友</p>
    </div>
    <button class="secondary mine-edit-profile" id="mine-edit-profile" type="button">编辑资料</button>
  `;
  const section = panel(
    "我的",
    `
      <div class="mine-segments">
        <button class="${mineSection === "placements" ? "active" : ""}" data-mine-section="placements">我的放置</button>
        <button class="${mineSection === "records" ? "active" : ""}" data-mine-section="records">我的照片</button>
      </div>
      <div id="mine-list"></div>
    `,
  );
  section.classList.add("mine-content");
  fragment.append(profile, section);

  queueMicrotask(() => {
    document.querySelector("#mine-edit-profile")?.addEventListener("click", openProfileEditor);
    document.querySelector("#mine-edit-avatar")?.addEventListener("click", openProfileEditor);
    document.querySelectorAll<HTMLButtonElement>("[data-mine-section]").forEach((button) => {
      button.addEventListener("click", () => {
        mineSection = button.dataset.mineSection as typeof mineSection;
        renderTab();
      });
    });
    const list = document.querySelector<HTMLDivElement>("#mine-list");
    if (!list) {
      return;
    }
    if (mineSection === "records") {
      if (!photos.length) {
        list.innerHTML = `
          <div class="empty-state">
            <strong class="empty-state-title">还没有照片</strong>
            <span class="empty-state-copy">到「看见」点击快门，照片会保存在这里，并可发布到记录论坛。</span>
          </div>
        `;
        return;
      }
      list.className = "record-feed mine-record-feed";
      list.innerHTML = photos.map((photo) => {
        const published = publishedRecords.some((record) => record.sourcePhotoId === photo.id);
        return `
        <article class="record-card" data-open-photo="${photo.id}">
          <img src="${escapeHtml(capturedPhotoImage(photo))}" alt="看见拍摄于 ${escapeHtml(formatTime(photo.createdAt))}" />
          <div class="record-card-body">
            <strong>${escapeHtml(photo.locationLabel)}</strong>
            <div class="record-card-meta">
              <span>${formatTime(photo.createdAt)}</span>
              ${published ? `<span class="pill-tag">已发布</span>` : ""}
            </div>
            <div class="actions">
              <button class="secondary" data-publish-captured="${photo.id}" type="button" ${published ? "disabled" : ""}>
                ${published ? "已发布" : "发布"}
              </button>
              <button class="secondary danger-text" data-delete-photo="${photo.id}" type="button">删除</button>
            </div>
          </div>
        </article>
      `;
      }).join("");
      list.querySelectorAll<HTMLElement>("[data-open-photo]").forEach((card) => {
        card.addEventListener("click", (event) => {
          if ((event.target as HTMLElement).closest("button")) {
            return;
          }
          void openCapturedPhotoSheet(card.dataset.openPhoto!);
        });
      });
      list.querySelectorAll<HTMLButtonElement>("[data-publish-captured]").forEach((button) => {
        button.addEventListener("click", () => {
          void openRecordComposer(button.dataset.publishCaptured!);
        });
      });
      list.querySelectorAll<HTMLButtonElement>("[data-delete-photo]").forEach((button) => {
        button.addEventListener("click", async () => {
          const id = button.dataset.deletePhoto!;
          const photo = store.getCapturedPhoto(id);
          const ok = await confirmDialog(
            "删除照片",
            publishedRecords.some((r) => r.sourcePhotoId === id)
              ? "删除后照片从「我的照片」移除；已发布的帖子仍保留。"
              : "确定删除这张照片吗？",
            {
              confirmLabel: "删除",
              danger: true,
            },
          );
          if (ok && photo) {
            try {
              store.deleteCapturedPhoto(id);
              await recordMediaStore.delete(photo.mediaKey);
              capturedPhotoCache.delete(id);
              renderTab();
            } catch (error) {
              showToast(error instanceof Error ? error.message : "照片删除失败。", "error");
            }
          }
        });
      });
      return;
    }
    if (!placements.length) {
      list.innerHTML = `<div class="empty-state"><span class="hint">还没有放置。使用中间的“放置”留下第一个虚像。</span></div>`;
      return;
    }
    list.className = "list";
    list.replaceChildren(
      ...placements.map((placement) => {
        const avatar = store.getAvatar(placement.avatarPoseId);
        const engagement = store.getPlacementEngagement(placement.id);
        const item = document.createElement("div");
        item.className = "list-item";
        const hidden = placement.hidden === true;
        item.innerHTML = `
          <strong>${escapeHtml(avatar?.label ?? "未知虚像")}${hidden ? " · 已隐藏" : ""}</strong>
          <div class="hint">${escapeHtml(placement.locationLabel)} · ${formatTime(placement.createdAt)}</div>
          <div class="message-card">${escapeHtml(placement.message)}</div>
          <div class="engagement-summary">♥ ${store.getPlacementLikeCount(placement.id)}${drift ? "" : ` · 💬 ${engagement.commentCount} · 有用 ${engagement.reactionCounts.useful} · 无用 ${engagement.reactionCounts.useless} · 欢乐 ${engagement.reactionCounts.joyful}`}</div>
          <div class="actions">
            <button class="secondary" data-view="${placement.id}">${drift ? "查看" : "查看/评论"}</button>
            <button class="secondary" data-hide="${placement.id}">${hidden ? "取消隐藏" : "隐藏"}</button>
            <button class="secondary danger-text" data-del-placement="${placement.id}">删除放置</button>
          </div>
        `;

        item.querySelector<HTMLButtonElement>("[data-view]")?.addEventListener("click", () => {
          openPlacementSheet(placement.id);
        });

        item.querySelector<HTMLButtonElement>("[data-hide]")?.addEventListener("click", () => {
          store.setPlacementHidden(placement.id, !hidden);
          render();
        });

        item.querySelector<HTMLButtonElement>("[data-del-placement]")?.addEventListener("click", async () => {
          const ok = await confirmDialog("删除放置", "确定删除这个放置吗？相关评论也会一并删除，且无法恢复。", {
            confirmLabel: "删除",
            danger: true,
          });
          if (ok) {
            try {
              store.deletePlacement(placement.id);
              render();
            } catch (error) {
              showToast(error instanceof Error ? error.message : "放置删除失败。", "error");
            }
          }
        });

        return item;
      }),
    );
  });

  return fragment;
}

function openProfileEditor(): void {
  let pendingAvatar: string | null | undefined;
  const nickname = store.getAuthorName();
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet profile-editor" role="dialog" aria-modal="true">
      <div class="sheet-handle"></div>
      <div class="sheet-header">
        <span class="sheet-title">我的信息</span>
        <button class="sheet-close" data-close aria-label="关闭">✕</button>
      </div>
      <div class="profile-avatar-editor">
        <div class="friend-avatar profile-avatar-preview" id="profile-avatar-preview">
          ${profileAvatarHtml(nickname)}
        </div>
        <div class="actions">
          <button class="secondary" id="profile-avatar-choose" type="button">选择图片</button>
          ${profileAvatarUrl ? `<button class="secondary danger-text" id="profile-avatar-remove" type="button">移除头像</button>` : ""}
        </div>
        <input class="visually-hidden" id="profile-avatar-file" type="file" accept="image/*" />
      </div>
      <div class="field">
        <label>昵称</label>
        <input id="profile-nickname" value="${escapeHtml(nickname)}" maxlength="16" />
      </div>
      <p class="hint">昵称用于记录、评论与好友展示。</p>
      <button class="primary" id="profile-save" type="button">保存</button>
      <p class="status" id="profile-status"></p>
    </div>
  `;
  let releaseDialog: () => void = () => undefined;
  const cleanup = () => {
    releaseDialog();
    overlay.remove();
  };
  releaseDialog = bindDialogBehavior(overlay, cleanup);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      cleanup();
    }
  });
  overlay.querySelector("[data-close]")?.addEventListener("click", cleanup);
  const fileInput = overlay.querySelector<HTMLInputElement>("#profile-avatar-file");
  const preview = overlay.querySelector<HTMLElement>("#profile-avatar-preview");
  overlay.querySelector("#profile-avatar-choose")?.addEventListener("click", () => fileInput?.click());
  fileInput?.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    const status = overlay.querySelector<HTMLElement>("#profile-status");
    if (!file || !preview) {
      return;
    }
    try {
      pendingAvatar = await resizeImageFile(file);
      preview.innerHTML = `<img class="profile-avatar-image" src="${escapeHtml(pendingAvatar)}" alt="" />`;
      if (status) {
        status.textContent = "图片已准备好，点击保存生效。";
      }
    } catch (error) {
      if (status) {
        status.textContent = error instanceof Error ? error.message : "无法处理图片。";
      }
    }
  });
  overlay.querySelector("#profile-avatar-remove")?.addEventListener("click", () => {
    pendingAvatar = null;
    if (preview) {
      preview.textContent = initialOf(
        overlay.querySelector<HTMLInputElement>("#profile-nickname")?.value ?? nickname,
      );
    }
  });
  overlay.querySelector("#profile-save")?.addEventListener("click", async () => {
    const nextNickname = overlay.querySelector<HTMLInputElement>("#profile-nickname")?.value ?? "";
    const status = overlay.querySelector<HTMLElement>("#profile-status");
    const saveButton = overlay.querySelector<HTMLButtonElement>("#profile-save");
    saveButton?.setAttribute("disabled", "");
    try {
      if (typeof pendingAvatar === "string") {
        const saved = await recordMediaStore.save(PROFILE_AVATAR_MEDIA_KEY, pendingAvatar);
        if (!saved) {
          throw new Error("头像保存失败，请检查浏览器存储权限。");
        }
        profileAvatarUrl = await recordMediaStore.load(PROFILE_AVATAR_MEDIA_KEY);
        store.updateSettings({ profileAvatarMediaKey: PROFILE_AVATAR_MEDIA_KEY });
      } else if (pendingAvatar === null) {
        await recordMediaStore.delete(PROFILE_AVATAR_MEDIA_KEY);
        profileAvatarUrl = null;
        store.updateSettings({ profileAvatarMediaKey: undefined });
      }
      store.setAuthorName(nextNickname);
      cleanup();
      renderTab();
    } catch (error) {
      saveButton?.removeAttribute("disabled");
      if (status) {
        status.textContent = error instanceof Error ? error.message : "保存失败。";
      }
    }
  });
  document.body.append(overlay);
  overlay.querySelector<HTMLInputElement>("#profile-nickname")?.focus();
}

function buildAvatarsView(): DocumentFragment {
  const avatars = store.getAvatars();
  const fragment = document.createDocumentFragment();

  const createCard = document.createElement("section");
  createCard.className = "avatar-create-card";
  createCard.innerHTML = `
    <div>
      <span class="eyebrow">创建虚像</span>
      <h2>记录一个属于你的姿态</h2>
      <p class="hint">扫描完成的虚像会保存在这里，再用于真实空间放置。</p>
    </div>
    <button class="primary avatar-scan-button" id="avatar-start-scan" type="button">扫描新虚像</button>
  `;
  fragment.append(createCard);

  if (selectedAvatarId && !avatars.some((avatar) => avatar.id === selectedAvatarId)) {
    selectedAvatarId = null;
    previewRotationY = 0;
  }

  const selectedAvatar = selectedAvatarId ? store.getAvatar(selectedAvatarId) : undefined;
  const previewData = selectedAvatar ? getPreviewDataForRotation(selectedAvatar, previewRotationY) : null;

  const listContent =
    avatars.length === 0
      ? `<p class="hint">还没有虚像。点击上方“扫描新虚像”记录第一个姿势。</p>`
      : `<div class="list">${avatars
          .map(
            (avatar) => `
              <div class="list-item selectable ${selectedAvatarId === avatar.id ? "selected" : ""}" data-select-avatar="${avatar.id}" role="button" tabindex="0" aria-label="预览虚像 ${escapeHtml(avatar.label)}">
                <strong>${escapeHtml(avatar.label)}</strong>
                <div class="hint">${GHOST_STYLE_LIST.find((style) => style.id === avatar.style)?.name ?? escapeHtml(avatar.style)} · ${avatar.views?.length ?? 1} 方位</div>
                <div class="hint">${new Date(avatar.createdAt).toLocaleString()}</div>
                <div class="actions">
                  <button class="secondary" data-delete="${avatar.id}">删除</button>
                </div>
              </div>
            `,
          )
          .join("")}</div>`;

  const rotationControl =
    selectedAvatar
      ? `
      <div class="rotation-picker">
        <label>旋转预览 <span id="avatar-rotation-label">${previewRotationY}°</span></label>
        <input id="avatar-rotation" type="range" min="0" max="359" value="${previewRotationY}" />
        <p class="hint">默认正面，可拖动滑块或在右侧画布拖拽旋转 360°。旋转时会自动匹配已录制的方位轮廓。</p>
        <p class="status" id="avatar-preview-status">当前方位：${scanViewLabel(previewData?.angle ?? "front")}</p>
      </div>`
      : "";

  const libraryPanel = panel(
      "我的虚像",
      `
      <p class="hint">点击列表选择虚像，手动旋转查看全身轮廓。</p>
      ${listContent}
      ${rotationControl}
    `,
  );
  libraryPanel.classList.add("avatar-library-panel");
  if (!selectedAvatar) {
    libraryPanel.classList.add("no-preview");
  }
  fragment.append(libraryPanel);

  if (selectedAvatar) {
    const stage = document.createElement("div");
    stage.className = "stage";
    stage.innerHTML = `<canvas id="avatars-canvas" class="three rotatable"></canvas>`;
    fragment.append(stage);
  }

  queueMicrotask(() => {
    document.querySelector("#avatar-start-scan")?.addEventListener("click", () => {
      avatarScanOpen = true;
      scanPhase = "idle";
      render();
    });

    document.querySelectorAll<HTMLButtonElement>("button[data-delete]").forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.stopPropagation();
        const id = button.dataset.delete ?? "";
        const avatar = store.getAvatar(id);
        const linkedPlacements = store.getPlacements().filter((placement) => placement.avatarPoseId === id).length;
        const extra = linkedPlacements
          ? `该虚像有 ${linkedPlacements} 个放置，删除后这些放置及其评论也会一并删除。`
          : "此操作无法恢复。";
        const ok = await confirmDialog(
          "删除虚像",
          `确定删除虚像「${avatar?.label ?? "未命名"}」吗？${extra}`,
          { confirmLabel: "删除", danger: true },
        );
        if (!ok) {
          return;
        }
        try {
          store.deleteAvatar(id);
        } catch (error) {
          showToast(error instanceof Error ? error.message : "虚像删除失败。", "error");
          return;
        }
        if (avatar?.reconstruction?.meshKey) {
          void import("./ghost/reconstruction-provider").then(({ deleteReconstructionCache }) => (
            deleteReconstructionCache(avatar.reconstruction!.meshKey)
          ));
        } else {
          void import("./ghost/body-silhouette").then(({ evictHullGeometry }) => evictHullGeometry(id));
        }
        if (selectedAvatarId === id) {
          selectedAvatarId = null;
          previewRotationY = 0;
        }
        render();
      });
    });

    document.querySelectorAll<HTMLElement>("[data-select-avatar]").forEach((item) => {
      const select = () => {
        selectedAvatarId = item.dataset.selectAvatar ?? null;
        previewRotationY = 0;
        renderTab();
      };
      item.addEventListener("click", (event) => {
        if ((event.target as HTMLElement).closest("button")) {
          return;
        }
        select();
      });
      item.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          select();
        }
      });
    });

    document.querySelector<HTMLInputElement>("#avatar-rotation")?.addEventListener("input", (event) => {
      previewRotationY = Number((event.target as HTMLInputElement).value);
      syncRotationUi();
      updateAvatarPreview();
    });

    void initAvatarsScene();
  });

  return fragment;
}

function syncRotationUi(): void {
  const label = document.querySelector("#avatar-rotation-label");
  const slider = document.querySelector<HTMLInputElement>("#avatar-rotation");
  const status = document.querySelector("#avatar-preview-status");
  if (label) {
    label.textContent = `${Math.round(previewRotationY)}°`;
  }
  if (slider) {
    slider.value = String(Math.round(previewRotationY));
  }
  const avatar = selectedAvatarId ? store.getAvatar(selectedAvatarId) : undefined;
  if (status && avatar) {
    const data = getPreviewDataForRotation(avatar, previewRotationY);
    status.textContent = `当前方位：${scanViewLabel(data.angle)}`;
  }
}

async function initAvatarsScene(): Promise<void> {
  ghostScene?.dispose();
  const canvas = document.querySelector<HTMLCanvasElement>("#avatars-canvas");
  const avatars = store.getAvatars();
  if (!canvas || avatars.length === 0) {
    return;
  }
  const scene = await createGhostScene(canvas);
  if (!canvas.isConnected) {
    scene.dispose();
    return;
  }
  ghostScene = scene;
  canvas.addEventListener("ghost-rotation", ((event: CustomEvent<{ deltaDeg: number }>) => {
    previewRotationY = ((previewRotationY + event.detail.deltaDeg) % 360 + 360) % 360;
    syncRotationUi();
    updateAvatarPreview();
  }) as EventListener);
  updateAvatarPreview();
  ghostScene.resize();
}

function updateAvatarPreview(): void {
  if (!ghostScene) {
    return;
  }
  const avatar = selectedAvatarId ? store.getAvatar(selectedAvatarId) : undefined;
  if (!avatar) {
    ghostScene.setPoses([]);
    return;
  }
  const data = getPreviewDataForRotation(avatar, previewRotationY);
  const quadrantBase: Record<PoseView["angle"], number> = {
    front: 0,
    left: 270,
    right: 90,
    back: 180,
    gesture: 0,
  };
  const fineRotation = previewRotationY - quadrantBase[data.angle];
  ghostScene.setPoses([
    {
      pose: { ...avatar, landmarks: data.landmarks },
      bodyOptions: {
        silhouetteContour: data.silhouetteContour,
        bodyProfile: data.bodyProfile,
      },
      rotationY: fineRotation,
    },
  ]);
}

function buildSocialView(): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const friends = store.getFriends();
  const activeConversation = activeConversationId
    ? store.getConversations().find((conversation) => conversation.id === activeConversationId)
    : undefined;

  if (activeConversation) {
    const friend = friends.find((item) => item.id === activeConversation.friendId);
    if (friend) {
      fragment.append(buildChatView(activeConversation, friend));
      return fragment;
    }
    activeConversationId = null;
  }

  const conversations = store.getConversations();
  const listContent = friends.length
    ? `<div class="conversation-list" id="friend-list"></div>`
    : `<div class="empty-state">还没有好友<br/><span class="hint">添加一位同行者，开始本机会话。</span></div>`;

  fragment.append(
    panel(
      "消息",
      `
      <p class="hint">好友与会话暂存在本机，数据结构已为 CloudKit 真实身份预留。</p>
      <div class="friend-add">
        <input id="friend-name" placeholder="输入好友昵称" maxlength="16" />
        <button class="primary" id="friend-add-btn">添加好友</button>
      </div>
      <p class="status" id="friend-status"></p>
      ${listContent}
    `,
    ),
  );

  queueMicrotask(() => {
    const nameInput = document.querySelector<HTMLInputElement>("#friend-name");
    const status = document.querySelector<HTMLElement>("#friend-status");

    const addFriend = () => {
      const value = nameInput?.value ?? "";
      const friend = store.addFriend(value);
      if (!friend) {
        if (status) {
          status.textContent = "请输入昵称。";
        }
        return;
      }
      render();
    };

    document.querySelector<HTMLButtonElement>("#friend-add-btn")?.addEventListener("click", addFriend);
    nameInput?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        addFriend();
      }
    });

    const list = document.querySelector<HTMLDivElement>("#friend-list");
    if (list) {
      list.replaceChildren(
        ...friends.map((friend) => {
          const conversation = conversations.find((item) => item.friendId === friend.id);
          const messages = conversation ? store.getChatMessages(conversation.id) : [];
          const lastMessage = messages.at(-1);
          const item = document.createElement("div");
          item.className = "friend-item conversation-item";
          item.setAttribute("role", "button");
          item.setAttribute("tabindex", "0");
          item.setAttribute("aria-label", `与 ${friend.name} 聊天`);
          item.innerHTML = `
            <span class="friend-avatar">${escapeHtml(initialOf(friend.name))}</span>
            <div class="friend-name">${escapeHtml(friend.name)}
              <div class="friend-meta">${escapeHtml(lastMessage?.text ?? "点击开始聊天")}</div>
            </div>
            ${conversation?.unreadCount ? `<span class="unread-badge">${conversation.unreadCount}</span>` : ""}
            <button class="secondary danger-text" data-remove-friend="${friend.id}">删除</button>
          `;
          item.addEventListener("click", (event) => {
            if ((event.target as HTMLElement).closest("[data-remove-friend]")) {
              return;
            }
            const next = store.conversationForFriend(friend.id);
            store.markConversationRead(next.id);
            activeConversationId = next.id;
            render();
          });
          item.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              const next = store.conversationForFriend(friend.id);
              store.markConversationRead(next.id);
              activeConversationId = next.id;
              render();
            }
          });
          item.querySelector<HTMLButtonElement>("[data-remove-friend]")?.addEventListener("click", async () => {
            const ok = await confirmDialog("删除好友", `确定删除好友「${friend.name}」吗？`, {
              confirmLabel: "删除",
              danger: true,
            });
            if (ok) {
              store.removeFriend(friend.id);
              render();
            }
          });
          return item;
        }),
      );
    }
  });

  return fragment;
}

function buildChatView(conversation: Conversation, friend: Friend): HTMLElement {
  const messages = store.getChatMessages(conversation.id);
  const section = document.createElement("section");
  section.className = "panel chat-panel";
  section.innerHTML = `
    <div class="chat-header">
      <button class="icon-btn" data-chat-back aria-label="返回会话">←</button>
      <span class="friend-avatar">${escapeHtml(initialOf(friend.name))}</span>
      <div>
        <h2>${escapeHtml(friend.name)}</h2>
        <div class="friend-meta">本机会话原型</div>
      </div>
    </div>
    <div class="chat-messages" id="chat-messages">
      ${
        messages.length
          ? messages
              .map((message) => chatMessageHtml(message, LOCAL_OWNER_ID, escapeHtml, formatTime))
              .join("")
          : `<div class="empty-state"><span class="hint">打个招呼吧。</span></div>`
      }
    </div>
    <div class="chat-compose">
      <input id="chat-input" maxlength="${MESSAGE_MAX_LENGTH}" placeholder="发送消息…" />
      <button class="primary" id="chat-send" type="button">发送</button>
    </div>
    <p class="status" id="chat-error"></p>
  `;

  queueMicrotask(() => {
    section.querySelector("[data-chat-back]")?.addEventListener("click", () => {
      activeConversationId = null;
      render();
    });
    const input = section.querySelector<HTMLInputElement>("#chat-input");
    const send = () => {
      const error = section.querySelector<HTMLElement>("#chat-error");
      try {
        const text = validateMessage(input?.value ?? "");
        store.sendChatMessage(conversation.id, text);
        render();
      } catch (cause) {
        if (error) {
          error.textContent = cause instanceof Error ? cause.message : "发送失败。";
        }
      }
    };
    section.querySelector("#chat-send")?.addEventListener("click", send);
    input?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        send();
      }
    });
  });
  return section;
}

function buildSettingsView(): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const settings = store.getSettings();
  const notificationsEnabled =
    settings.notifications &&
    "Notification" in window &&
    Notification.permission === "granted";
  if (settings.notifications !== notificationsEnabled) {
    store.updateSettings({ notifications: notificationsEnabled });
  }

  fragment.append(
    panel(
      "设置",
      `
      <div class="settings-group">
        <div class="settings-group-title">模式与通知</div>
        <div class="settings-row">
          <div>
            <div class="setting-label">漂流模式</div>
            <div class="setting-desc">只收赞、只点赞；无评论、无社交界面。别人仍能看见并评论你的虚像，只是不会打扰到你。</div>
          </div>
          <label class="switch"><input type="checkbox" id="settings-drift" aria-label="漂流模式" ${settings.driftMode ? "checked" : ""} /><span></span></label>
        </div>
        <div class="settings-row">
          <div>
            <div class="setting-label">通知</div>
            <div class="setting-desc">有人给你的虚像点赞或留言时提醒（原型阶段）</div>
          </div>
          <label class="switch"><input type="checkbox" id="settings-notify" aria-label="通知" ${notificationsEnabled ? "checked" : ""} /><span></span></label>
        </div>
      </div>

      <div class="settings-group">
        <div class="settings-group-title">权限</div>
        <div class="settings-row">
          <div>
            <div class="setting-label">相机</div>
            <div class="setting-desc">扫描虚像时需要</div>
          </div>
          <div class="permission-control">
            <span class="perm-status unknown" id="perm-camera">检测中…</span>
            <button class="secondary permission-request" id="request-camera" type="button">请求权限</button>
          </div>
        </div>
        <div class="settings-row">
          <div>
            <div class="setting-label">位置</div>
            <div class="setting-desc">在真实位置查看与放置虚像时需要</div>
          </div>
          <div class="permission-control">
            <span class="perm-status unknown" id="perm-location">检测中…</span>
            <button class="secondary permission-request" id="request-location" type="button">请求权限</button>
          </div>
        </div>
      </div>

      <div class="settings-group danger-zone">
        <div class="settings-group-title">数据</div>
        <div class="settings-row">
          <div>
            <div class="setting-label">清除本机数据</div>
            <div class="setting-desc">删除所有虚像、放置、评论、好友与设置</div>
          </div>
          <button class="danger" id="settings-clear">清除</button>
        </div>
      </div>

    `,
    ),
  );

  queueMicrotask(() => {
    document.querySelector<HTMLInputElement>("#settings-drift")?.addEventListener("change", (event) => {
      store.updateSettings({ driftMode: (event.target as HTMLInputElement).checked });
      render();
    });

    document.querySelector<HTMLInputElement>("#settings-notify")?.addEventListener("change", (event) => {
      void updateNotificationPreference(event.target as HTMLInputElement);
    });

    document.querySelector<HTMLButtonElement>("#request-camera")?.addEventListener("click", () => {
      void requestCameraPermission();
    });

    document.querySelector<HTMLButtonElement>("#request-location")?.addEventListener("click", () => {
      void requestLocationPermission();
    });

    document.querySelector<HTMLButtonElement>("#settings-clear")?.addEventListener("click", async () => {
      const ok = await confirmDialog("清除本机数据", "此操作会删除所有本机数据且无法恢复。确定继续吗？", {
        confirmLabel: "清除",
        danger: true,
      });
      if (ok) {
        await recordMediaStore.clear();
        localStorage.clear();
        window.location.reload();
      }
    });

    void refreshPermissionBadges();
  });

  return fragment;
}

async function refreshPermissionBadges(): Promise<void> {
  const query = async (name: PermissionName): Promise<"granted" | "denied" | "unknown"> => {
    try {
      const result = await navigator.permissions?.query({ name });
      if (!result) {
        return "unknown";
      }
      return result.state === "granted" ? "granted" : result.state === "denied" ? "denied" : "unknown";
    } catch {
      return "unknown";
    }
  };

  setPermissionBadge("perm-camera", await query("camera" as PermissionName));
  setPermissionBadge("perm-location", await query("geolocation" as PermissionName));
}

function setPermissionBadge(id: string, state: "granted" | "denied" | "unknown"): void {
  const element = document.querySelector<HTMLElement>(`#${id}`);
  if (!element) {
    return;
  }
  element.classList.remove("granted", "denied", "unknown");
  element.classList.add(state);
  element.textContent = state === "granted" ? "已授权" : state === "denied" ? "已拒绝" : "未确定";
}

async function requestCameraPermission(): Promise<void> {
  const button = document.querySelector<HTMLButtonElement>("#request-camera");
  button?.setAttribute("disabled", "");
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("当前浏览器不支持相机权限请求。");
    }
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    stream.getTracks().forEach((track) => track.stop());
    setPermissionBadge("perm-camera", "granted");
  } catch (error) {
    const denied = error instanceof DOMException && error.name === "NotAllowedError";
    setPermissionBadge("perm-camera", denied ? "denied" : "unknown");
  } finally {
    button?.removeAttribute("disabled");
  }
}

async function requestLocationPermission(): Promise<void> {
  const button = document.querySelector<HTMLButtonElement>("#request-location");
  button?.setAttribute("disabled", "");
  try {
    if (!navigator.geolocation) {
      throw new Error("当前浏览器不支持位置权限请求。");
    }
    await new Promise<GeolocationPosition>((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: false,
        timeout: 10_000,
        maximumAge: 60_000,
      });
    });
    setPermissionBadge("perm-location", "granted");
  } catch (error) {
    const denied =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: number }).code === 1;
    setPermissionBadge("perm-location", denied ? "denied" : "unknown");
  } finally {
    button?.removeAttribute("disabled");
  }
}

async function updateNotificationPreference(input: HTMLInputElement): Promise<void> {
  if (!input.checked) {
    store.updateSettings({ notifications: false });
    return;
  }

  if (!("Notification" in window)) {
    input.checked = false;
    store.updateSettings({ notifications: false });
    return;
  }

  const permission =
    Notification.permission === "default"
      ? await Notification.requestPermission()
      : Notification.permission;
  const enabled = permission === "granted";
  input.checked = enabled;
  store.updateSettings({ notifications: enabled });
}

window.addEventListener("resize", () => ghostScene?.resize());

window.addEventListener("beforeunload", (event) => {
  if (avatarScanOpen && hasUnsavedScan()) {
    event.preventDefault();
    event.returnValue = "";
  }
});

window.addEventListener("pagehide", () => {
  disposeActivePage();
  poseService?.dispose();
  poseService = null;
  poseServicePromise = null;
  void import("./ghost/body-silhouette").then(({ clearHullGeometryCache }) => {
    clearHullGeometryCache();
  });
  recordMediaStore.dispose();
});
