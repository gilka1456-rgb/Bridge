// Phase 0 占位实现：本地关键词过滤，仅用于原型。
// 联网版必须由服务端审核 API 替换（含语义审核、绕过检测、人工复核队列）。
const BLOCKED_TERMS = ["操", "傻逼", "去死", "杀人", "色情", "赌博", "毒品"];

export class MessageModerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MessageModerationError";
  }
}

export const MESSAGE_MAX_LENGTH = 80;

export function validateMessage(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new MessageModerationError("留言不能为空。");
  }
  if (trimmed.length > MESSAGE_MAX_LENGTH) {
    throw new MessageModerationError(`留言不能超过 ${MESSAGE_MAX_LENGTH} 字。`);
  }

  const lowered = trimmed.toLowerCase();
  if (BLOCKED_TERMS.some((term) => lowered.includes(term))) {
    throw new MessageModerationError("留言未通过审核，请修改后重试。");
  }

  return trimmed;
}
