import type { ChatMessage } from "../models/types";

export function chatMessageHtml(
  message: ChatMessage,
  localOwnerId: string,
  escapeHtml: (value: string) => string,
  formatTime: (iso: string) => string,
): string {
  const mine = message.senderId === localOwnerId;
  return `
    <div class="chat-message ${mine ? "mine" : "theirs"}">
      <div class="chat-bubble">${escapeHtml(message.text)}</div>
      <time>${formatTime(message.createdAt)}</time>
    </div>
  `;
}
