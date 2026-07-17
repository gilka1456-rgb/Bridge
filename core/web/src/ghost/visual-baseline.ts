import type { GhostStyleId } from "../models/types";
import { createPerformancePose } from "./performance-probe";
import { GhostScene } from "./renderer";
import { resolveGhostFeatureFlags } from "./feature-flags";

export const VISUAL_BASELINE_VERSION = "spectral-v3-v0";
export const VISUAL_BASELINE_FIXED_TIME = 2.75;
export const VISUAL_BASELINE_ANGLES = [0, 90, 180, 315] as const;
export const VISUAL_BASELINE_STYLES = ["wraith", "cyber"] as const;
export const VISUAL_BASELINE_BACKGROUNDS = ["black", "white"] as const;

export interface VisualBaselineConfig {
  style: (typeof VISUAL_BASELINE_STYLES)[number];
  background: (typeof VISUAL_BASELINE_BACKGROUNDS)[number];
  angle: (typeof VISUAL_BASELINE_ANGLES)[number];
}

function member<T extends readonly (string | number)[]>(values: T, candidate: string | null): T[number] | null {
  if (candidate === null) return null;
  return values.find((value) => String(value) === candidate) ?? null;
}

export function resolveVisualBaselineConfig(search: string): VisualBaselineConfig {
  const params = new URLSearchParams(search);
  return {
    style: member(VISUAL_BASELINE_STYLES, params.get("style")) ?? "wraith",
    background: member(VISUAL_BASELINE_BACKGROUNDS, params.get("background")) ?? "black",
    angle: member(VISUAL_BASELINE_ANGLES, params.get("angle")) ?? 0,
  };
}

function baselineHref(config: VisualBaselineConfig): string {
  const params = new URLSearchParams({
    "visual-baseline": "1",
    style: config.style,
    background: config.background,
    angle: String(config.angle),
  });
  return `?${params.toString()}`;
}

export async function mountVisualBaseline(root: HTMLElement, search: string): Promise<GhostScene> {
  const config = resolveVisualBaselineConfig(search);
  const featureFlags = resolveGhostFeatureFlags(search);
  const captureParams = new URLSearchParams(search);
  const captureOnly = captureParams.has("capture-only");
  const poseBake = captureParams.has("pose-bake");
  const poseVariant = captureParams.get("pose") === "extreme" ? "extreme" : "standing";
  const captureVersion = featureFlags.renderV3
    ? "spectral-v3-v3"
    : featureFlags.bodyV3
    ? poseBake ? "spectral-v3-v2" : "spectral-v3-v1"
    : VISUAL_BASELINE_VERSION;
  const poseSuffix = poseVariant === "extreme" ? "-extreme" : "";
  const label = `${captureVersion}${poseSuffix}-${config.style}-${config.background}-${config.angle}`;
  const heading = featureFlags.renderV3
    ? "共享透明渲染基线"
    : featureFlags.bodyV3
    ? poseBake ? "扫描姿势蒙皮基线" : "连续人体几何基线"
    : "旧几何视觉基线";
  const description = featureFlags.renderV3
    ? "固定人体、扫描姿势、相机与时间。此页验证结构深度预写、主表面和柔光背壳。"
    : featureFlags.bodyV3
    ? poseBake
      ? "固定扫描姿势、相机与时间。此页验证四骨权重和 CPU 姿势烘焙，风格渲染仍沿用旧版。"
      : "固定标准 A-pose、相机与时间。此页验证连续水密人体，风格渲染仍沿用旧版。"
    : "固定人体、相机与时间。此页只记录改造前的真实显示，不启用 V3。";
  root.innerHTML = `
    <main class="visual-baseline-page" data-background="${config.background}" data-capture="${captureOnly ? "canvas" : "page"}">
      <section class="visual-baseline-copy">
        <p class="eyebrow">Spectral V3 · ${featureFlags.renderV3 ? "V3 Render Core" : featureFlags.bodyV3 ? poseBake ? "V2 Skinning" : "V1 Geometry" : "V0 Golden"}</p>
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
    transparentBackground: true,
    fixedTimeSeconds: VISUAL_BASELINE_FIXED_TIME,
    cameraPosition: [0, 0, 4.2],
    cameraTarget: [0, 0, 0],
    pixelRatio: 1,
  });
  await scene.setPoses([{
    pose: createPerformancePose(config.style as GhostStyleId, poseVariant),
    rotationY: config.angle,
    bodyOptions: { spectralStandardPose: !poseBake },
  }]);
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
  document.body.dataset.visualBaselineReady = label;
  return scene;
}
