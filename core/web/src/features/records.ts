export function createScenePlaceholder(title: string, location: string): string {
  const safeTitle = escapeSvg(title || "虚像场景");
  const safeLocation = escapeSvg(location || "某个真实空间");
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200" viewBox="0 0 900 1200">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#2f2a32"/>
          <stop offset="0.55" stop-color="#766c8f"/>
          <stop offset="1" stop-color="#e6aa98"/>
        </linearGradient>
      </defs>
      <rect width="900" height="1200" fill="url(#bg)"/>
      <circle cx="450" cy="410" r="150" fill="rgba(255,255,255,.12)"/>
      <path d="M450 250 C370 330 345 500 360 720 L280 1030 L620 1030 L540 720 C555 500 530 330 450 250Z"
        fill="rgba(255,255,255,.26)" stroke="rgba(255,255,255,.7)" stroke-width="5"/>
      <text x="70" y="1080" fill="#fff" font-family="system-ui,sans-serif" font-size="48" font-weight="700">${safeTitle}</text>
      <text x="70" y="1135" fill="rgba(255,255,255,.75)" font-family="system-ui,sans-serif" font-size="28">${safeLocation}</text>
    </svg>
  `;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export async function shareSceneRecord(
  imageDataUrl: string,
  title: string,
  caption: string,
): Promise<"shared" | "downloaded"> {
  const blob = await (await fetch(imageDataUrl)).blob();
  const file = new File([blob], `${safeFilename(title)}.png`, { type: blob.type || "image/png" });
  const shareData: ShareData = { title, text: caption, files: [file] };

  if (navigator.share && (!navigator.canShare || navigator.canShare(shareData))) {
    await navigator.share(shareData);
    return "shared";
  }

  const link = document.createElement("a");
  link.href = imageDataUrl;
  link.download = file.name;
  link.click();
  if (navigator.clipboard && caption) {
    await navigator.clipboard.writeText(`${title}\n${caption}`).catch(() => undefined);
  }
  return "downloaded";
}

function safeFilename(value: string): string {
  return (value.trim() || "Bridge-记录").replace(/[\\/:*?"<>|]/g, "-");
}

function escapeSvg(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
