export async function resizeImageFile(
  file: File,
  maxSize = 512,
  quality = 0.86,
): Promise<string> {
  const image = await loadImageFile(file);
  const scale = Math.min(1, maxSize / image.naturalWidth, maxSize / image.naturalHeight);
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("当前浏览器无法处理图片。");
  }
  context.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", quality);
}

/** 解码图片供当前内存任务使用；对象 URL 在解码后立即释放，不会持久化原图。 */
export async function loadImageFile(file: File): Promise<HTMLImageElement> {
  if (!file.type.startsWith("image/")) {
    throw new Error("请选择图片文件。");
  }
  const sourceUrl = URL.createObjectURL(file);
  try {
    return await loadImage(sourceUrl);
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("无法读取这张图片。"));
    image.src = url;
  });
}
