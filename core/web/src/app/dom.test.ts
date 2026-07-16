import { describe, expect, it } from "vitest";
import { confirmDialog } from "./dom";

describe("confirmDialog accessibility", () => {
  it("closes with Escape and restores focus", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();

    const result = confirmDialog("确认", "继续吗？");
    await Promise.resolve();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    await expect(result).resolves.toBe(false);
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
