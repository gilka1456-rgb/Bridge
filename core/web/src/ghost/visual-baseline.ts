import type { GhostStyleId, OrientationMask } from "../models/types";
import { encodeAppearanceLuma, encodePersonMaskRLE } from "../pose/segmentation";
import { createPerformancePose } from "./performance-probe";
import { GhostScene, SPECTRAL_CAMERA_VERSION } from "./renderer";
import { resolveGhostFeatureFlags } from "./feature-flags";
import { SPECTRAL_BODY_ALGORITHM_VERSION } from "./anatomical-body";
import {
  SPECTRAL_CYBER_VERSION,
  SPECTRAL_FANTASY_VERSION,
  SPECTRAL_RENDER_VERSION,
} from "./spectral-renderer";
import { SPECTRAL_POSTPROCESS_VERSION } from "./spectral-postprocess";

export const VISUAL_BASELINE_VERSION = "spectral-visual-evidence-v4-fixed-quality-timeline";
export const VISUAL_BASELINE_FIXED_TIME = 2.75;
export const VISUAL_BASELINE_ANGLES = [0, 90, 180, 315] as const;
export const VISUAL_BASELINE_STYLES = ["wraith", "phantom", "cyber", "quantum"] as const;
export const VISUAL_BASELINE_BACKGROUNDS = ["black", "white"] as const;
export const VISUAL_BASELINE_RUNTIME_VERSIONS = Object.freeze({
  body: SPECTRAL_BODY_ALGORITHM_VERSION,
  render: SPECTRAL_RENDER_VERSION,
  fantasy: SPECTRAL_FANTASY_VERSION,
  cyber: SPECTRAL_CYBER_VERSION,
  postprocess: SPECTRAL_POSTPROCESS_VERSION,
  camera: SPECTRAL_CAMERA_VERSION,
});

export interface VisualBaselineConfig {
  style: (typeof VISUAL_BASELINE_STYLES)[number];
  background: (typeof VISUAL_BASELINE_BACKGROUNDS)[number];
  angle: (typeof VISUAL_BASELINE_ANGLES)[number];
  tint?: string;
}

export interface VisualBaselinePoseMode {
  variant: "standing" | "extreme";
  standardPose: boolean;
}

export interface VisualBaselineTimeMode {
  fixedTimeSeconds?: number;
  label: string;
}

export function resolveVisualBaselineTimeMode(search: string): VisualBaselineTimeMode {
  const params = new URLSearchParams(search);
  if (params.get("live-time") === "1") return { label: "live" };
  const requested = Number(params.get("time"));
  const fixedTimeSeconds = Number.isFinite(requested) && params.has("time")
    ? Math.max(0, Math.min(10, requested))
    : VISUAL_BASELINE_FIXED_TIME;
  return {
    fixedTimeSeconds,
    label: `t${fixedTimeSeconds.toFixed(2)}`,
  };
}

export function resolveVisualBaselinePoseMode(search: string): VisualBaselinePoseMode {
  const params = new URLSearchParams(search);
  const variant = params.get("pose") === "extreme" ? "extreme" : "standing";
  return {
    variant,
    // Asking for an extreme pose must never silently capture the canonical
    // body. pose-bake remains the explicit standing-pose regression switch.
    standardPose: variant === "standing" && !params.has("pose-bake"),
  };
}

export function resolveVisualBaselinePostProcessEvidence(
  requested: boolean,
  enabled: boolean,
  antiAliasingSamples: number,
): string {
  if (!requested || !enabled) return "post-off";
  const samples = Math.max(0, Math.trunc(Number.isFinite(antiAliasingSamples) ? antiAliasingSamples : 0));
  return `${SPECTRAL_POSTPROCESS_VERSION}-msaa${samples}`;
}

