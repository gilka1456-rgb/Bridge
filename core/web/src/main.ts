import "./styles.css";
import type {
  AvatarPose,
  Comment,
  GhostStyleId,
  OrientationMask,
  Placement,
  PoseView,
  ReactionKind,
  ScanViewAngle,
  TabId,
} from "./models/types";
import { encodePersonMaskRLE } from "./pose/segmentation";
import { GHOST_STYLE_LIST } from "./ghost/styles";
import { GhostScene } from "./ghost/renderer";
import { PoseCaptureService } from "./pose/capture";
import {
  autoCompleteLowerBody,
  drawSegmentationContour,
  drawSilhouetteOverlay,
  getDisplayViewData,
  getPreviewDataForRotation,
  pickPrimaryLandmarks,
  SCAN_COMPLETE_MESSAGE,
  SCAN_VIEW_SEQUENCE,
  scanViewLabel,
  normalizeLandmarks,
  validateFullBody,
} from "./pose/landmarks";
import { validateMessage, MESSAGE_MAX_LENGTH } from "./services/moderation";
import { createId, LocalStore } from "./services/store";

const store = new LocalStore();
const poseService = new PoseCaptureService();

type VoiceStyleId = "standard" | "gentle" | "deep" | "robot";

const VOICE_STYLES: Record<VoiceStyleId, { name: string; rate: number; pitch: number }> = {
  standard: { name: "标准", rate: 0.95, pitch: 1 },
  gentle: { name: "温柔", rate: 0.82, pitch: 1.25 },
  deep: { name: "低沉", rate: 0.9, pitch: 0.7 },
  robot: { name: "机械", rate: 1.12, pitch: 0.45 },
};

const AUTO_CAPTURE_HOLD_MS = 900;
const AUTO_CAPTURE_COUNTDOWN_MS = 3000;
const AUTO_CAPTURE_COOLDOWN_MS = 2600;

let activeTab: TabId = "discover";
let selectedStyle: GhostStyleId = "wraith";
let latestLandmarks: ReturnType<typeof normalizeLandmarks> | null = null;
let capturedViews: PoseView[] = [];
let capturedOrientations: OrientationMask[] = [];

/** 扫描方位角映射：正 0 / 右 90 / 背 180 / 左 270；gesture 不参与外壳雕刻 */
const ORIENTATION_AZIMUTH: Partial<Record<ScanViewAngle, number>> = {
  front: 0,
  right: 90,
  back: 180,
  left: 270,
};
let scanLoopId = 0;
let scanStarted = false;
let autoCompleteLower = true;
let autoCaptureEnabled = true;
let voiceEnabled = true;
let voiceStyle: VoiceStyleId = "standard";

// 免手动自动捕获运行状态
let acStableSince = 0;
let acCountdownEndsAt = 0;
let acCooldownUntil = 0;
let acLastSpokenSecond = -1;

let selectedAvatarId: string | null = null;
let previewRotationY = 0;

let scanVideo: HTMLVideoElement | null = null;
let scanOverlay: HTMLCanvasElement | null = null;
let ghostScene: GhostScene | null = null;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("Missing #app root");
}

render();

function render(): void {
  app!.innerHTML = `
    <header>
      <div>
        <h1>Bridge Core</h1>
        <p>Windows 可运行的核心原型 · 未来迁移到 iOS AR</p>
      </div>
      <span class="status">${store.getAvatars().length} 虚像 · ${store.getPlacements().length} 放置</span>
    </header>
    <nav>
      ${tabButton("discover", "看见")}
      ${tabButton("scan", "扫描")}
      ${tabButton("place", "放置")}
      ${tabButton("mine", "我的放置")}
      ${tabButton("avatars", "虚像")}
    </nav>
    <main id="content"></main>
  `;

  app!.querySelectorAll("nav button").forEach((button) => {
    button.addEventListener("click", () => {
      const tab = button.getAttribute("data-tab") as TabId;
      void switchTab(tab);
    });
  });

  renderTab();
}

function tabButton(id: TabId, label: string): string {
  return `<button data-tab="${id}" class="${activeTab === id ? "active" : ""}">${label}</button>`;
}

async function switchTab(tab: TabId): Promise<void> {
  if (tab === activeTab) {
    return;
  }
  if (activeTab === "scan" && hasUnsavedScan()) {
    const proceed = await confirmDialog(
      "扫描尚未保存",
      "离开将丢失本次已记录的方位。确定要离开扫描吗？",
      { confirmLabel: "离开", danger: true },
    );
    if (!proceed) {
      return;
    }
  }
  stopScanLoop();
  window.speechSynthesis.cancel();
  scanStarted = false;
  ghostScene?.dispose();
  ghostScene = null;
  activeTab = tab;
  render();
}

