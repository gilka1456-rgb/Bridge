import { describe, expect, it } from "vitest";
import { MESSAGE_MAX_LENGTH, MessageModerationError, validateMessage } from "./moderation";

describe("message moderation", () => {
  it("trims valid messages", () => {
    expect(validateMessage("  你好  ")).toBe("你好");
  });

  it("rejects empty, oversized and blocked messages", () => {
    expect(() => validateMessage(" ")).toThrow(MessageModerationError);
    expect(() => validateMessage("a".repeat(MESSAGE_MAX_LENGTH + 1))).toThrow("不能超过");
    expect(() => validateMessage("这里有赌博广告")).toThrow("未通过审核");
  });
});