function baselineAppearanceViews(): OrientationMask[] {
  const width = 64;
  const height = 128;
  const mask = new Uint8Array(width * height).fill(1);
  return [0, 90, 180, 270].map((azimuth) => {
    const luma = new Uint8Array(width * height);
    const phase = azimuth / 180 * Math.PI;
    for (let y = 0; y < height; y += 1) {
      const v = y / (height - 1);
      for (let x = 0; x < width; x += 1) {
        const u = x / (width - 1);
        const torso = (1 - Math.min(1, Math.abs(v - 0.38) / 0.25));
        const verticalFold = Math.sin(u * 39 + v * 5 + phase) * 26 * torso;
        const diagonalFold = Math.sin(u * 17 - v * 23 - phase * 0.6) * 13;
        const collar = Math.exp(-((u - 0.5) ** 2 * 110 + (v - 0.22) ** 2 * 420)) * -42;
        luma[y * width + x] = Math.round(Math.max(48, Math.min(208,
          128 + verticalFold + diagonalFold + collar,
        )));
      }
    }
    return {
      azimuth,
      width,
      height,
      mask: encodePersonMaskRLE(mask),
      appearanceLuma: encodeAppearanceLuma(luma),
      appearanceWidth: width,
      appearanceHeight: height,
      normalized: true,
      quality: 1,
    };
  });
}

function member<T extends readonly (string | number)[]>(values: T, candidate: string | null): T[number] | null {
  if (candidate === null) return null;
  return values.find((value) => String(value) === candidate) ?? null;
}

export function resolveVisualBaselineConfig(search: string): VisualBaselineConfig {
  const params = new URLSearchParams(search);
  const requestedTint = params.get("tint");
  return {
    style: member(VISUAL_BASELINE_STYLES, params.get("style")) ?? "wraith",
    background: member(VISUAL_BASELINE_BACKGROUNDS, params.get("background")) ?? "black",
    angle: member(VISUAL_BASELINE_ANGLES, params.get("angle")) ?? 0,
    ...(requestedTint && /^#[0-9a-f]{6}$/i.test(requestedTint)
      ? { tint: requestedTint.toLowerCase() }
      : {}),
  };
}

function baselineHref(config: VisualBaselineConfig): string {
  const params = new URLSearchParams({
    "visual-baseline": "1",
    style: config.style,
    background: config.background,
    angle: String(config.angle),
  });
  if (config.tint) params.set("tint", config.tint);
  return `?${params.toString()}`;
}