function hasUnsavedScan(): boolean {
  return scanStarted || capturedViews.length > 0;
}

function renderTab(): void {
  const content = document.querySelector<HTMLDivElement>("#content");
  if (!content) {
    return;
  }

  if (activeTab === "scan") {
    content.replaceChildren(buildScanView());
    startScanView();
    return;
  }

  stopScanLoop();
  poseService.stop();

  if (activeTab === "place") {
    content.replaceChildren(buildPlaceView());
    void initPlaceScene();
    return;
  }

  if (activeTab === "discover") {
    content.replaceChildren(buildDiscoverView());
    void initDiscoverScene();
    return;
  }

  if (activeTab === "mine") {
    content.replaceChildren(buildMineView());
    return;
  }

  content.replaceChildren(buildAvatarsView());
}

function buildScanView(): DocumentFragment {
  const fragment = document.createDocumentFragment();
  fragment.append(
    panel(
      "扫描虚像",
      `
      <p class="hint">点击「开始扫描」后再启动摄像头与语音，按提示依次记录正面、侧面、背面与建言姿势。无面部皮肤细节，呈现魂游建言式灵体。</p>
      <div class="field">
        <label>姿势名称</label>
        <input id="pose-label" value="站立" />
      </div>
      <div class="field">
        <label>风格</label>
        <select id="pose-style">
          ${GHOST_STYLE_LIST.map((style) => `<option value="${style.id}">${style.name}</option>`).join("")}
        </select>
      </div>
      <div class="field">
        <label class="inline-toggle">
          <input type="checkbox" id="scan-autocapture" ${autoCaptureEnabled ? "checked" : ""} />
          免手动自动捕获（保持姿势倒计时自动拍摄）
        </label>
      </div>
      <div class="field">
        <label class="inline-toggle">
          <input type="checkbox" id="scan-autocomplete" ${autoCompleteLower ? "checked" : ""} />
          自动补足下半身（房间小 / 只能拍到上半身时）
        </label>
      </div>
      <div class="field voice-controls">
        <label class="inline-toggle">
          <input type="checkbox" id="scan-voice-enabled" ${voiceEnabled ? "checked" : ""} />
          语音提示
        </label>
        <select id="scan-voice-style">
          ${Object.entries(VOICE_STYLES)
            .map(([id, style]) => `<option value="${id}" ${voiceStyle === id ? "selected" : ""}>${style.name}语音</option>`)
            .join("")}
        </select>
      </div>
      <p class="status" id="scan-instruction">点击「开始扫描」后按提示完成各方位。</p>
      <p class="status" id="scan-progress">已记录 0 / ${SCAN_VIEW_SEQUENCE.length} 方位</p>
      <div class="actions">
        <button class="primary" id="scan-start">开始扫描</button>
        <button class="secondary" id="scan-next" disabled>记录此方位</button>
        <button class="primary" id="scan-capture" disabled>保存虚像</button>
      </div>
      <p class="status" id="scan-status">摄像头未开启。准备好后点击「开始扫描」。</p>
    `,
    ),
  );

  const stage = document.createElement("div");
  stage.className = "stage";
  stage.innerHTML = `
    <video id="scan-video" autoplay playsinline muted></video>
    <canvas id="scan-overlay" class="overlay"></canvas>
  `;
  fragment.append(stage);

  return fragment;
}

function startScanView(): void {
  scanStarted = false;
  scanVideo = document.querySelector<HTMLVideoElement>("#scan-video");
  scanOverlay = document.querySelector<HTMLCanvasElement>("#scan-overlay");
  const styleSelect = document.querySelector<HTMLSelectElement>("#pose-style");
  const status = document.querySelector<HTMLSpanElement>("#scan-status");
  const instruction = document.querySelector<HTMLParagraphElement>("#scan-instruction");

  styleSelect?.addEventListener("change", () => {
    selectedStyle = styleSelect.value as GhostStyleId;
  });

  document.querySelector<HTMLInputElement>("#scan-autocapture")?.addEventListener("change", (event) => {
    autoCaptureEnabled = (event.target as HTMLInputElement).checked;
    resetAutoCaptureState();
    updateNextButtonLabel();
    if (scanStarted) {
      updateInstruction(instruction);
    }
  });

  document.querySelector<HTMLInputElement>("#scan-autocomplete")?.addEventListener("change", (event) => {
    autoCompleteLower = (event.target as HTMLInputElement).checked;
  });

  document.querySelector<HTMLInputElement>("#scan-voice-enabled")?.addEventListener("change", (event) => {
    voiceEnabled = (event.target as HTMLInputElement).checked;
    if (!voiceEnabled) {
      window.speechSynthesis.cancel();
    }
  });

  document.querySelector<HTMLSelectElement>("#scan-voice-style")?.addEventListener("change", (event) => {
    voiceStyle = (event.target as HTMLSelectElement).value as VoiceStyleId;
    if (voiceEnabled && scanStarted) {
      speak("语音风格已切换。");
    }
  });

  document.querySelector("#scan-start")?.addEventListener("click", () => {
    void beginScan(status, instruction);
  });

  document.querySelector("#scan-next")?.addEventListener("click", () => {
    if (!scanStarted) {
      return;
    }
    manualCapture(status, instruction);
  });

  document.querySelector("#scan-capture")?.addEventListener("click", () => {
    saveAvatar(status);
  });

  updateNextButtonLabel();
}

