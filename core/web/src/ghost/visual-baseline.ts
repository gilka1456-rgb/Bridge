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
  const captureVersion = featureFlags.bodyV3 ? "spectral-v3-v1" : VISUAL_BASELINE_VERSION;
  const label = `${captureVersion}-${config.style}-${config.background}-${config.angle}`;
  const heading = featureFlags.bodyV3 ? "连续人体几何基线" : "旧几何视觉基线";
  const description = featureFlags.bodyV3
    ? "固定标准 A-pose、相机与时间。此页验证连续水密人体，风格渲染仍沿用旧版。"
    : "固定人体、相机与时间。此页只记录改造前的真实显示，不启用 V3。";
  root.innerHTML = `
    <main class="visual-baseline-page" data-background="${config.background}">
      <section class="visual-baseline-copy">
        <p class="eyebrow">Spectral V3 · ${featureFlags.bodyV3 ? "V1 Geometry" : "V0 Golden"}</p>
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
  if (!canvas) throw new Error("Missing visual baseline canvas.");
  const scene = new GhostScene(canvas, {
    transparentBackground: true,
    fixedTimeSeconds: VISUAL_BASELINE_FIXED_TIME,
    cameraPosition: [0, 0, 4.2],
    cameraTarget: [0, 0, 0],
  });
  await scene.setPoses([{ pose: createPerformancePose(config.style as GhostStyleId), rotationY: config.angle }]);
  scene.resize();
  document.body.dataset.visualBaselineReady = label;
  return scene;
}