export async function mountVisualBaseline(root: HTMLElement, search: string): Promise<GhostScene> {
  const config = resolveVisualBaselineConfig(search);
  const featureFlags = resolveGhostFeatureFlags(search);
  const captureParams = new URLSearchParams(search);
  const captureOnly = captureParams.has("capture-only");
  const fantasyActive = featureFlags.fantasyV5 && (config.style === "wraith" || config.style === "phantom");
  const cyberActive = featureFlags.cyberV6 && (config.style === "cyber" || config.style === "quantum");
  const renderActive = featureFlags.renderV3 || fantasyActive || cyberActive;
  const runtimeSkinning = renderActive && captureParams.get("ghost-skinning") !== "cpu";
  const forcedLod = captureParams.get("ghost-lod");
  const timeMode = resolveVisualBaselineTimeMode(search);
  const poseMode = resolveVisualBaselinePoseMode(search);
  const poseBake = !poseMode.standardPose;
  const appearanceActive = captureParams.get("appearance") !== "0";
  const postProcessingRequested = config.background === "black";
  const poseVariant = poseMode.variant;
  const captureVersion = cyberActive
    ? `${SPECTRAL_CYBER_VERSION}-${SPECTRAL_RENDER_VERSION}-${SPECTRAL_BODY_ALGORITHM_VERSION}`
    : fantasyActive
    ? `${SPECTRAL_FANTASY_VERSION}-${SPECTRAL_RENDER_VERSION}-${SPECTRAL_BODY_ALGORITHM_VERSION}`
    : featureFlags.renderV3
    ? `${SPECTRAL_RENDER_VERSION}-${SPECTRAL_BODY_ALGORITHM_VERSION}`
    : featureFlags.bodyV3
    ? SPECTRAL_BODY_ALGORITHM_VERSION
    : VISUAL_BASELINE_VERSION;
  const skinningSuffix = renderActive && !runtimeSkinning ? "-cpu" : "";
  const poseSuffix = poseVariant === "extreme" ? "-extreme" : "";
  const lodSuffix = renderActive && forcedLod !== null ? `-lod${forcedLod}` : "";
  const timeSuffix = fantasyActive || cyberActive ? `-${timeMode.label}` : "";
  const qualitySuffix = timeMode.fixedTimeSeconds === undefined ? "-quality-fixed-high" : "";
  const tintSuffix = config.tint ? `-tint${config.tint.slice(1)}` : "";
  const appearanceSuffix = appearanceActive ? "" : "-neutral-surface";
  const postProcessSuffix = postProcessingRequested ? "-post-requested" : "-post-off";
  let label = `${captureVersion}-${SPECTRAL_CAMERA_VERSION}${postProcessSuffix}${skinningSuffix}${poseSuffix}${lodSuffix}${timeSuffix}${qualitySuffix}${tintSuffix}${appearanceSuffix}-${config.style}-${config.background}-${config.angle}`;
  const heading = cyberActive
    ? `${config.style === "cyber" ? "赛博青" : "量子紫"}投影基线${forcedLod === null ? "" : ` · LOD${forcedLod}`}`
    : fantasyActive
    ? `${config.style === "wraith" ? "红灵" : "白灵"}奇幻风格基线${forcedLod === null ? "" : ` · LOD${forcedLod}`}`
    : featureFlags.renderV3
    ? `三档 LOD 与 ${runtimeSkinning ? "GPU 姿势" : "CPU 回退"}基线${forcedLod === null ? "" : ` · LOD${forcedLod}`}`
    : featureFlags.bodyV3
    ? poseBake ? "扫描姿势蒙皮基线" : "连续人体几何基线"
    : "旧几何视觉基线";
  const description = cyberActive
    ? "固定人体、扫描姿势、相机与时间。此页验证照片浮雕法线、连续投影皮肤、细扫描带、双色边缘、地面投影盘和只作用于外层回声的相位事件。"
    : fantasyActive
    ? "固定人体、扫描姿势、相机与时间。此页验证照片浮雕法线、实体内核、表面魂流、向上雾焰轮廓和分档 GPU 魂屑。"
    : featureFlags.renderV3
    ? `固定人体、扫描姿势、相机与时间。此页验证${runtimeSkinning ? " GPU 链式笼形蒙皮" : " CPU 姿势烘焙回退"}和三档连续人体网格。`
    : featureFlags.bodyV3
    ? poseBake
      ? "固定扫描姿势、相机与时间。此页验证四骨权重和 CPU 姿势烘焙，风格渲染仍沿用旧版。"
      : "固定标准 A-pose、相机与时间。此页验证连续水密人体，风格渲染仍沿用旧版。"
    : "固定人体、相机与时间。此页只记录改造前的真实显示，不启用 V3。";
  root.innerHTML = `
    <main class="visual-baseline-page" data-background="${config.background}" data-capture="${captureOnly ? "canvas" : "page"}">
      <section class="visual-baseline-copy">
        <p class="eyebrow">Spectral V3 · ${cyberActive ? "V6 Cyber Projection" : fantasyActive ? "V5 Fantasy Spirit" : featureFlags.renderV3 ? `V4 LOD + ${runtimeSkinning ? "GPU Skinning" : "CPU Fallback"}` : featureFlags.bodyV3 ? poseBake ? "V2 Skinning" : "V1 Geometry" : "V0 Golden"}</p>
        <h1>${heading}</h1>
        <p>${description}</p>
        <code id="visual-baseline-id">${label}</code>
        <nav class="visual-baseline-controls" aria-label="基线状态">
          ${VISUAL_BASELINE_STYLES.map((style) => `<a href="${baselineHref({ ...config, style })}" ${style === config.style ? "aria-current=page" : ""}>${style}</a>`).join("")}
          ${VISUAL_BASELINE_BACKGROUNDS.map((background) => `<a href="${baselineHref({ ...config, background })}" ${background === config.background ? "aria-current=page" : ""}>${background}</a>`).join("")}
          ${VISUAL_BASELINE_ANGLES.map((angle) => `<a href="${baselineHref({ ...config, angle })}" ${angle === config.angle ? "aria-current=page" : ""}>${angle}°</a>`).join("")}
        </nav>
      </section>
      <section class="visual-baseline-stage" aria-label="旧灵体固定渲染">
        <canvas id="visual-baseline-canvas" class="three"></canvas>
      </section>
    </main>
  `;
  const canvas = root.querySelector<HTMLCanvasElement>("#visual-baseline-canvas");
  const stage = root.querySelector<HTMLElement>(".visual-baseline-stage");
  if (!canvas) throw new Error("Missing visual baseline canvas.");
  const scene = new GhostScene(canvas, {
    transparentBackground: !postProcessingRequested,
    postProcessing: postProcessingRequested,
    fixedTimeSeconds: timeMode.fixedTimeSeconds,
    cameraPosition: [0, 0, 4.2],
    cameraTarget: [0, 0, 0],
    cameraMode: "portrait",
    autoFrameSpectralBody: true,
    // Temporal evidence must compare one renderer tier with itself. Automatic
    // live downgrades are covered separately by the quality-controller tests.
    automaticQualitySwitching: false,
    pixelRatio: 1,
  });
  await scene.setPoses([{
    pose: {
      ...createPerformancePose(config.style as GhostStyleId, poseVariant),
      spectralTint: config.tint,
    },
    rotationY: config.angle,
    bodyOptions: {
      spectralStandardPose: poseMode.standardPose,
      spectralFantasyV5: fantasyActive,
      spectralCyberV6: cyberActive,
      spectralAppearanceViews: appearanceActive ? baselineAppearanceViews() : undefined,
    },
  }]);
  const postProcessStats = scene.getPerformanceSnapshot().postProcessing;
  if (postProcessingRequested) {
    label = label.replace(
      "-post-requested",
      `-${resolveVisualBaselinePostProcessEvidence(
        true,
        postProcessStats.enabled,
        postProcessStats.antiAliasingSamples,
      )}`,
    );
    const labelElement = root.querySelector<HTMLElement>("#visual-baseline-id");
    if (labelElement) labelElement.textContent = label;
  }
  scene.resize();
  if (captureOnly && stage) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const captureCanvas = document.createElement("canvas");
    captureCanvas.width = canvas.width;
    captureCanvas.height = canvas.height;
    const context = captureCanvas.getContext("2d");
    if (!context) throw new Error("Unable to create the visual baseline capture surface.");
    context.fillStyle = config.background === "white" ? "#ffffff" : "#000000";
    context.fillRect(0, 0, captureCanvas.width, captureCanvas.height);
    context.drawImage(canvas, 0, 0);
    const frame = new Image();
    frame.className = "visual-baseline-capture-frame";
    frame.alt = label;
    frame.src = captureCanvas.toDataURL("image/png");
    await frame.decode();
    canvas.hidden = true;
    stage.append(frame);
  }
  const performanceStats = scene.getPerformanceSnapshot();
  document.body.dataset.visualBaselineStats = JSON.stringify(performanceStats);
  document.body.dataset.visualBaselineVersions = JSON.stringify({
    evidence: VISUAL_BASELINE_VERSION,
    body: SPECTRAL_BODY_ALGORITHM_VERSION,
    render: SPECTRAL_RENDER_VERSION,
    camera: SPECTRAL_CAMERA_VERSION,
    style: cyberActive
      ? SPECTRAL_CYBER_VERSION
      : fantasyActive
        ? SPECTRAL_FANTASY_VERSION
        : null,
    postprocess: performanceStats.postProcessing.enabled
      ? resolveVisualBaselinePostProcessEvidence(
        true,
        true,
        performanceStats.postProcessing.antiAliasingSamples,
      )
      : null,
  });
  document.body.dataset.visualBaselineReady = label;
  return scene;
}
