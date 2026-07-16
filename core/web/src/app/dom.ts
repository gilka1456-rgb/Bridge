/**
 * Pure DOM/string helpers shared across view modules.
 * Extracted from main.ts so views can depend on them without reaching into
 * the orchestrator. None of these touch application state.
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString();
}

export function initialOf(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed[0].toUpperCase() : "我";
}

export function panel(title: string, innerHtml: string): HTMLElement {
  const element = document.createElement("section");
  element.className = "panel";
  element.innerHTML = `<h2>${title}</h2>${innerHtml}`;
  return element;
}

export function showToast(message: string, tone: "info" | "error" = "info"): void {
  document.querySelector(".app-toast")?.remove();
  const toast = document.createElement("div");
  toast.className = `app-toast ${tone}`;
  toast.setAttribute("role", tone === "error" ? "alert" : "status");
  toast.textContent = message;
  document.body.append(toast);
  window.setTimeout(() => toast.remove(), 3600);
}

export interface ConfirmOptions {
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

export function bindDialogBehavior(overlay: HTMLElement, close: () => void): () => void {
  const previouslyFocused = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
  const dialog = overlay.querySelector<HTMLElement>('[role="dialog"]');
  const title = dialog?.querySelector<HTMLElement>(".sheet-title, h1, h2, h3");
  if (dialog && title && !dialog.hasAttribute("aria-label") && !dialog.hasAttribute("aria-labelledby")) {
    title.id ||= `dialog-title-${crypto.randomUUID()}`;
    dialog.setAttribute("aria-labelledby", title.id);
  }
  const focusableSelector =
    'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab" || !dialog) {
      return;
    }
    const focusable = [...dialog.querySelectorAll<HTMLElement>(focusableSelector)]
      .filter((element) => !element.hidden);
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  document.addEventListener("keydown", onKey);
  queueMicrotask(() => {
    const first = dialog?.querySelector<HTMLElement>(focusableSelector);
    if (first) {
      first.focus();
    } else {
      dialog?.setAttribute("tabindex", "-1");
      dialog?.focus();
    }
  });
  return () => {
    document.removeEventListener("keydown", onKey);
    if (previouslyFocused?.isConnected) {
      previouslyFocused.focus();
    }
  };
}

export function confirmDialog(
  title: string,
  message: string,
  options: ConfirmOptions = {},
): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title">
        <h3 id="confirm-dialog-title">${escapeHtml(title)}</h3>
        <p>${escapeHtml(message)}</p>
        <div class="modal-actions">
          <button class="secondary" data-cancel>${escapeHtml(options.cancelLabel ?? "取消")}</button>
          <button class="${options.danger ? "danger" : "primary"}" data-confirm>${escapeHtml(options.confirmLabel ?? "确定")}</button>
        </div>
      </div>
    `;

    let releaseDialog: () => void = () => undefined;
    const cleanup = (result: boolean) => {
      releaseDialog();
      overlay.remove();
      resolve(result);
    };
    releaseDialog = bindDialogBehavior(overlay, () => cleanup(false));

    overlay.querySelector<HTMLButtonElement>("[data-confirm]")?.addEventListener("click", () => cleanup(true));
    overlay.querySelector<HTMLButtonElement>("[data-cancel]")?.addEventListener("click", () => cleanup(false));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) {
        cleanup(false);
      }
    });
    document.body.append(overlay);
  });
}
