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

export interface ConfirmOptions {
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
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
      <div class="modal" role="dialog" aria-modal="true">
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(message)}</p>
        <div class="modal-actions">
          <button class="secondary" data-cancel>${escapeHtml(options.cancelLabel ?? "取消")}</button>
          <button class="${options.danger ? "danger" : "primary"}" data-confirm>${escapeHtml(options.confirmLabel ?? "确定")}</button>
        </div>
      </div>
    `;

    const cleanup = (result: boolean) => {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      resolve(result);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        cleanup(false);
      }
    };

    overlay.querySelector<HTMLButtonElement>("[data-confirm]")?.addEventListener("click", () => cleanup(true));
    overlay.querySelector<HTMLButtonElement>("[data-cancel]")?.addEventListener("click", () => cleanup(false));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) {
        cleanup(false);
      }
    });
    document.addEventListener("keydown", onKey);

    document.body.append(overlay);
    overlay.querySelector<HTMLButtonElement>("[data-confirm]")?.focus();
  });
}