function updateNextButtonLabel(): void {
  const button = document.querySelector<HTMLButtonElement>("#scan-next");
  if (!button) {
    return;
  }
  button.textContent = autoCaptureEnabled ? "手动补拍此方位" : "记录此方位";
}

function resetAutoCaptureState(): void {
  acStableSince = 0;
  acCountdownEndsAt = 0;
  acCooldownUntil = 0;
  acLastSpokenSecond = -1;
}

async function beginScan(status: HTMLElement | null, instruction: HTMLElement | null): Promise<void> {
  if (scanStarted) {
    return;
  }

  if (!window.isSecureContext) {
    if (status) {
      status.textContent =
        "摄像头需要 HTTPS 或 localhost。手机测试请用 localhost 隧道或 https，或先在电脑上打开。";
    }
    return;
  }

  const startButton = document.querySelector<HTMLButtonElement>("#scan-start");
  if (startButton) {
    startButton.disabled = true;
    startButton.textContent = "启动中…";
  }
  if (status) {
    status.textContent = "正在初始化摄像头与姿态识别…";
  }

  try {
    await poseService.init();
    if (scanVideo) {
      await poseService.startVideo(scanVideo);
    }
    scanStarted = true;
    capturedViews = [];
    capturedOrientations = [];
    resetAutoCaptureState();

    if (startButton) {
      startButton.textContent = "扫描进行中";
    }
    const nextButton = document.querySelector<HTMLButtonElement>("#scan-next");
    if (nextButton) {
      nextButton.disabled = false;
    }
    if (status) {
      status.textContent = "识别中。请保证目标在画面中。";
    }
    updateInstruction(instruction);
    updateScanProgress();
    updateSaveButton();
    const target = suggestNextAngle();
    speak(instructionForAngle(target));
    startScanLoop();
  } catch (error) {
    if (status) {
      status.textContent = error instanceof Error ? error.message : "无法启动摄像头。";
    }
    if (startButton) {
      startButton.disabled = false;
      startButton.textContent = "开始扫描";
    }
  }
}

