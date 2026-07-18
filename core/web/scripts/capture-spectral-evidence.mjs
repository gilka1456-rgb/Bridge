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

  if (pageErrors.length > 0) {
    throw new Error(`Visual baseline page errors: ${pageErrors.join(" | ")}`);
  }

  const manifest = {
    evidenceVersion: "spectral-ci-visual-evidence-v2-standing-and-extreme",
    commit: process.env.GITHUB_SHA ?? null,
    generatedAt: new Date().toISOString(),
    baseUrl,
    viewport,
    frameCount: frames.length,
    frames,
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
} finally {
  await browser.close();
}

process.stdout.write(`Captured ${frames.length} Spectral frames in ${outputDirectory}\n`);
