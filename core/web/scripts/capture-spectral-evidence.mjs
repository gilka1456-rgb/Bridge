import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const styles = ["wraith", "phantom", "cyber", "quantum"];
const backgrounds = ["black", "white"];
const angles = [0, 90, 180, 315];
const captureCases = [
  ...styles.flatMap((style) => backgrounds.flatMap((background) => (
    angles.map((angle) => ({ style, background, angle, pose: "standing" }))
  ))),
  ...styles.flatMap((style) => ([
    { style, background: "black", angle: 0, pose: "extreme" },
    { style, background: "white", angle: 315, pose: "extreme" },
  ])),
];
const baseUrl = process.env.SPECTRAL_BASE_URL ?? "https://127.0.0.1:4173";
const outputDirectory = path.resolve(
  process.env.SPECTRAL_EVIDENCE_DIR ?? "spectral-evidence",
);
const viewport = { width: 1280, height: 720 };
const timelineStyles = ["wraith", "cyber"];
const timelineSeconds = Array.from({ length: 11 }, (_, second) => second);
const timelineGuardrails = Object.freeze({
  maximumMeanRgbDelta: 0.18,
  maximumChangedSampleRatio: 0.55,
});

function roundMetric(value) {
  return Number(value.toFixed(6));
}

function compareSamples(previous, current) {
  if (previous.length !== current.length || current.length === 0) {
    throw new Error(`Timeline sample shape changed (${previous.length} -> ${current.length}).`);
  }
  let totalDelta = 0;
  let changedSamples = 0;
  let maximumSampleDelta = 0;
  const sampleCount = current.length / 3;
  for (let index = 0; index < current.length; index += 3) {
    const delta = (
      Math.abs(current[index] - previous[index])
      + Math.abs(current[index + 1] - previous[index + 1])
      + Math.abs(current[index + 2] - previous[index + 2])
    ) / (3 * 255);
    totalDelta += delta;
    if (delta > 0.08) changedSamples += 1;
    maximumSampleDelta = Math.max(maximumSampleDelta, delta);
  }
  return {
    meanRgbDelta: roundMetric(totalDelta / sampleCount),
    changedSampleRatio: roundMetric(changedSamples / sampleCount),
    maximumSampleDelta: roundMetric(maximumSampleDelta),
  };
}

async function sampleTimelineCanvas(page) {
  return page.evaluate(() => {
    const source = document.querySelector("#visual-baseline-canvas");
    if (!(source instanceof HTMLCanvasElement)) throw new Error("Missing live visual baseline canvas.");
    const copy = document.createElement("canvas");
    copy.width = source.width;
    copy.height = source.height;
    const context = copy.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Unable to sample live visual baseline canvas.");
    context.drawImage(source, 0, 0);
    const pixels = context.getImageData(0, 0, copy.width, copy.height).data;
    const samples = [];
    const step = 8;
    const startX = Math.floor(copy.width * 0.22);
    const endX = Math.ceil(copy.width * 0.78);
    const startY = Math.floor(copy.height * 0.03);
    const endY = Math.ceil(copy.height * 0.97);
    for (let y = startY; y < endY; y += step) {
      for (let x = startX; x < endX; x += step) {
        const offset = (y * copy.width + x) * 4;
        samples.push(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
      }
    }
    return samples;
  });
}

await mkdir(outputDirectory, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: [
    "--enable-unsafe-swiftshader",
    "--use-angle=swiftshader-webgl",
  ],
});

const context = await browser.newContext({
  viewport,
  deviceScaleFactor: 1,
  ignoreHTTPSErrors: true,
});
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));