function startScanLoop(): void {
  stopScanLoop();
  let lastTimestamp = -1;

  const tick = () => {
    if (!scanVideo || !scanOverlay) {
      return;
    }

    const timestamp = performance.now();
    if (timestamp !== lastTimestamp) {
      lastTimestamp = timestamp;
      const rawLandmarks = poseService.detectForVideoFrame(timestamp);
      const ctx = scanOverlay.getContext("2d");
      if (rawLandmarks) {
        const landmarks = autoCompleteLower ? autoCompleteLowerBody(rawLandmarks) : rawLandmarks;
        latestLandmarks = normalizeLandmarks(landmarks);
        scanOverlay.width = scanOverlay.clientWidth;
        scanOverlay.height = scanOverlay.clientHeight;
        if (ctx) {
          drawSilhouetteOverlay(
            ctx,
            landmarks,
            scanOverlay.width,
            scanOverlay.height,
            scanVideo.videoWidth,
            scanVideo.videoHeight,
            "#9ec5ff",
          );
          const segmentation = poseService.captureSegmentation(timestamp);
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
      }

      if (autoCaptureEnabled) {
        handleAutoCapture(timestamp, ctx);
      }
    }

    scanLoopId = requestAnimationFrame(tick);
  };

  scanLoopId = requestAnimationFrame(tick);
}

function handleAutoCapture(now: number, ctx: CanvasRenderingContext2D | null): void {
  if (!scanStarted) {
    return;
  }

  const status = document.querySelector<HTMLElement>("#scan-status");
  const instruction = document.querySelector<HTMLElement>("#scan-instruction");

  // 全部方位已录完，停止自动捕获，提示保存。
  if (capturedViews.length >= SCAN_VIEW_SEQUENCE.length) {
    return;
  }

  if (now < acCooldownUntil) {
    return;
  }

  const valid = !!latestLandmarks && validateFullBody(latestLandmarks).ok;

  if (!valid) {
    // 姿势丢失：重置稳定计时与倒计时。
    if (acCountdownEndsAt > 0 && status) {
      status.textContent = "姿势丢失，请重新对准画面。";
    }
    acStableSince = 0;
    acCountdownEndsAt = 0;
    acLastSpokenSecond = -1;
    return;
  }

  // 稳定保持一段时间后进入倒计时。
  if (acStableSince === 0) {
    acStableSince = now;
  }

  if (acCountdownEndsAt === 0) {
    if (now - acStableSince >= AUTO_CAPTURE_HOLD_MS) {
      acCountdownEndsAt = now + AUTO_CAPTURE_COUNTDOWN_MS;
      acLastSpokenSecond = -1;
    } else if (status) {
      status.textContent = `检测到全身，保持姿势准备自动拍摄「${scanViewLabel(suggestNextAngle())}」…`;
    }
  }

  if (acCountdownEndsAt > 0) {
    const remainingMs = acCountdownEndsAt - now;
    const remainingSec = Math.ceil(remainingMs / 1000);

    if (remainingSec !== acLastSpokenSecond && remainingSec > 0) {
      acLastSpokenSecond = remainingSec;
      speak(String(remainingSec));
    }

    if (ctx) {
      drawCountdown(ctx, remainingSec);
    }
    if (status) {
      status.textContent = `${remainingSec} 秒后自动拍摄「${scanViewLabel(suggestNextAngle())}」，保持不动。`;
    }

    if (remainingMs <= 0) {
      const captured = recordAngle(suggestNextAngle(), status, instruction, { auto: true });
      acStableSince = 0;
      acCountdownEndsAt = 0;
      acLastSpokenSecond = -1;
      acCooldownUntil = now + AUTO_CAPTURE_COOLDOWN_MS;
      if (captured && capturedViews.length < SCAN_VIEW_SEQUENCE.length) {
        const nextAngle = suggestNextAngle();
        window.setTimeout(() => {
          if (scanStarted && autoCaptureEnabled) {
            speak(instructionForAngle(nextAngle));
          }
        }, 700);
      }
    }
  }
}

function drawCountdown(ctx: CanvasRenderingContext2D, seconds: number): void {
  if (seconds <= 0) {
    return;
  }
  const { width, height } = ctx.canvas;
  ctx.save();
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = "#66ffd6";
  ctx.strokeStyle = "rgba(2, 3, 8, 0.8)";
  ctx.lineWidth = 8;
  ctx.font = `bold ${Math.min(width, height) * 0.32}px "Segoe UI", system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.strokeText(String(seconds), width / 2, height / 2);
  ctx.fillText(String(seconds), width / 2, height / 2);
  ctx.restore();
}

function stopScanLoop(): void {
  cancelAnimationFrame(scanLoopId);
}

function instructionForAngle(angle: ScanViewAngle): string {
  return SCAN_VIEW_SEQUENCE.find((step) => step.angle === angle)?.instruction ?? SCAN_COMPLETE_MESSAGE;
}

function updateInstruction(element: HTMLElement | null): void {
  if (!element) {
    return;
  }
  if (capturedViews.length >= SCAN_VIEW_SEQUENCE.length) {
    element.textContent = SCAN_COMPLETE_MESSAGE;
    return;
  }
  const target = suggestNextAngle();
  const hint = autoCaptureEnabled
    ? "保持姿势，系统会自动倒计时拍摄。"
    : "摆好后点「记录此方位」。";
  element.textContent = `${instructionForAngle(target)}（${hint}）`;
}

function updateScanProgress(): void {
  const progress = document.querySelector<HTMLParagraphElement>("#scan-progress");
  if (!progress) {
    return;
  }
  const labels = capturedViews.map((view) => scanViewLabel(view.angle)).join("、");
  progress.textContent =
    capturedViews.length === 0
      ? `已记录 0 / ${SCAN_VIEW_SEQUENCE.length} 方位`
      : `已记录 ${capturedViews.length} / ${SCAN_VIEW_SEQUENCE.length} 方位${labels ? `（${labels}）` : ""}`;
}

function updateSaveButton(): void {
  const button = document.querySelector<HTMLButtonElement>("#scan-capture");
  if (!button) {
    return;
  }
  const hasMinimum = capturedViews.length >= 2;
  button.disabled = !hasMinimum;
  button.textContent = hasMinimum ? "保存虚像" : `保存虚像（至少 2 方位）`;
}

function manualCapture(status: HTMLElement | null, instruction: HTMLElement | null): void {
  if (capturedViews.length >= SCAN_VIEW_SEQUENCE.length) {
    if (status) {
      status.textContent = SCAN_COMPLETE_MESSAGE;
    }
    return;
  }
  recordAngle(suggestNextAngle(), status, instruction, { auto: false });
}

function recordAngle(
  angle: ScanViewAngle,
  status: HTMLElement | null,
  instruction: HTMLElement | null,
  options: { auto: boolean },
): boolean {
  if (!latestLandmarks || latestLandmarks.length === 0) {
    if (status) {
      status.textContent = "尚未检测到人体，请调整距离与光线。";
    }
    return false;
  }

  const validation = validateFullBody(latestLandmarks);
  if (!validation.ok) {
    if (status) {
      status.textContent = validation.message;
    }
    return false;
  }

  const segmentation = poseService.captureSegmentation(performance.now());
  const snapshot: PoseView = {
    angle,
    landmarks: latestLandmarks.map((point) => ({ ...point })),
    silhouetteContour: segmentation?.contour,
    bodyProfile: segmentation?.bodyProfile,
    capturedAt: new Date().toISOString(),
  };

  capturedViews = capturedViews.filter((view) => view.angle !== angle);
  capturedViews.push(snapshot);

  // 视觉外壳前置数据：为参与雕刻的朝向采集全高二值 mask。
  const azimuth = ORIENTATION_AZIMUTH[angle];
  if (azimuth !== undefined) {
    const orientationCapture = poseService.captureOrientationMask(performance.now());
    if (orientationCapture) {
      capturedOrientations = capturedOrientations.filter((item) => item.azimuth !== azimuth);
      capturedOrientations.push({
        azimuth,
        width: orientationCapture.width,
        height: orientationCapture.height,
        mask: encodePersonMaskRLE(orientationCapture.mask),
      });
    }
  }

  const allDone = capturedViews.length >= SCAN_VIEW_SEQUENCE.length;
  if (status) {
    status.textContent = allDone
      ? `已记录${scanViewLabel(angle)}方位。${SCAN_COMPLETE_MESSAGE}`
      : `已记录${scanViewLabel(angle)}方位。`;
  }

  updateInstruction(instruction);
  updateScanProgress();
  updateSaveButton();

  // 手动模式下语音播报下一步；自动模式的播报由状态机在冷却后处理。
  if (!options.auto) {
    if (allDone) {
      speak(SCAN_COMPLETE_MESSAGE);
    } else {
      speak(instructionForAngle(suggestNextAngle()));
    }
  } else if (allDone) {
    speak(SCAN_COMPLETE_MESSAGE);
  }

  return true;
}

function suggestNextAngle(): ScanViewAngle {
  for (const step of SCAN_VIEW_SEQUENCE) {
    if (!capturedViews.some((view) => view.angle === step.angle)) {
      return step.angle;
    }
  }
  return "front";
}

function saveAvatar(status: HTMLElement | null): void {
  if (capturedViews.length < 2) {
    if (status) {
      status.textContent = "请至少记录 2 个方位（建议正面 + 建言姿势）。";
    }
    return;
  }

  const labelInput = document.querySelector<HTMLInputElement>("#pose-label");
  const primaryLandmarks = pickPrimaryLandmarks(capturedViews);
  const avatar: AvatarPose = {
    id: createId(),
    label: labelInput?.value.trim() || "未命名虚像",
    style: selectedStyle,
    landmarks: primaryLandmarks,
    views: capturedViews,
    orientations: capturedOrientations.length ? [...capturedOrientations] : undefined,
    schema: "mediapipe-33",
    createdAt: new Date().toISOString(),
  };

  store.addAvatar(avatar);
  capturedViews = [];
  capturedOrientations = [];
  resetAutoCaptureState();
  updateScanProgress();
  updateSaveButton();
  const instruction = document.querySelector<HTMLElement>("#scan-instruction");
  updateInstruction(instruction);
  if (status) {
    status.textContent = `已保存虚像「${avatar.label}」，含 ${avatar.views.length} 个全身方位。`;
  }
}

function speak(text: string): void {
  if (!voiceEnabled) {
    return;
  }
  window.speechSynthesis.cancel();
  const preset = VOICE_STYLES[voiceStyle];
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
  const fragment = document.createDocumentFragment();
  fragment.append(
    panel(
      "放置虚像",
      `
      <p class="hint">Phase 0 在 Windows 上模拟「放置」：保存位置标签、朝向与留言。iOS 版会替换成真实 AR 锚点。</p>
      ${
        avatars.length === 0
          ? `<p class="hint">请先在「扫描」中创建一个虚像。</p>`
          : `
        <div class="field">
          <label>虚像</label>
          <select id="place-avatar">
            ${avatars.map((avatar) => `<option value="${avatar.id}">${escapeHtml(avatar.label)}</option>`).join("")}
          </select>
        </div>
        <div class="field">
          <label>位置标签</label>
          <input id="place-location" placeholder="例如：窗边、路口、书店门口" />
        </div>
        <div class="field">
          <label>留言（实用提示也可以）</label>
          <textarea id="place-message" maxlength="${MESSAGE_MAX_LENGTH}" placeholder="例如：此处晚风很好，适合站一会儿。"></textarea>
        </div>
        <div class="field">
          <label>朝向 <span id="place-rotation-label">0°</span></label>
          <input id="place-rotation" type="range" min="0" max="359" value="0" />
        </div>
        <div class="actions">
          <button class="primary" id="place-save">保存放置</button>
        </div>
        <p class="status" id="place-status"></p>
      `
      }
    `,
    ),
  );

  const stage = document.createElement("div");
  stage.className = "stage";
  stage.innerHTML = `<canvas id="place-canvas" class="three"></canvas>`;
  fragment.append(stage);
  return fragment;
}

async function initPlaceScene(): Promise<void> {
  ghostScene?.dispose();
  const canvas = document.querySelector<HTMLCanvasElement>("#place-canvas");
  if (!canvas) {
    return;
  }

  ghostScene = new GhostScene(canvas);
  const updatePreview = () => {
    const avatarId = document.querySelector<HTMLSelectElement>("#place-avatar")?.value;
    const rotation = Number(document.querySelector<HTMLInputElement>("#place-rotation")?.value ?? 0);
    const avatar = avatarId ? store.getAvatar(avatarId) : undefined;
    if (avatar) {
      const display = getDisplayViewData(avatar);
      ghostScene?.setPoses([
        {
          pose: { ...avatar, landmarks: display.landmarks },
          bodyOptions: {
            silhouetteContour: display.silhouetteContour,
            bodyProfile: display.bodyProfile,
          },
          placement: { rotationY: rotation, offsetX: 0, offsetZ: 0 },
        },
      ]);
    }
  };

  document.querySelector("#place-avatar")?.addEventListener("change", updatePreview);
  document.querySelector("#place-rotation")?.addEventListener("input", (event) => {
    const value = Number((event.target as HTMLInputElement).value);
    const label = document.querySelector("#place-rotation-label");
    if (label) {
      label.textContent = `${value}°`;
    }
    updatePreview();
  });

  document.querySelector("#place-save")?.addEventListener("click", () => {
    const status = document.querySelector<HTMLParagraphElement>("#place-status");
    try {
      const avatarId = document.querySelector<HTMLSelectElement>("#place-avatar")?.value;
      const avatar = avatarId ? store.getAvatar(avatarId) : undefined;
      if (!avatar) {
        throw new Error("请选择虚像。");
      }

      const message = validateMessage(
        document.querySelector<HTMLTextAreaElement>("#place-message")?.value ?? "",
      );
      const locationLabel =
        document.querySelector<HTMLInputElement>("#place-location")?.value.trim() ||
        "未命名位置";
      const rotationY = Number(document.querySelector<HTMLInputElement>("#place-rotation")?.value ?? 0);

      store.addPlacement({
        id: createId(),
        avatarPoseId: avatar.id,
        message,
        locationLabel,
        rotationY,
        offsetX: 0,
        offsetZ: 0,
        createdAt: new Date().toISOString(),
      });

      if (status) {
        status.textContent = `已放置到「${locationLabel}」。去「看见」预览。`;
      }
      render();
    } catch (error) {
      if (status) {
        status.textContent = error instanceof Error ? error.message : "保存失败。";
      }
    }
  });

  updatePreview();
}

function buildDiscoverView(): DocumentFragment {
  const placements = store.getPlacements();
  const fragment = document.createDocumentFragment();
  fragment.append(
    panel(
      "看见",
      `
      <p class="hint">Phase 0 用 3D 场景模拟「举起手机看见虚像」。iOS 版会替换成真实 AR 相机与世界重定位。</p>
      <div class="field author-field">
        <label>我的昵称（用于评论）</label>
        <input id="author-name" value="${escapeHtml(store.getAuthorName())}" maxlength="16" />
      </div>
      ${
        placements.length === 0
          ? `<p class="hint">还没有放置。去「放置」留下第一个虚像。</p>`
          : `<div class="list" id="discover-list"></div>`
      }
    `,
    ),
  );

  const stage = document.createElement("div");
  stage.className = "stage";
  stage.innerHTML = `<canvas id="discover-canvas" class="three"></canvas>`;
  fragment.append(stage);
  return fragment;
}

async function initDiscoverScene(): Promise<void> {
  ghostScene?.dispose();

  document.querySelector<HTMLInputElement>("#author-name")?.addEventListener("change", (event) => {
    store.setAuthorName((event.target as HTMLInputElement).value);
  });

  const canvas = document.querySelector<HTMLCanvasElement>("#discover-canvas");
  if (!canvas) {
    return;
  }

  ghostScene = new GhostScene(canvas);
  const placements = store.getPlacements();

  const poseEntries = placements.flatMap((placement, index) => {
    const avatar = store.getAvatar(placement.avatarPoseId);
    if (!avatar) {
      return [];
    }
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

  renderDiscoverList();
}

function renderDiscoverList(): void {
  const list = document.querySelector<HTMLDivElement>("#discover-list");
  if (!list) {
    return;
  }
  const placements = store.getPlacements();
  list.replaceChildren(...placements.map((placement) => buildPlacementCard(placement)));
}

function buildPlacementCard(placement: Placement): HTMLElement {
  const avatar = store.getAvatar(placement.avatarPoseId);
  const item = document.createElement("div");
  item.className = "list-item";
  const engagement = store.getPlacementEngagement(placement.id);
  item.innerHTML = `
    <strong>${escapeHtml(avatar?.label ?? "未知虚像")}</strong>
    <div class="hint">${escapeHtml(placement.locationLabel)}</div>
    <div class="message-card">${escapeHtml(placement.message)}</div>
    <div class="engagement-summary">💬 ${engagement.commentCount} · 有用 ${engagement.reactionCounts.useful} · 无用 ${engagement.reactionCounts.useless} · 欢乐 ${engagement.reactionCounts.joyful}</div>
    <div class="comment-thread" data-thread="${placement.id}"></div>
  `;
  const thread = item.querySelector<HTMLElement>(".comment-thread");
  if (thread) {
    refreshThread(thread, placement.id);
  }
  return item;
}

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

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString();
}

function buildMineView(): DocumentFragment {
  const placements = store.getMyPlacements();
  const fragment = document.createDocumentFragment();

  const listContent = placements.length
    ? `<div class="list" id="mine-list"></div>`
    : `<p class="hint">你还没有放置任何虚像。去「放置」留下第一个。</p>`;

  fragment.append(
    panel(
      "我的放置",
      `
      <p class="hint">这里汇总你放置的所有虚像：查看、删除，或看它们收到的评价与评论。</p>
      ${listContent}
    `,
    ),
  );

  queueMicrotask(() => {
    const list = document.querySelector<HTMLDivElement>("#mine-list");
    if (!list) {
      return;
    }
    list.replaceChildren(
      ...placements.map((placement) => {
        const avatar = store.getAvatar(placement.avatarPoseId);
        const engagement = store.getPlacementEngagement(placement.id);
        const item = document.createElement("div");
        item.className = "list-item";
        item.innerHTML = `
          <strong>${escapeHtml(avatar?.label ?? "未知虚像")}</strong>
          <div class="hint">${escapeHtml(placement.locationLabel)} · ${formatTime(placement.createdAt)}</div>
          <div class="message-card">${escapeHtml(placement.message)}</div>
          <div class="engagement-summary">💬 ${engagement.commentCount} · 有用 ${engagement.reactionCounts.useful} · 无用 ${engagement.reactionCounts.useless} · 欢乐 ${engagement.reactionCounts.joyful}</div>
          <div class="actions">
            <button class="secondary" data-view="${placement.id}">查看/评论</button>
            <button class="secondary danger-text" data-del-placement="${placement.id}">删除放置</button>
          </div>
        `;

        item.querySelector<HTMLButtonElement>("[data-view]")?.addEventListener("click", () => {
          void switchTab("discover");
        });

        item.querySelector<HTMLButtonElement>("[data-del-placement]")?.addEventListener("click", async () => {
          const ok = await confirmDialog("删除放置", "确定删除这个放置吗？相关评论也会一并删除，且无法恢复。", {
            confirmLabel: "删除",
            danger: true,
          });
          if (ok) {
            store.deletePlacement(placement.id);
            render();
          }
        });

        return item;
      }),
    );
  });

  return fragment;
}

function buildAvatarsView(): DocumentFragment {
  const avatars = store.getAvatars();
  const fragment = document.createDocumentFragment();

  if (avatars.length > 0 && !selectedAvatarId) {
    selectedAvatarId = avatars[0].id;
    previewRotationY = 0;
  }
  if (selectedAvatarId && !avatars.some((avatar) => avatar.id === selectedAvatarId)) {
    selectedAvatarId = avatars[0]?.id ?? null;
    previewRotationY = 0;
  }

  const selectedAvatar = selectedAvatarId ? store.getAvatar(selectedAvatarId) : undefined;
  const previewData = selectedAvatar ? getPreviewDataForRotation(selectedAvatar, previewRotationY) : null;

  const listContent =
    avatars.length === 0
      ? `<p class="hint">还没有虚像。去「扫描」捕获第一个姿势。</p>`
      : `<div class="list">${avatars
          .map(
            (avatar) => `
              <div class="list-item selectable ${selectedAvatarId === avatar.id ? "selected" : ""}" data-select-avatar="${avatar.id}">
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

  fragment.append(
    panel(
      "我的虚像",
      `
      <p class="hint">点击列表选择虚像，手动旋转查看全身轮廓。</p>
      ${listContent}
      ${rotationControl}
    `,
    ),
  );

  const stage = document.createElement("div");
  stage.className = "stage";
  stage.innerHTML = `<canvas id="avatars-canvas" class="three rotatable"></canvas>`;
  fragment.append(stage);

  queueMicrotask(() => {
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
        store.deleteAvatar(id);
        if (selectedAvatarId === id) {
          selectedAvatarId = null;
          previewRotationY = 0;
        }
        render();
      });
    });

    document.querySelectorAll<HTMLElement>("[data-select-avatar]").forEach((item) => {
      item.addEventListener("click", () => {
        selectedAvatarId = item.dataset.selectAvatar ?? null;
        previewRotationY = 0;
        updateAvatarPreview();
        syncRotationUi();
        document.querySelectorAll("[data-select-avatar]").forEach((el) => {
          el.classList.toggle("selected", el.getAttribute("data-select-avatar") === selectedAvatarId);
        });
      });
    });

    document.querySelector<HTMLInputElement>("#avatar-rotation")?.addEventListener("input", (event) => {
      previewRotationY = Number((event.target as HTMLInputElement).value);
      syncRotationUi();
      updateAvatarPreview();
    });

    initAvatarsScene();
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

function initAvatarsScene(): void {
  ghostScene?.dispose();
  const canvas = document.querySelector<HTMLCanvasElement>("#avatars-canvas");
  const avatars = store.getAvatars();
  if (!canvas || avatars.length === 0) {
    return;
  }
  ghostScene = new GhostScene(canvas);
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

function panel(title: string, innerHtml: string): HTMLElement {
  const element = document.createElement("section");
  element.className = "panel";
  element.innerHTML = `<h2>${title}</h2>${innerHtml}`;
  return element;
}

interface ConfirmOptions {
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

function confirmDialog(title: string, message: string, options: ConfirmOptions = {}): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(message)}</p>
        <div class="modal-actions">
          <button class="secondary" data-cancel>${escapeHtml(options.cancelLabel ?? "取消")}</button>
          <button class="${options.danger ? "danger" : "primary"}" data-confirm>${escapeHtml(options.confirmLabel ?? "确定")}</button>
        </div>
      </div>
    `;

    const cleanup = (result: boolean) => {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      resolve(result);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        cleanup(false);
      }
    };

    overlay.querySelector<HTMLButtonElement>("[data-confirm]")?.addEventListener("click", () => cleanup(true));
    overlay.querySelector<HTMLButtonElement>("[data-cancel]")?.addEventListener("click", () => cleanup(false));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) {
        cleanup(false);
      }
    });
    document.addEventListener("keydown", onKey);

    document.body.append(overlay);
    overlay.querySelector<HTMLButtonElement>("[data-confirm]")?.focus();
  });
}

window.addEventListener("resize", () => ghostScene?.resize());

window.addEventListener("beforeunload", (event) => {
  if (activeTab === "scan" && hasUnsavedScan()) {
    event.preventDefault();
    event.returnValue = "";
  }
});

window.addEventListener("pagehide", () => {
  stopScanLoop();
  poseService.dispose();
  ghostScene?.dispose();
});
