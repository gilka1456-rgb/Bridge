import { describe, expect, it, vi } from "vitest";
import { LocalStore } from "../services/store";
import { buildDiscoverView } from "./discover";

describe("discover view", () => {
  it("emits filter and camera actions without rebuilding the app shell", () => {
    const onFilterChange = vi.fn();
    const onShutter = vi.fn();
    const onCameraRetry = vi.fn();
    const fragment = buildDiscoverView({
      store: new LocalStore(),
      onFilterChange,
      onShutter,
      onCameraRetry,
    });
    document.body.append(fragment);

    document.querySelector<HTMLButtonElement>('[data-discover-filter="others"]')?.click();
    document.querySelector<HTMLButtonElement>("#discover-shutter")?.click();
    document.querySelector<HTMLButtonElement>("#discover-camera-retry")?.click();

    expect(onFilterChange).toHaveBeenCalledWith("others");
    expect(onShutter).toHaveBeenCalledOnce();
    expect(onCameraRetry).toHaveBeenCalledWith(expect.any(HTMLVideoElement));
  });
});