const frames = [];
const timelines = [];
const timelineFrames = [];
try {
  for (const { style, background, angle, pose } of captureCases) {
    const params = new URLSearchParams({
      "visual-baseline": "1",
      "capture-only": "1",
      "ghost-body-v3": "1",
      "ghost-render-v3": "1",
      "ghost-fantasy-v5": "1",
      "ghost-cyber-v6": "1",
      appearance: "1",
      style,
      background,
      angle: String(angle),
      time: "2.75",
    });
    if (pose === "extreme") params.set("pose", "extreme");
    const url = `${baseUrl}/?${params.toString()}`;
    const response = await page.goto(url, {
      waitUntil: "networkidle",
      timeout: 60_000,
    });
    if (!response?.ok()) {
      throw new Error(`Visual baseline request failed (${response?.status() ?? "no response"}): ${url}`);
    }
    await page.waitForFunction(
      () => Boolean(document.body.dataset.visualBaselineReady),
      undefined,
      { timeout: 60_000 },
    );
    const frame = page.locator(".visual-baseline-capture-frame");
    await frame.waitFor({ state: "visible", timeout: 30_000 });

    const evidence = await page.evaluate(() => ({
      label: document.body.dataset.visualBaselineReady ?? "",
      versions: JSON.parse(document.body.dataset.visualBaselineVersions ?? "{}"),
      stats: JSON.parse(document.body.dataset.visualBaselineStats ?? "{}"),
    }));
    const expectedFamily = style === "wraith" || style === "phantom"
      ? "fantasy-spirit-"
      : "cyber-projection-";
    if (!String(evidence.versions.style ?? "").startsWith(expectedFamily)) {
      throw new Error(`Unexpected style build for ${style}: ${JSON.stringify(evidence.versions)}`);
    }
    if (!String(evidence.versions.render ?? "").startsWith("spectral-render-v3-core-")) {
      throw new Error(`Missing current render build for ${style}: ${JSON.stringify(evidence.versions)}`);
    }

    const poseSuffix = pose === "standing" ? "" : `-${pose}`;
    const file = `${style}-${background}-${angle}${poseSuffix}.png`;
    await frame.screenshot({ path: path.join(outputDirectory, file) });
    frames.push({ style, background, angle, pose, file, url, ...evidence });
  }

  for (const style of timelineStyles) {
    const params = new URLSearchParams({
      "visual-baseline": "1",
      "live-time": "1",
      "ghost-body-v3": "1",
      "ghost-render-v3": "1",
      "ghost-fantasy-v5": "1",
      "ghost-cyber-v6": "1",
      appearance: "1",
      style,
      background: "black",
      angle: "315",
    });
    const url = `${baseUrl}/?${params.toString()}`;
    const response = await page.goto(url, {
      waitUntil: "networkidle",
      timeout: 60_000,
    });
    if (!response?.ok()) {
      throw new Error(`Live visual baseline request failed (${response?.status() ?? "no response"}): ${url}`);
    }
    await page.waitForFunction(
      () => Boolean(document.body.dataset.visualBaselineReady?.includes("-live-quality-fixed-high-")),
      undefined,
      { timeout: 60_000 },
    );
    const canvas = page.locator("#visual-baseline-canvas");
    await canvas.waitFor({ state: "visible", timeout: 30_000 });
    const evidence = await page.evaluate(() => ({
      label: document.body.dataset.visualBaselineReady ?? "",
      versions: JSON.parse(document.body.dataset.visualBaselineVersions ?? "{}"),
      stats: JSON.parse(document.body.dataset.visualBaselineStats ?? "{}"),
    }));
    const expectedFamily = style === "wraith" ? "fantasy-spirit-" : "cyber-projection-";
    if (!String(evidence.versions.style ?? "").startsWith(expectedFamily)) {
      throw new Error(`Unexpected live style build for ${style}: ${JSON.stringify(evidence.versions)}`);
    }

    await page.waitForTimeout(250);
    const startedAt = Date.now();
    let previousSamples = null;
    const transitions = [];
    const styleFrames = [];
    for (const second of timelineSeconds) {
      const remaining = startedAt + second * 1000 - Date.now();
      if (remaining > 0) await page.waitForTimeout(remaining);
      const file = `timeline-${style}-black-315-t${String(second).padStart(2, "0")}.png`;
      await canvas.screenshot({ path: path.join(outputDirectory, file) });
      const samples = await sampleTimelineCanvas(page);
      if (previousSamples) {
        transitions.push({
          fromSecond: second - 1,
          toSecond: second,
          ...compareSamples(previousSamples, samples),
        });
      }
      previousSamples = samples;
      const frame = { style, background: "black", angle: 315, second, file };
      styleFrames.push(frame);
      timelineFrames.push(frame);
    }
    const maximumMeanRgbDelta = Math.max(...transitions.map((item) => item.meanRgbDelta));
    const maximumChangedSampleRatio = Math.max(...transitions.map((item) => item.changedSampleRatio));
    if (maximumMeanRgbDelta > timelineGuardrails.maximumMeanRgbDelta) {
      throw new Error(`${style} timeline mean RGB discontinuity ${maximumMeanRgbDelta} exceeded ${timelineGuardrails.maximumMeanRgbDelta}.`);
    }
    if (maximumChangedSampleRatio > timelineGuardrails.maximumChangedSampleRatio) {
      throw new Error(`${style} timeline changed-sample ratio ${maximumChangedSampleRatio} exceeded ${timelineGuardrails.maximumChangedSampleRatio}.`);
    }
    timelines.push({
      style,
      background: "black",
      angle: 315,
      durationSeconds: 10,
      sampleIntervalSeconds: 1,
      frameCount: styleFrames.length,
      maximumMeanRgbDelta,
      maximumChangedSampleRatio,
      transitions,
      frames: styleFrames,
      url,
      ...evidence,
    });
  }

  if (pageErrors.length > 0) {
    throw new Error(`Visual baseline page errors: ${pageErrors.join(" | ")}`);
  }

  const manifest = {
    evidenceVersion: "spectral-ci-visual-evidence-v4-fixed-quality-10s-timeline",
    commit: process.env.GITHUB_SHA ?? null,
    generatedAt: new Date().toISOString(),
    baseUrl,
    viewport,
    frameCount: frames.length,
    frames,
    timelineGuardrails,
    timelineCount: timelines.length,
    timelineFrameCount: timelineFrames.length,
    timelines,
  };
  await writeFile(
    path.join(outputDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  const cards = frames.map((item) => `
    <figure>
      <img src="${item.file}" alt="${item.style} ${item.background} ${item.angle} degrees ${item.pose}">
      <figcaption>${item.style} · ${item.background} · ${item.angle}° · ${item.pose}</figcaption>
    </figure>
  `).join("");
  const galleryPath = path.join(outputDirectory, "contact-sheet.html");
  await writeFile(galleryPath, `<!doctype html>
  <html lang="zh-CN"><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 24px; color: #eef5ff; background: #101319; font: 14px system-ui, sans-serif; }
    h1 { margin: 0 0 18px; font-size: 22px; }
    main { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
    figure { margin: 0; padding: 8px; border: 1px solid #303846; border-radius: 10px; background: #171c24; }
    img { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: contain; border-radius: 6px; }
    figcaption { padding: 7px 2px 1px; color: #b8c7d9; }
  </style></head><body><h1>Spectral current branch · ${process.env.GITHUB_SHA ?? "local"}</h1><main>${cards}</main></body></html>`, "utf8");

  const gallery = await context.newPage();
  await gallery.setViewportSize({ width: 1440, height: 1000 });
  await gallery.goto(pathToFileURL(galleryPath).href, { waitUntil: "networkidle" });
  await gallery.screenshot({
    path: path.join(outputDirectory, "contact-sheet.png"),
    fullPage: true,
  });
  await gallery.close();

  const timelineCards = timelineFrames.map((item) => `
    <figure>
      <img src="${item.file}" alt="${item.style} timeline at ${item.second} seconds">
      <figcaption>${item.style} · ${item.second}s</figcaption>
    </figure>
  `).join("");
  const timelineGalleryPath = path.join(outputDirectory, "timeline-contact-sheet.html");
  await writeFile(timelineGalleryPath, `<!doctype html>
  <html lang="zh-CN"><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 20px; color: #eef5ff; background: #101319; font: 13px system-ui, sans-serif; }
    h1 { margin: 0 0 16px; font-size: 21px; }
    main { display: grid; grid-template-columns: repeat(11, 190px); gap: 8px; }
    figure { margin: 0; padding: 5px; border: 1px solid #303846; border-radius: 8px; background: #171c24; }
    img { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: contain; border-radius: 4px; }
    figcaption { padding: 5px 1px 0; color: #b8c7d9; }
  </style></head><body><h1>Spectral 10-second continuity · ${process.env.GITHUB_SHA ?? "local"}</h1><main>${timelineCards}</main></body></html>`, "utf8");
  const timelineGallery = await context.newPage();
  await timelineGallery.setViewportSize({ width: 2240, height: 720 });
  await timelineGallery.goto(pathToFileURL(timelineGalleryPath).href, { waitUntil: "networkidle" });
  await timelineGallery.screenshot({
    path: path.join(outputDirectory, "timeline-contact-sheet.png"),
    fullPage: true,
  });
  await timelineGallery.close();
} finally {
  await browser.close();
}

process.stdout.write(`Captured ${frames.length} static frames and ${timelineFrames.length} timeline frames in ${outputDirectory}\n`);
